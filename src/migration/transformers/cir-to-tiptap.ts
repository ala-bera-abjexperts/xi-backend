/**
 * @fileoverview XI-CIR → TipTap JSON. The sibling of `cir-serializer.ts` (which emits HTML).
 *
 * Why this exists: Wiki 2.0's editor is TipTap. A page imported as `content_format: 'html'` is
 * wrapped in a single opaque `rawHtml` atom the first time anyone clicks Edit — which destroys its
 * tables, empties `content_text` (so the page falls out of search), and leaves no text nodes for an
 * inline comment to anchor to. Emitting TipTap directly avoids all three.
 *
 * HARD CONTRACT: `validateTipTapDoc` (common/utils/tiptap-sanitizer.ts) REJECTS unknown node and mark
 * types outright — a stray type does not degrade the node, it fails the whole page write with a 400.
 * So every type emitted here must exist in `NODE_SPECS`, and the parity spec
 * (`tiptap-confluence-parity.spec.ts`) is what keeps the two in step.
 *
 * Structural rules that are easy to get wrong and produce an unopenable document:
 *  - `image` and `fileAttachment` are BLOCK nodes; inline media must use `mediaInline`.
 *  - `listItem`, `taskItem`, `decisionItem`, table cells and `blockquote` take BLOCK content, so a run
 *    of inline children has to be wrapped in a paragraph first.
 *  - headings use all six standard HTML levels, matching Confluence Server storage.
 *  - `userMention.userId` / `wikiLink.pageId` must be UUIDs; unresolved references degrade to text
 *    rather than emitting an attr the validator would reject.
 */

import {
  pageReferenceKey,
  type CirDoc,
  type CirMark,
  type CirNode,
  type CirTableCell,
} from './canonical-ir';
import type { CirResolved } from './cir-serializer';
import { labelsFromCql } from './macros/macro-registry';

/** A TipTap node in its JSON form. */
export interface TipTapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

/** CIR mark → TipTap mark name. Both vocabularies are closed, so this map is total. */
const MARK_NAMES: Record<CirMark, string> = {
  strong: 'bold',
  em: 'italic',
  underline: 'underline',
  strike: 'strike',
  code: 'code',
  subscript: 'subscript',
  superscript: 'superscript',
};

/** Confluence panel type → `callout.variant`. `note`/`tip` were added for this mapping. */
const PANEL_VARIANTS: Record<string, string> = {
  info: 'info',
  note: 'note',
  tip: 'tip',
  warning: 'warning',
  error: 'danger',
  danger: 'danger',
  success: 'success',
  custom: 'custom',
};

