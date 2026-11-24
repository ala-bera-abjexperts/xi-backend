/**
 * @fileoverview Source-agnostic priority. Maps in Phase 4 to a `task_priorities` row;
 * the stable slug key comes from `asciiSlug` (never the localized display name).
 */

export interface NormalizedPriority {
  /** Stable Jira priority id (e.g. "3") — crosswalk source_id. */
  sourceId: string;
  /** Localized display name (German ok) → task_priorities.name. */
  name: string;
  description?: string;
  /** Hex color from Jira statusColor when parseable. */
  colorHex?: string;
  iconUrl?: string;
  /** Lower rank = higher urgency (source list order); drives default + P6 bucketing. */
  rank: number;
}
