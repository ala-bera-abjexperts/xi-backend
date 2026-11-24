/**
 * @fileoverview Bounded HTML-fragment → TipTap JSON parser for the wiki
 * push path. Input is always sanitized HTML (text element content or a
 * formatted field value), so unknown tags just degrade to their text
 * content rather than being rejected. Output stays a subset of
 * tiptap-sanitizer.ts's NODE_SPECS/MARK_SPECS whitelist.
 * @module src/document-designer/rendering/doc-text-html-to-tiptap
 */

import * as jsdomModule from 'jsdom';

interface JSDOMConstructor {
  new (html: string): { window: { document: Document } };
}

const typedJsdom = jsdomModule as unknown as { JSDOM: JSDOMConstructor };

export interface TipTapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TipTapNode {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  marks?: TipTapMark[];
  content?: TipTapNode[];
}

const MARK_TAGS: Record<string, string> = {
  strong: 'bold',
  b: 'bold',
  em: 'italic',
  i: 'italic',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
  u: 'underline',
  code: 'code',
};

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BLOCK_TABLE_TAGS = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
]);

/** Uses one shared jsdom document per call — cheap for fragment-sized input, avoids a module-level singleton mutating across concurrent requests. */
function parseFragment(html: string): Document {
  const dom = new typedJsdom.JSDOM(`<!doctype html><body>${html}</body>`);

  return dom.window.document;
}

function textNode(text: string, marks: TipTapMark[]): TipTapNode | null {
  if (!text) return null;

  return marks.length > 0
    ? { type: 'text', text, marks }
    : { type: 'text', text };
}

/** Walks inline content (text + marks), flattening nested mark tags into the TipTap text+marks[] shape. */
function walkInline(node: ChildNode, marks: TipTapMark[]): TipTapNode[] {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    const text = node.textContent ?? '';
    const collapsed = text.replace(/\s+/g, ' ');
    const built = textNode(collapsed, marks);

    return built ? [built] : [];
  }

  if (node.nodeType !== 1 /* ELEMENT_NODE */) return [];

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  if (tag === 'br') return [{ type: 'hardBreak' }];

  if (tag === 'img') {
    const src = el.getAttribute('src');

    if (!src) return [];

    const attrs: Record<string, unknown> = { src };
    const alt = el.getAttribute('alt');
    const title = el.getAttribute('title');

    if (alt) attrs.alt = alt;
    if (title) attrs.title = title;

    return [{ type: 'image', attrs }];
  }

  if (tag === 'a') {
    const href = el.getAttribute('href');
    const linkMarks = href
      ? [...marks, { type: 'link', attrs: { href } }]
      : marks;

    return Array.from(el.childNodes).flatMap((child) =>
      walkInline(child, linkMarks),
    );
  }

  if (
    tag === 'span' &&
    el.getAttribute('data-user-mention') !== null &&
    el.getAttribute('data-user-id')
  ) {
    const attrs: Record<string, unknown> = {
      userId: el.getAttribute('data-user-id'),
    };
    const userName = el.getAttribute('data-user-name');

    if (userName) attrs.userName = userName;

    return [{ type: 'userMention', attrs }];
  }

  const markType = MARK_TAGS[tag];

  if (markType) {
    const nextMarks = [...marks, { type: markType }];

    return Array.from(el.childNodes).flatMap((child) =>
      walkInline(child, nextMarks),
    );
  }

  // Unknown inline tag (span without a recognized data-attr, etc.) — degrade
  // to its text content, carrying the marks accumulated so far.
  return Array.from(el.childNodes).flatMap((child) => walkInline(child, marks));
}

function inlineContent(el: Element): TipTapNode[] {
  return Array.from(el.childNodes).flatMap((child) => walkInline(child, []));
}

/** Wraps loose inline nodes (a text run with no block parent) in one paragraph, matching cir-to-tiptap.ts's `asBlocks` rule that TipTap disallows text as a direct child of `doc`/list items/etc. */
function asParagraphIfInline(nodes: TipTapNode[]): TipTapNode[] {
  if (nodes.length === 0) return [];

  const allInline = nodes.every(
    (n) => n.type === 'text' || n.type === 'hardBreak' || n.type === 'image',
  );

  return allInline ? [{ type: 'paragraph', content: nodes }] : nodes;
}