/** Confluence status colour → the closed palette the validator accepts. */
const STATUS_COLORS = new Set([
  'neutral',
  'grey',
  'green',
  'blue',
  'red',
  'yellow',
  'purple',
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Image/media dimensions arrive as strings ("240", "240px"); TipTap wants a positive integer. */
function toDim(value: string | undefined): string | number | undefined {
  if (!value) return undefined;

  const raw = String(value).trim();

  // The editor's ResizableImage stores width as a PERCENTAGE string
  // (`data-width="62%"`), so a Confluence `ac:width="50%"` must keep its unit.
  // Stripping it here turned every proportional migrated image into a 50px one.
  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(raw);

  if (pct) return `${pct[1]}%`;

  const n = parseInt(raw.replace(/[^\d]/g, ''), 10);

  return Number.isFinite(n) && n > 0 && n <= 10_000 ? n : undefined;
}

function text(value: string, marks?: TipTapNode['marks']): TipTapNode {
  const node: TipTapNode = { type: 'text', text: value };

  if (marks && marks.length > 0) node.marks = marks;

  return node;
}

/** ADF models indent/alignment as block marks; every target models them as block attrs. */
function blockAttrs(node: { indent?: number; align?: string }): {
  attrs?: Record<string, unknown>;
} {
  const attrs: Record<string, unknown> = {};

  if (node.indent) attrs.indent = Math.min(node.indent, 10);
  if (node.align && node.align !== 'left') attrs.textAlign = node.align;

  return Object.keys(attrs).length > 0 ? { attrs } : {};
}

const LIVE_MACRO_NODES: Record<string, string> = {
  pageTree: 'pageTree',
  recentlyUpdated: 'recentlyUpdated',
  contributors: 'contributors',
  contributorsSummary: 'contributorsSummary',
  contentByLabel: 'contentByLabel',
  labelsList: 'labelsList',
  spaceAttachments: 'spaceAttachments',
  spacesList: 'spacesList',
  liveSearch: 'liveSearch',
  taskReport: 'taskReport',
  changeHistory: 'changeHistory',
  pageTreeSearch: 'pageTreeSearch',
  spaceDetails: 'spaceDetails',
  userList: 'userList',
  userProfile: 'userProfile',
  profilePicture: 'profilePicture',
  popularLabels: 'popularLabels',
  recentlyUsedLabels: 'recentlyUsedLabels',
  relatedLabels: 'relatedLabels',
  contentByUser: 'contentByUser',
  recentlyUpdatedDashboard: 'recentlyUpdatedDashboard',
  contentReportTable: 'contentReportTable',
  decisionReport: 'decisionReport',
  navigationMap: 'navigationMap',
  blogPosts: 'blogPosts',
  rssFeed: 'rssFeed',
  confluenceToc: 'confluenceToc',
};

const LIVE_MACRO_LIMIT_MAX: Record<string, number> = {
  recentlyUpdated: 50,
  contributors: 50,
  contributorsSummary: 50,
  contentByLabel: 50,
  labelsList: 50,
  changeHistory: 100,
  pageTreeSearch: 100,
  userList: 100,
  spaceAttachments: 200,
  spacesList: 200,
  taskReport: 200,
  recentlyUsedLabels: 100,
  relatedLabels: 100,
  contentByUser: 100,
  recentlyUpdatedDashboard: 50,
  contentReportTable: 200,
  decisionReport: 100,
  navigationMap: 60,
};

/** Only the parameters the target node can actually validate are carried across. */
function liveMacroAttrs(node: {
  kind: string;
  params: Record<string, string>;
  sourceName?: string;
  sourceParams?: Record<string, string>;
  sourceBody?: string;
}): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (['blogPosts', 'rssFeed', 'confluenceToc'].includes(node.kind)) attrs.params = node.params;
  const depth = Number(node.params.depth ?? node.params.reverse ?? '');
  const limit = Number(
    node.params.limit ?? node.params.max ?? node.params.maxResults ?? '',
  );
  const split = (
    value: string | undefined,
    maxItems: number,
    separator = /,/,
  ): string[] =>
    (value ?? '')
      .split(separator)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, maxItems)
      .map((item) => item.slice(0, 100));

  if (node.kind === 'pageTree' && Number.isFinite(depth) && depth >= 1) {
    attrs.depth = Math.min(Math.trunc(depth), 10);
  }

  // `children` gets its root from the local page created in the first pass. Never carry a
  // Confluence numeric id into this UUID-only attribute.
  if (node.kind === 'pageTree' && UUID_RE.test(node.params.rootPageId ?? '')) {
    attrs.rootPageId = node.params.rootPageId;
  }

  const limitMax = LIVE_MACRO_LIMIT_MAX[node.kind];

  if (
    node.kind !== 'pageTree' &&
    Number.isFinite(limit) &&
    limit >= 1 &&
    limitMax
  ) {
    attrs.limit = Math.min(Math.trunc(limit), limitMax);
  }

  if (node.kind === 'contentByLabel') {
    // Confluence accepts comma-separated labels and one or more space keys. Keep the source values
    // as constrained attrs: the frontend can use the labels natively and can visibly decline an
    // unresolvable foreign/all-space scope rather than querying outside the current space.
    const labels = split(
      node.params.labels ??
        node.params.label ??
        labelsFromCql(node.params.cql).join(','),
      20,
    );
    const spaceKeys = split(
      node.params.spaces ??
        node.params.space ??
        node.params.spaceKey ??
        node.params.spacekey,
      20,
      /[\s,]+/,
    );

    if (labels.length > 0) attrs.labels = labels;
    if (spaceKeys.length > 0) attrs.spaceKeys = spaceKeys;
  }

  if (node.kind === 'contentReportTable') {
    // Same parameter family as contentbylabel (Server writes `label`, Cloud `labels`); without
    // this mapping the node landed with no labels and rendered "No labels configured".
    const labels = split(node.params.labels ?? node.params.label, 20);
    const spaceKeys = split(
      node.params.spaces ??
        node.params.space ??
        node.params.spaceKey ??
        node.params.spacekey,
      20,
      /[\s,]+/,
    );

    if (labels.length > 0) attrs.labels = labels;
    if (spaceKeys.length > 0) attrs.spaceKeys = spaceKeys;
  }

  if (node.kind === 'labelsList') {
    const excludedLabels = split(node.params.excludedLabels, 20);
    if (excludedLabels.length > 0) attrs.excludedLabels = excludedLabels;
  }

  if (node.kind === 'liveSearch') {
    const placeholder = node.params.placeholder?.trim();
    if (placeholder) attrs.placeholder = placeholder.slice(0, 200);
  }

  if (node.kind === 'recentlyUpdated') {
    const types = split(node.params.types, 10);
    if (types.length > 0) attrs.types = types;
    if (node.params.hideHeading === 'true') attrs.hideHeading = true;
  }

  if (node.kind === 'pageTreeSearch') {
    if (UUID_RE.test(node.params.rootPageId ?? '')) {
      attrs.rootPageId = node.params.rootPageId;
    }
    if (['search', 'pageIndex', 'searchResults'].includes(node.params.mode)) {
      attrs.mode = node.params.mode;
    }
    const query = node.params.query?.trim();
    if (query) attrs.query = query.slice(0, 1000);
  }

  if (node.kind === 'spaceDetails') {
    const width = node.params.width?.trim();
    if (width) attrs.width = width.slice(0, 50);
  }

  if (node.kind === 'userList') {
    const groups = split(node.params.groups, 100);
    if (groups.length > 0) attrs.groups = groups;
  }

  if (node.kind === 'profilePicture') {
    if (UUID_RE.test(node.params.userId ?? '')) {
      attrs.userId = node.params.userId;
    }
    const userKey = node.params.userKey?.trim();
    const userName = node.params.userName?.trim();
    if (userKey) attrs.userKey = userKey.slice(0, 500);
    if (userName) attrs.userName = userName.slice(0, 500);
  }

  if (node.kind === 'userProfile') {
    if (UUID_RE.test(node.params.userId ?? '')) {
      attrs.userId = node.params.userId;
    }
    const userKey = node.params.userKey?.trim();
    const userName = node.params.userName?.trim();
    if (userKey) attrs.userKey = userKey.slice(0, 500);
    if (userName) attrs.userName = userName.slice(0, 500);
  }

  if (node.kind === 'popularLabels') {
    const count = Number(node.params.count ?? '');
    if (Number.isInteger(count) && count >= 1) {
      attrs.count = Math.min(count, 100);
    }
    const spaceKey = node.params.spaceKey?.trim();
    if (spaceKey) attrs.spaceKey = spaceKey.slice(0, 100);
    if (node.params.style === 'list' || node.params.style === 'heatmap') {
      attrs.style = node.params.style;
    }
  }

  if (node.kind === 'recentlyUsedLabels') {
    const count = Number(node.params.count ?? '');
    if (Number.isInteger(count) && count >= 1)
      attrs.count = Math.min(count, 100);
    if (['global', 'space', 'personal'].includes(node.params.scope))
      attrs.scope = node.params.scope;
    if (['list', 'table'].includes(node.params.style))
      attrs.style = node.params.style;
    if (node.params.title?.trim())
      attrs.title = node.params.title.trim().slice(0, 200);
  }

  if (node.kind === 'relatedLabels') {
    const labels = split(node.params.labels ?? node.params.label, 20);
    if (labels.length) attrs.labels = labels;
  }

  if (node.kind === 'contentByUser') {
    const userId = node.params.userId?.trim();
    const userKey = node.params.userKey?.trim();
    const userName = (
      node.params.userName ??
      node.params.name ??
      node.params[''] ??
      ''
    ).trim();
    if (userId && UUID_RE.test(userId)) attrs.userId = userId;
    if (userKey) attrs.userKey = userKey.slice(0, 500);
    if (userName) attrs.userName = userName.slice(0, 500);
  }

  if (node.kind === 'recentlyUpdatedDashboard') {
    const spaceKeys = split(node.params.spaces, 20, /[\s,]+/);
    const types = split(node.params.types, 10);
    const labels = split(node.params.labels, 20);
    const users = split(node.params.users, 20);
    if (spaceKeys.length) attrs.spaceKeys = spaceKeys;
    if (types.length) attrs.types = types;
    if (labels.length) attrs.labels = labels;
    if (users.length) attrs.users = users;
    if (node.params.width?.trim())
      attrs.width = node.params.width.trim().slice(0, 16);
    if (node.params.showProfilePic === 'true') attrs.showProfilePic = true;
  }

  if (node.kind === 'contentReportTable' || node.kind === 'decisionReport') {
    const labels = split(node.params.labels, 20);
    const spaceKeys = split(node.params.spaces, 20, /[\s,]+/);
    if (labels.length) attrs.labels = labels;
    if (spaceKeys.length) attrs.spaceKeys = spaceKeys;
    if (node.kind === 'decisionReport' && node.params.cql?.trim()) {
      attrs.cql = node.params.cql.trim().slice(0, 1000);
    }
  }

  if (node.kind === 'navigationMap') {
    const label = (
      node.params.label ??
      node.params.labels ??
      node.params['']
    )?.trim();
    if (label) attrs.label = label.slice(0, 100);
    const title = (node.params.title ?? node.params.mapTitle)?.trim();
    if (title) attrs.title = title.slice(0, 200);
    const wrapAfter = Number(node.params.wrapAfter);
    if (Number.isInteger(wrapAfter) && wrapAfter >= 1)
      attrs.wrapAfter = Math.min(wrapAfter, 8);
    const cellWidth = node.params.cellWidth?.trim();
    if (cellWidth) {
      const unitless = /^\d+$/.test(cellWidth) ? Number(cellWidth) : null;

      if (unitless !== null && unitless >= 120 && unitless <= 499) {
        attrs.cellWidth = `${unitless}px`;
      } else if (
        /^(?:[1-9]\d?|100)%$|^(?:1[2-9]\d|[2-4]\d{2})px$/.test(cellWidth)
      ) {
        attrs.cellWidth = cellWidth;
      }
    }
  }

  if (node.sourceName) attrs.sourceName = node.sourceName.slice(0, 200);
  if (node.sourceParams) attrs.sourceParams = node.sourceParams;
  if (node.sourceBody !== undefined)
    attrs.sourceBody = node.sourceBody.slice(0, 20_000);

  return attrs;
}

