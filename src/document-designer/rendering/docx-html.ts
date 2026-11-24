/**
 * @fileoverview Rich-text HTML → docx Paragraph/Table mapping for Word exports,
 * reproducing the Chromium PDF look (marks, headings, real Word lists, tables,
 * images, links). Self-contained on purpose: a small tokenizer instead of
 * jsdom/DOMPurify, which the DOCX renderer's Jest spec cannot load.
 * @module src/document-designer/rendering/docx-html
 */

import {
  AlignmentType,
  BorderStyle,
  ExternalHyperlink,
  HighlightColor,
  ImageRun,
  LevelFormat,
  LineRuleType,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  VerticalAlignTable,
  WidthType,
} from 'docx';
import type {
  IBorderOptions,
  ILevelsOptions,
  IParagraphRunOptions,
  IRunOptions,
  ISpacingProperties,
  ParagraphChild,
} from 'docx';

export type DocxHtmlBlock = Paragraph | Table;

type Alignment = (typeof AlignmentType)[keyof typeof AlignmentType];

export type DocxListKind = 'bullet' | 'decimal';

export interface IDocxHtmlBase {
  /** Word font name (already a single family, e.g. 'Arial'). */
  font: string;
  /** Element font size in CSS px. */
  sizePx: number;
  bold: boolean;
  /** 'RRGGBB' (no '#'), already opacity-blended by the caller. */
  color?: string;
}

export interface IDocxHtmlOptions {
  base: IDocxHtmlBase;
  /** Element text-align; undefined = Word default (left). */
  align?: Alignment;
  /** Element CSS line-height multiplier; undefined = leave Word single spacing. */
  lineHeight?: number;
  /** Resolves {{tokens}}; applied to every text node and to <a href> only. */
  interpolate?: (text: string) => string;
  /** true = '\n' inside plain text / interpolated values becomes a Word line break. */
  keepNewlines: boolean;
  /** Shared per render (lists). */
  numbering: DocxNumbering;
  /** Warn-once sink (dedupe by key is the caller's job). */
  warn: (key: string, message: string) => void;
  /** Available width (cell width) — caps images and sizes tables. */
  maxWidthPx: number;
  /** Applied to every colour taken from the HTML (opacity blending). */
  colorTransform?: (rrggbb: string) => string;
}

export interface IHtmlTextNode {
  type: 'text';
  text: string;
  /** Set by parseHtml for tag-free input: rendered verbatim, no whitespace collapsing. */
  plain?: boolean;
}

export interface IHtmlElementNode {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}

export type HtmlNode = IHtmlTextNode | IHtmlElementNode;

const MAX_DEPTH = 50;
const MAX_LIST_LEVEL = 8;
/** Real Word numbering for the first N numbered lists; later ones get literal markers. */
const MAX_NUMBERED_INSTANCES = 100;
// Word's table column limit
const MAX_COLUMNS = 63;
const LIST_INDENT = 600;
const LIST_HANGING = 360;
const BULLETS = ['•', '◦', '▪'];
const MONO_FONT = 'Courier New';
const RULE_COLOR = 'A0A0A0';
const GRID_BORDER_COLOR = 'D1D5DB';
const GRID_MARGIN_Y = 30;
const GRID_MARGIN_X = 60;
const WS_RUN = /[ \t\n\r\f]+/g;
const NEWLINE = /\r?\n/;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/i;
// eslint-disable-next-line no-control-regex -- stripping XML-illegal characters is the point
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
  'param',
  'keygen',
]);
const RAW_TEXT_TAGS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'noembed',
  'noframes',
]);
const UNSUPPORTED_TAGS = new Set([
  'svg',
  'math',
  'video',
  'audio',
  'iframe',
  'object',
  'embed',
  'canvas',
  'script',
  'style',
  'template',
  'noscript',
]);
const IGNORED_TAGS = new Set([
  'head',
  'title',
  'meta',
  'link',
  'base',
  'textarea',
  'select',
  'option',
  'optgroup',
  'datalist',
  'colgroup',
  'col',
  'param',
  'source',
  'track',
  'wbr',
  'area',
  'map',
  'noembed',
  'noframes',
]);
const BLOCK_TAGS = new Set([
  'html',
  'body',
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'li',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'nav',
  'aside',
  'figure',
  'figcaption',
  'address',
  'dl',
  'dt',
  'dd',
  'details',
  'summary',
  'form',
  'fieldset',
  'legend',
  'center',
  'hgroup',
  'menu',
  'dir',
  'search',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
]);
// Start tags that implicitly close an open <p> (HTML parsing rules)
const P_CLOSERS = new Set([...BLOCK_TAGS, 'ul', 'ol', 'table', 'hr', 'dialog']);
const TABLE_STRUCTURE = new Set([
  'table',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
]);
const HEADING_SCALE = new Map([
  ['h1', 2],
  ['h2', 1.5],
  ['h3', 1.17],
  ['h4', 1],
  ['h5', 0.83],
  ['h6', 0.67],
]);
const FONT_SIZE_KEYWORDS = new Map([
  ['xx-small', 9],
  ['x-small', 10],
  ['small', 13],
  ['medium', 16],
  ['large', 18],
  ['x-large', 24],
  ['xx-large', 32],
  ['xxx-large', 48],
]);
const FONT_TAG_SIZES = [10, 13, 16, 18, 24, 32, 48];
const GENERIC_FONTS = new Map([
  ['serif', 'Times New Roman'],
  ['ui-serif', 'Times New Roman'],
  ['sans-serif', 'Arial'],
  ['ui-sans-serif', 'Arial'],
  ['system-ui', 'Arial'],
  ['-apple-system', 'Arial'],
  ['monospace', MONO_FONT],
  ['ui-monospace', MONO_FONT],
]);
const NAMED_COLORS = new Map([
  ['black', '000000'],
  ['white', 'FFFFFF'],
  ['red', 'FF0000'],
  ['green', '008000'],
  ['blue', '0000FF'],
  ['yellow', 'FFFF00'],
  ['orange', 'FFA500'],
  ['purple', '800080'],
  ['gray', '808080'],
  ['grey', '808080'],
  ['silver', 'C0C0C0'],
  ['maroon', '800000'],
  ['navy', '000080'],
  ['teal', '008080'],
  ['olive', '808000'],
  ['lime', '00FF00'],
  ['aqua', '00FFFF'],
  ['cyan', '00FFFF'],
  ['fuchsia', 'FF00FF'],
  ['magenta', 'FF00FF'],
  ['pink', 'FFC0CB'],
  ['brown', 'A52A2A'],
  ['gold', 'FFD700'],
  ['indigo', '4B0082'],
  ['violet', 'EE82EE'],
  ['lightgray', 'D3D3D3'],
  ['lightgrey', 'D3D3D3'],
  ['darkgray', 'A9A9A9'],
  ['darkgrey', 'A9A9A9'],
  ['darkred', '8B0000'],
  ['darkgreen', '006400'],
  ['darkblue', '00008B'],
  ['lightblue', 'ADD8E6'],
  ['lightgreen', '90EE90'],
  ['crimson', 'DC143C'],
  ['coral', 'FF7F50'],
  ['tomato', 'FF6347'],
]);
// Latin-1 named entities in code point order from U+00A0
const LATIN1_ENTITIES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(
    ' ',
  );
