/**
 * @fileoverview Confluence page → `wiki_pages` via `WikiService.createPage`.
 *
 * Resolves `parent_id` through the page crosswalk (already gated ready by the worker), applies the
 * depth-flatten guard (WikiService throws past level 10), transforms the body to sanitizer-safe
 * HTML, and creates the page. `path`/`level` are trigger-owned — only `parent_id` is passed.
 * The returned crosswalk metadata carries the created `level` so descendants compute depth
 * without re-reading `wiki_pages`.
 */

import { hasLegacyProfileMacros } from '../transformers/profile-macro-identity';
import { BadRequestException, Injectable } from '@nestjs/common';
import { TipTapValidationError } from '../../common/utils/tiptap-sanitizer';
import { WikiService } from '../../wiki/wiki.service';
import { isConfluenceAdapter } from '../adapters/source-adapter.interface';
import type { NormalizedPage } from '../model/normalized';
import {
  ContentTransformService,
  type RenderContext,
  type TipTapRenderResult,
} from '../transformers/content-transform.service';
import { diagramFetcher } from '../transformers/diagram-source';
import {
  MigrationItemError,
  type StageContext,
} from '../engine/stages/stage.interface';
import { requireActingUser, runOptions } from '../engine/stages/stage-helpers';
import { blogPostPosition } from '../engine/stages/page-containers.util';

export const PAGE_ENTITY = 'page';

/** WikiService rejects a page whose level would exceed this (level = parentLevel + 1). */
const WIKI_MAX_LEVEL = 10;

export function confluenceSourcePageUrl(
  base: string | null | undefined,
  pageId: string,
  cloud: boolean,
): string | undefined {
  if (!base || !pageId) return undefined;
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.username = '';
    url.password = '';
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = `${path}${cloud && !path.endsWith('/wiki') ? '/wiki' : ''}/pages/viewpage.action`;
    url.search = '';
    url.hash = '';
    url.searchParams.set('pageId', pageId);
    return url.href;
  } catch {
    return undefined;
  }
}

export interface PageCreateResult {
  targetId: string;
  level: number;
  depthFlattened: boolean;
  /** A cross-page macro/link couldn't resolve yet → the `page_relink` stage must re-render. */
  needsRelink: boolean;
  excerptContent: string | null;
}

interface CreatedWikiPage {
  id: string;
  level: number;
}

@Injectable()
export class PageMapper {
  constructor(
    private readonly wiki: WikiService,
    private readonly content: ContentTransformService,
  ) {}

  /**
   * Fetch a source page's body and render it to TipTap — everything `createPage`
   * does BEFORE it writes anything.
   *
   * Split out so a dry run can exercise the conversion without creating a page.
   * The dry run previously returned before this ran, so it validated nothing
   * about content and happily reported "all good" on a space whose pages the
   * write gate would refuse — the customer only found out on the live run.
   */
  async renderTipTap(
    ctx: StageContext,
    page: NormalizedPage,
    options: Pick<
      RenderContext,
      | 'childPages'
      | 'includePages'
      | 'currentPageId'
      | 'currentSourceSpaceKey'
      | 'targetSpaceId'
    > = {},
  ): Promise<
    // `unresolvedAttachmentRefs` was already carried by the spread below; the old annotation
    // just hid it from callers. createPage needs it to flag the page for `page_relink`. XE-T535.
    TipTapRenderResult & { excerptContent: string | null }
  > {
    const adapter = await ctx.getAdapter();

    if (!isConfluenceAdapter(adapter)) {
      throw new MigrationItemError(
        'permanent',
        'Adapter has no Confluence read surface',
      );
    }

    const body = await adapter.getPageBody(page.sourceId, page.bodyFormat);
    const sourceBaseUrl = await ctx.getSourceBaseUrl?.();

    // TipTap, not HTML: Wiki 2.0 edits TipTap natively. An HTML page is collapsed into a single
    // opaque `rawHtml` atom the first time a user clicks Edit — losing every table, emptying
    // `content_text` (so the page drops out of search) and leaving no text node for an inline
    // comment to anchor to. See `cir-to-tiptap.ts`.
    const renderContext = {
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      pageSourceId: page.sourceId,
      macroStrategy: runOptions(ctx).macro_strategy,
      childPages: options.childPages,
      includePages: options.includePages,
      currentPageId: options.currentPageId,
      targetSpaceId:
        options.targetSpaceId ?? ctx.job.target_space_id ?? undefined,
      currentSourceSpaceKey:
        options.currentSourceSpaceKey ?? ctx.job.source_ref,
      sourceBaseUrl: sourceBaseUrl ?? undefined,
      sourcePageUrl: confluenceSourcePageUrl(
        sourceBaseUrl,
        page.sourceId,
        adapter.deployment === 'cloud',
      ),
      fetchDiagram: diagramFetcher(adapter, page.sourceId),
      log: (message: string, meta?: Record<string, unknown>) =>
        void ctx.log('warn', message, meta),
    };
    const [rendered, excerptContent] = await Promise.all([
      this.content.renderBodyAsTipTap(body, renderContext),
      this.content.renderExcerptAsTipTap(body, renderContext),
    ]);

    return { ...rendered, excerptContent };
  }

