import createDOMPurify, { type WindowLike } from 'dompurify';
import type { DOMWindow } from 'jsdom';

interface JSDOMConstructor {
  new (html: string): { window: DOMWindow };
}

type DOMPurifyInstance = ReturnType<typeof createDOMPurify>;

/**
 * jsdom is loaded LAZILY, on first sanitize, rather than at module import.
 *
 * Two independent problems, both fixed by deferring:
 *
 * 1. Test-suite stability (found upstream). Constructing the JSDOM eagerly meant
 *    merely IMPORTING this module built a full DOM. Because it sits under
 *    `wiki-content.util.ts` and the automations action registry, most of the
 *    backend transitively imports it — so every Jest worker built its own DOM
 *    whether or not it sanitized anything. On a 15-core machine that was ~14
 *    concurrent DOMs and produced a SIGSEGV in roughly half of full-suite runs.
 *
 * 2. Test-suite CORRECTNESS. jsdom@28 transitively requires `tough-cookie`,
 *    which is `"type": "module"`. Under ts-jest's CommonJS resolver that
 *    resolves to an ESM entry and throws `SyntaxError: Unexpected token 'export'`
 *    **at import time**, taking out 42 of 307 suites (~14%) — `lists`,
 *    `automations`, `tasks` — purely through the import chain, nowhere near the
 *    code under test.
 *
 * This is why the jsdom `require()` lives INSIDE the function rather than as a
 * top-level `import * as jsdomModule`. A static import is hoisted, so it would
 * still load jsdom (and tough-cookie) at import time and reintroduce problem 2 —
 * a lazy INSTANCE alone only fixes problem 1.
 *
 * Behaviour is unchanged: still exactly one memoized instance per process, so
 * the hot path after the first call is identical.
 */
let domPurifyInstance: DOMPurifyInstance | null = null;

function getDOMPurify(): DOMPurifyInstance {
  if (domPurifyInstance) return domPurifyInstance;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jsdomModule = require('jsdom') as { JSDOM: JSDOMConstructor };

  domPurifyInstance = createDOMPurify(
    new jsdomModule.JSDOM('').window as unknown as WindowLike,
  );

  return domPurifyInstance;
}

/**
 * Table markup — allowed ONLY on write paths whose editors can represent it: wiki, migration, and
 * task descriptions/comments (`InlineRichTextEditor` mounted with `enableTables`, which registers
 * the TipTap table nodes). The rule is unchanged, only its membership: a surface may opt in once
 * its editor can round-trip a table, because an editor without table nodes silently drops a table
 * on open and destroys it on the next save.
 *
 * Still OFF by default, so GDPR, SiteStudio, wiki comments and the Editor.js wiki storage path keep
 * the narrow list. Do not flip the default to widen one caller — pass the option at that call site.
 *
 * These are pure layout tags/attrs — no script surface. `style` is deliberately NOT added, so cell
 * backgrounds and `<col style="width:…">` column widths do not survive; task editors therefore
 * mount tables with `resizable: false` rather than persisting a width the sanitizer will strip.
 */
const TABLE_TAGS = [
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'col',
];
const TABLE_ATTR = ['colspan', 'rowspan'];

export interface SanitizeRichTextOptions {
  /** Opt in to table markup. Default false → the exact pre-CF-B allow-list. */
  allowTables?: boolean;
}

export function sanitizeRichText(
  value: string | null | undefined,
  options?: SanitizeRichTextOptions,
): string | null {
  if (value == null) return null;

  const allowTables = options?.allowTables === true;

  return getDOMPurify().sanitize(value, {
    ALLOWED_TAGS: [
      // Text + structure
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'a',
      'ul',
      'ol',
      'li',
      'blockquote',
      'code',
      'pre',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'span',
      'div',
      // Media
      'img',
      'video',
      'source',
      'audio',
      'figure',
      'figcaption',
      // Inline SVG (vector graphics pasted from Figma / Illustrator / etc.).
      // <script> and <foreignObject> are intentionally NOT listed; DOMPurify
      // also strips event-handler attributes regardless.
      'svg',
      'g',
      'path',
      'circle',
      'rect',
      'ellipse',
      'line',
      'polyline',
      'polygon',
      'text',
      'tspan',
      'defs',
      'use',
      'symbol',
      'marker',
      'linearGradient',
      'radialGradient',
      'stop',
      'clipPath',
      'mask',
      'pattern',
      'desc',
      'image',
      ...(allowTables ? TABLE_TAGS : []),
    ],
    ALLOWED_ATTR: [
      // Links + generic
      'href',
      'target',
      'rel',
      'class',
      'align',
      // Media
      'src',
      'alt',
      'title',
      'width',
      'height',
      'loading',
      'controls',
      'autoplay',
      'loop',
      'muted',
      'poster',
      'preload',
      'playsinline',
      'controlslist',
      'type',
      // SVG geometry + drawing
      'd',
      'cx',
      'cy',
      'r',
      'rx',
      'ry',
      'x',
      'y',
      'x1',
      'y1',
      'x2',
      'y2',
      'points',
      'transform',
      'viewBox',
      'xmlns',
      'xmlns:xlink',
      'version',
      'preserveAspectRatio',
      // SVG paint
      'fill',
      'stroke',
      'stroke-width',
      'stroke-linecap',
      'stroke-linejoin',
      'stroke-dasharray',
      'stroke-dashoffset',
      'stroke-miterlimit',
      'fill-rule',
      'opacity',
      'fill-opacity',
      'stroke-opacity',
      // SVG text
      'font-family',
      'font-size',
      'font-weight',
      'font-style',
      'text-anchor',
      'dominant-baseline',
      // SVG gradients / refs
      'gradientUnits',
      'gradientTransform',
      'offset',
      'stop-color',
      'stop-opacity',
      'spreadMethod',
      'clip-path',
      'mask',
      'xlink:href',
      // User mention attributes
      'data-user-mention',
      'data-user-id',
      'data-user-name',
      // Entity mention attributes (wiki @PROC- / @TASK- mentions)
      'data-entity-mention',
      'data-entity-id',
      'data-entity-type',
      'data-entity-key',
      'data-entity-title',
      'data-space-key',
      // Image layout written by the resizable-image node view. Presentational only, no script
      // surface — the same character as the `width`/`height`/`align` attributes above. Without
      // these a resized image silently snaps back to full size on the next load.
      'data-width',
      'data-height',
      'data-align',
      'data-layout',
      'data-border',
      // XE-T684: an image shown as a thumbnail (opened full size on click). Same presentational character.
      'data-thumbnail',
      ...(allowTables ? TABLE_ATTR : []),
    ],
    ALLOW_DATA_ATTR: false,
    // DOMPurify strips event-handler (on*) attributes and blocks javascript:
    // URIs by default. <img>/<video>/<audio>/<source> are media-safe even with
    // SVG data: URIs because browsers load them in restricted (non-scripting)
    // contexts. Inline <svg> is restricted to drawing/text tags only — script
    // and foreignObject are NOT in the allowlist, so script execution inside
    // SVG is blocked. Do NOT add 'style' (CSS injection vector), 'srcset'
    // (bypasses src URI filters), 'animate' or 'set' (allow attribute mutation
    // toward javascript: URIs in older browsers). iframe is intentionally
    // omitted — adding it requires a host allowlist hook (YouTube/Vimeo only).
  });
}
