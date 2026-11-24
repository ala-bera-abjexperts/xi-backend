/**
 * @fileoverview What a table actually contributes to the archive.
 * @module src/backup/engine/backup-worker.members.spec
 *
 * Nothing asserted this before. Every other test covered what the writers PRODUCE or what the
 * manifest SAYS; none covered which members were appended. That gap is why an archive shipped
 * carrying two layers when one was asked for, and it is what would have hidden the worse bug:
 * with the NDJSON layer removed, a table whose writer could not be created appended nothing at
 * all, while its rows were counted and its item marked `succeeded`.
 *
 * So these tests assert membership directly: one member per table, named for the chosen format,
 * and a hard failure rather than silence when it cannot be written.
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

const ROWS = [
  { id: 'a', title: 'First' },
  { id: 'b', title: 'Second' },
];

/** Collects the member names an export appends, and the bytes of any spooled file. */
function harness() {
  const appended: string[] = [];
  const spooled = new Map<string, Buffer[]>();

  const archive = {
    append: (source: NodeJS.ReadableStream, options: { name: string }) => {
      appended.push(options.name);
      // Drain, or a spooled read stream would keep the process handle open.
      source.resume();

      return undefined;
    },
  };

  const session: SpoolSession = {
    open: (name: string) => {
      const chunks: Buffer[] = [];

      spooled.set(name, chunks);

      const sink = new PassThrough();

      sink.on('data', (chunk: Buffer) => chunks.push(chunk));

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

      return { table: 'tasks', rowsWritten: 2, rowsExpected: 2 };
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

  /** exportOne is private; membership is the behaviour under test, not the access modifier. */
  const exportOne = (
    formats: BackupFileFormat | BackupFileFormat[],
    withSession: SpoolSession | null = session,
  ): Promise<{
    rows: number;
    members: { name: string; format: string; sha256: string }[];
  }> =>
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
          members: { name: string; format: string; sha256: string }[];
        }>;
      }
    ).exportOne(
      archive,
      'tasks',
      'org-1',
      Array.isArray(formats) ? formats : [formats],
      withSession,
    );

  return { appended, spooled, exportOne };
}