const NAMED_ENTITIES = new Map<string, number>([
  ['amp', 38],
  ['lt', 60],
  ['gt', 62],
  ['quot', 34],
  ['apos', 39],
  ...LATIN1_ENTITIES.map((name, k): [string, number] => [name, 160 + k]),
  ...Object.entries({
    OElig: 338,
    oelig: 339,
    Scaron: 352,
    scaron: 353,
    Yuml: 376,
    fnof: 402,
    circ: 710,
    tilde: 732,
    ensp: 8194,
    emsp: 8195,
    thinsp: 8201,
    zwnj: 8204,
    zwj: 8205,
    lrm: 8206,
    rlm: 8207,
    ndash: 8211,
    mdash: 8212,
    lsquo: 8216,
    rsquo: 8217,
    sbquo: 8218,
    ldquo: 8220,
    rdquo: 8221,
    bdquo: 8222,
    dagger: 8224,
    Dagger: 8225,
    bull: 8226,
    hellip: 8230,
    permil: 8240,
    prime: 8242,
    Prime: 8243,
    lsaquo: 8249,
    rsaquo: 8250,
    euro: 8364,
    trade: 8482,
    larr: 8592,
    uarr: 8593,
    rarr: 8594,
    darr: 8595,
    harr: 8596,
    minus: 8722,
    infin: 8734,
    ne: 8800,
    le: 8804,
    ge: 8805,
    check: 10003,
  }),
]);
const ENTITY =
  /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g;

// Public helpers

/** Strips characters that are illegal in XML 1.0 (keeps \t \n \r). */
export function xmlSafe(text: string): string {
  return text.replace(XML_ILLEGAL, '');
}

/** True when the string contains no tag-like '<' (a plain-text value). */
export function isPlainText(value: string): boolean {
  return !/<[a-zA-Z!/?]/.test(value);
}

/** Composites `rrggbb` at `alpha` (0..1) over `beneath`; returns 'RRGGBB'. */
export function blendOverWhite(
  rrggbb: string,
  alpha: number,
  beneath = 'FFFFFF',
): string {
  const under = hexChannels(beneath) ?? [255, 255, 255];
  const top = hexChannels(rrggbb);
  if (!top) return channelsToHex(under);
  const a = Number.isFinite(alpha) ? Math.min(Math.max(alpha, 0), 1) : 1;

  return channelsToHex(
    top.map((c, k) => Math.round(c * a + under[k] * (1 - a))),
  );
}

/** CSS colour → 'RRGGBB' (alpha blended over white); undefined when transparent/unknown. */
export function cssColorToHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  const named = NAMED_COLORS.get(v);
  if (named) return named;

  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) {
    const full =
      hex.length === 3 || hex.length === 4
        ? [...hex].map((c) => c + c).join('')
        : hex;
    if (full.length === 6) return full.toUpperCase();
    if (full.length !== 8) return undefined;
    const alpha = parseInt(full.slice(6), 16) / 255;

    return alpha > 0 ? blendOverWhite(full.slice(0, 6), alpha) : undefined;
  }

  const fn = /^rgba?\(([^)]*)\)$/.exec(v)?.[1];
  if (fn === undefined) return undefined;
  const parts = fn.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return undefined;
  const rgb = parts.slice(0, 3).map((p) => {
    const n = parseFloat(p);

    return Math.min(
      Math.max(Math.round(p.endsWith('%') ? n * 2.55 : n), 0),
      255,
    );
  });
  if (rgb.some((c) => Number.isNaN(c))) return undefined;
  let alpha = parts[3] === undefined ? 1 : parseFloat(parts[3]);
  if (parts[3]?.endsWith('%')) alpha /= 100;
  if (Number.isNaN(alpha)) alpha = 1;
  if (alpha <= 0) return undefined;

  return blendOverWhite(channelsToHex(rgb), alpha);
}

/** First family of a CSS font-family list, quotes stripped; generic families mapped to Word fonts. */
export function firstFontFamily(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|([^,]*))/.exec(value);
  const name = xmlSafe(m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
  const lower = name.toLowerCase();
  if (!name || ['inherit', 'initial', 'unset', 'revert'].includes(lower)) {
    return undefined;
  }

  return GENERIC_FONTS.get(lower) ?? name;
}

/** Pixel size from a PNG / JPEG / GIF / BMP header; null when unrecognised. */
export function readImageSize(
  data: Uint8Array,
): { width: number; height: number } | null {
  const info = sniffImage(data);

  return info ? { width: info.width, height: info.height } : null;
}

/** 1pt empty paragraph: keeps adjacent tables apart and closes table cells. */
export function separatorParagraph(): Paragraph {
  return new Paragraph({
    children: [],
    spacing: { before: 0, after: 0 },
    run: { size: 2 },
  });
}

/**
 * Word list definitions shared across one document render. One abstract
 * definition per list "signature" (marker kind per depth); each top-level
 * list containing numbers gets its own instance so numbering restarts.
 */
export class DocxNumbering {
  private readonly definitions = new Map<string, ILevelsOptions[]>();
  private readonly nextInstance = new Map<string, number>();
  private readonly used = new Set<string>();
  // docx rewrites the whole document once per instance — cap them (quadratic otherwise).
  private numberedInstances = 0;

  /**
   * Reference + instance for a new top-level list (bullet-only lists share instance 0);
   * null once the numbered-instance budget is spent — the caller writes literal markers.
   */
  allocate(
    kinds: readonly DocxListKind[],
    start: number,
  ): { reference: string; instance: number } | null {
    const reference = `doc-list-${kinds.join('-')}-s${start}`;
    const numbered = kinds.includes('decimal');
    if (numbered && this.numberedInstances >= MAX_NUMBERED_INSTANCES) {
      return null;
    }
    if (!this.definitions.has(reference)) {
      this.definitions.set(reference, listLevels(kinds, start));
    }
    if (!numbered) return { reference, instance: 0 };
    this.numberedInstances += 1;
    const instance = this.nextInstance.get(reference) ?? 0;
    this.nextInstance.set(reference, instance + 1);

    return { reference, instance };
  }

  /** Records that a paragraph referencing `reference` was emitted. */
  markUsed(reference: string): void {
    if (this.definitions.has(reference)) this.used.add(reference);
  }

  /** Pass to `new Document({ numbering: { config: numbering.config() } })`; [] when no list was rendered. */
  config(): { reference: string; levels: ILevelsOptions[] }[] {
    return [...this.definitions]
      .filter(([reference]) => this.used.has(reference))
      .map(([reference, levels]) => ({ reference, levels }));
  }
}

function listLevels(
  kinds: readonly DocxListKind[],
  start: number,
): ILevelsOptions[] {
  return Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, level) => {
    const decimal = kinds[level] === 'decimal';

    return {
      level,
      format: decimal ? LevelFormat.DECIMAL : LevelFormat.BULLET,
      text: decimal ? `%${level + 1}.` : BULLETS[level % BULLETS.length],
      alignment: AlignmentType.LEFT,
      start: level === 0 ? start : 1,
      style: {
        paragraph: {
          indent: { left: LIST_INDENT * (level + 1), hanging: LIST_HANGING },
        },
      },
    };
  });
}

// Tokenizer

const OPEN_TAG = /<([a-zA-Z][^\s/>]*)/y;
const CLOSE_TAG = /<\/([a-zA-Z][^\s/>]*)[^<>]*>/y;
const ATTR_NAME = /[^\s/>][^\s/>=]*/y;
const UNQUOTED_VALUE = /[^\s>]+/y;

