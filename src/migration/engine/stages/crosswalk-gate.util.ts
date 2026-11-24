/**
 * @fileoverview Shared crosswalk-gate predicate: "is this crosswalk row usable for writing?"
 *
 * Pure and dependency-free ON PURPOSE — the stages that use it import NestJS services and
 * (transitively) `sanitizeRichText` → jsdom, which will not transform under this repo's Jest config.
 * Keeping the predicate here makes the rule directly testable.
 *
 * The rule this encodes cost a real bug: `placeholder` IS resolved. The users stage records an
 * unmatched Jira user as a linked placeholder with `status: 'placeholder'` (users.stage.ts:153) —
 * NOT `'mapped'` — and treats both as resolved itself (users.stage.ts:98). Placeholders exist
 * precisely to carry attribution for users with no XISUITE account. A gate that accepts only
 * `'mapped'` therefore silently drops the assignee/author of every entity whose owner did not
 * email-match, even though a real target row exists. Silent attribution loss, no error.
 *
 * @module src/migration/engine/stages/crosswalk-gate.util
 */

/** Crosswalk statuses that carry a REAL, usable target id. */
const RESOLVED_STATUSES: ReadonlySet<string> = new Set([
  'mapped',
  'placeholder',
]);

/**
 * Whether a crosswalk row's status means "a target exists, write against it".
 *
 * @param status  `migration_entity_map.status`.
 * @param dryRun  In a dry run a `planned` row gates open: it has no real target, but the caller is
 *                not writing either — it only needs to know the dependency would have been there.
 */
export function isResolvedStatus(
  status: string | null | undefined,
  dryRun: boolean,
): boolean {
  if (!status) return false;
  if (RESOLVED_STATUSES.has(status)) return true;

  return dryRun && status === 'planned';
}
