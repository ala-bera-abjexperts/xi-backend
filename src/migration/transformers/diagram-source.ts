/**
 * @fileoverview Reads a draw.io diagram's mxfile XML out of the SOURCE page's attachments.
 *
 * The drawio macro stores no drawing of its own — only a name. Verified against the customer's live
 * space, a page carrying `diagramName: "Architecture.drawio"` has three sibling attachments:
 *
 *   "Architecture.drawio"      application/vnd.jgraph.mxfile   ← the drawing (3–6 KB)
 *   "Architecture.drawio.png"  image/png                       ← a rendered preview
 *   "~Architecture.drawio.tmp" application/vnd.jgraph.mxfile   ← an editor temp file, must be ignored
 *
 * Only the exact-title match is used. This deliberately bypasses the wiki attachment crosswalk:
 * Wiki 2.0's upload allow-list rejects the mxfile mime, so `page_attachments` skips that file — but
 * the native `drawioDiagram` node stores the XML inline and needs no attachment row at all.
 *
 * Every render path must use this (first write AND the attachment/relink re-renders), or a re-render
 * would silently degrade an already-resolved diagram back to a placeholder.
 */

import type { NormalizedAttachment } from '../model/normalized';

/** `MAX_DRAWIO_XML` in `tiptap-sanitizer.ts` — a larger payload is rejected on write. */
const MAX_DIAGRAM_BYTES = 2 * 1024 * 1024;

/** The subset of the Confluence adapter this needs, kept structural to avoid an import cycle. */
interface DiagramSource {
  getPageAttachments(pageSourceId: string): Promise<NormalizedAttachment[]>;
  getAttachmentBytes(
    downloadUrl: string,
    maxBytes?: number,
  ): Promise<{ data: Buffer; contentType: string | null; size: number }>;
}

/**
 * Build the `fetchDiagram` resolver for one page. The attachment list is fetched at most once, and
 * only when the page actually contains a diagram macro (the caller checks first), so pages without
 * one cost nothing.
 */
export function diagramFetcher(
  adapter: DiagramSource,
  pageSourceId: string,
): (name: string) => Promise<string | null> {
  let listing: Promise<NormalizedAttachment[]> | null = null;

  return async (name: string) => {
    listing ??= adapter.getPageAttachments(pageSourceId);

    const attachment = (await listing).find((a) => a.filename === name);

    if (!attachment) return null;
    if ((attachment.sizeBytes ?? 0) > MAX_DIAGRAM_BYTES) return null;

    const bytes = await adapter.getAttachmentBytes(
      attachment.downloadUrl,
      MAX_DIAGRAM_BYTES,
    );

    return bytes.data.toString('utf8');
  };
}