/** Parse once (cacheable), render many times. Never throws on malformed markup. */
export function parseHtml(html: string): HtmlNode[] {
  const src = typeof html === 'string' ? html : '';
  if (isPlainText(src)) {
    return src
      ? [{ type: 'text', text: decodeEntities(src), plain: true }]
      : [];
  }
  const root = elementNode('#root', {});
  const stack = [root];
  const addText = (text: string): void => {
    if (!text) return;
    const siblings = stack[stack.length - 1].children;
    const last = siblings[siblings.length - 1];
    if (last?.type === 'text') last.text += text;
    else siblings.push({ type: 'text', text });
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      addText(decodeEntities(src.slice(i)));
      break;
    }
    addText(decodeEntities(src.slice(i, lt)));
    i = parseMarkup(src, lt, stack, addText);
  }

  return root.children;
}

function parseMarkup(
  src: string,
  at: number,
  stack: IHtmlElementNode[],
  addText: (text: string) => void,
): number {
  if (src.startsWith('<!--', at)) return skipPast(src, '-->', at + 4);
  if (src.startsWith('<![CDATA[', at)) {
    const end = src.indexOf(']]>', at + 9);
    addText(src.slice(at + 9, end < 0 ? src.length : end));

    return end < 0 ? src.length : end + 3;
  }
  const next = src.charAt(at + 1);
  if (next === '!' || next === '?') return skipPast(src, '>', at + 1);
  if (next === '/') {
    CLOSE_TAG.lastIndex = at;
    const close = CLOSE_TAG.exec(src);
    if (close) {
      closeElement(stack, close[1].toLowerCase());

      return CLOSE_TAG.lastIndex;
    }

    return skipPast(src, '>', at + 2);
  }
  OPEN_TAG.lastIndex = at;
  const open = OPEN_TAG.exec(src);
  if (!open) {
    addText('<');

    return at + 1;
  }
  const tag = open[1].toLowerCase();
  const { attrs, end, selfClosing } = parseAttributes(src, OPEN_TAG.lastIndex);
  impliedClose(stack, tag);
  const node = elementNode(tag, attrs);
  stack[stack.length - 1].children.push(node);
  if (RAW_TEXT_TAGS.has(tag)) {
    // Content is skipped, never parsed as markup
    const closeRe = new RegExp(`</${tag}[\\s/>]`, 'ig');
    closeRe.lastIndex = end;
    const close = closeRe.exec(src);

    return close ? skipPast(src, '>', close.index) : src.length;
  }
  if (selfClosing || VOID_TAGS.has(tag)) return end;
  stack.push(node);
  // HTML drops a newline directly after <pre>
  if (tag === 'pre' || tag === 'listing') {
    if (src.startsWith('\r\n', end)) return end + 2;
    if (src.charAt(end) === '\n') return end + 1;
  }

  return end;
}

function parseAttributes(
  src: string,
  from: number,
): { attrs: Record<string, string>; end: number; selfClosing: boolean } {
  const attrs = Object.create(null) as Record<string, string>;
  const isSpace = (c: string): boolean => /\s/.test(c);
  let i = from;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === '>') return { attrs, end: i + 1, selfClosing: false };
    if (c === '/') {
      if (src.charAt(i + 1) === '>') {
        return { attrs, end: i + 2, selfClosing: true };
      }
      i++;
      continue;
    }
    if (isSpace(c)) {
      i++;
      continue;
    }
    ATTR_NAME.lastIndex = i;
    const name = ATTR_NAME.exec(src)?.[0] ?? c;
    i += name.length;
    while (i < src.length && isSpace(src.charAt(i))) i++;
    let value = '';
    if (src.charAt(i) === '=') {
      i++;
      while (i < src.length && isSpace(src.charAt(i))) i++;
      const quote = src.charAt(i);
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, i + 1);
        value = src.slice(i + 1, close < 0 ? src.length : close);
        i = close < 0 ? src.length : close + 1;
      } else {
        UNQUOTED_VALUE.lastIndex = i;
        value = UNQUOTED_VALUE.exec(src)?.[0] ?? '';
        i += value.length;
      }
    }
    const key = name.toLowerCase();
    if (!(key in attrs)) attrs[key] = decodeEntities(value);
  }

  return { attrs, end: src.length, selfClosing: false };
}

// Minimal HTML implied-end-tag rules for unclosed li/td/tr/p
function impliedClose(stack: IHtmlElementNode[], tag: string): void {
  if (tag === 'li') popTo(stack, ['li'], ['ul', 'ol', 'table', 'td', 'th']);
  else if (tag === 'dt' || tag === 'dd') {
    popTo(stack, ['dt', 'dd'], ['dl', 'table', 'td', 'th']);
  } else if (tag === 'td' || tag === 'th')
    popTo(stack, ['td', 'th'], ['tr', 'table']);
  else if (tag === 'tr') {
    popTo(stack, ['tr'], ['table', 'thead', 'tbody', 'tfoot']);
  } else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
    popTo(stack, ['thead', 'tbody', 'tfoot'], ['table']);
  }
  if (P_CLOSERS.has(tag)) {
    popTo(
      stack,
      ['p'],
      ['table', 'td', 'th', 'caption', 'button', 'object', 'template'],
    );
  }
}

function popTo(
  stack: IHtmlElementNode[],
  targets: readonly string[],
  boundaries: readonly string[],
): void {
  for (let k = stack.length - 1; k > 0; k--) {
    const open = stack[k].tag;
    if (targets.includes(open)) {
      stack.length = k;

      return;
    }
    if (boundaries.includes(open)) return;
  }
}

function closeElement(stack: IHtmlElementNode[], tag: string): void {
  const tableTag = TABLE_STRUCTURE.has(tag);
  for (let k = stack.length - 1; k > 0; k--) {
    const open = stack[k].tag;
    if (open === tag) {
      stack.length = k;

      return;
    }
    // A stray close tag must not escape the current table cell
    if (!tableTag && TABLE_STRUCTURE.has(open)) return;
  }
}

function elementNode(
  tag: string,
  attrs: Record<string, string>,
): IHtmlElementNode {
  return { type: 'element', tag, attrs, children: [] };
}

function skipPast(src: string, token: string, from: number): number {
  const k = src.indexOf(token, from);

  return k < 0 ? src.length : k + token.length;
}

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;

  return text.replace(
    ENTITY,
    (match: string, dec?: string, hex?: string, name?: string): string => {
      if (name !== undefined) {
        const cp = NAMED_ENTITIES.get(name);

        return cp !== undefined && match.endsWith(';')
          ? String.fromCodePoint(cp)
          : match;
      }
      const cp =
        dec !== undefined ? parseInt(dec, 10) : parseInt(hex ?? '', 16);
      const valid = cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);

      return String.fromCodePoint(valid ? cp : 0xfffd);
    },
  );
}

// Small value helpers

function hexChannels(value: string): number[] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;

  return [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16));
}

function channelsToHex(channels: readonly number[]): string {
  return channels
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function positive(n: number | undefined): number | undefined {
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
}

function twips(px: number): number {
  return Math.round(px * 15);
}

function halfPoints(px: number): number {
  return Math.min(3276, Math.max(2, Math.round(px * 1.5)));
}

function clampInt(value: string | undefined, min: number, max: number): number {
  const n = parseInt(value ?? '', 10);

  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : min;
}

function parseStyle(value: string | undefined): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (!value) return out;
  for (const decl of value.split(';')) {
    const colon = decl.indexOf(':');
    if (colon <= 0) continue;
    out[decl.slice(0, colon).trim().toLowerCase()] = decl
      .slice(colon + 1)
      .replace(/!important/i, '')
      .trim();
  }

  return out;
}

