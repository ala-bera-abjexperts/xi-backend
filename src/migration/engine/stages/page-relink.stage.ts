/**
 * @fileoverview `page_relink` stage — CF-B second render pass for cross-page macros.
 *
 * Some macros can't resolve on the first pass because the page/issue they reference isn't migrated
 * yet (`children`, `include`, `excerpt-include`, cross-page links). Those pages are flagged
 * `metadata.needs_relink = true` by the `pages` stage. This stage runs AFTER `page_attachments`,
 * enumerates the flagged pages, re-renders each (now that every page is in the crosswalk — e.g.
 * `children` resolves to the real child-page links), updates the wiki page, and clears the flag.
 *
 * Idempotent (clearing the flag stops re-seeding) and dry-run-safe (nothing is created to relink).
 */

import { confluenceSourcePageUrl } from '../../mappers/page.mapper';
import { Injectable } from '@nestjs/common';
import { WikiService } from '../../../wiki/wiki.service';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { isConfluenceAdapter } from '../../adapters/source-adapter.interface';
import { ContentTransformService } from '../../transformers/content-transform.service';
import { diagramFetcher } from '../../transformers/diagram-source';
import { pageReferenceKey } from '../../transformers/canonical-ir';
import { PAGE_ENTITY } from '../../mappers/page.mapper';
import {
  requireActingUser,
  resolveTargetSpace,
  runOptions,
} from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type SeedItem,
  type StageContext,
} from './stage.interface';

export const PAGE_RELINK_STAGE = 'page_relink';

const PAGE_BATCH = 25;

type IncludePageRow = {
  source_id: string;
  target_id: string;
  metadata: Record<string, unknown>;
};

/** Build only unambiguous stable-id and `(space,title)` keys; bare titles are never indexed. */
export function buildIncludePageIndex(
  rows: IncludePageRow[],
  urlFor: (row: IncludePageRow) => string,
): Record<
  string,
  {
    pageId: string;
    url: string;
    title: string;
    targetSpaceId?: string;
    targetSpaceKey?: string;
  }
> {
  const candidates = new Map<string, IncludePageRow[]>();

  for (const row of rows) {
    const title =
      typeof row.metadata?.title === 'string' ? row.metadata.title : '';
    const space =
      typeof row.metadata?.space_ref === 'string' ? row.metadata.space_ref : '';
    // Folders and blog containers are not link targets, and their titles ("Blog", "2024") would
    // collide with a real page's title key and drop it from the index.
    if (!row.source_id || !row.target_id || row.metadata?.is_folder === true)
      continue;

    const keys = [
      row.source_id,
      ...(title && space ? [pageReferenceKey(title, space)] : []),
    ];
    for (const key of keys) {
      candidates.set(key, [...(candidates.get(key) ?? []), row]);
    }
  }

  return Object.fromEntries(
    [...candidates.entries()].flatMap(([key, matches]) => {
      if (matches.length !== 1) return [];
      const [row] = matches;

      return [
        [
          key,
          {
            pageId: row.target_id,
            title:
              typeof row.metadata.title === 'string'
                ? row.metadata.title
                : row.source_id,
            url: urlFor(row),
            ...(typeof row.metadata.target_space_id === 'string'
              ? { targetSpaceId: row.metadata.target_space_id }
              : {}),
            ...(typeof row.metadata.space_ref === 'string'
              ? { targetSpaceKey: row.metadata.space_ref }
              : {}),
          },
        ],
      ];
    }),
  );
}

/**
 * Slightly longer than Wiki 2.0's `COLLAB_SESSION_TTL_MS` (120 s in `wiki.service.ts`), so a
 * retry lands after a stale session lease has certainly expired rather than racing it.
 */
const COLLAB_RETRY_MS = 130_000;

/**
 * Is this the Wiki 2.0 collab-ownership 409? Detected by the `code` on the exception payload
 * rather than the message text, and defensively — the stage must never crash while classifying
 * an error it is trying to classify.
 */
function isCollabActiveConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const candidate = err as {
    response?: unknown;
    getResponse?: () => unknown;
  };
  const payload =
    typeof candidate.getResponse === 'function'
      ? candidate.getResponse()
      : candidate.response;

  if (!payload || typeof payload !== 'object') return false;

  return (payload as { code?: unknown }).code === 'COLLAB_ACTIVE';
}

interface RelinkPayload {
  pageSourceId: string;
  wikiPageId: string;
  metadata: Record<string, unknown>;
}

@Injectable()
export class PageRelinkStage implements IStageHandler {
  readonly stage = PAGE_RELINK_STAGE;

  constructor(
    private readonly wiki: WikiService,
    private readonly content: ContentTransformService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** Page through the flagged pages (offset cursor), seeding one relink item each. */
  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    // Dry-run creates nothing → there is nothing to relink.
    if (ctx.dryRun) return { items: [], nextCheckpoint: null, done: true };

    const checkpoint = (collectionItem.checkpoint ?? {}) as { offset?: number };
    const offset =
      typeof checkpoint.offset === 'number' ? checkpoint.offset : 0;

    const { data: pages, error } = (await this.db
      .from('migration_entity_map')
      .select('source_id, target_id, metadata')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('job_id', ctx.job.id)
      .eq('run_id', ctx.run.id)
      .eq('entity_type', PAGE_ENTITY)
      .eq('status', 'mapped')
      .filter('metadata->>space_ref', 'eq', ctx.job.source_ref)
      .filter('metadata->>needs_relink', 'eq', 'true')
      // Folder containers have no content. `neq` alone would also drop rows WITHOUT the key.
      .or('metadata->>is_folder.is.null,metadata->>is_folder.neq.true')
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE_BATCH - 1)) as {
      data:
        | {
            source_id: string;
            target_id: string;
            metadata: Record<string, unknown>;
          }[]
        | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Failed to enumerate pages needing relink: ${error.message}`,
      );
    }

    if (!pages || pages.length === 0) {
      return { items: [], nextCheckpoint: null, done: true };
    }

    const seeds: SeedItem[] = pages.map((p) => ({
      entityType: PAGE_RELINK_STAGE,
      sourceRef: p.source_id,
      payload: {
        pageSourceId: p.source_id,
        wikiPageId: p.target_id,
        metadata: p.metadata ?? {},
      } as unknown as Record<string, unknown>,
    }));

    const done = pages.length < PAGE_BATCH;

    await ctx.log('info', `page_relink: seeded ${seeds.length} page(s)`, {
      count: seeds.length,
    });

    return {
      items: seeds,
      nextCheckpoint: done ? null : { offset: offset + pages.length },
      done,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload = item.payload as unknown as RelinkPayload | null;

    if (!payload?.pageSourceId || !payload.wikiPageId) {
      throw new MigrationItemError(
        'permanent',
        'Relink item is missing its snapshot',
      );
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen) {
      return {
        kind: 'blocked',
        waitingFor: { entityType: 'space', sourceId: ctx.job.source_ref },
      };
    }

    const actingUser = requireActingUser(ctx);
    const { data: targetSpace, error: targetSpaceError } = (await this.db
      .from('spaces')
      .select('key')
      .eq('organization_id', ctx.orgId)
      .eq('id', spaceId!)
      .maybeSingle()) as {
      data: { key: string } | null;
      error: { message: string } | null;
    };
    if (targetSpaceError || !targetSpace?.key)
      throw new MigrationItemError(
        'transient',
        `Failed to resolve target space key: ${targetSpaceError?.message ?? 'space missing'}`,
      );
    const adapter = await ctx.getAdapter();

    if (!isConfluenceAdapter(adapter)) {
      throw new MigrationItemError(
        'permanent',
        'Adapter has no Confluence read surface',
      );
    }

    // Resolve child pages (for `children` macros) — every page is now in the crosswalk.
    const { data: childRows } = (await this.db
      .from('migration_entity_map')
      .select('target_id, metadata')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('job_id', ctx.job.id)
      .eq('run_id', ctx.run.id)
      .eq('entity_type', PAGE_ENTITY)
      .eq('status', 'mapped')
      .filter('metadata->>parent_source_id', 'eq', payload.pageSourceId)) as {
      data: { target_id: string; metadata: Record<string, unknown> }[] | null;
    };

    const childPages = (childRows ?? []).map((r) => ({
      url: `/spaces/${encodeURIComponent(targetSpace.key)}/wiki/${r.target_id}`,
      title: typeof r.metadata?.title === 'string' ? r.metadata.title : 'page',
    }));

    const { data: pageRows, error: pageRowsError } = (await this.db
      .from('migration_entity_map')
      .select('source_id, target_id, metadata')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('job_id', ctx.job.id)
      .eq('run_id', ctx.run.id)
      .eq('entity_type', PAGE_ENTITY)
      .eq('status', 'mapped')) as {
      data: IncludePageRow[] | null;
      error: { message: string } | null;
    };
    if (pageRowsError) {
      throw new MigrationItemError(
        'transient',
        `Failed to resolve include pages: ${pageRowsError.message}`,
      );
    }
    const includePages = buildIncludePageIndex(
      pageRows ?? [],
      (row) => `/wiki/${row.target_id}`,
    );

    const format =
      payload.metadata?.body_format === 'atlas_doc_format'
        ? 'atlas_doc_format'
        : 'storage';
    const body = await adapter.getPageBody(payload.pageSourceId, format);
    const sourceBaseUrl = await ctx.getSourceBaseUrl?.();
    // Same format the page was created with (tiptap) — see page.mapper / cir-to-tiptap.
    const renderContext = {
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      pageSourceId: payload.pageSourceId,
      macroStrategy: runOptions(ctx).macro_strategy,
      childPages,
      includePages,
      currentSourceSpaceKey: ctx.job.source_ref,
      currentPageId: payload.wikiPageId,
      sourceBaseUrl: sourceBaseUrl ?? undefined,
      sourcePageUrl: confluenceSourcePageUrl(
        sourceBaseUrl,
        payload.pageSourceId,
        adapter.deployment === 'cloud',
      ),
      fetchDiagram: diagramFetcher(adapter, payload.pageSourceId),
      log: (message: string, meta?: Record<string, unknown>) =>
        void ctx.log('warn', message, meta),
    };
    const [rendered, excerptContent] = await Promise.all([
      this.content.renderBodyAsTipTap(body, renderContext),
      this.content.renderExcerptAsTipTap(body, renderContext),
    ]);
    const relinkedContent = rendered.content;

    // Wiki 2.0 guards `updatePage` with a collab-session gate: while a live editing session owns
    // the page, a write carrying no matching `collabSessionId` 409s with code `COLLAB_ACTIVE`.
    // Relink is a ONE-SHOT flag-clearing pass, so letting that surface as a generic failure would
    // permanently lose the relink for a page someone happened to open right after it migrated.
    // Classify it explicitly as transient and sleep past the session TTL instead.
    try {
      await this.wiki.updatePage(
        payload.wikiPageId,
        spaceId!,
        { content: relinkedContent, content_format: 'tiptap' },
        actingUser,
      );
    } catch (err) {
      if (isCollabActiveConflict(err)) {
        throw new MigrationItemError(
          'rate_limited',
          `Page ${payload.wikiPageId} is owned by a live collaborative editing session — ` +
            `retrying after the session lease expires`,
          COLLAB_RETRY_MS,
        );
      }

      throw err;
    }

    // Clear the flag (one-shot) so the producer never re-seeds this page.
    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: PAGE_ENTITY,
      sourceId: payload.pageSourceId,
      sourceKey:
        typeof payload.metadata?.title === 'string'
          ? payload.metadata.title
          : null,
      targetTable: 'wiki_pages',
      targetId: payload.wikiPageId,
      status: 'mapped',
      metadata: {
        ...payload.metadata,
        ...(excerptContent ? { excerpt_content: excerptContent } : {}),
        needs_relink: false,
      },
    });

    return {
      kind: 'updated',
      targetId: payload.wikiPageId,
      targetTable: 'wiki_pages',
    };
  }
}
