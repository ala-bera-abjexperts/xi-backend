/**
 * @fileoverview XI-CIR — the Canonical Intermediate Representation.
 *
 * One internal AST produced by the inbound parsers (storage-XHTML, ADF) and consumed by the
 * outbound serializer (`cirToHtml`) which emits ONLY sanitizer-allow-listed HTML. Keeping a
 * single IR means every source format renders identically and every allow-list rule is enforced
 * in exactly one place.
 */

export type CirMark =
  | 'strong'
  | 'em'
  | 'underline'
  | 'strike'
  | 'code'
  | 'subscript'
  | 'superscript';

export interface CirText {
  type: 'text';
  text: string;
  marks?: CirMark[];
  /** Inline link href carried on the text run (ADF marks style). */
  link?: string;
  /** ADF `textColor` mark — a hex colour, so it cannot be one of the valueless `CirMark`s. */
  color?: string;
}

export interface CirHardBreak {
  type: 'hardBreak';
}

/** Indent depth + text alignment, which ADF carries as block marks (`indentation`, `alignment`). */
export interface CirBlockFormat {
  indent?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
}

export interface CirParagraph extends CirBlockFormat {
  type: 'paragraph';
  children: CirNode[];
}

export interface CirHeading extends CirBlockFormat {
  type: 'heading';
  level: number; // 1..6
  /** Deterministic fragment id assigned by the TOC post-pass. */
  anchorId?: string;
  children: CirNode[];
}

export interface CirList {
  type: 'list';
  ordered: boolean;
  /** HTML/Confluence `<ol start>` value; omitted for the normal first item. */
  start?: number;
  /** Each item is a list of block/inline children (may include a nested list). */
  items: CirNode[][];
}

export interface CirTaskList {
  type: 'taskList';
  items: { checked: boolean; children: CirNode[] }[];
}

export interface CirBlockquote {
  type: 'blockquote';
  children: CirNode[];
}

export interface CirCodeBlock {
  type: 'codeBlock';
  language?: string;
  text: string;
}

export interface CirRule {
  type: 'rule';
}

export interface CirLink {
  type: 'link';
  /** Dynamic macro output remains on the source; do not replace with a local self-link. */
  preserveSource?: boolean;
  href: string;
  children: CirNode[];
}

export interface CirMedia {
  type: 'media';
  /**
   * `file` is a non-previewable attachment (PDF, Office doc, zip) that renders as a
   * download card rather than an inline image — produced by the Confluence `view-file`
   * macro. It reuses this node type deliberately: `collectRefs` registers
   * `attachmentFilenames` from `media` only, and `resolveRefs` is skipped entirely when
   * that set is empty, so a bespoke node type would never get its filename resolved.
   */
  kind: 'image' | 'video' | 'file';
  /**
   * True for ADF `mediaInline` — media sitting inside a run of text rather than in its own block.
   * Without this the node serializes as a BLOCK image, which the inline-content guard then drops:
   * measured, that silently lost every one of the 17 inline images in the customer's space.
   */
  inline?: boolean;
  /** Direct external URL (ri:url / ADF external media). */
  src?: string;
  /** Confluence attachment filename — resolved to a migrated URL via the crosswalk. */
  filename?: string;
  alt?: string;
  width?: string;
  height?: string;
  /** Source image alignment; omitted means the editor's normal left alignment. */
  align?: 'left' | 'center' | 'right';
  /** Original Confluence viewer macro, retained so the target can render its intent. */
  sourceMacro?: string;
  sourceParams?: Record<string, string>;
  sourceBody?: string;
}

export interface CirUserMention {
  type: 'userMention';
  /** Source stable id (userkey / accountId). */
  sourceId: string;
  displayName?: string;
}

export interface CirPageLink {
  type: 'pageLink';
  /** Source page id where available, otherwise Confluence storage's page title. */
  pageSourceId: string;
  /** Confluence Server's `ri:space-key`, needed because titles are only space-unique. */
  sourceSpaceKey?: string;
  /** Optional Confluence in-page anchor on the resolved target page. */
  fragment?: string;
  text?: string;
}