  async repairProfileMacros(
    ctx: StageContext,
    content: string,
    targetSpaceId: string,
    source?: { sourceId: string; bodyFormat: 'storage' | 'atlas_doc_format' },
  ): Promise<string> {
    const renderContext = {
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      targetSpaceId,
    };
    let confirmedSource;
    if (source && hasLegacyProfileMacros(JSON.parse(content))) {
      const adapter = await ctx.getAdapter();
      if (isConfluenceAdapter(adapter)) {
        try {
          const body = await adapter.getPageBody(
            source.sourceId,
            source.bodyFormat,
          );
          const rendered = await this.content.renderBodyAsTipTap(
            body,
            renderContext,
          );
          confirmedSource = JSON.parse(rendered.content);
        } catch {
          await ctx.log(
            'warn',
            'Legacy profile macros left unchanged: source identity could not be confirmed',
            { pageSourceId: source.sourceId },
          );
        }
      }
    }
    return this.content.resolveProfileMacros(
      content,
      renderContext,
      true,
      confirmedSource,
    );
  }

  async createPage(
    ctx: StageContext,
    page: NormalizedPage,
    targetSpaceId: string,
  ): Promise<PageCreateResult> {
    const { parentId, depthFlattened } = await this.resolveParent(
      ctx,
      page,
      targetSpaceId,
    );

    const rendered = await this.renderTipTap(ctx, page, { targetSpaceId });

    const actingUser = requireActingUser(ctx);
    // Blog posts are ordered newest-first inside their month container; pages keep the source order.
    const sortOrder =
      page.contentKind === 'blogpost'
        ? blogPostPosition(page.createdAt)
        : page.position;

    let created: CreatedWikiPage;

    try {
      created = (await this.wiki.createPage(
        {
          space_id: targetSpaceId,
          title: page.title || 'Untitled',
          content: rendered.content,
          content_format: 'tiptap',
          parent_id: parentId ?? undefined,
          ...(page.contentKind === 'blogpost'
            ? {
                is_published: true,
                metadata: {
                  content_kind: 'blogpost',
                  blog_created_at: page.createdAt,
                  blog_modified_at: page.updatedAt,
                  blog_author_source_id: page.authorSourceId,
                  blog_author_name: page.authorName,
                  blog_author_username: page.authorUsername,
                },
              }
            : {}),
        },
        ctx.orgId,
        actingUser,

        // Carry the source page's last-modified date so the wiki meta line shows when the
        // page actually changed in Confluence, not when the import ran. XE-T552.
        page.updatedAt || sortOrder !== undefined
          ? {
              ...(page.updatedAt ? { sourceUpdatedAt: page.updatedAt } : {}),
              ...(sortOrder !== undefined ? { sortOrder } : {}),
            }
          : undefined,
      )) as CreatedWikiPage;
    } catch (err) {
      this.rethrowCreateError(err);
    }

    return {
      targetId: created.id,
      level: created.level ?? 0,
      depthFlattened,
      // An attachment reference that did not resolve renders as a raw `[File: name.docx]` /
      // `[Image: name.png]` placeholder. At `pages` time that is expected, `page_attachments`
      // has not ingested the files yet, but nothing re-rendered the page afterwards unless a
      // cross-page macro happened to flag it too: `page_relink` only re-seeds pages carrying
      // `needs_relink`, and unresolved attachments never set it. Pages whose per-attachment
      // re-render did not fire kept the placeholder permanently. XE-T535.
      needsRelink:
        rendered.needsRelink || rendered.unresolvedAttachmentRefs.length > 0,
      excerptContent: rendered.excerptContent,
    };
  }

