/**
 * @fileoverview Tests for the seven export formats.
 * @module src/backup/engine/writers/table-writer.spec
 *
 * Weighted towards the two writers whose output is executed rather than read: SQL, which a DBA runs
 * against a live database, and the delimited formats, whose cells a spreadsheet evaluates on open.
 * A bug in the XML writer produces a file that will not parse; a bug in either of those produces
 * one that runs.
 */

import { PassThrough } from 'node:stream';
import * as XLSX from 'xlsx';
import { FORMAT_REGISTRY, assertRegistryComplete } from './format-registry';
import { csvCell, neutraliseFormula, tsvCell } from './delimited.writer';
import { quoteLiteral, sqlValue } from './sql.writer';
import { escapeXml, stripIllegalXml } from './xml.writer';
import { XLSX_MAX_ROWS, sheetNameFor } from './xlsx.writer';
import {
  BACKUP_FILE_FORMATS,
  RESTORABLE_FORMATS,
  assertSafeIdentifier,
  isBackupFileFormat,
  type BackupFileFormat,
} from './table-writer';

const CTX = { table: 'tasks', insertLevel: 6 };

/** Runs rows through a format and returns the file it produced. */
async function render(
  format: BackupFileFormat,
  rows: Record<string, unknown>[],
): Promise<string> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];

  sink.on('data', (chunk: Buffer) => chunks.push(chunk));

  const writer = FORMAT_REGISTRY[format].create(sink, CTX);

  for (const row of rows) {
    await writer.writeRow(row);
  }

  await writer.finish();

  return Buffer.concat(chunks).toString('utf8');
}

describe('format registry', () => {
  it('has a writer for every declared format', () => {
    expect(() => assertRegistryComplete()).not.toThrow();
    expect(Object.keys(FORMAT_REGISTRY).sort()).toEqual(
      [...BACKUP_FILE_FORMATS].sort(),
    );
  });

  it('marks exactly the lossless formats restorable', () => {
    // SQL joined this list once sql.reader.ts existed. Nothing executes it — the reader parses
    // this writer's own grammar back into rows, and every type survives that.
    //
    // csv/tsv/xlsx cannot join it: they cannot tell an empty string from a NULL, and the
    // spreadsheet formula guard has already rewritten any value starting with = + - @. xml keeps
    // null and empty apart but loses every type, so a jsonb column would come back as text.
    expect([...RESTORABLE_FORMATS].sort()).toEqual(['json', 'ndjson', 'sql']);

    for (const format of BACKUP_FILE_FORMATS) {
      expect(FORMAT_REGISTRY[format].restorable).toBe(
        (RESTORABLE_FORMATS as readonly string[]).includes(format),
      );
    }
  });

  it('rejects a format name that is not one of the seven', () => {
    expect(isBackupFileFormat('sql')).toBe(true);
    expect(isBackupFileFormat('parquet')).toBe(false);
    expect(isBackupFileFormat(undefined)).toBe(false);
  });

  it('says something for an empty table rather than leaving a blank file', async () => {
    for (const format of BACKUP_FILE_FORMATS) {
      // NDJSON is the deliberate exception: the format is "one JSON value per line", so zero rows
      // IS zero bytes. A comment line would make the file unparseable, and this is the layer
      // restore reads — correctness beats reassurance here.
      if (format === 'ndjson') {
        expect(await render(format, [])).toBe('');
        continue;
      }

      // For every other format a zero-byte member is indistinguishable from a failed export.
      expect((await render(format, [])).length).toBeGreaterThan(0);
    }
  });
});

