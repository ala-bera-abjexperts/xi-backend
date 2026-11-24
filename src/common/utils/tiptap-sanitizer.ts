/**
 * @fileoverview Strict, reject-on-violation TipTap document validator used by
 * the Wiki 2.0 write paths (REST update, collab snapshot save, restore).
 *
 * Philosophy: the stored TipTap JSON is rendered client-side by a TipTap
 * schema, so the danger surface is (a) URL-bearing attrs (link/image/youtube/
 * button/fileAttachment), (b) the `rawHtml` escape hatch, and (c) unbounded
 * documents (size / depth / node-count DoS). Unknown node or mark types are
 * REJECTED (never silently dropped) so the client learns its schema drifted;
 * unknown ATTRIBUTES on known nodes are silently stripped (attrs are additive
 * noise from editor plugins). The one opacity exception is `legacyBlock.data`
 * (a fenced Editor.js payload) and the widget `config` objects, which are
 * depth-checked and JSON-cloned but not schema-validated.
 *
 * Colour attributes are the deliberate exception to "reject on violation": they
 * are purely cosmetic, so they are COERCED to canonical hex and DROPPED when
 * unparseable (see `normalizeCssColor`). A table cell tint must never be able to
 * destroy a user's document — and it did: CSSOM serializes
 * `element.style.backgroundColor` as `rgb(…)`, so copy/pasting a coloured table
 * inside the editor produced a value the old strict hex check rejected, 400ing
 * every save of that page.
 * @module src/common/utils/tiptap-sanitizer
 */

import { BadRequestException } from '@nestjs/common';
import { sanitizeRichText } from './sanitize-rich-text';

/** Hard cap on the serialized document size (5 MB). */
const MAX_SERIALIZED_BYTES = 5 * 1024 * 1024;

/** Hard cap on nesting depth. */
const MAX_DEPTH = 64;

/** Hard cap on total node count. */
const MAX_NODES = 50_000;

/** Max drawio XML payload (2 MB). */
const MAX_DRAWIO_XML = 2 * 1024 * 1024;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const CODE_LANGUAGE_RE = /^[\w+#-]{0,30}$/;

/** The validated result: the canonical doc object plus its JSON string. */
export interface ValidatedTipTapDoc {
  doc: Record<string, unknown>;
  json: string;
}

type AttrValidator = (value: unknown, path: string) => unknown;

interface NodeSpec {
  /** attr name → validator (returns the canonical value or throws). */
  attrs?: Record<string, AttrValidator>;
  /** Whether the node may carry a `content` array of child nodes. */
  content?: boolean;
  /** Whether the node is a text node (carries `text` + `marks`). */
  text?: boolean;
}

/**
 * A document that failed schema validation.
 *
 * Distinct from a plain `BadRequestException` so a caller can tell "this input
 * is structurally invalid and will NEVER become valid on retry" apart from a
 * genuinely transient 400 — `wiki.service.ts` wraps Postgres errors (including
 * the concurrent slug-uniqueness race) in a `BadRequestException` too, so the
 * class alone was not enough to distinguish them. The migration queue uses this
 * to classify the failure `permanent` instead of retrying it to exhaustion.
 */
export class TipTapValidationError extends BadRequestException {}

function reject(path: string, reason: string): never {
  throw new TipTapValidationError(
    `Invalid TipTap document at ${path}: ${reason}`,
  );
}

function optional(validator: AttrValidator): AttrValidator {
  return (value, path) =>
    value === undefined || value === null ? undefined : validator(value, path);
}

function str(max: number): AttrValidator {
  return (value, path) => {
    if (typeof value !== 'string') reject(path, 'expected a string');
    if (value.length > max) reject(path, `string exceeds ${max} chars`);

    return value;
  };
}

function bool(): AttrValidator {
  return (value, path) => {
    if (typeof value !== 'boolean') reject(path, 'expected a boolean');

    return value;
  };
}

function int(min: number, max: number): AttrValidator {
  return (value, path) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      reject(path, 'expected an integer');
    }
    if (value < min || value > max) {
      reject(path, `integer out of range [${min}, ${max}]`);
    }

    return value;
  };
}

/**
 * A CSS length the editor actually produces for images.
 *
 * `ResizableImage` types this attr as `string | number | null`, feeds it
 * straight into a style (`width: width || 'auto'`), and its drag handle writes
 * a PERCENTAGE STRING — `updateAttributes({ width: `${percent}%` })`. The
 * Confluence importer does the same on purpose (see the note above
 * `cir-to-tiptap.ts`'s media mapping). Accepting only integers therefore
 * rejected the editor's own output: resizing an image made every later save of
 * that page fail with `expected an integer`, and because a rejected attr fails
 * the WHOLE document, the page could not be saved again at all.
 *
 * Both forms stay bounded — an integer is pixels, a string is 1–100%.
 */
function cssLength(minPx: number, maxPx: number): AttrValidator {
  return (value, path) => {
    if (typeof value === 'number') {
      if (!Number.isInteger(value))
        reject(path, 'expected an integer or a percentage');
      if (value < minPx || value > maxPx) {
        reject(path, `integer out of range [${minPx}, ${maxPx}]`);
      }

      return value;
    }

    if (typeof value === 'string') {
      const match = /^(\d{1,3})%$/.exec(value.trim());

      if (!match)
        reject(path, 'expected an integer or a percentage like "50%"');

      const percent = Number(match[1]);

      if (percent < 1 || percent > 100)
        reject(path, 'percentage out of range [1, 100]');

      return `${percent}%`;
    }

    return reject(path, 'expected an integer or a percentage');
  };
}

function intArray(min: number, max: number): AttrValidator {
  return (value, path) => {
    if (!Array.isArray(value)) reject(path, 'expected an int array');

    return (value as unknown[]).map((v, i) =>
      int(min, max)(v, `${path}[${i}]`),
    );
  };
}

function strArray(maxLen: number, maxItems = 200): AttrValidator {
  return (value, path) => {
    if (!Array.isArray(value)) reject(path, 'expected a string array');
    if ((value as unknown[]).length > maxItems) {
      reject(path, `array exceeds ${maxItems} items`);
    }

    return (value as unknown[]).map((v, i) => str(maxLen)(v, `${path}[${i}]`));
  };
}

function stringRecord(maxValueLength: number, maxItems = 200): AttrValidator {
  return (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      reject(path, 'expected a string record');
    }

    const entries = Object.entries(value as Record<string, unknown>);

    if (entries.length > maxItems)
      reject(path, `object exceeds ${maxItems} entries`);

    const out: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;

    for (const [key, item] of entries) {
      if (key.length > 200) reject(`${path}.${key}`, 'key exceeds 200 chars');
      out[key] = str(maxValueLength)(item, `${path}.${key}`) as string;
    }

    return out;
  };
}

function contentPropertyRows(): AttrValidator {
  return (value, path) => {
    if (!Array.isArray(value)) reject(path, 'expected a property row array');
    if (value.length > 100) reject(path, 'array exceeds 100 items');

    return value.map((row, index) => {
      const rowPath = `${path}[${index}]`;

      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        reject(rowPath, 'expected a property row');
      }

      const record = row as Record<string, unknown>;

      return {
        key: str(500)(record.key, `${rowPath}.key`) as string,
        value: str(5000)(record.value, `${rowPath}.value`) as string,
      };
    });
  };
}

function uuid(): AttrValidator {
  return (value, path) => {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      reject(path, 'expected a UUID');
    }

    return value.toLowerCase();
  };
}

