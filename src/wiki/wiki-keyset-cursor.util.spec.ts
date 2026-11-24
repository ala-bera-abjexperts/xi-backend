/**
 * Keyset cursor helpers.
 *
 * These encode a POSITION IN AN ORDERING, so every failure mode here is silent data loss rather than
 * an error: a `>` where `>=` belongs repeats a row on each page boundary, a missing equality branch
 * skips one, and an unquoted value turns into extra filter syntax that changes the result set.
 */

import {
  buildWikiKeysetFilter,
  decodeWikiCursor,
  encodeWikiCursor,
  WIKI_ORDER_COLUMNS,
  wikiCursorValues,
} from './wiki-keyset-cursor.util';

describe('wiki keyset cursor', () => {
  describe('orderings', () => {
    it('ends every ordering with the unique id, or paging could skip or repeat rows', () => {
      for (const columns of Object.values(WIKI_ORDER_COLUMNS)) {
        expect(columns[columns.length - 1]).toBe('id');
      }
    });

    it('orders tree mode by depth first so a parent always precedes its children', () => {
      expect(WIKI_ORDER_COLUMNS.tree[0]).toBe('level');
    });
  });

  describe('encode / decode', () => {
    it('round-trips a key', () => {
      const values = [0, '2026-07-26T10:00:00Z', 'a-uuid'];
      const decoded = decodeWikiCursor(
        encodeWikiCursor('default', values),
        'default',
      );

      expect(decoded).toEqual(values);
    });

    it('REFUSES a cursor minted under a different ordering', () => {
      // The tuples have different arities; comparing them would silently mis-page rather than fail.
      const cursor = encodeWikiCursor('tree', [1, 0, 'ts', 'id']);

      expect(decodeWikiCursor(cursor, 'default')).toBeNull();
    });

    it('refuses a cursor whose arity does not match the ordering', () => {
      const cursor = encodeWikiCursor('default', ['only-one']);

      expect(decodeWikiCursor(cursor, 'default')).toBeNull();
    });

    it('returns null for malformed input rather than throwing mid-request', () => {
      expect(decodeWikiCursor('not-base64!!', 'default')).toBeNull();
      expect(decodeWikiCursor('', 'default')).toBeNull();
    });
  });

  describe('wikiCursorValues', () => {
    it('reads the key in the same column order the cursor encodes', () => {
      const row = {
        level: 2,
        sort_order: 0,
        created_at: '2026-07-26T10:00:00Z',
        id: 'page-uuid',
        title: 'ignored',
      };

      expect(wikiCursorValues(row, 'tree')).toEqual([
        2,
        0,
        '2026-07-26T10:00:00Z',
        'page-uuid',
      ]);
    });

    it('maps a missing column to null rather than undefined', () => {
      // `undefined` would serialize out of the JSON payload entirely and shift the tuple.
      expect(wikiCursorValues({ id: 'x' }, 'default')).toEqual([
        null,
        null,
        'x',
      ]);
    });
  });

  describe('buildWikiKeysetFilter', () => {
    it('expands the tuple comparison into one branch per column', () => {
      // PostgREST has no row-value comparison, so (a,b,c) > (:a,:b,:c) must be written as
      // a > :a OR (a = :a AND b > :b) OR (a = :a AND b = :b AND c > :c).
      const filter = buildWikiKeysetFilter('default', [
        0,
        '2026-07-26T10:00:00Z',
        'uuid-1',
      ]);
      const branches = filter.split('),and(');

      expect(branches).toHaveLength(WIKI_ORDER_COLUMNS.default.length);
      expect(filter).toContain('sort_order.gt.0');
      expect(filter).toContain('sort_order.eq.0');
      expect(filter).toContain('id.gt."uuid-1"');
    });

    it('makes the LAST branch require equality on every preceding column', () => {
      const filter = buildWikiKeysetFilter('default', [0, 'ts', 'uuid-1']);
      const last = filter.slice(filter.lastIndexOf('and('));

      expect(last).toContain('sort_order.eq.0');
      expect(last).toContain('created_at.eq."ts"');
      expect(last).toContain('id.gt."uuid-1"');
    });

    it('uses strictly-greater on the leading column, so the cursor row is never repeated', () => {
      const filter = buildWikiKeysetFilter('default', [5, 'ts', 'uuid-1']);

      expect(filter.startsWith('and(sort_order.gt.5)')).toBe(true);
    });

    it('quotes string values — an unquoted comma would parse as more filter syntax', () => {
      const filter = buildWikiKeysetFilter('default', [0, 'a,b(c)', 'uuid']);

      expect(filter).toContain('"a,b(c)"');
    });

    it('handles the 4-column tree ordering', () => {
      const filter = buildWikiKeysetFilter('tree', [1, 0, 'ts', 'uuid']);

      expect(filter.split('),and(')).toHaveLength(4);
      expect(filter).toContain('level.gt.1');
    });
  });
});
