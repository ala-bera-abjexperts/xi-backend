/**
 * @fileoverview The legacy `tasks.status` bucket.
 *
 * Deliberately its own module with ZERO imports: `tasks.service.ts` transitively pulls in
 * `sanitizeRichText` → jsdom, whose ESM dependency (`@exodus/bytes`) will not transform under this
 * repo's Jest config — so any spec importing the service cannot load. Keeping this pure and
 * dependency-free is what makes it directly testable.
 *
 * @module src/tasks/legacy-status.util
 */

/**
 * The only values the legacy `tasks.status` column accepts
 * (`tasks_status_check`: open|in_progress|review|done|closed|blocked).
 */
export const LEGACY_STATUS_KEYS: ReadonlySet<string> = new Set([
  'open',
  'in_progress',
  'review',
  'done',
  'closed',
  'blocked',
]);

/** `status_categories.key` → the legacy bucket that best represents it. */
const CATEGORY_TO_LEGACY_STATUS: Readonly<Record<string, string>> = {
  todo: 'open',
  in_progress: 'in_progress',
  done: 'done',
  cancelled: 'closed',
};

/**
 * Collapse a status key onto the legacy `tasks.status` CHECK set.
 *
 * `task_statuses.key` is deliberately unconstrained — a space may define `todo`, `in_review`,
 * `warte_auf_genehmigung`, … — but `tasks.status` is NOT NULL with a six-value CHECK. Writing a
 * custom key straight through raises 23514, which is why (verified against this database) not one
 * of ~17k tasks uses a custom status even though such status rows exist: they are unusable.
 *
 * `status_id` remains the source of truth; this column is the legacy bucket kept alongside it for
 * older read paths. Bucketing by the status's CATEGORY preserves the meaningful distinction
 * (todo / in-progress / done / cancelled) rather than flattening everything to 'open'.
 *
 * INERT for every pre-existing caller: a key already in the legacy set returns unchanged, and every
 * status currently attached to a task has such a key — so behaviour is byte-identical for all
 * existing data. Only the path that previously raised 23514 now produces a row.
 *
 * @param key         `task_statuses.key` (unconstrained).
 * @param isCompleted `task_statuses.is_completed` — the fallback signal when no category resolves.
 * @param categoryKey `status_categories.key` via `task_statuses.category_id` (nullable column).
 * @returns a value guaranteed to satisfy `tasks_status_check`.
 */
export function toLegacyStatusText(
  key: string,
  isCompleted: boolean | undefined,
  categoryKey: string | null,
): string {
  if (LEGACY_STATUS_KEYS.has(key)) return key;

  const byCategory = categoryKey
    ? CATEGORY_TO_LEGACY_STATUS[categoryKey]
    : undefined;

  if (byCategory) return byCategory;

  // No usable category (category_id is nullable): completion is the only other signal we trust —
  // never the localized display name, which is German and mutable on the source instances.
  return isCompleted ? 'done' : 'open';
}
