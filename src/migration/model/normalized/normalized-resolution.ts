/**
 * @fileoverview Source-agnostic resolution ("Done", "Won't Do", ...). Maps to `resolutions`.
 *
 * Jira resolutions are INSTANCE-WIDE — one global list shared by every project — and XISUITE's
 * `resolutions` table is org-scoped with no `space_id`, so this is a genuinely org-level entity on
 * both sides. The stage adopts by normalized key against the four rows every organization is seeded
 * with (`seed_default_workflow_config()`); creating is the exception, not the rule.
 */

export interface NormalizedResolution {
  /** Stable Jira resolution id (numeric as string). */
  sourceId: string;
  name: string;
  description?: string;
  /** Array position in Jira's own configured order; `/rest/api/2/resolution` has no rank field. */
  sortOrder: number;
}