function parseAlign(value: string | undefined): Alignment | undefined {
  switch (value?.trim().toLowerCase()) {
    case 'left':
    case 'start':
      return AlignmentType.LEFT;
    case 'right':
    case 'end':
      return AlignmentType.RIGHT;
    case 'center':
    case '-webkit-center':
      return AlignmentType.CENTER;
    case 'justify':
      return AlignmentType.JUSTIFIED;
    default:
      return undefined;
  }
}

function cssLengthPx(
  value: string | undefined,
  emPx: number,
  percentOf?: number,
): number | undefined {
  // Length-capped and backtracking-free: style values are author/user input.
  const m =
    value && value.length <= 64
      ? /^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(px|pt|em|rem|%)?$/i.exec(value.trim())
      : null;
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  switch ((m[2] ?? 'px').toLowerCase()) {
    case 'pt':
      return (n * 4) / 3;
    case 'em':
      return n * emPx;
    case 'rem':
      return n * 16;
    case '%':
      return percentOf === undefined ? undefined : (n * percentOf) / 100;
    default:
      return n;
  }
}

function fontSizePx(value: string, parentPx: number): number | undefined {
  const v = value.trim().toLowerCase();
  if (v === 'smaller') return parentPx / 1.2;
  if (v === 'larger') return parentPx * 1.2;

  return positive(
    FONT_SIZE_KEYWORDS.get(v) ?? cssLengthPx(v, parentPx, parentPx),
  );
}

// <font size="1..7" | "+n" | "-n">
function fontTagPx(value: string | undefined): number | undefined {
  const m = /^\s*([+-]?)(\d)\s*$/.exec(value ?? '');
  if (!m) return undefined;
  const n = Number(m[2]);
  const size = m[1] === '+' ? 3 + n : m[1] === '-' ? 3 - n : n;

  return FONT_TAG_SIZES[Math.min(Math.max(size, 1), 7) - 1];
}

function isBold(weight: string): boolean | undefined {
  const w = weight.trim().toLowerCase();
  if (w === 'bold' || w === 'bolder') return true;
  if (w === 'normal' || w === 'lighter') return false;
  const n = Number(w);

  return Number.isFinite(n) && w !== '' ? n >= 600 : undefined;
}

type ImageKind = 'png' | 'jpg' | 'gif' | 'bmp';

function sniffImage(
  data: Uint8Array,
): { type: ImageKind; width: number; height: number } | null {
  const n = data.length;
  const u16be = (o: number): number => (data[o] << 8) | data[o + 1];
  const u16le = (o: number): number => data[o] | (data[o + 1] << 8);
  const u32be = (o: number): number =>
    ((data[o] << 24) >>> 0) +
    (data[o + 1] << 16) +
    (data[o + 2] << 8) +
    data[o + 3];
  const i32le = (o: number): number =>
    data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24);
  const ok = (type: ImageKind, width: number, height: number) =>
    width > 0 && height > 0 ? { type, width, height } : null;

  if (
    n >= 24 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    String.fromCharCode(data[12], data[13], data[14], data[15]) === 'IHDR'
  ) {
    return ok('png', u32be(16), u32be(20));
  }
  if (n >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return ok('gif', u16le(6), u16le(8));
  }
  if (n >= 26 && data[0] === 0x42 && data[1] === 0x4d) {
    // BITMAPCOREHEADER (12 bytes) stores 16-bit sizes, later headers 32-bit
    return i32le(14) === 12
      ? ok('bmp', u16le(18), u16le(20))
      : ok('bmp', Math.abs(i32le(18)), Math.abs(i32le(22)));
  }
  if (n >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let o = 2;
    while (o + 9 < n) {
      if (data[o] !== 0xff) return null;
      const marker = data[o + 1];
      if (marker === 0xff) {
        o++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        o += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      const sof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (sof) return ok('jpg', u16be(o + 7), u16be(o + 5));
      o += 2 + u16be(o + 2);
    }
  }

  return null;
}

// Flattened text: block boundaries and <br> become '\n' when `lines` is set
function nodesText(nodes: readonly HtmlNode[], lines: boolean): string {
  let out = '';
  // block boundaries are soft: adjacent blocks must not produce blank lines
  const boundary = (): void => {
    if (out && !out.endsWith('\n')) out += '\n';
  };
  const stack: (HtmlNode | 'boundary')[] = [...nodes].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node === 'boundary') boundary();
    else if (node.type === 'text') out += node.text;
    else if (UNSUPPORTED_TAGS.has(node.tag) || IGNORED_TAGS.has(node.tag))
      continue;
    else if (lines && node.tag === 'br') out += '\n';
    else {
      if (lines && (BLOCK_TAGS.has(node.tag) || P_CLOSERS.has(node.tag))) {
        boundary();
        stack.push('boundary');
      }
      for (let k = node.children.length - 1; k >= 0; k--) {
        stack.push(node.children[k]);
      }
    }
  }

  return out;
}

function htmlToText(html: string): string {
  const src = typeof html === 'string' ? html : '';

  return decodeEntities(
    src
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(
        /<\/?(p|div|li|h[1-6]|tr|blockquote|ul|ol|pre|table|hr)\b[^<>]*>/gi,
        '\n',
      )
      .replace(/<[^<>]*>/g, ''),
  );
}

// Renderer

interface IRunStyle {
  font: string;
  sizePx: number;
  bold: boolean;
  italics: boolean;
  underline: boolean;
  strike: boolean;
  color?: string;
  shading?: string;
  highlight: boolean;
  sub: boolean;
  sup: boolean;
}

interface ILink {
  href: string;
}

interface IListCtx {
  reference: string;
  instance: number;
  level: number;
  // numbering budget spent: markers are written as text (counters per level)
  literal?: { counters: number[]; kinds: DocxListKind[] };
}

interface ICtx {
  style: IRunStyle;
  align?: Alignment;
  pre: boolean;
  depth: number;
  maxWidthPx: number;
  list?: IListCtx;
  link?: ILink;
}

type InlineItem =
  | {
      kind: 'text';
      text: string;
      style: IRunStyle;
      link?: ILink;
      // preserved whitespace (pre / pre-wrap / plain text)
      keep: boolean;
    }
  | { kind: 'break'; style: IRunStyle; link?: ILink }
  | { kind: 'image'; run: ImageRun; link?: ILink };

interface IParaIR {
  kind: 'p';
  items: InlineItem[];
  mark: IRunStyle;
  align?: Alignment;
  before: number;
  after: number;
  outlineLevel?: number;
  indentLeft?: number;
  hanging?: number;
  numbering?: { reference: string; level: number; instance: number };
  rule?: boolean;
  // already numbered/indented by the innermost list
  listOwned?: boolean;
}

type BlockIR = IParaIR | { kind: 'table'; table: Table };

interface IFlow {
  ctx: ICtx;
  outlineLevel?: number;
  items: InlineItem[];
  blocks: BlockIR[];
}

class DocxHtmlRenderer {
  private readonly warned = new Set<string>();

  constructor(private readonly opts: IDocxHtmlOptions) {}

  render(nodes: readonly HtmlNode[]): DocxHtmlBlock[] {
    const only = nodes.length === 1 ? nodes[0] : undefined;
    if (only?.type === 'text' && only.plain) {
      return [this.toParagraph(this.plainParagraph(only.text))];
    }

    return this.materialize(this.blocks(nodes, this.rootCtx()), false);
  }

