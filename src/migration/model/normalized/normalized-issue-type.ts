/**
 * @fileoverview Source-agnostic issue type. Maps in Phase 4 to a
 * `task_hierarchy_configurations.config.levels[]` entry:
 * `level.id` (TEXT) → `tasks.task_type_id`, `level.name` (localized names are fine),
 * `level.sort_order` derived from `hierarchyHint`.
 */

export interface NormalizedIssueType {
  /** Stable Jira issue type id (e.g. "10001") — crosswalk source_id, NOT the name. */
  sourceId: string;
  /** Localized display name (e.g. "Aufgabe" on the German test box). */
  name: string;
  description?: string;
  iconUrl?: string;
  /** True for sub-task types → drives parent_task_id gating in the issues stage. */
  isSubtask: boolean;
  /** Hierarchy hint from the source; the mapper derives sort_order from it. */
  hierarchyHint?: 'epic' | 'standard' | 'subtask';
}