function paragraph(content: TipTapNode[]): TipTapNode {
  return content.length > 0
    ? { type: 'paragraph', content }
    : { type: 'paragraph' };
}

/** TipTap treats these as block-level; they may never appear inside a paragraph. */
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'decisionList',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'table',
  'image',
  'fileAttachment',
  'callout',
  'details',
  'columnList',
  'rawHtml',
  'externalMacro',
  'safeEmbed',
  'carousel',
  'caption',
  'pageTree',
  'attachmentsList',
  'spaceAttachments',
  'spacesList',
  'liveSearch',
  'taskReport',
  'recentlyUpdated',
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
  'excerpt',
  'includePage',
  'excerptInclude',
  'contentProperties',
  'contentPropertiesReport',
  'contributors',
  'contributorsSummary',
  'contentByLabel',
  'labelsList',
  'drawioDiagram',
  'confluenceAnchor',
  'taskCard',
  'chart',
  'gallery',
]);

function isBlock(node: TipTapNode): boolean {
  return BLOCK_TYPES.has(node.type);
}

/**
 * Normalise a mixed run into valid BLOCK content: consecutive inline nodes are gathered into
 * paragraphs, blocks pass through. Without this, a bare text node under `listItem` or a table cell
 * makes the document invalid and the page write fails.
 */