  /**
   * A structural container (Cloud folder, or a Blog/year/month node): nothing to fetch or render.
   * Created published with an empty document and `metadata.is_folder`, which the wiki tree already
   * renders as a folder. Parent resolution is exactly a page's.
   */
  async createContainer(
    ctx: StageContext,
    page: NormalizedPage,
    targetSpaceId: string,
  ): Promise<PageCreateResult> {
    const { parentId, depthFlattened } = await this.resolveParent(
      ctx,
      page,
      targetSpaceId,
    );

    let created: CreatedWikiPage;

    try {
      created = (await this.wiki.createPage(
        {
          space_id: targetSpaceId,
          title: page.title || 'Untitled',
          content: JSON.stringify({ type: 'doc', content: [] }),
          content_format: 'tiptap',
          parent_id: parentId ?? undefined,
          is_published: true,
          metadata: { is_folder: true },
        },
        ctx.orgId,
        requireActingUser(ctx),
        page.position !== undefined ? { sortOrder: page.position } : undefined,
      )) as CreatedWikiPage;
    } catch (err) {
      this.rethrowCreateError(err);
    }

    return {
      targetId: created.id,
      level: created.level ?? 0,
      depthFlattened,
      needsRelink: false,
      excerptContent: null,
    };
  }

  /** Classify a `WikiService.createPage` failure for the queue. Shared by pages and containers. */
  private rethrowCreateError(err: unknown): never {
    // A document the validator refuses is refused DETERMINISTICALLY — retrying
    // it just burns every attempt and lands the item in `dead`, while telling
    // the operator "retryable" about something that never was. This must be
    // checked FIRST: `TipTapValidationError` extends `BadRequestException`, and
    // so does the slug race below (`wiki.service.ts` wraps Postgres errors in
    // one), so the class alone cannot separate them.
    if (err instanceof TipTapValidationError) {
      throw new MigrationItemError(
        'permanent',
        `Wiki page content rejected: ${(err as Error).message}`,
      );
    }

    // Slug uniqueness race under concurrent workers, or a transient DB error → retry.
    if (
      err instanceof BadRequestException ||
      (err as { code?: string })?.code === '23505'
    ) {
      throw new MigrationItemError(
        'transient',
        `Wiki page create failed (retryable): ${(err as Error).message}`,
      );
    }

    throw err;
  }

  /**
   * Resolve the parent wiki id. If the resolved parent sits at level ≥ 10 (child would exceed
   * the limit), re-parent to the nearest ancestor at level ≤ 9; if none exists, attach to the
   * wiki root. The page is never dropped and the chain never dangles.
   */
  private async resolveParent(
    ctx: StageContext,
    page: NormalizedPage,
    targetSpaceId: string,
  ): Promise<{ parentId: string | null; depthFlattened: boolean }> {
    if (!page.parentSourceId) return { parentId: null, depthFlattened: false };

    const direct = await ctx.entityMap.getExistingWikiPageTarget(
      ctx.orgId,
      ctx.job.connection_id,
      page.parentSourceId,
      targetSpaceId,
    );

    const directLevel = Number(direct?.metadata?.level ?? 0);

    if (direct && directLevel < WIKI_MAX_LEVEL) {
      return { parentId: direct.target_id, depthFlattened: false };
    }

    // Walk ancestors (root→parent) backwards for the deepest one still at level ≤ 9.
    for (let i = page.ancestors.length - 1; i >= 0; i--) {
      const ancestorId = page.ancestors[i];

      if (ancestorId === page.parentSourceId) continue;

      const row = await ctx.entityMap.getExistingWikiPageTarget(
        ctx.orgId,
        ctx.job.connection_id,
        ancestorId,
        targetSpaceId,
      );

      if (row && Number(row.metadata?.level ?? 0) < WIKI_MAX_LEVEL) {
        await ctx.log(
          'warn',
          `Page nested deeper than ${WIKI_MAX_LEVEL} levels — re-parented`,
          { wikiDepthFlattened: true, pageSourceId: page.sourceId },
        );

        return { parentId: row.target_id, depthFlattened: true };
      }
    }

    // Two very different situations reach this point, and reporting both as a depth problem is
    // actively misleading: on the customer's space it produced 128 "nested deeper than 10 levels"
    // warnings for a hierarchy only 3 deep, and inflated the depth-flattened metric by the same 128.
    // `direct === null` means the parent is not in the crosswalk at all — a `parentId` pointing at a
    // page deleted in Confluence, which `detachUnreachableParents`
    // already decided belongs at the space root. Nothing was flattened in that case.
    const parentMissing = !direct;

    if (parentMissing) {
      await ctx.log(
        'warn',
        `Parent page ${page.parentSourceId} did not migrate — attached to the wiki root`,
        { wikiParentUnreachable: true, pageSourceId: page.sourceId },
      );

      return { parentId: null, depthFlattened: false };
    }

    await ctx.log(
      'warn',
      `Page nested deeper than ${WIKI_MAX_LEVEL} levels — attached to the wiki root`,
      { wikiDepthFlattened: true, pageSourceId: page.sourceId },
    );

    return { parentId: null, depthFlattened: true };
  }
}
