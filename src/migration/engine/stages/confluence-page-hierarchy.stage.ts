/**
 * @fileoverview `confluence_page_hierarchy` — repair-only stage that restores the page tree of a
 * space imported before folders, blog containers, paged parent reconciliation and sibling order.
 *
 * The producer walks the source exactly like `PagesStage.produce` and seeds the same containers.
 * Containers are created through `PagesStage.processItem` (skipped when already mapped). A page is
 * only ever re-parented and/or given a `sort_order`; content, title and metadata are never written.
 * A page a user has moved since the import is left where the user put it.
 * @module src/migration/engine/stages/confluence-page-hierarchy.stage
 * @author Prince Jadiya
 */

import { Injectable } from '@nestjs/common';
import { fetchAllRows } from '../../../common/utils/fetch-all-rows';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { WikiService } from '../../../wiki/wiki.service';
import { isConfluenceAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedPage } from '../../model/normalized';
import { blogPostPosition } from './page-containers.util';
import { PAGE_ENTITY, PagesStage } from './pages.stage';
import { blockedOnSpace, resolveTargetSpace } from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type SeedItem,
  type StageContext,
} from './stage.interface';

export const CONFLUENCE_PAGE_HIERARCHY_STAGE = 'confluence_page_hierarchy';

/** WikiService rejects a page whose level would exceed this (level = parentLevel + 1). */
const WIKI_MAX_LEVEL = 10;

interface PageRow {
  id: string;
  parent_id: string | null;
  sort_order: number | null;
  level: number | null;
  space_id: string;
  is_archived: boolean | null;
  path: string[] | null;
}

@Injectable()
export class ConfluencePageHierarchyStage implements IStageHandler {
  readonly stage = CONFLUENCE_PAGE_HIERARCHY_STAGE;

  constructor(
    private readonly pagesStage: PagesStage,
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
    if (ctx.dryRun || !this.repairOf(ctx))
      return { items: [], nextCheckpoint: null, done: true };

    const adapter = await ctx.getAdapter();

    if (!isConfluenceAdapter(adapter)) {
      throw new MigrationItemError(
        'permanent',
        'Confluence page hierarchy repair requires a Confluence connection',
      );
    }

    const cursor =
      typeof collectionItem.checkpoint?.cursor === 'string'
        ? collectionItem.checkpoint.cursor
        : null;

    // The path sweep runs on the FIRST call, before this run has seeded anything: `refreshSubtreePaths`
    // re-writes `parent_id` to the value it read, so running it while this stage's own items are
    // re-parenting pages could revert a move. Every move below refreshes its own subtree instead.
    if (cursor === null) await this.sweepPaths(ctx);

    const page = await adapter
      .iteratePages(ctx.job.source_ref, { cursor, pageSize: 200 })
      .next();

    if (page.done || !page.value) {
      return { items: [], nextCheckpoint: null, done: true };
    }

    const { items: pages, nextCursor } = page.value;
    // ponytail: `fetchFolders` skips folders seeded by the `pages` stage only, so folders are
    // re-fetched per batch here (a few GETs per batch); the queue drops the duplicate seeds.
    const containers = await this.pagesStage.seedContainers(
      ctx,
      adapter,
      pages,
    );
    const containerIds = new Set(containers.map((c) => c.sourceId));

    // Gate only on containers seeded in this same batch: they are guaranteed to be queued, so the
    // worker's parent gate opens once they are created. Every other parent is either already mapped
    // by the import or never will be (deleted in Confluence), and gating on it would block forever.
    const seeds: SeedItem[] = [...containers, ...pages].map((p) => ({
      entityType: PAGE_ENTITY,
      sourceRef: p.sourceId,
      parentSourceRef:
        p.parentSourceId && containerIds.has(p.parentSourceId)
          ? p.parentSourceId
          : undefined,
      payload: p as unknown as Record<string, unknown>,
    }));

    await ctx.log(
      'info',
      `page hierarchy: seeded ${pages.length} page(s) and ${containers.length} container(s)`,
    );

    return {
      items: seeds,
      nextCheckpoint: nextCursor == null ? null : { cursor: nextCursor },
      done: nextCursor == null,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const page = item.payload as unknown as NormalizedPage | null;

    if (!page?.sourceId) {
      throw new MigrationItemError(
        'permanent',
        'Page hierarchy item is missing its snapshot',
      );
    }

    if (ctx.dryRun || !this.repairOf(ctx))
      return { kind: 'skipped', reason: 'not a repair run' };

    // Same code path as the import: created once, skipped when the crosswalk already maps it.
    if (page.contentKind === 'folder')
      return this.pagesStage.processItem(ctx, item);

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen || !spaceId) return blockedOnSpace(ctx);

    const lookup = async (sourceId: string) => {
      const row = await ctx.entityMap.getExistingWikiPageTarget(
        ctx.orgId,
        ctx.job.connection_id,
        sourceId,
        spaceId,
      );

      return row?.status === 'mapped' ? row : null;
    };

    const mapped = await lookup(page.sourceId);

    if (!mapped) return { kind: 'skipped', reason: 'page not imported' };

    const current = await this.readPage(ctx, mapped.target_id);

    if (!current || current.space_id !== spaceId || current.is_archived)
      return { kind: 'skipped', reason: 'mapped wiki page no longer exists' };

    let parent: { id: string; level: number; flattened: boolean } | null = null;

    if (page.parentSourceId) {
      const direct = await lookup(page.parentSourceId);

      if (!direct)
        return { kind: 'skipped', reason: 'parent page not imported' };

      if (
        direct.target_id !== current.parent_id &&
        (await this.stillWhereImportPutIt(
          ctx,
          current,
          mapped.metadata,
          lookup,
        ))
      ) {
        parent = await this.chooseParent(ctx, page, current, lookup);
      }
    }

    const patch: { parent_id?: string; sort_order?: number } = {};

    if (parent && parent.id !== current.parent_id) patch.parent_id = parent.id;

    // Same order the importer now writes: blog posts newest-first, pages by source position.
    const position =
      page.contentKind === 'blogpost'
        ? blogPostPosition(page.createdAt)
        : page.position;

    if (!current.sort_order && Number.isInteger(position) && position !== 0)
      patch.sort_order = position;

    if (Object.keys(patch).length === 0)
      return {
        kind: 'skipped',
        reason: 'hierarchy already correct',
        targetId: current.id,
      };

    // Conditional on the parent we read, so a move made in the meantime is never overwritten.
    let update = this.db
      .from('wiki_pages')
      .update(patch)
      .eq('organization_id', ctx.orgId)
      .eq('id', current.id);

    update =
      current.parent_id === null
        ? update.is('parent_id', null)
        : update.eq('parent_id', current.parent_id);

    const { data: updated, error } = (await update.select('id')) as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error)
      throw new MigrationItemError(
        'transient',
        `Page hierarchy update failed: ${error.message}`,
      );