function asBlocks(nodes: TipTapNode[]): TipTapNode[] {
  const out: TipTapNode[] = [];
  let buffer: TipTapNode[] = [];

  const flush = () => {
    if (buffer.length > 0) {
      out.push(paragraph(buffer));
      buffer = [];
    }
  };

  for (const node of nodes) {
    if (isBlock(node)) {
      flush();
      out.push(node);
    } else {
      buffer.push(node);
    }
  }

  flush();

  // Every block container in the TipTap schema needs at least one child.
  return out.length > 0 ? out : [paragraph([])];
}

/** Drop blocks that wandered into an inline run (they cannot be represented there). */
function asInline(nodes: TipTapNode[]): TipTapNode[] {
  return nodes.filter((n) => !isBlock(n));
}

export function cirToTipTap(doc: CirDoc, resolved: CirResolved): TipTapNode {
  const content = asBlocks(renderMany(doc.children, resolved, []));

  return { type: 'doc', content };
}

function renderMany(
  nodes: CirNode[],
  r: CirResolved,
  marks: TipTapNode['marks'],
): TipTapNode[] {
  return nodes.flatMap((node) => renderNode(node, r, marks));
}

function renderNode(
  node: CirNode,
  r: CirResolved,
  marks: TipTapNode['marks'] = [],
): TipTapNode[] {
  switch (node.type) {
    case 'text': {
      if (!node.text) return [];

      const own: TipTapNode['marks'] = [
        ...(marks ?? []),
        ...(node.marks ?? []).map((m) => ({ type: MARK_NAMES[m] })),
      ];

      if (node.link) {
        own.push({ type: 'link', attrs: { href: node.link } });
      }

      if (node.color) {
        own.push({ type: 'textStyle', attrs: { color: node.color } });
      }

      return [text(node.text, own)];
    }

    case 'hardBreak':
      return [{ type: 'hardBreak' }];

    case 'paragraph': {
      const rendered = renderMany(node.children, r, marks);
      const attrs = blockAttrs(node);

      // A macro may legitimately sit INLINE and still resolve to a block node — Confluence allows an
      // `inlineExtension` inside a paragraph, and all 4 `pagetree` macros in the customer's space are
      // shaped exactly that way. `asInline` would drop them, so promote them to siblings instead,
      // which is what the HTML serializer already does for the same situation.
      if (rendered.some(isBlock)) {
        return asBlocks(rendered).map((n) =>
          n.type === 'paragraph' ? { ...n, ...attrs } : n,
        );
      }

      return [{ ...paragraph(rendered), ...attrs }];
    }

    case 'heading':
      return [
        {
          type: 'heading',
          // Confluence storage has all six standard HTML heading levels.
          attrs: {
            level: Math.min(Math.max(node.level || 1, 1), 6),
            ...(node.anchorId ? { id: node.anchorId } : {}),
            ...(blockAttrs(node).attrs ?? {}),
          },
          content: asInline(renderMany(node.children, r, marks)),
        },
      ];

    case 'list':
      return [
        {
          type: node.ordered ? 'orderedList' : 'bulletList',
          ...(node.ordered && node.start !== undefined
            ? { attrs: { start: node.start } }
            : {}),
          content: node.items.map((item) => ({
            type: 'listItem',
            content: asBlocks(renderMany(item, r, marks)),
          })),
        },
      ];

    case 'taskList':
      return [
        {
          type: 'taskList',
          content: node.items.map((item) => ({
            type: 'taskItem',
            attrs: { checked: item.checked },
            content: asBlocks(renderMany(item.children, r, marks)),
          })),
        },
      ];

    case 'decisionList':
      return [
        {
          type: 'decisionList',
          content: node.items.map((item) => ({
            type: 'decisionItem',
            attrs: { state: item.decided ? 'DECIDED' : 'UNDECIDED' },
            content: asBlocks(renderMany(item.children, r, marks)),
          })),
        },
      ];

    case 'caption':
      return [
        {
          type: 'caption',
          content: asInline(renderMany(node.children, r, marks)),
        },
      ];

    case 'excerpt':
      return [
        {
          type: 'excerpt',
          attrs: {
            hidden: node.hidden,
            ...(node.name ? { name: node.name } : {}),
            ...(node.sourceParams ? { sourceParams: node.sourceParams } : {}),
          },
          content: asBlocks(renderMany(node.children, r, marks)),
        },
      ];

    case 'includePage':
      return [
        {
          type: 'includePage',
          attrs: {
            pageId: node.pageId,
            title: node.title,
            ...(node.targetSpaceId
              ? { targetSpaceId: node.targetSpaceId }
              : {}),
            ...(node.targetSpaceKey
              ? { targetSpaceKey: node.targetSpaceKey }
              : {}),
            ...(node.sourceParams ? { sourceParams: node.sourceParams } : {}),
            ...(node.sourceReference
              ? { sourceReference: node.sourceReference }
              : {}),
          },
        },
      ];

    case 'excerptInclude':
      return [
        {
          type: 'excerptInclude',
          attrs: {
            pageId: node.pageId,
            title: node.title,
            ...(node.targetSpaceId
              ? { targetSpaceId: node.targetSpaceId }
              : {}),
            ...(node.targetSpaceKey
              ? { targetSpaceKey: node.targetSpaceKey }
              : {}),
            ...(node.excerptName ? { excerptName: node.excerptName } : {}),
            nopanel: node.nopanel,
            ...(node.sourceParams ? { sourceParams: node.sourceParams } : {}),
            ...(node.sourceReference
              ? { sourceReference: node.sourceReference }
              : {}),
          },
        },
      ];

    // Wiki 2.0 already has a native draw.io node that stores the mxfile inline, so a resolved
    // diagram migrates as a real, editable drawing. Unresolved → a named placeholder, because
    // `drawioDiagram.attrs.xml` is required and an empty one would be rejected on write.
    case 'diagram':
      return node.xml
        ? [
            {
              type: 'drawioDiagram',
              attrs: {
                xml: node.xml,
                caption: node.name,
                ...(r.attachments.get(`${node.name}.png`)
                  ? { preview: r.attachments.get(`${node.name}.png`) }
                  : {}),
              },
            },
          ]
        : [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: `[Diagram: ${node.name}]`,
                  marks: [{ type: 'italic' }],
                },
              ],
            },
          ];

    case 'blockquote':
      return [
        {
          type: 'blockquote',
          content: asBlocks(renderMany(node.children, r, marks)),
        },
      ];

    case 'codeBlock':
      return [
        {
          type: 'codeBlock',
          ...(node.language ? { attrs: { language: node.language } } : {}),
          ...(node.text ? { content: [text(node.text)] } : {}),
        },
      ];

    case 'rule':
      // A real node here — the HTML serializer had to fake it with `<p>———</p>` because `<hr>`
      // is not on the HTML allow-list.
      return [{ type: 'horizontalRule' }];

    case 'link': {
      const href = (node.href ?? '').trim();

      // A link with no destination is not a link — degrade to its text, the same
      // way an unresolved `userMention`/`wikiLink` degrades rather than emitting
      // an attr the validator would reject. The storage-XHTML producer already
      // drops these, but the ADF path builds `link` nodes too, so the guard
      // belongs here as well: the write gate would otherwise have to strip an
      // empty href on every save, and until it did, one such anchor failed the
      // ENTIRE page (214 of a customer's 216 pages).
      if (!href) return asInline(renderMany(node.children, r, marks));

      // TipTap models links as a MARK, not a node, so push it onto the children.
      const linkMark = { type: 'link', attrs: { href } };

      return asInline(
        renderMany(node.children, r, [...(marks ?? []), linkMark]),
      );
    }

    case 'media':
      // Inline media MUST use the inline node: a block `image` inside a paragraph is stripped by
      // `asInline`, which is how all 17 of the space's inline images were silently lost.
      return node.inline ? [renderMediaInline(node, r)] : renderMedia(node, r);

    case 'date':
      return [{ type: 'date', attrs: { timestamp: node.timestamp } }];

    case 'inlineCard':
      return [
        {
          type: 'inlineCard',
          attrs: {
            url: node.url,
            ...(node.title ? { title: node.title } : {}),
            ...(node.sourceMacro ? { sourceMacro: node.sourceMacro } : {}),
            ...(node.sourceParams ? { sourceParams: node.sourceParams } : {}),
            ...(node.sourceBody !== undefined
              ? { sourceBody: node.sourceBody }
              : {}),
          },
        },
      ];

    case 'safeEmbed':
      return [
        {
          type: 'safeEmbed',
          attrs: {
            url: node.url,
            ...(node.title ? { title: node.title } : {}),
            ...(node.width ? { width: node.width } : {}),
            ...(node.height ? { height: node.height } : {}),
            ...(node.align ? { align: node.align } : {}),
            ...(node.frameBorder !== undefined
              ? { frameBorder: node.frameBorder }
              : {}),
            ...(node.scrolling ? { scrolling: node.scrolling } : {}),
            sourceMacro: node.sourceMacro,
            sourceParams: node.sourceParams,
            sourceBody: node.sourceBody,
          },
        },
      ];

    case 'carousel':
      return [
        {
          type: 'carousel',
          attrs: {
            frames: node.frames,
            sourceMacro: node.sourceMacro,
            sourceParams: node.sourceParams,
            sourceBody: node.sourceBody,
          },
        },
      ];

    // Live macros keep querying after the migration, exactly as they do in Confluence. `spaceKey` and
    // page ids are left to the node's own resolution: the source ids are Confluence's, and these attrs
    // are validated as UUIDs, so passing them through would be rejected on write.
    case 'liveMacro':
      return [
        { type: LIVE_MACRO_NODES[node.kind], attrs: liveMacroAttrs(node) },
      ];

    case 'createSpaceButton':
      return [
        {
          type: 'createSpaceButton',
          attrs: {
            size: node.size,
            sourceName: node.sourceName,
            sourceParams: node.sourceParams,
          },
        },
      ];

    case 'chart':
      return [
        {
          type: 'chart',
          attrs: {
            ...(node.chartType ? { type: node.chartType } : {}),
            ...(node.title ? { title: node.title } : {}),
            ...(node.subtitle ? { subtitle: node.subtitle } : {}),
            ...(node.xLabel ? { xLabel: node.xLabel } : {}),
            ...(node.yLabel ? { yLabel: node.yLabel } : {}),
            ...(node.width ? { width: node.width } : {}),
            ...(node.height ? { height: node.height } : {}),
            ...(node.legend !== undefined ? { legend: node.legend } : {}),
            ...(node.orientation ? { orientation: node.orientation } : {}),
            ...(node.stacked !== undefined ? { stacked: node.stacked } : {}),
            ...(node.sourceParams ? { sourceParams: node.sourceParams } : {}),
          },
          content: asBlocks(renderMany(node.children, r, marks)),
        },
      ];

    case 'gallery':
      return [
        {
          type: 'gallery',
          attrs: {
            ...(node.title ? { title: node.title } : {}),
            ...(node.columns ? { columns: node.columns } : {}),
            ...(node.include ? { include: node.include } : {}),
            ...(node.exclude ? { exclude: node.exclude } : {}),
            ...(node.includeLabel ? { includeLabel: node.includeLabel } : {}),
            ...(node.excludeLabel ? { excludeLabel: node.excludeLabel } : {}),
            ...(node.sort ? { sort: node.sort } : {}),
            ...(node.reverse !== undefined ? { reverse: node.reverse } : {}),
            ...(node.limit ? { limit: node.limit } : {}),
            ...(node.captions !== undefined ? { captions: node.captions } : {}),
            ...(node.sourceParams ? { sourceParams: node.sourceParams } : {}),
          },
        },
      ];

    case 'externalMacro':
      return [
        {
          type: 'externalMacro',
          attrs: { name: node.name, params: node.params },
          content: [
            paragraph([
              text(`${node.name} (external macro)`, [{ type: 'italic' }]),
            ]),
          ],
        },
      ];

    case 'jiraIssue': {
      const mapped = r.jiraIssues?.get(node.key);

      if (mapped) {
        return [
          {
            type: 'taskCard',
            attrs: {
              config: {
                taskKey: mapped.taskKey,
                sourceMacro: node.macroName,
                sourceParams: node.params,
                sourceBody: JSON.stringify(node.children),
                ...(node.sourceUrl ? { sourceUrl: node.sourceUrl } : {}),
              },
            },
          },
        ];
      }

      return [
        {
          type: 'externalMacro',
          attrs: {
            name: node.macroName,
            params: node.params,
            ...(node.sourceUrl ? { sourceUrl: node.sourceUrl } : {}),
          },
          content: asBlocks(renderMany(node.children, r, marks)),
        },
      ];
    }

    case 'contentProperties':
      return [
        {
          type: 'contentProperties',
          attrs: {
            ...(node.propertyId ? { propertyId: node.propertyId } : {}),
            hidden: node.hidden,
            rows: node.rows,
            sourceParams: node.sourceParams,
            sourceBody: node.sourceBody,
          },
        },
      ];

    case 'contentPropertiesReport':
      return [
        {
          type: 'contentPropertiesReport',
          attrs: {
            label: node.label,
            ...(node.propertyId ? { propertyId: node.propertyId } : {}),
            titleColumn: node.titleColumn,
            columns: node.columns,
            limit: node.limit,
            ...(node.sortBy ? { sortBy: node.sortBy } : {}),
            sourceParams: node.sourceParams,
          },
        },
      ];

    case 'anchor':
      return [{ type: 'confluenceAnchor', attrs: { name: node.name } }];

    case 'userMention':
      return [renderUserMention(node, r)];

    case 'pageLink':
      return [renderPageLink(node, r)];

    case 'panel':
      return [
        {
          type: 'callout',
          attrs: {
            variant:
              PANEL_VARIANTS[String(node.variant ?? '').toLowerCase()] ??
              'info',
            ...(node.title ? { title: node.title } : {}),
            ...(node.backgroundColor
              ? { backgroundColor: node.backgroundColor }
              : {}),
            ...(node.borderColor ? { borderColor: node.borderColor } : {}),
            ...(node.borderStyle ? { borderStyle: node.borderStyle } : {}),
            ...(node.borderWidth !== undefined
              ? { borderWidth: node.borderWidth }
              : {}),
            ...(node.titleBackgroundColor
              ? { titleBackgroundColor: node.titleBackgroundColor }
              : {}),
            ...(node.titleColor ? { titleColor: node.titleColor } : {}),
          },
          content: asBlocks(renderMany(node.children, r, marks)),
        },
      ];

    case 'table':
      return [
        {
          type: 'table',
          content: node.rows.map((row) => ({
            type: 'tableRow',
            content: row.cells.map((cell) => renderCell(cell, r)),
          })),
        },
      ];

    case 'status': {
      const color = String(node.color ?? '').toLowerCase();

      return [
        {
          type: 'status',
          attrs: {
            text: node.text ?? '',
            color: STATUS_COLORS.has(color) ? color : 'neutral',
          },
        },
      ];
    }

    case 'expand':
      // A real disclosure widget, unlike the HTML path which flattened it to a styled div.
      return [
        {
          type: 'details',
          content: [
            {
              type: 'detailsSummary',
              content: [text(node.title || 'Details')],
            },
            {
              type: 'detailsContent',
              content: asBlocks(renderMany(node.children, r, marks)),
            },
          ],
        },
      ];

    case 'layout':
      return [
        {
          type: 'columnList',
          content: node.columns.map((col, index) => ({
            type: 'column',
            ...(Number.isInteger(node.widths?.[index]) &&
            Number(node.widths?.[index]) >= 1 &&
            Number(node.widths?.[index]) <= 100
              ? { attrs: { width: node.widths![index] } }
              : {}),
            content: asBlocks(renderMany(col, r, marks)),
          })),
        },
      ];

    case 'macroDeferred':
      // Preserved as a labelled card rather than dropped, so an operator can see what was there.
      return [
        {
          type: 'externalMacro',
          attrs: { name: node.name },
          content: [paragraph([])],
        },
      ];

    case 'attachmentsMacro':
      // Becomes a LIVE node that lists the page's attachments at view time.
      return [{ type: 'attachmentsList', attrs: {} }];

    case 'tocMarker':
      // Replaced upstream by content-transform; if one survives it carries no content.
      return [];

    case 'raw':
      return node.html ? [{ type: 'rawHtml', attrs: { html: node.html } }] : [];

    default:
      return [];
  }
}

