import { sanitizeRichText } from '../common/utils/sanitize-rich-text';

/**
 * A calendar or entry description as it is stored. Rich text from the editor is cleaned with the same
 * allow-list task descriptions use; plain text is left exactly as typed, because it is never rendered as
 * HTML and escaping it would show `&amp;` where the person wrote `&`.
 */
export function cleanDescription(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;

  return value.trimStart().startsWith('<') ? sanitizeRichText(value) : value;
}
