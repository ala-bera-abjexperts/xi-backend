/**
 * @fileoverview Source-agnostic issue. Maps in Phase 6 to `TasksService.create`:
 * `assigned_to` (input field name), `custom_field_values` keyed by `field_key`,
 * `task_type_id` = mapped level id, status/priority DUAL-written (`status`+`status_id`,
 * `priority`+`priority_id`) — and NEVER set the trigger-owned `tasks.key`.
 * All references are sourceIds resolved through `migration_entity_map`.
 */

import type { RawBody } from './raw-body';
import type { NormalizedAttachment } from './normalized-attachment';
import type { NormalizedComment } from './normalized-comment';
import type { NormalizedLink } from './normalized-link';

export interface NormalizedIssue {
  /** Stable issue id (numeric as string) — crosswalk source_id. */
  sourceId: string;
  /** Human key (e.g. "KAN-12") — kept for natural_key + logging, never written to tasks.key. */
  key: string;
  summary: string;
  issueTypeSourceId: string;
  statusSourceId: string;
  prioritySourceId?: string;
  assigneeSourceId?: string;
  reporterSourceId?: string;
  /** Parent issue (sub-task or epic link) — gates child creation until the parent exists. */
  parentSourceId?: string;
  description?: RawBody;
  labels: string[];
  /** Raw custom field values keyed by field sourceId; typed conversion happens in Phase 6. */
  customFields: Record<string, unknown>;
  attachments: NormalizedAttachment[];
  comments: NormalizedComment[];
  /**
   * What the SOURCE says the comment count is. Jira caps the comments it inlines in a search
   * response, so `comments.length < commentsTotal` means the rest were NOT returned — the comments
   * stage asserts this and fails loudly rather than migrate a silently truncated subset.
   * `undefined` when the source did not report a total.
   */
  commentsTotal?: number;
  links: NormalizedLink[];
  /** ISO-8601 timestamps. */
  created?: string;
  updated?: string;
  dueDate?: string;
  resolutionDate?: string;
  /** Jira resolution id, when the issue is resolved. Crosswalks to `resolutions`. */
  resolutionSourceId?: string;
  /** Jira resolution display name — the adopt-by-name fallback when the id is unmapped. */
  resolutionName?: string;
  /** Sprint sourceIds this issue belongs to (Server: parsed from the greenhopper field). */
  sprintSourceIds?: string[];
}
