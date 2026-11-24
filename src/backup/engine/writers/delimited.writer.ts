/**
 * @fileoverview CSV and TSV — one algorithm, two delimiters.
 * @module src/backup/engine/writers/delimited.writer
 *
 * Both are export-only. A delimited file cannot distinguish NULL from the empty string, so a
 * restore reading one would turn every empty cell into `''` and every `''` into NULL — silently,
 * across the whole database. That is why `restorable` is false and the archive always keeps its
 * NDJSON layer.
 *
 * The formula-injection guard below is a security control, not formatting. A cell beginning `=`,
 * `+`, `-`, `@`, tab or carriage return is executed by Excel, Google Sheets and LibreOffice when
 * the file is opened. Since these archives contain user-supplied text — task titles, comments,
 * wiki content — an attacker with permission to create a task can otherwise land a formula in an
 * administrator's spreadsheet and have it run on open.
 */

import type { Writable } from 'node:stream';
import {
  assertWritableValue,
  columnsOf,
  endSink,
  flatten,
  writeChunk,
  type FormatDefinition,
  type TableWriter,
  type WriterContext,
} from './table-writer';

/** Leading characters a spreadsheet treats as the start of a formula. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Neutralises a value that a spreadsheet would execute.
 *
 * Prefixing with an apostrophe is the standard defence: the cell displays its literal text and the
 * formula never evaluates. The apostrophe is visible in the cell, which is the accepted trade —
 * a visible quote beats arbitrary code execution on open.
 */
export function neutraliseFormula(value: string): string {
  if (value.length && FORMULA_PREFIXES.includes(value[0])) {
    return `'${value}`;
  }

  return value;
}

/** RFC 4180 quoting: double the quotes, wrap when the value contains anything structural. */
export function csvCell(value: string, delimiter: string): string {
  const needsQuotes =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r');

  if (!needsQuotes) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * TSV has no quoting standard, so a tab or newline inside a value cannot be represented — it would
 * shift every following column. Escaped rather than quoted, which is what `\copy … FORMAT text`
 * expects and what spreadsheet importers accept.
 */
export function tsvCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

class DelimitedTableWriter implements TableWriter {
  private columns: string[] | null = null;

  constructor(
    private readonly sink: Writable,
    private readonly ctx: WriterContext,
    private readonly delimiter: string,
    private readonly encode: (value: string) => string,
  ) {}

  async writeRow(row: Record<string, unknown>): Promise<void> {
    if (!this.columns) {
      this.columns = columnsOf(row);
      await writeChunk(
        this.sink,
        `${this.columns.map((c) => this.encode(c)).join(this.delimiter)}\n`,
      );
    }

    const cells = this.columns.map((column) => {
      const text = flatten(row[column]);

      assertWritableValue(this.ctx.table, column, text);

      // Neutralise BEFORE encoding, so the apostrophe is inside the quoted cell rather than
      // outside it where a parser would treat it as stray text.
      return this.encode(neutraliseFormula(text));
    });

    await writeChunk(this.sink, `${cells.join(this.delimiter)}\n`);
  }

  async finish(): Promise<void> {
    if (!this.columns) {
      // With no rows the column names are unknowable — PostgREST returns shapes, not schemas. A
      // zero-byte file is indistinguishable from a failed export, so say which table it was and
      // that it was genuinely empty. Written as a comment line so a parser skips or ignores it
      // rather than reading it as data.
      await writeChunk(this.sink, `# ${this.ctx.table}: no rows\n`);
    }

    await endSink(this.sink);
  }
}

export const csvFormat: FormatDefinition = {
  extension: 'csv',
  restorable: false,
  streams: true,
  create: (sink, ctx) =>
    new DelimitedTableWriter(sink, ctx, ',', (value) => csvCell(value, ',')),
};

export const tsvFormat: FormatDefinition = {
  extension: 'tsv',
  restorable: false,
  streams: true,
  create: (sink, ctx) => new DelimitedTableWriter(sink, ctx, '\t', tsvCell),
};
