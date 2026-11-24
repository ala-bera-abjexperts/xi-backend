/**
 * @fileoverview The checksum must cover the whole member, and the hash must outlive the stream.
 * @module src/backup/engine/backup-worker.checksum.spec
 *
 * A live run died here with:
 *
 *   Error [ERR_CRYPTO_HASH_FINALIZED]: Digest already called
 *     at PassThrough.<anonymous> (backup-worker.service.ts)
 *
 * `writer.finish()` ends the WRITABLE side of the hashing stream. When the archive member it feeds
 * is slower than the writer, the member's buffer fills, `pipe` pauses the hashing stream, and bytes
 * are still sitting in it when `finish()` resolves. `hash.digest()` then runs early, and the next
 * `data` event calls `update()` on a finalised hash — inside a stream listener, so the throw is
 * uncaught and takes the process down rather than failing one table.
 *
 * Two conditions are needed to reproduce it, and the archive-membership tests have neither: enough
 * bytes to exceed the member's 16 KB high-water mark, and a consumer that does not drain
 * synchronously. Real archiver deflates each member and pushes it over SFTP, so it has both.
 *
 * With the wait removed, `covers every byte of the sql member` fails with the production error
 * verbatim — "Digest already called". SQL reproduces it where the others do not because its writer
 * buffers 500 rows and flushes them as one ~40 KB statement, overflowing the member in a single
 * write; the row-at-a-time formats give the consumer a chance to keep up. That SQL is both the
 * worst case and the default format is why this reached a live run.
 */

import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { BackupWorkerService } from './backup-worker.service';
import type { BackupArchiveCipherService } from '../services/backup-archive-cipher.service';
import type { BackupSecretsService } from '../services/backup-secrets.service';
import type { BackupSpoolService, SpoolSession } from './backup-spool.service';
import type { BackupStorageService } from './backup-storage.service';
import type { SftpTargetAdapter } from '../adapters/sftp/sftp.adapter';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TableExporterService } from './table-exporter.service';
import type { BackupFileFormat } from './writers/table-writer';

/**
 * Comfortably past the 16 KB default high-water mark of the member stream, so `pipe` really does
 * pause the hashing stream part-way through. Two rows never do.
 */
const ROWS = Array.from({ length: 600 }, (_, index) => ({
  id: `row-${index}`,
  title: `Title ${index}`,
  body: 'x'.repeat(64),
}));

interface Member {
  chunks: Buffer[];
  drained: Promise<void>;
}

/** An archive whose members are read a tick late and slowly, the way a real one behaves. */
function harness() {
  const members = new Map<string, Member>();

  const archive = {
    append: (source: NodeJS.ReadableStream, options: { name: string }) => {
      const chunks: Buffer[] = [];

      const drained = new Promise<void>((resolve) => {
        // Deferred on purpose: consuming synchronously is what hid the bug.
        setImmediate(() => {
          source.on('data', (chunk: Buffer) => chunks.push(chunk));
          source.on('end', () => resolve());
          source.resume();
        });
      });

      members.set(options.name, { chunks, drained });

      return undefined;
    },
  };

  const session: SpoolSession = {
    open: (name: string) => {
      const chunks: Buffer[] = [];
      const sink = new PassThrough();

      sink.on('data', (chunk: Buffer) => chunks.push(chunk));

      members.set(name, {
        chunks,
        drained: new Promise<void>((resolve) =>
          sink.on('end', () => resolve()),
        ),
      });

      return { path: name, sink };
    },
    read: () => Readable.from([Buffer.alloc(0)]),
    assertWithinLimit: () => Promise.resolve(),
    trackEntry: () => undefined,
    releaseEntry: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
  };

  const exporter = {
    // eslint-disable-next-line @typescript-eslint/require-await
    exportTable: async function* () {
      yield ROWS;

      return {
        table: 'tasks',
        rowsWritten: ROWS.length,
        rowsExpected: ROWS.length,
      };
    },
  } as unknown as TableExporterService;

  const service = new BackupWorkerService(
    {} as unknown as SupabaseAdminService,
    exporter,
    {} as unknown as BackupSecretsService,
    {} as unknown as SftpTargetAdapter,
    {} as unknown as BackupArchiveCipherService,
    {} as unknown as BackupSpoolService,
    {} as unknown as BackupStorageService,
  );

  const exportOne = (
    formats: BackupFileFormat | BackupFileFormat[],
  ): Promise<{ rows: number; members: { name: string; sha256: string }[] }> =>
    (
      service as unknown as {
        exportOne: (
          a: unknown,
          t: string,
          o: string,
          f: BackupFileFormat[],
          s: SpoolSession | null,
        ) => Promise<{
          rows: number;
          members: { name: string; sha256: string }[];
        }>;
      }
    ).exportOne(
      archive,
      'tasks',
      'org-1',
      Array.isArray(formats) ? formats : [formats],
      session,
    );

  /**
   * The bytes of the one member this export produced, once it has been fully read.
   *
   * The spooled path registers two: the staged file, which carries the bytes, and the archive
   * append of that file, which this harness reads back as empty. Only one ever has content.
   */
  const memberBytes = async (): Promise<Buffer> => {
    await Promise.all([...members.values()].map((member) => member.drained));

    // By byte count, not chunk count: the empty read-back still emits one zero-length chunk.
    const written = [...members.values()].filter(
      (member) => Buffer.concat(member.chunks).length > 0,
    );

    expect(written).toHaveLength(1);

    return Buffer.concat(written[0].chunks);
  };

  /** Every member that carries bytes, keyed by the name it was registered under. */
  const bytesByMember = async (): Promise<Map<string, Buffer>> => {
    await Promise.all([...members.values()].map((member) => member.drained));

    const written = new Map<string, Buffer>();

    for (const [name, member] of members) {
      const bytes = Buffer.concat(member.chunks);

      if (bytes.length) {
        written.set(name, bytes);
      }
    }

    return written;
  };

  return { exportOne, memberBytes, bytesByMember };
}

