/**
 * Re-renders pages from one completed Confluence run after an importer fix.
 *
 * This stage is intentionally available only to the dedicated repair plan. It never deletes
 * pages and refuses to overwrite a page touched after the source run completed.
 */
import { Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { WikiService } from '../../../wiki/wiki.service';
import { PageMapper, PAGE_ENTITY } from '../../mappers/page.mapper';
import { isConfluenceAdapter } from '../../adapters/source-adapter.interface';
import { requireActingUser } from './stage-helpers';
import { buildIncludePageIndex } from './page-relink.stage';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type SeedItem,
  type StageContext,
} from './stage.interface';

export const CONFLUENCE_PAGE_REPAIR_STAGE = 'confluence_page_repair';
const PAGE_BATCH = 25;

interface RepairPayload {
  sourceId: string;
  targetId: string;
  title: string;
  bodyFormat: 'storage' | 'atlas_doc_format';
  metadata: Record<string, unknown>;
}

/**
 * A prior repair updates the page immediately before its successful work item is finished.  That
 * timestamp window is the only safe legacy signal available for imports made before we recorded a
 * repair watermark in the mapping metadata.  A later user edit is necessarily outside it.
 */
export function isPriorMigrationRepair(
  pageUpdatedAt: string,
  repairStartedAt: string | null,
  repairFinishedAt: string | null,
): boolean {
  const pageTime = Date.parse(pageUpdatedAt);
  const startedTime = repairStartedAt ? Date.parse(repairStartedAt) : NaN;
  const finishedTime = repairFinishedAt ? Date.parse(repairFinishedAt) : NaN;

  return (
    Number.isFinite(pageTime) &&
    Number.isFinite(startedTime) &&
    Number.isFinite(finishedTime) &&
    pageTime >= startedTime &&
    pageTime <= finishedTime
  );
}

@Injectable()
export class ConfluencePageRepairStage implements IStageHandler {
  readonly stage = CONFLUENCE_PAGE_REPAIR_STAGE;