describe('sql writer', () => {
  it('emits a valid multi-row INSERT with quoted identifiers', async () => {
    const out = await render('sql', [
      { id: 'a', title: 'First' },
      { id: 'b', title: 'Second' },
    ]);

    expect(out).toContain('INSERT INTO public."tasks" ("id", "title") VALUES');
    expect(out).toContain("('a', 'First')");
    expect(out).toContain("('b', 'Second')");
    // One statement for the page, not one per row.
    expect(out.match(/INSERT INTO/g)).toHaveLength(1);
  });

  it("escapes a quote by doubling it, and never reaches for E''", () => {
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");

    // A backslash is literal under standard_conforming_strings; escaping it would corrupt every
    // Windows path and regex in the database.
    expect(quoteLiteral('C:\\Users')).toBe("'C:\\Users'");
  });

  it('survives the classic injection payload as data', async () => {
    const payload = "'); DROP TABLE users; --";

    // Asserted on the literal itself rather than by searching the file: the correctly escaped
    // form necessarily CONTAINS the payload text, so a substring check cannot tell safe from
    // unsafe. What matters is that the value opens and closes exactly once, with the inner quote
    // doubled — which is what this equality pins.
    expect(sqlValue(payload, 'tasks', 'title')).toBe(
      "'''); DROP TABLE users; --'",
    );

    const out = await render('sql', [{ id: 'x', title: payload }]);

    expect(out).toContain("('x', '''); DROP TABLE users; --')");
  });

  it('writes NULL, booleans and numbers unquoted', () => {
    expect(sqlValue(null, 'tasks', 'c')).toBe('NULL');
    expect(sqlValue(undefined, 'tasks', 'c')).toBe('NULL');
    expect(sqlValue(true, 'tasks', 'c')).toBe('TRUE');
    expect(sqlValue(false, 'tasks', 'c')).toBe('FALSE');
    expect(sqlValue(42, 'tasks', 'c')).toBe('42');
  });

  it('casts nested values to jsonb so the INSERT matches the column type', () => {
    expect(sqlValue({ a: 1 }, 'tasks', 'meta')).toBe(`'{"a":1}'::jsonb`);
    expect(sqlValue([1, 2], 'tasks', 'meta')).toBe(`'[1,2]'::jsonb`);
  });

  it('refuses a NUL byte rather than writing a dump that cannot apply', () => {
    expect(() => sqlValue('bad\u0000value', 'tasks', 'title')).toThrow(/NUL/);
  });

  it('refuses a non-finite number', () => {
    expect(() => sqlValue(Number.NaN, 'tasks', 'n')).toThrow(/NaN/);
    expect(() => sqlValue(Number.POSITIVE_INFINITY, 'tasks', 'n')).toThrow();
  });

  it('records the dependency level so a DBA knows the insert order', async () => {
    expect(await render('sql', [{ id: 'a' }])).toContain('Dependency level 6');
  });
});

describe('delimited writers', () => {
  it('neutralises every spreadsheet formula prefix', () => {
    for (const payload of [
      '=cmd|calc',
      '+1+1',
      '-1+1',
      '@SUM(A1)',
      '\tx',
      '\rx',
    ]) {
      expect(neutraliseFormula(payload).startsWith("'")).toBe(true);
    }
  });

  it('leaves ordinary text alone', () => {
    expect(neutraliseFormula('Ordinary title')).toBe('Ordinary title');
    expect(neutraliseFormula('')).toBe('');
  });

  it('neutralises formulas end to end in a CSV', async () => {
    const out = await render('csv', [{ id: 'a', title: '=cmd|calc' }]);

    // Quoted because of the apostrophe-prefixed content, and inert either way.
    expect(out).toContain("'=cmd|calc");
    expect(out).not.toMatch(/,=cmd/);
  });

  it('quotes cells containing the delimiter, quotes or newlines', () => {
    expect(csvCell('plain', ',')).toBe('plain');
    expect(csvCell('a,b', ',')).toBe('"a,b"');
    expect(csvCell('say "hi"', ',')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak', ',')).toBe('"line\nbreak"');
  });

  it('escapes tabs and newlines in TSV, which has no quoting', () => {
    expect(tsvCell('a\tb')).toBe('a\\tb');
    expect(tsvCell('a\nb')).toBe('a\\nb');
    expect(tsvCell('a\\b')).toBe('a\\\\b');
  });

  it('writes a header row from the first record', async () => {
    const out = await render('csv', [{ id: 'a', title: 'T' }]);

    expect(out.split('\n')[0]).toBe('id,title');
  });

  it('renders nested values as JSON rather than [object Object]', async () => {
    const out = await render('csv', [{ id: 'a', meta: { k: 'v' } }]);

    expect(out).toContain('{""k"":""v""}');
    expect(out).not.toContain('[object Object]');
  });
});

describe('json writers', () => {
  it('round-trips NDJSON exactly', async () => {
    const rows = [
      { id: 'a', n: 1, nested: { x: [1, 2] }, empty: '', missing: null },
      { id: 'b', n: 2, nested: { x: [] }, empty: '', missing: null },
    ];

    const parsed = (await render('ndjson', rows))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    // The distinction CSV loses: null and '' survive as themselves.
    expect(parsed).toEqual(rows);
  });

  it('produces a parseable array for JSON, including when empty', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];

    expect(JSON.parse(await render('json', rows))).toEqual(rows);
    expect(JSON.parse(await render('json', []))).toEqual([]);
  });
});

