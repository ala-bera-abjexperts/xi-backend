/**
 * @fileoverview NDJSON and JSON — the two lossless formats.
 * @module src/backup/engine/writers/json.writer
 *
 * Both share one serialisation and differ only in framing: NDJSON writes one object per line, JSON
 * wraps the same objects in an array. Neither ever holds more than one row in memory, so a
 * multi-gigabyte table costs the same as a small one.
 *
 * These are the only formats a restore can read, because they are the only ones that keep the
 * distinction between null and empty, preserve nesting, and do not reinterpret dates.
 */

import type { Writable } from 'node:stream';
import {
  endSink,
  writeChunk,
  type FormatDefinition,
  type TableWriter,
} from './table-writer';

class NdjsonTableWriter implements TableWriter {
  constructor(private readonly sink: Writable) {}

  async writeRow(row: Record<string, unknown>): Promise<void> {
    await writeChunk(this.sink, `${JSON.stringify(row)}\n`);
  }

  async finish(): Promise<void> {
    await endSink(this.sink);
  }
}

class JsonTableWriter implements TableWriter {
  private wroteAny = false;

  constructor(private readonly sink: Writable) {}

  async writeRow(row: Record<string, unknown>): Promise<void> {
    // The separator goes BEFORE each row after the first, so the array closes correctly without
    // knowing the row count in advance — which is what keeps this streaming.
    await writeChunk(
      this.sink,
      `${this.wroteAny ? ',\n' : '[\n'}${JSON.stringify(row)}`,
    );

    this.wroteAny = true;
  }

  async finish(): Promise<void> {
    // An empty table still yields valid JSON: `[]`, not an empty file that JSON.parse rejects.
    await writeChunk(this.sink, this.wroteAny ? '\n]\n' : '[]\n');
    await endSink(this.sink);
  }
}

export const ndjsonFormat: FormatDefinition = {
  extension: 'ndjson',
  restorable: true,
  streams: true,
  create: (sink) => new NdjsonTableWriter(sink),
};

export const jsonFormat: FormatDefinition = {
  extension: 'json',
  restorable: true,
  streams: true,
  create: (sink) => new JsonTableWriter(sink),
};
