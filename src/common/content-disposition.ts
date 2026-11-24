/**
 * @fileoverview RFC 5987 Content-Disposition builder for downloads with user-named files.
 * @module common/content-disposition
 *
 * A raw non-ASCII filename in `res.setHeader('Content-Disposition', ...)` is a live bug twice
 * over: characters outside Latin-1 (CJK, Polish ł, Czech ř, emoji) make Node throw
 * ERR_INVALID_CHAR → 500, and Latin-1 accents (ä ö ü é) go out as single raw bytes that browsers
 * render as mojibake. The dual-form header — ASCII fallback plus `filename*=UTF-8''…` — is the
 * standard fix; every modern browser prefers the encoded form, so the user saves the real name.
 *
 * Lifted verbatim from `file-explorer-node.controller.ts` (also copied in
 * `file-explorer-public.controller.ts` and `backup-archives.controller.ts` — consolidating those
 * onto this helper is later cleanup; they work as-is).
 */

/** `attachment; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded original>` */
export function contentDispositionAttachment(fileName: string): string {
  const asciiFileName = fileName
    .replace(/[\r\n]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/[^\x20-\x7e]/g, '_');
  const encodedFileName = encodeURIComponent(fileName);

  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`;
}
