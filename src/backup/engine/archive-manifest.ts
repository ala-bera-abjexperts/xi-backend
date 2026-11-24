/**
 * @fileoverview The README and index written at the root of every archive.
 * @module src/backup/engine/archive-manifest
 *
 * An archive contains one layer, in the selected format, and nothing inside it said which — or
 * whether this application could read it back. Both matter during an incident, so the archive
 * explains itself, in two forms:
 *
 *   README.txt    prose, for the person who just double-clicked the zip
 *   manifest.json the same facts as data, for a restore and for scripted verification
 *
 * The manifest reports what the run ACTUALLY produced, never what it intended. A manifest claiming
 * a table succeeded when its item failed would turn a visibly partial archive into an invisibly
 * partial one, which is the single worst outcome available to a backup product.
 */

import {
  RESTORABLE_FORMATS,
  type BackupFileFormat,
} from './writers/table-writer';

/** One file in the archive, and the digest of exactly that file's bytes. */
export interface ManifestMember {
  /** Full entry name, e.g. `data/03-tasks.sql`. */
  name: string;
  format: BackupFileFormat;
  sha256: string;
}

export interface ManifestTable {
  table: string;
  rows: number;
  /**
   * One entry per format the run wrote for this table.
   *
   * Deliberately nested rather than flattened into one entry per member: `table_count` and
   * `row_count` below are computed from this array, and a flat list would multiply both by the
   * number of layers — an archive of 176 tables reporting 1,232.
   */
  members: ManifestMember[];
  status: string;
}

export interface ManifestInput {
  runId: string;
  organizationId: string;
  schemeVersion: number | null;
  /** Every format this archive carries, in the order the members appear. */
  formats: BackupFileFormat[];
  encrypted: boolean;
  createdAt: Date;
  tables: ManifestTable[];
  filesCopied: number;
  missingObjects: string[];
}

/** Whether this application's own restore can read an archive in this format. */
function appRestorable(format: BackupFileFormat): boolean {
  return (RESTORABLE_FORMATS as readonly string[]).includes(format);
}

/**
 * The single format an older reader will see in `format`.
 *
 * A reader that predates multi-layer archives takes that scalar and decides from it alone whether
 * it can restore. Naming the restorable layer when there is one means such a reader accepts a
 * mixed archive instead of refusing a file it could have read.
 */
function primaryFormat(formats: BackupFileFormat[]): BackupFileFormat {
  return formats.find(appRestorable) ?? formats[0];
}

/** The archive index, as data. */
export function buildManifest(input: ManifestInput): string {
  const rowTotal = input.tables.reduce((sum, t) => sum + t.rows, 0);

  return `${JSON.stringify(
    {
      archive_version: 1,
      run_id: input.runId,
      organization_id: input.organizationId,
      scheme_version: input.schemeVersion,
      created_at: input.createdAt.toISOString(),
      encrypted: input.encrypted,
      // One directory, named explicitly rather than inferred from a file extension.
      layer: 'data/',
      // Scalar first, for readers written before an archive could hold several layers. It names
      // the restorable layer when there is one, so such a reader is not told "sql" about an
      // archive that also contains NDJSON.
      format: primaryFormat(input.formats),
      formats: input.formats,
      // Whether THIS application can restore from this archive — true when ANY layer is readable.
      // False for an archive of sql/csv/tsv/xlsx/xml alone: the backend has no way to execute SQL
      // and the flat formats cannot tell an empty value from a missing one. A reader must not
      // infer restorability from an extension.
      app_restorable: input.formats.some(appRestorable),
      table_count: input.tables.length,
      row_count: rowTotal,
      files_copied: input.filesCopied,
      // Referenced by a row but absent from storage. Capped: a tenant with a systemic problem
      // should not turn its manifest into a multi-megabyte list.
      missing_objects: input.missingObjects.slice(0, 100),
      missing_object_count: input.missingObjects.length,
      tables: input.tables,
    },
    null,
    2,
  )}\n`;
}