// ───────────────────────── CSS colour coercion ─────────────────────────
// Colour attributes are COSMETIC, so they are COERCED to canonical hex and
// silently DROPPED when unparseable — never rejected. Losing a cell tint is
// recoverable; losing the user's document because of one is not. (Structural
// violations — unknown node types, wrong content shape — still reject.)
//
// Coercion is not a nicety: the value is usually NOT hex by the time it gets
// here. CSSOM re-serializes `element.style.backgroundColor` as
// `rgb(254, 226, 226)`, so an in-editor copy/paste of a table painted with the
// editor's own `#fee2e2` swatch used to arrive as rgb() and 400 the whole save.
//
// Mirrors `risk-management-app/src/utils/css-color.ts` (`toHexColor`) — the two
// accept-sets must stay in lockstep.

/** `rgb(…)`/`rgba(…)` with no nesting — CSSOM never emits nested colour funcs. */
const RGB_FN_RE = /^rgba?\(([^()]*)\)$/i;

/** Longest colour token worth scanning at all; real values are <32 chars. */
const MAX_COLOR_LENGTH = 128;

/**
 * CSS Color Module Level 4 named colours, packed as `name:rrggbb` to keep the
 * table compact; expanded once at module load.
 */
const NAMED_COLORS_PACKED = [
  'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4',
  'azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000',
  'blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a',
  'burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e',
  'coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c',
  'cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b',
  'darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b',
  'darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00',
  'darkorchid:9932cc darkred:8b0000 darksalmon:e9967a',
  'darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f',
  'darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3',
  'deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969',
  'dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0',
  'forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff',
  'gold:ffd700 goldenrod:daa520 gray:808080 green:008000',
  'greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4',
  'indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c',
  'lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00',
  'lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080',
  'lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3',
  'lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1',
  'lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa',
  'lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de',
  'lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6',
  'magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa',
  'mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db',
  'mediumseagreen:3cb371 mediumslateblue:7b68ee',
  'mediumspringgreen:00fa9a mediumturquoise:48d1cc',
  'mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa',
  'mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080',
  'oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500',
  'orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98',
  'paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5',
  'peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd',
  'powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000',
  'rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072',
  'sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d',
  'silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090',
  'slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4',
  'tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0',
  'violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5',
  'yellow:ffff00 yellowgreen:9acd32',
].join(' ');

/**
 * Prototype-free lookup table. `Object.fromEntries` alone inherits from
 * `Object.prototype`, so `NAMED_COLORS['__proto__']` returned the prototype
 * OBJECT and `NAMED_COLORS['constructor']` returned the `Object` FUNCTION —
 * both of which then flowed straight out of `normalizeCssColor`, violating its
 * `string | undefined` contract and writing a non-string into the stored
 * `backgroundColor` attr for a document containing
 * `<td data-bg-color="__proto__">`. `Object.create(null)` has no prototype, so
 * every non-colour key misses.
 *
 * `risk-management-app/src/utils/css-color.ts` builds its mirrored table the
 * same way — keep the two constructions identical.
 */
const NAMED_COLORS: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  Object.fromEntries(
    NAMED_COLORS_PACKED.split(' ').map((entry): [string, string] => {
      const [name, hex] = entry.split(':');

      return [name, `#${hex}`];
    }),
  ),
);

/**
 * `currentColor` and the CSS-wide keywords resolve only against a live cascade,
 * so there is no honest hex for them. Dropped rather than guessed: an absent
 * background renders the theme default, whereas mapping `currentColor` to the
 * text colour would paint cells near-black.
 */
const UNRESOLVABLE_COLOR_KEYWORDS = new Set([
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'none',
]);

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toColorByte(value: number): string {
  return clampNumber(Math.round(value), 0, 255).toString(16).padStart(2, '0');
}

/** One r/g/b component: `255`, `99.5` or `40%`. */
function parseColorChannel(token: string): number | null {
  const percent = token.endsWith('%');
  const raw = Number(percent ? token.slice(0, -1) : token);

  if (!Number.isFinite(raw)) return null;

  return clampNumber(percent ? (raw / 100) * 255 : raw, 0, 255);
}

/** Alpha component: `0.5` or `50%`. */
function parseColorAlpha(token: string): number | null {
  const percent = token.endsWith('%');
  const raw = Number(percent ? token.slice(0, -1) : token);

  if (!Number.isFinite(raw)) return null;

  return clampNumber(percent ? raw / 100 : raw, 0, 1);
}

/**
 * `rgb()`/`rgba()` in either syntax: legacy `rgb(255, 0, 0)` /
 * `rgba(255, 0, 0, .5)` and modern `rgb(255 0 0 / 50%)`.
 */
function parseRgbFunction(value: string): string | null {
  const match = RGB_FN_RE.exec(value);

  if (!match) return null;

  const slashParts = match[1].split('/');

  if (slashParts.length > 2) return null;

  const channels = slashParts[0]
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);

  let alphaToken: string | undefined;

  if (slashParts.length === 2) {
    // Modern syntax — alpha follows the slash, so exactly 3 channels precede it.
    if (channels.length !== 3) return null;
    alphaToken = slashParts[1].trim();
  } else if (channels.length === 4) {
    alphaToken = channels[3];
  } else if (channels.length !== 3) {
    return null;
  }

  const rgb: number[] = [];

  for (const token of channels.slice(0, 3)) {
    const component = parseColorChannel(token);

    if (component === null) return null;

    rgb.push(component);
  }

  const alpha = alphaToken === undefined ? 1 : parseColorAlpha(alphaToken);

  if (alpha === null) return null;

  const hex = `#${rgb.map(toColorByte).join('')}`;

  return alpha >= 1 ? hex : `${hex}${toColorByte(alpha * 255)}`;
}

/**
 * Coerces any supported CSS colour to a canonical lowercase hex string.
 *
 * Accepts hex (3/4/6/8 digits, passed through lowercased), `rgb()`/`rgba()` in
 * both the legacy comma syntax and the modern space + slash syntax (numeric or
 * percentage channels), the CSS named colours, and `transparent`.
 *
 * @param input - Untrusted attribute value.
 * @returns Canonical lowercase hex, or `undefined` when the value cannot be
 *   resolved — the caller DROPS the attribute rather than failing the write.
 */
export function normalizeCssColor(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;

  const value = input.trim().toLowerCase();

  if (value.length === 0 || value.length > MAX_COLOR_LENGTH) return undefined;
  if (HEX_COLOR_RE.test(value)) return value;

  // `transparent` is a real, storable colour — fully transparent black.
  if (value === 'transparent') return '#00000000';
  if (UNRESOLVABLE_COLOR_KEYWORDS.has(value)) return undefined;

  return NAMED_COLORS[value] ?? parseRgbFunction(value) ?? undefined;
}

/**
 * Cosmetic colour attribute — coerce-or-drop, never reject. Inherently optional
 * (null/undefined normalize to `undefined`), so it is NOT wrapped in
 * `optional()`.
 */
function cssColor(): AttrValidator {
  return (value) => normalizeCssColor(value);
}

function oneOf(values: string[]): AttrValidator {
  return (value, path) => {
    if (typeof value !== 'string' || !values.includes(value)) {
      reject(path, `expected one of: ${values.join(', ')}`);
    }

    return value;
  };
}

