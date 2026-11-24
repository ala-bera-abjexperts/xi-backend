/**
 * @fileoverview Reads an archive back — the half of a backup product that proves the other half.
 * @module src/backup/engine/archive-reader.service
 *
 * Until this existed the engine could only write. `archiver` has no reader, so an archive was a
 * one-way door: the bytes went to an SFTP server and nothing in this codebase could ever open them
 * again. Every guarantee the backup makes — this many rows, this checksum, this organization — was
 * therefore unfalsifiable, which is the same thing as untrue.
 *
 * ## What this is handed
 *
 * A PLAINTEXT zip stream. Decryption is not repeated here: `BackupArchivesService.openForDownload`
 * already reads the header, verifies the passphrase before a byte is transferred, and returns a
 * decrypted stream. Reusing it means one crypto implementation and one place where a wrong
 * passphrase is diagnosed — a second one here would eventually disagree with the first.
 *
 * ## Why the stream is spooled to disk first
 *
 * A zip's index lives at the END of the file. A streaming reader has to trust the local header in
 * front of each member instead, and those two structures are allowed to disagree — that
 * disagreement is the basis of most zip parser attacks. Writing the stream to a temp file first
 * buys random access, so the central directory is the only thing this ever believes.
 *
 * ## The order of operations is the safety property
 *
 * Every table is hashed and compared against `manifest.json` BEFORE a single row of it is handed
 * back. A checksum verified while inserting would be verified after inserting — the mismatch would
 * be discovered with the rows already in the database, and a restore cannot be rolled back.
 */

import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable, Logger } from '@nestjs/common';
import { openPromise, type Entry, type ZipFile } from 'yauzl';
import { BackupSpoolService, type SpoolSession } from './backup-spool.service';
import { SqlRowReader } from './writers/sql.reader';
import {
  isBackupFileFormat,
  RESTORABLE_FORMATS,
  type BackupFileFormat,
} from './writers/table-writer';

/** Entries a zip may declare before this refuses to index it. */
const MAX_ENTRIES = 50_000;

/** Total declared uncompressed size across every entry. The zip-bomb ceiling. */
const MAX_TOTAL_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024;

/**
 * Compression ratio one entry may claim.
 *
 * Deflate on row data reaches perhaps 20:1. A thousand-to-one entry is not a table.
 */
const MAX_ENTRY_RATIO = 1000;

/**
 * Ceiling on a `.json` table, which cannot be parsed incrementally.
 *
 * NDJSON is parsed a line at a time and has no such limit — which is the practical reason it is the
 * format to choose when an archive is meant to be restored.
 */
const MAX_JSON_TABLE_BYTES = 256 * 1024 * 1024;

/** Rows handed to the caller at a time. */
const DEFAULT_BATCH_ROWS = 500;

/** Compression methods this ever wrote: stored and deflate. */
const ALLOWED_COMPRESSION_METHODS = new Set([0, 8]);

/** Table names the writer can produce — `assertSafeIdentifier` guarantees this shape. */
const SAFE_TABLE_NAME = /^[a-z0-9_]+$/;

/**
 * How long the download may produce nothing before it is called dead.
 *
 * A liveness budget, not a throughput one: the timer is reset by every chunk, so a large archive on
 * a slow link is never cut off. What it catches is a stream that has gone silent — an SFTP
 * connection whose socket is gone but which never ends and never errors, so `pipeline` waits on it
 * for ever. A restore stopped exactly there, sat in `validating` for minutes holding the
 * organization's only restore slot, against previews that normally finish in seven seconds.
 *
 * Sixty seconds is far past any real gap between chunks and well short of the point where an
 * operator starts wondering whether the product is broken.
 */
const SPOOL_IDLE_TIMEOUT_MS = 60_000;

/** How often the download may report itself. Fine enough to look live, coarse enough to be cheap. */
const PROGRESS_REPORT_INTERVAL_MS = 1_000;

