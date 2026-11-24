/**
 * Tests for label sanitization (pure — no DI, no jsdom).
 *
 * Context: until this change, `issues.stage.ts` FETCHED labels (they are in `ISSUE_SYSTEM_FIELDS`
 * and normalized at `jira-adapter.base.ts:515`) and then dropped them on the floor — the create
 * payload never passed them. So every migrated task lost its labels silently.
 *
 * Wiring them up exposes a second problem: `CreateTaskDto.labels` is `@IsArray()` and nothing else,
 * and `tasks.labels` is untyped jsonb. The DTO rejects nothing, so whatever Jira hands back reaches
 * the task UI. These tests pin the sanitizer that stands in that gap.
 */

import { sanitizeLabels } from './issue-labels.util';

describe('sanitizeLabels', () => {
  describe('the happy path', () => {
    it('keeps real labels in source order', () => {
      expect(sanitizeLabels(['billing', 'regression', 'api'])).toEqual([
        'billing',
        'regression',
        'api',
      ]);
    });

    it('returns a new array rather than the input', () => {
      const input = ['billing'];

      expect(sanitizeLabels(input)).not.toBe(input);
    });
  });

  describe('case sensitivity is preserved (Jira treats these as DISTINCT labels)', () => {
    it('does NOT merge labels differing only by case', () => {
      // Case-insensitive dedupe would silently destroy a real, separate Jira label.
      expect(sanitizeLabels(['Billing', 'billing', 'BILLING'])).toEqual([
        'Billing',
        'billing',
        'BILLING',
      ]);
    });
  });

  describe('deduplication', () => {
    it('drops exact duplicates, keeping the FIRST occurrence', () => {
      expect(sanitizeLabels(['api', 'billing', 'api'])).toEqual([
        'api',
        'billing',
      ]);
    });

    it('treats values equal only after trimming as duplicates', () => {
      expect(sanitizeLabels(['api', '  api  '])).toEqual(['api']);
    });
  });

  describe('whitespace', () => {
    it('trims surrounding whitespace', () => {
      expect(sanitizeLabels(['  billing  '])).toEqual(['billing']);
    });

    it('drops whitespace-only entries', () => {
      expect(sanitizeLabels(['billing', '   ', '\t', '\n'])).toEqual([
        'billing',
      ]);
    });

    it('drops empty strings', () => {
      expect(sanitizeLabels(['', 'billing', ''])).toEqual(['billing']);
    });
  });

  describe('non-string entries are dropped, never coerced', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a number', 42],
      ['a boolean', true],
      ['an object', { name: 'billing' }],
      ['an array', ['billing']],
    ])('drops %s', (_label, value) => {
      expect(sanitizeLabels(['keep', value])).toEqual(['keep']);
    });

    it('never produces the [object Object] string', () => {
      // Coercing objects is exactly the bug that put raw Jira JSON into the task UI and blanked the
      // page with "Objects are not valid as a React child".
      const out = sanitizeLabels([{ value: 'x' }, { id: 1 }]);

      expect(out).toEqual([]);
      expect(out.join(' ')).not.toContain('[object Object]');
    });
  });

  describe('length caps', () => {
    it('truncates a label longer than 255 characters', () => {
      const long = 'a'.repeat(300);
      const [only] = sanitizeLabels([long]);

      expect(only).toHaveLength(255);
    });

    it('trims a trailing space created by the truncation', () => {
      // 254 'a's, a space, then more text: the slice lands on the gap.
      const awkward = `${'a'.repeat(254)} trailing words`;
      const [only] = sanitizeLabels([awkward]);

      expect(only).toBe('a'.repeat(254));
      expect(only.endsWith(' ')).toBe(false);
    });

    it('caps the array at 100 labels', () => {
      const many = Array.from({ length: 250 }, (_, i) => `label-${i}`);

      expect(sanitizeLabels(many)).toHaveLength(100);
    });

    it('keeps the FIRST 100 when capping, so the result is stable across re-runs', () => {
      const many = Array.from({ length: 250 }, (_, i) => `label-${i}`);
      const out = sanitizeLabels(many);

      expect(out[0]).toBe('label-0');
      expect(out[99]).toBe('label-99');
      expect(out).not.toContain('label-100');
    });
  });

  describe('non-array input', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a string', 'billing'],
      ['a number', 7],
      ['an object', { labels: ['billing'] }],
    ])('returns [] for %s', (_label, value) => {
      expect(sanitizeLabels(value)).toEqual([]);
    });

    it('returns [] for an empty array', () => {
      expect(sanitizeLabels([])).toEqual([]);
    });

    it('always returns an array, so callers can spread without a guard', () => {
      // issues.stage.ts spreads this conditionally; a null return would throw there.
      expect(Array.isArray(sanitizeLabels(undefined))).toBe(true);
      expect(Array.isArray(sanitizeLabels(['a']))).toBe(true);
    });
  });
});