// URL validator. Allows https/http/mailto/tel and app-relative paths.
// javascript: and data: are rejected — EXCEPT data:image/* when
// `allowDataImage` is set (image.src only).
function url(opts: { allowDataImage?: boolean } = {}): AttrValidator {
  return (value, path) => {
    if (typeof value !== 'string') reject(path, 'expected a URL string');

    const raw = value.trim();

    // Split deliberately: an empty href and an over-long one are unrelated
    // causes, and sharing one message made a customer's failure log unreadable
    // (every row said "empty or exceeds 4096" when every row was in fact empty).
    if (raw.length === 0) reject(path, 'URL is empty');
    if (raw.length > 4096) reject(path, 'URL exceeds 4096 chars');

    // App-relative ("/spaces/..", "#anchor", "?query") — no scheme to attack.
    if (/^[/#?]/.test(raw)) return raw;

    // Browsers strip embedded control chars / tabs / newlines BEFORE resolving
    // a URL's scheme, so `java\tscript:` and `java\nscript:` execute as
    // `javascript:`. Classify the scheme against a normalized copy (mirrors
    // DOMPurify's ATTR_WHITESPACE stripping) while still storing the original
    // trimmed value, so legitimate URLs are never mangled.
    const normalized = raw.replace(
      // Control chars are matched on purpose — that is the attack we neutralize.
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g,
      '',
    );
    const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(normalized);

    if (!schemeMatch) {
      // Scheme-less relative path such as "docs/page" — safe.
      return raw;
    }

    const scheme = schemeMatch[1].toLowerCase();

    if (scheme === 'data') {
      if (opts.allowDataImage && /^data:image\//i.test(normalized)) return raw;
      reject(path, 'data: URLs are not allowed here');
    }

    if (!['https', 'http', 'mailto', 'tel'].includes(scheme)) {
      reject(path, `URL scheme "${scheme}" is not allowed`);
    }

    return raw;
  };
}

/**
 * The `link` MARK's href, and nothing else.
 *
 * Wraps `url()` verbatim — one definition of a storable URL, no second
 * allow-list to drift — but turns a violation into `undefined` instead of a
 * thrown rejection, which makes `validateMarks` drop the mark and keep the text.
 *
 * Why links specifically: a link whose href cannot be stored is not a link, and
 * losing it costs the reader nothing (the text survives). Rejecting instead
 * destroys the ENTIRE document over one bad anchor — which is exactly what a
 * Confluence import did, where Word-exported bookmark anchors (`<a name="_Toc1">`
 * with no href) cost a customer 214 of 216 pages. This mirrors the colour
 * coercion above: a bad cosmetic value must never destroy a user's document.
 *
 * Security is unchanged or better — `javascript:`/`data:` are now REMOVED rather
 * than merely refused, so they still never reach storage. Every other
 * URL-bearing attr (image.src, youtube.src, button.url, fileAttachment.url,
 * mediaInline.src, inlineCard.url, externalMacro.sourceUrl) keeps using `url()`
 * and still rejects, because those nodes are meaningless without their URL.
 */
function urlOrDrop(): AttrValidator {
  return orDrop(url());
}

/**
 * Turns a validator's rejection into `undefined`, which `validateAttrs` and
 * `validateMarks` treat as "attribute absent" rather than "document invalid".
 *
 * Use it only where the node still means something without the attribute. The
 * whole-document blast radius of a single bad attr is the most expensive
 * failure mode this file has (see `urlOrDrop`), so every attr that is decoration
 * rather than payload belongs here.
 */
function orDrop(strict: AttrValidator): AttrValidator {
  return (value, path) => {
    try {
      return strict(value, path);
    } catch (err) {
      // Only swallow a validation verdict; a genuine defect must still surface.
      if (err instanceof TipTapValidationError) return undefined;

      throw err;
    }
  };
}

// Opaque config objects (widget embeds, legacyBlock.data): JSON-cloned with a
// depth check; functions cannot survive JSON but we defensively drop any
// non-plain value.
function opaqueObject(maxDepth = 32): AttrValidator {
  const clone = (value: unknown, path: string, depth: number): unknown => {
    if (depth > maxDepth) reject(path, 'opaque object exceeds max depth');

    if (value === null) return null;

    const t = typeof value;

    if (t === 'string' || t === 'number' || t === 'boolean') return value;

    if (Array.isArray(value)) {
      return value.map((v, i) => clone(v, `${path}[${i}]`, depth + 1));
    }

    if (t === 'object') {
      const out: Record<string, unknown> = {};

      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'function' || v === undefined) continue;
        out[k] = clone(v, `${path}.${k}`, depth + 1);
      }

      return out;
    }

    // function / symbol / bigint — drop.
    return undefined;
  };

  return (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      reject(path, 'expected an object');
    }

    return clone(value, path, 0);
  };
}

