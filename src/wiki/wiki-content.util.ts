// Plain-text extraction for wiki page content, used only by the MCP-facing
// read endpoints (`/wiki/mine/*`).
//
// Wiki content is stored either as Editor.js JSON (default) or as HTML
// (`wiki_pages.content_format`). The MCP surface deliberately returns sanitized
// plain text, the lowest prompt-injection surface (no raw HTML, no scripts, no
// markdown link/structure trickery). HTML is run through the shared DOMPurify
// sanitizer and then stripped to text; Editor.js documents are walked block by
// block and their text extracted. Anything we can't parse degrades to a safe
// stripped-text fallback (never throws).
//
// This is intentionally a small, dependency-light helper (the only import is
// the existing sanitizer) so the MCP read path adds no new attack surface.

import { sanitizeRichText } from '../common/utils/sanitize-rich-text';

/** Decode the handful of HTML entities that survive tag-stripping. */
function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Collapse runs of blank lines / trailing whitespace into a tidy block. */
function collapse(value: string): string {
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Sanitize an HTML fragment (DOMPurify strips scripts, event handlers,
// javascript: URIs) and then strip all tags down to plain text. Block-level
// close tags become newlines; `<li>` becomes a bullet.
function htmlToPlainText(html: string): string {
  // Keep table structure so the block-close→newline pass below can turn rows into lines.
  const sanitized = sanitizeRichText(html, { allowTables: true }) ?? '';

  const stripped = sanitized
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|li|blockquote|h[1-6]|tr|figcaption|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return collapse(decodeEntities(stripped));
}

// Walk an Editor.js document (a JSON string) and extract its text. Unknown
// block types fall back to any `data.text`. A parse failure degrades to
// treating the raw value as HTML (never throws).
function editorJsToPlainText(raw: string): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return htmlToPlainText(raw);
  }

  const blocks = (parsed as { blocks?: unknown[] })?.blocks;

  if (!Array.isArray(blocks)) {
    return htmlToPlainText(raw);
  }

  const lines: string[] = [];

  for (const block of blocks) {
    const b = block as { type?: string; data?: Record<string, unknown> };
    const type = b?.type;
    const data = b?.data ?? {};

    if (type === 'list' || type === 'checklist') {
      const items = Array.isArray(data.items) ? data.items : [];

      for (const item of items) {
        const text =
          typeof item === 'string'
            ? item
            : ((item as { text?: string; content?: string })?.text ??
              (item as { content?: string })?.content ??
              '');

        if (typeof text === 'string' && text.trim()) {
          lines.push(`- ${htmlToPlainText(text)}`);
        }
      }
    } else if (type === 'code') {
      if (typeof data.code === 'string') lines.push(data.code);
    } else if (type === 'table') {
      const rows = Array.isArray(data.content) ? data.content : [];

      for (const row of rows) {
        if (Array.isArray(row)) {
          lines.push(
            row.map((cell) => htmlToPlainText(String(cell ?? ''))).join('\t'),
          );
        }
      }
    } else if (typeof data.text === 'string') {
      // paragraph / header / quote / anything else carrying a `text` field.
      if (data.text.trim()) lines.push(htmlToPlainText(data.text));
    }
  }

  return collapse(lines.join('\n'));
}

// ── TipTap (Wiki 2.0) ───────────────────────────────────────────────────────

type TipTapNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: TipTapNode[];
};

/** Block-level TipTap node types that terminate a text line. */
const TIPTAP_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'taskItem',
  'blockquote',
  'codeBlock',
  'tableRow',
  'callout',
  'detailsSummary',
  'detailsContent',
  'mathBlock',
  // Confluence-parity blocks — must be listed or their text runs into the next block.
  'decisionItem',
  'caption',
  'externalMacro',
  'spaceAttachments',
  'spacesList',
  'liveSearch',
  'contentByLabel',
  'labelsList',
  'contributorsSummary',
  'changeHistory',
  'pageTreeSearch',
  'spaceDetails',
  'userList',
  'userProfile',
  'profilePicture',
  'popularLabels',
  'recentlyUsedLabels',
  'relatedLabels',
  'contentByUser',
  'recentlyUpdatedDashboard',
  'contentReportTable',
  'decisionReport',
  'navigationMap',
  'blogPosts',
  'rssFeed',
  'confluenceToc',
  'createSpaceButton',
  'contentProperties',
  'contentPropertiesReport',
  'chart',
  'gallery',
  'excerpt',
  'includePage',
  'excerptInclude',

  // Its six importer-only siblings (spaceAttachments, spacesList, liveSearch,
  // contributorsSummary, labelsList, contentByLabel) were all already here;
  // taskReport was the one omission, so a page whose only block was a task
  // report ran its heading straight into the following paragraph in content_text.
  'taskReport',
  'spreadsheet',
]);

