/**
 * @fileoverview Confluence storage-XHTML → XI-CIR.
 *
 * Parsed with jsdom in HTML mode (lenient; preserves the namespaced `ac:`/`ri:` tags, decodes
 * entities, and surfaces `ac:plain-text-body` CDATA as a comment node). Standard XHTML structure
 * plus the Confluence-specific constructs:
 *   ac:image + ri:attachment → media(filename)   ac:link + ri:user → userMention
 *   ac:link + ri:page        → pageLink           ac:task-list      → taskList
 *   ac:layout*               → flatten cells      ac:structured-macro → hooks.onMacro
 * Every `ac:structured-macro` is dispatched through `hooks.onMacro` (Milestone A returns a
 * `[Macro deferred]` placeholder; Milestone B's macro registry overrides it).
 */

import * as jsdomModule from 'jsdom';
import type {
  CirDoc,
  CirMark,
  CirNode,
  CirTableCell,
  ParsedMacro,
} from './canonical-ir';

/** Minimal structural view of jsdom nodes — avoids depending on the global DOM lib. */
interface XNode {
  nodeType: number;
  childNodes: ArrayLike<XNode>;
  textContent: string | null;
  data?: string;
}

/** Typed jsdom handle (the package's own types aren't resolvable under this tsconfig). */
interface JsdomInstance {
  window: { document: { body: XElement } };
}
type JsdomCtor = new (html: string) => JsdomInstance;
const JSDOM = (jsdomModule as unknown as { JSDOM: JsdomCtor }).JSDOM;

export interface XElement extends XNode {
  tagName: string;
  getAttribute(name: string): string | null;
}

export interface StorageParseHooks {
  /** Dispatch a normalised macro to the registry. Returns null to omit it entirely. */
  onMacro: (macro: ParsedMacro) => CirNode | CirNode[] | null;
  /** Optional lossy-conversion logger. */
  log?: (message: string, meta?: Record<string, unknown>) => void;
  /** Internal: current macro-nesting depth (guards unbounded recursion). Callers leave it unset. */
  macroDepth?: number;
}

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;
const NODE_COMMENT = 8;

const HEADING_TAGS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

const MARK_BY_TAG: Record<string, CirMark> = {
  strong: 'strong',
  b: 'strong',
  em: 'em',
  i: 'em',
  u: 'underline',
  s: 'strike',
  del: 'strike',
  strike: 'strike',
  code: 'code',
  sub: 'subscript',
  sup: 'superscript',
};