// Spreadsheet macro `sheet` attr. Only a non-object or an oversize sheet
// rejects; cell-level problems are coerced or dropped so one bad cell never
// fails the page. Must mirror the editor's `normalizeSheet`: collab stores the
// client ydoc unsanitised, so valid input has to pass through unchanged.
const SHEET_MAX_JSON = 563_200;
const SHEET_KEY_RE = /^([A-Z])([1-9]\d{0,2})$/;
const SHEET_ERRORS = new Set([
  '#DIV/0!',
  '#REF!',
  '#NAME?',
  '#VALUE!',
  '#NUM!',
  '#CIRC!',
  '#ERROR!',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampInt(value: unknown, min: number, max: number): number {
  const n =
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 3;

  return Math.min(max, Math.max(min, n));
}

/** Keys of `record` that address a cell inside rows × cols, in row-major order. */
function sheetKeys(
  record: Record<string, unknown>,
  rows: number,
  cols: number,
): string[] {
  const keys: { key: string; row: number; col: number }[] = [];

  for (const key of Object.keys(record)) {
    const match = SHEET_KEY_RE.exec(key);

    if (!match) continue;

    const col = match[1].charCodeAt(0) - 65;
    const row = Number(match[2]);

    if (col < cols && row <= rows) keys.push({ key, row, col });
  }

  keys.sort((a, b) => a.row - b.row || a.col - b.col);

  return keys.map((k) => k.key);
}

/** ISO 4217 shape; Intl formats any well-formed code, so no fixed list to drift. */
const SHEET_CURRENCY = /^[A-Z]{3}$/;

function sheetFormat(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) return undefined;

  const out = Object.create(null) as Record<string, unknown>;

  if (value['b'] === true) out['b'] = true;
  if (value['i'] === true) out['i'] = true;
  if (value['u'] === true) out['u'] = true;
  if (value['s'] === true) out['s'] = true;
  if (value['al'] === 'l' || value['al'] === 'c' || value['al'] === 'r') {
    out['al'] = value['al'];
  }
  if (['g', 'n', 'p', 'c'].includes(value['nf'] as string)) {
    out['nf'] = value['nf'];
  }

  const d = value['d'];

  if (typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 10) {
    out['d'] = d;
  }
  if (typeof value['cur'] === 'string' && SHEET_CURRENCY.test(value['cur'])) {
    out['cur'] = value['cur'];
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function sheetCacheValue(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length <= 1000 ? value : undefined;
  }
  if (
    isPlainRecord(value) &&
    typeof value['e'] === 'string' &&
    SHEET_ERRORS.has(value['e'])
  ) {
    return { e: value['e'] };
  }

  return undefined;
}

function wikiSheet(): AttrValidator {
  return (value, path) => {
    if (!isPlainRecord(value)) reject(path, 'expected a sheet object');

    let size: number;

    try {
      size = JSON.stringify(value).length;
    } catch {
      return reject(path, 'sheet is not serializable');
    }

    if (size > SHEET_MAX_JSON) {
      reject(path, `sheet exceeds ${SHEET_MAX_JSON} chars`);
    }

    // A newer client's sheet is kept verbatim so it is never downgraded.
    if (typeof value['v'] === 'number' && value['v'] > 1) return value;

    const rows = clampInt(value['rows'], 1, 200);
    const cols = clampInt(value['cols'], 1, 26);
    const out = Object.create(null) as Record<string, unknown>;

    out['v'] = 1;

    if (typeof value['title'] === 'string') {
      // eslint-disable-next-line no-control-regex
      const title = value['title'].replace(/[\u0000-\u001f\u007f]/g, '').trim();

      if (title) out['title'] = title.slice(0, 200).trimEnd();
    }

    out['headerRow'] = value['headerRow'] === true;
    out['rows'] = rows;
    out['cols'] = cols;

    const cells = Object.create(null) as Record<string, unknown>;
    const rawCells = isPlainRecord(value['cells']) ? value['cells'] : {};

    for (const key of sheetKeys(rawCells, rows, cols)) {
      const cell = rawCells[key];

      if (!isPlainRecord(cell)) continue;

      const raw =
        typeof cell['raw'] === 'string' ? cell['raw'].slice(0, 1000) : '';
      const fmt = sheetFormat(cell['fmt']);

      if (!raw && !fmt) continue;

      const outCell = Object.create(null) as Record<string, unknown>;

      outCell['raw'] = raw;
      if (fmt) outCell['fmt'] = fmt;
      cells[key] = outCell;
    }

    out['cells'] = cells;

    const cache = Object.create(null) as Record<string, unknown>;
    const rawCache = isPlainRecord(value['cache']) ? value['cache'] : {};

    for (const key of sheetKeys(rawCache, rows, cols)) {
      const cached = sheetCacheValue(rawCache[key]);

      if (cached !== undefined) cache[key] = cached;
    }

    out['cache'] = cache;

    return out;
  };
}

function safeEmbedUrlAttr(): AttrValidator {
  return (value, path) => {
    if (typeof value !== 'string') reject(path, 'expected a URL string');

    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase();
      const youtubeId =
        host === 'youtu.be'
          ? parsed.pathname.split('/').filter(Boolean)[0]
          : host === 'youtube.com' || host === 'www.youtube.com'
            ? parsed.pathname === '/watch'
              ? parsed.searchParams.get('v')
              : /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/.exec(
                  parsed.pathname,
                )?.[1]
            : undefined;
      const vimeoId =
        host === 'vimeo.com' || host === 'www.vimeo.com'
          ? /^\/(\d+)(?:\/|$)/.exec(parsed.pathname)?.[1]
          : host === 'player.vimeo.com'
            ? /^\/video\/(\d+)(?:\/|$)/.exec(parsed.pathname)?.[1]
            : undefined;
      const allowed =
        (youtubeId !== undefined &&
          youtubeId !== null &&
          /^[A-Za-z0-9_-]{11}$/.test(youtubeId)) ||
        Boolean(vimeoId);

      if (parsed.protocol !== 'https:' || !allowed)
        reject(path, 'embed provider is not allowed');

      return value;
    } catch (error) {
      if (error instanceof TipTapValidationError) throw error;
      reject(path, 'invalid embed URL');
    }
  };
}

/** Largest inline preview accepted, in base64 characters (~1.5 MB decoded). */
const MAX_DRAWIO_PREVIEW_CHARS = 2_000_000;

/**
 * `drawioDiagram.preview` — the thumbnail the diagram editor exports when the
 * user saves.
 *
 * This used to reuse `localCarouselImageAttr()`, which only admits a URL under
 * the local public wiki-attachments path. The editor does not upload anything:
 * it exports the drawing inline and hands back a `data:` URI. So every diagram a
 * user drew produced a preview the gate refused, one rejected attr fails the
 * WHOLE document, and the page became unsaveable the moment a diagram was drawn
 * — with the error still reading "carousel image", which is why it read as a
 * carousel problem.
 *
 * Raster only, deliberately. `data:image/svg+xml` is NOT accepted here even
 * though the editor could produce it: SVG carries script and this value is fed
 * straight to an <img src>. The client exports PNG for exactly that reason.
 * Local attachment URLs still pass, so an upload-based preview keeps working.
 *
 * Registered through `orDrop` rather than raw: the client exported `xmlsvg` up
 * to this release, so documents already in the wild carry an SVG preview. If
 * that merely rejected, tightening the gate would brick every one of those pages
 * permanently — the user cannot fix an attribute they cannot see. Dropping it
 * keeps the SVG out of storage all the same, preserves `xml`, and the node view
 * already renders "Preview unavailable; open the editor to regenerate it" for a
 * diagram with source and no preview. `xml` itself still rejects: a diagram
 * without valid source is not a diagram.
 */
function drawioPreviewAttr(): AttrValidator {
  const local = localCarouselImageAttr();

  return (value, path) => {
    if (typeof value !== 'string') reject(path, 'expected an image URL string');

    const raster =
      /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);

    if (raster) {
      if (value.length > MAX_DRAWIO_PREVIEW_CHARS) {
        reject(path, 'inline diagram preview is too large');
      }

      return value;
    }

    if (value.startsWith('data:')) {
      reject(
        path,
        'inline diagram preview must be a base64 PNG or JPEG data URI',
      );
    }

    return local(value, path);
  };
}

function localCarouselImageAttr(): AttrValidator {
  return (value, path) => {
    if (typeof value !== 'string') reject(path, 'expected an image URL string');

    const publicWikiAttachmentPath =
      '/storage/v1/object/public/wiki-attachments/';

    const isPublicWikiAttachmentPath = (pathname: string): boolean => {
      try {
        const decoded = decodeURIComponent(pathname);

        return (
          decoded.startsWith(publicWikiAttachmentPath) &&
          !decoded.split('/').includes('..') &&
          !decoded.includes('\\')
        );
      } catch {
        return false;
      }
    };

    if (value.startsWith('/') && !value.startsWith('//')) {
      const local = new URL(value, 'https://xisuite.local');

      if (
        local.origin === 'https://xisuite.local' &&
        isPublicWikiAttachmentPath(local.pathname)
      ) {
        return value;
      }
    }

    try {
      const parsed = new URL(value);
      const configuredOrigins = [
        process.env.SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_URL,
      ].flatMap((candidate) => {
        if (!candidate) return [];
        try {
          return [new URL(candidate).origin];
        } catch {
          return [];
        }
      });

      if (
        configuredOrigins.includes(parsed.origin) &&
        isPublicWikiAttachmentPath(parsed.pathname)
      ) {
        return value;
      }
    } catch {
      // Rejected below with one stable validation message.
    }

    reject(path, 'carousel image must use local public attachment storage');
  };
}

