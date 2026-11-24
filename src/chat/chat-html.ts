/**
 * @fileoverview Plain-text derivation for chat messages. The server derives
 * `body_text` (search, previews, length rule) from the SANITISED html itself;
 * text sent by the client is never trusted.
 * @module src/chat/chat-html
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

/**
 * Converts sanitised message html to searchable plain text: block ends and
 * `<br>` become line breaks, tags are removed, common entities decoded and
 * whitespace collapsed (line breaks kept).
 *
 * @param html - already sanitised html
 * @returns plain text, trimmed; '' for empty input
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return '';

  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(amp|lt|gt|quot|nbsp|#39|#x27);/g,
      (entity) => ENTITIES[entity] ?? entity,
    )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
