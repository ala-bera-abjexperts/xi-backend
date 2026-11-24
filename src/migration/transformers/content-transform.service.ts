/**
 * @fileoverview Content transform facade: raw source body → sanitizer-safe HTML.
 *
 * Detects the format, parses to XI-CIR, resolves crosswalk references (attachments + page links)
 * in one bulk pass, serializes to allow-listed HTML, then runs the REAL `sanitizeRichText` as a
 * self-check — any strip is a logged lossy warning (the output would otherwise be dropped at write
 * time). Wiki user mentions render display-only (`@Name`) — they carry no FK, so no user row is
 * created here (unlike Jira assignees).
 */

import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { sanitizeRichText } from '../../common/utils/sanitize-rich-text';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { browserSafeStorageUrl } from '../../wiki/wiki.service';
import type { RawBody } from '../model/normalized';
import { MigrationConnectionsService } from '../services/migration-connections.service';
import { MigrationEntityMapService } from '../services/migration-entity-map.service';
import { adfToCir } from './adf-to-html';
import {
  collectRefs,
  unresolvedPageReferences,
  type CirDoc,
  type CirNode,
} from './canonical-ir';
import { cirToHtml, type CirResolved } from './cir-serializer';
import { cirToTipTap, type TipTapNode } from './cir-to-tiptap';
import { detectFormat } from './content-format-detector';
import { renderMacro, type MacroContext } from './macros/macro-registry';
import { mapProfileMacros } from './profile-macro-identity';
import { deferredMacro, storageToCir } from './storage-format-to-html';
import { relinkSourceUrls } from './source-url-relink';

export const PAGE_ATTACHMENT_ENTITY = 'page_attachment';
export const PAGE_ENTITY = 'page';
export const USER_ENTITY = 'user';

/** `userMention.userId` is validated as a UUID; a dry-run `planned:` target would be rejected. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RenderContext {
  orgId: string;
  connectionId: string;
  /** Owning page id — scopes attachment resolution (`${pageSourceId}:${filename}`). */
  pageSourceId?: string;
  /**
   * Job macro strategy: `'semantic'` (CF-B, default) renders native tables + the macro registry;
   * `'fallback'` keeps CF-A behaviour (deferred macros + list-degraded tables).
   */
  macroStrategy?: 'semantic' | 'fallback';
  /** Explicit override of native-table rendering; when unset, derived from `macroStrategy`. */
  nativeTables?: boolean;
  /** Source instance base URL — used by the `jira` macro to build issue links. */
  sourceBaseUrl?: string;
  sourcePageUrl?: string;
  /** Relink pass: resolved child-page links for a `children` macro on this page. */
  childPages?: { url: string; title: string }[];
  /** Relink pass: the local page id used as the root of a live child-page tree. */
  currentPageId?: string;
  targetSpaceId?: string;
  /** Relink pass: migrated page targets keyed by source title for include macros. */
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
  /** Stored excerpt fragments keyed by source page title, in TipTap JSON form. */
  includeExcerptContent?: Record<string, string>;
  /** Source space of the page being rendered; scopes title-only include references. */
  currentSourceSpaceKey?: string;
  /**
   * Fetches a draw.io diagram's mxfile XML by attachment title. Supplied by the stage (which owns the
   * source adapter); when absent, `diagram` nodes degrade to a named placeholder instead of failing.
   */
  fetchDiagram?: (name: string) => Promise<string | null>;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface RenderResult {
  html: string;
  /** True when the sanitizer stripped something the serializer emitted (should be rare). */
  sanitizerStripped: boolean;
  /** True when a cross-page macro couldn't resolve yet → the `page_relink` stage must re-render. */
  needsRelink: boolean;
}

/**
 * TipTap output — what Wiki 2.0 actually stores. `content` is the serialized TipTap JSON, ready for
 * `WikiService.createPage`/`updatePage` with `content_format: 'tiptap'`.
 */
export interface TipTapRenderResult {
  content: string;
  needsRelink: boolean;
  /** Source attachment references that remain without a live page-attachment crosswalk. */
  unresolvedAttachmentRefs: string[];
}

/** The shared parse + resolve pipeline, before a target format is chosen. */
interface BuiltCir {
  cir: CirDoc;
  resolved: CirResolved;
  needsRelink: boolean;
  unresolvedAttachmentRefs: string[];
}

@Injectable()
export class ContentTransformService {
  constructor(
    private readonly entityMap: MigrationEntityMapService,
    @Optional() private readonly supabaseAdmin?: SupabaseAdminService,
    private readonly connections?: MigrationConnectionsService,
  ) {}

  private get db() {
    return this.supabaseAdmin?.getClient();
  }

