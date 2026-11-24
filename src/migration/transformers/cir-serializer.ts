/**
 * @fileoverview XI-CIR → sanitizer-safe HTML. The single allow-list gatekeeper: it emits ONLY
 * tags/attributes that survive `sanitizeRichText` (verified in `content-transform.service`), so
 * migrated content is never silently stripped at write time.
 *
 * Crosswalk references are resolved up front (bulk, async) into the `CirResolved` maps; this
 * serializer is pure/synchronous. Unresolved refs degrade visibly (never dropped):
 *   - user mention → placeholder `@displayName` span
 *   - attachment image → `[Image: filename]`
 *   - page link → plain text
 *   - table (Milestone A) → bullet list; (Milestone B) → native `<table>`
 *   - macro → `[Macro deferred: name]`
 */

import {
  pageReferenceKey,
  type CirDoc,
  type CirMark,
  type CirNode,
  type CirTableCell,
} from './canonical-ir';

export interface CirResolved {
  /** user sourceId → resolved target user. */
  users: Map<
    string,
    { userId: string; displayName: string; isPlaceholder?: boolean }
  >;
  /** page sourceId → in-app link. */
  pages: Map<
    string,
    {
      url: string;
      title?: string;
      pageId?: string;
      pageSlug?: string;
      spaceKey?: string;
    }
  >;
  /** attachment filename → migrated public URL. */
  attachments: Map<string, string>;
  /** attachment filename → optional migration-only browser preview URL. */
  attachmentPreviews?: Map<string, string>;
  /** Exact Jira source issue key → migrated XISUITE task key. */
  jiraIssues?: Map<string, { taskKey: string }>;
  /** Milestone B: render native tables (requires the reviewed allow-list extension). */
  nativeTables: boolean;
}

const MARK_TAGS: Record<CirMark, [string, string]> = {
  strong: ['<strong>', '</strong>'],
  em: ['<em>', '</em>'],
  underline: ['<u>', '</u>'],
  strike: ['<s>', '</s>'],
  code: ['<code>', '</code>'],
  subscript: ['<sub>', '</sub>'],
  superscript: ['<sup>', '</sup>'],
};

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}