  private rootCtx(): ICtx {
    const { base } = this.opts;

    return {
      style: {
        font: xmlSafe(base.font || 'Arial'),
        sizePx: positive(base.sizePx) ?? 16,
        bold: base.bold,
        italics: false,
        underline: false,
        strike: false,
        color: base.color,
        highlight: false,
        sub: false,
        sup: false,
      },
      align: this.opts.align,
      pre: false,
      depth: 0,
      maxWidthPx: positive(this.opts.maxWidthPx) ?? 600,
    };
  }

  private warn(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.opts.warn(key, message);
  }

  private color(rrggbb: string): string {
    return this.opts.colorTransform ? this.opts.colorTransform(rrggbb) : rrggbb;
  }

  private interp(text: string): string {
    return this.opts.interpolate ? this.opts.interpolate(text) : text;
  }

  // Plain-text values: verbatim, newlines become breaks when asked
  private plainParagraph(text: string): IParaIR {
    const ctx = this.rootCtx();
    const value = this.interp(text);
    const lines = this.opts.keepNewlines
      ? value.split(NEWLINE)
      : [value.replace(/\r?\n/g, ' ')];
    const items: InlineItem[] = [];
    this.pushLines(items, lines, ctx, true);
    if (items[items.length - 1]?.kind === 'break') items.pop();

    return this.para(ctx, items);
  }

  private blocks(
    nodes: readonly HtmlNode[],
    ctx: ICtx,
    outlineLevel?: number,
  ): BlockIR[] {
    const flow: IFlow = { ctx, outlineLevel, items: [], blocks: [] };
    for (const node of nodes) this.walk(node, ctx, flow);
    this.flush(flow);

    return flow.blocks;
  }

  private walk(node: HtmlNode, ctx: ICtx, flow: IFlow): void {
    if (node.type === 'text') {
      this.addText(node.text, ctx, flow);

      return;
    }
    const tag = node.tag;
    if (UNSUPPORTED_TAGS.has(tag)) {
      this.warn(
        `docx-html:${tag}`,
        `Rich text <${tag}> content is not supported in Word exports (skipped)`,
      );

      return;
    }
    if (IGNORED_TAGS.has(tag)) return;
    if (ctx.depth >= MAX_DEPTH) {
      this.addText(nodesText([node], false), ctx, flow);

      return;
    }
    const css = parseStyle(node.attrs.style);
    if (css.display?.trim().toLowerCase() === 'none') return;

    switch (tag) {
      case 'br':
        flow.items.push({ kind: 'break', style: ctx.style, link: ctx.link });

        return;
      case 'img':
        this.addImage(node, css, ctx, flow);

        return;
      case 'input':
        if ((node.attrs.type ?? '').toLowerCase() === 'checkbox') {
          flow.items.push({
            kind: 'text',
            text: 'checked' in node.attrs ? '☑ ' : '☐ ',
            style: ctx.style,
            link: ctx.link,
            keep: false,
          });
        }

        return;
      case 'hr':
        this.flush(flow);
        flow.blocks.push(this.rule(this.elementCtx(node, css, ctx)));

        return;
      case 'table':
        this.flush(flow);
        append(flow.blocks, this.table(node, this.elementCtx(node, css, ctx)));

        return;
      case 'ul':
      case 'ol':
        this.flush(flow);
        append(flow.blocks, this.list(node, this.elementCtx(node, css, ctx)));

        return;
      default:
        break;
    }

    const inner = this.elementCtx(node, css, ctx);
    if (!BLOCK_TAGS.has(tag)) {
      for (const child of node.children) this.walk(child, inner, flow);

      return;
    }
    this.flush(flow);
    const heading = HEADING_SCALE.has(tag)
      ? Number(tag.charAt(1)) - 1
      : undefined;
    const out = this.blocks(node.children, inner, heading);
    if (tag === 'pre') {
      const em = twips(inner.style.sizePx);
      pad(out, em, em);
    }
    append(flow.blocks, out);
  }