  /**
   * Parse a source body into CIR and resolve its crosswalk references. Shared by both output
   * formats so HTML and TipTap can never drift in how they interpret macros, TOCs or attachments.
   */
  private async buildCir(
    body: RawBody,
    ctx: RenderContext,
    nativeAttachments = false,
  ): Promise<BuiltCir> {
    const format = detectFormat(body);
    const log = ctx.log ?? (() => undefined);
    const strValue = typeof body.value === 'string' ? body.value : '';

    // CF-B: `semantic` (default) → macro registry + native tables; `fallback` → CF-A deferral.
    const semantic = ctx.macroStrategy !== 'fallback';
    let needsRelink = false;

    const macroCtx: MacroContext = {
      nativeCommunicationMacros: nativeAttachments,
      log,
      markNeedsRelink: () => {
        needsRelink = true;
      },
      childPages: ctx.childPages,
      currentPageId: ctx.currentPageId,
      includePages: ctx.includePages,
      includeExcerptContent: ctx.includeExcerptContent,
      currentSourceSpaceKey: ctx.currentSourceSpaceKey,
      sourceBaseUrl: ctx.sourceBaseUrl,
      sourcePageUrl: ctx.sourcePageUrl,
    };
    const onMacro = semantic
      ? (macro: Parameters<typeof renderMacro>[0]) =>
          renderMacro(macro, macroCtx)
      : (macro: { name: string }) => deferredMacro(macro.name);

    let cir: CirDoc;

    if (format === 'adf') {
      cir = adfToCir(body.value, { onMacro, log });
    } else if (format === 'storage') {
      cir = storageToCir(strValue, { onMacro, log });
    } else {
      // Pre-rendered HTML / wiki fallback: hand it straight to the sanitizer.
      cir = { type: 'doc', children: [{ type: 'raw', html: strValue }] };
    }

    const refs = collectRefs(cir);
    const resolved = await this.resolveRefs(refs, ctx);

    if (semantic) {
      // Post-passes that need the whole doc (toc) or a crosswalk lookup (attachments).
      this.replaceTocMarkers(cir);
      await this.replaceAttachmentsMacros(cir, ctx, nativeAttachments);
      await this.resolveDiagrams(cir, ctx);

      // Plain Confluence and Jira source anchors become XiSuite links only through a
      // confirmed source origin and live crosswalk. Unresolvable links stay unchanged.
      const relinked = await relinkSourceUrls(
        cir,
        this.entityMap,
        {
          orgId: ctx.orgId,
          connectionId: ctx.connectionId,
          sourceBaseUrl: ctx.sourceBaseUrl,
          findJiraConnectionsByOrigin: async (sourceUrl) =>
            this.connections
              ? (
                  await this.connections.findActiveJiraConnectionsByOrigin(
                    ctx.orgId,
                    sourceUrl,
                  )
                ).map(({ id, origin }) => ({ id, origin }))
              : [],
          resolveJiraIssueTargets: (orgId, connectionId, issueKeys) =>
            this.resolveJiraIssueTargetsForRelink(
              orgId,
              connectionId,
              issueKeys,
            ),
          resolveJiraAttachmentTargets: (orgId, connectionId, sourceIds) =>
            this.resolveJiraAttachmentTargetsForRelink(
              orgId,
              connectionId,
              sourceIds,
            ),
        },
        resolved,
      );

      if (relinked.rewritten > 0) {
        log(`source-url relink rewrote ${relinked.rewritten} link(s)`, {
          relinked: relinked.rewritten,
        });
      }

      if (relinked.unresolved.length > 0) {
        needsRelink = true;
        log(
          `source-url relink left ${relinked.unresolved.length} internal link(s) unresolved`,
          {
            unresolvedLinks: relinked.unresolved.map(
              ({ kind, sourceRef, reason, href }) => ({
                kind,
                sourceRef,
                reason,
                href,
              }),
            ),
          },
        );
      }
    }

    /**
     * XE-T471: a `pageLink` (`<ac:link><ri:page>`) to a page that migrates LATER in the same run
     * has no crosswalk target on the first pass, so `cir-to-tiptap.renderPageLink` degrades it to
     * plain text. The macro handlers flag their page via `ctx.markNeedsRelink()`; a plain pageLink
     * must drive the SAME flag from the unresolved-reference set, or `page_relink` never re-renders
     * the page and the link is lost permanently.
     */
    const unresolvedPages = unresolvedPageReferences(refs, resolved.pages);

    if (unresolvedPages.length > 0) {
      needsRelink = true;
      log(`left ${unresolvedPages.length} internal page link(s) unresolved`, {
        unresolvedPageLinks: unresolvedPages.map(
          ({ sourceId, sourceSpaceKey }) => ({
            sourceRef: sourceId,
            ...(sourceSpaceKey ? { sourceSpaceKey } : {}),
          }),
        ),
      });
    }

    return {
      cir,
      resolved,
      needsRelink,
      unresolvedAttachmentRefs: [...refs.attachmentFilenames].filter(
        (filename) => !resolved.attachments.has(filename),
      ),
    };
  }

