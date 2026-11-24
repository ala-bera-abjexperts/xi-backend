/**
 * @fileoverview The SQL dump has to come back as the rows that went in.
 * @module src/backup/engine/writers/sql.reader.spec
 *
 * SQL is the DEFAULT backup format, so until this reader existed the default archive was an export
 * and not a restore point — every archive this product had written was unrestorable by it.
 *
 * The load-bearing test here is the ROUND TRIP: rows are written by the real `sql.writer.ts` and
 * read back by the real reader, and the result must equal the input exactly. Asserting against a
 * hand-written string would only prove the reader agrees with whoever wrote the fixture; driving
 * the writer proves the two halves agree with each other, which is the property a restore depends
 * on.
 *
 * The refusals matter as much. A restore cannot be undone, so a file that is *almost* one of ours
 * must fail rather than produce plausible wrong rows.
 */

import { PassThrough } from 'node:stream';
import { sqlFormat } from './sql.writer';
import { SqlReadError, SqlRowReader, parseSqlLiteral } from './sql.reader';

/** Writes rows through the real writer and returns the bytes it produced. */
async function dump(
  table: string,
  rows: Record<string, unknown>[],
): Promise<string> {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];

  sink.on('data', (chunk: Buffer) => chunks.push(chunk));

  const writer = sqlFormat.create(sink, { table, insertLevel: 3 });

  for (const row of rows) {
    await writer.writeRow(row);
  }

  await writer.finish();

  return Buffer.concat(chunks).toString('utf8');
}

/** Feeds a dump through the real reader. */
function read(table: string, sql: string): Record<string, unknown>[] {
  const reader = new SqlRowReader(table);
  const rows: Record<string, unknown>[] = [];

  for (const line of sql.split('\n')) {
    reader.push(line);
    rows.push(...reader.drain());
  }

  reader.end();
  rows.push(...reader.drain());

  return rows;
}

/** Writes rows and reads them straight back. */
async function roundTrip(
  table: string,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  return read(table, await dump(table, rows));
}

describe('SQL round trip', () => {
  it('returns simple rows unchanged', async () => {
    const rows = [
      { id: 'a', title: 'First' },
      { id: 'b', title: 'Second' },
    ];

    expect(await roundTrip('tasks', rows)).toEqual(rows);
  });

  it('keeps NULL apart from the empty string', async () => {
    const rows = [{ id: 'a', note: null, other: '' }];

    // The distinction CSV cannot carry, and the reason it stays export-only while this does not.
    const [row] = await roundTrip('tasks', rows);

    expect(row.note).toBeNull();
    expect(row.other).toBe('');
  });

  it('keeps booleans as booleans, not as the strings "true" and "false"', async () => {
    const [row] = await roundTrip('tasks', [
      { id: 'a', done: true, open: false },
    ]);

    expect(row.done).toBe(true);
    expect(row.open).toBe(false);
  });

  it('keeps numbers as numbers, including negatives and decimals', async () => {
    const rows = [{ id: 'a', count: 42, ratio: -3.5, zero: 0 }];

    // A negative number is the value the spreadsheet formula guard rewrites on the way out, which
    // is one of the two reasons CSV cannot be read back. SQL quotes nothing here, so it survives.
    expect(await roundTrip('tasks', rows)).toEqual(rows);
  });

  it('keeps a jsonb object an object', async () => {
    const rows = [{ id: 'a', meta: { nested: { k: [1, 2, 3] }, flag: true } }];

    expect(await roundTrip('tasks', rows)).toEqual(rows);
  });

  it('survives quotes, commas and parentheses inside text', async () => {
    const rows = [
      { id: 'a', title: "O'Brien, (mostly)" },
      { id: 'b', title: "it''s already doubled" },
      { id: 'c', title: "',NULL),('x" },
    ];

    // The last one is the interesting case: text shaped like the tuple separator itself. A reader
    // that split on commas rather than tracking quotes would invent rows out of it.
    expect(await roundTrip('tasks', rows)).toEqual(rows);
  });

  it('survives newlines inside a value', async () => {
    const rows = [{ id: 'a', body: 'line one\nline two\nline three' }];

    // Statements are read line by line, so a value containing newlines is the case that breaks a
    // naive line-at-a-time parser.
    expect(await roundTrip('tasks', rows)).toEqual(rows);
  });

  it('survives unicode and emoji', async () => {
    const rows = [{ id: 'a', title: 'Größe — 日本語 — 🎯' }];

    expect(await roundTrip('tasks', rows)).toEqual(rows);
  });

  it('reads a table larger than one INSERT statement', async () => {
    // The writer flushes every 500 rows, so this spans three statements and proves the reader
    // carries its column list across them.
    const rows = Array.from({ length: 1200 }, (_, index) => ({
      id: `row-${index}`,
      n: index,
    }));

    expect(await roundTrip('tasks', rows)).toEqual(rows);
  });

  it('reads an empty table as no rows rather than failing', async () => {
    expect(await roundTrip('tasks', [])).toEqual([]);
  });
});

