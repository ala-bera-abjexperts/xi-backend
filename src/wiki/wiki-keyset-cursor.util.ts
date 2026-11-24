/**
 * @fileoverview Keyset (cursor) pagination helpers for wiki listings.
 *
 * Offset pagination is wrong for a list that is permission-filtered after it is read: rows the caller
 * cannot see still consume offsets, so pages come back short and — worse — inserts and deletes between
 * requests make rows repeat or vanish. A keyset cursor addresses a POSITION IN THE ORDER instead of a
 * row count, so it is stable under concurrent writes.
 *
 * The tuple must be totally ordered or the cursor can skip or repeat rows. Both orderings used here
 * end in `id` (the uuid primary key), which guarantees uniqueness even when every other component
 * ties — and after a migration they very often do tie, because `sort_order` is left at its default
 * for every imported page.
 */

/** Ordering the caller asked for. `tree` guarantees a parent sorts before its children. */
export type WikiListOrder = 'default' | 'tree';

/** Column tuple per ordering — the last element must be unique. */
export const WIKI_ORDER_COLUMNS: Record<WikiListOrder, readonly string[]> = {
  default: ['sort_order', 'created_at', 'id'],
  tree: ['level', 'sort_order', 'created_at', 'id'],
};

/**
 * Encode the ordering key of a row as an opaque cursor.
 *
 * The order name is embedded so a cursor minted under one ordering can never be replayed against
 * another — the tuples have different arities and comparing them would silently mis-page.
 */
export function encodeWikiCursor(
  order: WikiListOrder,
  values: (string | number | null)[],
): string {
  const payload = JSON.stringify({ o: order, v: values });

  return Buffer.from(payload, 'utf8').toString('base64url');
}

/** Decode a cursor, or `null` when malformed or minted for a different ordering. */
export function decodeWikiCursor(
  cursor: string,
  order: WikiListOrder,
): (string | number | null)[] | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as {
      o?: unknown;
      v?: unknown;
    };

    if (parsed.o !== order || !Array.isArray(parsed.v)) return null;
    if (parsed.v.length !== WIKI_ORDER_COLUMNS[order].length) return null;

    return parsed.v as (string | number | null)[];
  } catch {
    return null;
  }
}

/** Read the ordering key out of a row, in the same column order the cursor encodes. */
export function wikiCursorValues(
  row: Record<string, unknown>,
  order: WikiListOrder,
): (string | number | null)[] {
  return WIKI_ORDER_COLUMNS[order].map((column) => {
    const value = row[column];

    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;

    return String(value);
  });
}

/**
 * PostgREST `or=` predicate for "strictly after this key", expanded lexicographically.
 *
 * PostgREST has no row-value comparison (`(a,b,c) > (:a,:b,:c)`), so the tuple comparison is written
 * out as the equivalent disjunction:
 *
 *   a > :a OR (a = :a AND b > :b) OR (a = :a AND b = :b AND c > :c)
 *
 * Getting this wrong is a silent data bug rather than an error — a `>` where `>=` belongs repeats a
 * row on every page boundary, and dropping the trailing equality branch skips one.
 */
export function buildWikiKeysetFilter(
  order: WikiListOrder,
  values: (string | number | null)[],
): string {
  const columns = WIKI_ORDER_COLUMNS[order];
  const branches: string[] = [];

  for (let i = 0; i < columns.length; i++) {
    const equalities = columns
      .slice(0, i)
      .map((column, j) => `${column}.eq.${formatValue(values[j])}`);

    branches.push(
      `and(${[...equalities, `${columns[i]}.gt.${formatValue(values[i])}`].join(',')})`,
    );
  }

  return branches.join(',');
}

/**
 * PostgREST filter values are comma/parenthesis delimited, so any value containing those characters
 * must be quoted or it would be parsed as more filter syntax. Timestamps and uuids are safe, but
 * quoting unconditionally keeps this correct if the tuple ever gains a text column.
 */
function formatValue(value: string | number | null): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);

  return `"${value.replace(/"/g, '\\"')}"`;
}
