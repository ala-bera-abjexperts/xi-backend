/**
 * @fileoverview Tests for reading an archive back.
 * @module src/backup/engine/archive-reader.service.spec
 *
 * These build REAL zip bytes and read them with the real reader — no mocked zip, because the whole
 * risk here is that the reader and the format disagree, and a mock would only prove the reader
 * agrees with the mock.
 *
 * The zips are assembled by hand rather than with `archiver` for two reasons. `archiver@8` is
 * ESM-only and cannot be imported from this CommonJS test runner at all. More usefully, writing the
 * headers directly is the only way to forge the ones a real writer never emits — an unsupported
 * compression method, an impossible declared size — which are exactly the cases the guards exist
 * for and cannot otherwise be reached.
 *
 * The load-bearing assertions are the refusals. A restore cannot be undone, so a reader that hands
 * back rows from a member whose checksum does not match has already lost, whatever it does next.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { crc32, deflateRawSync } from 'node:zlib';
import type { ConfigService } from '@nestjs/config';
import { buildManifest } from './archive-manifest';
import {
  ArchiveReaderService,
  ArchiveReadError,
  type OpenedArchive,
} from './archive-reader.service';
import { BackupSpoolService } from './backup-spool.service';
import { planRestore } from './restore-planner';

const ORG = '9de67ec3-0000-0000-0000-000000000000';

/** Overrides written into the central directory only, to forge a header a writer never emits. */
interface Forged {
  compressionMethod?: number;
  compressedSize?: number;
  uncompressedSize?: number;
}

interface ZipMember {
  name: string;
  body: string;
  /** Stored rather than deflated. Both are methods this engine can produce. */
  store?: boolean;
  forge?: Forged;
}

/**
 * A minimal but genuine zip: local headers, file data, central directory, end record.
 *
 * No zip64 and no data descriptors — neither appears in an archive this product writes.
 */
function buildZip(members: ZipMember[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];

  let offset = 0;

  for (const member of members) {
    const nameBuf = Buffer.from(member.name, 'utf8');
    const raw = Buffer.from(member.body, 'utf8');
    const method = member.store ? 0 : 8;
    const data = member.store ? raw : deflateRawSync(raw);
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    // Bit 11 marks the name as UTF-8, which is how every writer here encodes it.
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    parts.push(local, nameBuf, data);

    const record = Buffer.alloc(46);

    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(member.forge?.compressionMethod ?? method, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(member.forge?.compressedSize ?? data.length, 20);
    record.writeUInt32LE(member.forge?.uncompressedSize ?? raw.length, 24);
    record.writeUInt16LE(nameBuf.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);

    central.push(record, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, directory, end]);
}

/** The common case: a map of name to contents, deflated. */
function zipOf(members: Record<string, string>): Buffer {
  return buildZip(
    Object.entries(members).map(([name, body]) => ({ name, body })),
  );
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A manifest in the shape `buildManifest` writes. */
function manifestFor(
  tables: { table: string; body: string; rows: number }[],
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    archive_version: 1,
    run_id: 'run-1',
    organization_id: ORG,
    created_at: '2026-08-05T00:00:00.000Z',
    encrypted: false,
    layer: 'data/',
    format: 'ndjson',
    app_restorable: true,
    table_count: tables.length,
    row_count: tables.reduce((sum, table) => sum + table.rows, 0),
    tables: tables.map((table) => ({
      table: table.table,
      rows: table.rows,
      sha256: sha256(table.body),
      status: 'succeeded',
    })),
    ...overrides,
  });
}

const TASKS_BODY = [
  `{"id":"t1","title":"First","organization_id":"${ORG}"}`,
  `{"id":"t2","title":"Second","organization_id":"${ORG}"}`,
  `{"id":"t3","title":"Third","organization_id":"${ORG}"}`,
  '',
].join('\n');