describe('SQL literals', () => {
  it('parses each form the writer emits', () => {
    expect(parseSqlLiteral('NULL', 't', 'c')).toBeNull();
    expect(parseSqlLiteral('TRUE', 't', 'c')).toBe(true);
    expect(parseSqlLiteral('FALSE', 't', 'c')).toBe(false);
    expect(parseSqlLiteral('42', 't', 'c')).toBe(42);
    expect(parseSqlLiteral('-3.5', 't', 'c')).toBe(-3.5);
    expect(parseSqlLiteral("'text'", 't', 'c')).toBe('text');
    expect(parseSqlLiteral("'it''s'", 't', 'c')).toBe("it's");
    expect(parseSqlLiteral(`'{"a":1}'::jsonb`, 't', 'c')).toEqual({ a: 1 });
  });

  it('refuses a bare token that is not a number', () => {
    // An unquoted word is a function call, a column reference or a keyword — never a value this
    // writer produced. Treating it as text is how `now()` becomes the literal string "now()".
    expect(() => parseSqlLiteral('now()', 't', 'c')).toThrow(SqlReadError);
    expect(() => parseSqlLiteral('DEFAULT', 't', 'c')).toThrow(SqlReadError);
  });

  it('refuses a ::jsonb literal that is not valid JSON', () => {
    expect(() => parseSqlLiteral("'{oops'::jsonb", 't', 'c')).toThrow(
      SqlReadError,
    );
  });
});

describe('what the reader refuses', () => {
  it('refuses values that arrive before any INSERT', () => {
    expect(() => read('tasks', "  ('a', 'b'),\n")).toThrow(SqlReadError);
  });

  it('refuses a row whose value count does not match its columns', () => {
    const sql = [
      'INSERT INTO public."tasks" ("id", "title") VALUES',
      "  ('a', 'First', 'extra');",
    ].join('\n');

    // Off-by-one here would shift every following column into the wrong field — the kind of
    // corruption that looks like real data.
    expect(() => read('tasks', sql)).toThrow(/2 columns/);
  });

  it('refuses a truncated statement rather than dropping it', () => {
    const sql = [
      'INSERT INTO public."tasks" ("id", "title") VALUES',
      "  ('a', 'First',",
    ].join('\n');

    // A file cut off mid-upload must not restore as "everything before the cut".
    expect(() => read('tasks', sql)).toThrow(/truncated/);
  });

  it('refuses SQL this product did not write', () => {
    // Valid Postgres, but not this writer's grammar: no schema, no quoted identifiers, no column
    // list. The reader parses one dialect — its own.
    expect(() => read('tasks', 'insert into tasks values (1);')).toThrow(
      SqlReadError,
    );
  });

  it('ignores the comment header the writer emits', () => {
    const sql = [
      '-- tasks',
      '-- Dependency level 3.',
      '-- Generated by the XISUITE backup engine.',
      '',
      'INSERT INTO public."tasks" ("id") VALUES',
      "  ('a');",
    ].join('\n');

    expect(read('tasks', sql)).toEqual([{ id: 'a' }]);
  });
});
