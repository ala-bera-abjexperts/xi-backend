/**
 * @fileoverview Stable ASCII slugs for status/priority keys and issue-type level ids.
 * German display names are everywhere on the source (test box) — keys must be
 * transliterated ASCII, deterministic, and NEVER blank; the localized original is
 * preserved separately in `name`.
 */

const DE_MAP: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  Ä: 'ae',
  Ö: 'oe',
  Ü: 'ue',
};

/**
 * Transliterate German, strip diacritics, lowercase, collapse non-[a-z0-9] to '_'.
 * Falls back to `${fallbackPrefix}_${sourceId}` when the name yields a slug shorter
 * than 2 chars (e.g. purely non-latin names) so keys are always deterministic.
 */
export function asciiSlug(
  name: string,
  fallbackPrefix: string,
  sourceId: string,
): string {
  const transliterated = (name ?? '').replace(
    /[äöüßÄÖÜ]/g,
    (ch) => DE_MAP[ch] ?? ch,
  );
  const slug = transliterated
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (slug.length >= 2) return slug;

  const safeSource = String(sourceId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');

  return `${fallbackPrefix}_${safeSource}`;
}

/**
 * Conform a slug to the app's key shape `/^[a-z][a-z0-9_]*$/` (statuses, priorities,
 * categories): prefix when the slug starts with a non-letter, cap at 50 chars.
 */
export function asDbKey(slug: string, prefix: string): string {
  const key = /^[a-z]/.test(slug) ? slug : `${prefix}_${slug}`;

  return key.slice(0, 50);
}

/**
 * Deduplicate derived keys across one produce batch: the second occurrence of a
 * key gets a stable `_${sourceId}` suffix. Two German names can slug identically
 * ("Fertig" / "FERTIG!") and per-scope key uniqueness would 409 the second create.
 */
export function dedupeKeys<T>(
  items: T[],
  keyOf: (item: T) => string,
  sourceIdOf: (item: T) => string,
): Map<T, string> {
  const seen = new Set<string>();
  const result = new Map<T, string>();

  for (const item of items) {
    let key = keyOf(item);

    if (seen.has(key)) {
      const safeSource = sourceIdOf(item)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_');

      key = `${key.slice(0, 50 - safeSource.length - 1)}_${safeSource}`;
    }

    seen.add(key);
    result.set(item, key);
  }

  return result;
}