function walkBlock(node: ChildNode): TipTapNode[] {
  if (node.nodeType === 3 /* TEXT_NODE */) {
    const text = (node.textContent ?? '').trim();

    return text
      ? [{ type: 'paragraph', content: [{ type: 'text', text }] }]
      : [];
  }

  if (node.nodeType !== 1 /* ELEMENT_NODE */) return [];

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  if (tag === 'p' || tag === 'div') {
    const content = inlineContent(el);

    return content.length > 0 ? [{ type: 'paragraph', content }] : [];
  }

  if (HEADING_TAGS.has(tag)) {
    const level = Number(tag.slice(1));
    const content = inlineContent(el);

    return content.length > 0
      ? [{ type: 'heading', attrs: { level }, content }]
      : [];
  }

  if (tag === 'ul' || tag === 'ol') {
    const items = Array.from(el.children)
      .filter((child) => child.tagName.toLowerCase() === 'li')
      .map((li) => ({
        type: 'listItem',
        content: asParagraphIfInline(
          Array.from(li.childNodes).flatMap((child) => walkBlock(child)),
        ),
      }))
      .filter((item) => item.content.length > 0);

    if (items.length === 0) return [];

    return [
      { type: tag === 'ul' ? 'bulletList' : 'orderedList', content: items },
    ];
  }

  if (tag === 'blockquote') {
    const content = Array.from(el.childNodes).flatMap((child) =>
      walkBlock(child),
    );

    return content.length > 0
      ? [{ type: 'blockquote', content: asParagraphIfInline(content) }]
      : [];
  }

  if (tag === 'pre') {
    const codeEl = el.querySelector('code');
    const language = codeEl?.className.match(/language-(\S+)/)?.[1];
    const text = (codeEl ?? el).textContent ?? '';

    return [
      {
        type: 'codeBlock',
        ...(language ? { attrs: { language } } : {}),
        content: text ? [{ type: 'text', text }] : [],
      },
    ];
  }

  if (tag === 'hr') return [{ type: 'horizontalRule' }];

  // An inline ATOM sitting at block level — which is exactly how the editors store a pasted
  // picture: `<p>text</p><img src="…"><p>more</p>`, the image a SIBLING of the paragraphs, not
  // inside one. It has no children, so the recurse-into-children fallback at the end of this
  // function returned [] and every such image vanished from wiki pushes.
  if (tag === 'img' || tag === 'br') {
    return walkInline(el, []);
  }

  if (tag === 'table') {
    return [parseTable(el)];
  }

  if (BLOCK_TABLE_TAGS.has(tag)) {
    // A stray thead/tbody/tr/th/td reached outside a <table> ancestor (should
    // not happen given callers always pass a full fragment) — skip rather
    // than emit an invalid standalone node.
    return [];
  }

  // Unknown block tag (section, article, span-as-block, …) — recurse into
  // children rather than dropping the content.
  return Array.from(el.childNodes).flatMap((child) => walkBlock(child));
}

function parseTable(tableEl: Element): TipTapNode {
  const rows = Array.from(tableEl.querySelectorAll('tr'));

  const content = rows.map((row) => {
    const cells = Array.from(row.children).filter((c) =>
      ['td', 'th'].includes(c.tagName.toLowerCase()),
    );

    return {
      type: 'tableRow',
      content: cells.map((cell) => ({
        type: cell.tagName.toLowerCase() === 'th' ? 'tableHeader' : 'tableCell',
        content: asParagraphIfInline(inlineContent(cell)),
      })),
    };
  });

  return { type: 'table', content };
}

/**
 * Parses a bounded HTML fragment into TipTap block-node JSON. Returns an
 * empty array for empty/whitespace-only input — callers decide whether an
 * empty result is itself an error (e.g. the whole document has no content).
 */
export function parseHtmlFragmentToTipTapNodes(html: string): TipTapNode[] {
  const trimmed = html?.trim();

  if (!trimmed) return [];

  const doc = parseFragment(trimmed);
  const body = doc.body;

  return Array.from(body.childNodes).flatMap((child) => walkBlock(child));
}

/**
 * Convenience wrapper for a value that must render as ONE inline run inside
 * an existing paragraph/cell (e.g. a field's formatted value) rather than a
 * sequence of block nodes — flattens any block structure the fragment
 * produced into a single paragraph's inline content.
 */
export function parseHtmlFragmentToInlineNodes(html: string): TipTapNode[] {
  const blocks = parseHtmlFragmentToTipTapNodes(html);

  return blocks.flatMap((block) => {
    if (block.content) return block.content;
    if (block.text) return [block];

    // Atoms (image, hardBreak, horizontalRule) carry neither children nor text. Unwrapping only
    // `content`/`text` discarded them, which is why a picture reached this function and still
    // never appeared on the pushed wiki page.
    return block.type ? [block] : [];
  });
}
