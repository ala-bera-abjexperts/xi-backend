/**
 * @fileoverview Source-agnostic issue history (Jira "changelog").
 *
 * One entry is a single edit event by one person at one instant, carrying one or more field
 * changes — Jira groups them exactly that way (`changelog.histories[].items[]`), and XISUITE's
 * `task_history` stores one row per changed field, so an entry fans out to N rows sharing an
 * author and timestamp.
 */

export interface NormalizedHistoryItem {
  /** Source field name: `status`, `assignee`, `priority`, `Sprint`, a custom field label, ... */
  field: string;
  /** `jira` for system fields, `custom` for custom fields. */
  fieldType?: string;
  /** Raw id before/after (often an internal id). */
  from?: string | null;
  to?: string | null;
  /** Human-readable before/after — what a timeline should display. */
  fromString?: string | null;
  toString?: string | null;
}

export interface NormalizedHistoryEntry {
  sourceId: string;
  /** Stable source id of whoever made the change; resolved through the user crosswalk. */
  authorSourceId?: string;
  /** ISO-8601 instant of the change. */
  created?: string;
  items: NormalizedHistoryItem[];
}
