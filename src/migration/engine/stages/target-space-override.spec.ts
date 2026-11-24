import { targetOverridesMappedSpace } from './stage-helpers';

/**
 * XE-T549 — regression guard for a silent data-misplacement bug found during E2E.
 *
 * `migration_entity_map` is unique on (organization_id, source_connection_id, entity_type,
 * source_id). The TARGET is not part of that key, so a source migrated once through a connection
 * keeps its original space mapping forever. Both space stages short-circuited on that mapping
 * BEFORE consulting `job.target_space_id`, so selecting a target space was silently ignored for any
 * previously-migrated source.
 *
 * Observed live before the fix: a Jira KAN run explicitly targeted at a fresh space wrote all 55
 * issues into the "KANBAN (2)" space an earlier run had created — and the run still reported
 * `succeeded`. The operator gets no signal at all: the job card even reads "Target space linked".
 */
describe('targetOverridesMappedSpace (XE-T549)', () => {
  const SPACE_A = '11111111-1111-4111-8111-111111111111';
  const SPACE_B = '22222222-2222-4222-8222-222222222222';

  it('overrides when the job targets a different space than the crosswalk maps', () => {
    // The bug: without this the stage returns `skipped: space already mapped` and every
    // downstream stage resolves SPACE_A, ignoring the operator's choice of SPACE_B.
    expect(targetOverridesMappedSpace(SPACE_B, SPACE_A)).toBe(true);
  });

  it('does NOT override when the job target already equals the mapping', () => {
    // Idempotent re-run: this must stay a no-op, or every re-run would redo the space stage.
    expect(targetOverridesMappedSpace(SPACE_A, SPACE_A)).toBe(false);
  });

  it('does not override when the job names no target space', () => {
    // Auto-create migrations keep their existing mapping — unchanged pre-XE-T549 behaviour.
    expect(targetOverridesMappedSpace(null, SPACE_A)).toBe(false);
    expect(targetOverridesMappedSpace(undefined, SPACE_A)).toBe(false);
    expect(targetOverridesMappedSpace('', SPACE_A)).toBe(false);
  });

  it('does not override when there is no existing mapping to override', () => {
    // First run against this source: the normal adopt path handles it, not this guard.
    expect(targetOverridesMappedSpace(SPACE_B, null)).toBe(false);
    expect(targetOverridesMappedSpace(SPACE_B, undefined)).toBe(false);
  });

  it('treats a planned dry-run placeholder target as a different target', () => {
    // Dry runs record `planned:<key>` rather than a uuid; a real target must still win.
    expect(targetOverridesMappedSpace(SPACE_B, 'planned:KAN')).toBe(true);
  });
});
