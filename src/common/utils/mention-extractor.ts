/**
 * Extracts user IDs from HTML content that contains user mention spans.
 * Mention spans are stored as: <span data-user-mention data-user-id="uuid" ...>
 * Handles both plain HTML (data-user-id="uuid") and EditorJS JSON-encoded HTML
 * where quotes are escaped as \" (data-user-id=\"uuid\").
 * Returns a deduplicated list of user IDs.
 */
export function extractUserMentionIds(
  html: string | null | undefined,
): string[] {
  if (!html) return [];

  // Normalise JSON-escaped quotes so the regex works for both HTML and
  // EditorJS-serialised JSON where attribute quotes appear as \".
  const normalised = html.replace(/\\"/g, '"');
  const matches = [...normalised.matchAll(/data-user-id="([^"]+)"/g)];

  return [...new Set(matches.map((m) => m[1]).filter(Boolean))];
}