/**
 * What opening an archive can say about itself while it happens.
 *
 * Two phases, because there are genuinely two and they can say different things. A zip keeps its
 * directory at the END of the file, so until every byte has arrived nothing knows which tables are
 * inside — the only honest report during the download is how much of it has landed. Once indexed,
 * the tables can be named.
 *
 * This matters more than it sounds: a 113 MB archive spent minutes here reporting nothing at all,
 * which read as a hang and was cancelled by hand three times.
 */
export type ArchiveOpenProgress =
  | { phase: 'downloading'; bytes: number }
  | { phase: 'indexed'; tables: string[] };

/**
 * Which layer to read when an archive holds several, best first.
 *
 * Ranked rather than first-wins, so the choice never depends on the order entries happen to appear
 * in the zip. Every format is listed, so adding a reader is a change to RESTORABLE_FORMATS and the
 * matcher below — never a silent reordering here.
 *
 *   ndjson  streams, no size ceiling
 *   json    equally exact, but must be held whole
 *   sql     exact, but a parse of a text dump rather than of a data format
 *   xml     null and empty survive, types do not
 *   csv/tsv/xlsx  cannot tell empty from NULL, and the formula guard has already rewritten any
 *                 value starting with = + - @
 *
 * The last four have no reader and are not in RESTORABLE_FORMATS, so they are never selected.
 * Their place in this order is what they would rank if one is ever written.
 */
const READ_PREFERENCE: readonly BackupFileFormat[] = [
  'ndjson',
  'json',
  'sql',
  'xml',
  'csv',
  'tsv',
  'xlsx',
];

export class ArchiveReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveReadError';
  }
}

/** One table's row in `manifest.json`, as written by the run that produced the archive. */
export interface ManifestTableEntry {
  rows: number;
  /**
   * The single digest older archives recorded, when `data/` held one file per table.
   *
   * Empty for archives that carry several layers — those record a digest per member below, because
   * one table no longer means one set of bytes.
   */
  sha256: string;
  /** Digest per member name, e.g. `data/03-tasks.sql`. Empty for single-layer archives. */
  members: Map<string, string>;
  status: string;
}

export interface ArchiveManifestSummary {
  archiveVersion: number | null;
  runId: string | null;
  /** The tenant the archive was taken from. The restore's tenant boundary is checked against this. */
  organizationId: string | null;
  format: BackupFileFormat | null;
  /** The manifest's own claim about whether this product can read the archive back. */
  appRestorable: boolean;
  createdAt: string | null;
  rowCount: number | null;
  tables: Map<string, ManifestTableEntry>;
}

export interface ArchiveTableEntry {
  table: string;
  entryName: string;
  /** Which reader this member needs, and how the layer preference is ranked. */
  extension: BackupFileFormat;
  /** From the central directory, and enforced against the bytes actually read. */
  uncompressedSize: number;
}

export interface TableVerification {
  table: string;
  sha256: string;
  byteSize: number;
  /** Null when the archive has no manifest to compare against. */
  matched: boolean | null;
  expectedSha256: string | null;
}

export interface OpenedArchive {
  /** Null for an archive written before manifests existed. Reported, never fatal. */
  manifest: ArchiveManifestSummary | null;

  /**
   * The format of the members inside, from the manifest.
   *
   * Null when there is no manifest; the caller falls back to the extensions in `tables`.
   */
  format: BackupFileFormat | null;

  /**
   * The format of the members a restore will ACTUALLY read, taken from their file extensions.
   *
   * Not the same thing as `format`. An archive may hold several layers, and its manifest names one
   * of them; a restore that decided from that scalar would refuse a mixed SQL+NDJSON archive whose
   * manifest happens to say `sql`, even though the NDJSON layer beside it is perfectly readable.
   * Null when the archive has no restorable member at all.
   */
  restorableFormat: BackupFileFormat | null;

  /** Restorable table members found in `data/`, in archive order. */
  tables: ArchiveTableEntry[];

  /** Names in the zip that were rejected, with the reason. Reported so nothing vanishes silently. */
  rejectedEntries: string[];

  /** Hashes one table and compares it with the manifest. Throws on a mismatch. */
  verifyTable(table: string): Promise<TableVerification>;

  /**
   * Yields batches of rows. Verifies the table's checksum FIRST — nothing is handed back from an
   * entry whose bytes have not already been proven to match the manifest.
   */
  readTable(
    table: string,
    batchRows?: number,
  ): AsyncGenerator<Record<string, unknown>[]>;

