/**
 * @fileoverview Shared MIME-type gates for file uploads.
 * @module common/upload-mime
 * @author Prince Jadiya
 *
 * Replaces the nine hand-maintained image allow-lists that used to live one-per-feature. Each of
 * those enumerated a handful of MIME strings, so every format that arrived after they were written
 * — AVIF, HEIC, JPEG XL — was rejected as "not allowed" even though nothing about the format was
 * unsafe. Enumerating raster formats is a losing game; the family prefix is the real rule.
 *
 * ATTACHMENTS ARE NOT GATED HERE AT ALL. Document/attachment endpoints deliberately accept any
 * type: those buckets are served through signed URLs that force `Content-Disposition: attachment`,
 * so the browser downloads rather than renders and the content type carries no execution risk. The
 * size cap, not a type list, is the abuse control there.
 */

import { MIMEType } from 'node:util';

import { BadRequestException } from '@nestjs/common';

/** The one MIME type that can execute script when a browser renders it inline as an image. */
const SVG_MIME = 'image/svg+xml';

/**
 * True for any image type — `image/png`, `image/avif`, `image/heic`, and anything else the
 * `image/` family grows in future.
 */
export function isImageMime(mime: string | undefined | null): boolean {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/');
}

/** True for any video type. Used by Site Studio, which accepts images and video in one endpoint. */
export function isVideoMime(mime: string | undefined | null): boolean {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('video/');
}

/**
 * Content types a browser will execute script from when it renders them inline.
 *
 * Only relevant to buckets served through `getPublicUrl` — those hand the browser a plain URL with
 * no `Content-Disposition`, so the stored content type alone decides render-vs-download.
 */
const ACTIVE_CONTENT_MIMES = new Set([
  SVG_MIME,
  'text/html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'image/svg',
]);

/** Return a concrete HTTP media type; never forward source header syntax to storage. */
export function normalizeContentType(mime: string | undefined | null): string {
  // eslint-disable-next-line no-control-regex
  if (!mime || /[\x00-\x1f\x7f]/.test(mime)) return 'application/octet-stream';

  try {
    const parsed = new MIMEType(mime.trim());

    return parsed.type.includes('*') || parsed.subtype.includes('*')
      ? 'application/octet-stream'
      : parsed.essence;
  } catch {
    return 'application/octet-stream';
  }
}

const OCTET_STREAM = 'application/octet-stream';

/**
 * Canonical MIME types for the document extensions the migration carries.
 * Source systems sometimes report the wrong member of the Office family — a
 * real-world Confluence Server served every `.docx` as the `.dotx` template
 * type — and `application/octet-stream` says nothing at all. The filename
 * extension is ground truth.
 */
const EXTENSION_MIME_MAP: Record<string, string> = {
  doc: 'application/msword',
  dot: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  csv: 'text/csv',
};

const KNOWN_DOCUMENT_MIMES = new Set(Object.values(EXTENSION_MIME_MAP));

/** The Office family where wrong-member MIME mix-ups actually occur. */
const OFFICE_MIME_EXTENSIONS = new Set([
  'doc',
  'dot',
  'docx',
  'dotx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
]);

/** True when the filename carries an extension this module knows a MIME for. */
export function hasKnownDocumentExtension(
  filename: string | undefined | null,
): boolean {
  const match = /\.[a-z0-9]+$/i.exec((filename ?? '').trim());

  return (
    match !== null && match[0].slice(1).toLowerCase() in EXTENSION_MIME_MAP
  );
}

/**
 * True when the filename is in the Office family — the only formats where
 * wrong-member MIME mix-ups have actually been observed. Repair candidacy is
 * deliberately narrower than the reconcile map so repair runs do not churn
 * through every PDF and CSV.
 */
export function hasOfficeDocumentExtension(
  filename: string | undefined | null,
): boolean {
  const match = /\.[a-z0-9]+$/i.exec((filename ?? '').trim());

  return (
    match !== null &&
    OFFICE_MIME_EXTENSIONS.has(match[0].slice(1).toLowerCase())
  );
}

/**
 * Reconcile a source-reported content type against the filename extension.
 *
 * Overrides the reported type only when it is useless (octet-stream) or is
 * another member of the known document family (the template-vs-document
 * mix-up); a concrete but foreign type is left untouched so genuinely exotic
 * source annotations survive. Returns the normalized type either way.
 */
export function reconcileMimeWithExtension(
  filename: string | undefined | null,
  mime: string | undefined | null,
): string {
  const normalized = normalizeContentType(mime);
  const match = /\.[a-z0-9]+$/i.exec((filename ?? '').trim());
  const canonical = match
    ? EXTENSION_MIME_MAP[match[0].slice(1).toLowerCase()]
    : undefined;

  if (!canonical || normalized === canonical) return normalized;
  if (normalized === OCTET_STREAM || KNOWN_DOCUMENT_MIMES.has(normalized)) {
    return canonical;
  }

  return normalized;
}

/**
 * Content type to STORE a public-bucket attachment under.
 *
 * Attachment endpoints accept every file type — nothing is rejected here. But on the buckets that
 * are served via `getPublicUrl`, storing an `.html` or `.svg` under its true type means the browser
 * executes it on view, which turns "attach a file" into stored XSS. Downgrading just those types to
 * `application/octet-stream` keeps the upload working and the bytes byte-identical while forcing
 * the browser to download rather than render.
 *
 * Do NOT use this on buckets served through signed URLs — those already pass
 * `{ download: fileName }`, which sets `Content-Disposition: attachment` and settles the question.
 */
export function storageContentType(mime: string | undefined | null): string {
  const normalized = normalizeContentType(mime);

  return ACTIVE_CONTENT_MIMES.has(normalized)
    ? 'application/octet-stream'
    : normalized;
}

/**
 * Reject anything that is not an image.
 *
 * `allowSvg` is set PER CALL SITE to preserve each endpoint's existing posture rather than to
 * apply one blanket rule. SVG is a script-execution vector when rendered inline: the buckets
 * behind org logos and wiki images are served via `getPublicUrl`, so an uploaded SVG is fetched
 * and rendered by the browser as-is. Endpoints that already blocked it (space icons, per-entity
 * attachments) keep blocking it; endpoints that already accepted it keep accepting it. Changing
 * either direction is a separate decision from widening the raster formats, and is not made here.
 *
 * @throws BadRequestException when the type is not an image, or is SVG where SVG is not permitted.
 */
export function assertImageMime(
  mime: string | undefined | null,
  opts: { allowSvg: boolean },
): void {
  if (!isImageMime(mime)) {
    throw new BadRequestException(
      `File type "${mime ?? 'unknown'}" is not allowed. Only image files are accepted.`,
    );
  }

  if (!opts.allowSvg && mime?.toLowerCase() === SVG_MIME) {
    throw new BadRequestException('SVG files are not allowed for this upload');
  }
}

/**
 * Reject anything that is neither image nor video.
 *
 * @throws BadRequestException when the type is neither, or is SVG where SVG is not permitted.
 */
export function assertImageOrVideoMime(
  mime: string | undefined | null,
  opts: { allowSvg: boolean },
): void {
  if (!isImageMime(mime) && !isVideoMime(mime)) {
    throw new BadRequestException(
      `File type "${mime ?? 'unknown'}" is not allowed. Only image and video files are accepted.`,
    );
  }

  if (!opts.allowSvg && mime?.toLowerCase() === SVG_MIME) {
    throw new BadRequestException('SVG files are not allowed for this upload');
  }
}