const SHEET_TEXT_CAP = 20_000;

/** Display text of one sheet cell: cached value for formulas, raw for constants. */
function sheetCellText(cell: unknown, cached: unknown): string {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return '';

  const raw = (cell as Record<string, unknown>)['raw'];

  if (typeof raw !== 'string') return '';

  let text = raw;

  if (raw.length > 1 && raw.startsWith('=')) {
    if (typeof cached === 'number') text = String(cached);
    else if (typeof cached === 'boolean') text = cached ? 'TRUE' : 'FALSE';
    else if (typeof cached === 'string') text = cached;
    else if (
      cached &&
      typeof cached === 'object' &&
      typeof (cached as Record<string, unknown>)['e'] === 'string'
    ) {
      text = (cached as Record<string, unknown>)['e'] as string;
    } else text = '';
  } else if (raw.startsWith("'")) {
    text = raw.slice(1);
  }

  // Keep one line per row and one tab per column.
  return text.replace(/[\t\r\n]+/g, ' ');
}

/** Title line then rows as TSV, capped so later page text stays indexed. */
function sheetToPlainText(sheet: unknown): string {
  if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) return '';

  const s = sheet as Record<string, unknown>;
  const cells =
    s['cells'] && typeof s['cells'] === 'object'
      ? (s['cells'] as Record<string, unknown>)
      : {};
  const cache =
    s['cache'] && typeof s['cache'] === 'object'
      ? (s['cache'] as Record<string, unknown>)
      : {};
  const rows = Math.min(200, Number(s['rows']) || 0);
  const cols = Math.min(26, Number(s['cols']) || 0);
  const lines: string[] = [];

  if (typeof s['title'] === 'string' && s['title'].trim()) {
    lines.push(s['title'].trim());
  }

  for (let r = 1; r <= rows; r++) {
    const values: string[] = [];

    for (let c = 0; c < cols; c++) {
      const key = `${String.fromCharCode(65 + c)}${r}`;

      values.push(sheetCellText(cells[key], cache[key]));
    }

    while (values.length > 0 && values[values.length - 1] === '') values.pop();
    if (values.length > 0) lines.push(values.join('\t'));
  }

  return lines.join('\n').slice(0, SHEET_TEXT_CAP);
}

function walkTipTap(node: TipTapNode, visit: (n: TipTapNode) => void): void {
  visit(node);

  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      if (child && typeof child === 'object') walkTipTap(child, visit);
    }
  }
}

/** Parse a TipTap doc (JSON string or object) to a node, or null. */
function parseTipTapDoc(raw: unknown): TipTapNode | null {
  let parsed: unknown = raw;

  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  return parsed as TipTapNode;
}

