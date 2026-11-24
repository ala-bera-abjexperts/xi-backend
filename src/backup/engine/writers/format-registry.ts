/**
 * @fileoverview Maps a format name to its writer.
 * @module src/backup/engine/writers/format-registry
 *
 * Separate from table-writer.ts because the writers import that module — putting the map there
 * would make every writer import itself through a cycle. Adding an eighth format means one new
 * writer file and one line here.
 */

import {
  BACKUP_FILE_FORMATS,
  type BackupFileFormat,
  type FormatDefinition,
} from './table-writer';
import { csvFormat, tsvFormat } from './delimited.writer';
import { jsonFormat, ndjsonFormat } from './json.writer';
import { sqlFormat } from './sql.writer';
import { xlsxFormat } from './xlsx.writer';
import { xmlFormat } from './xml.writer';

/** Every format, keyed by the value stored in `options_snapshot.file_format`. */
export const FORMAT_REGISTRY: Record<BackupFileFormat, FormatDefinition> = {
  sql: sqlFormat,
  ndjson: ndjsonFormat,
  json: jsonFormat,
  csv: csvFormat,
  tsv: tsvFormat,
  xlsx: xlsxFormat,
  xml: xmlFormat,
};

/**
 * Every format name has a writer. A `Record` keyed by the union already makes a missing entry a
 * compile error; this catches the reverse — an entry whose key is no longer a legal format.
 */
export function assertRegistryComplete(): void {
  for (const format of BACKUP_FILE_FORMATS) {
    if (!FORMAT_REGISTRY[format]) {
      throw new Error(`No writer is registered for the "${format}" format.`);
    }
  }
}