  /**
   * Transform one source body to TipTap JSON — the format Wiki 2.0 edits natively.
   *
   * Preferred over `renderBody` for wiki pages: an HTML page is collapsed into a single opaque
   * `rawHtml` atom the first time it is opened in the editor, which destroys its tables and empties
   * `content_text`. No sanitizer pass is needed here because `validateTipTapDoc` on the write path
   * is itself the gate, and it validates structurally rather than by tag allow-list.
   */
  async renderBodyAsTipTap(
    body: RawBody,
    ctx: RenderContext,
  ): Promise<TipTapRenderResult> {
    const { cir, resolved, needsRelink, unresolvedAttachmentRefs } =
      await this.buildCir(body, ctx, true);

    return {
      content: await this.resolveProfileMacros(
        JSON.stringify(cirToTipTap(cir, resolved)),
        ctx,
      ),
      needsRelink,
      unresolvedAttachmentRefs,
    };
  }

  /**
   * Render the first Confluence `excerpt` macro body on a page as its own TipTap fragment.
   *
   * This is stored on the page mapping so `excerpt-include` can be inlined later without a new
   * frontend-only macro runtime. A page with no excerpt returns null.
   */
  async renderExcerptAsTipTap(
    body: RawBody,
    ctx: RenderContext,
  ): Promise<string | null> {
    const log = ctx.log ?? (() => undefined);
    const semantic = ctx.macroStrategy !== 'fallback';
    const format = detectFormat(body);
    const strValue = typeof body.value === 'string' ? body.value : '';
    const onMacro = semantic
      ? (macro: Parameters<typeof renderMacro>[0]) =>
          renderMacro(macro, {
            nativeCommunicationMacros: true,
            log,
            childPages: ctx.childPages,
            currentPageId: ctx.currentPageId,
            includePages: ctx.includePages,
            includeExcerptContent: ctx.includeExcerptContent,
            currentSourceSpaceKey: ctx.currentSourceSpaceKey,
            sourceBaseUrl: ctx.sourceBaseUrl,
            sourcePageUrl: ctx.sourcePageUrl,
          })
      : (macro: { name: string }) => deferredMacro(macro.name);

    const fullDoc =
      format === 'adf'
        ? adfToCir(body.value, { onMacro, log })
        : format === 'storage'
          ? storageToCir(strValue, { onMacro, log })
          : { type: 'doc', children: [] as CirNode[] };

    const excerpt = findExcerpt(fullDoc.children);
    if (!excerpt || excerpt.children.length === 0) return null;

    const excerptDoc: CirDoc = { type: 'doc', children: excerpt.children };
    const resolved = await this.resolveRefs(collectRefs(excerptDoc), ctx);

    if (semantic) {
      this.replaceTocMarkers(excerptDoc);
      await this.replaceAttachmentsMacros(excerptDoc, ctx, true);
      await this.resolveDiagrams(excerptDoc, ctx);
      await relinkSourceUrls(
        excerptDoc,
        this.entityMap,
        {
          orgId: ctx.orgId,
          connectionId: ctx.connectionId,
          sourceBaseUrl: ctx.sourceBaseUrl,
          findJiraConnectionsByOrigin: async (sourceUrl) =>
            this.connections
              ? (
                  await this.connections.findActiveJiraConnectionsByOrigin(
                    ctx.orgId,
                    sourceUrl,
                  )
                ).map(({ id, origin }) => ({ id, origin }))
              : [],
          resolveJiraIssueTargets: (orgId, connectionId, issueKeys) =>
            this.resolveJiraIssueTargetsForRelink(
              orgId,
              connectionId,
              issueKeys,
            ),
          resolveJiraAttachmentTargets: (orgId, connectionId, sourceIds) =>
            this.resolveJiraAttachmentTargetsForRelink(
              orgId,
              connectionId,
              sourceIds,
            ),
        },
        resolved,
      );
    }

    return this.resolveProfileMacros(
      JSON.stringify(cirToTipTap(excerptDoc, resolved)),
      ctx,
    );
  }