/** Only http(s)/mailto/relative hrefs survive; javascript: etc. are dropped to '#'. */
function safeHref(href: string): string {
  const trimmed = (href ?? '').trim();

  if (/^(https?:|mailto:|\/|#)/i.test(trimmed)) return escapeAttr(trimmed);

  return '#';
}

export function cirToHtml(doc: CirDoc, resolved: CirResolved): string {
  return doc.children.map((node) => renderNode(node, resolved)).join('');
}

function renderChildren(children: CirNode[], r: CirResolved): string {
  return children.map((node) => renderNode(node, r)).join('');
}

function renderInline(children: CirNode[], r: CirResolved): string {
  return children.map((node) => renderNode(node, r)).join('');
}

function renderText(node: Extract<CirNode, { type: 'text' }>): string {
  let html = escapeHtml(node.text);
  const marks = node.marks ?? [];

  for (const mark of marks) {
    const [open, close] = MARK_TAGS[mark];

    html = `${open}${html}${close}`;
  }

  if (node.link) {
    html = `<a href="${safeHref(node.link)}" target="_blank" rel="noopener noreferrer">${html}</a>`;
  }

  return html;
}

const BLOCK_LEVEL_TYPES = new Set<CirNode['type']>([
  'paragraph',
  'heading',
  'list',
  'taskList',
  'blockquote',
  'codeBlock',
  'rule',
  'panel',
  'table',
  'expand',
  'layout',
  'macroDeferred',
]);

/** Nodes that must never be nested inside a `<p>` (the HTML parser would reflow them out of it). */
function isBlockLevel(node: CirNode): boolean {
  return (
    BLOCK_LEVEL_TYPES.has(node.type) ||
    (node.type === 'media' && Boolean(node.align) && !node.inline)
  );
}

function renderNode(node: CirNode, r: CirResolved): string {
  switch (node.type) {
    case 'text':
      return renderText(node);

    case 'hardBreak':
      return '<br>';

    case 'paragraph': {
      const inner = renderInline(node.children, r);

      if (!inner) return '';

      // A block-producing macro (info panel, code, children list…) can legitimately sit inside an
      // inline run — Confluence allows `<p>see <ac:structured-macro ac:name="info"/> here</p>`.
      // Wrapping that in <p> is invalid HTML, and the sanitizer's reparse silently reflows it so
      // trailing text escapes the paragraph. Emit it unwrapped instead.
      return node.children.some(isBlockLevel) ? inner : `<p>${inner}</p>`;
    }

    case 'heading': {
      const level = Math.min(Math.max(node.level, 1), 6);
      const id = node.anchorId ? ` id="${escapeAttr(node.anchorId)}"` : '';

      return `<h${level}${id}>${renderInline(node.children, r)}</h${level}>`;
    }

    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start =
        node.ordered && node.start !== undefined
          ? ` start="${node.start}"`
          : '';
      const items = node.items
        .map((item) => `<li>${renderChildren(item, r)}</li>`)
        .join('');

      return `<${tag}${start}>${items}</${tag}>`;
    }

    case 'taskList': {
      const items = node.items
        .map(
          (item) =>
            `<li>${item.checked ? '☑' : '☐'} ${renderChildren(item.children, r)}</li>`,
        )
        .join('');

      return `<ul class="xi-tasklist">${items}</ul>`;
    }

    case 'decisionList': {
      // Decisions use a distinct glyph from task lists so a reader can tell a recorded decision
      // from an outstanding to-do. `<input type=checkbox>` is not on the allow-list, hence glyphs.
      const items = node.items
        .map(
          (item) =>
            `<li>${item.decided ? '✔' : '?'} ${renderChildren(item.children, r)}</li>`,
        )
        .join('');

      return `<ul class="xi-decisionlist">${items}</ul>`;
    }

    case 'caption':
      return `<p class="xi-caption"><em>${renderInline(node.children, r)}</em></p>`;

    case 'excerpt':
      return node.hidden ? '' : renderChildren(node.children, r);

    case 'includePage':
      return `<p><em>[Included page: ${escapeHtml(node.title)}]</em></p>`;

    case 'excerptInclude':
      return `<p><em>[Included excerpt: ${escapeHtml(node.title)}]</em></p>`;

    // HTML has no way to hold an editable drawing, so the diagram is named either way. Only the
    // TipTap path (what Wiki 2.0 stores) can carry the mxfile itself.
    case 'diagram':
      return `<p><em>[Diagram: ${escapeHtml(node.name)}]</em></p>`;

    // The HTML path has no lozenge/chip/live-query vocabulary, so these degrade to readable text.
    // Nothing is dropped, which is the only guarantee this serializer makes for them.
    case 'date':
      return escapeHtml(
        new Date(Number(node.timestamp)).toISOString().slice(0, 10),
      );

    case 'inlineCard':
      // `safeHref`, not `escapeAttr` — the URL comes from the source document, so the scheme must be
      // checked, not merely escaped.
      return `<a href="${safeHref(node.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        node.title ?? node.url,
      )}</a>`;

    case 'safeEmbed':
      return `<p><a href="${safeHref(node.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        node.title ?? 'Embedded media',
      )}</a></p>`;

    case 'carousel': {
      const first = node.frames[0];
      if (!first) return '<p><em>Carousel unavailable</em></p>';
      const label = escapeHtml(first.title || first.description || 'Carousel');
      return first.url
        ? `<p><a href="${safeHref(first.url)}" target="_blank" rel="noopener noreferrer">${label}</a></p>`
        : `<p>${label}</p>`;
    }

    case 'liveMacro':
      return `<p><em>[${escapeHtml(node.kind)}]</em></p>`;

    // Permission-aware actions cannot be represented safely in static/read-only HTML.
    case 'createSpaceButton':
      return '';

    case 'chart': {
      const title = node.title
        ? `<p><strong>${escapeHtml(node.title)}</strong></p>`
        : '';

      return `${title}<div class="xi-chart-fallback"><p><em>Chart source data</em></p>${renderChildren(
        node.children,
        r,
      )}</div>`;
    }

    case 'gallery':
      return `<p><em>[Gallery${node.title ? `: ${escapeHtml(node.title)}` : ''}]</em></p>`;

    case 'externalMacro':
      return `<p><em>[${escapeHtml(node.name)}]</em></p>${Object.keys(node.params).length > 0 ? `<pre><code>${escapeHtml(JSON.stringify(node.params, null, 2))}</code></pre>` : ''}`;

    case 'jiraIssue': {
      const mapped = r.jiraIssues?.get(node.key);
      const label = mapped?.taskKey ?? node.key;
      const href = mapped
        ? `/tasks/${encodeURIComponent(mapped.taskKey)}`
        : node.sourceUrl;
      const body = renderChildren(node.children, r);

      return `${href ? `<p><a href="${safeHref(href)}">${escapeHtml(label)}</a></p>` : `<p><em>[${escapeHtml(node.macroName)}: ${escapeHtml(label)}]</em></p>`}${body}`;
    }

    case 'anchor':
      return `<span id="${escapeAttr(node.name)}"></span>`;

    case 'blockquote':
      return `<blockquote>${renderChildren(node.children, r)}</blockquote>`;

    case 'codeBlock': {
      // `lang-` is the vocabulary the mapping catalog + downstream highlighting key on.
      const langClass = node.language
        ? ` class="lang-${escapeAttr(node.language)}"`
        : '';

      return `<pre><code${langClass}>${escapeHtml(node.text)}</code></pre>`;
    }

    case 'rule':
      // <hr> is not allow-listed → a visible divider paragraph.
      return '<p class="xi-divider">———</p>';

    case 'link':
      return `<a href="${safeHref(node.href)}" target="_blank" rel="noopener noreferrer">${renderInline(node.children, r)}</a>`;

    case 'media':
      return renderMedia(node, r);

    case 'userMention':
      return renderUserMention(node, r);

    case 'pageLink':
      return renderPageLink(node, r);

    case 'panel': {
      const variant = node.variant
        ? ` xi-panel-${escapeAttr(node.variant)}`
        : '';
      const title = node.title
        ? `<p><strong>${escapeHtml(node.title)}</strong></p>`
        : '';

      return `<blockquote class="xi-panel${variant}">${title}${renderChildren(node.children, r)}</blockquote>`;
    }

    case 'table':
      return r.nativeTables
        ? renderNativeTable(node, r)
        : renderTableFallback(node, r);

    case 'macroDeferred':
      return `<blockquote class="xi-macro-deferred">[Macro deferred: ${escapeHtml(node.name)}]</blockquote>`;

    case 'status': {
      const color = node.color ? ` xi-status-${escapeAttr(node.color)}` : '';

      return `<span class="xi-status${color}">${escapeHtml(node.text)}</span>`;
    }

    case 'expand': {
      const title = node.title
        ? `<p class="xi-expand-title"><strong>${escapeHtml(node.title)}</strong></p>`
        : '';

      return `<div class="xi-expand">${title}${renderChildren(node.children, r)}</div>`;
    }

    case 'layout': {
      const hasWidths = node.widths?.some(
        (width) =>
          Number.isInteger(width) && Number(width) >= 1 && Number(width) <= 100,
      );

      if (hasWidths && r.nativeTables) {
        const cells = node.columns
          .map((col, index) => {
            const width = node.widths?.[index];
            const attr =
              Number.isInteger(width) &&
              Number(width) >= 1 &&
              Number(width) <= 100
                ? ` width="${width}%"`
                : '';

            return `<td class="xi-col"${attr}>${renderChildren(col, r)}</td>`;
          })
          .join('');

        return `<table class="xi-layout" width="100%"><tbody><tr>${cells}</tr></tbody></table>`;
      }

      const cols = node.columns
        .map((col) => `<div class="xi-col">${renderChildren(col, r)}</div>`)
        .join('');

      return `<div class="xi-layout">${cols}</div>`;
    }

    // toc/attachments markers are normally replaced by post-passes in the service; if one reaches
    // the serializer unresolved (e.g. an empty doc), degrade to nothing rather than leak a marker.
    case 'tocMarker':
    case 'attachmentsMacro':
      return '';

    case 'raw':
      return node.html;

    default:
      return '';
  }
}

function renderMedia(
  node: Extract<CirNode, { type: 'media' }>,
  r: CirResolved,
): string {
  const alt = node.alt ? ` alt="${escapeAttr(node.alt)}"` : '';
  const dims =
    (node.width ? ` width="${escapeAttr(node.width)}"` : '') +
    (node.height ? ` height="${escapeAttr(node.height)}"` : '');

  // A `view-file` attachment (PDF/doc/zip) is a download link, never an <img> — without
  // this branch the HTML path emits a broken image for every one of them.
  if (node.kind === 'file') {
    const href =
      node.src ?? (node.filename && r.attachments.get(node.filename));
    const label = escapeHtml(node.filename ?? node.alt ?? 'file');

    if (!href) {
      return `[File: ${label}]`;
    }

    return `<a href="${safeHref(href)}" download>${label}</a>`;
  }

  let image = node.src ? `<img src="${safeHref(node.src)}"${alt}${dims}>` : '';

  if (!image && node.filename) {
    const url = r.attachments.get(node.filename);

    if (url) {
      image = `<img src="${safeHref(url)}" alt="${escapeAttr(node.alt ?? node.filename)}"${dims}>`;
    } else {
      // Not migrated yet (two-pass): visible placeholder rewritten by the attachments re-render.
      return `[Image: ${escapeHtml(node.filename)}]`;
    }
  }

  if (!image) return '';

  return node.align && !node.inline
    ? `<p align="${node.align}">${image}</p>`
    : image;
}

function renderUserMention(
  node: Extract<CirNode, { type: 'userMention' }>,
  r: CirResolved,
): string {
  const match = r.users.get(node.sourceId);
  const name =
    match?.displayName || node.displayName || 'Unknown Confluence user';
  const userId = match?.userId ?? '';
  const title = match?.isPlaceholder
    ? ' title="Imported Confluence user is not an active organization member"'
    : '';

  return (
    `<span${title} data-user-mention data-user-id="${escapeAttr(userId)}" ` +
    `data-user-name="${escapeAttr(name)}">@${escapeHtml(name)}</span>`
  );
}

function renderPageLink(
  node: Extract<CirNode, { type: 'pageLink' }>,
  r: CirResolved,
): string {
  const match = r.pages.get(
    pageReferenceKey(node.pageSourceId, node.sourceSpaceKey),
  );
  const text = node.text ?? match?.title ?? 'page';

  if (match) {
    const href = node.fragment
      ? `${match.url}#${encodeURIComponent(node.fragment)}`
      : match.url;

    return `<a href="${safeHref(href)}">${escapeHtml(text)}</a>`;
  }

  return escapeHtml(text);
}

/** Milestone A: degrade a table to a bullet list of rows (cells joined) + a note. */
function renderTableFallback(
  node: Extract<CirNode, { type: 'table' }>,
  r: CirResolved,
): string {
  const rows = node.rows
    .map((row) => {
      const cells = row.cells
        .map((cell) => renderInline(cell.children, r).trim())
        .filter(Boolean)
        .join(' · ');

      return `<li>${cells}</li>`;
    })
    .join('');

  return `<p class="xi-table-note"><em>[table]</em></p><ul class="xi-table-fallback">${rows}</ul>`;
}

/** Milestone B: native table (allow-list extended). */
function renderNativeTable(
  node: Extract<CirNode, { type: 'table' }>,
  r: CirResolved,
): string {
  const rows = node.rows
    .map((row) => {
      const cells = row.cells.map((cell) => renderCell(cell, r)).join('');

      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `<table><tbody>${rows}</tbody></table>`;
}

function renderCell(cell: CirTableCell, r: CirResolved): string {
  const tag = cell.header ? 'th' : 'td';
  const attrs =
    (cell.colspan && cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '') +
    (cell.rowspan && cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '');

  return `<${tag}${attrs}>${renderChildren(cell.children, r)}</${tag}>`;
}