describe('ArchiveReaderService', () => {
  let root: string;
  const opened: OpenedArchive[] = [];

  function makeService(maxBytes = 2_147_483_648): ArchiveReaderService {
    const config = {
      get: (key: string) =>
        key === 'backup.spoolDir'
          ? root
          : key === 'backup.spoolMaxBytes'
            ? maxBytes
            : undefined,
    } as unknown as ConfigService;

    return new ArchiveReaderService(new BackupSpoolService(config));
  }

  /** Opens zip bytes and registers the handle for cleanup. */
  async function open(bytes: Buffer, label = 'spec'): Promise<OpenedArchive> {
    const archive = await makeService().open(Readable.from([bytes]), label);

    opened.push(archive);

    return archive;
  }

  /** Every row a generator yields, flattened. */
  async function collect(
    archive: OpenedArchive,
    table: string,
    batchRows?: number,
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];

    for await (const batch of archive.readTable(table, batchRows)) {
      rows.push(...batch);
    }

    return rows;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'xisuite-reader-spec-'));
  });

  afterEach(async () => {
    while (opened.length) {
      await opened.pop()?.close();
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('round trip', () => {
    it('reads back exactly the rows the writer put in', async () => {
      const archive = await open(
        zipOf({
          'data/tasks.ndjson': TASKS_BODY,
          'manifest.json': manifestFor([
            { table: 'tasks', body: TASKS_BODY, rows: 3 },
          ]),
        }),
      );

      const rows = await collect(archive, 'tasks');

      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual({
        id: 't1',
        title: 'First',
        organization_id: ORG,
      });
      expect(rows[2].title).toBe('Third');
    });

    /**
     * The seam, not each side of it.
     *
     * `manifestFor` below is a hand-written fixture in the shape `buildManifest` is BELIEVED to
     * write, and the writer's own spec never asserts which keys it emits. So both halves were
     * verified against a duplicated guess and nothing pinned them together — a rename on either
     * side would have passed green. This drives the real writer's output through the real reader.
     */
    it('reads back the organization id the writer actually wrote', async () => {
      const written = buildManifest({
        runId: 'run-1',
        organizationId: ORG,
        schemeVersion: 1,
        createdAt: new Date('2026-08-06T00:00:00.000Z'),
        formats: ['ndjson'],
        encrypted: false,
        tables: [
          {
            table: 'tasks',
            rows: 3,
            members: [
              {
                format: 'ndjson',
                name: 'data/tasks.ndjson',
                bytes: TASKS_BODY.length,
                sha256: createHash('sha256').update(TASKS_BODY).digest('hex'),
              },
            ],
          },
        ],
        filesCopied: 0,
        missingObjects: [],
      });

      const archive = await open(
        zipOf({ 'data/tasks.ndjson': TASKS_BODY, 'manifest.json': written }),
      );

      expect(archive.manifest?.organizationId).toBe(ORG);
      expect(archive.manifest?.runId).toBe('run-1');
    });

    it('reports the archive tenant, which the restore checks its own against', async () => {
      const archive = await open(
        zipOf({
          'data/tasks.ndjson': TASKS_BODY,
          'manifest.json': manifestFor([
            { table: 'tasks', body: TASKS_BODY, rows: 3 },
          ]),
        }),
      );

      expect(archive.manifest?.organizationId).toBe(ORG);
      expect(archive.manifest?.format).toBe('ndjson');
      expect(archive.manifest?.appRestorable).toBe(true);
      expect(archive.manifest?.tables.get('tasks')?.rows).toBe(3);
    });

    it('lists the restorable members it found', async () => {
      const archive = await open(
        zipOf({
          'data/tasks.ndjson': TASKS_BODY,
          'data/spaces.ndjson': '{"id":"s1"}\n',
          'README.txt': 'hello',
        }),
      );

      expect(archive.tables.map((table) => table.table).sort()).toEqual([
        'spaces',
        'tasks',
      ]);
    });

    it('yields rows in batches of the requested size', async () => {
      const archive = await open(zipOf({ 'data/tasks.ndjson': TASKS_BODY }));
      const sizes: number[] = [];

      for await (const batch of archive.readTable('tasks', 2)) {
        sizes.push(batch.length);
      }

      expect(sizes).toEqual([2, 1]);
    });

    it('reads a JSON array member', async () => {
      const archive = await open(
        zipOf({ 'data/tasks.json': '[\n{"id":"t1"},\n{"id":"t2"}\n]\n' }),
      );

      await expect(collect(archive, 'tasks')).resolves.toEqual([
        { id: 't1' },
        { id: 't2' },
      ]);
    });

    it('reads an empty table as zero rows, not as a failure', async () => {
      // A table with no rows is written as a zero-byte member. Treating that as damage would
      // refuse a perfectly good archive of an empty table.
      const archive = await open(
        buildZip([
          { name: 'data/tasks.ndjson', body: '', store: true },
          {
            name: 'manifest.json',
            body: manifestFor([{ table: 'tasks', body: '', rows: 0 }]),
          },
        ]),
      );

      await expect(collect(archive, 'tasks')).resolves.toEqual([]);
    });

    it('reads a stored member as well as a deflated one', async () => {
      // `compression: none` on the scheme writes members with method 0.
      const archive = await open(
        buildZip([
          { name: 'data/tasks.ndjson', body: TASKS_BODY, store: true },
        ]),
      );

      await expect(collect(archive, 'tasks')).resolves.toHaveLength(3);
    });
  });

  describe('checksum', () => {
    it('refuses a member that does not match the manifest', async () => {
      const archive = await open(
        zipOf({
          'data/tasks.ndjson': TASKS_BODY,
          // The manifest describes different bytes: the archive was altered or is damaged.
          'manifest.json': manifestFor([
            { table: 'tasks', body: 'something else entirely', rows: 3 },
          ]),
        }),
      );

      await expect(archive.verifyTable('tasks')).rejects.toThrow(
        ArchiveReadError,
      );
      await expect(archive.verifyTable('tasks')).rejects.toThrow(
        /does not match the checksum/,
      );
    });

    it('yields NOTHING from a member whose checksum fails', async () => {
      // The ordering property this whole file exists for. A checksum verified while inserting is
      // verified after inserting, and a restore cannot be rolled back.
      const archive = await open(
        zipOf({
          'data/tasks.ndjson': TASKS_BODY,
          'manifest.json': manifestFor([
            { table: 'tasks', body: 'tampered', rows: 3 },
          ]),
        }),
      );

      const seen: Record<string, unknown>[] = [];

      await expect(
        (async () => {
          for await (const batch of archive.readTable('tasks')) {
            seen.push(...batch);
          }
        })(),
      ).rejects.toThrow(ArchiveReadError);

      expect(seen).toHaveLength(0);
    });

    it('reports the digest it computed so a mismatch is diagnosable', async () => {
      const archive = await open(
        zipOf({
          'data/tasks.ndjson': TASKS_BODY,
          'manifest.json': manifestFor([
            { table: 'tasks', body: TASKS_BODY, rows: 3 },
          ]),
        }),
      );

      const check = await archive.verifyTable('tasks');

      expect(check.sha256).toBe(sha256(TASKS_BODY));
      expect(check.matched).toBe(true);
      expect(check.byteSize).toBe(Buffer.byteLength(TASKS_BODY));
    });

    it('still reads an archive written before manifests existed', async () => {
      // Refusing every older archive would make the restore useless exactly when it is needed.
      const archive = await open(zipOf({ 'data/tasks.ndjson': TASKS_BODY }));
      const check = await archive.verifyTable('tasks');

      expect(archive.manifest).toBeNull();
      // Null, not true: nothing was verified, and saying otherwise would be a lie.
      expect(check.matched).toBeNull();
      await expect(collect(archive, 'tasks')).resolves.toHaveLength(3);
    });

    it('refuses a table the archive does not contain', async () => {
      const archive = await open(zipOf({ 'data/tasks.ndjson': TASKS_BODY }));

      await expect(archive.verifyTable('spaces')).rejects.toThrow(
        /no restorable member for spaces/,
      );
    });
  });

  describe('hostile input', () => {
    it('refuses the whole archive when an entry path escapes it', async () => {
      // Refusing the file rather than the entry is deliberate: a path escape cannot be produced by
      // this engine's writer, so the archive is not the one it claims to be.
      await expect(
        open(
          zipOf({
            'data/tasks.ndjson': TASKS_BODY,
            'data/../../../etc/passwd': 'root:x:0:0',
          }),
        ),
      ).rejects.toThrow(/points outside the archive/);
    });

    it('refuses an absolute entry path', async () => {
      await expect(
        open(zipOf({ '/etc/passwd': 'root:x:0:0' })),
      ).rejects.toThrow(/points outside the archive/);
    });

    it('drops a member compressed in a way this engine never writes', async () => {
      const archive = await open(
        buildZip([
          { name: 'data/tasks.ndjson', body: TASKS_BODY },
          {
            name: 'data/spaces.ndjson',
            body: '{"id":"s1"}\n',
            // 12 is bzip2. The writer emits store or deflate and nothing else.
            forge: { compressionMethod: 12 },
          },
        ]),
      );

      expect(archive.tables.map((table) => table.table)).toEqual(['tasks']);
      expect(archive.rejectedEntries.join()).toMatch(
        /unsupported compression method 12/,
      );
    });

    it('drops a member claiming an impossible compression ratio', async () => {
      const archive = await open(
        buildZip([
          { name: 'data/tasks.ndjson', body: TASKS_BODY },
          {
            name: 'data/bomb.ndjson',
            body: '{"id":"b"}\n',
            // A gigabyte from a hundred bytes. Real row data reaches perhaps 20:1.
            forge: { compressedSize: 100, uncompressedSize: 1_000_000_000 },
          },
        ]),
      );

      expect(archive.tables.map((table) => table.table)).toEqual(['tasks']);
      expect(archive.rejectedEntries.join()).toMatch(
        /implausible compression ratio/,
      );
    });

    it('refuses an archive declaring more content than the ceiling allows', async () => {
      // Each of these is under the per-entry ratio cap; together they claim 21 GiB.
      const members = Array.from({ length: 21 }, (_, index) => ({
        name: `data/t${index}.ndjson`,
        body: '{"id":"x"}\n',
        forge: {
          compressedSize: 4 * 1024 * 1024,
          uncompressedSize: 1024 * 1024 * 1024,
        },
      }));

      await expect(open(buildZip(members))).rejects.toThrow(
        /declares more than/,
      );
    });

    it('names what it rejected rather than dropping it silently', async () => {
      const archive = await open(
        buildZip([
          { name: 'data/tasks.ndjson', body: TASKS_BODY },
          {
            name: 'data/spaces.ndjson',
            body: '{}',
            forge: { compressionMethod: 99 },
          },
        ]),
      );

      expect(archive.rejectedEntries).toHaveLength(1);
      expect(archive.rejectedEntries[0]).toContain('data/spaces.ndjson');
    });

    it('refuses a line that is not an object', async () => {
      const archive = await open(
        zipOf({ 'data/tasks.ndjson': '{"id":"t1"}\n["not","a","row"]\n' }),
      );

      await expect(collect(archive, 'tasks')).rejects.toThrow(
        /entry 2 is not an object/,
      );
    });

    it('names the line when NDJSON is malformed', async () => {
      const archive = await open(
        zipOf({ 'data/tasks.ndjson': '{"id":"t1"}\n{"id":\n' }),
      );

      // "Unexpected end of JSON input" alone is useless against a 200 000-line member.
      await expect(collect(archive, 'tasks')).rejects.toThrow(
        /tasks line 2 is not valid JSON/,
      );
    });

    it('refuses a JSON member that is not an array of rows', async () => {
      const archive = await open(
        zipOf({ 'data/tasks.json': '{"rows":[{"id":"t1"}]}\n' }),
      );

      await expect(collect(archive, 'tasks')).rejects.toThrow(
        /not a JSON array of rows/,
      );
    });

    it('refuses a manifest that is not valid JSON', async () => {
      // A manifest that cannot be parsed means checksums cannot be checked at all, which is not
      // the same as an archive that never had one and must not be treated like it.
      await expect(
        open(
          zipOf({
            'data/tasks.ndjson': TASKS_BODY,
            'manifest.json': '{ this is not json',
          }),
        ),
      ).rejects.toThrow(/manifest is not valid JSON/);
    });

    it('refuses an empty stream', async () => {
      await expect(
        makeService().open(Readable.from([]), 'spec'),
      ).rejects.toThrow(/empty/);
    });

    it('refuses something that is not a zip at all', async () => {
      await expect(
        makeService().open(
          Readable.from([Buffer.from('not a zip file', 'utf8')]),
          'spec',
        ),
      ).rejects.toThrow(ArchiveReadError);
    });

    it('refuses an archive larger than the spool limit', async () => {
      await expect(
        makeService(10).open(
          Readable.from([zipOf({ 'data/tasks.ndjson': TASKS_BODY })]),
          'spec',
        ),
      ).rejects.toThrow(/larger than the 10-byte spool limit/);
    });
  });

  describe('what is not a restorable table', () => {
    it('ignores a SQL member it did not write', async () => {
      const archive = await open(
        zipOf({
          // Lower-case, unquoted, no column list: valid SQL, but not this writer's grammar. The
          // reader parses one dialect — its own — and anything else is not a table.
          'data/03-tasks.sql': 'insert into tasks values (1);\n',
          'README.txt': 'hello',
        }),
      );

      // Listed, because the extension says it is a layer; reading it is what refuses.
      expect(archive.tables.map((entry) => entry.table)).toEqual(['tasks']);
      await expect(collect(archive, 'tasks')).rejects.toThrow(ArchiveReadError);
    });

    it('ignores CSV, which cannot tell an empty value from a missing one', async () => {
      const archive = await open(
        zipOf({ 'data/tasks.csv': 'id,title\n1,x\n' }),
      );

      expect(archive.tables).toEqual([]);
    });

    it('ignores copied files, which are not rows', async () => {
      const archive = await open(
        zipOf({
          'data/tasks.ndjson': TASKS_BODY,
          'files/attachments/logo.png': 'binary-ish',
        }),
      );

      expect(archive.tables.map((table) => table.table)).toEqual(['tasks']);
    });
  });

  describe('an archive holding several layers', () => {
    it('reads the NDJSON layer and ignores the SQL one beside it', async () => {
      const archive = await open(
        zipOf({
          'data/03-tasks.sql': 'insert into tasks values (1);\n',
          'data/tasks.ndjson': TASKS_BODY,
          'manifest.json': manifestFor([
            { table: 'tasks', body: TASKS_BODY, rows: 3 },
          ]),
        }),
      );

      // One table, once. The SQL member is skipped, not counted as a second copy.
      expect(archive.tables.map((table) => table.table)).toEqual(['tasks']);
      expect(archive.tables[0].entryName).toBe('data/tasks.ndjson');
      expect(await collect(archive, 'tasks')).toHaveLength(3);
    });

    it('does not report the export layers as damage', async () => {
      const archive = await open(
        zipOf({
          'data/03-tasks.sql': 'insert into tasks values (1);\n',
          'data/tasks.csv': 'id,title\n1,x\n',
          'data/tasks.ndjson': TASKS_BODY,
        }),
      );

      // Skipped is not rejected. An operator who ticked three formats must not be told their
      // archive has two problems in it.
      expect(archive.rejectedEntries).toEqual([]);
    });

    it('reports the format it will read, not the one the manifest names', async () => {
      const archive = await open(
        zipOf({
          'data/03-tasks.sql': 'insert into tasks values (1);\n',
          'data/tasks.ndjson': TASKS_BODY,
          'manifest.json': manifestFor(
            [{ table: 'tasks', body: TASKS_BODY, rows: 3 }],
            { format: 'sql', formats: ['sql', 'ndjson'] },
          ),
        }),
      );

      // The restore decides from this. Taking the manifest's scalar instead would refuse an
      // archive that holds a perfectly readable NDJSON layer.
      expect(archive.manifest?.format).toBe('sql');
      expect(archive.restorableFormat).toBe('ndjson');
    });

    it('is not refused by the planner just because the manifest says SQL', async () => {
      const archive = await open(
        zipOf({
          'data/03-tasks.sql': 'insert into tasks values (1);\n',
          'data/tasks.ndjson': TASKS_BODY,
          'manifest.json': manifestFor(
            [{ table: 'tasks', body: TASKS_BODY, rows: 3 }],
            { format: 'sql', formats: ['sql', 'ndjson'] },
          ),
        }),
      );

      // The composition that matters, end to end: the reader derives the format from the member it
      // will open, and the planner decides from that. Passing the manifest's scalar instead turns
      // `format_not_restorable` into a fatal refusal of an archive that reads perfectly — the
      // feature would look finished and every restore would still fail.
      const plan = planRestore({
        selection: ['tasks'],
        format: archive.restorableFormat as 'ndjson',
        archiveOrganizationId: ORG,
        sessionOrganizationId: ORG,
      });

      expect(plan.refusals.map((refusal) => refusal.code)).not.toContain(
        'format_not_restorable',
      );
      expect(plan.canProceed).toBe(true);
    });

    it('prefers NDJSON when JSON is present too', async () => {
      const jsonBody = `[\n{"id":"t1","organization_id":"${ORG}"}\n]\n`;

      const archive = await open(
        zipOf({
          'data/tasks.json': jsonBody,
          'data/tasks.ndjson': TASKS_BODY,
        }),
      );

      // Both are readable, so without a fixed preference which one gets read would depend on zip
      // ordering. NDJSON streams and has no size ceiling.
      expect(archive.tables).toHaveLength(1);
      expect(archive.tables[0].entryName).toBe('data/tasks.ndjson');
      expect(archive.restorableFormat).toBe('ndjson');
    });

    it('prefers NDJSON whichever order the members appear in', async () => {
      const jsonBody = `[\n{"id":"t1","organization_id":"${ORG}"}\n]\n`;

      const archive = await open(
        zipOf({
          'data/tasks.ndjson': TASKS_BODY,
          'data/tasks.json': jsonBody,
        }),
      );

      expect(archive.tables[0].entryName).toBe('data/tasks.ndjson');
    });

    it('verifies against the digest recorded for that member', async () => {
      const archive = await open(
        zipOf({
          'data/03-tasks.sql': 'insert into tasks values (1);\n',
          'data/tasks.ndjson': TASKS_BODY,
          'manifest.json': manifestFor(
            [{ table: 'tasks', body: TASKS_BODY, rows: 3 }],
            {
              formats: ['sql', 'ndjson'],
              tables: [
                {
                  table: 'tasks',
                  rows: 3,
                  status: 'succeeded',
                  members: [
                    {
                      name: 'data/03-tasks.sql',
                      format: 'sql',
                      sha256: 'a'.repeat(64),
                    },
                    {
                      name: 'data/tasks.ndjson',
                      format: 'ndjson',
                      sha256: sha256(TASKS_BODY),
                    },
                  ],
                },
              ],
            },
          ),
        }),
      );

      const verified = await archive.verifyTable('tasks');

      // Matched against the NDJSON member's own digest. The SQL digest in the same entry is for
      // different bytes and must not be what this is compared with.
      expect(verified.matched).toBe(true);
      expect(verified.expectedSha256).toBe(sha256(TASKS_BODY));
    });

    it('still verifies an archive written before members were recorded', async () => {
      const archive = await open(
        zipOf({
          'data/tasks.ndjson': TASKS_BODY,
          'manifest.json': manifestFor([
            { table: 'tasks', body: TASKS_BODY, rows: 3 },
          ]),
        }),
      );

      // The legacy shape: one scalar sha256 per table, no members array. Every archive taken
      // before this change looks like this, and they have to keep restoring.
      const verified = await archive.verifyTable('tasks');

      expect(verified.matched).toBe(true);
    });

    it('still refuses a member whose bytes do not match its recorded digest', async () => {
      const archive = await open(
        zipOf({
          'data/03-tasks.sql': 'insert into tasks values (1);\n',
          'data/tasks.ndjson': TASKS_BODY,
          'manifest.json': manifestFor([
            { table: 'tasks', body: 'x', rows: 3 },
          ]),
        }),
      );

      // Extra layers must not weaken the one guard that matters.
      await expect(archive.verifyTable('tasks')).rejects.toThrow(
        ArchiveReadError,
      );
    });
  });

  describe('cleanup', () => {
    it('deletes the spooled copy when the archive is closed', async () => {
      const archive = await makeService().open(
        Readable.from([zipOf({ 'data/tasks.ndjson': TASKS_BODY })]),
        'cleanup-1',
      );

      for await (const batch of archive.readTable('tasks')) {
        expect(batch.length).toBeGreaterThan(0);
      }

      await archive.close();

      // A restore that leaves its copy of every archive behind fills the disk in a week.
      await expect(readdir(root)).resolves.not.toContain(
        'xisuite-backup-restore-cleanup-1',
      );
    });

    it('is safe to close twice', async () => {
      const archive = await makeService().open(
        Readable.from([zipOf({ 'data/tasks.ndjson': TASKS_BODY })]),
        'cleanup-2',
      );

      await archive.close();
      await expect(archive.close()).resolves.toBeUndefined();
    });

    it('leaves nothing behind when the archive is refused', async () => {
      const before = await readdir(root);

      await expect(
        makeService().open(
          Readable.from([Buffer.from('rubbish', 'utf8')]),
          'refused',
        ),
      ).rejects.toThrow(ArchiveReadError);

      // The failure path has to clean up too, or a handful of refused restores fills the volume.
      await expect(readdir(root)).resolves.toEqual(before);
    });
  });
});

/**
 * A download that stops arriving.
 *
 * This is what a restore actually hung on: the SFTP stream opened, the run wrote `validating`, and
 * then not one byte arrived. `pipeline` waits for a source to end, and a socket that is gone never
 * ends and never errors — so the run sat there for minutes holding the organization's only restore
 * slot, while previews that work finish in seven seconds.
 *
 * Fake timers because the real budget is a minute; the point is the behaviour, not the wait.
 */
describe('ArchiveReaderService spool liveness', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'spool-idle-'));

    // Only `setTimeout` is faked. The spool writes to a real file, and Node's stream and fs
    // machinery runs on `setImmediate` and `nextTick` — faking those freezes the write itself, so
    // the test hangs on the very I/O it is trying to observe rather than on the deadline.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  function makeService(): ArchiveReaderService {
    const config = {
      get: (key: string) =>
        key === 'backup.spoolDir'
          ? root
          : key === 'backup.spoolMaxBytes'
            ? 2_147_483_648
            : undefined,
    } as unknown as ConfigService;

    return new ArchiveReaderService(new BackupSpoolService(config));
  }

  it('abandons a stream that goes silent instead of waiting for ever', async () => {
    // Never pushes and never ends — exactly what a dead SFTP connection looks like from here.
    const silent = new Readable({ read() {} });

    const opening = makeService().open(silent, 'stalled');

    // Nothing has arrived, so the clock that was armed before the pipeline is the only thing that
    // can end this.
    // Wait until `open` has ACTUALLY armed the liveness timer. A fixed number of ticks is a race:
    // the spool session is created with real filesystem I/O first, and under a loaded full-suite
    // run that outlives a single setImmediate — advancing then moves a clock with nothing on it and
    // the assertion below hangs instead of failing. Polling the fake-timer count is deterministic.
    for (let i = 0; jest.getTimerCount() === 0 && i < 1000; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(jest.getTimerCount()).toBeGreaterThan(0);

    await jest.advanceTimersByTimeAsync(61_000);

    await expect(opening).rejects.toThrow(/stopped sending this archive/i);

    // Destroyed, not merely rejected. A promise that rejects while the socket stays open leaves the
    // connection leased, and the next restore inherits the exhaustion that caused this one.
    expect(silent.destroyed).toBe(true);
  });

  it('does not cut off a slow download that is still making progress', async () => {
    // A chunk every 50s, for four minutes total — far past the 60s budget in aggregate, but never
    // silent for a minute. A cap on total time would kill this; a liveness check must not.
    const slow = new Readable({ read() {} });
    const opening = makeService().open(slow, 'slow');

    for (let i = 0; i < 5; i += 1) {
      await jest.advanceTimersByTimeAsync(50_000);
      slow.push(Buffer.from('PK'));
    }

    await jest.advanceTimersByTimeAsync(1_000);
    slow.push(null);

    // It fails as a malformed zip, NOT as a stall — which is the whole point: the transport stayed
    // alive, so the deadline never fired.
    await expect(opening).rejects.not.toThrow(/stopped sending/i);
  });
});
