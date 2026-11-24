/**
 * @fileoverview Resolves the display character for an ADF `emoji` node.
 *
 * Atlassian ships `emoji.attrs.text` ALREADY ESCAPED. After a correct `JSON.parse` of
 * `body.atlas_doc_format.value`, the attribute holds the twelve literal characters
 * `🗓` (codepoints 0x5c 0x75 0x44 …) rather than the single character 🗓. Written straight
 * into a page, that renders as the escape text — which is exactly the reported defect.
 *
 * The escaping is INCONSISTENT within the same field, measured across a 350-page space:
 *
 *   id=1f5d3  :calendar_spiral:      text="🗓"   escaped   (non-BMP)
 *   id=1f945  :goal:                 text="🥅"   escaped   (non-BMP)
 *   id=2705   :white_check_mark:     text="✅"              already a real character (BMP)
 *   id=1f5c3  :card_box:             text="🗃️"             already real, non-BMP, plus U+FE0F
 *   id=…-plus :plus:                 text=":plus:"         Atlassian custom, no unicode equivalent
 *   id=null   :memo:                 text="📝"             `id` can be absent entirely
 *
 * So decoding must be IDEMPOTENT — it has to fix the escaped values without touching the ones that
 * already arrived correct. Note `1f5c3` carries a variation selector its `id` does not, which is why
 * a decoded `text` is preferred over deriving the character from `id`.
 */

/** `\uXXXX`, the form Atlassian leaves behind. */
const UNICODE_ESCAPE = /\\u([0-9a-fA-F]{4})/g;

/**
 * A surrogate half with no partner. Postgres cannot store an unpaired surrogate in a `text` or
 * `jsonb` value — it rejects the write — so producing one would turn a cosmetic defect into a failed
 * page import.
 */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Decode `\uXXXX` escapes, or return the input unchanged when that is not safe.
 *
 * Consecutive escapes for a surrogate pair decode into adjacent UTF-16 code units, which JavaScript
 * strings represent as the single astral character — so no explicit pair arithmetic is needed. What
 * IS needed is the guard: if the result contains an unpaired surrogate the original is returned, so
 * a malformed attribute degrades to visible-but-storable text instead of an aborted write.
 */
export function decodeUnicodeEscapes(value: string): string {
  // Fast path, and the property that makes this idempotent: a value with no escape is returned
  // byte-for-byte, so an already-correct emoji can never be corrupted by a second pass.
  if (!value.includes('\\u')) return value;

  const decoded = value.replace(UNICODE_ESCAPE, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

  return LONE_SURROGATE.test(decoded) ? value : decoded;
}

/**
 * Build the character from an emoji `id`, which is hyphen-separated hex code points
 * (`1f5d3`, or `1f468-200d-1f469` for a ZWJ sequence).
 *
 * Returns `null` for anything that is not purely hex — Atlassian's custom emoji use ids like
 * `atlassian-plus`, and splitting those on `-` yields parts that must NOT be coerced into code
 * points or the node renders as garbage.
 */
export function emojiFromId(id: string | null | undefined): string | null {
  if (!id) return null;

  const parts = id.split('-');

  if (!parts.every((part) => /^[0-9a-fA-F]{1,6}$/.test(part))) return null;

  const points = parts.map((part) => Number.parseInt(part, 16));

  // Reject out-of-range values and surrogate halves: `String.fromCodePoint` throws on both, and a
  // throw here would abort the whole page transform.
  if (
    points.some(
      (point) =>
        !Number.isInteger(point) ||
        point < 1 ||
        point > 0x10ffff ||
        (point >= 0xd800 && point <= 0xdfff),
    )
  ) {
    return null;
  }

  try {
    return String.fromCodePoint(...points);
  } catch {
    return null;
  }
}

/** The `attrs` shape this helper reads; every field is optional in real ADF. */
export interface AdfEmojiAttrs {
  text?: unknown;
  id?: unknown;
  shortName?: unknown;
}

/**
 * The character to render for an ADF emoji node.
 *
 * Order is deliberate: a decoded `text` wins because it can carry more than the `id` implies (the
 * variation selector on `:card_box:`); `id` is the fallback when `text` is missing; `shortName` is
 * last so a custom emoji at least renders as `:plus:` rather than vanishing.
 */
export function resolveEmojiText(attrs: AdfEmojiAttrs | undefined): string {
  const rawText = typeof attrs?.text === 'string' ? attrs.text : '';
  const decoded = decodeUnicodeEscapes(rawText);

  if (decoded) return decoded;

  const fromId = emojiFromId(typeof attrs?.id === 'string' ? attrs.id : null);

  if (fromId) return fromId;

  return typeof attrs?.shortName === 'string' ? attrs.shortName : '';
}
