/**
 * @fileoverview Priority resolution for support requests.
 *
 * `support_requests.priority` is a CHECK-constrained varchar limited to
 * `low|medium|high|critical`, exactly like the legacy `tasks.priority` bucket. The
 * real, org/space-configurable priority lives in `task_priorities` and is carried on
 * `support_requests.priority_id` (mirroring `tasks.priority_id`).
 *
 * Deliberately its own module with ZERO imports so the mapping is unit-testable
 * without standing up `HelpCenterService` (same rationale as `tasks/legacy-priority.util`).
 *
 * @module src/help-center/priority.util
 */

/** The four values `support_requests_priority_check` accepts. */
export const SUPPORT_REQUEST_PRIORITY_KEYS: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
  'critical',
]);

/**
 * The bucket ladder, ascending urgency. A support request keeps only four buckets, so a
 * finer org ladder (`lowest`…`highest`) is collapsed proportionally onto these four —
 * order-preserving, which is what the list filter and the dashboard badges rely on.
 */
const BUCKET_LADDER = ['low', 'medium', 'high', 'critical'] as const;

/** Scheme words whose urgency is SEMANTIC rather than positional. */
const PRIORITY_ALIAS: Readonly<Record<string, string>> = {
  lowest: 'low',
  niedrigste: 'low',
  niedrig: 'low',
  minor: 'low',
  trivial: 'low',
  mittel: 'medium',
  major: 'high',
  hoch: 'high',
  highest: 'critical',
  hoechste: 'critical',
  kritisch: 'critical',
  blocker: 'critical',
};

/**
 * Collapse a dynamic priority key onto the legacy `support_requests.priority` CHECK set.
 *
 * The bucket must PRESERVE ORDER (not merely avoid the constraint) because the list
 * filter and the dashboard badges still read this column. First rung that holds:
 *   a) the key is already legal        → itself
 *   b) a known scheme word             → its semantic bucket
 *   c) its position in its own ladder  → proportional bucket (language independent)
 *   d) nothing known                   → 'medium' (total function; never 23514)
 *
 * `priority_id` remains the source of truth; this is the coarse bucket kept beside it.
 *
 * @param key     `task_priorities.key` (unconstrained).
 * @param ordinal 0-based position within its OWN ladder (peers sharing its `space_id`).
 * @param total   Size of that ladder.
 */
export function toSupportRequestPriorityBucket(
  key: string,
  ordinal: number | null = null,
  total: number | null = null,
): string {
  if (SUPPORT_REQUEST_PRIORITY_KEYS.has(key)) return key;

  const alias = PRIORITY_ALIAS[key];

  if (alias) return alias;

  if (
    ordinal !== null &&
    total !== null &&
    total > 1 &&
    ordinal >= 0 &&
    ordinal < total
  ) {
    const span = BUCKET_LADDER.length - 1;

    return BUCKET_LADDER[Math.round((ordinal * span) / (total - 1))];
  }

  return 'medium';
}

/** True when a stored bucket refers to the same step as a dynamic key. */
export function priorityBucketMatchesKey(
  bucket: string,
  key: string,
): boolean {
  return toSupportRequestPriorityBucket(key) === bucket;
}

/** One row of an org/space priority ladder, as read for resolution. */
export interface PriorityLadderRow {
  id: string;
  key: string;
  space_id: string | null;
}

/**
 * A priority's bucket comes from its OWN ladder — the rows sharing its `space_id`, not the
 * merged list. A space may carry its own ladder alongside the org's seeded one, and
 * interleaving the two would make "position" meaningless (same rule as
 * `TasksService.legacyPriorityOf`).
 */
export function priorityBucketForLadderRow(
  ladder: PriorityLadderRow[],
  row: PriorityLadderRow,
): string {
  const peers = ladder.filter((r) => r.space_id === row.space_id);

  return toSupportRequestPriorityBucket(
    row.key,
    peers.indexOf(row),
    peers.length,
  );
}

/**
 * Resolve a `priority_id` the caller supplied against the ladder visible for the ticket's
 * space. Returns `null` when the id is not in that ladder — the caller decides whether that
 * is a 400 or a silent fallback.
 */
export function resolvePriorityIdFromLadder(
  ladder: PriorityLadderRow[],
  priorityId: string,
): { key: string; bucket: string } | null {
  const row = ladder.find((r) => r.id === priorityId);

  if (!row) return null;

  return { key: row.key, bucket: priorityBucketForLadderRow(ladder, row) };
}

/**
 * Resolve a priority KEY (e.g. `high`, `p1`) to its id + legacy bucket, or null.
 * A space-scoped row wins over an org-wide row with the same key.
 */
export function resolvePriorityKeyFromLadder(
  ladder: PriorityLadderRow[],
  key: string,
): { id: string; key: string; bucket: string } | null {
  const row =
    ladder.find((r) => r.key === key && r.space_id) ??
    ladder.find((r) => r.key === key);

  if (!row) return null;

  return { id: row.id, key: row.key, bucket: priorityBucketForLadderRow(ladder, row) };
}
