/**
 * @fileoverview Turns a user's filename into a storage-object key that is safe to store.
 * @module common/upload-filename
 * @author Prince Jadiya
 *
 * WHY THIS EXISTS
 * Supabase Storage keys must be ASCII. A German customer attached
 * "Änderungsantrag Produktion.zip" to a task; the key builder interpolated the
 * filename raw, storage rejected the key, and the upload failed. Confirmed
 * against production: of 865 stored objects, ZERO contain a non-ASCII byte, and
 * every attachment whose upload failed had an umlaut in its name.
 *
 * That is not an edge case for this product. Every German, French, Spanish,
 * Nordic and CJK customer hits it the first time they attach a file named in
 * their own language.
 *
 * WHY IT IS SHARED
 * Nine call sites had each hand-rolled `replace(/[^a-zA-Z0-9._-]/g, '_')` and a
 * few had none at all, which is exactly how the ones with none were missed.
 * This mirrors what `upload-mime.ts` did for the nine image allow-lists.
 *
 * THE STORED NAME IS NOT THE DISPLAYED NAME. The original filename is kept
 * verbatim in the database (`file_attachments.file_name`) and is what the user
 * sees and downloads as. This value is only ever the object key, so it is free
 * to be lossy.
 */

/**
 * Longest base name we put in a key. Storage keys have length limits and the
 * key already carries several UUIDs, so a very long name is the part that has
 * to give. Generous enough that real filenames survive intact.
 */
const MAX_BASE_LENGTH = 100;

/** Longest extension we keep. Real extensions are short; anything longer is not one. */
const MAX_EXTENSION_LENGTH = 16;

/** Used when a name sanitises away to nothing, e.g. a filename that is entirely CJK. */
const FALLBACK_BASE = 'file';

/**
 * Strips accents by decomposing to base letter + combining mark and dropping
 * the marks, so `Ä` becomes `A` and `é` becomes `e` rather than both becoming
 * `_`. Keeps the name recognisable to a human reading the storage bucket.
 *
 * Characters with no decomposition (`ß`, `ø`, `æ`, CJK) are left for the
 * allow-list below to replace.
 */
function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Everything outside the safe set becomes `_`, then runs of `_` collapse to one. */
function toSafeAscii(value: string): string {
  return stripAccents(value)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_');
}

/**
 * A storage-object key segment derived from `originalName`.
 *
 * Guarantees, each of which is asserted in the spec:
 *  - ASCII only, so Supabase Storage accepts the key;
 *  - never empty, so the key never ends in a bare `/`;
 *  - no `/` or `\`, and no leading dot, so it cannot escape its prefix or
 *    create a hidden object;
 *  - the extension is preserved where there is one, so content sniffing and
 *    "save as" behave.
 */
export function storageSafeFileName(
  originalName: string | null | undefined,
): string {
  const raw = (originalName ?? '').trim();

  // Defend against a full path arriving instead of a name. Both separators,
  // because the client may be on Windows.
  const nameOnly = raw.split(/[/\\]/).pop() ?? '';

  const lastDot = nameOnly.lastIndexOf('.');

  // A leading dot is not an extension separator, it marks a hidden file, so
  // `.gitignore` keeps its name as the base rather than becoming `.gitignore`
  // with an empty base.
  const hasExtension = lastDot > 0 && lastDot < nameOnly.length - 1;

  const rawBase = hasExtension ? nameOnly.slice(0, lastDot) : nameOnly;
  const rawExtension = hasExtension ? nameOnly.slice(lastDot + 1) : '';

  const base = toSafeAscii(rawBase)
    // A name that is only dots or dashes is not a name; it is also how `..`
    // would try to climb the prefix.
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, MAX_BASE_LENGTH);

  const extension = toSafeAscii(rawExtension)
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, MAX_EXTENSION_LENGTH);

  const safeBase = base.length > 0 ? base : FALLBACK_BASE;

  return extension.length > 0 ? `${safeBase}.${extension}` : safeBase;
}
