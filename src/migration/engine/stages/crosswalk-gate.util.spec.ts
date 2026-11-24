/**
 * Regression tests for the crosswalk gate (pure — no DI, no jsdom).
 *
 * These exist because of a REAL bug found in review: `issues.stage.ts`'s gate accepted only
 * `'mapped'`, so placeholder users — the entire mechanism for attributing work to people who have no
 * XISUITE account — were treated as unresolved and their assignees silently dropped. No error, no
 * failed item, just missing attribution. Exactly this project's signature failure mode.
 */

import { isResolvedStatus } from './crosswalk-gate.util';

describe('crosswalk gate — isResolvedStatus', () => {
  describe('placeholder is RESOLVED (the regression)', () => {
    it('accepts placeholder in a live run — it carries a real target id', () => {
      // users.stage.ts:153 writes status 'placeholder' for an unmatched user, and creates a real
      // linked user row. Rejecting it drops the assignee of every non-email-matching issue.
      expect(isResolvedStatus('placeholder', false)).toBe(true);
    });

    it('accepts placeholder in a dry run too', () => {
      expect(isResolvedStatus('placeholder', true)).toBe(true);
    });

    it('agrees with the users stage, which treats mapped and placeholder alike', () => {
      // users.stage.ts:98 — `if (existing.status === 'mapped' || existing.status === 'placeholder')`
      for (const s of ['mapped', 'placeholder']) {
        expect(isResolvedStatus(s, false)).toBe(true);
      }
    });
  });

  describe('mapped is resolved', () => {
    it('accepts mapped in both modes', () => {
      expect(isResolvedStatus('mapped', false)).toBe(true);
      expect(isResolvedStatus('mapped', true)).toBe(true);
    });
  });

  describe('planned gates open ONLY in a dry run', () => {
    it('accepts planned in a dry run — no write happens, the dependency just has to exist', () => {
      expect(isResolvedStatus('planned', true)).toBe(true);
    });

    it('REJECTS planned in a live run — there is no real target id to write against', () => {
      // A `planned` row's target_id is a marker like `planned:foo`, not a real id. Writing an FK to
      // it would produce a dangling reference — the one thing the crosswalk exists to prevent.
      expect(isResolvedStatus('planned', false)).toBe(false);
    });
  });

  describe('never resolves a non-target', () => {
    it('rejects skipped and failed in both modes', () => {
      for (const s of ['skipped', 'failed']) {
        expect(isResolvedStatus(s, false)).toBe(false);
        expect(isResolvedStatus(s, true)).toBe(false);
      }
    });

    it('rejects null/undefined/empty (a missing row is not a resolved one)', () => {
      for (const s of [null, undefined, '']) {
        expect(isResolvedStatus(s, false)).toBe(false);
        expect(isResolvedStatus(s, true)).toBe(false);
      }
    });

    it('rejects an unknown status rather than assuming it is safe', () => {
      expect(isResolvedStatus('something_new', false)).toBe(false);
      expect(isResolvedStatus('something_new', true)).toBe(false);
    });
  });
});