  // Inherited run style / alignment / link for an element's content
  private elementCtx(
    el: IHtmlElementNode,
    css: Record<string, string>,
    ctx: ICtx,
  ): ICtx {
    const s: IRunStyle = { ...ctx.style };
    const parentPx = s.sizePx;
    const tag = el.tag;
    let { align, link, pre } = ctx;

    const heading = HEADING_SCALE.get(tag);
    if (heading !== undefined) {
      s.bold = true;
      s.sizePx = parentPx * heading;
    }
    switch (tag) {
      case 'strong':
      case 'b':
      case 'th':
        s.bold = true;
        break;
      case 'em':
      case 'i':
      case 'cite':
      case 'var':
      case 'dfn':
      case 'address':
        s.italics = true;
        break;
      case 'u':
      case 'ins':
        s.underline = true;
        break;
      case 's':
      case 'del':
      case 'strike':
        s.strike = true;
        break;
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt':
        s.font = MONO_FONT;
        break;
      case 'pre':
        s.font = MONO_FONT;
        pre = true;
        break;
      case 'sub':
        s.sub = true;
        s.sup = false;
        break;
      case 'sup':
        s.sup = true;
        s.sub = false;
        break;
      case 'mark':
        // a highlight enum cannot be opacity-blended, shading can
        if (this.opts.colorTransform) s.shading = this.color('FFFF00');
        else s.highlight = true;
        break;
      case 'center':
        align = AlignmentType.CENTER;
        break;
      case 'font': {
        const color = cssColorToHex(el.attrs.color);
        if (color) s.color = this.color(color);
        s.font = firstFontFamily(el.attrs.face) ?? s.font;
        s.sizePx = fontTagPx(el.attrs.size) ?? s.sizePx;
        break;
      }
      case 'a':
        link = this.link(el.attrs.href);
        if (link) s.underline = true;
        break;
      default:
        break;
    }

    this.applyCss(s, css, parentPx, !BLOCK_TAGS.has(tag));
    if (BLOCK_TAGS.has(tag)) {
      align =
        parseAlign(css['text-align']) ?? parseAlign(el.attrs.align) ?? align;
    }
    const ws = css['white-space']?.trim().toLowerCase();
    if (ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces') pre = true;
    else if (ws === 'normal' || ws === 'nowrap' || ws === 'pre-line')
      pre = false;

    return { ...ctx, style: s, align, link, pre, depth: ctx.depth + 1 };
  }

  private applyCss(
    s: IRunStyle,
    css: Record<string, string>,
    parentPx: number,
    inline: boolean,
  ): void {
    const color = cssColorToHex(css.color);
    if (color) s.color = this.color(color);
    if (inline) {
      const bg = cssColorToHex(css['background-color'] ?? css.background);
      if (bg) s.shading = this.color(bg);
    }
    const size = css['font-size']
      ? fontSizePx(css['font-size'], parentPx)
      : undefined;
    if (size) s.sizePx = size;
    s.font = firstFontFamily(css['font-family']) ?? s.font;
    if (css['font-weight']) s.bold = isBold(css['font-weight']) ?? s.bold;
    const fontStyle = css['font-style']?.trim().toLowerCase();
    if (fontStyle === 'italic' || fontStyle === 'oblique') s.italics = true;
    else if (fontStyle === 'normal') s.italics = false;
    const deco = `${css['text-decoration'] ?? ''} ${css['text-decoration-line'] ?? ''}`;
    if (/underline/i.test(deco)) s.underline = true;
    if (/line-through/i.test(deco)) s.strike = true;
    const va = css['vertical-align']?.trim().toLowerCase();
    if (va === 'sub' || va === 'super') {
      s.sub = va === 'sub';
      s.sup = va === 'super';
    }
  }

  private link(raw: string | undefined): ILink | undefined {
    if (raw === undefined) return undefined;
    const href = xmlSafe(this.interp(raw).trim());

    return /^https?:\/\/\S/i.test(href) ? { href } : undefined;
  }

  private addText(raw: string, ctx: ICtx, flow: IFlow): void {
    if (ctx.pre) {
      this.pushLines(flow.items, this.interp(raw).split(NEWLINE), ctx, true);

      return;
    }
    // Source whitespace collapses before interpolation, so only value newlines can break
    const value = this.interp(raw.replace(WS_RUN, ' '));
    const lines = this.opts.keepNewlines ? value.split(NEWLINE) : [value];
    this.pushLines(
      flow.items,
      lines.map((line) => line.replace(WS_RUN, ' ')),
      ctx,
      false,
    );
  }

  private pushLines(
    items: InlineItem[],
    lines: readonly string[],
    ctx: ICtx,
    keep: boolean,
  ): void {
    lines.forEach((line, k) => {
      if (k > 0)
        items.push({ kind: 'break', style: ctx.style, link: ctx.link });
      if (line) {
        items.push({
          kind: 'text',
          text: line,
          style: ctx.style,
          link: ctx.link,
          keep,
        });
      }
    });
  }

  // Pending inline content → one paragraph; empty blocks are 0px in the PDF so they are skipped
  private flush(flow: IFlow): void {
    if (!flow.items.length) return;
    const raw = flow.items;
    flow.items = [];
    const items = normalizeWhitespace(raw);
    const hadBreak = raw.some((item) => item.kind === 'break');
    // a trailing <br> adds no line in HTML
    if (items[items.length - 1]?.kind === 'break') items.pop();
    if (!items.length && !hadBreak) return;
    flow.blocks.push(this.para(flow.ctx, items, flow.outlineLevel));
  }

  private para(ctx: ICtx, items: InlineItem[], outlineLevel?: number): IParaIR {
    return {
      kind: 'p',
      items,
      mark: ctx.style,
      align: ctx.align,
      before: 0,
      after: 0,
      outlineLevel,
    };
  }

  private rule(ctx: ICtx): IParaIR {
    const half = twips(ctx.style.sizePx / 2);

    return { ...this.para(ctx, []), before: half, after: half, rule: true };
  }

  // Top-level lists get their own numbering instance; nested lists reuse it one level deeper
  private list(el: IHtmlElementNode, ctx: ICtx): BlockIR[] {
    const parent = ctx.list;
    const start = el.tag === 'ol' ? listStart(el.attrs.start) : 1;
    const allocated = parent
      ? null
      : this.opts.numbering.allocate(listSignature(el), start);
    const list: IListCtx = parent
      ? { ...parent, level: Math.min(parent.level + 1, MAX_LIST_LEVEL) }
      : allocated
        ? { ...allocated, level: 0 }
        : {
            reference: '',
            instance: 0,
            level: 0,
            literal: { counters: [], kinds: [] },
          };
    // Literal markers: every list (nested too) restarts its own counter.
    if (list.literal) {
      list.literal.counters[list.level] = start - 1;
      list.literal.kinds[list.level] = el.tag === 'ol' ? 'decimal' : 'bullet';
    }
    const inner: ICtx = { ...ctx, list };
    const indent = LIST_INDENT * (list.level + 1);
    const out: BlockIR[] = [];
    for (const child of el.children) {
      if (child.type === 'text' && !child.text.replace(WS_RUN, '')) continue;
      const blocks =
        child.type === 'element' && child.tag === 'li'
          ? this.listItem(child, inner)
          : this.blocks([child], inner);
      for (const block of blocks) {
        if (block.kind !== 'p' || block.listOwned) continue;
        if (!block.numbering) block.indentLeft = indent;
        block.listOwned = true;
      }
      append(out, blocks);
    }
    if (!parent) {
      const em = twips(ctx.style.sizePx);
      pad(out, em, em);
    }

    return out;
  }

  // First own paragraph of an <li> carries the marker; an li without one gets an empty marker line
  private listItem(li: IHtmlElementNode, ctx: ICtx): BlockIR[] {
    const css = parseStyle(li.attrs.style);
    if (css.display?.trim().toLowerCase() === 'none') return [];
    const inner = this.elementCtx(li, css, ctx);
    const blocks = this.blocks(li.children, inner);
    let first = blocks[0];
    if (first?.kind !== 'p' || first.listOwned) {
      first = this.para(inner, []);
      blocks.unshift(first);
    }
    const list = ctx.list;
    if (list?.literal) {
      const count = (list.literal.counters[list.level] ?? 0) + 1;
      list.literal.counters[list.level] = count;
      const marker =
        list.literal.kinds[list.level] === 'decimal'
          ? `${count}.`
          : BULLETS[list.level % BULLETS.length];
      first.items.unshift({
        kind: 'text',
        text: `${marker} `,
        style: first.mark,
        keep: true,
      });
      first.indentLeft = LIST_INDENT * (list.level + 1);
      first.hanging = LIST_HANGING;
      first.listOwned = true;
    } else if (list) {
      first.numbering = {
        reference: list.reference,
        level: list.level,
        instance: list.instance,
      };
      first.listOwned = true;
    }

    return blocks;
  }

  private table(el: IHtmlElementNode, ctx: ICtx): BlockIR[] {
    const grid = /(^|\s)doc-grid-table(\s|$)/.test(el.attrs.class ?? '');
    const parts = tableParts(el);
    const rows = parts.rows.filter((row) => row.cells.length > 0);
    if (!rows.length) return [];

    const columns = Math.min(
      MAX_COLUMNS,
      rows.reduce(
        (max, row) =>
          Math.max(
            max,
            row.cells.reduce((sum, cell) => sum + colspan(cell), 0),
          ),
        1,
      ),
    );
    const tableTw = Math.max(columns * 15, twips(ctx.maxWidthPx));
    const widths = columnWidths(parts.cols, columns, tableTw);
    const marginTw = grid ? GRID_MARGIN_X * 2 : 0;
    const out: BlockIR[] = [];
    for (const caption of parts.captions) {
      const capCtx = this.elementCtx(caption, parseStyle(caption.attrs.style), {
        ...ctx,
        align: AlignmentType.CENTER,
      });
      append(out, this.blocks(caption.children, capCtx));
    }

    const tableRows = rows.map((row) => {
      const cells: TableCell[] = [];
      let used = 0;
      for (const cell of row.cells) {
        if (used >= columns) break;
        const span = Math.min(colspan(cell), columns - used);
        if (clampInt(cell.attrs.rowspan, 1, 1000) > 1) {
          this.warn(
            'docx-html:rowspan',
            'Merged table rows (rowspan) are not supported in Word exports; cells were rendered unmerged',
          );
        }
        const cellTw = sum(widths.slice(used, used + span));
        used += span;
        cells.push(this.cell(cell, span, cellTw, marginTw, grid, ctx));
      }
      if (used < columns) {
        const rest = columns - used;
        cells.push(
          new TableCell({
            children: [separatorParagraph()],
            columnSpan: rest > 1 ? rest : undefined,
            width: { size: sum(widths.slice(used)), type: WidthType.DXA },
          }),
        );
      }

      return new TableRow({
        children: cells,
        tableHeader: row.header || undefined,
      });
    });

    const line: IBorderOptions = grid
      ? {
          style: BorderStyle.SINGLE,
          size: 6,
          color: this.color(GRID_BORDER_COLOR),
        }
      : { style: BorderStyle.NONE, size: 0, color: 'auto' };
    const marginY = grid ? GRID_MARGIN_Y : 0;
    const marginX = grid ? GRID_MARGIN_X : 0;
    out.push({
      kind: 'table',
      table: new Table({
        rows: tableRows,
        width: { size: tableTw, type: WidthType.DXA },
        columnWidths: widths,
        layout: TableLayoutType.FIXED,
        borders: {
          top: line,
          bottom: line,
          left: line,
          right: line,
          insideHorizontal: line,
          insideVertical: line,
        },
        margins: {
          top: marginY,
          bottom: marginY,
          left: marginX,
          right: marginX,
        },
      }),
    });

    return out;
  }

  private cell(
    cell: IHtmlElementNode,
    span: number,
    cellTw: number,
    marginTw: number,
    grid: boolean,
    ctx: ICtx,
  ): TableCell {
    const th = cell.tag === 'th';
    const align = grid
      ? AlignmentType.LEFT
      : th
        ? AlignmentType.CENTER
        : ctx.align;
    const inner = this.elementCtx(cell, parseStyle(cell.attrs.style), {
      ...ctx,
      align,
      list: undefined,
      maxWidthPx: Math.max(1, (cellTw - marginTw) / 15),
    });

    return new TableCell({
      children: this.materialize(this.blocks(cell.children, inner), true),
      columnSpan: span > 1 ? span : undefined,
      width: { size: cellTw, type: WidthType.DXA },
      // Chromium centres table cell content vertically by default
      verticalAlign: VerticalAlignTable.CENTER,
    });
  }

  private addImage(
    el: IHtmlElementNode,
    css: Record<string, string>,
    ctx: ICtx,
    flow: IFlow,
  ): void {
    const src = (el.attrs.src ?? '').trim();
    if (!src) return;
    const match = DATA_IMAGE.exec(src.replace(/\s+/g, ''));
    if (!match) {
      if (/^data:/i.test(src)) {
        this.warn(
          'docx-html:img-format',
          'Rich-text images in WEBP/SVG/AVIF (or other non PNG/JPEG/GIF/BMP) formats are not embedded in Word exports (skipped)',
        );
      } else {
        this.warn(
          'docx-html:img-url',
          'Rich-text images from URLs are not embedded in Word exports (skipped)',
        );
      }

      return;
    }
    const data = Buffer.from(match[2], 'base64');
    const info = sniffImage(data);
    if (!info) {
      this.warn(
        'docx-html:img-decode',
        'A rich-text image could not be decoded and was skipped in the Word export',
      );

      return;
    }
    const em = ctx.style.sizePx;
    const w0 = positive(
      cssLengthPx(css.width, em, ctx.maxWidthPx) ??
        cssLengthPx(el.attrs.width, em, ctx.maxWidthPx),
    );
    const h0 = positive(
      cssLengthPx(css.height, em) ?? cssLengthPx(el.attrs.height, em),
    );
    let w =
      w0 ?? (h0 !== undefined ? (h0 * info.width) / info.height : info.width);
    let h =
      h0 ?? (w0 !== undefined ? (w0 * info.height) / info.width : info.height);
    if (w > ctx.maxWidthPx) {
      h = (h * ctx.maxWidthPx) / w;
      w = ctx.maxWidthPx;
    }
    flow.items.push({
      kind: 'image',
      run: new ImageRun({
        type: info.type,
        data,
        transformation: {
          width: Math.max(1, Math.round(w)),
          height: Math.max(1, Math.round(h)),
        },
      }),
      link: ctx.link,
    });
  }

  // IR → docx; separators keep adjacent tables from merging, cells must end with a paragraph
  private materialize(
    blocks: readonly BlockIR[],
    cell: boolean,
  ): DocxHtmlBlock[] {
    const out: DocxHtmlBlock[] = [];
    for (const block of blocks) {
      const docxBlock =
        block.kind === 'table' ? block.table : this.toParagraph(block);
      if (docxBlock instanceof Table && out[out.length - 1] instanceof Table) {
        out.push(separatorParagraph());
      }
      out.push(docxBlock);
    }
    if (!out.length) {
      out.push(
        cell
          ? separatorParagraph()
          : this.toParagraph(this.para(this.rootCtx(), [])),
      );
    } else if (out[out.length - 1] instanceof Table) {
      out.push(separatorParagraph());
    }

    return out;
  }

  private toParagraph(p: IParaIR): Paragraph {
    const children: ParagraphChild[] = [];
    for (let k = 0; k < p.items.length; ) {
      const link = p.items[k].link;
      if (!link) {
        children.push(this.toRun(p.items[k]));
        k++;
        continue;
      }
      const runs: ParagraphChild[] = [];
      while (k < p.items.length && p.items[k].link === link) {
        runs.push(this.toRun(p.items[k]));
        k++;
      }
      children.push(new ExternalHyperlink({ link: link.href, children: runs }));
    }
    if (p.numbering) this.opts.numbering.markUsed(p.numbering.reference);
    const mark: IParagraphRunOptions = p.rule
      ? { size: 2 }
      : {
          font: p.mark.font,
          size: halfPoints(p.mark.sizePx),
          bold: p.mark.bold,
          color: p.mark.color,
        };

    return new Paragraph({
      children,
      alignment: p.align,
      spacing: { before: p.before, after: p.after, ...this.lineSpacing(p) },
      outlineLevel: p.outlineLevel,
      numbering: p.numbering,
      indent:
        p.indentLeft !== undefined && !p.numbering
          ? {
              left: p.indentLeft,
              ...(p.hanging ? { hanging: p.hanging } : {}),
            }
          : undefined,
      border: p.rule
        ? {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 6,
              color: this.color(RULE_COLOR),
              space: 1,
            },
          }
        : undefined,
      // paragraph-mark style also formats the list marker and empty-line height
      run: mark,
    });
  }