/**
 * Media resolves through the attachment crosswalk. An unresolved reference degrades to text rather
 * than emitting a broken `image` — the `page_attachments` re-render pass fills it in on the second
 * pass, exactly as the HTML path did.
 */
/**
 * Content type for the common Confluence attachment formats, derived from the filename.
 * Returns null for anything unrecognised — the card simply omits its caption line, which
 * is better than guessing `application/octet-stream` at every reader.
 */
function mimeFromFilename(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop();

  if (!ext || ext === name.toLowerCase()) return null;

  const byExt: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    csv: 'text/csv',
    txt: 'text/plain',
    zip: 'application/zip',
    json: 'application/json',
    xml: 'application/xml',
  };

  return byExt[ext] ?? null;
}

function renderMedia(
  node: Extract<CirNode, { type: 'media' }>,
  r: CirResolved,
): TipTapNode[] {
  const src =
    node.src ?? (node.filename ? r.attachments.get(node.filename) : undefined);

  // A `view-file` attachment is a download card, not an inline image. Handled before the
  // unresolved-src guard so a missing crosswalk row degrades to a file placeholder rather
  // than claiming the PDF was an image.
  if (node.kind === 'file') {
    if (!src) {
      return [text(`[File: ${node.filename ?? 'unresolved'}]`)];
    }

    const name = node.filename ?? node.alt ?? 'file';

    return [
      {
        type: 'fileAttachment',
        attrs: {
          url: src,
          name,
          ...(node.filename && r.attachmentPreviews?.get(node.filename)
            ? { previewUrl: r.attachmentPreviews.get(node.filename) }
            : {}),

          // Confluence gives no size or content type for a view-file attachment, but the
          // card only renders its caption line when one of them is present. Deriving mime
          // from the extension makes an IMPORTED card look the same as one inserted with
          // the `/file` command, which always carries a real mime from the upload.
          mime: mimeFromFilename(name),
          ...(node.sourceMacro ? { sourceMacro: node.sourceMacro } : {}),
          ...(node.sourceParams ? { sourceParams: node.sourceParams } : {}),
          ...(node.sourceBody !== undefined
            ? { sourceBody: node.sourceBody }
            : {}),
          ...(node.filename && !node.src ? { localAttachment: true } : {}),
        },
      },
    ];
  }

  if (!src) {
    return [text(`[Image: ${node.filename ?? 'unresolved'}]`)];
  }

  const width = toDim(node.width);
  const height = toDim(node.height);

  return [
    {
      type: 'image',
      attrs: {
        src,
        alt: node.alt ?? node.filename ?? '',
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(node.align ? { textAlign: node.align } : {}),
      },
    },
  ];
}

