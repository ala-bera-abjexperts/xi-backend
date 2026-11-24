/**
 * @fileoverview CF-B macro registry — semantic translation of Confluence macros into XI-CIR.
 *
 * Handlers are pure `(ParsedMacro, MacroContext) → CirNode | CirNode[] | null` and map into
 * mostly-existing CIR nodes (panel/codeBlock/status/expand/layout/list/...). They are source-agnostic:
 * the storage-XHTML and ADF parsers both normalise a macro into `ParsedMacro` before dispatch.
 *
 * Cross-page macros (children/include/excerpt-include/jira) can't resolve at first render — the
 * target page/issue may not be migrated yet — so they emit a VISIBLE placeholder and call
 * `ctx.markNeedsRelink()`; the `page_relink` stage re-renders the page once every ref exists.
 * Unknown macros never vanish: they render an `externalMacro` card naming the macro and PRESERVING
 * every `ac:parameter`, followed by any body, and log a lossy row. The card matters for bodyless
 * macros, whose parameters are their only content — the old italic-text note threw those away.
 */

import { CONFLUENCE_LOREM_PARAGRAPHS } from './confluence-placeholder-text';
import {
  pageReferenceKey,
  type CirNode,
  type ParsedMacro,
} from '../canonical-ir';

export interface MacroContext {
  nativeCommunicationMacros?: boolean;
  /** Provenance-tied lossy report → migration_logs (level:'warn', stage:'page'). */
  log?: (message: string, meta?: Record<string, unknown>) => void;
  /** Flag the owning page so the `page_relink` stage re-renders it after all refs exist. */
  markNeedsRelink?: () => void;
  /** Resolved child-page links for a `children` macro, injected during the relink pass. */
  childPages?: { url: string; title: string }[];
  /** Local page id, available only once the first page-create pass has completed. */
  currentPageId?: string;
  /** Resolved local targets for `include` / `excerpt-include`, keyed by source page title. */
  includePages?: Record<
    string,
    {
      pageId: string;
      url: string;
      title: string;
      targetSpaceId?: string;
      targetSpaceKey?: string;
    }
  >;
  /** Source space of the page being rendered; scopes an unqualified include title. */
  currentSourceSpaceKey?: string;
  /** Stored excerpt fragments keyed by source page title; carried only by repair helpers. */
  includeExcerptContent?: Record<string, string>;
  /** Base URL of the source Jira/Confluence (for `jira`/external issue links). */
  sourceBaseUrl?: string;
  /** Source reference for output that still depends on Confluence. */
  sourcePageUrl?: string;
}

export type MacroHandler = (
  macro: ParsedMacro,
  ctx: MacroContext,
) => CirNode | CirNode[] | null;

type LiveMacroKind = Extract<CirNode, { type: 'liveMacro' }>['kind'];

const PANEL_VARIANTS: Record<string, string> = {
  info: 'info',
  note: 'note',
  warning: 'warning',
  tip: 'tip',
  success: 'success',
  panel: 'custom',
};

/**
 * Confluence info/note/warning/tip panels carry NO `title` param — the label is implicit in the
 * macro name. Without this the panel renders as an unlabelled quote block and the reader loses the
 * "this is a warning" signal entirely. An explicit `title` param always wins.
 */
const PANEL_LABELS: Record<string, string> = {
  info: 'Info',
  note: 'Note',
  warning: 'Warning',
  tip: 'Tip',
  success: 'Success',
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]{0,254}-[1-9]\d*$/i;

const panelParam = (
  params: Record<string, string>,
  ...names: string[]
): string | undefined => {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const hit = Object.entries(params).find(([name]) =>
    wanted.has(name.toLowerCase()),
  );

  return hit?.[1]?.trim() || undefined;
};

