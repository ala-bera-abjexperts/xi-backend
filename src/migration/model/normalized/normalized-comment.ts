/**
 * @fileoverview Source-agnostic comment. Maps in Phase 7 to `task_comments` — author
 * resolved through the user crosswalk (placeholder when unmatched).
 */

import type { RawBody } from './raw-body';

export interface NormalizedComment {
  sourceId: string;
  authorSourceId?: string;
  body: RawBody;
  /** ISO-8601. */
  created?: string;
  updated?: string;
  /** Owning page (Confluence) — Jira comments carry their issue on the seed item instead. */
  pageSourceId?: string;
  /** Confluence resolves comment threads; a resolved comment is still migrated, just marked. */
  resolved?: boolean;
  /**
   * Set for a Confluence INLINE comment: the text it was anchored to, plus Confluence's own marker
   * id. The selection is what makes re-anchoring possible at all — the target stores it on the
   * comment's `anchor`, because the exact character offsets do not survive an ADF → TipTap
   * transform (block wrapping, promoted inline nodes, dropped placeholders all shift them).
   */
  inline?: { selection: string; markerRef?: string };
}