// Extract plain text from a TipTap document (JSON string or parsed object) by
// walking its text leaves. Block boundaries become newlines; mention/wikiLink
// labels are included so the search index covers them. Never throws — a
// malformed document degrades to ''.
export function tiptapToPlainText(raw: unknown): string {
  const doc = parseTipTapDoc(raw);

  if (!doc) return '';

  const parts: string[] = [];

  walkTipTap(doc, (node) => {
    if (typeof node.text === 'string') {
      parts.push(node.text);

      return;
    }

    const attrs = node.attrs ?? {};

    // Imported user mentions use userName; legacy mentions and links use label.
    const mentionLabel =
      node.type === 'userMention' && typeof attrs['userName'] === 'string'
        ? attrs['userName']
        : attrs['label'];

    if (
      (node.type === 'mention' ||
        node.type === 'userMention' ||
        node.type === 'entityMention' ||
        node.type === 'wikiLink') &&
      typeof mentionLabel === 'string'
    ) {
      parts.push(mentionLabel);
    }

    if (node.type === 'mathBlock' || node.type === 'mathInline') {
      if (typeof attrs['latex'] === 'string') parts.push(attrs['latex']);
    }

    // Confluence-parity ATOM nodes hold their only human-readable text in attrs. They have no child
    // text node, so without these branches the content never reaches `content_text` and the page
    // becomes unfindable by the very words a reader sees on it.
    if (node.type === 'status' && typeof attrs['text'] === 'string') {
      parts.push(attrs['text']);
    }

    if (node.type === 'date' && typeof attrs['timestamp'] === 'string') {
      // Index the ISO date so "2025-10-14" matches a page showing that lozenge.
      const ms = Number(attrs['timestamp']);

      if (Number.isFinite(ms) && ms > 0) {
        parts.push(new Date(ms).toISOString().slice(0, 10));
      }
    }

    if (node.type === 'inlineCard' || node.type === 'embed') {
      const label = attrs['title'];

      parts.push(
        typeof label === 'string' && label
          ? label
          : typeof attrs['url'] === 'string'
            ? attrs['url']
            : '',
      );
    }

    if (node.type === 'safeEmbed') {
      parts.push(
        typeof attrs['title'] === 'string' && attrs['title']
          ? attrs['title']
          : typeof attrs['url'] === 'string'
            ? attrs['url']
            : '',
      );
    }

    if (node.type === 'carousel' && Array.isArray(attrs['frames'])) {
      for (const frame of attrs['frames']) {
        if (!frame || typeof frame !== 'object' || Array.isArray(frame))
          continue;
        const value = frame as Record<string, unknown>;
        if (typeof value['title'] === 'string') parts.push(value['title']);
        if (typeof value['description'] === 'string')
          parts.push(value['description']);
      }
    }

    if (node.type === 'mediaInline' || node.type === 'fileAttachment') {
      if (typeof attrs['name'] === 'string') parts.push(attrs['name']);
    }

    if (node.type === 'image' && typeof attrs['alt'] === 'string') {
      parts.push(attrs['alt']);
    }

    if (node.type === 'externalMacro' && typeof attrs['name'] === 'string') {
      parts.push(attrs['name']);
    }

    if (node.type === 'taskCard') {
      const config = attrs['config'];

      if (config && typeof config === 'object' && !Array.isArray(config)) {
        const taskKey = (config as Record<string, unknown>)['taskKey'];
        if (typeof taskKey === 'string') parts.push(taskKey);
      }
    }

    // The embedded board's name (a snapshot taken when it was picked), so the page is found by it.
    if (node.type === 'whiteboardEmbed') {
      const config = attrs['config'];

      if (config && typeof config === 'object' && !Array.isArray(config)) {
        const name = (config as Record<string, unknown>)['name'];
        if (typeof name === 'string') parts.push(name);
      }
    }

    if (
      (node.type === 'includePage' || node.type === 'excerptInclude') &&
      typeof attrs['title'] === 'string'
    ) {
      parts.push(attrs['title']);
    }

    if (
      node.type === 'liveSearch' &&
      typeof attrs['placeholder'] === 'string'
    ) {
      parts.push(attrs['placeholder']);
    }

    if (node.type === 'contentByLabel' && Array.isArray(attrs['labels'])) {
      parts.push(
        (attrs['labels'] as unknown[])
          .filter((label): label is string => typeof label === 'string')
          .join(' '),
      );
    }

    if (node.type === 'pageTreeSearch' && typeof attrs['query'] === 'string') {
      parts.push(attrs['query']);
    }

    if (node.type === 'chart' && typeof attrs['title'] === 'string') {
      parts.push(attrs['title']);
    }

    if (node.type === 'chart' && typeof attrs['subtitle'] === 'string') {
      parts.push(attrs['subtitle']);
    }

    if (node.type === 'gallery' && typeof attrs['title'] === 'string') {
      parts.push(attrs['title']);
    }

    if (node.type === 'userList' && Array.isArray(attrs['groups'])) {
      parts.push(
        (attrs['groups'] as unknown[])
          .filter((group): group is string => typeof group === 'string')
          .join(' '),
      );
    }

    if (node.type === 'userProfile' && typeof attrs['userName'] === 'string') {
      parts.push(attrs['userName']);
    }

    if (
      node.type === 'profilePicture' &&
      typeof attrs['userName'] === 'string'
    ) {
      parts.push(attrs['userName']);
    }

    if (
      node.type === 'createSpaceButton' &&
      typeof attrs['sourceName'] === 'string'
    ) {
      parts.push(attrs['sourceName']);
    }

    if (node.type === 'contentProperties' && Array.isArray(attrs['rows'])) {
      for (const row of attrs['rows'] as unknown[]) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;

        const record = row as Record<string, unknown>;

        if (typeof record.key === 'string') parts.push(record.key);
        if (typeof record.value === 'string') parts.push(record.value);
      }
    }

    if (node.type === 'spreadsheet') {
      const text = sheetToPlainText(attrs['sheet']);

      // Visits are pre-order, so start a new line before the multi-line TSV.
      if (text) parts.push('\n', text);
    }

    if (node.type === 'contentPropertiesReport') {
      if (typeof attrs['label'] === 'string') parts.push(attrs['label']);
      if (Array.isArray(attrs['columns'])) {
        parts.push(
          (attrs['columns'] as unknown[])
            .filter((column): column is string => typeof column === 'string')
            .join(' '),
        );
      }
    }

    // `callout` custom variant carries a title that is real prose.
    if (node.type === 'callout' && typeof attrs['title'] === 'string') {
      parts.push(attrs['title']);
    }

    // A diagram's caption (the source drawing's name) is the only searchable text it has — the
    // mxfile itself is markup, not prose, so it is deliberately NOT indexed.
    if (node.type === 'drawioDiagram' && typeof attrs['caption'] === 'string') {
      parts.push(attrs['caption']);
    }

    if (node.type && TIPTAP_BLOCK_TYPES.has(node.type)) {
      parts.push('\n');
    }
  });

  return collapse(parts.join(' ').replace(/ ?\n ?/g, '\n'));
}