/** Stable key for a source page ref. Preserve legacy id-only keys for ADF callers. */
export function pageReferenceKey(
  pageSourceId: string,
  sourceSpaceKey?: string,
): string {
  return sourceSpaceKey
    ? `${sourceSpaceKey}\u0000${pageSourceId}`
    : pageSourceId;
}

export interface CirPanel {
  type: 'panel';
  /** info | note | warning | tip | success | (generic). */
  variant?: string;
  title?: string;
  backgroundColor?: string;
  borderColor?: string;
  borderStyle?: 'solid' | 'dashed' | 'dotted' | 'double' | 'none';
  borderWidth?: number;
  titleBackgroundColor?: string;
  titleColor?: string;
  children: CirNode[];
}

export interface CirTableCell {
  header: boolean;
  children: CirNode[];
  colspan?: number;
  rowspan?: number;
}

export interface CirTable {
  type: 'table';
  rows: { cells: CirTableCell[] }[];
}

export interface CirMacroDeferred {
  type: 'macroDeferred';
  name: string;
}

// ── Milestone B (CF-B) macro-registry node types ──

/** Status/label chip (Confluence `status` macro). */
export interface CirStatus {
  type: 'status';
  text: string;
  /** grey | green | red | yellow | blue | purple (Confluence colours). */
  color?: string;
}

/** Collapsible section (Confluence `expand` macro) — rendered as `div.xi-expand` (no `<details>`). */
export interface CirExpand {
  type: 'expand';
  title?: string;
  children: CirNode[];
}

/** Multi-column layout (`ac:layout` / `-section` / `-cell`) — rendered as `div.xi-layout` columns. */
export interface CirLayout {
  type: 'layout';
  columns: CirNode[][];
  /** Optional percentage weights, positionally matched to `columns`. */
  widths?: Array<number | undefined>;
}

/** `toc` macro placeholder — replaced in a post-parse pass with a list of the doc's headings. */
export interface CirTocMarker {
  type: 'tocMarker';
}

/** `attachments` macro placeholder — replaced (post-resolve) with a list of the page's attachments. */
export interface CirAttachmentsMacro {
  type: 'attachmentsMacro';
}

/**
 * A draw.io / gliffy diagram. The macro itself carries only a diagram NAME; the drawing lives in a
 * sibling page attachment of that exact title with mime `application/vnd.jgraph.mxfile` (verified on
 * the customer's space: `diagramName: "Architecture.drawio"` → attachment `"Architecture.drawio"`).
 * `xml` is therefore filled in by an async post-pass, not by the parser, and stays absent when the
 * attachment cannot be read — the serializers degrade to a named placeholder rather than lie.
 */
export interface CirDiagram {
  type: 'diagram';
  name: string;
  xml?: string;
  /** Source macro (`drawio`, `drawio-sketch`, `gliffy`) — kept for the degraded label. */
  macroName?: string;
}

/** Date lozenge (ADF `date`, 200 in the live space). `timestamp` is epoch ms as a string, as ADF emits. */
export interface CirDate {
  type: 'date';
  timestamp: string;
}

/** Smart link (ADF `inlineCard`, 33 in the live space) — a URL that resolves to a titled chip. */
export interface CirInlineCard {
  type: 'inlineCard';
  url: string;
  title?: string;
  sourceMacro?: string;
  sourceParams?: Record<string, string>;
  sourceBody?: string;
}

/** Sandboxed client-side embed for the deliberately tiny YouTube/Vimeo allowlist. */
export interface CirSafeEmbed {
  type: 'safeEmbed';
  sourceMacro: string;
  url: string;
  embedUrl: string;
  title?: string;
  width?: number;
  height?: number;
  align?: 'left' | 'right';
  frameBorder?: boolean;
  scrolling?: 'yes' | 'no' | 'auto';
  sourceParams: Record<string, string>;
  sourceBody: string;
}