  async resolveProfileMacros(
    content: string,
    ctx: RenderContext,
    repairOnly = false,
    confirmedSource?: TipTapNode,
  ): Promise<string> {
    return JSON.stringify(
      await mapProfileMacros(
        JSON.parse(content),
        async (refs) => {
          let spaceId = ctx.targetSpaceId;
          if (!spaceId && ctx.currentPageId && this.db) {
            const { data, error } = await this.db
              .from('wiki_pages')
              .select('space_id')
              .eq('organization_id', ctx.orgId)
              .eq('id', ctx.currentPageId)
              .maybeSingle();
            if (error)
              throw new BadRequestException(
                'Profile page ownership lookup failed',
              );
            spaceId = data?.space_id;
          }
          return spaceId
            ? this.entityMap.resolveProfileTargets(
                ctx.orgId,
                ctx.connectionId,
                spaceId,
                refs,
              )
            : new Map();
        },
        repairOnly,
        confirmedSource,
      ),
    );
  }

  /** Upgrade temporary pre-live-node carriers without freezing the target excerpt into this page. */
  inlineExcerptIncludes(
    content: string,
    _excerptsByTitle: Record<string, string>,
    includePages: Record<
      string,
      {
        pageId: string;
        url: string;
        title: string;
        targetSpaceId?: string;
        targetSpaceKey?: string;
      }
    >,
  ): string {
    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return content;
    }

    const replace = (nodes: unknown): unknown[] => {
      if (!Array.isArray(nodes)) return [];

      return (nodes as Record<string, unknown>[]).flatMap((node) => {
        if (!node || typeof node !== 'object') return [];

        const attrs =
          node.type === 'externalMacro' &&
          node.attrs &&
          typeof node.attrs === 'object'
            ? (node.attrs as Record<string, unknown>)
            : null;
        const name = typeof attrs?.name === 'string' ? attrs.name : null;
        const params =
          attrs?.params && typeof attrs.params === 'object'
            ? (attrs.params as Record<string, unknown>)
            : null;

        if (name === 'excerpt-include') {
          const title =
            typeof params?.page === 'string'
              ? params.page
              : typeof params?.[''] === 'string'
                ? params['']
                : '';
          const pageId =
            typeof params?.pageId === 'string' ? params.pageId : '';
          const target =
            Object.values(includePages).find(
              (candidate) => candidate.pageId === pageId,
            ) ?? (title ? includePages[title] : null);
          if (!target) return [node];

          return [
            {
              type: 'excerptInclude',
              attrs: {
                pageId: target.pageId,
                title: target.title,
                nopanel: params?.nopanel === 'true',
                ...(typeof params?.excerpt === 'string' && params.excerpt
                  ? { excerptName: params.excerpt }
                  : {}),
                sourceParams: params ?? {},
              },
            },
          ];
        }

        if (Array.isArray(node.content)) {
          return [{ ...node, content: replace(node.content) }];
        }

        return [node];
      });
    };