// Extract mentioned user IDs from a TipTap document (mention/userMention nodes
// with a UUID `id` attr). Deduplicated; never throws.
export function extractTipTapUserMentionIds(raw: unknown): string[] {
  const doc = parseTipTapDoc(raw);

  if (!doc) return [];

  const ids = new Set<string>();

  walkTipTap(doc, (node) => {
    const id =
      node.type === 'userMention' && typeof node.attrs?.['userId'] === 'string'
        ? node.attrs['userId']
        : node.attrs?.['id'];

    if (
      (node.type === 'mention' || node.type === 'userMention') &&
      typeof id === 'string'
    ) {
      ids.add(id);
    }
  });

  return [...ids];
}

// Extract the comment-mark thread IDs present in a TipTap document (marks of
// type 'comment' with a `threadId` attr). Used to sync inline comment anchors
// (active ↔ orphaned). Deduplicated; never throws.
export function extractTipTapCommentThreadIds(raw: unknown): string[] {
  const doc = parseTipTapDoc(raw);

  if (!doc) return [];

  const ids = new Set<string>();

  walkTipTap(doc, (node) => {
    for (const mark of node.marks ?? []) {
      if (
        mark?.type === 'comment' &&
        typeof mark.attrs?.['threadId'] === 'string'
      ) {
        ids.add(mark.attrs['threadId']);
      }
    }
  });

  return [...ids];
}

// Extract sanitized plain text from a wiki page's stored content. `content` is
// the raw `wiki_pages.content` value (string JSON/HTML or null) and
// `contentFormat` is `'editorjs'` (default storage), `'html'`, or `'tiptap'`
// (Wiki 2.0). Returns sanitized plain text: never null, never raw HTML, never
// throws.
export function extractWikiPlainText(
  content: unknown,
  contentFormat: string | null | undefined,
): string {
  if (content == null) return '';

  const raw = typeof content === 'string' ? content : JSON.stringify(content);

  if (!raw.trim()) return '';

  if (contentFormat === 'tiptap') {
    return tiptapToPlainText(raw);
  }

  if (contentFormat === 'editorjs') {
    return editorJsToPlainText(raw);
  }

  return htmlToPlainText(raw);
}

/** `&`, `<`, `>`, `"` — enough for both element text and double-quoted attributes. */
function escapeTipTapHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const TIPTAP_MARK_TAGS: Record<string, string> = {
  bold: 'strong',
  strong: 'strong',
  italic: 'em',
  em: 'em',
  underline: 'u',
  strike: 's',
  code: 'code',
};