  /**
   * Where the decrypted archive is staged on local disk, valid until `close()`.
   *
   * Exposed so the restore can copy it into the archive cache without reading it back through this
   * handle. It is a plaintext copy of a tenant's data — do not hand the path anywhere that outlives
   * the run.
   */
  spoolPath: string;

  /** Closes the zip and deletes the spooled copy. Safe to call twice. */
  close(): Promise<void>;
}

@Injectable()
export class ArchiveReaderService {
  private readonly logger = new Logger(ArchiveReaderService.name);

  constructor(private readonly spool: BackupSpoolService) {}

  /**
   * The largest archive this can open, in bytes.
   *
   * Exposed so a caller can refuse an oversized archive BEFORE downloading it. Reading spools the
   * whole file to local disk first — the zip directory lives at the end, so nothing can be read
   * until all of it has arrived — and the size check therefore happens at the very end of the
   * transfer. An archive larger than the disk allowance is spent on in full, over the network,
   * only to be told it never had a chance.
   */
  get maxArchiveBytes(): number {
    return this.spool.maxBytes;
  }

  /**
   * Spools a decrypted archive to disk and indexes it.
   *
   * @param source A PLAINTEXT zip stream — already decrypted by the download path.
   * @param label Identifies the temp directory, so a crashed restore leaves traceable files.
   * @throws ArchiveReadError when the stream is not a zip this engine could have written.
   */
  async open(
    source: Readable,
    label: string,
    onProgress?: (progress: ArchiveOpenProgress) => void,
  ): Promise<OpenedArchive> {
    const session = await this.spool.createSession(`restore-${label}`);

    try {
      const path = await this.spoolToDisk(source, session, onProgress);

      return await this.indexSpooled(path, session, onProgress);
    } catch (err) {
      // A failure here leaves neither an open file descriptor nor a temp file behind. Without this
      // a rejected archive would leak both, and a few refused restores would fill the disk.
      // `indexSpooled` closes its own zip handle before rethrowing.
      await session.dispose();

      throw err instanceof ArchiveReadError
        ? err
        : new ArchiveReadError(
            `This archive could not be opened: ${(err as Error).message}`,
          );
    }
  }

  /** Opens and indexes a zip already on local disk. Shared by the download and reuse paths. */
  private async indexSpooled(
    path: string,
    session: SpoolSession,
    onProgress?: (progress: ArchiveOpenProgress) => void,
  ): Promise<OpenedArchive> {
    // `validateEntrySizes` makes yauzl reject an entry whose real size differs from the size the
    // central directory declared — which is what lets the declared totals below be trusted at all.
    // `lazyEntries` keeps indexing under this loop's control rather than an event storm.
    const zip = await openPromise(path, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      autoClose: false,
    });