    return JSON.stringify({
      ...parsed,
      content: replace(parsed.content),
    });
  }

  /** Transform one source body to sanitizer-safe HTML, resolving refs via the crosswalk. */
  async renderBody(body: RawBody, ctx: RenderContext): Promise<RenderResult> {
    const log = ctx.log ?? (() => undefined);
    const { cir, resolved, needsRelink } = await this.buildCir(body, ctx);

    const rawHtml = cirToHtml(cir, resolved);
    // Wiki/migration is a table-capable surface → opt in. Task/comment/GDPR keep the default
    // (no tables), so migrated tables can never reach the table-less inline editor.
    const sanitized = sanitizeRichText(rawHtml, { allowTables: true }) ?? '';
    const stripped = detectStrippedMarkup(rawHtml, sanitized);

    if (stripped) {
      log('content sanitizer removed part of the rendered body', {
        pageSourceId: ctx.pageSourceId,
        before: rawHtml.length,
        after: sanitized.length,
      });
    }

    return { html: sanitized, sanitizerStripped: stripped, needsRelink };
  }

  /**
   * Replace `toc` markers ANYWHERE in the tree with a list of the doc's heading titles.
   * A TOC inside an `ac:layout-cell` (the classic sidebar idiom) or a panel is common — scanning
   * only the top level left those markers in place, and the serializer renders them as '' → the
   * whole TOC silently vanished. Each marker gets a FRESH node (no shared-object aliasing).
   */
  private replaceTocMarkers(doc: CirDoc): void {
    const headings = anchorHeadings(doc);

    doc.children = replaceMarkers(doc.children, (n) => {
      if (n.type !== 'tocMarker') return null;

      return headings.length > 0
        ? tocList(headings)
        : { type: 'paragraph', children: [] };
    });
  }

  /**
   * Replace `attachments` markers anywhere in the tree with links to ALL of the page's migrated
   * attachments. Using the render's `resolved.attachments` was wrong: that map only holds files the
   * body already inlines as images, so a page whose files aren't embedded listed nothing.
   */
  private async replaceAttachmentsMacros(
    doc: CirDoc,
    ctx: RenderContext,
    native = false,
  ): Promise<void> {
    if (!hasNode(doc.children, 'attachmentsMacro')) return;

    // Wiki 2.0 has a live attachment table.  Keep the marker for TipTap so the view reflects
    // later uploads too; the HTML compatibility path below still needs concrete links.
    if (native) return;

    let entries: { filename: string; url: string }[] = [];

    if (ctx.pageSourceId) {
      const rows = await this.entityMap.listPageAttachments(
        ctx.orgId,
        ctx.connectionId,
        ctx.pageSourceId,
      );

      entries = rows
        .map((row) => ({
          filename:
            typeof row.metadata?.filename === 'string'
              ? row.metadata.filename
              : row.source_id.slice(row.source_id.indexOf(':') + 1),
          url: typeof row.metadata?.url === 'string' ? row.metadata.url : '',
        }))
        .filter((e) => e.url && e.filename);
    }

    doc.children = replaceMarkers(doc.children, (n) => {
      if (n.type !== 'attachmentsMacro') return null;

      return entries.length > 0
        ? {
            type: 'list',
            ordered: false,
            items: entries.map((e) => [
              {
                type: 'link',
                href: e.url,
                children: [{ type: 'text', text: e.filename }],
              },
            ]),
          }
        : { type: 'attachmentsMacro' };
    });
  }

  /**
   * Fill in each `diagram` node's mxfile XML so it can become a native Wiki 2.0 `drawioDiagram`.
   *
   * The drawio macro records only a name; the drawing is a page attachment of that exact title with
   * mime `application/vnd.jgraph.mxfile`. That attachment is NOT in the crosswalk — Wiki 2.0's upload
   * allow-list rejects the mime, so `page_attachments` skips it — which is fine, because the node
   * stores the XML inline and needs no attachment row at all. Each distinct name is fetched once.
   */
  private async resolveDiagrams(
    doc: CirDoc,
    ctx: RenderContext,
  ): Promise<void> {
    if (!hasNode(doc.children, 'diagram')) return;

    const fetchDiagram = ctx.fetchDiagram;

    if (!fetchDiagram) return;

    const names = new Set<string>();

    replaceMarkers(doc.children, (n) => {
      if (n.type === 'diagram') names.add(n.name);

      return null;
    });

    const xmlByName = new Map<string, string>();

    for (const name of names) {
      try {
        const xml = await fetchDiagram(name);

        // The node's validator requires an `<mxfile>` (or an SVG data URI); anything else would be
        // rejected on write and fail the whole page, so it is left to degrade instead.
        if (xml && xml.trimStart().startsWith('<mxfile')) {
          xmlByName.set(name, xml);
        } else {
          ctx.log?.('diagram attachment is not an mxfile', { name });
        }
      } catch (err) {
        ctx.log?.('diagram attachment could not be read', {
          name,
          error: (err as Error).message,
        });
      }
    }

    if (xmlByName.size === 0) return;

    doc.children = replaceMarkers(doc.children, (n) => {
      if (n.type !== 'diagram') return null;

      const xml = xmlByName.get(n.name);

      return xml ? { ...n, xml } : null;
    });
  }

  private async resolveRefs(
    refs: ReturnType<typeof collectRefs>,
    ctx: RenderContext,
  ): Promise<CirResolved> {
    const attachments = new Map<string, string>();
    const attachmentPreviews = new Map<string, string>();
    const jiraIssues = new Map<string, { taskKey: string }>();
    const users = new Map<
      string,
      { userId: string; displayName: string; isPlaceholder?: boolean }
    >();
    const pages = new Map<
      string,
      {
        url: string;
        title?: string;
        pageId?: string;
        pageSlug?: string;
        spaceKey?: string;
      }
    >();

    /**
     * Attachment resolution is indexed by BOTH the filename and the Media Services `file_id`.
     *
     * Storage-format bodies (`<ri:attachment ri:filename="x.png">`) reference a filename, but ADF —
     * which is what every Confluence CLOUD page returns — references `media.attrs.id`, a UUID. The
     * old lookup only built `${pageSourceId}:${filename}` keys, so on Cloud it could never hit and
     * every attachment-backed image degraded to a `[Image: <uuid>]` placeholder, permanently.
     *
     * Listing the page's attachments (rather than querying only the refs we spotted) also makes the
     * two-pass flow robust: the `page_attachments` re-render sees everything already migrated.
     */
    if (ctx.pageSourceId && refs.attachmentFilenames.size > 0) {
      const rows = await this.entityMap.listPageAttachments(
        ctx.orgId,
        ctx.connectionId,
        ctx.pageSourceId,
      );

      for (const row of rows) {
        const url = row.metadata?.url;

        if (typeof url !== 'string' || !url) continue;

        const filename = row.metadata?.filename;
        const fileId = row.metadata?.file_id;
        const previewUrl = row.metadata?.preview_url;

        if (typeof filename === 'string' && filename) {
          attachments.set(filename, browserSafeStorageUrl(url));
          if (typeof previewUrl === 'string' && previewUrl) {
            attachmentPreviews.set(filename, browserSafeStorageUrl(previewUrl));
          }
        }

        if (typeof fileId === 'string' && fileId) {
          attachments.set(fileId, browserSafeStorageUrl(url));
          if (typeof previewUrl === 'string' && previewUrl) {
            attachmentPreviews.set(fileId, browserSafeStorageUrl(previewUrl));
          }
        }
      }
    }

    /**
     * Mentions.
     *
     * This used to return an empty map with the note "wiki mentions are display-only (no FK)". That
     * held for the HTML path, where a mention is just a styled span. It does NOT hold for TipTap:
     * `userMention.userId` must be a real user UUID or the serializer degrades the node to text — and
     * Confluence Cloud leaves ADF's `mention.attrs.text` EMPTY, so the degraded form renders as a bare
     * "@" with no name at all. The display name comes from the crosswalk (the `users` stage recovered
     * it from page metadata and rendered bodies), never from the ADF node.
     */
    if (refs.userSourceIds.size > 0) {
      const rows = await this.entityMap.getTargets(
        ctx.orgId,
        ctx.connectionId,
        USER_ENTITY,
        [...refs.userSourceIds],
      );

      for (const [sourceId, row] of rows) {
        // A `planned` dry-run row carries no real id; emitting it would fail the UUID validator.
        if (!row.target_id || !UUID_RE.test(row.target_id)) continue;

        const displayName =
          typeof row.metadata?.display_name === 'string'
            ? row.metadata.display_name
            : '';

        users.set(sourceId, {
          userId: row.target_id,
          displayName,
          ...(row.metadata?.is_placeholder === true
            ? { isPlaceholder: true }
            : {}),
        });
      }
    }

    // Page links: ADF carries a source id, while Server storage carries title + source space.
    // Resolve both to the REAL target space key so WikiLink never defaults to the current space.
    if (refs.pageReferences.size > 0) {
      const rows = await this.entityMap.resolveWikiPageTargets(
        ctx.orgId,
        ctx.connectionId,
        [...refs.pageReferences.values()],
      );

      for (const [sourceId, row] of rows) {
        const route = row.spaceKey
          ? `/spaces/${row.spaceKey}/wiki/${row.pageSlug ?? row.pageId}`
          : `/wiki/${row.pageId}`;

        pages.set(sourceId, { ...row, url: route });
      }
    }

    if (refs.jiraIssueKeys.size > 0) {
      const mapped = await this.entityMap.resolveIssueTargets(
        ctx.orgId,
        ctx.connectionId,
        [...refs.jiraIssueKeys],
      );

      for (const [sourceKey, target] of mapped)
        jiraIssues.set(sourceKey, target);
    }

    return {
      users,
      pages,
      attachments,
      attachmentPreviews,
      jiraIssues,
      // CF-B: native tables on unless the job explicitly chose the `fallback` strategy.
      nativeTables: ctx.nativeTables ?? ctx.macroStrategy !== 'fallback',
    };
  }

  private async resolveJiraIssueTargetsForRelink(
    orgId: string,
    connectionId: string,
    issueKeys: string[],
  ): Promise<{
    targets: ReadonlyMap<string, { taskKey: string }>;
    unresolved: ReadonlyMap<string, string>;
  }> {
    const keys = [
      ...new Set(issueKeys.map((key) => key.trim()).filter(Boolean)),
    ].slice(0, 200);
    const targets = await this.entityMap.resolveIssueTargets(
      orgId,
      connectionId,
      keys,
    );
    const unresolved = new Map<string, string>();

    if (!this.db || keys.length === 0) return { targets, unresolved };

    const { data, error } = (await this.db
      .from('migration_entity_map')
      .select('source_key, target_id, status')
      .eq('organization_id', orgId)
      .eq('source_connection_id', connectionId)
      .eq('entity_type', 'issue')
      .in('source_key', keys)) as {
      data:
        | { source_key: string | null; target_id: string; status: string }[]
        | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Issue relink lookup failed: ${error.message}`,
      );
    }

    const rowsByKey = new Map<
      string,
      { target_id: string; status: string }[]
    >();

    for (const row of data ?? []) {
      if (!row.source_key) continue;
      rowsByKey.set(row.source_key, [
        ...(rowsByKey.get(row.source_key) ?? []),
        row,
      ]);
    }

    for (const key of keys) {
      if (targets.has(key)) continue;

      const rows = rowsByKey.get(key) ?? [];

      if (rows.length === 0) {
        unresolved.set(
          key,
          `issue "${key}" was not migrated by this Jira connection`,
        );
        continue;
      }

      if (rows.some((row) => row.status === 'mapped')) {
        unresolved.set(
          key,
          `migrated task for issue "${key}" no longer exists`,
        );
        continue;
      }

      unresolved.set(
        key,
        `issue "${key}" was not migrated (${rows[0].status})`,
      );
    }

    return { targets, unresolved };
  }

  private async resolveJiraAttachmentTargetsForRelink(
    orgId: string,
    connectionId: string,
    sourceIds: string[],
  ): Promise<{
    targets: ReadonlyMap<string, { attachmentId: string }>;
    unresolved: ReadonlyMap<string, string>;
  }> {
    const ids = [
      ...new Set(sourceIds.map((id) => id.trim()).filter(Boolean)),
    ].slice(0, 200);
    const targets = await this.entityMap.resolveAttachmentTargets(
      orgId,
      connectionId,
      ids,
    );
    const unresolved = new Map<string, string>();

    if (!this.db || ids.length === 0) return { targets, unresolved };

    const { data, error } = (await this.db
      .from('migration_entity_map')
      .select('source_id, target_id, status')
      .eq('organization_id', orgId)
      .eq('source_connection_id', connectionId)
      .eq('entity_type', 'attachment')
      .in('source_id', ids)) as {
      data: { source_id: string; target_id: string; status: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new BadRequestException(
        `Jira attachment relink lookup failed: ${error.message}`,
      );
    }

    const rowsById = new Map<string, { target_id: string; status: string }[]>();

    for (const row of data ?? []) {
      rowsById.set(row.source_id, [
        ...(rowsById.get(row.source_id) ?? []),
        row,
      ]);
    }

    for (const id of ids) {
      if (targets.has(id)) continue;

      const rows = rowsById.get(id) ?? [];

      if (rows.length === 0) {
        unresolved.set(
          id,
          `attachment "${id}" was not migrated by this Jira connection`,
        );
        continue;
      }

      if (rows.some((row) => row.status === 'mapped')) {
        unresolved.set(
          id,
          `migrated file for attachment "${id}" no longer exists`,
        );
        continue;
      }

      unresolved.set(
        id,
        `attachment "${id}" was not migrated (${rows[0].status})`,
      );
    }

    return { targets, unresolved };
  }
}

/** Is a node of `type` present ANYWHERE in the tree? (markers nest inside panels/layout cells). */
function hasNode(nodes: CirNode[], type: CirNode['type']): boolean {
  let found = false;

  replaceMarkers(nodes, (n) => {
    if (n.type === type) found = true;

    return null;
  });

  return found;
}

function findExcerpt(
  nodes: CirNode[],
): Extract<CirNode, { type: 'excerpt' }> | null {
  for (const node of nodes) {
    if (node.type === 'excerpt') return node;

    if (
      node.type === 'paragraph' ||
      node.type === 'heading' ||
      node.type === 'blockquote' ||
      node.type === 'link' ||
      node.type === 'panel' ||
      node.type === 'expand'
    ) {
      const hit = findExcerpt(node.children);
      if (hit) return hit;
      continue;
    }

    if (node.type === 'layout') {
      for (const column of node.columns) {
        const hit = findExcerpt(column);
        if (hit) return hit;
      }
      continue;
    }

    if (node.type === 'list') {
      for (const item of node.items) {
        const hit = findExcerpt(item);
        if (hit) return hit;
      }
      continue;
    }

    if (node.type === 'taskList') {
      for (const item of node.items) {
        const hit = findExcerpt(item.children);
        if (hit) return hit;
      }
      continue;
    }

    if (node.type === 'table') {
      for (const row of node.rows) {
        for (const cell of row.cells) {
          const hit = findExcerpt(cell.children);
          if (hit) return hit;
        }
      }
    }
  }

  return null;
}

const TAG_RE = /<([a-zA-Z][\w-]*)/g;
const ATTR_RE = /\s([a-zA-Z-]+)=/g;

function vocabulary(html: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  let m: RegExpExecArray | null;

  re.lastIndex = 0;
  while ((m = re.exec(html)) !== null) out.add(m[1].toLowerCase());

  return out;
}

/**
 * Did the sanitizer actually REMOVE markup?
 *
 * A length diff is wrong in BOTH directions and can't be used: `escapeHtml` emits `&#39;`/`&quot;`
 * which DOMPurify re-serializes back to `'`/`"` (shorter → a false "lossy" warning on virtually
 * every page, since most prose has an apostrophe), while invalid-nesting reflow ADDS characters and
 * can mask a genuine strip. Compare the tag/attribute vocabulary instead: if every tag and attribute
 * the serializer emitted still exists afterwards, nothing was dropped — normalisation is not loss.
 */
function detectStrippedMarkup(before: string, after: string): boolean {
  const beforeTags = vocabulary(before, TAG_RE);
  const afterTags = vocabulary(after, TAG_RE);

  for (const tag of beforeTags) if (!afterTags.has(tag)) return true;

  const beforeAttrs = vocabulary(before, ATTR_RE);
  const afterAttrs = vocabulary(after, ATTR_RE);

  for (const attr of beforeAttrs) if (!afterAttrs.has(attr)) return true;

  return false;
}

/**
 * Walk every block position in the tree and swap any node `make` claims. Recurses through every
 * container type so a marker nested in a layout column / panel / expand / list / table cell is
 * replaced rather than silently dropped by the serializer.
 */
function replaceMarkers(
  nodes: CirNode[],
  make: (node: CirNode) => CirNode | null,
): CirNode[] {
  return nodes.map((node): CirNode => {
    const replacement = make(node);

    if (replacement) return replacement;

    switch (node.type) {
      case 'paragraph':
      case 'heading':
      case 'blockquote':
      case 'link':
      case 'panel':
      case 'expand':
      case 'excerpt':
        return { ...node, children: replaceMarkers(node.children, make) };
      case 'layout':
        return {
          ...node,
          columns: node.columns.map((col) => replaceMarkers(col, make)),
        };
      case 'list':
        return {
          ...node,
          items: node.items.map((item) => replaceMarkers(item, make)),
        };
      case 'taskList':
        return {
          ...node,
          items: node.items.map((item) => ({
            ...item,
            children: replaceMarkers(item.children, make),
          })),
        };
      case 'table':
        return {
          ...node,
          rows: node.rows.map((row) => ({
            cells: row.cells.map((cell) => ({
              ...cell,
              children: replaceMarkers(cell.children, make),
            })),
          })),
        };
      default:
        return node;
    }
  });
}

interface TocHeading {
  title: string;
  id: string;
  level: number;
  children: TocHeading[];
}

function headingSlug(title: string): string {
  return (
    title
      .toLocaleLowerCase()
      .trim()
      .replace(/\s+/gu, '-')
      .replace(/[^\p{L}\p{N}_-]+/gu, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}

/** Assign stable fragment ids and collect a level-aware outline in document order. */
function anchorHeadings(doc: CirDoc): TocHeading[] {
  const counts = new Map<string, number>();
  const flat: TocHeading[] = [];

  doc.children = replaceMarkers(doc.children, (node) => {
    if (node.type !== 'heading') return null;

    const title = textOf(node.children).trim();

    if (!title) return null;

    const base = headingSlug(title);
    const count = (counts.get(base) ?? 0) + 1;
    const id = count === 1 ? base : `${base}-${count}`;

    counts.set(base, count);
    flat.push({ title, id, level: node.level, children: [] });

    return { ...node, anchorId: id };
  });

  const roots: TocHeading[] = [];
  const stack: TocHeading[] = [];

  for (const heading of flat) {
    while (stack.length > 0 && heading.level <= stack[stack.length - 1].level) {
      stack.pop();
    }

    (stack[stack.length - 1]?.children ?? roots).push(heading);
    stack.push(heading);
  }

  return roots;
}

function tocList(headings: TocHeading[]): CirNode {
  return {
    type: 'list',
    ordered: false,
    items: headings.map((heading) => [
      {
        type: 'link',
        href: `#${heading.id}`,
        children: [{ type: 'text', text: heading.title }],
      },
      ...(heading.children.length > 0 ? [tocList(heading.children)] : []),
    ]),
  };
}

/** Concatenate the plain text of a run of inline/block CIR nodes. */
function textOf(nodes: CirNode[]): string {
  let out = '';

  for (const n of nodes) {
    if (n.type === 'text') out += n.text;
    else if (
      'children' in n &&
      Array.isArray((n as { children?: CirNode[] }).children)
    ) {
      out += textOf((n as { children: CirNode[] }).children);
    }
  }

  return out.trim();
}
