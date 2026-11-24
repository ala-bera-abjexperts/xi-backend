/**
 * @fileoverview The contract every export format implements, and the registry of formats.
 * @module src/backup/engine/writers/table-writer
 *
 * An archive contains ONE format — the one that was selected — under `data/`. A writer produces it.
 *
 * `restorable` is therefore load-bearing rather than informational: CSV, TSV, XLSX and XML cannot
 * round-trip a PostgreSQL row (an empty cell is both NULL and the empty string, dates become
 * spreadsheet serials, long identifiers lose digits to floating point), and SQL cannot be executed
 * by this backend at all. Choosing one of those produces a portable export that this application
 * cannot restore from, which the manifest and the UI both have to state plainly.
 *
 * Writers are pull-free: the engine hands rows in and the writer appends to a sink. XLSX is the
 * reason `finish()` exists separately from `writeRow()` — SheetJS can only produce a workbook once
 * it has every row, so it buffers and emits in `finish()` while the text formats stream.
 */

import type { Writable } from 'node:stream';

export const BACKUP_FILE_FORMATS = [
  'sql',
  'ndjson',
  'json',
  'csv',
  'tsv',
  'xlsx',
  'xml',
] as const;

export type BackupFileFormat = (typeof BACKUP_FILE_FORMATS)[number];

/** The default. SQL is portable to any PostgreSQL and readable by any DBA. */
export const DEFAULT_FILE_FORMAT: BackupFileFormat = 'sql';

/**
 * Formats a restore could in principle read back.
 *
 * `sql` is deliberately absent. This application has no way to execute SQL — there is no Postgres
 * driver and every query goes through PostgREST — so a `.sql` file is restorable by a human with
 * `psql`, not by this product. Marking it restorable here would be a lie the engine acts on.
 */
/**
 * SQL joined this list once `sql.reader.ts` existed.
 *
 * Not because anything executes SQL — there is still no Postgres driver — but because the dump is
 * this product's own output, with a grammar small enough to parse back into rows exactly. Every
 * type survives it: NULL, booleans, numbers, jsonb and text are all distinguishable.
 *
 * csv/tsv/xlsx are still absent, and not for want of a parser. They cannot tell an empty string
 * from a NULL, and the spreadsheet formula guard rewrites any value starting with = + - @ — so
 * every negative number in the tenant is already altered in the file. There is nothing to read
 * back correctly.
 */
export const RESTORABLE_FORMATS: readonly BackupFileFormat[] = [
  'ndjson',
  'json',
  'sql',
];

export function isBackupFileFormat(value: unknown): value is BackupFileFormat {
  return (BACKUP_FILE_FORMATS as readonly unknown[]).includes(value);
}

export interface TableWriter {
  /** Appends one row. Awaits the sink when it is full, so a large table never buffers in memory. */
  writeRow(row: Record<string, unknown>): Promise<void>;

  /** Flushes anything held back and ends the sink. Always called, even for an empty table. */
  finish(): Promise<void>;
}

export interface WriterContext {
  table: string;

  /**
   * Dependency-insertion depth from the component registry, used to order SQL filenames. The FK
   * graph has real cycles, so this is a strong hint rather than a guarantee.
   */
  insertLevel: number;
}

export interface FormatDefinition {
  /** File extension without the dot. */
  extension: string;

  /** False when the format loses information a restore would need. */
  restorable: boolean;

  /**
   * True when the writer emits bytes as rows arrive, so it can write straight into the archive.
   *
   * False only for XLSX: SheetJS builds the whole workbook in memory and emits one Buffer at
   * `finish()`, so it must be staged on disk first. Everything else pays two pointless I/O passes
   * if it is spooled.
   */
  streams: boolean;

  create(sink: Writable, ctx: WriterContext): TableWriter;
}

/**
 * Writes to a stream and waits when it is full.
 *
 * Every text writer funnels through this. Skipping the drain wait is how an export of a large table
 * turns into an out-of-memory crash rather than a slow write.
 */
export async function writeChunk(sink: Writable, text: string): Promise<void> {
  if (!sink.write(text)) {
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        sink.off('error', onError);
        resolve();
      };

      const onError = (err: Error) => {
        sink.off('drain', onDrain);
        reject(err);
      };

      sink.once('drain', onDrain);
      sink.once('error', onError);
    });
  }
}

/** Ends a sink and resolves once the bytes are actually flushed. */
export function endSink(sink: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.once('error', reject);
    sink.end(() => resolve());
  });
}

/**
 * PostgreSQL text cannot hold a NUL byte, and a spreadsheet cell cannot hold a lone surrogate.
 * Both would produce a file that looks fine and fails on import, so they are refused at the source.
 */
export function assertWritableValue(
  table: string,
  column: string,
  value: string,
): void {
  if (value.includes('\u0000')) {
    throw new Error(
      `${table}.${column} contains a NUL byte, which no PostgreSQL text column can hold. ` +
        'The export was stopped rather than writing a file that cannot be imported.',
    );
  }
}

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Rejects an identifier that could not have come from this database's catalog.
 *
 * Table and column names reach the writers from PostgREST responses, so they are not attacker
 * controlled today — but a generated `.sql` file is executed by a human against a live database,
 * which makes "probably safe" the wrong standard.
 */
export function assertSafeIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(
      `"${name}" is not a valid unquoted PostgreSQL identifier, so it cannot be written to a dump.`,
    );
  }

  return name;
}

/**
 * Column order for a table, taken from the first row.
 *
 * Every row of one PostgREST response carries the same keys, so the first row defines the shape.
 * Later rows are read through this list, which means a row that somehow gained a key cannot
 * silently shift every column in a CSV.
 */
export function columnsOf(row: Record<string, unknown>): string[] {
  return Object.keys(row);
}

/** How a nested value appears in a flat format: as JSON text, never as "[object Object]". */
export function flatten(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  // Narrowed explicitly rather than String(value): a symbol throws on coercion, and anything else
  // exotic would stringify to "[object Object]" and land in the file as data.
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }

  return JSON.stringify(value) ?? '';
}