/** Keep only colour values the TipTap write gate can canonically validate. */
function textColor(style: string | null): string | undefined {
  const match = /(?:^|;)\s*color\s*:\s*([^;]+?)\s*(?=;|$)/i.exec(style ?? '');
  const value = match?.[1]?.trim();

  // `url(...)`, CSS variables, and arbitrary style expressions are not colours. The final
  // canonicalisation happens in the shared TipTap validator; this guard prevents preserving a
  // non-colour declaration as if it were user text styling.
  if (
    !value ||
    value.length > 128 ||
    !/^(?:#[0-9a-f]{3,8}|[a-z]{1,30}|rgba?\([^()]{1,100}\))$/i.test(value)
  ) {
    return undefined;
  }

  return value;
}

function tag(el: XNode): string {
  return (el as XElement).tagName?.toLowerCase() ?? '';
}

function isElement(n: XNode): n is XElement {
  return n.nodeType === NODE_ELEMENT;
}

function children(n: XNode): XNode[] {
  return Array.from(n.childNodes);
}

/** Extract `ac:plain-text-body` text — content arrives as a CDATA comment or plain text.
 *  Exported for the Milestone-B macro registry (code/noformat macros). */
export function plainTextBody(el: XNode): string {
  let out = '';

  for (const c of children(el)) {
    if (c.nodeType === NODE_TEXT) out += c.data ?? c.textContent ?? '';
    else if (c.nodeType === NODE_COMMENT) {
      const raw = c.data ?? '';
      const m = /^\[CDATA\[([\s\S]*)\]\]$/.exec(raw);

      out += m ? m[1] : raw;
    } else if (isElement(c)) out += c.textContent ?? '';
  }

  return out;
}

/**
 * Confluence storage is XHTML and emits body-less macros/refs SELF-CLOSED
 * (`<ac:structured-macro ac:name="toc" />`, `<ri:page ... />`). We parse with jsdom in HTML mode
 * (for entity decoding + lenient namespaced tags), where `/>` is MEANINGLESS for unknown elements:
 * the element stays OPEN and adopts every following sibling as its children — silently destroying
 * the rest of the page after the first self-closing macro. Expand them to explicit open/close pairs
 * first. The attribute matcher skips quoted values so a `>` or `/` inside an attribute is safe.
 *
 * Plain-HTML `<time datetime="…" />` (Confluence date lozenges) has the same problem: `time` is
 * not a void element, so in HTML mode the REST of the block is swallowed as the date's children
 * and every date after the first text run in that block was lost. `time` is the only non-namespaced
 * element Confluence storage writes self-closed; genuine labelled dates use an explicit close tag
 * and never match the `/>` form.
 */
export function expandSelfClosingTags(xhtml: string): string {
  return xhtml.replace(
    /<((?:ac|ri):[A-Za-z0-9-]+|time)((?:[^>"']|"[^"]*"|'[^']*')*?)\/>/g,
    '<$1$2></$1>',
  );
}

/**
 * HTML parsing mangles `<![CDATA[…]]>`: it becomes a *bogus comment* that ENDS at the first `>`, so
 * a code macro containing `>` / `->` / `=>` / generics is split across a comment + text nodes AND
 * loses the `>` itself (it's consumed as the comment terminator) — unrecoverable from the DOM.
 * Convert CDATA sections to escaped text BEFORE parsing so jsdom sees one plain text node and
 * decodes it back for us. Runs BEFORE self-closing expansion so markup inside CDATA stays inert.
 */
export function inlineCdataSections(xhtml: string): string {
  return xhtml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, body: string) =>
    body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  );
}

export function storageToCir(xhtml: string, hooks: StorageParseHooks): CirDoc {
  const body = storageBody(xhtml);

  return { type: 'doc', children: blockNodes(body, hooks) };
}

function storageBody(xhtml: string): XElement {
  const prepared = expandSelfClosingTags(inlineCdataSections(xhtml));
  const dom = new JSDOM(`<body>${prepared}</body>`);

  return dom.window.document.body;
}

export interface StorageUserRef {
  sourceId: string;
  lookup: 'key' | 'username';
}

function storageUserRef(el: XElement): StorageUserRef | null {
  const key = el.getAttribute('ri:userkey') ?? el.getAttribute('ri:account-id');

  if (key) return { sourceId: key, lookup: 'key' };

  const username = el.getAttribute('ri:username');

  return username ? { sourceId: username, lookup: 'username' } : null;
}

/** Stable user refs from any storage location, including task bodies and macro parameters. */
export function collectStorageUserRefs(xhtml: string): StorageUserRef[] {
  const refs = new Map<string, StorageUserRef>();
  const walk = (node: XNode): void => {
    for (const child of children(node)) {
      if (!isElement(child)) continue;

      if (tag(child) === 'ri:user') {
        const ref = storageUserRef(child);

        if (ref && !refs.has(ref.sourceId)) refs.set(ref.sourceId, ref);
      }

      walk(child);
    }
  };

  walk(storageBody(xhtml));

  return [...refs.values()];
}

/** Block-level walk: each child element becomes 0+ block nodes; loose text → a paragraph. */
function blockNodes(parent: XNode, hooks: StorageParseHooks): CirNode[] {
  const out: CirNode[] = [];
  let pendingInline: CirNode[] = [];

  const flush = (): void => {
    const trimmed = pendingInline.filter(
      (n) => !(n.type === 'text' && !n.text.trim()),
    );

    if (trimmed.length > 0)
      out.push({ type: 'paragraph', children: pendingInline });

    pendingInline = [];
  };

  for (const node of children(parent)) {
    if (node.nodeType === NODE_TEXT) {
      const text = node.data ?? node.textContent ?? '';

      if (text.trim()) pendingInline.push({ type: 'text', text });

      continue;
    }

    if (!isElement(node)) continue;

    const name = tag(node);

    // Inline-level elements accumulate into a wrapping paragraph.
    if (isInlineTag(name)) {
      pendingInline.push(...inlineElement(node, hooks, []));
      continue;
    }

    flush();

    const block = blockElement(node, name, hooks);

    if (block) out.push(...block);
  }

  flush();

  return out;
}

function isInlineTag(name: string): boolean {
  return (
    name in MARK_BY_TAG ||
    name === 'a' ||
    name === 'br' ||
    name === 'span' ||
    name === 'ac:link' ||
    name === 'ac:image' ||
    name === 'ac:emoticon' ||
    name === 'ac:inline-comment-marker' ||
    name === 'time'
  );
}

/** `text-align` from a style attribute, mapped to the CIR align vocabulary. */
function blockAlign(el: XElement): 'center' | 'right' | 'justify' | undefined {
  const style = el.getAttribute('style') ?? '';
  const match = /(?:^|;)\s*text-align\s*:\s*([^;]+?)\s*(?=;|$)/i.exec(style);
  const value = match?.[1]?.toLowerCase();

  if (value === 'center' || value === 'right' || value === 'justify') {
    return value;
  }

  // `left` is the default everywhere downstream, so it needs no attribute.
  return undefined;
}

function blockElement(
  el: XElement,
  name: string,
  hooks: StorageParseHooks,
): CirNode[] | null {
  if (name === 'p') {
    const align = blockAlign(el);

    return [
      {
        type: 'paragraph',
        children: inlineNodes(el, hooks, []),
        ...(align ? { align } : {}),
      },
    ];
  }

  if (name in HEADING_TAGS) {
    const align = blockAlign(el);

    return [
      {
        type: 'heading',
        level: HEADING_TAGS[name],
        children: inlineNodes(el, hooks, []),
        ...(align ? { align } : {}),
      },
    ];
  }

  if (name === 'ul' || name === 'ol') {
    const items = children(el)
      .filter((c) => isElement(c) && tag(c) === 'li')
      .map((li) => blockNodes(li, hooks));

    // Only an EXPLICIT start attribute may set `start`: `Number(null ?? '')` is
    // 0, and a plain `<ol>` used to come through as `start: 0`, rendering "0."
    // as the first marker.
    const rawStart = el.getAttribute('start');
    const start = rawStart === null ? NaN : Number(rawStart);

    return [
      {
        type: 'list',
        ordered: name === 'ol',
        items,
        ...(name === 'ol' && Number.isInteger(start) && start >= 0
          ? { start }
          : {}),
      },
    ];
  }

  if (name === 'blockquote') {
    return [{ type: 'blockquote', children: blockNodes(el, hooks) }];
  }

  if (name === 'pre') {
    return [{ type: 'codeBlock', text: el.textContent ?? '' }];
  }

  if (name === 'hr') return [{ type: 'rule' }];

  if (name === 'table') return [parseTable(el, hooks)];

  if (name === 'div' || name === 'section') {
    // Flatten wrapper divs (Confluence uses them for content-layout).
    return blockNodes(el, hooks);
  }

  // Editor-only hint text ("Type here…") — never real content.
  if (name === 'ac:placeholder') return null;

  if (name === 'ac:structured-macro' || name === 'ac:macro') {
    const result = hooks.onMacro(buildParsedMacro(el, hooks));

    if (!result) return null;

    return Array.isArray(result) ? result : [result];
  }

  if (name === 'ac:task-list') return [parseTaskList(el, hooks)];

  if (name === 'ac:layout') {
    // Each `ac:layout-section` is a ROW of columns. Concatenating cells across sections merged
    // e.g. a two-column section + a full-width section into one bogus 3-column row, so emit one
    // layout node per section and keep their order.
    const sections = collectLayoutSections(el);
    const out: CirNode[] = [];

    for (const { cells, widths } of sections) {
      if (cells.length === 0) continue;

      // A single-cell section is a full-width row, not a layout → keep its blocks inline.
      if (cells.length === 1) out.push(...blockNodes(cells[0], hooks));
      else
        out.push({
          type: 'layout',
          columns: cells.map((c) => blockNodes(c, hooks)),
          ...(widths?.length === cells.length ? { widths } : {}),
        });
    }

    // No recognisable sections/cells → don't lose the body.
    return out.length > 0 ? out : blockNodes(el, hooks);
  }

  if (name === 'ac:layout-section' || name === 'ac:layout-cell') {
    // Standalone (not under ac:layout) → flatten.
    return blockNodes(el, hooks);
  }

  if (name === 'ac:image' || name === 'ac:link') {
    // Block-context inline element → wrap in a paragraph.
    return [{ type: 'paragraph', children: inlineNodes(el, hooks, []) }];
  }

  // Unknown block element: recurse so its content is never lost.
  return blockNodes(el, hooks);
}

/** Inline walk carrying accumulated marks down text runs. */
function inlineNodes(
  parent: XNode,
  hooks: StorageParseHooks,
  marks: CirMark[],
): CirNode[] {
  const out: CirNode[] = [];

  for (const node of children(parent)) {
    if (node.nodeType === NODE_TEXT) {
      const text = node.data ?? node.textContent ?? '';

      if (text)
        out.push({
          type: 'text',
          text,
          marks: marks.length ? [...marks] : undefined,
        });

      continue;
    }

    if (!isElement(node)) continue;

    out.push(...inlineElement(node, hooks, marks));
  }

  return out;
}

/**
 * Convert ONE inline element to 0+ inline CIR nodes, applying `marks`.
 *
 * This used to live inside `inlineNodes`' loop, and the block-level walker
 * (`blockNodes`) called `inlineNodes` directly on an inline child. That treated
 * the element as a CONTAINER and walked its children, so an `<a>` (or a
 * coloured `<span>`, `ac:image`, `ac:link`, emoticon) sitting directly inside
 * `<li>` / `<div>` / a table cell lost its own semantics and degraded to bare
 * text. Splitting the per-element handling out lets both walkers share it.
 */
function inlineElement(
  el: XElement,
  hooks: StorageParseHooks,
  marks: CirMark[],
): CirNode[] {
  const out: CirNode[] = [];
  const name = tag(el);

  if (name === 'br') {
    out.push({ type: 'hardBreak' });
    return out;
  }

  if (name in MARK_BY_TAG) {
    return inlineNodes(el, hooks, [...marks, MARK_BY_TAG[name]]);
  }

  if (name === 'span' || name === 'ac:inline-comment-marker') {
    const color =
      name === 'span' ? textColor(el.getAttribute('style')) : undefined;
    const inner = inlineNodes(el, hooks, marks);

    if (!color) return inner;

    // Colour applies to every text run beneath the span, including runs nested
    // inside containers such as a link (`<span style=color><a>text</a></span>`).
    const paint = (nodes: CirNode[]): CirNode[] =>
      nodes.map((child) => {
        if (child.type === 'text') return { ...child, color };

        const kids = (child as { children?: CirNode[] }).children;

        return Array.isArray(kids)
          ? { ...child, children: paint(kids) }
          : child;
      });

    return paint(inner);
  }

  if (name === 'time') {
    // Confluence dates are usually EMPTY elements carrying the value in @datetime. In HTML mode
    // jsdom can attach the following whitespace to a self-closed <time>, so whitespace is not
    // evidence of a visible date body.
    const inner = inlineNodes(el, hooks, marks);
    const datetime = el.getAttribute('datetime');
    const timestamp = datetime ? Date.parse(datetime) : NaN;

    if (inner.some((child) => child.type !== 'text' || child.text.trim())) {
      return inner;
    }

    if (Number.isFinite(timestamp)) {
      out.push({ type: 'date', timestamp: String(timestamp) });
    } else if (datetime) {
      // Invalid source dates still remain readable rather than vanishing.
      out.push({
        type: 'text',
        text: datetime,
        marks: marks.length ? [...marks] : undefined,
      });
    }

    return out;
  }

  // Editor-only hint text — never real content.
  if (name === 'ac:placeholder') return out;

  if (name === 'a') {
    const href = (el.getAttribute('href') ?? '').trim();

    // An `<a>` with no href is a BOOKMARK TARGET (`<a name="_Toc123">`), not a
    // link. Word-exported documents pasted into Confluence are full of them.
    // Emitting a link node anyway produced `href: ''`, which the write gate
    // refuses — and because it refuses the whole DOCUMENT, one such anchor
    // cost a customer 214 of their 216 pages. Keep the text, drop the wrapper.
    //
    // Fixed here, in the CIR producer, so both consumers benefit: the TipTap
    // path (`cir-to-tiptap.ts`) and the HTML path (`cir-serializer.ts`), which
    // until now turned these into a junk `href="#"`.
    if (!href) return inlineNodes(el, hooks, marks);

    out.push({
      type: 'link',
      href,
      children: inlineNodes(el, hooks, marks),
    });
    return out;
  }

  if (name === 'ac:image') {
    const media = parseAcImage(el);

    if (media) out.push(media);
    return out;
  }

  if (name === 'ac:link') {
    return parseAcLink(el, hooks, marks);
  }

  if (name === 'ac:emoticon') {
    const alt =
      el.getAttribute('ac:emoji-fallback') ??
      CONFLUENCE_EMOTICONS[(el.getAttribute('ac:name') ?? '').toLowerCase()] ??
      '';

    if (alt) out.push({ type: 'text', text: alt });
    return out;
  }

  if (name === 'ac:structured-macro' || name === 'ac:macro') {
    // An inline macro — resolve through the registry, best-effort inline.
    const macro = hooks.onMacro(buildParsedMacro(el, hooks));

    if (macro) out.push(...(Array.isArray(macro) ? macro : [macro]));
    return out;
  }

  // Unknown inline element: keep its text.
  return inlineNodes(el, hooks, marks);
}

function parseAcImage(el: XElement): CirNode | null {
  const width = el.getAttribute('ac:width') ?? undefined;
  const height = el.getAttribute('ac:height') ?? undefined;
  const alt = el.getAttribute('ac:alt') ?? undefined;
  const rawAlign = el.getAttribute('ac:align')?.toLowerCase();
  const align =
    rawAlign === 'left' || rawAlign === 'center' || rawAlign === 'right'
      ? rawAlign
      : undefined;

  for (const c of children(el)) {
    if (!isElement(c)) continue;

    const cname = tag(c);

    if (cname === 'ri:attachment') {
      const filename = c.getAttribute('ri:filename') ?? undefined;

      return {
        type: 'media',
        kind: 'image',
        filename,
        alt,
        width,
        height,
        ...(align ? { align } : {}),
      };
    }

    if (cname === 'ri:url') {
      const src = c.getAttribute('ri:value') ?? undefined;

      return {
        type: 'media',
        kind: 'image',
        src,
        alt,
        width,
        height,
        ...(align ? { align } : {}),
      };
    }
  }

  return null;
}

function parseAcLink(
  el: XElement,
  hooks: StorageParseHooks,
  marks: CirMark[],
): CirNode[] {
  const bodyText = (): string =>
    children(el)
      .filter(
        (c) =>
          c.nodeType === NODE_TEXT ||
          (isElement(c) && tag(c) === 'ac:link-body') ||
          (isElement(c) && tag(c) === 'ac:plain-text-link-body'),
      )
      .map((c) => c.textContent ?? '')
      .join('')
      .trim();

  for (const c of children(el)) {
    if (!isElement(c)) continue;

    const cname = tag(c);

    if (cname === 'ri:user') {
      const sourceId = storageUserRef(c)?.sourceId ?? '';

      if (sourceId)
        return [
          {
            type: 'userMention',
            sourceId,
            displayName: bodyText() || undefined,
          },
        ];
    }

    if (cname === 'ri:page') {
      const title = c.getAttribute('ri:content-title') ?? '';
      const sourceSpaceKey = c.getAttribute('ri:space-key') ?? undefined;
      const fragment = el.getAttribute('ac:anchor')?.replace(/^#/, '').trim();

      // Storage refs pages by TITLE (no id). Milestone B builds a title→id index; for now
      // the pageLink resolver misses → renders as plain text (never dropped).
      if (title)
        return [
          {
            type: 'pageLink',
            pageSourceId: title,
            ...(sourceSpaceKey ? { sourceSpaceKey } : {}),
            ...(fragment ? { fragment } : {}),
            text: bodyText() || title,
          },
        ];
    }

    if (cname === 'ri:attachment') {
      const filename = c.getAttribute('ri:filename') ?? '';

      // Reuse `media`: attachment resolution intentionally only walks this node type. A file
      // card is rendered after the attachment stage fills its crosswalk entry.
      if (filename) return [{ type: 'media', kind: 'file', filename }];
    }
  }

  // Plain link body with no recognized ri:* target → keep the inline text.
  const inner = inlineNodes(el, hooks, marks).filter(
    (n) => n.type !== 'text' || n.text.trim(),
  );

  return inner.length ? inner : [];
}

function parseTaskList(
  el: XElement,
  hooks: StorageParseHooks,
): Extract<CirNode, { type: 'taskList' }> {
  const items = children(el)
    .filter((c) => isElement(c) && tag(c) === 'ac:task')
    .map((taskEl) => {
      let checked = false;
      let bodyChildren: CirNode[] = [];

      for (const c of children(taskEl)) {
        if (!isElement(c)) continue;

        const cname = tag(c);

        if (cname === 'ac:task-status') {
          checked = (c.textContent ?? '').trim() === 'complete';
        } else if (cname === 'ac:task-body') {
          bodyChildren = inlineNodes(c, hooks, []);
        }
      }

      return { checked, children: bodyChildren };
    });

  return { type: 'taskList', items };
}

function parseTable(
  el: XElement,
  hooks: StorageParseHooks,
): Extract<CirNode, { type: 'table' }> {
  const rows: { cells: CirTableCell[] }[] = [];

  const collectRows = (container: XNode): void => {
    for (const c of children(container)) {
      if (!isElement(c)) continue;

      const cname = tag(c);

      if (cname === 'thead' || cname === 'tbody' || cname === 'tfoot') {
        collectRows(c);
      } else if (cname === 'tr') {
        const cells: CirTableCell[] = [];

        for (const cellEl of children(c)) {
          if (!isElement(cellEl)) continue;

          const cellName = tag(cellEl);

          if (cellName !== 'td' && cellName !== 'th') continue;

          cells.push({
            header: cellName === 'th',
            children: blockNodes(cellEl, hooks),
            colspan: Number(cellEl.getAttribute('colspan') ?? '') || undefined,
            rowspan: Number(cellEl.getAttribute('rowspan') ?? '') || undefined,
          });
        }

        rows.push({ cells });
      }
    }
  };

  collectRows(el);

  return { type: 'table', rows };
}

/** Milestone A default: any macro → a visible, logged placeholder (never silently dropped). */
export function deferredMacro(macroName: string): CirNode {
  return { type: 'macroDeferred', name: macroName };
}

/**
 * Normalise an `ac:structured-macro` element into a source-agnostic `ParsedMacro`:
 * `ac:parameter` name→value, `ac:rich-text-body` parsed to CIR (nested macros resolved through the
 * same hooks), and `ac:plain-text-body` extracted as text (code/noformat macros).
 */
/** Hard cap on macro nesting — customer-authored bodies are untrusted input; unbounded
 *  `blockNodes → onMacro → buildParsedMacro → blockNodes` recursion can blow the stack. */
const MAX_MACRO_DEPTH = 25;

/**
 * An `ac:parameter`'s value is EITHER text OR a nested `ri:*` reference element whose textContent is
 * empty (`<ac:parameter ac:name="user"><ri:user ri:userkey="…"/></ac:parameter>`). Reading only
 * textContent silently yielded `''` → `profile` mentions dropped and `include` targets lost.
 */
const CONFLUENCE_EMOTICONS: Record<string, string> = {
  'blue-star': '⭐',
  cheeky: '😜',
  cross: '❌',
  'green-star': '⭐',
  information: 'ℹ️',
  laugh: '😄',
  'light-off': '💡',
  'light-on': '💡',
  minus: '➖',
  plus: '➕',
  question: '❓',
  'red-star': '⭐',
  sad: '😞',
  smile: '🙂',
  'thumbs-down': '👎',
  'thumbs-up': '👍',
  tick: '✅',
  warning: '⚠️',
  wink: '😉',
  'yellow-star': '⭐',
};

function paramValue(el: XElement): string {
  const text = (el.textContent ?? '').trim();

  if (text) return text;

  const findReference = (node: XNode): string => {
    for (const c of children(node)) {
      if (!isElement(c)) continue;

      switch (tag(c)) {
        case 'ri:user':
          return storageUserRef(c)?.sourceId ?? '';
        case 'ri:page':
          return c.getAttribute('ri:content-title') ?? '';
        case 'ri:url':
          return c.getAttribute('ri:value') ?? '';
        case 'ri:space':
          return c.getAttribute('ri:space-key') ?? '';
        case 'ri:attachment':
          return c.getAttribute('ri:filename') ?? '';
        default:
          break;
      }

      const nested = findReference(c);
      if (nested) return nested;
    }
    return '';
  };

  return findReference(el);
}

function pageReferenceAttrs(
  node: XNode,
): { pageId?: string; spaceKey?: string } | null {
  for (const child of children(node)) {
    if (!isElement(child)) continue;
    if (tag(child) === 'ri:page') {
      const pageId = child.getAttribute('ri:content-id')?.trim();
      const spaceKey = child.getAttribute('ri:space-key')?.trim();

      return {
        ...(pageId ? { pageId } : {}),
        ...(spaceKey ? { spaceKey } : {}),
      };
    }

    const nested = pageReferenceAttrs(child);
    if (nested) return nested;
  }

  return null;
}

function buildParsedMacro(el: XElement, hooks: StorageParseHooks): ParsedMacro {
  const name = (el.getAttribute('ac:name') ?? 'unknown').toLowerCase();
  const params: Record<string, string> = {};
  const richBody: CirNode[] = [];
  let plainBody = '';
  let pageReference: ParsedMacro['pageReference'];

  const depth = (hooks.macroDepth ?? 0) + 1;

  const tooDeep = (): boolean => {
    if (depth <= MAX_MACRO_DEPTH) return false;

    hooks.log?.('macro nesting exceeded the depth cap — body dropped', {
      macroName: name,
      depth,
    });

    return true;
  };

  for (const c of children(el)) {
    if (!isElement(c)) continue;

    const cname = tag(c);

    if (cname === 'ac:parameter') {
      // Confluence uses an UNNAMED parameter for a macro's default argument (include/excerpt-include
      // target) — key it as '' rather than discarding it.
      params[c.getAttribute('ac:name') ?? ''] = paramValue(c);

      // Keep the legacy title value above for every existing consumer. Include macros alone also
      // retain the stable/source-space parts needed to avoid a collision-prone bare-title relink.
      if (name === 'include' || name === 'excerpt-include') {
        const reference = pageReferenceAttrs(c);
        const title = params[c.getAttribute('ac:name') ?? ''];
        if (reference && title) {
          pageReference = {
            title,
            ...(reference.pageId ? { sourceId: reference.pageId } : {}),
            ...(reference.spaceKey
              ? { sourceSpaceKey: reference.spaceKey }
              : {}),
          };
        }
      }
    } else if (cname === 'ac:rich-text-body') {
      if (!tooDeep())
        richBody.push(...blockNodes(c, { ...hooks, macroDepth: depth }));
    } else if (cname === 'ac:plain-text-body') {
      plainBody = plainTextBody(c);
    } else if (cname === 'ac:structured-macro' || cname === 'ac:macro') {
      // Classic container macros nest their children as DIRECT macro elements with no
      // rich-text-body wrapper — `section` carries its `column` macros exactly that way. They
      // were silently dropped here, so every classic multi-column section migrated as nothing
      // at all. Resolve them in document order, as if they sat in a rich-text-body.
      if (!tooDeep()) {
        const nested = hooks.onMacro(
          buildParsedMacro(c, { ...hooks, macroDepth: depth }),
        );

        if (nested)
          richBody.push(...(Array.isArray(nested) ? nested : [nested]));
      }
    }
  }

  return {
    name,
    params,
    richBody,
    plainBody,
    ...(pageReference ? { pageReference } : {}),
  };
}

/**
 * Group an `ac:layout`'s cells by their owning `ac:layout-section` — sections are ROWS, so their
 * cells must not be flattened together. Cells directly under the layout (no section) form one row.
 * Does not descend into a cell, so a nested `ac:layout` is left for that cell's own block walk.
 */
function collectLayoutSections(
  el: XElement,
): Array<{ cells: XElement[]; widths?: number[] }> {
  const sections: Array<{ cells: XElement[]; widths?: number[] }> = [];
  const looseCells: XElement[] = [];

  const cellsOf = (section: XNode): XElement[] => {
    const cells: XElement[] = [];

    const walk = (n: XNode): void => {
      for (const c of children(n)) {
        if (!isElement(c)) continue;

        if (tag(c) === 'ac:layout-cell') cells.push(c);
        else walk(c);
      }
    };

    walk(section);

    return cells;
  };

  for (const child of children(el)) {
    if (!isElement(child)) continue;

    const name = tag(child);

    if (name === 'ac:layout-section') {
      const cells = cellsOf(child);
      const widths = layoutWidths(child.getAttribute('ac:type'), cells.length);

      sections.push({ cells, ...(widths ? { widths } : {}) });
    } else if (name === 'ac:layout-cell') looseCells.push(child);
  }

  if (looseCells.length > 0) sections.push({ cells: looseCells });

  return sections;
}

function layoutWidths(
  type: string | null,
  count: number,
): number[] | undefined {
  const widths: Record<string, number[]> = {
    two_equal: [50, 50],
    two_left_sidebar: [30, 70],
    two_right_sidebar: [70, 30],
    three_equal: [33, 34, 33],
    three_with_sidebars: [20, 60, 20],
  };
  const match = widths[String(type ?? '').toLowerCase()];

  return match?.length === count ? match : undefined;
}
