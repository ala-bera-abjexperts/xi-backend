/**
 * @fileoverview Writes a table as XML.
 * @module src/backup/engine/writers/xml.writer
 *
 * Streams one `<row>` per record, so a large table costs nothing extra in memory.
 *
 * Export-only. XML could in principle be lossless, but only with a type annotation on every
 * element; without one, "123" and 123 are indistinguishable on the way back in, which is the same
 * ambiguity that makes CSV unrestorable. NULL is represented as an absent element rather than an
 * empty one, so it is at least distinguishable from the empty string by a careful reader.
 */

import type { Writable } from 'node:stream';
import {
  assertSafeIdentifier,
  assertWritableValue,
  columnsOf,
  endSink,
  flatten,
  writeChunk,
  type FormatDefinition,
  type TableWriter,
  type WriterContext,
} from './table-writer';

/**
 * Escapes the five XML entities.
 *
 * `&` must be replaced first, or the ampersands introduced by the later replacements are escaped a
 * second time and `<` becomes `&amp;lt;`.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Strips characters XML 1.0 cannot represent at all.
 *
 * Control characters below 0x20 other than tab, newline and carriage return are illegal in an XML
 * document — not merely in need of escaping. A document containing one fails every parser, so they
 * are removed rather than encoded.
 */
export function stripIllegalXml(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

class XmlTableWriter implements TableWriter {
  private columns: string[] | null = null;
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

    const cells = this.columns
      .map((column) => {
        const value = row[column];

        // An absent element means NULL; an empty one means the empty string. The only distinction
        // this format can carry, and it costs nothing to keep.
        if (value === null || value === undefined) {
          return '';
        }

        const text = flatten(value);

        assertWritableValue(this.ctx.table, column, text);

        return `    <${column}>${escapeXml(stripIllegalXml(text))}</${column}>\n`;
      })
      .join('');

    await writeChunk(this.sink, `  <row>\n${cells}  </row>\n`);
  }

  async finish(): Promise<void> {
    if (!this.wroteHeader) {
      await this.writeHeader();
    }

    await writeChunk(this.sink, '</table>\n');
    await endSink(this.sink);
  }

  private async writeHeader(): Promise<void> {
    this.wroteHeader = true;

    await writeChunk(
      this.sink,
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<table name="${escapeXml(assertSafeIdentifier(this.ctx.table))}">\n`,
    );
  }
}

export const xmlFormat: FormatDefinition = {
  extension: 'xml',
  restorable: false,
  streams: true,
  create: (sink, ctx) => new XmlTableWriter(sink, ctx),
};