function carouselFrames(): AttrValidator {
  return (value, path) => {
    if (!Array.isArray(value)) reject(path, 'expected an array');
    if (value.length > 3) reject(path, 'carousel exceeds three frames');

    return value.map((item, index) => {
      const itemPath = `${path}[${index}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item))
        reject(itemPath, 'expected a frame object');
      const frame = item as Record<string, unknown>;

      return {
        title: str(255)(frame['title'] ?? '', `${itemPath}.title`),
        description: str(700)(
          frame['description'] ?? '',
          `${itemPath}.description`,
        ),
        ...(frame['url'] === undefined
          ? {}
          : { url: url()(frame['url'], `${itemPath}.url`) }),
        ...(frame['image'] === undefined
          ? {}
          : {
              image: localCarouselImageAttr()(
                frame['image'],
                `${itemPath}.image`,
              ),
            }),
      };
    });
  };
}

/** drawio payload: bounded string that must be an mxfile or an SVG data URI. */
function drawioXml(): AttrValidator {
  return (value, path) => {
    if (typeof value !== 'string') reject(path, 'expected a string');

    const v = value;

    if (v.length > MAX_DRAWIO_XML) reject(path, 'drawio payload exceeds 2 MB');
    if (
      !v.startsWith('data:image/svg+xml') &&
      !v.trimStart().startsWith('<mxfile')
    ) {
      reject(path, 'drawio payload must be an <mxfile> or an SVG data URI');
    }

    return v;
  };
}

/**
 * rawHtml payload: run through the shared DOMPurify sanitizer.
 *
 * `allowTables` on purpose, and it was the one wiki write path missing it. Every
 * other one passes it — `wiki.service.ts`, `wiki-content.util.ts`,
 * `wiki-mine-write.service.ts` (twice) and the migration's own rawHtml transform
 * in `content-transform.service.ts`. That option exists precisely to separate
 * editors that can represent a table (wiki, migration) from those that cannot
 * (task/comment `InlineRichTextEditor`), and this validator only ever sees the
 * wiki's `rawHtml` node.
 *
 * Without it the default policy dropped `<table>/<tr>/<td>` and kept only the
 * cell TEXT, so a table pasted into the Raw HTML macro rendered correctly in the
 * editor and came back from the server as one run-on line — and a table imported
 * from Confluence was sanitized WITH tables by the transform, then stripped again
 * here on the way into storage. The tags are pure layout: no script surface.
 */
function sanitizedHtml(max: number): AttrValidator {
  return (value, path) => {
    if (typeof value !== 'string') reject(path, 'expected an HTML string');
    if (value.length > max) reject(path, `HTML exceeds ${max} chars`);

    return sanitizeRichText(value, { allowTables: true }) ?? '';
  };
}

const TEXT_ALIGN = optional(oneOf(['left', 'center', 'right', 'justify']));

/**
 * Block indentation level. Confluence/ADF models indentation as a MARK, but a mark applies to inline
 * content while indentation is a block property — so it is carried as a block attr here, which is also
 * how TipTap models it. Capped generously; Confluence itself allows 1-6.
 */
const INDENT = optional(int(0, 10));

/**
 * Confluence's status-lozenge palette (`ac:parameter colour` / ADF `status.attrs.color`). Kept as a
 * closed set rather than a free hex value so a migrated lozenge always renders as one of the six
 * recognised styles instead of arbitrary CSS.
 */
const STATUS_COLORS = [
  'neutral',
  'grey',
  'green',
  'blue',
  'red',
  'yellow',
  'purple',
];

const TABLE_CELL_ATTRS: Record<string, AttrValidator> = {
  colspan: optional(int(1, 100)),
  rowspan: optional(int(1, 100)),
  colwidth: optional(intArray(1, 10_000)),
  backgroundColor: cssColor(),
};

const CONFIG_WIDGET_ATTRS: Record<string, AttrValidator> = {
  config: optional(opaqueObject()),
};

/** Node whitelist with per-attr validators. */
const NODE_SPECS: Record<string, NodeSpec> = {
  doc: { content: true },
  paragraph: {
    content: true,
    attrs: { textAlign: TEXT_ALIGN, indent: INDENT },
  },
  text: { text: true },
  heading: {
    content: true,
    attrs: {
      level: int(1, 6),
      textAlign: TEXT_ALIGN,
      indent: INDENT,
      id: optional((value, path) => {
        if (
          typeof value !== 'string' ||
          !/^[\p{L}\p{N}_-]{1,200}$/u.test(value)
        ) {
          reject(path, 'invalid heading anchor');
        }

        return value;
      }),
    },
  },
  bulletList: { content: true },
  orderedList: { content: true, attrs: { start: optional(int(0, 1_000_000)) } },
  listItem: { content: true },
  taskList: { content: true },
  taskItem: { content: true, attrs: { checked: optional(bool()) } },
  // Confluence decisions. Structurally a task list, semantically distinct (a decision is recorded,
  // not completed), so it gets its own pair rather than being flattened into taskList.
  decisionList: { content: true },
  decisionItem: {
    content: true,
    attrs: { state: optional(oneOf(['DECIDED', 'UNDECIDED'])) },
  },
  blockquote: { content: true },
  codeBlock: {
    content: true,
    attrs: {
      language: optional((value, path) => {
        if (typeof value !== 'string' || !CODE_LANGUAGE_RE.test(value)) {
          reject(path, 'invalid code language');
        }

        return value;
      }),
    },
  },
  horizontalRule: {},
  hardBreak: {},
  table: { content: true },
  tableRow: { content: true },
  tableHeader: { content: true, attrs: TABLE_CELL_ATTRS },
  tableCell: { content: true, attrs: TABLE_CELL_ATTRS },
  image: {
    attrs: {
      src: url({ allowDataImage: true }),
      alt: optional(str(1000)),
      title: optional(str(1000)),
      width: optional(cssLength(1, 10_000)),
      height: optional(cssLength(1, 10_000)),
      textAlign: TEXT_ALIGN,
    },
  },
  youtube: {
    attrs: {
      src: url(),
      width: optional(int(1, 10_000)),
      height: optional(int(1, 10_000)),
    },
  },
  mention: { attrs: { id: uuid(), label: optional(str(500)) } },
  // Attr names mirror src/components/editor/extensions/*Extension.tsx exactly —
  // unknown attrs are stripped, so a mismatch here silently corrupts the node.
  userMention: {
    attrs: {
      userId: uuid(),
      userName: optional(str(500)),
      isPlaceholder: optional(bool()),
    },
  },
  entityMention: {
    attrs: {
      entityId: uuid(),
      entityType: str(30),
      entityKey: optional(str(100)),
      entityTitle: optional(str(1000)),
      spaceKey: optional(str(100)),
      label: optional(str(500)),
    },
  },
  embed: {
    attrs: {
      src: url(),
      provider: optional(str(50)),
      aspectRatio: optional(str(20)),
      title: optional(str(1000)),
      originalUrl: optional(url()),
    },
  },
  wikiLink: {
    attrs: {
      pageId: uuid(),
      pageTitle: optional(str(1000)),
      pageSlug: optional(str(500)),
      spaceKey: optional(str(100)),
      fragment: optional(str(200)),
      label: optional(str(500)),

      // The editor sets this to drive broken-link styling (red vs blue), but it
      // had no entry here, so it was silently stripped on every save and the
      // styling reset to "exists" on the next reload — a link to a deleted page
      // looked healthy again. `pageId` stays REQUIRED: a wikiLink with no target
      // is not a link, and the picker now always supplies a real page id.
      exists: optional(bool()),
    },
  },
  callout: {
    content: true,
    attrs: {
      // `note`/`tip`/`custom` extend the original four to cover Confluence's full panel set
      // (info/note/tip/warning/success/error + custom). Widening an existing enum is backward
      // compatible: every value already stored still validates.
      variant: oneOf([
        'info',
        'warning',
        'success',
        'danger',
        'note',
        'tip',
        'custom',
      ]),
      title: optional(str(500)),
      // Only meaningful for variant 'custom', which is Confluence's user-styled panel.
      emoji: optional(str(100)),
      backgroundColor: cssColor(),
      borderColor: cssColor(),
      borderStyle: optional(
        oneOf(['solid', 'dashed', 'dotted', 'double', 'none']),
      ),
      borderWidth: optional(int(0, 10)),
      titleBackgroundColor: cssColor(),
      titleColor: cssColor(),
    },
  },
  details: { content: true },
  detailsSummary: { content: true },
  detailsContent: { content: true },
  columnList: { content: true },
  column: { content: true, attrs: { width: optional(int(1, 100)) } },
  button: {
    attrs: {
      label: str(200),
      url: url(),
      style: optional(str(50)),
    },
  },
  rawHtml: { attrs: { html: sanitizedHtml(1_000_000) } },
  confluenceAnchor: { attrs: { name: str(200) } },
  fileAttachment: {
    attrs: {
      fileId: optional(uuid()),
      url: optional(url()),
      previewUrl: optional(url()),
      name: optional(str(1000)),
      size: optional(int(0, Number.MAX_SAFE_INTEGER)),
      mime: optional(str(255)),
      sourceMacro: optional(str(100)),
      localAttachment: optional(bool()),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },
  drawioDiagram: {
    attrs: {
      // Optional on purpose: the slash command inserts an EMPTY diagram
      // (`xml: null`) and the node view renders "Empty diagram — click Edit
      // diagram to start drawing" until someone draws one. Requiring xml here
      // meant inserting a Diagram and saving before drawing rejected the whole
      // document. The payload itself is still fully validated when present.
      xml: optional(drawioXml()),
      preview: optional(orDrop(drawioPreviewAttr())),
      caption: optional(str(2000)),
    },
  },
  // Flat attrs (Editor.js block-data fields spread), per AssetObjectEmbed.tsx
  assetObjectList: {
    attrs: {
      spaceId: optional(str(100)),
      schemaId: optional(str(100)),
      schemaName: optional(str(500)),
      objectTypeId: optional(str(100)),
      objectTypeName: optional(str(500)),
      // Always a string[] of column field-keys (extension default [], config
      // dialog saves string[]) — opaqueObject() rejects top-level arrays.
      selectedColumns: optional(strArray(200)),
      sortField: optional(str(100)),
      sortDirection: optional(oneOf(['asc', 'desc'])),
      pageSize: optional(int(1, 100)),
      caption: optional(str(2000)),
    },
  },
  assetObjectCard: {
    attrs: {
      spaceId: optional(str(100)),
      schemaId: optional(str(100)),
      schemaName: optional(str(500)),
      objectTypeId: optional(str(100)),
      objectTypeName: optional(str(500)),
      objectId: optional(str(100)),
      objectName: optional(str(500)),
      objectKey: optional(str(100)),
      // Same string[] shape as assetObjectList.selectedColumns above.
      selectedAttributes: optional(strArray(200)),
      caption: optional(str(2000)),
    },
  },
  taskList2: { attrs: CONFIG_WIDGET_ATTRS },
  ticketTable: { attrs: CONFIG_WIDGET_ATTRS },
  taskCard: {
    attrs: { taskKey: optional(str(100)), config: optional(opaqueObject()) },
  },
  boardEmbed: { attrs: CONFIG_WIDGET_ATTRS },
  // Embedded whiteboard (wiki2 "/whiteboard"): config = { whiteboardId, spaceId, name }.
  whiteboardEmbed: { attrs: CONFIG_WIDGET_ATTRS },
  planGantt: { attrs: CONFIG_WIDGET_ATTRS },
  dashboardWidget: { attrs: CONFIG_WIDGET_ATTRS },
  savedFilterEmbed: { attrs: CONFIG_WIDGET_ATTRS },
  // Embedded Form Builder form (wiki2 FormBuilderEmbed). publicSlug is a snapshot for the public page link.
  formBuilderEmbed: {
    attrs: {
      spaceId: optional(str(100)),
      formId: optional(str(100)),
      formName: optional(str(500)),
      publicSlug: optional(str(100)),
    },
  },
  // Renders the page's own custom-field values in the body. `config` carries
  // { fieldKeys?, layout?, hideEmpty?, showGroupHeadings? } — a nested string
  // array is fine here, opaqueObject only rejects a top-level array.
  pageProperties: { attrs: CONFIG_WIDGET_ATTRS },
  legacyBlock: {
    attrs: { blockType: str(50), data: optional(opaqueObject()) },
  },
  // @tiptap/extension-mathematics v3 registers blockMath/inlineMath
  blockMath: { attrs: { latex: str(5000) } },
  inlineMath: { attrs: { latex: str(5000) } },
  emoji: { attrs: { name: str(100) } },

  // ───────────────────── Confluence parity nodes ─────────────────────
  // Added so Confluence Cloud content survives migration as EDITABLE structure rather than an opaque
  // HTML blob. Attr names mirror the frontend extensions in src/components/wiki2/extensions/ exactly —
  // unknown attrs are silently stripped, so a mismatch here corrupts the node without any error.

  /**
   * Date lozenge (ADF `date`). `timestamp` is epoch milliseconds as a STRING, which is what ADF emits;
   * keeping the source representation avoids a lossy parse and lets the client format per locale.
   */
  date: { attrs: { timestamp: str(20) } },

  /** Coloured status lozenge (ADF `status`, Confluence `status` macro). */
  status: {
    attrs: {
      text: str(200),
      color: optional(oneOf(STATUS_COLORS)),
    },
  },

  /**
   * Smart link rendered inline (ADF `inlineCard`). Distinct from the block-level `embed`: this one sits
   * inside a paragraph. `title` is a resolved-label cache; the `url` is authoritative.
   */
  inlineCard: {
    attrs: {
      url: url(),
      title: optional(str(1000)),
      sourceMacro: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },

  safeEmbed: {
    attrs: {
      url: safeEmbedUrlAttr(),
      title: optional(str(255)),
      width: optional(int(100, 2000)),
      height: optional(int(100, 2000)),
      align: optional(oneOf(['left', 'right'])),
      frameBorder: optional(bool()),
      scrolling: optional(oneOf(['yes', 'no', 'auto'])),
      sourceMacro: optional(
        oneOf(['iframe', 'widget', 'widget-connector', 'widgetconnector']),
      ),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },

  carousel: {
    attrs: {
      frames: carouselFrames(),
      sourceMacro: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },

  /** Inline image/file chip (ADF `mediaInline`) — media inside a run of text rather than its own block. */
  mediaInline: {
    attrs: {
      src: optional(url({ allowDataImage: true })),
      fileId: optional(str(200)),
      name: optional(str(1000)),
      mime: optional(str(255)),
      size: optional(int(0, Number.MAX_SAFE_INTEGER)),
      width: optional(int(1, 10_000)),
      height: optional(int(1, 10_000)),
    },
  },

  /** Media caption (ADF `caption`), a sibling block under the image it describes. */
  caption: { content: true },

  /**
   * Live child-page tree (Confluence `pagetree` / `children` macro). Renders from the wiki tree at view
   * time, so it stays correct as pages move — unlike the old importer, which froze a link list.
   */
  pageTree: {
    attrs: {
      rootPageId: optional(uuid()),
      depth: optional(int(1, 10)),
      spaceKey: optional(str(100)),
    },
  },

  /** Live list of a page's attachments (Confluence `attachments` macro). */
  attachmentsList: { attrs: { pageId: optional(uuid()) } },

  /** Live list of attachments across the current space (Confluence `space-attachments` macro). */
  spaceAttachments: {
    attrs: { limit: optional(int(1, 200)) },
  },

  /** Live list of spaces in the current organization (Confluence `spaces` macro). */
  spacesList: {
    attrs: { limit: optional(int(1, 200)) },
  },

  /** In-page search UI over the current space's wiki pages (Confluence `livesearch` macro). */
  liveSearch: {
    attrs: { placeholder: optional(str(200)) },
  },

  /** Live report of inline wiki tasks (Confluence `tasks-report-macro`). */
  taskReport: {
    attrs: {
      limit: optional(int(1, 200)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },

  /** Recently-updated feed for a space (Confluence `recently-updated` macro). */
  recentlyUpdated: {
    attrs: {
      spaceKey: optional(str(100)),
      limit: optional(int(1, 50)),
      types: optional(strArray(100, 10)),
      hideHeading: optional(bool()),
    },
  },

  /** Version history for the containing page (Confluence `change-history`). */
  changeHistory: {
    attrs: {
      limit: optional(int(1, 100)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },

  /** Scoped tree search plus the legacy Page Index/Search Results display modes. */
  pageTreeSearch: {
    attrs: {
      rootPageId: optional(uuid()),
      mode: optional(oneOf(['search', 'pageIndex', 'searchResults'])),
      query: optional(str(1000)),
    },
  },

  /** Public-safe metadata for the current space (legacy Confluence `space-details`). */
  spaceDetails: {
    attrs: {
      width: optional(str(50)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },

  /** Tenant/space-visible members only; source groups remain explicit when unresolved. */
  userList: {
    attrs: {
      groups: optional(strArray(500, 100)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },

  /** Richer user summary card, limited to visible members. */
  userProfile: {
    attrs: {
      userId: optional(uuid()),
      userKey: optional(str(500)),
      userName: optional(str(500)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },

  /** Avatar lookup. Local IDs are UUIDs; source keys/names remain strings until remapped. */
  profilePicture: {
    attrs: {
      userId: optional(uuid()),
      userKey: optional(str(500)),
      userName: optional(str(500)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },

  /** Most-used labels for the current or explicitly matching source space. */
  popularLabels: {
    attrs: {
      count: optional(int(1, 100)),
      spaceKey: optional(str(100)),
      style: optional(oneOf(['list', 'heatmap'])),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },

  recentlyUsedLabels: {
    attrs: {
      count: optional(int(1, 100)),
      scope: optional(oneOf(['global', 'space', 'personal'])),
      style: optional(oneOf(['list', 'table'])),
      title: optional(str(200)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },
  relatedLabels: {
    attrs: {
      labels: optional(strArray(100, 20)),
      pageId: optional(uuid()),
      limit: optional(int(1, 100)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },
  contentByUser: {
    attrs: {
      userId: optional(uuid()),
      userKey: optional(str(500)),
      userName: optional(str(500)),
      limit: optional(int(1, 100)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },
  recentlyUpdatedDashboard: {
    attrs: {
      spaceKeys: optional(strArray(100, 20)),
      types: optional(strArray(100, 10)),
      labels: optional(strArray(100, 20)),
      users: optional(strArray(100, 20)),
      width: optional(str(16)),
      showProfilePic: optional(bool()),
      limit: optional(int(1, 50)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },
  contentReportTable: {
    attrs: {
      labels: optional(strArray(100, 20)),
      spaceKeys: optional(strArray(100, 20)),
      limit: optional(int(1, 200)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },
  decisionReport: {
    attrs: {
      labels: optional(strArray(100, 20)),
      spaceKeys: optional(strArray(100, 20)),
      cql: optional(str(1000)),
      limit: optional(int(1, 100)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },
  blogPosts: {
    attrs: {
      params: optional(stringRecord(5000)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },
  rssFeed: {
    attrs: {
      params: optional(stringRecord(5000)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },
  confluenceToc: {
    attrs: {
      params: optional(stringRecord(5000)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },
  navigationMap: {
    attrs: {
      label: optional(str(100)),
      title: optional(str(200)),
      wrapAfter: optional(int(1, 8)),
      cellWidth: optional(str(16)),
      limit: optional(int(1, 60)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },

  /** Legacy action; frontend independently checks auth and can_create_spaces before showing it. */
  createSpaceButton: {
    attrs: {
      size: optional(oneOf(['small', 'large'])),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
    },
  },

  /** Reusable content source. Hidden affects only the source page, never an include consumer. */
  excerpt: {
    content: true,
    attrs: {
      hidden: optional(bool()),
      name: optional(str(500)),
      sourceParams: optional(stringRecord(5000)),
    },
  },

  /** Live whole-page include, bound during migration to a stable local page id. */
  includePage: {
    attrs: {
      pageId: optional(uuid()),
      title: optional(str(1000)),
      targetSpaceId: optional(uuid()),
      targetSpaceKey: optional(str(100)),
      sourceParams: optional(stringRecord(5000)),
      sourceReference: optional(stringRecord(2000)),
    },
  },

  /** Live excerpt include; empty excerptName means the first source excerpt. */
  excerptInclude: {
    attrs: {
      pageId: optional(uuid()),
      title: optional(str(1000)),
      targetSpaceId: optional(uuid()),
      targetSpaceKey: optional(str(100)),
      excerptName: optional(str(500)),
      nopanel: optional(bool()),
      sourceParams: optional(stringRecord(5000)),
      sourceReference: optional(stringRecord(2000)),
    },
  },

  /** Structured Confluence metadata; intentionally distinct from XISUITE custom fields. */
  contentProperties: {
    attrs: {
      propertyId: optional(str(255)),
      hidden: optional(bool()),
      rows: contentPropertyRows(),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(1_000_000)),
    },
  },

  /** Spreadsheet macro: one JSON `sheet` attr, coerced by `wikiSheet`. */
  spreadsheet: {
    attrs: { sheet: optional(wikiSheet()) },
  },

  /** Label is optional at the storage gate so an unfinished editor node remains saveable. */
  contentPropertiesReport: {
    attrs: {
      label: optional(str(50)),
      propertyId: optional(str(255)),
      titleColumn: optional(str(100)),
      columns: optional(strArray(100, 100)),
      limit: optional(int(1, 30)),
      // BOTH values the editor can produce. The node's own default is 'title'
      // (ContentProperties.tsx `sortBy: { default: 'title' }`, and its Sort by
      // select offers Title | Modified), so admitting only 'modified' rejected
      // the macro the instant it was inserted — and because one bad attr fails
      // the WHOLE document, that took every other unsaved edit on the page with
      // it. The gate must cover the client's actual domain, not a subset of it.
      sortBy: optional(oneOf(['title', 'modified'])),
      sourceParams: optional(stringRecord(5000)),
    },
  },

  /** Editable chart with a source table body. */
  chart: {
    content: true,
    attrs: {
      type: optional(oneOf(['pie', 'bar', 'line', 'area'])),
      title: optional(str(1000)),
      subtitle: optional(str(1000)),
      xLabel: optional(str(500)),
      yLabel: optional(str(500)),
      width: optional(int(1, 10_000)),
      height: optional(int(1, 10_000)),
      legend: optional(bool()),
      orientation: optional(oneOf(['vertical', 'horizontal'])),
      stacked: optional(bool()),
      sourceParams: optional(opaqueObject()),
    },
  },

  /** Attachment-backed image gallery; attrs stay broad for migration compatibility. */
  gallery: {
    attrs: {
      pageId: optional(uuid()),
      title: optional(str(1000)),
      columns: optional(int(1, 8)),
      include: optional(strArray(1000, 200)),
      exclude: optional(strArray(1000, 200)),
      includeLabel: optional(strArray(1000, 200)),
      excludeLabel: optional(strArray(1000, 200)),
      sort: optional(
        oneOf(['created', 'name', 'none', 'date', 'size', 'comment']),
      ),
      reverse: optional(bool()),
      captions: optional(bool()),
      limit: optional(int(1, 200)),
      sourceParams: optional(opaqueObject()),
    },
  },

  /** Page contributors (Confluence `contributors` macro). */
  contributors: {
    attrs: { pageId: optional(uuid()), limit: optional(int(1, 50)) },
  },

  /** Confluence `contributors-summary`, including edits, comments, and labels. */
  contributorsSummary: {
    attrs: { limit: optional(int(1, 50)) },
  },

  /** Confluence `listlabels`, evaluated against labels in the rendered page's space. */
  labelsList: {
    attrs: {
      excludedLabels: optional(strArray(100, 20)),
      sourceName: optional(str(200)),
      sourceParams: optional(stringRecord(5000)),
      sourceBody: optional(str(20_000)),
    },
  },

  /** Confluence `contentbylabel`, evaluated only against the rendered page's current space. */
  contentByLabel: {
    attrs: {
      labels: strArray(100, 20),
      spaceKeys: optional(strArray(100, 20)),
      limit: optional(int(1, 50)),
    },
  },

  /**
   * Vendor/Forge app macro that XISUITE cannot reimplement (e.g. `azure-devops-macro-wiki`).
   * Every source parameter is preserved verbatim in `params` and the card deep-links back to the
   * original page, so the data is never lost — only its live rendering is.
   */
  externalMacro: {
    content: true,
    attrs: {
      name: str(200),
      params: optional(opaqueObject()),
      sourceUrl: optional(url()),
    },
  },
};

/** Mark whitelist with per-attr validators. */
const MARK_SPECS: Record<string, Record<string, AttrValidator>> = {
  bold: {},
  italic: {},
  strike: {},
  underline: {},
  code: {},
  subscript: {},
  superscript: {},
  highlight: { color: cssColor() },
  textStyle: { color: cssColor() },
  link: {
    // Lenient ON PURPOSE — see `urlOrDrop`. An unusable href drops this mark,
    // it does not fail the document.
    href: urlOrDrop(),
    target: optional(oneOf(['_blank', '_self'])),
    // rel is forced below regardless of input.
  },
  comment: { threadId: uuid() },
  spoiler: {},
  annotation: { title: optional(str(1000)) },
};

interface WalkState {
  nodeCount: number;
}

function validateAttrs(
  rawAttrs: unknown,
  validators: Record<string, AttrValidator>,
  path: string,
): Record<string, unknown> | undefined {
  const attrs =
    typeof rawAttrs === 'object' &&
    rawAttrs !== null &&
    !Array.isArray(rawAttrs)
      ? (rawAttrs as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};

  for (const [name, validator] of Object.entries(validators)) {
    const value = validator(attrs[name], `${path}.attrs.${name}`);

    if (value !== undefined) out[name] = value;
  }

  // Unknown attrs are silently stripped (never copied to `out`).
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateMarks(
  rawMarks: unknown,
  path: string,
): Record<string, unknown>[] | undefined {
  if (rawMarks === undefined || rawMarks === null) return undefined;
  if (!Array.isArray(rawMarks)) reject(path, 'marks must be an array');

  const out: Record<string, unknown>[] = [];

  for (let i = 0; i < (rawMarks as unknown[]).length; i++) {
    const mark = (rawMarks as unknown[])[i] as Record<string, unknown>;
    const markPath = `${path}.marks[${i}]`;

    if (typeof mark !== 'object' || mark === null) {
      reject(markPath, 'mark must be an object');
    }

    const type = mark['type'];

    if (typeof type !== 'string' || !(type in MARK_SPECS)) {
      reject(markPath, `unknown mark type "${String(type)}"`);
    }

    const attrs = validateAttrs(mark['attrs'], MARK_SPECS[type], markPath);
    const canonical: Record<string, unknown> = { type };

    if (type === 'link') {
      // A link mark with no storable href is not a link: DROP the mark and keep
      // the text, rather than failing the whole document over one bad anchor.
      // `urlOrDrop` has already turned every unusable href (missing, empty,
      // >4096 chars, disallowed scheme) into `undefined` by this point.
      if (!attrs || attrs['href'] === undefined) continue;

      canonical['attrs'] = { ...attrs, rel: 'noopener noreferrer nofollow' };
    } else if (attrs) {
      canonical['attrs'] = attrs;
    }

    // comment mark requires threadId (validateAttrs throws if missing? no —
    // uuid() rejects undefined only via the non-optional validator).
    out.push(canonical);
  }

  return out.length > 0 ? out : undefined;
}

function validateNode(
  raw: unknown,
  path: string,
  depth: number,
  state: WalkState,
): Record<string, unknown> {
  if (depth > MAX_DEPTH) reject(path, `nesting exceeds max depth ${MAX_DEPTH}`);

  state.nodeCount++;

  if (state.nodeCount > MAX_NODES) {
    reject(path, `document exceeds max node count ${MAX_NODES}`);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    reject(path, 'node must be an object');
  }

  const node = raw as Record<string, unknown>;
  const type = node['type'];

  if (typeof type !== 'string' || !(type in NODE_SPECS)) {
    reject(path, `unknown node type "${String(type)}"`);
  }

  const spec = NODE_SPECS[type];
  const canonical: Record<string, unknown> = { type };

  if (spec.text) {
    const text = node['text'];

    if (typeof text !== 'string') reject(`${path}.text`, 'expected a string');
    canonical['text'] = text;
  }

  const attrs = validateAttrs(node['attrs'], spec.attrs ?? {}, path);

  if (attrs) canonical['attrs'] = attrs;

  const marks = validateMarks(node['marks'], path);

  if (marks) canonical['marks'] = marks;

  if (node['content'] !== undefined && node['content'] !== null) {
    if (!spec.content) {
      reject(`${path}.content`, `node type "${type}" cannot have content`);
    }
    if (!Array.isArray(node['content'])) {
      reject(`${path}.content`, 'content must be an array');
    }

    canonical['content'] = (node['content'] as unknown[]).map((child, i) =>
      validateNode(child, `${path}.content[${i}]`, depth + 1, state),
    );
  }

  return canonical;
}

/**
 * Validates an untrusted TipTap document (JSON string or already-parsed
 * object) against the Wiki 2.0 node/mark whitelist. REJECTS (throws
 * `BadRequestException` with the offending path) on unknown node/mark types,
 * invalid attribute values, unsafe URLs, or size/depth/node-count violations.
 * Unknown attributes on known nodes are stripped.
 *
 * @param raw - The untrusted document (string or object).
 * @returns The canonical doc object plus its canonical JSON string.
 * @throws BadRequestException on any violation.
 */
export function validateTipTapDoc(raw: unknown): ValidatedTipTapDoc {
  let parsed: unknown = raw;

  if (typeof raw === 'string') {
    if (raw.length > MAX_SERIALIZED_BYTES) {
      reject('$', 'serialized document exceeds 5 MB');
    }

    try {
      parsed = JSON.parse(raw);
    } catch {
      reject('$', 'content is not valid JSON');
    }
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>)['type'] !== 'doc'
  ) {
    reject('$', 'root must be a { type: "doc" } node');
  }

  const state: WalkState = { nodeCount: 0 };
  const doc = validateNode(parsed, '$', 0, state);
  const json = JSON.stringify(doc);

  if (json.length > MAX_SERIALIZED_BYTES) {
    reject('$', 'serialized document exceeds 5 MB');
  }

  return { doc, json };
}