const EMPTY_SHA256 = createHash('sha256').digest('hex');

describe('member checksum', () => {
  // Every streaming format, because the fix is in the shared path and a regression in any one of
  // them is the same crash.
  for (const format of [
    'ndjson',
    'json',
    'sql',
    'csv',
    'tsv',
    'xml',
  ] as const) {
    it(`covers every byte of the ${format} member`, async () => {
      const { exportOne, memberBytes } = harness();

      const result = await exportOne(format);
      const bytes = await memberBytes();

      // The member has to be big enough that the hashing stream was genuinely paused part-way,
      // or this test passes for the wrong reason.
      expect(bytes.length).toBeGreaterThan(16 * 1024);

      expect(result.members[0].sha256).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(result.members[0].sha256).not.toBe(EMPTY_SHA256);
    });
  }

  it('covers every byte of the spooled XLSX member', async () => {
    const { exportOne, memberBytes } = harness();

    const result = await exportOne('xlsx');
    const bytes = await memberBytes();

    // XLSX stages to the spool instead, so its hash was already correct. Pinned so the shared
    // change cannot quietly break the one format that takes the other path.
    expect(bytes.length).toBeGreaterThan(0);
    expect(result.members[0].sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });

  it('gives each layer of a multi-format run its own correct digest', async () => {
    const { exportOne, bytesByMember } = harness();

    // SQL streams and NDJSON spools, so the two layers travel by different routes. Both digests
    // have to describe their own bytes — sharing one hash across layers is the mistake this
    // whole file exists to catch.
    const result = await exportOne(['sql', 'ndjson']);
    const written = await bytesByMember();

    expect(result.members).toHaveLength(2);

    for (const member of result.members) {
      // The spooled layer's real bytes are under its spool name; the archive entry for it is the
      // empty read-back this harness fakes.
      const bytes =
        written.get(member.name) ??
        written.get(member.name.replace(/^data\//, ''));

      expect(bytes?.length ?? 0).toBeGreaterThan(0);
      expect(member.sha256).toBe(
        createHash('sha256')
          .update(bytes as Buffer)
          .digest('hex'),
      );
    }

    expect(result.members[0].sha256).not.toBe(result.members[1].sha256);
  });

  it('stops feeding the hash before the digest is taken', async () => {
    const { exportOne, memberBytes } = harness();

    const result = await exportOne('ndjson');

    // The original crash was ERR_CRYPTO_HASH_FINALIZED raised inside the stream listener, after
    // exportOne had already returned. Draining fully past the end of the call is what surfaced it.
    await memberBytes();
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.rows).toBe(ROWS.length);
  });
});