export interface CirCarousel {
  type: 'carousel';
  sourceMacro: string;
  frames: Array<{
    url?: string;
    title: string;
    description: string;
    image?: string;
  }>;
  sourceParams: Record<string, string>;
  sourceBody: string;
}

/**
 * A macro whose output is computed at VIEW time (page tree, recently-updated, contributors). A static
 * snapshot would be wrong the moment the space changes, so these carry their parameters through to
 * the equivalent live Wiki 2.0 node instead of being flattened to text.
 */
export interface CirLiveMacro {
  /**
   * `contentByLabel` remains space-scoped: source spaces are preserved as parameters, but no
   * cross-space query is ever inferred from a Confluence key that cannot be mapped safely.
   */
  type: 'liveMacro';
  kind:
    | 'pageTree'
    | 'recentlyUpdated'
    | 'contributors'
    | 'contributorsSummary'
    | 'contentByLabel'
    | 'labelsList'
    | 'spaceAttachments'
    | 'spacesList'
    | 'liveSearch'
    | 'taskReport'
    | 'changeHistory'
    | 'pageTreeSearch'
    | 'spaceDetails'
    | 'userList'
    | 'userProfile'
    | 'profilePicture'
    | 'popularLabels'
    | 'recentlyUsedLabels'
    | 'relatedLabels'
    | 'contentByUser'
    | 'recentlyUpdatedDashboard'
    | 'contentReportTable'
    | 'decisionReport'
    | 'navigationMap'
    | 'blogPosts'
    | 'rssFeed'
    | 'confluenceToc';
  params: Record<string, string>;
  sourceName?: string;
  sourceParams?: Record<string, string>;
  sourceBody?: string;
}

/** Legacy Confluence action, shown only to authenticated users allowed to create spaces. */
export interface CirCreateSpaceButton {
  type: 'createSpaceButton';
  size: 'small' | 'large';
  sourceName: string;
  sourceParams: Record<string, string>;
}

/** Table-backed Confluence chart macro rendered natively in Wiki 2.0. */
export interface CirChart {
  type: 'chart';
  chartType?: 'pie' | 'bar' | 'line' | 'area';
  title?: string;
  subtitle?: string;
  xLabel?: string;
  yLabel?: string;
  width?: number;
  height?: number;
  legend?: boolean;
  orientation?: 'vertical' | 'horizontal';
  stacked?: boolean;
  sourceParams?: Record<string, string>;
  children: CirNode[];
}

/** Attachment-backed image gallery for the current page. */
export interface CirGallery {
  type: 'gallery';
  title?: string;
  columns?: number;
  include?: string[];
  exclude?: string[];
  includeLabel?: string[];
  excludeLabel?: string[];
  sort?: 'none' | 'name' | 'date' | 'size' | 'comment';
  reverse?: boolean;
  limit?: number;
  captions?: boolean;
  sourceParams?: Record<string, string>;
}

/**
 * A third-party vendor app macro (`project-linker`, `azure-devops-macro-wiki`,
 * `appsplus-microsoft-onedrive-macro`). Its rendering lives in the vendor's app and cannot be
 * reimplemented, so every parameter is preserved verbatim and shown as a card that names the macro —
 * honest and lossless as data, rather than a silent drop.
 */
export interface CirExternalMacro {
  type: 'externalMacro';
  name: string;
  params: Record<string, string>;
}

/** A single Jira work item that may resolve through the migration crosswalk at serialization time. */
export interface CirJiraIssue {
  type: 'jiraIssue';
  key: string;
  macroName: string;
  params: Record<string, string>;
  sourceUrl?: string;
  children: CirNode[];
}

/** Confluence Content/Page Properties, kept separate from XISUITE custom-field `pageProperties`. */
export interface CirContentProperties {
  type: 'contentProperties';
  propertyId?: string;
  hidden: boolean;
  rows: { key: string; value: string }[];
  sourceParams: Record<string, string>;
  /** Exact normalized CIR body retained for migration diagnostics and future remapping. */
  sourceBody: string;
}

