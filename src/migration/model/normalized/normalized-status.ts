/**
 * @fileoverview Source-agnostic status. Bucketing is ALWAYS by `statusCategory`
 * (new | indeterminate | done) — never by the localized name (German on the test box).
 * Statuses without a category (old Jira reports key "undefined") bucket to 'indeterminate'
 * and the extraction logs a lossy warning.
 */

export type NormalizedStatusCategory = 'new' | 'indeterminate' | 'done';

export interface NormalizedStatus {
  /** Stable Jira status id (e.g. "10000") — crosswalk source_id. */
  sourceId: string;
  /** Localized display name (e.g. "In Arbeit"). */
  name: string;
  statusCategory: NormalizedStatusCategory;
  /** Source color hint (e.g. "blue-gray", "green"). */
  colorName?: string;
  /** Issue type sourceIds this status applies to (from /project/{k}/statuses). */
  issueTypeSourceIds?: string[];
}