  constructor(
    private readonly pageMapper: PageMapper,
    private readonly wiki: WikiService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const repairOf = this.repairOf(ctx);
    if (ctx.dryRun || !repairOf)
      return { items: [], nextCheckpoint: null, done: true };

    const offset = Number(collectionItem.checkpoint?.offset ?? 0);
    const { data, error } = (await this.db
      .from('migration_entity_map')
      .select('source_id, target_id, metadata')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('job_id', ctx.job.id)
      .eq('run_id', repairOf)
      .eq('entity_type', PAGE_ENTITY)
      .eq('status', 'mapped')
      .filter('metadata->>space_ref', 'eq', ctx.job.source_ref)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
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

    if (error)
      throw new MigrationItemError(
        'transient',
        `Failed to enumerate pages for repair: ${error.message}`,
      );

    const pages = data ?? [];
    return {
      items: pages.flatMap((page): SeedItem[] => {
        const title =
          typeof page.metadata?.title === 'string' ? page.metadata.title : '';
        const bodyFormat = page.metadata?.body_format;
        if (
          !title ||
          (bodyFormat !== 'storage' && bodyFormat !== 'atlas_doc_format')
        )
          return [];
        return [
          {
            entityType: CONFLUENCE_PAGE_REPAIR_STAGE,
            sourceRef: page.source_id,
            payload: {
              sourceId: page.source_id,
              targetId: page.target_id,
              title,
              bodyFormat,
              metadata: page.metadata,
            },
          },
        ];
      }),
      nextCheckpoint:
        pages.length < PAGE_BATCH ? null : { offset: offset + pages.length },
      done: pages.length < PAGE_BATCH,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload = item.payload as unknown as RepairPayload | null;
    if (!payload?.sourceId || !payload.targetId)
      throw new MigrationItemError(
        'permanent',
        'Confluence page repair item is missing its snapshot',
      );
    const repairOf = this.repairOf(ctx);
    if (!repairOf) return { kind: 'skipped', reason: 'not a repair run' };

    const adapter = await ctx.getAdapter();
    if (!isConfluenceAdapter(adapter))
      throw new MigrationItemError(
        'permanent',
        'Confluence page repair requires a Confluence connection',
      );

    const [
      { data: sourceRun, error: sourceError },
      { data: page, error: pageError },
    ] = await Promise.all([
      this.db
        .from('migration_runs')
        .select('finished_at')
        .eq('organization_id', ctx.orgId)
        .eq('id', repairOf)
        .maybeSingle(),
      this.db
        .from('wiki_pages')
        .select('id, space_id, updated_at, content, content_format')
        .eq('id', payload.targetId)
        .eq('organization_id', ctx.orgId)
        .maybeSingle(),
    ]);
    if (sourceError || !sourceRun?.finished_at)
      throw new MigrationItemError(
        'conflict',
        'The source run is unavailable or has not finished; page repair was not applied',
      );
    if (pageError)
      throw new MigrationItemError(
        'transient',
        `Failed to load wiki page for repair: ${pageError.message}`,
      );
    if (!page)
      return { kind: 'skipped', reason: 'mapped wiki page no longer exists' };
    if (ctx.run.config_snapshot.repair_scope === 'profile_macros') {
      if (page.content_format !== 'tiptap' || !page.content)
        return { kind: 'skipped', reason: 'profile repair requires native wiki content' };
      const content = await this.pageMapper.repairProfileMacros(ctx, page.content, page.space_id, payload);
      if (content === page.content || JSON.stringify(JSON.parse(content)) === JSON.stringify(JSON.parse(page.content)))
        return { kind: 'skipped', reason: 'no safely mapped imported profiles to repair' };
      try {
        await this.wiki.updatePage(payload.targetId, page.space_id, {
          content, content_format: 'tiptap', expectedUpdatedAt: page.updated_at,
        }, requireActingUser(ctx));
      } catch (error) {
        throw new MigrationItemError('conflict', `Profile repair could not safely update the page: ${(error as Error).message}`);
      }
      return { kind: 'updated', targetId: payload.targetId };
    }
    let priorRepairOwnsPage = false;
    if (Date.parse(page.updated_at) > Date.parse(sourceRun.finished_at)) {
      const { data: priorRepairRuns, error: priorRepairRunsError } =
        (await this.db
          .from('migration_runs')
          .select('id')
          .eq('organization_id', ctx.orgId)
          .eq('job_id', ctx.job.id)
          .eq('status', 'succeeded')
          .filter('config_snapshot->>repair_of_run_id', 'eq', repairOf)
          .neq('id', ctx.run.id)) as {
          data: { id: string }[] | null;
          error: { message: string } | null;
        };
      if (priorRepairRunsError)
        throw new MigrationItemError(
          'transient',
          `Failed to verify earlier repair ownership: ${priorRepairRunsError.message}`,
        );

      const priorRepairIds = (priorRepairRuns ?? []).map((run) => run.id);
      if (priorRepairIds.length > 0) {
        const { data: priorRepairItems, error: priorRepairItemsError } =
          (await this.db
            .from('migration_run_items')
            .select('started_at, finished_at')
            .in('run_id', priorRepairIds)
            .eq('stage', CONFLUENCE_PAGE_REPAIR_STAGE)
            .eq('source_ref', payload.sourceId)
            .eq('status', 'succeeded')) as {
            data:
              | { started_at: string | null; finished_at: string | null }[]
              | null;
            error: { message: string } | null;
          };
        if (priorRepairItemsError)
          throw new MigrationItemError(
            'transient',
            `Failed to verify earlier repair item: ${priorRepairItemsError.message}`,
          );
        priorRepairOwnsPage = (priorRepairItems ?? []).some((prior) =>
          isPriorMigrationRepair(
            page.updated_at,
            prior.started_at,
            prior.finished_at,
          ),
        );
      }
    }
    if (
      Date.parse(page.updated_at) > Date.parse(sourceRun.finished_at) &&
      !priorRepairOwnsPage
    ) {
      await ctx.log(
        'warn',
        'Page repair skipped because the page was edited after the import finished',
        { pageSourceId: payload.sourceId, wikiPageId: payload.targetId },
      );
      return { kind: 'skipped', reason: 'page changed after source import' };
    }
    const { data: targetSpace, error: targetSpaceError } = (await this.db
      .from('spaces')
      .select('key')
      .eq('organization_id', ctx.orgId)
      .eq('id', page.space_id)
      .maybeSingle()) as {
      data: { key: string } | null;
      error: { message: string } | null;
    };
    if (targetSpaceError || !targetSpace?.key)
      throw new MigrationItemError(
        'transient',
        `Failed to resolve repair target space key: ${targetSpaceError?.message ?? 'space missing'}`,
      );

    const { data: childRows, error: childError } = (await this.db
      .from('migration_entity_map')
      .select('target_id, metadata')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('job_id', ctx.job.id)
      .eq('run_id', repairOf)
      .eq('entity_type', PAGE_ENTITY)
      .eq('status', 'mapped')
      .filter('metadata->>parent_source_id', 'eq', payload.sourceId)) as {
      data: { target_id: string; metadata: Record<string, unknown> }[] | null;
      error: { message: string } | null;
    };
    if (childError)
      throw new MigrationItemError(
        'transient',
        `Failed to resolve child pages for repair: ${childError.message}`,
      );
    const childPages = (childRows ?? []).map((child) => ({
      url: `/spaces/${encodeURIComponent(targetSpace.key)}/wiki/${child.target_id}`,
      title:
        typeof child.metadata?.title === 'string'
          ? child.metadata.title
          : 'page',
    }));
    const { data: pageRows, error: pageRowsError } = (await this.db
      .from('migration_entity_map')
      .select('source_id, target_id, metadata')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('job_id', ctx.job.id)
      .eq('run_id', repairOf)
      .eq('entity_type', PAGE_ENTITY)
      .eq('status', 'mapped')) as {
      data:
        | {
            source_id: string;
            target_id: string;
            metadata: Record<string, unknown>;
          }[]
        | null;
      error: { message: string } | null;
    };
    if (pageRowsError)
      throw new MigrationItemError(
        'transient',
        `Failed to resolve include pages for repair: ${pageRowsError.message}`,
      );
    const includePages = buildIncludePageIndex(
      pageRows ?? [],
      (row) => `/wiki/${row.target_id}`,
    );

    const rendered = await this.pageMapper.renderTipTap(
      ctx,
      {
        sourceId: payload.sourceId,
        title: payload.title,
        parentSourceId: null,
        ancestors: [],
        version: 0,
        bodyFormat: payload.bodyFormat,
      },
      {
        childPages,
        includePages,
        currentPageId: payload.targetId,
        targetSpaceId: page.space_id,
        currentSourceSpaceKey: ctx.job.source_ref,
      },
    );
    const repairedContent = rendered.content;
    try {
      await this.wiki.updatePage(
        payload.targetId,
        page.space_id,
        {
          content: repairedContent,
          content_format: 'tiptap',
          expectedUpdatedAt: page.updated_at as string,
        },
        requireActingUser(ctx),
      );
    } catch (error) {
      throw new MigrationItemError(
        'conflict',
        `Page repair could not safely overwrite "${payload.title}": ${(error as Error).message}`,
      );
    }

    // The repair rendered against the completed original crosswalk. Do not schedule the older
    // unguarded relink stage afterward: this run must leave later user edits intact.
    const metadata = {
      ...payload.metadata,
      ...(rendered.excerptContent
        ? { excerpt_content: rendered.excerptContent }
        : {}),
      needs_relink: false,
    };
    const { error: mapError } = await this.db
      .from('migration_entity_map')
      .update({ metadata })
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('job_id', ctx.job.id)
      .eq('run_id', repairOf)
      .eq('entity_type', PAGE_ENTITY)
      .eq('source_id', payload.sourceId);
    if (mapError)
      throw new MigrationItemError(
        'transient',
        `Page repair succeeded but could not record relink state: ${mapError.message}`,
      );

    return {
      kind: 'updated',
      targetId: payload.targetId,
      targetTable: 'wiki_pages',
    };
  }

  private repairOf(ctx: StageContext): string | null {
    const value = ctx.run.config_snapshot?.repair_of_run_id;
    return typeof value === 'string' && value ? value : null;
  }
}
