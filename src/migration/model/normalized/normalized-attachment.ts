/**
 * @fileoverview Source-agnostic attachment. Phase 7 STREAMS `downloadUrl` → Supabase
 * Storage (`task-attachments`, 10 MB limit) — never buffered in memory. Oversize files
 * are skipped with a lossy-report entry.
 */

export interface NormalizedAttachment {
  sourceId: string;
  filename: string;
  /**
   * Confluence Media Services file id (v2 `fileId` / v1 `extensions.fileId`).
   *
   * This is the ONLY key that links an attachment to the way ADF references it: an ADF `media` node
   * carries `attrs.id` = this UUID, never the filename. Without carrying it, every attachment-backed
   * image on a Confluence Cloud page is unresolvable and renders as a `[Image: <uuid>]` placeholder.
   */
  fileId?: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Authenticated download URL on the source system (may be a relative, pre-encoded path). */
  downloadUrl: string;
  authorSourceId?: string;
  /** Owning page/issue id — scopes the attachment (Confluence: `${pageSourceId}:${filename}` natural key). */
  pageSourceId?: string;
  /** ISO-8601. */
  created?: string;
}
