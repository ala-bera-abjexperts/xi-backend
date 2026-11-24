/**
 * @fileoverview Reads back the INSERT statements this product writes.
 * @module src/backup/engine/writers/sql.reader
 *
 * This does NOT execute SQL, and it is not a general SQL parser. There is no Postgres driver in
 * this backend — every write goes through PostgREST — so a `.sql` archive is turned back into row
 * objects here and inserted the same way an NDJSON archive is.
 *
 * That is only sound because the input is not arbitrary SQL: it is the output of `sql.writer.ts`,
 * whose grammar is small and fully known.
 *
 *     -- tasks
 *     -- Dependency level 6. …
 *
 *     INSERT INTO public."tasks" ("id", "title", "meta") VALUES
 *       ('a', 'First', '{"k":1}'::jsonb),
 *       ('b', NULL, NULL);
 *
 * Every type distinction the database had survives that: `NULL` is null, `TRUE`/`FALSE` are
 * booleans, a bare token is a number, `'…'::jsonb` is an object, and `'…'` is text with `''`
 * meaning one quote. Nothing is inferred from shape — which is exactly what CSV cannot do, and why
 * CSV stays export-only while this does not.
 *
 * Anything outside that grammar is refused rather than guessed at. A file that is *almost* one of
 * ours is the dangerous case: half-understanding it would write plausible wrong rows, and a restore
 * cannot be undone.
 */

/** Raised when the input is not a dump this product wrote. */
export class SqlReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlReadError';
  }
}

/** One parsed statement: the columns it names and the rows it carries. */
export interface SqlStatement {
  columns: string[];
  rows: unknown[][];
}

/** `INSERT INTO public."table" ("a", "b") VALUES` — the only statement form this writer emits. */
const INSERT_HEAD =
  /^INSERT\s+INTO\s+public\."([A-Za-z0-9_]+)"\s*\(([^)]*)\)\s+VALUES\s*$/;

/**
 * Splits a tuple body into its literals, respecting quotes.
 *
 * A comma inside `'a, b'` is data, not a separator, so this cannot be a `split(',')`. Doubled
 * quotes inside a literal are part of the value and do not end it.
 */
function splitLiterals(body: string, table: string): string[] {
  const parts: string[] = [];

  let current = '';
  let index = 0;
  let inQuotes = false;

  while (index < body.length) {
    const char = body[index];

    if (inQuotes) {
      if (char === "'") {
        // Two quotes in a row are one literal quote, still inside the string.
        if (body[index + 1] === "'") {
          current += "''";
          index += 2;
          continue;
        }

        inQuotes = false;
      }

      current += char;
      index += 1;
      continue;
    }

    if (char === "'") {
      inQuotes = true;
      current += char;
      index += 1;
      continue;
    }

    if (char === ',') {
      parts.push(current.trim());
      current = '';
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  if (inQuotes) {
    throw new SqlReadError(
      `A value in ${table} has an unterminated quote, so this file was not read.`,
    );
  }

  parts.push(current.trim());

  return parts;
}

/**
 * One SQL literal back to the JavaScript value it came from.
 *
 * The inverse of `sqlValue` in sql.writer.ts, and deliberately as strict: a token that is not one
 * of the forms that writer emits is an error, never a string fallback.
 */
export function parseSqlLiteral(
  literal: string,
  table: string,
  column: string,
): unknown {
  const token = literal.trim();

  if (token === 'NULL') {
    return null;
  }

  if (token === 'TRUE') {
    return true;
  }

  if (token === 'FALSE') {
    return false;
  }

  if (token.startsWith("'")) {
    const jsonb = token.endsWith('::jsonb');
    const quoted = jsonb ? token.slice(0, -'::jsonb'.length).trim() : token;

    if (!quoted.startsWith("'") || !quoted.endsWith("'") || quoted.length < 2) {
      throw new SqlReadError(
        `${table}.${column} holds a quoted value this reader cannot parse.`,
      );
    }

    // Undo the one escape the writer applies: a doubled quote is a single quote.
    const text = quoted.slice(1, -1).replace(/''/g, "'");

    if (!jsonb) {
      return text;
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new SqlReadError(
        `${table}.${column} is marked ::jsonb but does not contain valid JSON.`,
      );
    }
  }

  // Everything the writer emits unquoted is a finite number. Refused rather than coerced: a token
  // that is not one is a file this reader does not understand.
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token)) {
    return Number(token);
  }

  throw new SqlReadError(
    `${table}.${column} holds ${JSON.stringify(token)}, which is not a value this product writes.`,
  );
}