/** Wraps a text leaf in its marks. `link` becomes an anchor; the rest are simple tags. */
function applyTipTapMarks(text: string, node: TipTapNode): string {
  const marks = Array.isArray(node.marks) ? node.marks : [];
  let out = text;

  for (const mark of marks) {
    if (!mark || typeof mark !== 'object') continue;

    const type = (mark as { type?: unknown }).type;

    if (typeof type !== 'string') continue;

    if (type === 'link') {
      const attrs = ((mark as { attrs?: unknown }).attrs ?? {}) as Record<
        string,
        unknown
      >;
      const href = typeof attrs['href'] === 'string' ? attrs['href'] : '';

      out = href
        ? `<a href="${escapeTipTapHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${out}</a>`
        : out;
      continue;
    }

    const tag = TIPTAP_MARK_TAGS[type];

    if (tag) out = `<${tag}>${out}</${tag}>`;
  }

  return out;
}

/**
 * Serialize a TipTap document to HTML.
 *
 * Why this exists next to `tiptapToPlainText`: the Document Designer needs the wiki page BODY, and
 * the plain-text extractor reads only `attrs.alt` for an image — so every picture on a wiki page was
 * silently absent from every exported document. This keeps images, links, lists and tables.
 *
 * An unrecognised node renders its children rather than throwing, so a schema addition degrades to
 * its text instead of blanking the page. `@tiptap/html` is deliberately not used: TipTap is a
 * frontend-only dependency here, and the wiki schema's custom nodes are not in `starter-kit`.
 */
export function tiptapToHtml(raw: unknown): string {
  const doc = parseTipTapDoc(raw);

  if (!doc) return '';

  const children = (node: TipTapNode): string =>
    Array.isArray(node.content) ? node.content.map(render).join('') : '';

  const render = (node: TipTapNode): string => {
    if (!node || typeof node !== 'object') return '';

    if (typeof node.text === 'string') {
      return applyTipTapMarks(escapeTipTapHtml(node.text), node);
    }

    const attrs = node.attrs ?? {};
    const str = (key: string): string => {
      const raw = attrs[key];

      return typeof raw === 'string' ? raw : '';
    };

    switch (node.type) {
      case 'doc':
        return children(node);
      case 'paragraph':
        return `<p>${children(node)}</p>`;
      case 'heading': {
        const level = Number(attrs['level']);
        const tag =
          Number.isFinite(level) && level >= 1 && level <= 6
            ? `h${level}`
            : 'h3';

        return `<${tag}>${children(node)}</${tag}>`;
      }
      case 'hardBreak':
        return '<br>';
      case 'horizontalRule':
        return '<hr>';
      case 'bulletList':
        return `<ul>${children(node)}</ul>`;
      case 'orderedList':
        return `<ol>${children(node)}</ol>`;
      case 'listItem':
      case 'taskItem':
        return `<li>${children(node)}</li>`;
      case 'taskList':
        return `<ul>${children(node)}</ul>`;
      case 'blockquote':
        return `<blockquote>${children(node)}</blockquote>`;
      case 'codeBlock':
        return `<pre><code>${children(node)}</code></pre>`;
      case 'table':
        return `<table>${children(node)}</table>`;
      case 'tableRow':
        return `<tr>${children(node)}</tr>`;
      case 'tableHeader':
        return `<th>${children(node)}</th>`;
      case 'tableCell':
        return `<td>${children(node)}</td>`;
      case 'image': {
        const src = str('src');

        if (!src) return '';

        const alt = escapeTipTapHtml(str('alt'));

        return `<img src="${escapeTipTapHtml(src)}" alt="${alt}">`;
      }
      case 'drawioDiagram': {
        // Drawio stores its rendered SVG as a data URI; the caption is the only text.
        const src = str('src') || str('dataUri');
        const caption = escapeTipTapHtml(str('caption'));

        return src
          ? `<img src="${escapeTipTapHtml(src)}" alt="${caption}">`
          : '';
      }
      case 'fileAttachment':
      case 'mediaInline': {
        const url = str('url') || str('src');
        const name = escapeTipTapHtml(str('name') || url);

        return url
          ? `<a href="${escapeTipTapHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${name}</a>`
          : name;
      }
      case 'mention':
      case 'userMention':
      case 'entityMention':
      case 'wikiLink': {
        const label =
          node.type === 'userMention' && str('userName')
            ? str('userName')
            : str('label');

        return escapeTipTapHtml(label);
      }
      case 'mathBlock':
      case 'mathInline':
        return escapeTipTapHtml(str('latex'));
      case 'status':
        return escapeTipTapHtml(str('text'));
      default:
        // Unknown node: keep whatever is inside it rather than dropping the subtree.
        return children(node);
    }
  };

  return render(doc);
}