describe('archive membership', () => {
  it('appends exactly one member per table for NDJSON', async () => {
    const { appended, exportOne } = harness();

    await exportOne('ndjson');

    expect(appended).toEqual(['data/tasks.ndjson']);
  });

  it('appends exactly one member per table for SQL, numbered for insert order', async () => {
    const { appended, exportOne } = harness();

    await exportOne('sql');

    // One member, in data/, with the dependency-level prefix that makes `psql -f` order correct.
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatch(/^data\/\d{2}-tasks\.sql$/);
  });

  it('never writes NDJSON when another format was chosen', async () => {
    for (const format of ['sql', 'csv', 'tsv', 'xml', 'xlsx'] as const) {
      const { appended, exportOne } = harness();

      await exportOne(format);

      // Still true with several formats available: the archive holds what was asked for and
      // nothing else. NDJSON is never added behind the operator's back.
      expect(appended.some((name) => name.endsWith('.ndjson'))).toBe(false);
      expect(appended).toHaveLength(1);
      expect(appended[0]).toContain(`.${format}`);
    }
  });

  it('appends one member per selected format', async () => {
    const { appended, exportOne } = harness();

    const result = await exportOne(['sql', 'ndjson']);

    // The point of the whole change: one zip that a person can read with psql and the product can
    // restore from.
    expect(appended).toHaveLength(2);
    expect(appended.some((name) => /^data\/\d{2}-tasks\.sql$/.test(name))).toBe(
      true,
    );
    expect(appended).toContain('data/tasks.ndjson');
    expect(result.members.map((member) => member.name)).toEqual(appended);
  });

  it('streams exactly one layer and spools the rest', async () => {
    const { appended, spooled, exportOne } = harness();

    await exportOne(['sql', 'ndjson', 'csv']);

    // Archiver reads one member at a time, so only one may be open while rows are written. The
    // others are staged and appended afterwards — holding two open is the original deadlock.
    expect(appended).toHaveLength(3);
    expect([...spooled.keys()].sort()).toEqual(['tasks.csv', 'tasks.ndjson']);
  });

  it('puts the streamed layer first, so members[0] is the one on the run item', async () => {
    const { exportOne } = harness();

    const result = await exportOne(['xlsx', 'ndjson']);

    // XLSX cannot stream, so NDJSON is the streamed layer even though it was picked second.
    expect(result.members[0].name).toBe('data/tasks.ndjson');
  });

  it('spools every layer when none of them can stream', async () => {
    const { appended, spooled, exportOne } = harness();

    await exportOne(['xlsx']);

    expect(appended).toEqual(['data/tasks.xlsx']);
    expect([...spooled.keys()]).toEqual(['tasks.xlsx']);
  });

  it('refuses a multi-format run with no spool rather than dropping a layer', async () => {
    const { appended, exportOne } = harness();

    // Checked before any member is appended: opening one and then failing would leave a member
    // archiver can never finish reading, which hangs the run instead of failing it.
    await expect(exportOne(['sql', 'ndjson'], null)).rejects.toThrow(
      /no spool is available/,
    );
    expect(appended).toEqual([]);
  });

  it('never writes into an export/ folder', async () => {
    const { appended, exportOne } = harness();

    await exportOne('sql');

    expect(appended.some((name) => name.startsWith('export/'))).toBe(false);
  });

  it('spools XLSX and nothing else', async () => {
    for (const format of [
      'sql',
      'csv',
      'tsv',
      'xml',
      'json',
      'ndjson',
    ] as const) {
      const { spooled, exportOne } = harness();

      await exportOne(format);

      // These all stream straight into the archive. Spooling them cost a write to disk and a read
      // back per table for no benefit — the two-member deadlock that required it is gone.
      expect([...spooled.keys()]).toEqual([]);
    }

    const { spooled, exportOne } = harness();

    await exportOne('xlsx');

    // XLSX genuinely cannot stream: SheetJS emits one Buffer at finish().
    expect([...spooled.keys()]).toEqual(['tasks.xlsx']);
  });

  it('throws rather than appending nothing when XLSX has no spool', async () => {
    const { appended, exportOne } = harness();

    // Without this guard the loop would read every row, count them, append NOTHING, and the item
    // would still be marked succeeded — a table silently missing from a "successful" backup.
    await expect(exportOne('xlsx', null)).rejects.toThrow(
      /no spool is available/,
    );
    expect(appended).toHaveLength(0);
  });

  it('still counts rows correctly for a spooled format', async () => {
    const { exportOne } = harness();

    await expect(exportOne('sql')).resolves.toMatchObject({ rows: 2 });
  });

  it('checksums the bytes that reach the archive, not a layer that is gone', async () => {
    const { exportOne } = harness();

    const sql = await exportOne('sql');
    const ndjson = await exportOne('ndjson');

    // Both are real sha256 hex digests, and they differ because the bytes differ. Before this
    // change both formats reported the hash of the NDJSON layer.
    expect(sql.members[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ndjson.members[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sql.members[0].sha256).not.toEqual(ndjson.members[0].sha256);
  });

  it('gives each layer of one table its own digest', async () => {
    const { exportOne } = harness();

    const result = await exportOne(['sql', 'ndjson']);

    // Same rows, different bytes. One digest per member is what lets a restore verify the layer it
    // actually reads rather than whichever one happened to be hashed.
    expect(result.members).toHaveLength(2);
    expect(result.members[0].sha256).not.toEqual(result.members[1].sha256);
    expect(new Set(result.members.map((m) => m.format)).size).toBe(2);
  });

  it('hashes the same bytes it wrote, for the format that still spools', async () => {
    const { spooled, exportOne } = harness();

    const { members } = await exportOne('xlsx');
    const written = Buffer.concat(spooled.get('tasks.xlsx') ?? []);

    expect(written.length).toBeGreaterThan(0);
    expect(createHash('sha256').update(written).digest('hex')).toBe(
      members[0].sha256,
    );
  });
});