const safePanelColor = (value: string | undefined): string | undefined =>
  value &&
  value.length <= 64 &&
  /^(?:#[0-9a-f]{3,8}|[a-z]{1,32}|rgba?\([\d\s.,%+/-]+\))$/i.test(value)
    ? value
    : undefined;

const safePanelBorderStyle = (
  value: string | undefined,
): 'solid' | 'dashed' | 'dotted' | 'double' | 'none' | undefined => {
  const normalized = value?.toLowerCase();

  return normalized === 'solid' ||
    normalized === 'dashed' ||
    normalized === 'dotted' ||
    normalized === 'double' ||
    normalized === 'none'
    ? normalized
    : undefined;
};

const safePanelBorderWidth = (
  value: string | undefined,
): number | undefined => {
  const match = /^(\d+)(?:px)?$/i.exec(value ?? '');
  const width = match ? Number(match[1]) : NaN;

  return Number.isInteger(width) && width >= 0 && width <= 10
    ? width
    : undefined;
};

/** info/note/warning/tip/success/panel → native callout with safe presentation attrs. */
const panelHandler: MacroHandler = (macro) => {
  const title = panelParam(macro.params, 'title') ?? PANEL_LABELS[macro.name];
  const backgroundColor = safePanelColor(
    panelParam(macro.params, 'bgColor', 'backgroundColor'),
  );
  const borderColor = safePanelColor(panelParam(macro.params, 'borderColor'));
  const borderStyle = safePanelBorderStyle(
    panelParam(macro.params, 'borderStyle'),
  );
  const borderWidth = safePanelBorderWidth(
    panelParam(macro.params, 'borderWidth'),
  );
  const titleBackgroundColor = safePanelColor(
    panelParam(macro.params, 'titleBGColor', 'titleBackgroundColor'),
  );
  const titleColor = safePanelColor(panelParam(macro.params, 'titleColor'));

  return {
    type: 'panel',
    variant: PANEL_VARIANTS[macro.name],
    ...(title ? { title } : {}),
    ...(backgroundColor ? { backgroundColor } : {}),
    ...(borderColor ? { borderColor } : {}),
    ...(borderStyle ? { borderStyle } : {}),
    ...(borderWidth !== undefined ? { borderWidth } : {}),
    ...(titleBackgroundColor ? { titleBackgroundColor } : {}),
    ...(titleColor ? { titleColor } : {}),
    children: macro.richBody,
  };
};

/** code/noformat → <pre><code class="language-…"> from the plain-text body. */
const codeHandler: MacroHandler = (macro) => ({
  type: 'codeBlock',
  language: macro.params.language || undefined,
  text: macro.plainBody,
});

/** status → <span class="xi-status xi-status-{colour}">. */
const statusHandler: MacroHandler = (macro) => {
  const text = macro.params.title || macro.plainBody || 'status';
  const color = (macro.params.colour || macro.params.color || '').toLowerCase();

  return { type: 'status', text, color: color || undefined };
};

/** expand → <div class="xi-expand"> (no <details> — not allow-listed). */
const expandHandler: MacroHandler = (macro) => ({
  type: 'expand',
  title: macro.params.title || undefined,
  children: macro.richBody,
});

/** toc → placeholder replaced (post-parse) with a list of the doc's headings. */
const tocHandler: MacroHandler = (macro, ctx) => ctx.nativeCommunicationMacros
  ? { type: 'liveMacro', kind: 'confluenceToc', params: macro.params, sourceName: macro.name, sourceParams: macro.params }
  : { type: 'tocMarker' };

function safeFeedUrl(raw: string | undefined): string | undefined {
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  try {
    const url = new URL(raw.trim());
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

const feedReferenceHandler: MacroHandler = (macro, ctx) => {
  const blog = macro.name === 'blog-posts';
  if (ctx.nativeCommunicationMacros) {
    const supported = blog ? ['content', 'time', 'label', 'author', 'spaces', 'max', 'sort', 'reverse'] : ['url', 'max', 'showTitlesOnly', 'titleBar'];
    const unsupported = Object.keys(macro.params).filter(key => !supported.includes(key));
    if (unsupported.length) ctx.log?.('Macro has additional source parameters', { macroName: macro.name, reason: `Unsupported parameters preserved: ${unsupported.join(', ')}` });
    return [
      { type: 'liveMacro', kind: blog ? 'blogPosts' : 'rssFeed', params: macro.params, sourceName: macro.name, sourceParams: macro.params, sourceBody: macro.plainBody },
      ...macro.richBody,
    ];
  }
  const href = safeFeedUrl(
    blog ? ctx.sourcePageUrl : panelParam(macro.params, 'url', ''),
  );
  const preserved = fidelityCard(
    macro,
    ctx,
    href
      ? 'external dynamic output preserved as a source link; content is not fetched or reproduced'
      : 'external dynamic output has no safe HTTP(S) source reference',
  );
  if (!href) return preserved;
  return [
    {
      type: 'paragraph',
      children: [
        {
          type: 'link',
          href,
          preserveSource: true,
          children: [
            {
              type: 'text',
              text: blog
                ? 'Blog posts (source Confluence page)'
                : 'RSS feed (external)',
            },
          ],
        },
      ],
    },
    ...(Array.isArray(preserved) ? preserved : [preserved]),
  ];
};

/** attachments → placeholder replaced (post-resolve) with the page's attachment links. */
const attachmentsHandler: MacroHandler = () => ({ type: 'attachmentsMacro' });

/**
 * view-file → a download card for one attached document (XE-T456).
 *
 * The filename arrives already unwrapped: `paramValue` resolves a nested
 * `<ri:attachment ri:filename="…"/>` inside `<ac:parameter ac:name="name">`, so no
 * parser change is needed. Emitting a `media` node (kind 'file') rather than a bespoke
 * type is what gets the filename into `collectRefs` → `resolveRefs`, which is the only
 * path that maps it to a migrated Storage URL.
 *
 * `ri:url` covers the variant pointing at an external file instead of an attachment.
 */
function attachmentFilename(value: string | undefined): string | undefined {
  const raw = value?.trim();

  if (!raw) return undefined;

  const wrapped = /(?:^|,|\[)\s*filename\s*=\s*([^,\]]+)/i.exec(raw)?.[1];

  if (/^AttachmentResourceIdentifier\[/i.test(raw) && !wrapped) {
    return undefined;
  }

  return (wrapped ?? raw).trim() || undefined;
}

const viewFileHandler: MacroHandler = (macro, ctx) => {
  const filename = attachmentFilename(
    macro.params.name ?? macro.params.filename ?? macro.params[''],
  );
  const candidateUrl = macro.params.url?.trim();
  const externalUrl =
    candidateUrl && /^https?:\/\//i.test(candidateUrl)
      ? candidateUrl
      : undefined;

  if (!filename && !externalUrl) {
    return fidelityCard(
      macro,
      ctx,
      'file macro has no attachment name or safe URL',
    );
  }

  return {
    type: 'media',
    kind: 'file',
    sourceMacro: macro.name,
    sourceParams: { ...macro.params },
    sourceBody: macro.plainBody,
    ...(externalUrl ? { src: externalUrl } : {}),
    ...(filename ? { filename } : {}),
  };
};

function safeEmbedUrl(raw: string | undefined): string | null {
  if (!raw) return null;

  try {
    const url = new URL(raw.trim());

    if (url.protocol !== 'https:') return null;

    if (url.hostname === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return id && /^[A-Za-z0-9_-]{11}$/.test(id)
        ? `https://www.youtube.com/embed/${id}`
        : null;
    }

    if (url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com') {
      const id =
        url.pathname === '/watch'
          ? url.searchParams.get('v')
          : /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})/.exec(url.pathname)?.[1];
      return id && /^[A-Za-z0-9_-]{11}$/.test(id)
        ? `https://www.youtube.com/embed/${id}`
        : null;
    }

    if (url.hostname === 'vimeo.com' || url.hostname === 'www.vimeo.com') {
      const id = /^\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
      return id ? `https://player.vimeo.com/video/${id}` : null;
    }

    if (url.hostname === 'player.vimeo.com') {
      const id = /^\/video\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
      return id ? `https://player.vimeo.com/video/${id}` : null;
    }
  } catch {
    return null;
  }

  return null;
}

function boundedMacroDimension(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 2000
    ? parsed
    : undefined;
}

const safeEmbedHandler: MacroHandler = (macro, ctx) => {
  const embedUrl = safeEmbedUrl(macro.params.url);

  if (
    !embedUrl ||
    macro.richBody.length > 0 ||
    macro.plainBody.trim().length > 0
  ) {
    return fidelityCard(
      macro,
      ctx,
      'iframe/widget provider or body is not supported safely',
    );
  }

  return {
    type: 'safeEmbed',
    sourceMacro: macro.name,
    url: macro.params.url.trim(),
    embedUrl,
    ...(macro.params.title?.trim()
      ? { title: macro.params.title.trim().slice(0, 255) }
      : {}),
    ...(boundedMacroDimension(macro.params.width)
      ? { width: boundedMacroDimension(macro.params.width) }
      : {}),
    ...(boundedMacroDimension(macro.params.height)
      ? { height: boundedMacroDimension(macro.params.height) }
      : {}),
    ...(macro.params.align === 'right' ? { align: 'right' as const } : {}),
    ...(macro.params.frameborder === 'hide'
      ? { frameBorder: false }
      : macro.params.frameborder === 'show'
        ? { frameBorder: true }
        : {}),
    ...(macro.params.scrolling === 'yes' ||
    macro.params.scrolling === 'no' ||
    macro.params.scrolling === 'auto'
      ? { scrolling: macro.params.scrolling }
      : {}),
    sourceParams: { ...macro.params },
    sourceBody: macro.plainBody,
  };
};

const cardHandler: MacroHandler = (macro, ctx) => {
  const known = new Set(['url', 'link', 'title']);
  const url = (macro.params.url || macro.params.link || '').trim();
  const hasUnknownParams = Object.keys(macro.params).some(
    (key) => !known.has(key),
  );

  if (
    !url ||
    hasUnknownParams ||
    macro.richBody.length > 0 ||
    macro.plainBody.trim().length > 0
  ) {
    return fidelityCard(
      macro,
      ctx,
      'rich or dynamic cards cannot map losslessly to inlineCard',
    );
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('unsafe card URL');
  } catch {
    return fidelityCard(macro, ctx, 'card URL is not safe');
  }

  return {
    type: 'inlineCard',
    url,
    ...(macro.params.title?.trim()
      ? { title: macro.params.title.trim().slice(0, 1000) }
      : {}),
    sourceMacro: macro.name,
    sourceParams: { ...macro.params },
    sourceBody: macro.plainBody,
  };
};

function safeCarouselLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;

  try {
    return new URL(trimmed).protocol === 'https:' ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

const carouselHandler: MacroHandler = (macro, ctx) => {
  if (macro.richBody.length > 0 || macro.plainBody.trim()) {
    return fidelityCard(
      macro,
      ctx,
      'carousel body cannot be parsed losslessly',
    );
  }

  const frames = [1, 2, 3].flatMap((index) => {
    const title = (macro.params[`title${index}`] || '').slice(0, 255);
    const description = (macro.params[`description${index}`] || '').slice(
      0,
      700,
    );
    const url = safeCarouselLink(
      macro.params[`link${index}`] || macro.params[`url${index}`],
    );
    const image = macro.params[`image${index}`]?.trim();

    if (!title && !description && !url && !image) return [];
    return [
      {
        title,
        description,
        ...(url ? { url } : {}),
        ...(image?.startsWith('/') && !image.startsWith('//') ? { image } : {}),
      },
    ];
  });

  if (!frames.length)
    return fidelityCard(macro, ctx, 'carousel has no safe frames');

  return {
    type: 'carousel',
    sourceMacro: macro.name,
    frames,
    sourceParams: { ...macro.params },
    sourceBody: macro.plainBody,
  };
};

/**
 * chart → the generated chart IMAGE (saved as an attachment) plus the data table
 * that produced it.
 *
 * The image only exists when the author set the `attachment` param; charts are
 * usually rendered on the fly, in which case there is nothing to point at and we
 * return null so the caller's `externalMacro` fallback keeps the parameters and
 * the body. Either way the data table in `richBody` survives — previously the
 * whole macro collapsed to a one-line note.
 */
function containsTable(nodes: CirNode[]): boolean {
  return nodes.some((node) => {
    switch (node.type) {
      case 'table':
        return true;
      case 'paragraph':
      case 'heading':
      case 'blockquote':
      case 'link':
      case 'panel':
      case 'expand':
      case 'excerpt':
      case 'chart':
        return containsTable(node.children);
      case 'layout':
        return node.columns.some((column) => containsTable(column));
      case 'list':
        return node.items.some((item) => containsTable(item));
      case 'taskList':
        return node.items.some((item) => containsTable(item.children));
      case 'decisionList':
        return node.items.some((item) => containsTable(item.children));
      default:
        return false;
    }
  });
}

const chartKinds = new Set(['pie', 'bar', 'line', 'area']);

const chartHandler: MacroHandler = (macro, ctx) => {
  const rawType = macro.params.type?.trim().toLowerCase();

  if (rawType && !chartKinds.has(rawType)) {
    return fidelityCard(macro, ctx, 'chart type is not supported natively');
  }

  if (containsTable(macro.richBody)) {
    const width = Number(macro.params.width);
    const height = Number(macro.params.height);

    return {
      type: 'chart',
      ...(rawType
        ? { chartType: rawType as 'pie' | 'bar' | 'line' | 'area' }
        : {}),
      ...(macro.params.title?.trim()
        ? { title: macro.params.title.trim() }
        : {}),
      ...(macro.params.subtitle?.trim()
        ? { subtitle: macro.params.subtitle.trim() }
        : {}),
      ...(macro.params.xLabel?.trim()
        ? { xLabel: macro.params.xLabel.trim() }
        : {}),
      ...(macro.params.yLabel?.trim()
        ? { yLabel: macro.params.yLabel.trim() }
        : {}),
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(Number.isFinite(height) && height > 0 ? { height } : {}),
      ...(macro.params.legend === 'true' ? { legend: true } : {}),
      ...(macro.params.legend === 'false' ? { legend: false } : {}),
      ...(macro.params.orientation === 'horizontal' ||
      macro.params.orientation === 'vertical'
        ? { orientation: macro.params.orientation }
        : {}),
      ...(macro.params.stacked === 'true' ? { stacked: true } : {}),
      ...(macro.params.stacked === 'false' ? { stacked: false } : {}),
      sourceParams: macro.params,
      children: macro.richBody,
    };
  }

  const filename = macro.params.attachment?.trim();

  if (!filename)
    return fidelityCard(
      macro,
      ctx,
      'chart has no native table data or generated attachment to resolve',
    );

  return [{ type: 'media', kind: 'file', filename }, ...macro.richBody];
};

/**
 * html → `raw`, which `cir-to-tiptap` maps to the `rawHtml` node.
 *
 * Safe because `rawHtml` is sanitized at the write gate, not trusted from here.
 * The macro is disabled by default in Confluence, so an empty body is the norm
 * and degrades to the standard fallback.
 */
const htmlHandler: MacroHandler = (macro) =>
  macro.plainBody.trim() ? { type: 'raw', html: macro.plainBody } : null;

/** excerpt → a live source wrapper; `hidden` affects only this page, never consumers. */
const excerptHandler: MacroHandler = (macro) => ({
  type: 'excerpt',
  hidden: macro.params.hidden?.toLowerCase() === 'true',
  ...(macro.params.name?.trim() ? { name: macro.params.name.trim() } : {}),
  sourceParams: macro.params,
  children: macro.richBody,
});

/** anchor → an invisible local fragment target, preserving `#anchor` links. */
const anchorHandler: MacroHandler = (macro) => {
  const name = (
    macro.params[''] ||
    macro.params.name ||
    macro.plainBody
  ).trim();

  return name ? { type: 'anchor', name } : null;
};

/** profile / user macro → mention (resolved via the user crosswalk / placeholder). */
const profileHandler: MacroHandler = (macro, ctx) => {
  const sourceId =
    macro.params.user || macro.params.userkey || macro.params.account_id;

  if (!sourceId)
    return fidelityCard(
      macro,
      ctx,
      'profile macro has no resolvable source user identifier',
    );

  return { type: 'userMention', sourceId };
};

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const gallerySorts = new Set(['none', 'name', 'date', 'size', 'comment']);

const galleryHandler: MacroHandler = (macro, ctx) => {
  if (macro.params.page?.trim() || macro.params.spaceKey?.trim()) {
    return fidelityCard(
      macro,
      ctx,
      'gallery targets a non-local attachment source page',
    );
  }

  const columns = Number(macro.params.columns);
  const limit = Number(macro.params.limit ?? macro.params.max);
  const sort = macro.params.sort?.trim().toLowerCase();

  return {
    type: 'gallery',
    ...(macro.params.title?.trim() ? { title: macro.params.title.trim() } : {}),
    ...(Number.isInteger(columns) && columns >= 1 && columns <= 8
      ? { columns }
      : {}),
    ...(csv(macro.params.include).length > 0
      ? { include: csv(macro.params.include) }
      : {}),
    ...(csv(macro.params.exclude).length > 0
      ? { exclude: csv(macro.params.exclude) }
      : {}),
    ...(csv(macro.params.includeLabel ?? macro.params.labels).length > 0
      ? { includeLabel: csv(macro.params.includeLabel ?? macro.params.labels) }
      : {}),
    ...(csv(macro.params.excludeLabel).length > 0
      ? { excludeLabel: csv(macro.params.excludeLabel) }
      : {}),
    ...(sort && gallerySorts.has(sort)
      ? { sort: sort as 'none' | 'name' | 'date' | 'size' | 'comment' }
      : {}),
    ...(macro.params.reverse === 'true' ? { reverse: true } : {}),
    ...(macro.params.reverse === 'false' ? { reverse: false } : {}),
    ...(Number.isInteger(limit) && limit >= 1 && limit <= 200 ? { limit } : {}),
    ...(macro.params.captions === 'true' ? { captions: true } : {}),
    ...(macro.params.captions === 'false' ? { captions: false } : {}),
    sourceParams: macro.params,
  };
};

/**
 * A single Jira issue is resolved later through the exact migration crosswalk. Queries stay on the
 * fidelity path until the existing JQL transpiler can prove a complete translation.
 */
const jiraHandler: MacroHandler = (macro, ctx) => {
  const key = macro.params.key?.trim();

  if (key && JIRA_KEY_RE.test(key)) {
    const base = ctx.sourceBaseUrl?.replace(/\/+$/, '');
    const sourceUrl = macro.params.url?.trim();

    ctx.markNeedsRelink?.();

    return {
      type: 'jiraIssue',
      key,
      macroName: macro.name,
      params: macro.params,
      ...(sourceUrl && /^https?:\/\//i.test(sourceUrl)
        ? { sourceUrl }
        : base && /^https?:\/\//i.test(base)
          ? { sourceUrl: `${base}/browse/${encodeURIComponent(key)}` }
          : {}),
      children:
        macro.richBody.length > 0
          ? macro.richBody
          : macro.plainBody.trim()
            ? [{ type: 'codeBlock', text: macro.plainBody }]
            : [],
    };
  }

  // Legacy `jiraissues` carries an RSS filter `url`; the modern macro carries JQL.
  // The target ticket table is not available until a later JQL mapping pass can validate every
  // clause, so preserve this source query rather than reducing it to a text label.
  return fidelityCard(
    macro,
    ctx,
    'Jira filter/query cannot be safely remapped',
  );
};

/**
 * children → Wiki 2.0's live page tree.
 *
 * `childPages === undefined` means "not resolved yet" (pass 1, before every page is in the
 * crosswalk) → placeholder + flag for the relink pass. `childPages === []` means "resolved, and this
 * page genuinely has no children" → render nothing and DON'T re-flag; conflating the two re-flagged
 * childless pages forever, so every relink pass re-fetched and re-wrote them for no change.
 */
const childrenHandler: MacroHandler = (macro, ctx) => {
  if (!ctx.currentPageId) {
    ctx.markNeedsRelink?.();

    return fidelityCard(
      macro,
      ctx,
      'child-page links await the page relink pass',
    );
  }

  return {
    type: 'liveMacro',
    kind: 'pageTree',
    params: { rootPageId: ctx.currentPageId },
  };
};

function includeTarget(macro: ParsedMacro, ctx: MacroContext) {
  const directId =
    macro.pageReference?.sourceId ||
    macro.params.pageId ||
    macro.params.contentId ||
    macro.params['content-id'] ||
    macro.params.targetPageId;
  if (directId && ctx.includePages?.[directId])
    return ctx.includePages[directId];

  const raw = (
    macro.pageReference?.title ||
    macro.params[''] ||
    macro.params.page ||
    ''
  ).trim();
  if (!raw) return undefined;

  const colon = raw.indexOf(':');
  const explicitSpace = colon > 0 ? raw.slice(0, colon) : undefined;
  const title = colon > 0 ? raw.slice(colon + 1) : raw;
  const sourceSpace =
    macro.pageReference?.sourceSpaceKey ||
    explicitSpace ||
    macro.params.spaceKey ||
    ctx.currentSourceSpaceKey;

  return sourceSpace
    ? ctx.includePages?.[pageReferenceKey(title, sourceSpace)]
    : undefined;
}

/** include → a live local page reference after the relink pass. */
const includeHandler: MacroHandler = (macro, ctx) => {
  const target = includeTarget(macro, ctx);

  if (target) {
    return {
      type: 'includePage',
      pageId: target.pageId,
      title: target.title,
      ...(target.targetSpaceId ? { targetSpaceId: target.targetSpaceId } : {}),
      ...(target.targetSpaceKey || macro.pageReference?.sourceSpaceKey
        ? {
            targetSpaceKey:
              target.targetSpaceKey ?? macro.pageReference?.sourceSpaceKey,
          }
        : {}),
      sourceParams: macro.params,
      ...(macro.pageReference ? { sourceReference: macro.pageReference } : {}),
    };
  }

  ctx.markNeedsRelink?.();

  return fidelityCard(
    macro,
    ctx,
    'included page has no migrated local target yet',
  );
};

/** excerpt-include → live local excerpt reference after the relink pass. */
const excerptIncludeHandler: MacroHandler = (macro, ctx) => {
  const target = includeTarget(macro, ctx);

  if (target) {
    const excerptName = (
      macro.params.excerptName ||
      macro.params.excerpt ||
      ''
    ).trim();

    return {
      type: 'excerptInclude',
      pageId: target.pageId,
      title: target.title,
      ...(target.targetSpaceId ? { targetSpaceId: target.targetSpaceId } : {}),
      ...(target.targetSpaceKey || macro.pageReference?.sourceSpaceKey
        ? {
            targetSpaceKey:
              target.targetSpaceKey ?? macro.pageReference?.sourceSpaceKey,
          }
        : {}),
      ...(excerptName ? { excerptName } : {}),
      nopanel: macro.params.nopanel?.toLowerCase() === 'true',
      sourceParams: macro.params,
      ...(macro.pageReference ? { sourceReference: macro.pageReference } : {}),
    };
  }

  ctx.markNeedsRelink?.();
  return fidelityCard(
    macro,
    ctx,
    'included excerpt has no unambiguous migrated local target yet',
  );
};

/**
 * `column` → a single-column layout. Nested macros resolve BEFORE their parent, so a `section`'s
 * richBody already contains these; `sectionHandler` merges them into one multi-column layout.
 * A stray `column` outside a section degrades to a plain one-column div — never lost.
 */
const columnHandler: MacroHandler = (macro) => {
  const width = parseColumnWidth(macro.params.width);

  return {
    type: 'layout',
    columns: [macro.richBody],
    ...(width !== undefined ? { widths: [width] } : {}),
  };
};

function parseColumnWidth(value: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(value?.trim() ?? '');
  const width = match ? Number(match[1]) : NaN;

  return Number.isInteger(width) && width >= 1 && width <= 100
    ? width
    : undefined;
}

/** `section` → merge its resolved `column` children into one multi-column layout (classic pre-ac:layout). */
const sectionHandler: MacroHandler = (macro) => {
  const columns: CirNode[][] = [];
  const widths: Array<number | undefined> = [];
  const loose: CirNode[] = [];

  for (const node of macro.richBody) {
    if (node.type === 'layout') {
      columns.push(...node.columns);
      widths.push(...node.columns.map((_, index) => node.widths?.[index]));
    } else loose.push(node);
  }

  // No columns → not a real multi-column section; keep the body rather than invent a layout.
  if (columns.length === 0)
    return macro.richBody.length ? macro.richBody : null;

  // Content sitting outside any column still renders (as a leading column) — never dropped.
  if (loose.length > 0) {
    columns.unshift(loose);
    widths.unshift(undefined);
  }

  return {
    type: 'layout',
    columns,
    ...(widths.length === columns.length &&
    widths.some((width) => width !== undefined)
      ? { widths }
      : {}),
  };
};

/**
 * drawio / gliffy → a real `diagram` node. The macro carries only the diagram's NAME; the drawing
 * itself is a sibling page attachment of that exact title, so the XML is fetched by an async
 * post-pass (`resolveDiagrams`) and Wiki 2.0's native `drawioDiagram` node receives it. Without a
 * name there is nothing to look up, so that case still degrades to a visible placeholder.
 */
const diagramHandler: MacroHandler = (macro, ctx) => {
  const name =
    macro.params.diagramName ||
    macro.params.name ||
    macro.params.diagramDisplayName ||
    '';

  if (!name) {
    return fidelityCard(
      macro,
      ctx,
      'diagram name is missing; attachment cannot be resolved',
    );
  }

  return { type: 'diagram', name, macroName: macro.name };
};

/**
 * Live macros that Wiki 2.0 CAN reproduce: `pagetree`, `recently-updated`, `contributors` and
 * `contentbylabel` all have
 * a native node that re-queries on render, which is what Confluence does. A static snapshot would be
 * wrong as soon as the space changed, and a placeholder threw the macro away entirely.
 */
const liveHandler =
  (kind: LiveMacroKind): MacroHandler =>
  (macro) => ({ type: 'liveMacro', kind, params: macro.params });

const sourcedLiveHandler =
  (kind: LiveMacroKind): MacroHandler =>
  (macro, ctx) =>
    macro.richBody.length
      ? fidelityCard(
          macro,
          ctx,
          `native ${kind} mapping cannot preserve a rich macro body`,
        )
      : {
          type: 'liveMacro',
          kind,
          params: macro.params,
          sourceName: macro.name,
          sourceParams: macro.params,
          sourceBody: macro.plainBody,
        };

/**
 * Native mappings are lossless only when every source field has an equivalent target attr. If a
 * macro carries a body or an unsupported parameter, keep the complete source on a fidelity card
 * rather than silently narrowing or broadening its meaning.
 */
const nativeLiveHandler =
  (
    kind: LiveMacroKind,
    allowedParams: readonly string[],
    normalize: (
      params: Record<string, string>,
    ) => Record<string, string> | null,
  ): MacroHandler =>
  (macro, ctx) => {
    const unknown = Object.keys(macro.params).filter(
      (name) => !allowedParams.includes(name),
    );

    if (
      unknown.length > 0 ||
      macro.richBody.length > 0 ||
      macro.plainBody.trim()
    ) {
      return fidelityCard(
        macro,
        ctx,
        `native ${kind} mapping cannot preserve the complete source payload`,
      );
    }

    const params = normalize(macro.params);

    return params
      ? {
          type: 'liveMacro',
          kind,
          params,
          sourceName: macro.name,
          sourceParams: { ...macro.params },
          sourceBody: macro.plainBody,
        }
      : fidelityCard(
          macro,
          ctx,
          `native ${kind} mapping rejected unsafe parameters`,
        );
  };

const boundedInt = (value: string | undefined, max: number): string | null => {
  if (value === undefined || value.trim() === '') return '';

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max
    ? String(parsed)
    : null;
};

const changeHistoryHandler = nativeLiveHandler(
  'changeHistory',
  ['limit', 'max'],
  (params) => {
    if (
      params.limit !== undefined &&
      params.max !== undefined &&
      params.limit.trim() !== params.max.trim()
    ) {
      return null;
    }

    const limit = boundedInt(params.limit ?? params.max, 100);

    if (limit === null) return null;

    const normalized: Record<string, string> = {};

    if (limit) normalized.limit = limit;

    return normalized;
  },
);

const pageTreeSearchHandler = nativeLiveHandler(
  'pageTreeSearch',
  ['root', 'rootPageId'],
  (params) => {
    const root = params.root?.trim();
    const rootPageId = params.rootPageId?.trim();

    if (root && root !== '@self') return null;
    if (rootPageId && !UUID_RE.test(rootPageId)) return null;

    return {
      mode: 'search',
      ...(rootPageId ? { rootPageId } : {}),
    };
  },
);

const pageIndexHandler = nativeLiveHandler('pageTreeSearch', [], () => ({
  mode: 'pageIndex',
}));

const searchResultsHandler = nativeLiveHandler(
  'pageTreeSearch',
  ['query', 'queryString'],
  (params) => ({
    mode: 'searchResults',
    query: (params.query ?? params.queryString ?? '').trim(),
  }),
);

const spaceDetailsHandler = nativeLiveHandler(
  'spaceDetails',
  ['width', 'id'],
  (params) => {
    const width = params.width?.trim();
    const id = params.id?.trim();

    if (width && !/^\d+(?:px|%|em|rem)?$/.test(width)) return null;
    if (
      id &&
      (id.length > 200 || [...id].some((char) => char.charCodeAt(0) < 32))
    )
      return null;

    const normalized: Record<string, string> = {};

    if (width) normalized.width = width;

    return normalized;
  },
);

const userListHandler = nativeLiveHandler('userList', ['groups'], (params) => {
  const groups = params.groups?.trim();

  const normalized: Record<string, string> = {};

  if (groups && groups !== '*') normalized.groups = groups;

  return normalized;
});

const userProfileHandler = nativeLiveHandler(
  'userProfile',
  ['user', 'username', 'userkey', 'userKey', 'account_id', 'accountId'],
  (params) => {
    const userName = (params.user ?? params.username)?.trim();
    const userKey = (
      params.userkey ??
      params.userKey ??
      params.account_id ??
      params.accountId
    )?.trim();

    return userName || userKey
      ? {
          ...(userName ? { userName } : {}),
          ...(userKey ? { userKey } : {}),
        }
      : {};
  },
);

const profilePictureHandler = nativeLiveHandler(
  'profilePicture',
  ['user', 'username', 'userkey', 'userKey', 'account_id', 'accountId'],
  (params) => {
    const userName = (params.user ?? params.username)?.trim();
    const userKey = (
      params.userkey ??
      params.userKey ??
      params.account_id ??
      params.accountId
    )?.trim();

    return userName || userKey
      ? {
          ...(userName ? { userName } : {}),
          ...(userKey ? { userKey } : {}),
        }
      : null;
  },
);

const popularLabelsHandler = nativeLiveHandler(
  'popularLabels',
  ['count', 'spaceKey', 'spacekey', 'style'],
  (params) => {
    const count = boundedInt(params.count, 100);
    const style = params.style?.trim().toLowerCase();
    const spaceKey = (params.spaceKey ?? params.spacekey)?.trim();

    if (
      count === null ||
      (style && style !== 'list' && style !== 'heatmap' && style !== 'table')
    ) {
      return null;
    }

    return {
      ...(count ? { count } : {}),
      ...(spaceKey ? { spaceKey } : {}),
      ...(style ? { style: style === 'table' ? 'list' : style } : {}),
    };
  },
);

const createSpaceButtonHandler: MacroHandler = (macro, ctx) => {
  const size = (macro.params.size || 'large').trim().toLowerCase();

  if (
    Object.keys(macro.params).some((name) => name !== 'size') ||
    macro.richBody.length > 0 ||
    macro.plainBody.trim() ||
    (size !== 'small' && size !== 'large')
  ) {
    return fidelityCard(
      macro,
      ctx,
      'native create-space action only supports a bodyless small/large size',
    );
  }

  return {
    type: 'createSpaceButton',
    size,
    sourceName: macro.name,
    sourceParams: { ...macro.params },
  };
};

type CirTable = Extract<CirNode, { type: 'table' }>;
type CirTableCell = CirTable['rows'][number]['cells'][number];

function plainPropertyNode(node: CirNode): string | null {
  if (node.type === 'text') return node.text;
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'status') return node.text;
  if (node.type === 'userMention') return node.displayName?.trim() || 'User';
  if (node.type === 'pageLink') return node.text || node.pageSourceId;
  if (node.type === 'inlineCard') return node.title || node.url;
  if (node.type === 'date') {
    const value = Number(node.timestamp);

    return Number.isFinite(value)
      ? new Date(value).toISOString().slice(0, 10)
      : null;
  }
  if (
    (node.type !== 'paragraph' && node.type !== 'link') ||
    ('indent' in node && (node.indent || node.align))
  )
    return null;

  let value = '';

  for (const child of node.children) {
    const text = plainPropertyNode(child);

    if (text === null) return null;
    value += text;
  }

  return value;
}

function plainPropertyCell(cell: CirTableCell): string | null {
  if ((cell.colspan ?? 1) !== 1 || (cell.rowspan ?? 1) !== 1) return null;

  const parts: string[] = [];

  for (const child of cell.children) {
    const text = plainPropertyNode(child);

    if (text === null) return null;
    parts.push(text);
  }

  return parts.join('\n');
}

function contentPropertyRows(
  body: CirNode[],
): { key: string; value: string }[] | null {
  if (body.length !== 1 || body[0].type !== 'table') return null;

  const table = body[0];

  if (table.rows.length === 0 || table.rows.length > 100) return null;

  const vertical = table.rows.every(
    (row) =>
      row.cells.length === 2 && row.cells[0].header && !row.cells[1].header,
  );
  const width = table.rows[0]?.cells.length ?? 0;
  const horizontal =
    table.rows.length === 2 &&
    width > 0 &&
    width <= 100 &&
    table.rows[1].cells.length === width &&
    table.rows[0].cells.every((cell) => cell.header) &&
    table.rows[1].cells.every((cell) => !cell.header);

  if (!vertical && !horizontal) return null;

  const pairs = vertical
    ? table.rows.map((row) => [row.cells[0], row.cells[1]] as const)
    : table.rows[0].cells.map(
        (keyCell, index) => [keyCell, table.rows[1].cells[index]] as const,
      );
  const rows: { key: string; value: string }[] = [];

  for (const [keyCell, valueCell] of pairs) {
    const key = plainPropertyCell(keyCell);
    const value = plainPropertyCell(valueCell);

    if (
      key === null ||
      value === null ||
      !key.trim() ||
      key.length > 500 ||
      value.length > 5000
    ) {
      return null;
    }

    rows.push({ key, value });
  }

  return rows;
}

const CONTENT_PROPERTIES_PARAMS = ['id', 'hidden', 'layout'] as const;

const contentPropertiesHandler: MacroHandler = (macro, ctx) => {
  if (
    macro.plainBody.trim() ||
    Object.keys(macro.params).some(
      (name) =>
        !CONTENT_PROPERTIES_PARAMS.includes(
          name as (typeof CONTENT_PROPERTIES_PARAMS)[number],
        ),
    )
  ) {
    return fidelityCard(
      macro,
      ctx,
      'content properties macro has unsupported source payload',
    );
  }

  const propertyId = macro.params.id?.trim();
  const hiddenValue = macro.params.hidden?.trim().toLowerCase();
  const layout = macro.params.layout?.trim().toLowerCase();

  if (
    (propertyId && propertyId.length > 255) ||
    (hiddenValue && hiddenValue !== 'true' && hiddenValue !== 'false') ||
    (layout && layout !== 'table')
  ) {
    return fidelityCard(
      macro,
      ctx,
      'content properties parameters are invalid',
    );
  }

  const rows = contentPropertyRows(macro.richBody);

  if (!rows) {
    return fidelityCard(
      macro,
      ctx,
      'content properties table cannot be translated without loss',
    );
  }

  return {
    type: 'contentProperties',
    ...(propertyId ? { propertyId } : {}),
    hidden: hiddenValue === 'true',
    rows,
    sourceParams: { ...macro.params },
    sourceBody: JSON.stringify(macro.richBody),
  };
};

function parseColumns(value: string | undefined): string[] | null {
  if (value === undefined || !value.trim()) return [];

  const columns: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (char === '"') {
      if (quoted && value[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      columns.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (quoted) return null;

  columns.push(current.trim());

  return columns.length <= 100 &&
    columns.every((column) => column && column.length <= 100)
    ? columns
    : null;
}

const REPORT_PARAMS = [
  'label',
  'labels',
  'cql',
  'id',
  'propertyId',
  'headings',
  'columns',
  'firstcolumn',
  'titleColumn',
  'pageSize',
  'limit',
  'sortBy',
] as const;

function cqlLabel(value: string | undefined): string | null {
  if (!value) return null;

  const match = /^\s*label\s*=\s*(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*$/i.exec(
    value,
  );

  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim() || null;
}

function validReportLabel(value: string | null | undefined): value is string {
  return (
    !!value &&
    value.length <= 50 &&
    !Array.from(value).some(
      (character) => character === ',' || character.charCodeAt(0) < 32,
    )
  );
}

const contentPropertiesReportHandler: MacroHandler = (macro, ctx) => {
  if (
    macro.richBody.length > 0 ||
    macro.plainBody.trim() ||
    Object.keys(macro.params).some(
      (name) => !REPORT_PARAMS.includes(name as (typeof REPORT_PARAMS)[number]),
    )
  ) {
    return fidelityCard(
      macro,
      ctx,
      'content properties report has unsupported parameters',
    );
  }

  const explicitLabel = (macro.params.label ?? macro.params.labels)?.trim();
  const parsedCqlLabel = cqlLabel(macro.params.cql);
  const label = explicitLabel || parsedCqlLabel;

  if (
    !validReportLabel(label) ||
    (macro.params.cql !== undefined && !parsedCqlLabel) ||
    (macro.params.label !== undefined &&
      macro.params.labels !== undefined &&
      macro.params.label.trim() !== macro.params.labels.trim()) ||
    (explicitLabel && parsedCqlLabel && explicitLabel !== parsedCqlLabel)
  ) {
    return fidelityCard(
      macro,
      ctx,
      'content properties report has no single valid label',
    );
  }

  const propertyId = (macro.params.id ?? macro.params.propertyId)?.trim();
  const columns = parseColumns(macro.params.headings ?? macro.params.columns);
  const titleColumn = (
    macro.params.firstcolumn ??
    macro.params.titleColumn ??
    'Title'
  ).trim();
  const limitValue = macro.params.pageSize ?? macro.params.limit;
  const limit =
    limitValue === undefined || !limitValue.trim() ? 30 : Number(limitValue);
  const sortBy = macro.params.sortBy?.trim().toLowerCase();
  const conflictingAliases =
    (macro.params.id !== undefined &&
      macro.params.propertyId !== undefined &&
      macro.params.id.trim() !== macro.params.propertyId.trim()) ||
    (macro.params.headings !== undefined &&
      macro.params.columns !== undefined &&
      macro.params.headings !== macro.params.columns) ||
    (macro.params.firstcolumn !== undefined &&
      macro.params.titleColumn !== undefined &&
      macro.params.firstcolumn.trim() !== macro.params.titleColumn.trim()) ||
    (macro.params.pageSize !== undefined &&
      macro.params.limit !== undefined &&
      macro.params.pageSize.trim() !== macro.params.limit.trim());

  if (
    conflictingAliases ||
    (propertyId && propertyId.length > 255) ||
    columns === null ||
    !titleColumn ||
    titleColumn.length > 100 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 30 ||
    (sortBy && sortBy !== 'modified')
  ) {
    return fidelityCard(
      macro,
      ctx,
      'content properties report parameters are invalid',
    );
  }

  return {
    type: 'contentPropertiesReport',
    label,
    ...(propertyId ? { propertyId } : {}),
    titleColumn,
    columns,
    limit,
    ...(sortBy === 'modified' ? { sortBy: 'modified' as const } : {}),
    sourceParams: { ...macro.params },
  };
};

/**
 * Confluence 8+ writes `contentbylabel` with the query in a `cql` parameter
 * (`label = "macro-test"`, `label in ("a","b")`, compound with and/or) instead of the classic
 * `labels`/`label` parameters. Extract the label tokens so the native live node still applies;
 * the raw CQL stays on the macro's params for provenance either way.
 */
export function labelsFromCql(cql: string | undefined): string[] {
  if (!cql) return [];

  const out = new Set<string>();
  const clause = /label\s*=\s*"([^"]+)"|label\s*in\s*\(([^)]*)\)/gi;

  for (const match of cql.matchAll(clause)) {
    if (match[1]) {
      out.add(match[1].trim());
    } else if (match[2]) {
      for (const part of match[2].split(',')) {
        const token = part.trim().replace(/^"|"$/g, '');

        if (token) out.add(token);
      }
    }
  }

  return [...out];
}

/**
 * Content by Label has no useful output without at least one label. Do not run a broad query as a
 * guess: retain the malformed source macro visibly instead, including the original parameters.
 */
const contentByLabelHandler: MacroHandler = (macro, ctx) => {
  const cqlLabels = labelsFromCql(macro.params.cql);
  const labels =
    macro.params.labels ?? macro.params.label ?? cqlLabels.join(',');

  if (labels.split(',').some((label) => label.trim())) {
    return {
      type: 'liveMacro',
      kind: 'contentByLabel',
      params: {
        ...macro.params,
        ...(cqlLabels.length > 0 && !macro.params.labels && !macro.params.label
          ? { labels: cqlLabels.join(',') }
          : {}),
      },
    };
  }

  return fidelityCard(
    macro,
    ctx,
    'content-by-label has no labels and would broaden the query',
  );
};

/**
 * Third-party vendor app macros. Their rendering lives inside the vendor's app, so it cannot be
 * reimplemented — but the parameters ARE the content, so they are preserved verbatim on a card that
 * names the macro. Lossless as data, and visibly not a silent drop.
 */
const externalHandler: MacroHandler = (macro, ctx) => {
  return fidelityCard(macro, ctx, 'vendor app macro has no local renderer');
};

/** Dynamic/live macros that can't be migrated as static content. */
const dynamicHandler: MacroHandler = (macro, ctx) => {
  return fidelityCard(macro, ctx, 'dynamic output has no native XI node');
};

const placeholderTextHandler: MacroHandler = (macro, ctx) => {
  if (
    macro.richBody.length ||
    macro.plainBody ||
    Object.keys(macro.params).some(
      (key) => macro.name !== 'loremipsum' || key !== '',
    )
  )
    return fidelityCard(
      macro,
      ctx,
      'unrecognized static macro parameters or body preserved',
    );
  const paragraph = (text: string): CirNode => ({
    type: 'paragraph',
    children: [{ type: 'text', text }],
  });
  if (macro.name === 'cheese') return paragraph('I like cheese!');
  const raw = macro.params[''] ?? '';
  const requested = /^\d+$/.test(raw) ? Number(raw) : 3;
  const count =
    requested > 0 ? Math.min(requested, CONFLUENCE_LOREM_PARAGRAPHS.length) : 3;
  return CONFLUENCE_LOREM_PARAGRAPHS.slice(0, count).map(paragraph);
};

const HANDLERS: Record<string, MacroHandler> = {
  cheese: placeholderTextHandler,
  loremipsum: placeholderTextHandler,
  info: panelHandler,
  note: panelHandler,
  warning: panelHandler,
  tip: panelHandler,
  success: panelHandler,
  panel: panelHandler,
  code: codeHandler,
  noformat: codeHandler,
  status: statusHandler,
  expand: expandHandler,
  'expand-macro': expandHandler,
  toc: tocHandler,
  'table-of-contents': tocHandler,
  'blog-posts': feedReferenceHandler,
  rss: feedReferenceHandler,
  'toc-zone': tocHandler,
  attachments: attachmentsHandler,
  'view-file': viewFileHandler,
  viewfile: viewFileHandler,
  // Confluence Server's legacy Office/PDF viewer macros carry the same `name`
  // attachment parameter as view-file. Preserve a working local download rather
  // than a vendor-style fallback card.
  viewdoc: viewFileHandler,
  viewpdf: viewFileHandler,
  viewppt: viewFileHandler,
  viewxls: viewFileHandler,
  // Same `name` param, same job: an embedded attachment. Video/audio renders as
  // a download card rather than an inline player, which keeps the file reachable
  // instead of losing the reference entirely.
  multimedia: viewFileHandler,
  chart: chartHandler,
  html: htmlHandler,
  excerpt: excerptHandler,
  anchor: anchorHandler,
  profile: userProfileHandler,
  jira: jiraHandler,
  jiraissues: jiraHandler,
  'jira-issues': jiraHandler,
  'jira-work-items': jiraHandler,
  'jira-chart': dynamicHandler,
  jirachart: dynamicHandler,
  'jira-timeline': dynamicHandler,
  'advanced-roadmaps': dynamicHandler,
  'portfolio-for-jira-plan': dynamicHandler,
  'roadmap-planner': dynamicHandler,
  assets: dynamicHandler,
  'assets-data': dynamicHandler,
  children: childrenHandler,
  include: includeHandler,
  'excerpt-include': excerptIncludeHandler,
  // Classic pre-`ac:layout` multi-column construct (still pervasive in Server exports).
  section: sectionHandler,
  column: columnHandler,
  // Diagrams — the rendered image is a separate attachment; name it rather than drop it.
  drawio: diagramHandler,
  // Same app, sketch mode — it carries the identical `diagramName`/`diagramDisplayName` params and a
  // sibling mxfile attachment. Unregistered, its diagram rendered as "[Unsupported macro]".
  'drawio-sketch': diagramHandler,
  gliffy: diagramHandler,
  // Confluence's `details` name means Page/Content Properties, not an HTML disclosure.
  details: contentPropertiesHandler,
  'page-properties': contentPropertiesHandler,
  detailssummary: contentPropertiesReportHandler,
  'page-properties-report': contentPropertiesReportHandler,
  // Live macros with a native Wiki 2.0 equivalent — reproduced, not placeholdered.
  // `children` is deliberately NOT here: `childrenHandler` resolves real migrated page links via the
  // relink pass, which is strictly better than a live tree and already proven.
  'recently-updated': liveHandler('recentlyUpdated'),
  'change-history': changeHistoryHandler,
  changehistory: changeHistoryHandler,
  pagetreesearch: pageTreeSearchHandler,
  'page-tree-search': pageTreeSearchHandler,
  index: pageIndexHandler,
  pageindex: pageIndexHandler,
  'page-index': pageIndexHandler,
  search: searchResultsHandler,
  searchresults: searchResultsHandler,
  'search-results': searchResultsHandler,
  'space-details': spaceDetailsHandler,
  spacedetails: spaceDetailsHandler,
  'user-list': userListHandler,
  userlist: userListHandler,
  userlister: userListHandler,
  'user-profile': userProfileHandler,
  userprofile: userProfileHandler,
  'profile-picture': profilePictureHandler,
  profilepicture: profilePictureHandler,
  'popular-labels': popularLabelsHandler,
  popularlabels: popularLabelsHandler,
  'create-space-button': createSpaceButtonHandler,
  createspacebutton: createSpaceButtonHandler,
  listlabels: sourcedLiveHandler('labelsList'),
  'labels-list': sourcedLiveHandler('labelsList'),
  pagetree: liveHandler('pageTree'),
  // Confluence Server storage calls this `contentbylabel`. It is a native, live query over the
  // target space's own wiki labels; unsupported source-space scopes are displayed honestly by the
  // node instead of risking data from a different tenant/space.
  contentbylabel: contentByLabelHandler,
  'space-attachments': liveHandler('spaceAttachments'),
  spaces: liveHandler('spacesList'),
  // Live/dynamic macros that have no static equivalent.
  livesearch: liveHandler('liveSearch'),
  'tasks-report-macro': sourcedLiveHandler('taskReport'),
  taskreport: sourcedLiveHandler('taskReport'),
  'recently-used-labels': sourcedLiveHandler('recentlyUsedLabels'),
  recentlyusedlabels: sourcedLiveHandler('recentlyUsedLabels'),
  'related-labels': sourcedLiveHandler('relatedLabels'),
  relatedlabels: sourcedLiveHandler('relatedLabels'),
  'content-by-user': sourcedLiveHandler('contentByUser'),
  contentbyuser: sourcedLiveHandler('contentByUser'),
  'recently-updated-dashboard': sourcedLiveHandler('recentlyUpdatedDashboard'),
  recentlyupdateddashboard: sourcedLiveHandler('recentlyUpdatedDashboard'),
  'content-report-table': sourcedLiveHandler('contentReportTable'),
  contentreporttable: sourcedLiveHandler('contentReportTable'),
  'decision-report': sourcedLiveHandler('decisionReport'),
  decisionreport: sourcedLiveHandler('decisionReport'),
  roadmap: dynamicHandler,
  iframe: safeEmbedHandler,
  widget: safeEmbedHandler,
  'widget-connector': safeEmbedHandler,
  widgetconnector: safeEmbedHandler,
  cards: cardHandler,
  card: cardHandler,
  carousel: carouselHandler,
  gallery: galleryHandler,
  // Navigation Map is label-driven; Page Index/Search Results modes are not equivalent.
  navmap: sourcedLiveHandler('navigationMap'),
  'navigation-map': sourcedLiveHandler('navigationMap'),
  // `contributors` re-queries page history on every view, so it is dynamic, not merely unknown.
  // Verified on M0's "All possible Macros" page: unregistered, it rendered
  // "[Unsupported macro: contributors]", which reads like a gap in the tool rather than what it is —
  // a live query with no static form. Same placeholder either way; only the label was wrong.
  contributors: liveHandler('contributors'),
  'contributors-summary': liveHandler('contributorsSummary'),
  user: profileHandler,
  // Vendor apps present in the customer's space — parameters preserved on a named card.
  'project-linker': externalHandler,
  'azure-devops-macro-wiki': externalHandler,
  'appsplus-microsoft-onedrive-macro': externalHandler,
};

/**
 * Resolve a macro to CIR. Registered handlers translate semantically; everything else renders a
 * visible `[Unsupported macro: name]` note (preserving any body) and logs a lossy report — content
 * is never silently dropped. Returns null only when a handler deliberately omits the macro (anchor).
 */
export function renderMacro(
  macro: ParsedMacro,
  ctx: MacroContext,
): CirNode | CirNode[] | null {
  const handler = HANDLERS[macro.name];

  // Last-resort net: one malformed macro must never kill a whole page's migration.
  if (handler) {
    try {
      const out = handler(macro, ctx);

      // A handler returns null when it cannot build its node (no filename, no
      // resolvable id, nothing to point at). That must not throw the macro's
      // BODY away with it: a chart whose image was never saved as an attachment
      // still has its data table, and dropping it silently is the exact failure
      // `unsupported` was written to prevent. Bodyless opt-outs (anchor,
      // unresolved profile) still return null and vanish, which is intended.
      if (
        out === null &&
        (macro.richBody.length > 0 || macro.plainBody.trim())
      ) {
        return fidelityCard(
          macro,
          ctx,
          `handler has no renderable source content for ${macro.name}`,
        );
      }

      return out;
    } catch (err) {
      ctx.log?.('macro handler threw — degraded to placeholder', {
        macroName: macro.name,
        error: (err as Error).message,
      });

      return fidelityCard(macro, ctx, `macro handler failed: ${macro.name}`);
    }
  }

  return fidelityCard(macro, ctx, 'no compatible XI macro mapping');
}

/**
 * Visible, logged fallback that PRESERVES everything the macro carried. Both bodies matter:
 * `richBody` for bodied macros, and `plainBody` for text-bodied ones (`sql`, `chart`, `html`,
 * `groovy`) — dropping the latter silently destroyed the entire body of any unregistered
 * text-bodied macro.
 *
 * The header is an `externalMacro` node rather than an italic text note, because the note threw the
 * PARAMETERS away. For a bodyless macro the parameters ARE the content (which space, which labels,
 * which attachment), so the note reduced the whole macro to its own name. `externalMacro` already
 * carries `{ name, params }` end to end — write gate, editor, published-page renderer and the
 * `content_text` search extraction all understand it — so this upgrades EVERY unregistered macro at
 * once, with no new node type and no frontend change. Exactly what `externalHandler` above already
 * does for known vendor macros; unknown ones deserve the same honesty.
 *
 * `reason` is telemetry only: the visible card names the source macro itself.
 */
function fidelityCard(
  macro: ParsedMacro,
  ctx: MacroContext | undefined,
  reason: string,
): CirNode | CirNode[] {
  ctx?.log?.('macro rendered as unsupported placeholder', {
    macroName: macro.name,
    reason,
  });

  const card: CirNode = {
    type: 'externalMacro',
    name: macro.name,
    params: macro.params,
  };

  if (macro.richBody.length > 0) return [card, ...macro.richBody];

  if (macro.plainBody.trim())
    return [card, { type: 'codeBlock', text: macro.plainBody }];

  return card;
}