/** Inline variant used when media appears inside a run of text. */
export function renderMediaInline(
  node: Extract<CirNode, { type: 'media' }>,
  r: CirResolved,
): TipTapNode {
  const src =
    node.src ?? (node.filename ? r.attachments.get(node.filename) : undefined);

  return {
    type: 'mediaInline',
    attrs: {
      ...(src ? { src } : {}),
      ...(node.filename ? { name: node.filename } : {}),
    },
  };
}

function renderUserMention(
  node: Extract<CirNode, { type: 'userMention' }>,
  r: CirResolved,
): TipTapNode {
  const hit = r.users.get(node.sourceId);
  const placeholder = hit?.isPlaceholder;
  const label =
    hit?.displayName || node.displayName || 'Unknown Confluence user';

  // `userMention.userId` must be a UUID; an unresolved author degrades to plain text so the mention
  // still reads correctly instead of failing validation.
  if (hit && UUID_RE.test(hit.userId)) {
    return {
      type: 'userMention',
      attrs: {
        userId: hit.userId,
        userName: label,
        ...(placeholder ? { isPlaceholder: true } : {}),
      },
    };
  }

  return text(`@${label}`);
}

function renderPageLink(
  node: Extract<CirNode, { type: 'pageLink' }>,
  r: CirResolved,
): TipTapNode {
  const hit = r.pages.get(
    pageReferenceKey(node.pageSourceId, node.sourceSpaceKey),
  );
  const label = node.text || hit?.title || node.pageSourceId;
  const pageId = hit?.pageId ?? hit?.url?.split('/').pop() ?? '';

  if (hit && UUID_RE.test(pageId)) {
    return {
      type: 'wikiLink',
      attrs: {
        pageId,
        pageTitle: hit.title ?? label,
        ...(hit.pageSlug ? { pageSlug: hit.pageSlug } : {}),
        ...(hit.spaceKey ? { spaceKey: hit.spaceKey } : {}),
        ...(node.fragment ? { fragment: node.fragment } : {}),
        label,
      },
    };
  }

  return text(label);
}

function renderCell(cell: CirTableCell, r: CirResolved): TipTapNode {
  const attrs: Record<string, unknown> = {};

  if (cell.colspan && cell.colspan > 1) attrs.colspan = cell.colspan;
  if (cell.rowspan && cell.rowspan > 1) attrs.rowspan = cell.rowspan;

  return {
    type: cell.header ? 'tableHeader' : 'tableCell',
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    content: asBlocks(renderMany(cell.children, r, [])),
  };
}