describe('xml writer', () => {
  it('escapes the five entities, ampersand first', () => {
    expect(escapeXml('<a & b>')).toBe('&lt;a &amp; b&gt;');
    expect(escapeXml('"q"')).toBe('&quot;q&quot;');
    // Double-escaping check: the & introduced by &lt; must not itself be escaped.
    expect(escapeXml('<')).toBe('&lt;');
  });

  it('strips control characters XML cannot represent, keeping tab and newline', () => {
    expect(stripIllegalXml('a\u0000b\u0008c')).toBe('abc');
    expect(stripIllegalXml('a\tb\nc')).toBe('a\tb\nc');
  });

  it('omits an element for NULL so it stays distinguishable from empty', async () => {
    const out = await render('xml', [{ id: 'a', note: null, blank: '' }]);

    expect(out).toContain('<blank></blank>');
    expect(out).not.toContain('<note>');
  });

  it('produces a well-formed document', async () => {
    const out = await render('xml', [{ id: 'a' }]);

    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(out.trimEnd().endsWith('</table>')).toBe(true);
  });
});

describe('xlsx writer', () => {
  it('aborts rather than truncating past the Excel sheet limit', async () => {
    const sink = new PassThrough();

    sink.resume();

    const writer = FORMAT_REGISTRY.xlsx.create(sink, CTX);

    // Reach the cap without allocating a million real rows: the guard counts what it has buffered,
    // so priming that array directly exercises the same branch.
    const internals = writer as unknown as { rows: string[][] };

    internals.rows = new Array<string[]>(XLSX_MAX_ROWS).fill(['x']);

    await expect(writer.writeRow({ id: 'a' })).rejects.toThrow(
      /more than one Excel sheet can hold/,
    );
  });

  it('keeps sheet names legal and distinct for long table names', () => {
    expect(sheetNameFor('tasks')).toBe('tasks');
    expect(sheetNameFor('a'.repeat(40)).length).toBe(31);
    expect(sheetNameFor('with/slash:and*star')).toBe('with_slash_and_star');

    // Long names share prefixes, so keeping the tail is what stops two sheets colliding.
    const a = sheetNameFor('form_builder_integration_deliveries');
    const b = sheetNameFor('form_builder_integration_webhooks');

    expect(a).not.toEqual(b);
  });

  it('writes a real workbook that reads back', async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];

    sink.on('data', (chunk: Buffer) => chunks.push(chunk));

    const writer = FORMAT_REGISTRY.xlsx.create(sink, CTX);

    await writer.writeRow({ id: 'a', title: 'First' });
    await writer.finish();

    const book = XLSX.read(Buffer.concat(chunks), { type: 'buffer' });
    const sheet = book.Sheets[book.SheetNames[0]];

    expect(XLSX.utils.sheet_to_json(sheet)).toEqual([
      { id: 'a', title: 'First' },
    ]);
  });
});

describe('identifier safety', () => {
  it('accepts catalog-shaped names and rejects anything else', () => {
    expect(assertSafeIdentifier('task_statuses')).toBe('task_statuses');
    expect(() => assertSafeIdentifier('drop table')).toThrow();
    expect(() => assertSafeIdentifier('Tasks')).toThrow();
    expect(() => assertSafeIdentifier('a"b')).toThrow();
  });
});
