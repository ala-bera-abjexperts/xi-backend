/**
 * @fileoverview Source-agnostic project (Jira project / future Confluence space parent).
 * Maps in Phase 4 to `SpacesService.createSpace` — note `spaces.key` is ≤ 8 chars, so
 * longer keys are truncated + collision-suffixed there (preview warns when key.length > 8).
 */

export interface NormalizedProject {
  /** Stable source id (Jira numeric project id as string) — crosswalk `source_id`. */
  sourceId: string;
  /** Project key, e.g. "KAN", "SDP". */
  key: string;
  name: string;
  description?: string;
  /** Stable id of the project lead (Server: username/key; Cloud: accountId). */
  leadUserSourceId?: string;
  /** 'software' | 'business' | 'service_desk' (free-form — source-reported). */
  projectTypeKey?: string;
  avatarUrl?: string;
  archived?: boolean;
}