/** Label-scoped Content/Page Properties Report. A missing label is never represented natively. */
export interface CirContentPropertiesReport {
  type: 'contentPropertiesReport';
  label: string;
  propertyId?: string;
  titleColumn: string;
  columns: string[];
  limit: number;
  sortBy?: 'modified';
  sourceParams: Record<string, string>;
}

/** An invisible, targetable Confluence `anchor` macro. */
export interface CirAnchor {
  type: 'anchor';
  name: string;
}

/** A pre-sanitized HTML fragment (macro-fallback body.view; Milestone B). */
export interface CirRaw {
  type: 'raw';
  html: string;
}

/**
 * Confluence decisions (ADF `decisionList`). Structurally a task list, but a decision is RECORDED
 * rather than completed — flattening it into `taskList` would present every migrated decision as an
 * outstanding to-do. Kept distinct so the target can render it with decision semantics.
 */
export interface CirDecisionList {
  type: 'decisionList';
  items: { decided: boolean; children: CirNode[] }[];
}

/** Media caption (ADF `caption`) — describes the media block it follows. */
export interface CirCaption {
  type: 'caption';
  children: CirNode[];
}

/** Confluence `excerpt` body — invisible wrapper that marks content other pages can include. */
export interface CirExcerpt {
  type: 'excerpt';
  hidden: boolean;
  name?: string;
  sourceParams?: Record<string, string>;
  children: CirNode[];
}

/** Confluence `include` / Cloud Include Content, bound to a migrated stable page id. */
export interface CirIncludePage {
  type: 'includePage';
  pageId: string;
  title: string;
  targetSpaceId?: string;
  targetSpaceKey?: string;
  sourceParams?: Record<string, string>;
  sourceReference?: ParsedMacro['pageReference'];
}

/**
 * Confluence `excerpt-include` — resolved to the migrated local target page so the renderer can
 * inline the target page's preserved excerpt instead of downgrading to a bare link.
 */
export interface CirExcerptInclude {
  type: 'excerptInclude';
  pageId: string;
  title: string;
  targetSpaceId?: string;
  targetSpaceKey?: string;
  excerptName?: string;
  nopanel: boolean;
  sourceParams?: Record<string, string>;
  sourceReference?: ParsedMacro['pageReference'];
}

/**
 * Source-agnostic macro payload handed to the CF-B macro registry. The storage/ADF parsers
 * normalise a macro into this shape (params + already-parsed rich body + plain-text body) so the
 * handlers stay pure and work identically for Server storage-XHTML and Cloud ADF.
 */
export interface ParsedMacro {
  /** Lowercased macro name (`info`, `code`, `status`, …). */
  name: string;
  /** `ac:parameter` name→value (storage) / node attrs (ADF). */
  params: Record<string, string>;
  /** Parsed `ac:rich-text-body` / ADF `content` (nested macros already resolved). */
  richBody: CirNode[];
  /** `ac:plain-text-body` / text content (code/noformat macros). */
  plainBody: string;
  /** Rich `ri:page` identity for include macros; separate so source params remain byte-faithful. */
  pageReference?: {
    title: string;
    sourceId?: string;
    sourceSpaceKey?: string;
  };
}

export type CirNode =
  | CirText
  | CirHardBreak
  | CirParagraph
  | CirHeading
  | CirList
  | CirTaskList
  | CirBlockquote
  | CirCodeBlock
  | CirRule
  | CirLink
  | CirMedia
  | CirUserMention
  | CirPageLink
  | CirPanel
  | CirTable
  | CirMacroDeferred
  | CirStatus
  | CirExpand
  | CirLayout
  | CirTocMarker
  | CirAttachmentsMacro
  | CirDecisionList
  | CirCaption
  | CirExcerpt
  | CirIncludePage
  | CirExcerptInclude
  | CirDiagram
  | CirDate
  | CirInlineCard
  | CirSafeEmbed
  | CirCarousel
  | CirLiveMacro
  | CirCreateSpaceButton
  | CirChart
  | CirGallery
  | CirExternalMacro
  | CirJiraIssue
  | CirContentProperties
  | CirContentPropertiesReport
  | CirAnchor
  | CirRaw;

