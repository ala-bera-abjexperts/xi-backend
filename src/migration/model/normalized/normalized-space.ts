/**
 * @fileoverview Source-agnostic Confluence space (scaffold — read path lands in Phase 9).
 */

export interface NormalizedSpace {
  sourceId: string;
  key: string;
  name: string;
  description?: string;
  homepageSourceId?: string;
}
