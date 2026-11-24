/**
 * @fileoverview Source-agnostic Confluence revision DTOs: one page revision, one attachment version.
 *
 * Confluence numbers revisions from 1 and never renumbers them, so `version` is the stable
 * per-entity key the crosswalk is built on (`${sourceId}:v${version}`). The target mirrors those
 * numbers 1:1 rather than inventing its own, so a migrated page's history reads the same as the
 * source's.
 *
 * `body` is deliberately OPTIONAL and separate from the listing: Confluence returns revision
 * metadata cheaply but each historical body is its own request, so the stage lists first and
 * fetches bodies one revision at a time.
 *
 * @module src/migration/model/normalized/normalized-page-version
 * @author Prince Jadiya
 */

export interface NormalizedPageVersion {
  /** Source page id this revision belongs to. */
  pageSourceId: string;
  /** Confluence version number, 1-based. Mirrored verbatim onto `wiki_page_versions.version`. */
  version: number;
  /** Title AT THIS REVISION where the source reports it; Confluence renames are version events. */
  title?: string;
  /** Stable source id of the editor; resolved through the user crosswalk. */
  authorSourceId?: string;
  /** ISO-8601 instant of the edit. */
  created?: string;
  /** Confluence "version comment" — the editor's change message. */
  message?: string;
  /** Confluence `minorEdit`. Absent when the edition does not report it. */
  minorEdit?: boolean;
  /** True only for the revision that is currently live on the source. */
  current?: boolean;
}

export interface NormalizedAttachmentVersion {
  /** Source attachment id this version belongs to. */
  attachmentSourceId: string;
  /** Confluence version number, 1-based. */
  version: number;
  /** Filename AT THIS VERSION; Confluence permits a rename between versions. */
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  authorSourceId?: string;
  /** ISO-8601. */
  created?: string;
  /** Confluence version comment for this upload. */
  message?: string;
  /**
   * Authenticated download URL for THIS EXACT version's bytes. Pinned to the connection origin by
   * the SSRF guard in `getAttachmentBytes`, exactly like the current-version download URL.
   */
  downloadUrl: string;
}