  private toRun(item: InlineItem): ParagraphChild {
    if (item.kind === 'image') return item.run;
    const s = item.style;
    const options: IRunOptions = {
      font: s.font,
      size: halfPoints(s.sizePx),
      bold: s.bold,
      italics: s.italics || undefined,
      underline: s.underline ? { type: UnderlineType.SINGLE } : undefined,
      strike: s.strike || undefined,
      color: s.color,
      highlight: s.highlight ? HighlightColor.YELLOW : undefined,
      shading: s.shading
        ? { type: ShadingType.CLEAR, fill: s.shading, color: 'auto' }
        : undefined,
      subScript: s.sub || undefined,
      superScript: s.sup || undefined,
    };

    return item.kind === 'break'
      ? new TextRun({ ...options, break: 1 })
      : new TextRun({ ...options, text: xmlSafe(item.text) });
  }

  private lineSpacing(p: IParaIR): ISpacingProperties {
    const lh = this.opts.lineHeight;
    if (lh === undefined || !Number.isFinite(lh) || p.rule) return {};
    const m = Math.max(lh, 1);
    if (p.items.some((item) => item.kind === 'image')) {
      return { line: Math.round(240 * m), lineRule: LineRuleType.AUTO };
    }
    let px = 0;
    for (const item of p.items) {
      if (item.kind !== 'image') px = Math.max(px, item.style.sizePx);
    }

    return {
      line: Math.round(m * (px || p.mark.sizePx) * 15),
      lineRule: LineRuleType.EXACT,
    };
  }
}