    try {
      const { entries, rejected } = await this.indexEntries(zip);

      // The first moment a table can be named at all. Everything before this is a byte count: a zip
      // keeps its directory at the END of the file, so nothing knows what is inside until the whole
      // archive has arrived and been indexed. Reported here so the wizard can stop counting bytes
      // and start naming things.
      onProgress?.({ phase: 'indexed', tables: [...entries.keys()] });

      const manifest = await this.readManifest(zip, entries);

      return this.build(zip, session, entries, rejected, manifest, path);
    } catch (err) {
      zip.close();

      throw err;
    }
  }

  /** Writes the stream to a temp file, refusing to fill the disk with it. */
  private async spoolToDisk(
    source: Readable,
    session: SpoolSession,
    onProgress?: (progress: ArchiveOpenProgress) => void,
  ): Promise<string> {
    const staged = session.open('archive.zip');
    const limit = this.spool.maxBytes;

    let written = 0;
    let lastReportedAt = 0;

    /**
     * Fails a download that has stopped arriving.
     *
     * Nothing else bounds this. `pipeline` waits for the source to end, and an SFTP stream whose
     * connection has gone quiet never ends and never errors — so the whole restore stopped here,
     * with its status written as `validating` and nothing after it. Observed at five minutes and
     * still climbing, holding the organization's only restore slot, against previews that normally
     * finish in seven seconds.
     *
     * The clock is on SILENCE, not on total time: it is reset by every chunk below, so a large
     * archive on a slow link takes as long as it takes. Only a stream that has produced nothing at
     * all for a minute is called dead.
     *
     * `source.destroy(err)` rather than a rejected promise, because rejecting leaves the socket
     * open — the connection stays leased, and the next restore inherits the exhaustion that caused
     * this one. Destroying the source makes `pipeline` tear the whole chain down, which also removes
     * the half-written temp file.
     */
    let idle: NodeJS.Timeout | undefined;

    const armIdleTimer = () => {
      if (idle) {
        clearTimeout(idle);
      }

      idle = setTimeout(() => {
        source.destroy(
          new ArchiveReadError(
            `The target stopped sending this archive after ${written} byte(s) — nothing arrived ` +
              `for ${Math.round(SPOOL_IDLE_TIMEOUT_MS / 1000)}s, so the download was abandoned. ` +
              'Check the backup target is reachable and try again.',
          ),
        );
      }, SPOOL_IDLE_TIMEOUT_MS);
    };

    // Counted inside the pipeline rather than from a `data` listener: attaching one of those puts
    // the source into flowing mode before the destination is wired up. The limit is enforced as the
    // bytes pass, so an archive larger than the volume stops while it is still failing cheaply
    // instead of after it has filled the disk.
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written += chunk.length;

        // Progress, so the stall clock starts again. This is what keeps the deadline a liveness
        // check rather than a cap on how long a legitimate download may take.
        armIdleTimer();

        // Throttled, because this is the hot path — a 113 MB archive at 2 MB a chunk is fine, but
        // the same callback on a 32 KB chunk size would fire thousands of times and each report
        // costs a database write upstream. A second's granularity is far finer than anyone reads.
        const now = Date.now();

        if (now - lastReportedAt >= PROGRESS_REPORT_INTERVAL_MS) {
          lastReportedAt = now;
          onProgress?.({ phase: 'downloading', bytes: written });
        }

        if (written > limit) {
          done(
            new ArchiveReadError(
              `This archive is larger than the ${limit}-byte spool limit, so it was not read. ` +
                'Raise BACKUP_SPOOL_MAX_BYTES to restore from it.',
            ),
          );

          return;
        }

        done(null, chunk);
      },
    });

    // Armed BEFORE the pipeline, so a connection that produces no first byte is caught too. That is
    // the shape this actually failed in: the stream opened, the status was written, and not one
    // chunk ever arrived.
    armIdleTimer();

    try {
      // pipeline destroys every stream in the chain on failure, so a refused archive leaves no
      // half-written temp file and no dangling descriptor.
      await pipeline(source, meter, staged.sink);
    } finally {
      // Always, including on success — a pending timer holds the event loop open, and on a healthy
      // download it would keep the process alive for the length of the deadline after the work is
      // finished.
      if (idle) {
        clearTimeout(idle);
      }
    }

    if (written === 0) {
      throw new ArchiveReadError('This archive is empty.');
    }

    return staged.path;
  }

  /**
   * Walks the central directory once, keeping only what a restore may read.
   *
   * Three classes of entry are refused before anything is decompressed: a path that escapes the
   * archive root, a member with an impossible compression ratio, and a per-entry zip password. None
   * of them can be produced by this engine's writer, so any of them means the file is not the
   * archive it claims to be.
   */
  private indexEntries(
    zip: ZipFile,
  ): Promise<{ entries: Map<string, Entry>; rejected: string[] }> {
    return new Promise((resolve, reject) => {
      const entries = new Map<string, Entry>();
      const rejected: string[] = [];

      let count = 0;
      let declaredBytes = 0;

      const fail = (message: string) => reject(new ArchiveReadError(message));

      zip.on('entry', (entry: Entry) => {
        count += 1;

        if (count > MAX_ENTRIES) {
          fail(
            `This archive declares more than ${MAX_ENTRIES} entries, which no backup this ` +
              'product writes ever does.',
          );

          return;
        }

        // Directory markers carry no data and are simply not members.
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();

          return;
        }

        const refusal = this.refuseEntry(entry);

        if (refusal) {
          rejected.push(`${entry.fileName}: ${refusal}`);
          zip.readEntry();

          return;
        }

        declaredBytes += entry.uncompressedSize;

        if (declaredBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
          fail(
            `This archive declares more than ${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes of content, ` +
              'so it was not read.',
          );

          return;
        }

        // Last one wins on a duplicate name, matching how extraction tools behave, and the
        // duplicate is reported rather than hidden.
        if (entries.has(entry.fileName)) {
          rejected.push(`${entry.fileName}: duplicate entry name`);
        }

        entries.set(entry.fileName, entry);
        zip.readEntry();
      });

      zip.on('end', () => resolve({ entries, rejected }));
      zip.on('error', (err: Error) => reject(this.describeZipError(err)));

      zip.readEntry();
    });
  }

  /**
   * Turns a yauzl failure into something an administrator can act on.
   *
   * yauzl refuses a path-escaping entry name by failing the WHOLE archive rather than that one
   * entry, which is the right call for a file this engine could not have written — but its message
   * reads like a parse error. The two are worth telling apart: one means a damaged transfer, the
   * other means the file is not the archive it claims to be.
   */
  private describeZipError(err: Error): ArchiveReadError {
    const escaping =
      /^(invalid characters in fileName|absolute path:|invalid relative path:)/.test(
        err.message,
      );

    if (escaping) {
      return new ArchiveReadError(
        'This archive contains an entry whose path points outside the archive, which no backup ' +
          `this product writes ever does, so it was not read: ${err.message}`,
      );
    }

    return new ArchiveReadError(`This archive is damaged: ${err.message}`);
  }

  /**
   * Why one entry may not be read, or null when it may.
   *
   * Path escapes are checked here as well as by yauzl, which validates every decoded name against
   * the same rules and fails the archive outright. That makes this branch normally unreachable, and
   * it is kept deliberately: it is the check that survives if `decodeStrings` is ever turned off,
   * at which point yauzl stops validating names altogether.
   */
  private refuseEntry(entry: Entry): string | null {
    const name = entry.fileName;

    // Zip-slip. Nothing here is written to disk, but a name that escapes the root is still a
    // name this writer cannot produce, and the table mapping below treats the path as meaningful.
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      /^[A-Za-z]:/.test(name) ||
      name.split('/').includes('..')
    ) {
      return 'the entry path escapes the archive root';
    }

    if (entry.isEncrypted()) {
      // This engine encrypts the whole container, never individual members, so a per-entry
      // password means the file was not written here.
      return 'the entry carries its own zip password';
    }

    if (!ALLOWED_COMPRESSION_METHODS.has(entry.compressionMethod)) {
      return `unsupported compression method ${entry.compressionMethod}`;
    }

    if (
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > MAX_ENTRY_RATIO
    ) {
      return 'the entry claims an implausible compression ratio';
    }

    return null;
  }

  /**
   * Reads `manifest.json`, if there is one.
   *
   * A missing manifest disables checksum verification but does not fail the archive: manifests were
   * added part-way through this module's life, and refusing every older archive would make the
   * restore useless exactly when it is most needed. The caller is told, and decides.
   */
  private async readManifest(
    zip: ZipFile,
    entries: Map<string, Entry>,
  ): Promise<ArchiveManifestSummary | null> {
    const entry = entries.get('manifest.json');

    if (!entry) {
      return null;
    }

    const raw = await this.readEntryText(zip, entry, MAX_JSON_TABLE_BYTES);

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ArchiveReadError(
        `The archive manifest is not valid JSON, so this archive cannot be trusted: ${
          (err as Error).message
        }`,
      );
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new ArchiveReadError('The archive manifest is not an object.');
    }

    const source = parsed as Record<string, unknown>;
    const tables = new Map<string, ManifestTableEntry>();

    for (const row of Array.isArray(source.tables) ? source.tables : []) {
      const record = row as Record<string, unknown>;

      if (typeof record?.table !== 'string') {
        continue;
      }

      // Archives with several layers record a digest per member. Older ones record one per table,
      // which is read below and kept as the fallback — an archive written before this change must
      // still verify.
      const members = new Map<string, string>();

      for (const entry of Array.isArray(record.members) ? record.members : []) {
        const member = entry as Record<string, unknown>;

        if (
          typeof member?.name === 'string' &&
          typeof member?.sha256 === 'string'
        ) {
          members.set(member.name, member.sha256);
        }
      }

      tables.set(record.table, {
        rows: typeof record.rows === 'number' ? record.rows : 0,
        sha256: typeof record.sha256 === 'string' ? record.sha256 : '',
        members,
        status: typeof record.status === 'string' ? record.status : 'unknown',
      });
    }

    return {
      archiveVersion:
        typeof source.archive_version === 'number'
          ? source.archive_version
          : null,
      runId: typeof source.run_id === 'string' ? source.run_id : null,
      organizationId:
        typeof source.organization_id === 'string'
          ? source.organization_id
          : null,
      format: isBackupFileFormat(source.format) ? source.format : null,
      appRestorable: source.app_restorable === true,
      createdAt:
        typeof source.created_at === 'string' ? source.created_at : null,
      rowCount: typeof source.row_count === 'number' ? source.row_count : null,
      tables,
    };
  }

  /** Assembles the handle the restore engine works against. */
  private build(
    zip: ZipFile,
    session: SpoolSession,
    entries: Map<string, Entry>,
    rejected: string[],
    manifest: ArchiveManifestSummary | null,
    spoolPath: string,
  ): OpenedArchive {
    const tables = this.tableEntries(entries);

    // Bound as arrows so the generator below can reach them without aliasing `this` into the
    // returned object, which would keep the whole service alive for as long as the handle is held.
    const hashEntry = (entry: Entry) => this.hashEntry(zip, entry);
    const rowsFrom = (entry: Entry, table: string, batchRows: number) => {
      if (entry.fileName.endsWith('.ndjson')) {
        return this.readNdjsonRows(zip, entry, table, batchRows);
      }

      // Parsed, never executed — see sql.reader.ts. Line-oriented like NDJSON, so a large table
      // costs no more memory than one statement.
      if (entry.fileName.endsWith('.sql')) {
        return this.readSqlRows(zip, entry, table, batchRows);
      }

      return this.readJsonRows(zip, entry, table, batchRows);
    };

    let closed = false;

    const verifyTable = async (table: string): Promise<TableVerification> => {
      const found = tables.find((candidate) => candidate.table === table);

      if (!found) {
        throw new ArchiveReadError(
          `This archive has no restorable member for ${table}.`,
        );
      }

      const entry = entries.get(found.entryName) as Entry;
      const digest = await hashEntry(entry);
      const recorded = manifest?.tables.get(table);

      // By member first: a multi-layer archive has a digest per file, and the table-keyed one is
      // ambiguous once `data/` holds more than one copy of a table. The scalar is the fallback for
      // archives written when there was only ever one.
      const expected =
        recorded?.members.get(found.entryName) || recorded?.sha256 || null;

      if (expected && expected !== digest.sha256) {
        // Refused for this table only. The archive may still be good elsewhere, and naming the
        // table is what makes the failure actionable.
        throw new ArchiveReadError(
          `The ${table} member does not match the checksum recorded when the backup was taken, ` +
            'so it was not restored. The archive may be damaged or altered.',
        );
      }

      return {
        table,
        sha256: digest.sha256,
        byteSize: digest.byteSize,
        matched: expected ? true : null,
        expectedSha256: expected,
      };
    };

    // Derived from the members themselves, never from the manifest — see the note on the field.
    const restorableFormat = tables.length ? tables[0].extension : null;

    return {
      manifest,
      format: manifest?.format ?? null,
      restorableFormat,
      tables,
      rejectedEntries: rejected,
      spoolPath,
      verifyTable,

      async *readTable(table: string, batchRows = DEFAULT_BATCH_ROWS) {
        // Pass one. Nothing below yields a row from bytes that have not already been proven to
        // match what the backup recorded — a restore cannot be undone, so the checksum has to be
        // settled before the first insert, not alongside it.
        await verifyTable(table);

        const found = tables.find(
          (candidate) => candidate.table === table,
        ) as ArchiveTableEntry;
        const entry = entries.get(found.entryName) as Entry;

        yield* rowsFrom(entry, table, batchRows);
      },

      async close() {
        if (closed) {
          return;
        }

        closed = true;
        zip.close();
        await session.dispose();
      },
    };
  }

  /**
   * The restorable members under `data/`, one per table.
   *
   * Only `.ndjson` and `.json` qualify. A `.sql` member is a file for a person with `psql`, not
   * something this backend can execute, and a `.csv` cannot tell an empty string from a null — so
   * neither is offered as a table here even though both are perfectly good archive contents. They
   * are skipped, not rejected: an archive may deliberately carry several layers.
   *
   * At most one entry per table survives. An archive written with both JSON and NDJSON ticked has
   * two readable copies of every table, and returning both would list each table twice and leave
   * which one gets read to zip ordering. NDJSON wins: it streams, it has no size ceiling, and it is
   * what the restore path is built around.
   */
  private tableEntries(entries: Map<string, Entry>): ArchiveTableEntry[] {
    const byTable = new Map<string, ArchiveTableEntry>();

    for (const [name, entry] of entries) {
      if (!name.startsWith('data/')) {
        continue;
      }

      // SQL members carry a zero-padded dependency-level prefix — `data/06-tasks.sql` — so that
      // alphabetical order is insert order for `psql -f`. The prefix is naming, not part of the
      // table, and is dropped here.
      const match = /^data\/(?:(\d{2})-)?([^/]+)\.(ndjson|json|sql)$/.exec(
        name,
      );

      if (!match) {
        continue;
      }

      const [, prefix, table, extension] = match;

      // Only SQL is written with that prefix. A `.ndjson` member carrying one is not a member this
      // product wrote, and guessing at it is how a crafted name becomes a table name.
      if (prefix && extension !== 'sql') {
        continue;
      }

      // isBackupFileFormat narrows the regex capture from string; RESTORABLE_FORMATS is the gate
      // that decides whether anything can actually read it.
      if (
        !SAFE_TABLE_NAME.test(table) ||
        !isBackupFileFormat(extension) ||
        !RESTORABLE_FORMATS.includes(extension)
      ) {
        continue;
      }

      // Ranked, not first-wins: an archive written with several layers has more than one readable
      // copy of every table, and which one gets read must not depend on zip ordering.
      const rank = READ_PREFERENCE.indexOf(extension);
      const held = byTable.get(table);

      if (held && READ_PREFERENCE.indexOf(held.extension) <= rank) {
        continue;
      }

      byTable.set(table, {
        table,
        entryName: name,
        extension,
        uncompressedSize: entry.uncompressedSize,
      });
    }

    return [...byTable.values()];
  }

  /** sha256 of one member's decompressed bytes — the same bytes the writer hashed. */
  private async hashEntry(
    zip: ZipFile,
    entry: Entry,
  ): Promise<{ sha256: string; byteSize: number }> {
    const stream = await zip.openReadStreamPromise(entry);
    const hash = createHash('sha256');

    let byteSize = 0;

    for await (const chunk of stream) {
      const buffer = chunk as Buffer;

      byteSize += buffer.length;
      hash.update(buffer);
    }

    return { sha256: hash.digest('hex'), byteSize };
  }

  /** Reads a whole member as text, refusing one that is too large to hold. */
  private async readEntryText(
    zip: ZipFile,
    entry: Entry,
    maxBytes: number,
  ): Promise<string> {
    if (entry.uncompressedSize > maxBytes) {
      throw new ArchiveReadError(
        `${entry.fileName} is ${entry.uncompressedSize} bytes, above the ${maxBytes}-byte limit ` +
          'for a member that must be read whole.',
      );
    }

    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * NDJSON, a line at a time.
   *
   * Memory stays at one batch however large the table is, which is the whole reason NDJSON is the
   * format to pick when an archive is meant to be restored rather than read.
   */
  /**
   * A `.sql` member, parsed back into rows.
   *
   * Nothing here executes SQL — there is no Postgres driver in this backend. `SqlRowReader` parses
   * the grammar `sql.writer.ts` emits and nothing wider, so a file that is not one of ours is
   * refused rather than half-understood. Line-oriented like the NDJSON reader, so the memory cost
   * is one statement rather than one table.
   */
  private async *readSqlRows(
    zip: ZipFile,
    entry: Entry,
    table: string,
    batchRows: number,
  ): AsyncGenerator<Record<string, unknown>[]> {
    const stream = await zip.openReadStreamPromise(entry);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const reader = new SqlRowReader(table);

    let batch: Record<string, unknown>[] = [];

    try {
      for await (const line of lines) {
        try {
          reader.push(line);
        } catch (err) {
          // Reported as an archive problem, because that is what it is: the member does not hold
          // what it claims to. Same shape as a checksum mismatch, so callers need no new case.
          throw new ArchiveReadError((err as Error).message);
        }

        batch.push(...reader.drain());

        while (batch.length >= batchRows) {
          yield batch.slice(0, batchRows);
          batch = batch.slice(batchRows);
        }
      }

      try {
        reader.end();
      } catch (err) {
        throw new ArchiveReadError((err as Error).message);
      }

      if (batch.length) {
        yield batch;
      }
    } finally {
      // A caller that stops early must not leave the zip's inflate stream open, or the next read of
      // this archive deadlocks behind it.
      lines.close();
      stream.destroy();
    }
  }

  private async *readNdjsonRows(
    zip: ZipFile,
    entry: Entry,
    table: string,
    batchRows: number,
  ): AsyncGenerator<Record<string, unknown>[]> {
    const stream = await zip.openReadStreamPromise(entry);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });

    let batch: Record<string, unknown>[] = [];
    let lineNumber = 0;

    try {
      for await (const line of lines) {
        lineNumber += 1;

        if (!line.trim()) {
          continue;
        }

        batch.push(this.parseRow(line, table, lineNumber));

        if (batch.length >= batchRows) {
          yield batch;
          batch = [];
        }
      }

      if (batch.length) {
        yield batch;
      }
    } finally {
      // A caller that stops early — a failed insert, a cancelled run — must not leave the zip's
      // inflate stream open, or the next read of this archive deadlocks behind it.
      lines.close();
      stream.destroy();
    }
  }

  /**
   * JSON, which cannot be parsed incrementally.
   *
   * The array has to be complete before any of it is valid, so the member is held in memory and
   * capped. NDJSON has no such ceiling; this is the cost of the friendlier format.
   */
  private async *readJsonRows(
    zip: ZipFile,
    entry: Entry,
    table: string,
    batchRows: number,
  ): AsyncGenerator<Record<string, unknown>[]> {
    const text = await this.readEntryText(zip, entry, MAX_JSON_TABLE_BYTES);

    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new ArchiveReadError(
        `The ${table} member is not valid JSON: ${(err as Error).message}`,
      );
    }

    if (!Array.isArray(parsed)) {
      throw new ArchiveReadError(
        `The ${table} member is not a JSON array of rows.`,
      );
    }

    for (let index = 0; index < parsed.length; index += batchRows) {
      yield parsed
        .slice(index, index + batchRows)
        .map((row, offset) => this.asRow(row, table, index + offset + 1));
    }
  }

  /** One NDJSON line as a row, with the line number in the error. */
  private parseRow(
    line: string,
    table: string,
    lineNumber: number,
  ): Record<string, unknown> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new ArchiveReadError(
        `${table} line ${lineNumber} is not valid JSON: ${(err as Error).message}`,
      );
    }

    return this.asRow(parsed, table, lineNumber);
  }

  /**
   * Narrows a parsed value to a row.
   *
   * An array or a bare string here would otherwise reach the insert path and be sent to PostgREST
   * as a row, where it fails with something that names neither the table nor the line.
   */
  private asRow(
    value: unknown,
    table: string,
    position: number,
  ): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ArchiveReadError(
        `${table} entry ${position} is not an object, so it is not a row.`,
      );
    }

    return value as Record<string, unknown>;
  }
}
