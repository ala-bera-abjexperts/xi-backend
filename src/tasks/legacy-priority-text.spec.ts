/**
 * Unit tests for the legacy `tasks.priority` bucket (pure — no DI, no DB).
 *
 * Context: `tasks.priority` is `varchar(20)` with
 * `tasks_priority_check CHECK (lowest|low|medium|high|highest|critical)`, while
 * `task_priorities.key` is unconstrained. Before this funnel existed, creating a task whose priority
 * row had a custom key wrote that key straight into the constrained column and raised 23514. A
 * German Jira import created priorities keyed `hoechste/hoch/mittel/niedrig/niedrigste` and every one
 * of its 37 issue INSERTs was rejected; the same happens today when a user creates a custom priority
 * in the UI (this database already holds `p1,p2,p3,p4,test1,efdsdfdsfdsfdfd`, all with zero
 * referencing tasks because they have never been attachable). `priority_id` stays the source of
 * truth; this column is the legacy bucket kept beside it.
 *
 * English Jira's five default priority names slug onto the six legal words exactly
 * (`Highest→highest` … `Lowest→lowest`), which is why the missing funnel went unnoticed for so long.
 *
 * The first describe block is the safety contract: for every priority that exists on a task today,
 * the funnel is a no-op.
 */

import { toLegacyPriorityText } from './legacy-priority.util';

const LEGACY = ['lowest', 'low', 'medium', 'high', 'highest', 'critical'];

describe('toLegacyPriorityText', () => {
  describe('INERT for every pre-existing caller (the no-regression contract)', () => {
    it('returns a legacy key unchanged, whatever the ladder says', () => {
      for (const key of LEGACY) {
        expect(toLegacyPriorityText(key, null, null)).toBe(key);
        expect(toLegacyPriorityText(key, 0, 6)).toBe(key);
        // A contradictory position must not rewrite an already-legal key.
        expect(toLegacyPriorityText(key, 5, 6)).toBe(key);
      }
    });

    it('the seeded org ladder round-trips position for position', () => {
      // lowest@1 … critical@6 — ascending sort_order = increasing urgency, in every organization.
      LEGACY.forEach((key, i) =>
        expect(toLegacyPriorityText(key, i, LEGACY.length)).toBe(key),
      );
    });
  });

  describe('the German ladder that migrated 0 of 37 issues', () => {
    // Ascending urgency, as `priority.stage` now writes it (Jira's rank inverted).
    const DE = ['niedrigste', 'niedrig', 'mittel', 'hoch', 'hoechste'];

    it('maps the five German steps onto the five legacy steps, in order', () => {
      expect(DE.map((k, i) => toLegacyPriorityText(k, i, DE.length))).toEqual([
        'lowest',
        'low',
        'medium',
        'high',
        'highest',
      ]);
    });

    it('agrees with itself when the ladder is unknown — the alias rung alone suffices', () => {
      expect(DE.map((k) => toLegacyPriorityText(k, null, null))).toEqual([
        'lowest',
        'low',
        'medium',
        'high',
        'highest',
      ]);
    });

    it('only the alias rung reaches `critical` — position never promotes past `highest`', () => {
      expect(toLegacyPriorityText('kritisch', 0, 5)).toBe('critical');
      expect(toLegacyPriorityText('blocker', 4, 5)).toBe('critical');
      expect(toLegacyPriorityText('irgendwas', 4, 5)).toBe('highest');
    });

    it('an un-aliased German word still buckets by position', () => {
      // "Schwerwiegend" (Severe), 4th of 5 ascending — deliberately not in the alias table.
      expect(toLegacyPriorityText('schwerwiegend', 3, 5)).toBe('high');
    });
  });

  describe('schemes nobody enumerated (the ordinal rung)', () => {
    it('French', () => {
      const FR = ['tres_basse', 'basse', 'moyenne', 'elevee', 'tres_elevee'];

      expect(FR.map((k, i) => toLegacyPriorityText(k, i, FR.length))).toEqual([
        'lowest',
        'low',
        'medium',
        'high',
        'highest',
      ]);
    });

    it('P-labels — note the ladder is listed most-urgent LAST', () => {
      const P = ['p4', 'p3', 'p2', 'p1'];

      expect(P.map((k, i) => toLegacyPriorityText(k, i, P.length))).toEqual([
        'lowest',
        'low',
        'high',
        'highest',
      ]);
    });

    it('the rows already dead in this database resolve instead of raising 23514', () => {
      for (const key of ['p1', 'p2', 'p3', 'p4', 'test1', 'efdsdfdsfdsfdfd']) {
        expect(LEGACY).toContain(toLegacyPriorityText(key, null, null));
      }
    });

    it('is monotone non-decreasing for any ladder size', () => {
      for (const total of [2, 3, 4, 6, 7, 12]) {
        const out = Array.from({ length: total }, (_, i) =>
          LEGACY.indexOf(toLegacyPriorityText(`custom_${i}`, i, total)),
        );

        for (let i = 1; i < out.length; i++) {
          expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
        }
      }
    });

    it('falls back to `medium` when there is no usable ladder', () => {
      expect(toLegacyPriorityText('efdsdfdsfdsfdfd', null, null)).toBe(
        'medium',
      );
      expect(toLegacyPriorityText('solo', 0, 1)).toBe('medium');
    });
  });

  describe('ALWAYS produces a value the CHECK constraint accepts', () => {
    it('holds for every key/ordinal/total combination we can construct', () => {
      const keys = [
        ...LEGACY,
        'hoechste',
        'hoch',
        'mittel',
        'niedrig',
        'niedrigste',
        'kritisch',
        'blocker',
        'schwerwiegend',
        'p1',
        'sev_1',
        'test1',
        '',
        'HÖCHSTE',
      ];

      for (const key of keys) {
        for (const total of [null, 0, 1, 2, 5, 6, 20]) {
          for (const ordinal of [null, -1, 0, 1, 4, 19, 999]) {
            expect(LEGACY).toContain(toLegacyPriorityText(key, ordinal, total));
          }
        }
      }
    });
  });
});
