/**
 * Tests for resolution key normalization (pure — no DI, no jsdom).
 *
 * The one rule that matters: apostrophes are DELETED before separator runs are collapsed. XISUITE
 * seeds every org with `done`, `wont_do`, `duplicate`, `cannot_reproduce` (the
 * `seed_default_workflow_config()` trigger), and Jira ships "Done", "Won't Do", "Duplicate",
 * "Cannot Reproduce". Collapse-first would turn "Won't Do" into `won_t_do`, miss the seeded row,
 * and mint a duplicate resolution in every migrated org.
 */

import { normalizeResolutionKey } from './resolution-key.util';

describe('normalizeResolutionKey', () => {
  describe('the four live Jira resolutions map 1:1 onto the seeded XISUITE rows', () => {
    // Source list verified against http://167.233.94.130:8080/rest/api/2/resolution.
    // Target keys verified against the seed trigger and the live `resolutions` table.
    it.each([
      ['Done', 'done'],
      ["Won't Do", 'wont_do'],
      ['Duplicate', 'duplicate'],
      ['Cannot Reproduce', 'cannot_reproduce'],
    ])('maps %s to %s', (jiraName, expected) => {
      expect(normalizeResolutionKey(jiraName)).toBe(expected);
    });
  });

  describe('the German equivalents adopt the same seeded rows', () => {
    // Names taken verbatim from a customer's run log, where all four were CREATED as duplicates
    // because the alias table was English-only. That is the regression these cover.
    it.each([
      ['Fertig', 'done'],
      ['Erledigt', 'done'],
      ['Duplikat', 'duplicate'],
      ['Kann nicht reproduziert werden', 'cannot_reproduce'],
      ['Reicht nicht', 'wont_do'],
    ])('maps %s to %s', (jiraName, expected) => {
      expect(normalizeResolutionKey(jiraName)).toBe(expected);
    });
  });

  describe('apostrophe deletion precedes separator collapse (the regression this exists for)', () => {
    it("never produces won_t_do from Won't Do", () => {
      expect(normalizeResolutionKey("Won't Do")).not.toBe('won_t_do');
    });

    it('handles the typographic apostrophe Jira renders in some locales', () => {
      expect(normalizeResolutionKey('Won’t Do')).toBe('wont_do');
    });

    it('deletes backticks and double quotes the same way', () => {
      expect(normalizeResolutionKey('Won`t "Do"')).toBe('wont_do');
    });
  });

  describe('general normalization', () => {
    it('lowercases', () => {
      expect(normalizeResolutionKey('DONE')).toBe('done');
    });

    it('collapses runs of separators into one underscore', () => {
      expect(normalizeResolutionKey('Fixed -- upstream / vendor')).toBe(
        'fixed_upstream_vendor',
      );
    });

    it('trims leading and trailing separators', () => {
      expect(normalizeResolutionKey('  (Deferred)  ')).toBe('deferred');
    });

    it('strips accents rather than replacing the letter with an underscore', () => {
      // NFKD + combining-mark removal: "Résolu" is a real value on French instances. It stays
      // `resolu`, NOT an alias to `done`: per-language aliasing is exactly the kind of invented
      // correspondence the alias table refuses, so the accent handling is all that is asserted.
      expect(normalizeResolutionKey('Résolu')).toBe('resolu');
    });
  });

  describe('DTO contract: /^[a-z][a-z0-9_]*$/ with max length 50', () => {
    const LEGAL = /^[a-z][a-z0-9_]*$/;

    it.each([
      ['a digit-leading name', '2nd Level Duplicate'],
      ['a symbol-only name', '!!!'],
      ['an empty name', ''],
      [
        'a long name',
        'A very long resolution name that keeps going well past the fifty character limit',
      ],
      ['unicode', 'Não Reproduzível'],
    ])('always emits a DTO-legal key for %s', (_label, name) => {
      const key = normalizeResolutionKey(name);

      expect(key).toMatch(LEGAL);
      expect(key.length).toBeLessThanOrEqual(50);
    });

    it('prefixes a digit-leading result so the key starts with a letter', () => {
      expect(normalizeResolutionKey('2nd Level Duplicate')).toBe(
        'r_2nd_level_duplicate',
      );
    });

    it('never leaves a trailing underscore after the 50-char truncation', () => {
      const key = normalizeResolutionKey('x'.repeat(49) + ' trailing words');

      expect(key.endsWith('_')).toBe(false);
    });
  });

  describe('aliases for common Jira variants', () => {
    it.each([
      ["Won't Fix", 'wont_do'],
      ['Fixed', 'done'],
      ['Resolved', 'done'],
      ['Incomplete', 'cannot_reproduce'],
    ])('maps the classic Jira default %s to %s', (name, expected) => {
      expect(normalizeResolutionKey(name)).toBe(expected);
    });

    it('leaves a genuinely new resolution alone rather than force-fitting it', () => {
      // A wrong alias silently rewrites what the customer's data MEANS; an extra row merely
      // clutters a list. New names must survive as themselves.
      expect(normalizeResolutionKey('Deferred to Vendor')).toBe(
        'deferred_to_vendor',
      );
    });
  });
});
