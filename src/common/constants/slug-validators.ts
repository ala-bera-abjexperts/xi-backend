/**
 * Slug format invariants shared between organization create-time validation
 * and the public `/tenant-exists/:slug` lookup. Single source of truth on
 * the backend; the frontend mirrors this contract in
 * `src/lib/domain/slug-validators.ts`.
 *
 * Keep this file + the frontend mirror byte-identical (regex + length
 * limits). Drift here = format-error divergence between the onboarding form
 * and the API.
 */

/**
 * Accepts lowercase letters, digits, and hyphens. Must start AND end with
 * an alphanumeric character (no leading/trailing hyphens, no consecutive
 * hyphens). Single-character slugs are rejected by the SLUG_MIN_LEN check
 * below — not by this regex.
 */
export const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export const SLUG_MIN_LEN = 3;
export const SLUG_MAX_LEN = 40;

/**
 * Cheap format-only check. Pair with the reserved-slug check
 * (`isReservedSlug` from `./reserved-slugs.ts`) for the full validation.
 */
export function isValidSlugFormat(slug: string): boolean {
  if (slug.length < SLUG_MIN_LEN || slug.length > SLUG_MAX_LEN) return false;

  return SLUG_REGEX.test(slug);
}