export interface CirDoc {
  type: 'doc';
  children: CirNode[];
}

/** References that must be resolved through the crosswalk before serialization. */
export interface CirRefs {
  userSourceIds: Set<string>;
  pageSourceIds: Set<string>;
  pageReferences: Map<string, { sourceId: string; sourceSpaceKey?: string }>;
  attachmentFilenames: Set<string>;
  jiraIssueKeys: Set<string>;
}

/** Walk the whole tree collecting every crosswalk reference for one bulk resolution pass. */
export function collectRefs(doc: CirDoc): CirRefs {
  const refs: CirRefs = {
    userSourceIds: new Set(),
    pageSourceIds: new Set(),
    pageReferences: new Map(),
    attachmentFilenames: new Set(),
    jiraIssueKeys: new Set(),
  };

  const visit = (node: CirNode): void => {
    switch (node.type) {
      case 'userMention':
        if (node.sourceId) refs.userSourceIds.add(node.sourceId);
        break;
      case 'pageLink':
        if (node.pageSourceId) {
          refs.pageSourceIds.add(node.pageSourceId);
          refs.pageReferences.set(
            pageReferenceKey(node.pageSourceId, node.sourceSpaceKey),
            {
              sourceId: node.pageSourceId,
              ...(node.sourceSpaceKey
                ? { sourceSpaceKey: node.sourceSpaceKey }
                : {}),
            },
          );
        }
        break;
      case 'media':
        if (node.filename) refs.attachmentFilenames.add(node.filename);
        break;
      case 'diagram':
        refs.attachmentFilenames.add(`${node.name}.png`);
        break;
      case 'jiraIssue':
        refs.jiraIssueKeys.add(node.key);
        node.children.forEach(visit);
        break;
      case 'paragraph':
      case 'heading':
      case 'blockquote':
      case 'link':
      case 'panel':
      case 'expand':
      case 'excerpt':
      case 'chart':
        node.children.forEach(visit);
        break;
      case 'layout':
        node.columns.forEach((col) => col.forEach(visit));
        break;
      case 'list':
        node.items.forEach((item) => item.forEach(visit));
        break;
      case 'taskList':
        node.items.forEach((item) => item.children.forEach(visit));
        break;
      case 'table':
        node.rows.forEach((row) =>
          row.cells.forEach((cell) => cell.children.forEach(visit)),
        );
        break;
      default:
        break;
    }
  };

  doc.children.forEach(visit);

  return refs;
}

/** A `pageLink` reference the crosswalk did not resolve on this render pass. */
export interface UnresolvedPageReference {
  /** `pageReferenceKey(sourceId, sourceSpaceKey)` — the key `resolved.pages` is indexed by. */
  key: string;
  sourceId: string;
  sourceSpaceKey?: string;
}

/**
 * Which `pageLink` references are still absent from the resolved page map.
 *
 * A `pageLink` to a page that migrates LATER in the same run renders as plain text on the first
 * pass (the target is not in the crosswalk yet) and `cir-to-tiptap.renderPageLink` degrades it to a
 * text node — there is no second chance unless the page is flagged for the `page_relink` re-render.
 * This is the judgment the render pass drives that flag from, parallel to how the macro handlers
 * call `ctx.markNeedsRelink?.()`.
 */
export function unresolvedPageReferences(
  refs: CirRefs,
  resolvedPages: ReadonlyMap<string, unknown>,
): UnresolvedPageReference[] {
  const unresolved: UnresolvedPageReference[] = [];

  for (const [key, ref] of refs.pageReferences) {
    if (resolvedPages.has(key)) continue;

    unresolved.push({
      key,
      sourceId: ref.sourceId,
      ...(ref.sourceSpaceKey ? { sourceSpaceKey: ref.sourceSpaceKey } : {}),
    });
  }

  return unresolved;
}