// HTML whitespace rules: collapse across runs, trim at line start/end (kept runs untouched)
function normalizeWhitespace(items: readonly InlineItem[]): InlineItem[] {
  const out: InlineItem[] = [];
  let space = true;
  for (const item of items) {
    if (item.kind !== 'text') {
      if (item.kind === 'break') trimTrailing(out);
      out.push(item);
      space = item.kind === 'break';
      continue;
    }
    if (item.keep) {
      out.push(item);
      space = false;
      continue;
    }
    const text = space ? item.text.replace(/^ /, '') : item.text;
    if (!text) continue;
    out.push(text === item.text ? item : { ...item, text });
    space = text.endsWith(' ');
  }
  trimTrailing(out);

  return out;
}

function trimTrailing(out: InlineItem[]): void {
  for (let k = out.length - 1; k >= 0; k--) {
    const item = out[k];
    if (item.kind !== 'text' || item.keep) return;
    const text = item.text.replace(/ +$/, '');
    if (text) {
      out[k] = { ...item, text };

      return;
    }
    out.splice(k, 1);
  }
}

function pad(blocks: BlockIR[], before: number, after: number): void {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (first?.kind === 'p') first.before = Math.max(first.before, before);
  if (last?.kind === 'p') last.after = Math.max(last.after, after);
}

// push(...items) overflows the stack on very large arrays
function append<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

// Marker kind per nesting depth, first seen wins (tables start their own lists)
function listSignature(list: IHtmlElementNode): DocxListKind[] {
  const kinds: DocxListKind[] = [];
  const stack: [HtmlNode, number][] = [[list, 0]];
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const [node, depth] = entry;
    if (
      node.type !== 'element' ||
      node.tag === 'table' ||
      depth > MAX_LIST_LEVEL
    ) {
      continue;
    }
    let childDepth = depth;
    if (node.tag === 'ul' || node.tag === 'ol') {
      kinds[depth] ??= node.tag === 'ol' ? 'decimal' : 'bullet';
      childDepth = depth + 1;
    }
    for (let k = node.children.length - 1; k >= 0; k--) {
      stack.push([node.children[k], childDepth]);
    }
  }

  return kinds;
}

function listStart(value: string | undefined): number {
  const n = parseInt(value ?? '', 10);

  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 32767) : 1;
}

function colspan(cell: IHtmlElementNode): number {
  return clampInt(cell.attrs.colspan, 1, MAX_COLUMNS);
}

function childElements(
  node: IHtmlElementNode,
  ...tags: string[]
): IHtmlElementNode[] {
  return node.children.filter(
    (child): child is IHtmlElementNode =>
      child.type === 'element' && tags.includes(child.tag),
  );
}

// Rows of THIS table only, in visual order: thead, body, tfoot
function tableParts(table: IHtmlElementNode): {
  rows: { cells: IHtmlElementNode[]; header: boolean }[];
  captions: IHtmlElementNode[];
  cols: IHtmlElementNode[];
} {
  const head: IHtmlElementNode[] = [];
  const body: IHtmlElementNode[] = [];
  const foot: IHtmlElementNode[] = [];
  const captions: IHtmlElementNode[] = [];
  const cols: IHtmlElementNode[] = [];
  for (const child of table.children) {
    if (child.type !== 'element') continue;
    switch (child.tag) {
      case 'tr':
        body.push(child);
        break;
      case 'thead':
        append(head, childElements(child, 'tr'));
        break;
      case 'tbody':
        append(body, childElements(child, 'tr'));
        break;
      case 'tfoot':
        append(foot, childElements(child, 'tr'));
        break;
      case 'caption':
        captions.push(child);
        break;
      case 'colgroup':
        append(cols, childElements(child, 'col'));
        break;
      case 'col':
        cols.push(child);
        break;
      default:
        break;
    }
  }
  const toRow = (tr: IHtmlElementNode, header: boolean) => ({
    cells: childElements(tr, 'td', 'th'),
    header,
  });

  return {
    rows: [
      ...head.map((tr) => toRow(tr, true)),
      ...body.map((tr) => toRow(tr, false)),
      ...foot.map((tr) => toRow(tr, false)),
    ],
    captions,
    cols,
  };
}

// Equal split, or proportional when every <col> has a px width; sums exactly to tableTw
function columnWidths(
  cols: readonly IHtmlElementNode[],
  columns: number,
  tableTw: number,
): number[] {
  const px: number[] = [];
  for (const col of cols) {
    const width = positive(
      cssLengthPx(parseStyle(col.attrs.style).width, 16) ??
        cssLengthPx(col.attrs.width, 16),
    );
    for (let k = clampInt(col.attrs.span, 1, MAX_COLUMNS); k > 0; k--) {
      px.push(width ?? 0);
    }
  }
  const split = (weights: readonly number[]): number[] => {
    const total = sum(weights);
    const widths = weights.map((w) => Math.floor((tableTw * w) / total));
    widths[widths.length - 1] += tableTw - sum(widths);

    return widths;
  };
  const equal = split(new Array<number>(columns).fill(1));
  if (px.length !== columns || px.some((w) => w <= 0)) return equal;
  const proportional = split(px);

  return proportional.some((w) => w < 15) ? equal : proportional;
}

function fallbackBlocks(
  text: () => string,
  opts: IDocxHtmlOptions,
): DocxHtmlBlock[] {
  try {
    opts.warn(
      'docx-html:fallback',
      'Rich text could not be converted for Word; exported as plain text',
    );
  } catch {
    // the warn sink must never break the export
  }
  try {
    let value = text();
    try {
      if (opts.interpolate) value = opts.interpolate(value);
    } catch {
      // keep the raw tokens
    }
    const lines = value
      .split(NEWLINE)
      .map((line) => line.replace(/[ \t\r\f]+/g, ' ').trim());
    while (lines.length > 1 && !lines[0]) lines.shift();
    while (lines.length > 1 && !lines[lines.length - 1]) lines.pop();
    const size = halfPoints(positive(opts.base.sizePx) ?? 16);
    const run = {
      font: xmlSafe(opts.base.font || 'Arial'),
      size,
      bold: opts.base.bold,
      color: opts.base.color,
    };

    return lines.map(
      (line) =>
        new Paragraph({
          children: line ? [new TextRun({ ...run, text: xmlSafe(line) })] : [],
          alignment: opts.align,
          spacing: { before: 0, after: 0 },
          run,
        }),
    );
  } catch {
    return [new Paragraph({ children: [] })];
  }
}

/** Renders parsed nodes to docx blocks; never throws (falls back to plain text). */
export function renderHtmlNodes(
  nodes: readonly HtmlNode[],
  opts: IDocxHtmlOptions,
): DocxHtmlBlock[] {
  try {
    return new DocxHtmlRenderer(opts).render(nodes);
  } catch {
    return fallbackBlocks(() => nodesText(nodes, true), opts);
  }
}

/** = renderHtmlNodes(parseHtml(html), opts); never throws. */
export function renderHtmlBlocks(
  html: string,
  opts: IDocxHtmlOptions,
): DocxHtmlBlock[] {
  let nodes: HtmlNode[];
  try {
    nodes = parseHtml(html);
  } catch {
    return fallbackBlocks(() => htmlToText(html), opts);
  }

  return renderHtmlNodes(nodes, opts);
}
