/**
 * @fileoverview The legacy `tasks.priority` bucket.
 *
 * Deliberately its own module with ZERO imports, mirroring `legacy-status.util`: keeping it pure and
 * dependency-free is what makes it directly testable without standing up `TasksService`.
 *
 * @module src/tasks/legacy-priority.util
 */

/**
 * The only values the legacy `tasks.priority` column accepts
 * (`tasks_priority_check`: lowest|low|medium|high|highest|critical).
 */
export const LEGACY_PRIORITY_KEYS: ReadonlySet<string> = new Set([
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
  'critical',
]);

/**
 * The positionally reachable ladder, ASCENDING urgency — the app's own seeded org ladder
 * (`lowest`@1 … `critical`@6, identical across every organization).
 *
 * `critical` is deliberately absent: it is the overflow step ABOVE `highest`, and a five-step source
 * scheme must not have its top step promoted past `highest` just because the target ladder happens
 * to have six steps. Only the alias table below can produce `critical`.
 */
const ORDINAL_LADDER = ['lowest', 'low', 'medium', 'high', 'highest'] as const;

/**
 * Scheme words whose urgency is SEMANTIC rather than positional — the one thing a position cannot
 * express (`Blocker` outranks everything regardless of where it sits in a list).
 *
 * One word per bucket per scheme (Jira's German default plus Jira's classic English scheme), so two
 * steps of the SAME ladder can never collapse onto one bucket. Do NOT grow this per locale: French,
 * Italian, Dutch, `Sev-1` and `P1` are handled by the ordinal rung, which is what makes this work for
 * schemes nobody has enumerated.
 */
const PRIORITY_ALIAS: Readonly<Record<string, string>> = {
  hoechste: 'highest',
  hoch: 'high',
  mittel: 'medium',
  niedrig: 'low',
  niedrigste: 'lowest',
  kritisch: 'critical',
  blocker: 'critical',
  major: 'high',
  minor: 'low',
  trivial: 'lowest',
};

/**
 * Collapse a priority key onto the legacy `tasks.priority` CHECK set.
 *
 * `task_priorities.key` is unconstrained — a space may define `hoechste`, `p1`, `sev_1`, … — but
 * `tasks.priority` is CHECK-constrained to six values. Writing a custom key straight through raises
 * 23514, which is why (verified against this database) all 37 issues of a German Jira import were
 * rejected, and why six `task_priorities` rows created through the UI have never been attachable to
 * any task. English Jira happens to slug onto the six legal words exactly, which is why this went
 * unnoticed.
 *
 * `priority_id` remains the source of truth; this column is the coarse legacy bucket kept beside it
 * for older read paths that FILTER and SORT on it — so the bucket must preserve order, not merely
 * avoid the constraint.
 *
 * Ladder, first rung that holds:
 *   a) the key is already legal       → itself (every existing row takes this rung)
 *   b) a known scheme word            → its semantic bucket
 *   c) its position in its own ladder → proportional bucket (language independent)
 *   d) nothing known                  → 'medium' (total function; can never 23514)
 *
 * INERT for every pre-existing caller: a key already in the legacy set returns unchanged, and every
 * priority currently attached to a task has such a key. Only the path that previously raised 23514
 * now produces a row.
 *
 * ponytail: (b) runs before (c) on purpose — position is the better signal only when the ladder is
 * genuinely ordered, and migrated ladders provably are not always. Drop an alias entry if a customer
 * scheme ever needs two of these words separated.
 *
 * @param key     `task_priorities.key` (unconstrained).
 * @param ordinal 0-based position within its OWN ladder (peers sharing its `space_id`), ascending
 *                `sort_order` = increasing urgency. `null` when the key resolves to no row.
 * @param total   Size of that ladder. `null` alongside a null ordinal.
 * @returns a value guaranteed to satisfy `tasks_priority_check`.
 */
export function toLegacyPriorityText(
  key: string,
  ordinal: number | null,
  total: number | null,
): string {
  if (LEGACY_PRIORITY_KEYS.has(key)) return key;

  const alias = PRIORITY_ALIAS[key];

  if (alias) return alias;

  if (
    ordinal !== null &&
    total !== null &&
    total > 1 &&
    ordinal >= 0 &&
    ordinal < total
  ) {
    // Proportional, order-preserving, monotone non-decreasing. A five-step source scheme maps
    // exactly onto lowest|low|medium|high|highest, so Jira's default scheme round-trips.
    const span = ORDINAL_LADDER.length - 1;

    return ORDINAL_LADDER[Math.round((ordinal * span) / (total - 1))];
  }

  // No usable ladder (an unconfigured key, or a one-entry ladder): the safe middle, never a guess at
  // an extreme. `priority_id` still carries the truth.
  return 'medium';
}
