/** Appended wherever text is cut, so a truncation is never silent. */
export const TRUNCATION_MARKER = '… (truncated)';

/**
 * Cuts a string to `max`, appending the marker.
 *
 * Slicing UTF-16 can split a surrogate pair and leave a lone half, which renders as a replacement
 * character — step back one unit when that would happen. The result may therefore be `max + marker`
 * long; use clampToMaxLength when the total has to fit a hard limit.
 */
export function truncateForMessage(text: string, max: number): string {
  if (text.length <= max) return text;

  const code = text.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;

  return `${text.slice(0, end)}${TRUNCATION_MARKER}`;
}

/**
 * Cuts a string so the RESULT, marker included, is at most `maximum` characters — the shape a
 * provider's own schema limit needs.
 */
export function clampToMaxLength(text: string, maximum: number): string {
  if (text.length <= maximum) return text;

  // No room for the marker; a bare cut is all that fits.
  if (maximum <= TRUNCATION_MARKER.length)
    return text.slice(0, Math.max(maximum, 0));

  return truncateForMessage(text, maximum - TRUNCATION_MARKER.length);
}
