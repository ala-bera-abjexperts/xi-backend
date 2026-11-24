/** Private bucket created by migration 20260925120100_whiteboards.sql. */
export const WHITEBOARD_FILES_BUCKET = 'whiteboard-files';

/** Scene JSON cap. Below the 10mb body parser, so the client gets our 413, not the parser's. */
export const WHITEBOARD_MAX_SCENE_BYTES = 5 * 1024 * 1024;

export const WHITEBOARD_MAX_ELEMENTS = 50_000;

/** Excalidraw itself refuses images over 4 MiB; the bucket allows 5 MiB. */
export const WHITEBOARD_MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Must match the bucket's allowed_mime_types. */
export const WHITEBOARD_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/x-icon',
  'image/avif',
]);

/** Excalidraw FileId (SHA-1 hex by default). Also a storage path segment, so path-safe only. */
export const WHITEBOARD_FILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// ponytail: time-based tombstone GC; a live-collab relay would need tombstones kept per session instead.
export const WHITEBOARD_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const WHITEBOARD_LIST_LIMIT = 1000;