/** Column names out of `("a", "b")`. */
function parseColumns(list: string, table: string): string[] {
  const columns = list
    .split(',')
    .map((name) => name.trim())
    .map((name) => {
      const match = /^"([A-Za-z0-9_]+)"$/.exec(name);

      if (!match) {
        throw new SqlReadError(
          `${table} names a column this reader cannot parse: ${name}`,
        );
      }

      return match[1];
    });

  if (!columns.length) {
    throw new SqlReadError(`${table} has an INSERT with no columns.`);
  }

  return columns;
}

/**
 * Turns a line-oriented SQL dump into rows, incrementally.
 *
 * Written as a feed-one-line-at-a-time reader rather than a whole-file parse so a multi-gigabyte
 * table costs no more memory than one statement — the same property the NDJSON reader has.
 */
export class SqlRowReader {
  private columns: string[] | null = null;
  private buffer = '';
  private readonly pending: Record<string, unknown>[] = [];

  constructor(private readonly table: string) {}

  /** Feeds one line. Rows completed by it become available from `drain()`. */
  push(line: string): void {
    const trimmed = line.trim();

    // Comments carry the table name and dependency level, which the manifest already states.
    if (!trimmed || trimmed.startsWith('--')) {
      return;
    }

    const head = INSERT_HEAD.exec(trimmed);

    if (head) {
      this.columns = parseColumns(head[2], this.table);
      this.buffer = '';

      return;
    }

    if (!this.columns) {
      throw new SqlReadError(
        `${this.table} has values before any INSERT statement, so this file was not read.`,
      );
    }

    // Tuples may wrap: a row wider than a line, or a value containing a newline. Accumulate until
    // the parentheses balance outside of quotes.
    this.buffer += this.buffer ? `\n${trimmed}` : trimmed;

    if (!this.isComplete(this.buffer)) {
      return;
    }

    const body = this.buffer;

    this.buffer = '';

    for (const tuple of this.tuples(body)) {
      const literals = splitLiterals(tuple, this.table);

      if (literals.length !== this.columns.length) {
        throw new SqlReadError(
          `A row in ${this.table} has ${literals.length} values for ${this.columns.length} columns.`,
        );
      }

      const row: Record<string, unknown> = {};

      this.columns.forEach((column, index) => {
        row[column] = parseSqlLiteral(literals[index], this.table, column);
      });

      this.pending.push(row);
    }
  }

  /** Rows parsed since the last call. */
  drain(): Record<string, unknown>[] {
    return this.pending.splice(0, this.pending.length);
  }

  /** Called once the input ends, to refuse a half-read statement rather than silently dropping it. */
  end(): void {
    if (this.buffer.trim()) {
      throw new SqlReadError(
        `${this.table} ends mid-statement, so the file is truncated and was not read.`,
      );
    }
  }

  /** True when every `(` in the accumulated text has been closed outside of a quoted literal. */
  private isComplete(text: string): boolean {
    let depth = 0;
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];

      if (inQuotes) {
        if (char === "'") {
          if (text[index + 1] === "'") {
            index += 1;
            continue;
          }

          inQuotes = false;
        }

        continue;
      }

      if (char === "'") {
        inQuotes = true;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
    }

    return !inQuotes && depth === 0;
  }

  /** The `( … )` groups in a completed chunk, without their outer parentheses. */
  private *tuples(text: string): Generator<string> {
    let depth = 0;
    let inQuotes = false;
    let start = -1;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];

      if (inQuotes) {
        if (char === "'") {
          if (text[index + 1] === "'") {
            index += 1;
            continue;
          }

          inQuotes = false;
        }

        continue;
      }

      if (char === "'") {
        inQuotes = true;
        continue;
      }

      if (char === '(') {
        if (depth === 0) {
          start = index + 1;
        }

        depth += 1;
        continue;
      }

      if (char === ')') {
        depth -= 1;

        if (depth === 0 && start >= 0) {
          yield text.slice(start, index);
          start = -1;
        }
      }
    }
  }
}
