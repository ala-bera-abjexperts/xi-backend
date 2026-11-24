/**
 * Builds the PostgREST `or` filter for wiki page search: case-insensitive
 * substring match across BOTH the page title and its plain-text projection.
 *
 * `content_text` is the server-maintained plain text of `content` (the same
 * projection the generated `search_vector` indexes), so matching it covers body
 * text for every supported content format without parsing Editor.js/TipTap JSON
 * here.
 *
 * Characters that are structural to a PostgREST `or` expression — and SQL LIKE
 * wildcards — are stripped: a comma or parenthesis would otherwise break out of
 * the filter, and `%`/`*` would let a caller force a wildcard scan.
 * Returns null when nothing searchable remains.
 */
export function buildWikiSearchFilter(search: string): string | null {
  const safe = search.replace(/[,.()"'\\%*]/g, '').trim();

  if (!safe) return null;

  return `title.ilike.%${safe}%,content_text.ilike.%${safe}%`;
}
