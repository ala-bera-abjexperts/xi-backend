/**
 * @fileoverview Writes a table as PostgreSQL INSERT statements.
 * @module src/backup/engine/writers/sql.writer
 *
 * The default format, and the only one whose output a human runs against a live database. That is
 * why the escaping here is stricter than the rest: a bug in the CSV writer produces a wrong
 * spreadsheet, a bug here produces a dump that fails to apply — or worse, applies incorrectly.
 *
 * Two decisions worth keeping:
 *
 *   - **Standard quoting, never `E'…'`.** `standard_conforming_strings` has defaulted to `on` since
 *     PostgreSQL 9.1, so doubling `'` is the whole of string escaping and a backslash is literal.
 *     `E'…'` would additionally require escaping every backslash, and getting that wrong is how
 *     dumps silently corrupt Windows paths and regexes.
 *   - **Types come from JSON, not a catalog lookup.** PostgREST already distinguishes string,
 *     number, boolean, null and object, and that is enough to emit a correct literal. The one place
 *     it is lossy is `numeric`, which arrives as a JSON number — see the note on writeValue.
 */

import type { Writable } from 'node:stream';
import {
  assertSafeIdentifier,
  assertWritableValue,
  columnsOf,
  endSink,
  writeChunk,
  type FormatDefinition,
  type TableWriter,
  type WriterContext,
} from './table-writer';

/** Rows per INSERT. Matches the export page size, so one page is one statement. */
const ROWS_PER_STATEMENT = 500;

/** Doubles single quotes. The complete rule under standard_conforming_strings. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * One SQL literal for one JSON value.
 *
 * `numeric` columns are the known soft spot: PostgREST returns them as JSON numbers, so a value
 * that does not fit a double has already lost precision before it reaches here. Emitting it
 * verbatim is the honest choice — rounding or quoting it would hide the loss rather than fix it.
 * The real fix is a column-introspection RPC that casts numerics to text at the source.
 */
export function sqlValue(
  value: unknown,
  table: string,
  column: string,
): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      // NaN and Infinity are valid JSON-ish but not valid in an INSERT for a numeric column.
      throw new Error(
        `${table}.${column} holds ${String(value)}, which cannot be written as a SQL literal.`,
      );
    }

    return String(value);
  }

  if (typeof value === 'object') {
    const json = JSON.stringify(value);

    assertWritableValue(table, column, json);

    // Cast explicitly: without it PostgreSQL infers text and the INSERT fails against a jsonb
    // column with "column is of type jsonb but expression is of type text".
    return `${quoteLiteral(json)}::jsonb`;
  }

  // bigint stringifies losslessly, unlike the JSON number path above.
  if (typeof value === 'bigint') {
    return quoteLiteral(value.toString());
  }

  // Everything a JSON document can hold has now been handled. Anything else — a symbol, a function
  // — is refused rather than coerced, because String() on those yields either a throw or
  // "[object Object]" written into the dump as if it were data.
  if (typeof value !== 'string') {
    throw new Error(
      `${table}.${column} holds a ${typeof value}, which cannot be written as a SQL literal.`,
    );
  }

  assertWritableValue(table, column, value);

  return quoteLiteral(value);
}

class SqlTableWriter implements TableWriter {
  private columns: string[] | null = null;
  private buffered: string[] = [];
  private wroteHeader = false;

  constructor(
    private readonly sink: Writable,
    private readonly ctx: WriterContext,
  ) {}

  async writeRow(row: Record<string, unknown>): Promise<void> {
    if (!this.columns) {
      this.columns = columnsOf(row).map(assertSafeIdentifier);
      await this.writeHeader();
    }

    const values = this.columns.map((column) =>
      sqlValue(row[column], this.ctx.table, column),
    );

    this.buffered.push(`  (${values.join(', ')})`);

    if (this.buffered.length >= ROWS_PER_STATEMENT) {
      await this.flush();
    }
  }

  async finish(): Promise<void> {
    if (!this.wroteHeader) {
      // An empty table still gets a file, so a reader can tell "no rows" from "not backed up".
      await this.writeHeader();
      await writeChunk(this.sink, '-- No rows.\n');
    }

    await this.flush();
    await endSink(this.sink);
  }

  private async writeHeader(): Promise<void> {
    this.wroteHeader = true;

    const table = assertSafeIdentifier(this.ctx.table);

    await writeChunk(
      this.sink,
      `-- ${table}\n` +
        `-- Dependency level ${this.ctx.insertLevel}. Files are named so that alphabetical order\n` +
        `-- is insert order, but the foreign-key graph contains genuine cycles, so treat that as a\n` +
        `-- strong hint rather than a guarantee.\n` +
        `-- Generated by the XISUITE backup engine. Restore with: psql -f <file>\n\n`,
    );
  }

  private async flush(): Promise<void> {
    if (!this.buffered.length || !this.columns) {
      return;
    }

    const table = assertSafeIdentifier(this.ctx.table);
    const columns = this.columns.map((c) => `"${c}"`).join(', ');

    await writeChunk(
      this.sink,
      `INSERT INTO public."${table}" (${columns}) VALUES\n` +
        `${this.buffered.join(',\n')};\n`,
    );

    this.buffered = [];
  }
}

export const sqlFormat: FormatDefinition = {
  extension: 'sql',
  // Readable back by `sql.reader.ts`, which parses this writer's own grammar rather than executing
  // anything. Every literal below is unambiguous on the way in again.
  restorable: true,
  streams: true,
  create: (sink, ctx) => new SqlTableWriter(sink, ctx),
};