    if (!updated?.length)
      return { kind: 'skipped', reason: 'page changed during repair' };

    if (patch.parent_id && parent) {
      // The path trigger rebuilt only this row; its descendants still carry the old path.
      await this.wiki.refreshSubtreePaths(ctx.orgId, current.id);

      const { error: mapError } = await this.db
        .from('migration_entity_map')
        .update({
          metadata: {
            ...mapped.metadata,
            parent_source_id: page.parentSourceId,
            level: parent.level,
            depth_flattened: parent.flattened,
          },
        })
        .eq('organization_id', ctx.orgId)
        .eq('id', mapped.id);

      if (mapError)
        throw new MigrationItemError(
          'transient',
          `Page re-parented but the crosswalk was not updated: ${mapError.message}`,
        );
    }

    await ctx.log('info', `Repaired hierarchy of wiki page "${page.title}"`, {
      wikiPageId: current.id,
      parentChanged: Boolean(patch.parent_id),
      sortOrderSet: patch.sort_order !== undefined,
    });

    return { kind: 'updated', targetId: current.id, targetTable: 'wiki_pages' };
  }

  /**
   * True when the page sits where the import put it: at the root when the import recorded level 0
   * (the flattened case), or under the crosswalk target of the parent recorded at import. Anything
   * else — including a nested page a user later dragged to the root — is a user's move and is kept.
   */
  private async stillWhereImportPutIt(
    ctx: StageContext,
    current: PageRow,
    metadata: Record<string, unknown>,
    lookup: (sourceId: string) => Promise<{ target_id: string } | null>,
  ): Promise<boolean> {
    if (current.parent_id === null) {
      // Legacy crosswalk rows without a level predate the level metadata: keep treating them as flat.
      if (!(Number(metadata?.level) > 0)) return true;
    } else {
      const recorded = metadata?.parent_source_id;
      const recordedTarget =
        typeof recorded === 'string' && recorded
          ? (await lookup(recorded))?.target_id
          : undefined;

      if (current.parent_id === recordedTarget) return true;
    }

    await ctx.log(
      'info',
      'Page hierarchy left unchanged: the page was moved after the import',
      { wikiPageId: current.id },
    );

    return false;
  }

  /**
   * The parent to attach under: the source parent, or — when the page's subtree would pass level
   * 10 — the deepest source ancestor that still fits (the `PageMapper.resolveParent` fallback). A
   * candidate that is the page itself or one of its descendants is refused. Null = leave as is.
   */
  private async chooseParent(
    ctx: StageContext,
    page: NormalizedPage,
    current: PageRow,
    lookup: (sourceId: string) => Promise<{ target_id: string } | null>,
  ): Promise<{ id: string; level: number; flattened: boolean } | null> {
    // Levels below this page move with it, so the whole subtree must fit.
    const { data: deepest } = (await this.db
      .from('wiki_pages')
      .select('level')
      .eq('organization_id', ctx.orgId)
      .contains('path', [current.id])
      .order('level', { ascending: false })
      .limit(1)) as { data: { level: number | null }[] | null };
    const height = Math.max(
      0,
      (deepest?.[0]?.level ?? current.level ?? 0) - (current.level ?? 0),
    );
    const candidates = [
      page.parentSourceId as string,
      ...[...(page.ancestors ?? [])]
        .reverse()
        .filter((id) => id !== page.parentSourceId),
    ];

    for (const [i, sourceId] of candidates.entries()) {
      const target = await lookup(sourceId);
      const row = target ? await this.readPage(ctx, target.target_id) : null;

      if (!row) continue;

      if (row.id === current.id || (row.path ?? []).includes(current.id)) {
        await ctx.log(
          'warn',
          'Page hierarchy left unchanged: the source parent is this page or one of its descendants',
          { wikiPageId: current.id, parentWikiPageId: row.id },
        );

        return null;
      }

      const level = (row.level ?? 0) + 1;

      if (level + height <= WIKI_MAX_LEVEL)
        return { id: row.id, level, flattened: i > 0 };
    }

    await ctx.log(
      'warn',
      `Page hierarchy left unchanged: no source ancestor keeps the subtree within ${WIKI_MAX_LEVEL} levels`,
      { wikiPageId: current.id },
    );

    return null;
  }

  private async readPage(
    ctx: StageContext,
    id: string,
  ): Promise<PageRow | null> {
    const { data, error } = (await this.db
      .from('wiki_pages')
      .select('id, parent_id, sort_order, level, space_id, is_archived, path')
      .eq('organization_id', ctx.orgId)
      .eq('id', id)
      .maybeSingle()) as {
      data: PageRow | null;
      error: { message: string } | null;
    };

    if (error)
      throw new MigrationItemError(
        'transient',
        `Failed to load wiki page for hierarchy repair: ${error.message}`,
      );

    return data;
  }

  /**
   * Rebuild stale `path`s in the target space. A node is stale when its path is not its parent's
   * path plus its own id; only the shallowest stale node of each chain is refreshed, because
   * `refreshSubtreePaths` rebuilds everything beneath it.
   */
  private async sweepPaths(ctx: StageContext): Promise<void> {
    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen || !spaceId) return;

    const { rows } = await fetchAllRows<
      Pick<PageRow, 'id' | 'parent_id' | 'path'>
    >(
      (from, to) =>
        this.db
          .from('wiki_pages')
          .select('id, parent_id, path')
          .eq('organization_id', ctx.orgId)
          .eq('space_id', spaceId)
          .order('id', { ascending: true })
          .range(from, to),
      Infinity,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const isStale = (r: (typeof rows)[number]) => {
      const parent = r.parent_id ? byId.get(r.parent_id) : null;

      // A parent outside this space cannot be judged from here.
      if (r.parent_id && !parent) return false;

      const expected = [...(parent?.path ?? []), r.id];

      return JSON.stringify(r.path ?? []) !== JSON.stringify(expected);
    };
    const stale = rows.filter(isStale);
    const staleIds = new Set(stale.map((r) => r.id));
    const roots = stale.filter((r) => {
      const seen = new Set([r.id]);

      for (
        let p = r.parent_id ? byId.get(r.parent_id) : undefined;
        p && !seen.has(p.id);
        p = p.parent_id ? byId.get(p.parent_id) : undefined
      ) {
        if (staleIds.has(p.id)) return false;

        seen.add(p.id);
      }

      return true;
    });

    for (const root of roots) {
      // Re-set the root's own parent so the trigger rebuilds it, then its subtree top-down.
      let update = this.db
        .from('wiki_pages')
        .update({ parent_id: root.parent_id })
        .eq('organization_id', ctx.orgId)
        .eq('id', root.id);

      update =
        root.parent_id === null
          ? update.is('parent_id', null)
          : update.eq('parent_id', root.parent_id);

      const { error } = await update;

      if (error)
        throw new MigrationItemError(
          'transient',
          `Page path sweep failed: ${error.message}`,
        );

      await this.wiki.refreshSubtreePaths(ctx.orgId, root.id);
    }

    if (roots.length > 0) {
      await ctx.log(
        'warn',
        `page hierarchy: rebuilt stale paths under ${roots.length} page(s)`,
      );
    }
  }

  private repairOf(ctx: StageContext): string | null {
    const value = ctx.run.config_snapshot?.repair_of_run_id;

    return typeof value === 'string' && value ? value : null;
  }
}
