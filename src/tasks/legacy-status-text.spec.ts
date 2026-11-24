/**
 * Unit tests for the legacy `tasks.status` bucket (pure — no DI, no DB).
 *
 * Context: `tasks.status` is NOT NULL with
 * `tasks_status_check CHECK (open|in_progress|review|done|closed|blocked)`, while
 * `task_statuses.key` is unconstrained. Before this funnel existed, creating a task whose status
 * row had a custom key (`todo`, `won`, `in_review`, …) wrote that key straight into the constrained
 * column and raised 23514 — which is why, in this database, not one of ~17k tasks uses a custom
 * status despite such status rows existing. `status_id` stays the source of truth; this column is
 * the legacy bucket kept beside it.
 *
 * The first describe block is the safety contract: for every status that exists on a task today,
 * the funnel is a no-op.
 */

import { toLegacyStatusText } from './legacy-status.util';

const LEGACY = ['open', 'in_progress', 'review', 'done', 'closed', 'blocked'];

describe('toLegacyStatusText', () => {
  describe('INERT for every pre-existing caller (the no-regression contract)', () => {
    it('returns a legacy key unchanged, whatever the category or completion says', () => {
      for (const key of LEGACY) {
        expect(toLegacyStatusText(key, false, null)).toBe(key);
        expect(toLegacyStatusText(key, true, 'done')).toBe(key);
        // Even a contradictory category must not rewrite an already-legal key: existing rows are
        // the source of truth and must round-trip byte-identically.
        expect(toLegacyStatusText(key, false, 'cancelled')).toBe(key);
      }
    });
  });

  describe('custom keys collapse onto the CHECK set (previously a 23514)', () => {
    it('buckets by category — the meaningful distinction, not a flatten-to-open', () => {
      expect(toLegacyStatusText('to_do', false, 'todo')).toBe('open');
      expect(toLegacyStatusText('in_review', false, 'in_progress')).toBe(
        'in_progress',
      );
      expect(toLegacyStatusText('won', true, 'done')).toBe('done');
      expect(toLegacyStatusText('lost', true, 'cancelled')).toBe('closed');
    });

    it('falls back to completion when category_id is null (the column is nullable)', () => {
      expect(toLegacyStatusText('warte_auf_kunden', false, null)).toBe('open');
      expect(toLegacyStatusText('erledigt', true, null)).toBe('done');
    });

    it('falls back to completion when the category key is unrecognised', () => {
      expect(toLegacyStatusText('weird', true, 'not_a_real_category')).toBe(
        'done',
      );
      expect(toLegacyStatusText('weird', false, 'not_a_real_category')).toBe(
        'open',
      );
    });

    it('never trusts the localized display name — German keys bucket by category alone', () => {
      // The test instance is German; names/keys are localized and mutable.
      expect(toLegacyStatusText('warte_auf_genehmigung', false, 'todo')).toBe(
        'open',
      );
      expect(toLegacyStatusText('s2nd_level', false, 'in_progress')).toBe(
        'in_progress',
      );
    });
  });

  describe('ALWAYS produces a value the CHECK constraint accepts', () => {
    it('holds for every key/category/completion combination we can construct', () => {
      const keys = [
        ...LEGACY,
        'to_do',
        'todo',
        'won',
        'lost',
        'in_review',
        'test1',
        's3rd_level',
        'warte_auf_kunden',
        '',
        'ÜBERPRÜFUNG',
      ];
      const categories = [
        null,
        'todo',
        'in_progress',
        'done',
        'cancelled',
        'bogus',
      ];

      for (const key of keys) {
        for (const cat of categories) {
          for (const done of [true, false, undefined]) {
            expect(LEGACY).toContain(toLegacyStatusText(key, done, cat));
          }
        }
      }
    });

    it('the real Jira migration case: "To Do" → key `to_do` → open (was 23514 on all 9,826)', () => {
      expect(toLegacyStatusText('to_do', false, 'todo')).toBe('open');
      expect(LEGACY).toContain(toLegacyStatusText('to_do', false, 'todo'));
    });
  });
});