/** The same facts, for a person. */
export function buildReadme(input: ManifestInput): string {
  const rowTotal = input.tables.reduce((sum, t) => sum + t.rows, 0);

  const lines = [
    'XISUITE BACKUP ARCHIVE',
    '======================',
    '',
    `Created:      ${input.createdAt.toISOString()}`,
    `Run:          ${input.runId}`,
    `Contents:     ${input.tables.length} tables, ${rowTotal} rows` +
      (input.filesCopied ? `, ${input.filesCopied} files` : ''),
    '',
    'WHAT IS IN HERE',
    '---------------',
    '',
    input.formats.length === 1
      ? `data/        One .${input.formats[0]} file per table. This is the format that was chosen when`
      : `data/        ${input.formats.length} files per table, one per format chosen when the backup was`,
    input.formats.length === 1
      ? '             the backup was started, and it is the only copy in this archive.'
      : `             started: ${input.formats.map((f) => `.${f}`).join(', ')}. Each holds the same rows.`,
  ];

  if (input.formats.includes('sql')) {
    lines.push(
      '',
      '             The .sql files are numbered by dependency order, so applying them in filename',
      '             order satisfies foreign keys:',
      '',
      '                 for f in data/*.sql; do psql -f "$f"; done',
    );
  }

  const readable = input.formats.filter(appRestorable);

  lines.push('', 'HOW TO RESTORE THIS', '-------------------', '');

  // Said plainly and early. Someone recovering from an incident must not discover halfway through
  // that the archive they chose cannot be loaded by the product that wrote it.
  if (readable.length) {
    lines.push(
      `.${readable.join(' and .')} keeps the difference between an empty value and a missing one, so`,
      'the XISUITE restore feature can read this archive directly. It uses that layer and ignores',
      'the others.',
    );
  } else {
    lines.push(
      `This archive holds .${input.formats.join(', .')} only, which are export formats. The XISUITE`,
      'restore feature cannot read this archive — it loads NDJSON or JSON. Restoring from it means',
      'loading it yourself, with',
      input.formats.includes('sql')
        ? 'psql, using the command above.'
        : 'whatever tool reads these formats.',
      '',
      'To get an archive the product can restore by itself, choose NDJSON or JSON as well when',
      'starting the backup. The other formats can stay — an archive may hold several layers.',
    );
  }

  if (input.filesCopied) {
    lines.push(
      '',
      'files/       Uploaded files, under files/<bucket>/<path>. The rows describing them are in',
      '             data/, so the two only make sense together.',
    );
  }

  if (input.missingObjects.length) {
    lines.push(
      '',
      'INCOMPLETE',
      '----------',
      '',
      `${input.missingObjects.length} file(s) were referenced by a row but were not in storage, so`,
      'they are not in this archive. See missing_objects in manifest.json. This reflects the state',
      'of the source data, not a fault in the backup.',
    );
  }

  if (input.encrypted) {
    lines.push(
      '',
      'ENCRYPTION',
      '----------',
      '',
      'This archive was encrypted with AES-256-GCM before leaving the server. If you are reading',
      'this, it has already been decrypted. To get another one:',
      '',
      '    Tenant Config -> Backup & Restore -> the target -> Browse archives -> Download',
      '',
      'You are asked for the archive passphrase and the file is decrypted as it downloads.',
      '',
      "It can only be opened with the scheme's archive passphrase. Nobody, including the people",
      'who run the server, can recover the contents without it.',
    );
  }

  const failed = input.tables.filter((t) => t.status !== 'succeeded');

  if (failed.length) {
    lines.push(
      '',
      'WARNING',
      '-------',
      '',
      `${failed.length} table(s) did not export cleanly: ${failed
        .map((t) => t.table)
        .join(', ')}.`,
      'This archive is incomplete. Check the run in Tenant Config for the reason.',
    );
  }

  lines.push('');

  return lines.join('\n');
}
