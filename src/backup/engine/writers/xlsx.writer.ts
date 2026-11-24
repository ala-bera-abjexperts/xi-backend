/**
 * @fileoverview Writes a table as a real Excel workbook.
 * @module src/backup/engine/writers/xlsx.writer
 *
 * The format a non-technical admin actually wants: double-click, and the data is there. It is also
 * the most dangerous of the seven, for two reasons that both end in silent data loss:
 *
 *   - **Excel cannot hold more than 1 048 576 rows in a sheet.** Writing the first million and
 *     stopping would produce a file that opens perfectly and is missing most of the table. This
 *     writer ABORTS instead, exactly as the exporter aborts on a short page — a backup that fails
 *     loudly is recoverable, one that lies is not.
 *   - **SheetJS cannot stream.** `XLSX.write` builds the workbook from a complete array, so the
 *     whole table is held in memory until `finish()`. The row cap doubles as the memory bound.
 *
 * Values are written as text. That is deliberate: letting Excel infer types turns long ids into
 * 1.23457E+20, dates into serial numbers, and "0123" into 123. Text keeps what the database had.
 */

import type { Writable } from 'node:stream';
// Imported statically. A dynamic `await import('xlsx')` throws "a dynamic import callback was
// invoked without --experimental-vm-modules" under this repo's CommonJS Jest setup, so the lazy
// form is untestable — and an untested spreadsheet writer is the last thing this should have.
import * as XLSX from 'xlsx';
import {
  columnsOf,
  endSink,
  flatten,
  type FormatDefinition,
  type TableWriter,
  type WriterContext,
} from './table-writer';
import { neutraliseFormula } from './delimited.writer';

/** The hard limit of the .xlsx format itself, not a tuning knob. */
export const XLSX_MAX_ROWS = 1_048_576;

/** One row is the header, so the data budget is one less than the sheet limit. */
const MAX_DATA_ROWS = XLSX_MAX_ROWS - 1;

class XlsxTableWriter implements TableWriter {
  private columns: string[] | null = null;
  private readonly rows: string[][] = [];

  constructor(
    private readonly sink: Writable,
    private readonly ctx: WriterContext,
  ) {}

  async writeRow(row: Record<string, unknown>): Promise<void> {
    if (!this.columns) {
      this.columns = columnsOf(row);
      this.rows.push(this.columns);
    }

    if (this.rows.length > MAX_DATA_ROWS) {
      throw new Error(
        `${this.ctx.table} has more than ${MAX_DATA_ROWS.toLocaleString('en-US')} rows, which is ` +
          'more than one Excel sheet can hold. The run was stopped rather than writing a ' +
          'spreadsheet that silently omits the rest. Choose CSV or SQL for this scheme.',
      );
    }

    this.rows.push(
      this.columns.map((column) => neutraliseFormula(flatten(row[column]))),
    );

    return Promise.resolve();
  }

  async finish(): Promise<void> {
    const sheet = XLSX.utils.aoa_to_sheet(
      this.rows.length ? this.rows : [['(no rows)']],
    );
    const book = XLSX.utils.book_new();

    // Excel rejects a sheet name over 31 characters or containing []:*?/\ — and several table
    // names here are longer than that, so the name is derived rather than used raw.
    XLSX.utils.book_append_sheet(book, sheet, sheetNameFor(this.ctx.table));

    const buffer = XLSX.write(book, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;

    await new Promise<void>((resolve, reject) => {
      this.sink.write(buffer, (err) => (err ? reject(err) : resolve()));
    });

    await endSink(this.sink);
  }
}

/** A legal Excel sheet name: at most 31 chars, none of []:*?/\ */
export function sheetNameFor(table: string): string {
  const cleaned = table.replace(/[[\]:*?/\\]/g, '_');

  if (cleaned.length <= 31) {
    return cleaned;
  }

  // Keep the tail: table names share long prefixes (`form_builder_…`, `partner_…`), so truncating
  // the front would collide where truncating the end does not.
  return cleaned.slice(cleaned.length - 31);
}

export const xlsxFormat: FormatDefinition = {
  extension: 'xlsx',
  restorable: false,
  streams: false,
  create: (sink, ctx) => new XlsxTableWriter(sink, ctx),
};
