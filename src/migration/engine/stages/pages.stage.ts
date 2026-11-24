/**
 * @fileoverview `pages` stage — the Confluence wiki tree.
 *
 * The producer pages `iteratePages` ONE batch per tick (cursor persisted in the collection item's
 * checkpoint → crash-safe resume), seeding one item per page with `parentSourceRef = ancestor`
 * (null for the homepage/top-level → wiki root). The worker's generic same-entity-type parent gate
 * keeps parents strictly before children (`blocked` until the parent lands — never a dangling
 * `parent_id`). `processItem` also gates on the target space, then delegates to `PageMapper`.
 */

import { Injectable } from '@nestjs/common';
import type { ConfluenceCloudAdapter } from '../../adapters/confluence/confluence-cloud.adapter';
import {
  isConfluenceAdapter,
  type IConfluenceSourceAdapter,
} from '../../adapters/source-adapter.interface';
import type { NormalizedPage } from '../../model/normalized';
import { PageMapper } from '../../mappers/page.mapper';
import {
  TipTapValidationError,
  validateTipTapDoc,
} from '../../../common/utils/tiptap-sanitizer';
import { fetchAllRows } from '../../../common/utils/fetch-all-rows';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import {
  blogContainerIds,
  buildBlogContainerPages,
} from './page-containers.util';
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

export const PAGES_STAGE = 'pages';
export const PAGE_ENTITY = 'page';

@Injectable()
export class PagesStage implements IStageHandler {
  readonly stage = PAGES_STAGE;

  constructor(
    private readonly pageMapper: PageMapper,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** One list batch per tick; the adapter's `_links.next` cursor resumes on the next call. */
  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isConfluenceAdapter(adapter)) {
      throw new MigrationItemError(
        'permanent',
        'The pages stage requires a Confluence connection',
      );
    }

    const checkpoint = (collectionItem.checkpoint ?? {}) as {
      cursor?: string | null;
      seeded?: number;
    };
    const cursor =
      typeof checkpoint.cursor === 'string' ? checkpoint.cursor : null;
    const seededSoFar =
      typeof checkpoint.seeded === 'number' ? checkpoint.seeded : 0;

    // 200 = the list endpoint's max batch. Each `produce()` call is one ~2s work pass, so the batch
    // size IS the seeding rate: at 50 a 10,383-page space needs 208 passes, at 200 it needs 52.
    const page = await adapter
      .iteratePages(ctx.job.source_ref, { cursor, pageSize: 200 })
      .next();

    if (page.done || !page.value) {
      return { items: [], nextCheckpoint: null, done: true };
    }

    // The whole space always migrates: there is no page cap.
    const { items: batch, nextCursor } = page.value;

    // Containers go FIRST so every parent precedes its children in the same insert. Re-seeding one
    // from an earlier batch is harmless: the queue drops refs the run already holds.
    const containers = await this.seedContainers(ctx, adapter, batch);

    const seeds: SeedItem[] = [...containers, ...batch].map((p) => ({
      entityType: PAGE_ENTITY,
      sourceRef: p.sourceId,
      parentSourceRef: p.parentSourceId ?? undefined,
      payload: p as unknown as Record<string, unknown>,
    }));

    // Containers are structure, not content, so the running page total counts real pages only.
    const newSeeded = seededSoFar + batch.length;
    const done = nextCursor == null;

    await ctx.log(
      'info',
      `pages: seeded ${batch.length} page(s)` +
        (containers.length ? ` and ${containers.length} container(s)` : ''),
      {
        count: batch.length,
        containers: containers.length,
        total: newSeeded,
        more: !done,
      },
    );

    // Seeding is finished, so the full page set is now known — reconcile parents that will never
    // arrive. `seeds` is passed in because the engine inserts it only AFTER this method returns, so
    // these rows are not yet queryable. See `detachUnreachableParents` for why this is not optional.
    if (done) await this.detachUnreachableParents(ctx, seeds);

    return {
      items: seeds,
      nextCheckpoint: done ? null : { cursor: nextCursor, seeded: newSeeded },
      done,
    };
  }

  /**
   * Every container `batch` needs (Cloud folders, then Blog → year → month), parents first. Blog
   * posts are not in the page tree, so each post in `batch` is re-pointed at its month container
   * IN PLACE. Shared with the `confluence_page_hierarchy` repair, which must seed the same tree.
   */
  async seedContainers(
    ctx: StageContext,
    adapter: IConfluenceSourceAdapter,
    batch: NormalizedPage[],
  ): Promise<NormalizedPage[]> {
    const posts = batch.filter((p) => p.contentKind === 'blogpost');

    for (const post of posts) {
      const ids = blogContainerIds(ctx.job.source_ref, post.createdAt);

      post.ancestors = [ids.root, ids.year, ids.month].filter(
        (id): id is string => Boolean(id),
      );
      post.parentSourceId = post.ancestors[post.ancestors.length - 1];
    }

    return [
      ...(await this.fetchFolders(ctx, adapter, batch)),
      ...buildBlogContainerPages(ctx.job.source_ref, posts),
    ];
  }

  /**
   * The Cloud v2 folders this batch's pages sit under, each parent folder before its children.
   *
   * `iteratePages` lists pages only, so a page whose `parentType` is `folder` points at an id that
   * is never seeded: measured on space AS, 377 pages sat in 12 folders and `detachUnreachableParents`
   * hoisted every one of their subtrees to the wiki root. Folders nest in folders, so the chain is
   * walked up until it reaches a page, the root, or a folder this run already seeded. A deleted
   * folder (404) is simply not seeded, and its pages are detached at the end like any dangling
   * parent. Server/DC has no folders and no `getFolder`, so this is a no-op there.
   */
  private async fetchFolders(
    ctx: StageContext,
    adapter: IConfluenceSourceAdapter,
    batch: NormalizedPage[],
  ): Promise<NormalizedPage[]> {
    const { getFolder } = adapter as Partial<
      Pick<ConfluenceCloudAdapter, 'getFolder'>
    >;
    const wanted = new Set(
      batch
        .filter((p) => p.parentType === 'folder' && p.parentSourceId)
        .map((p) => p.parentSourceId as string),
    );

    if (typeof getFolder !== 'function' || wanted.size === 0) return [];

    // Folders seeded by earlier batches — never re-fetched.
    const { rows } = await fetchAllRows<{ source_ref: string }>(
      (from, to) =>
        this.db
          .from('migration_run_items')
          .select('source_ref')
          .eq('organization_id', ctx.orgId)
          .eq('run_id', ctx.run.id)
          .eq('stage', PAGES_STAGE)
          .eq('item_kind', 'entity')
          .filter('payload->>contentKind', 'eq', 'folder')
          .order('id', { ascending: true })
          .range(from, to),
      Infinity,
    );
    const known = new Set(rows.map((r) => r.source_ref));
    const folders: NormalizedPage[] = [];

    const visit = async (id: string): Promise<void> => {
      if (known.has(id)) return;

      // Marked before the fetch, so a cyclic or repeated reference is fetched once.
      known.add(id);

      const folder = await getFolder.call(adapter, id);

      if (!folder) return;

      if (folder.parentType === 'folder' && folder.parentSourceId) {
        await visit(folder.parentSourceId);
      }

      folders.push(folder);
    };

    for (const id of wanted) await visit(id);

    return folders;
  }

  /**
   * Re-point pages whose parent is not in the migrated set at the space root.
   *
   * Confluence `parentId` can be a DANGLING reference: measured on a live 339-page space, three
   * parent ids returned HTTP 404 (the pages had been deleted) yet 335 descendants still pointed at
   * them transitively. Because the worker gates each item on `parent_source_ref`, those children
   * blocked forever, the tick's deadlock guard then failed them as orphans, and the cascade wiped
   * 99% of the space — while the run reported only `partially_completed`. Confluence itself shows
   * such pages at the space root, so that is what we do.
   *
   * Runs once, after the last batch is seeded, when the complete set is knowable.
   *
   * `pendingSeeds` is the final batch, which `produce` has built but the engine has not inserted yet
   * — it is invisible to the query below. Both halves of that matter: its ids must count as reachable
   * (or a page whose parent sits in the last batch would be needlessly moved to the root), and its
   * own rows must be reconciled here, in memory, because nothing revisits them afterwards. Measured:
   * with the last batch ignored, 11 pages kept a dangling `parent_source_ref`, blocked, and took a
   * further 24 descendants down with them.
   *
   * The read MUST page. PostgREST caps a response at 1000 rows, and an unpaged read of a 1,480-page
   * space (release 1.2.18) saw only 1000: 52 parents looked unreachable when 40 of them were real
   * imported pages, 597 pages were hoisted to the wiki root, and 138 cascade victims beyond the cap
   * were never requeued and never created. Folder and blog containers are ordinary rows/seeds here,
   * so they count as reachable like any page.
   */
  private async detachUnreachableParents(
    ctx: StageContext,
    pendingSeeds: SeedItem[] = [],
  ): Promise<void> {
    type Row = {
      id: string;
      source_ref: string | null;
      parent_source_ref: string | null;
      status: string;
      checkpoint: Record<string, unknown> | null;
      error_message: string | null;
    };
    let all: Row[];

    try {
      // No row ceiling: every seeded item must be visible, however large the space.
      const { rows } = await fetchAllRows<Row>(
        (from, to) =>
          this.db
            .from('migration_run_items')
            .select(
              'id, source_ref, parent_source_ref, status, checkpoint, error_message',
            )
            .eq('organization_id', ctx.orgId)
            .eq('run_id', ctx.run.id)
            .eq('stage', PAGES_STAGE)
            .eq('item_kind', 'entity')
            .order('id', { ascending: true })
            .range(from, to),
        Infinity,
      );

      all = rows;
    } catch (err) {
      // Non-fatal: without the reconcile the run degrades to the old behaviour, so log and move on.
      await ctx.log(
        'warn',
        `pages: could not reconcile unreachable parents: ${(err as Error).message}`,
      );

      return;
    }
    const seeded = new Set(
      [
        ...all.map((r) => r.source_ref),
        ...pendingSeeds.map((s) => s.sourceRef),
      ].filter(Boolean),
    );

    /** Its parent will never arrive → the page belongs at the space root. */
    const unreachable = all.filter(
      (r) => r.parent_source_ref && !seeded.has(r.parent_source_ref),
    );

    // Same test against the not-yet-inserted batch. Clearing the ref here means the row is inserted
    // already detached, so it never blocks and the deadlock guard never sees it.
    const pendingUnreachable = pendingSeeds.filter(
      (s) => s.parentSourceRef && !seeded.has(s.parentSourceRef),
    );
    // Read the refs out before clearing them, or the log below reports `undefined`.
    const pendingMissingParents = pendingUnreachable.map(
      (s) => s.parentSourceRef as string,
    );

    for (const seed of pendingUnreachable) seed.parentSourceRef = undefined;

    /**
     * Cascade victims. The tick's deadlock guard fails a blocked item the moment its dependency dies,
     * so an entire subtree beneath an unreachable ancestor can already be `failed` — and `failed` is
     * terminal. These keep their (legitimate, reachable) parent and are simply returned to the queue;
     * once the ancestor lands at the root, the whole subtree drains in dependency order.
     *
     * Retrying is safe: the page write is idempotent, since `processItem` checks the crosswalk first
     * and adopts an existing page instead of creating a duplicate.
     */
    const cascade = all.filter(
      (r) =>
        (r.status === 'failed' || r.status === 'blocked') &&
        /^(Dependency|Waiting for)\b/.test(
          String((r as { error_message?: string }).error_message ?? ''),
        ) &&
        !unreachable.includes(r),
    );

    if (
      unreachable.length === 0 &&
      cascade.length === 0 &&
      pendingUnreachable.length === 0
    )
      return;

    const revive = (row: (typeof all)[number], detach: boolean) => {
      const checkpoint = { ...(row.checkpoint ?? {}) };

      // `blockItem` records the dependency in `checkpoint.waiting_*`, and BOTH `unblockReadyItems`
      // and the tick's orphan guard read it from there — not from `parent_source_ref`. Leaving these
      // keys behind means the guard re-fails the item on the very next tick.
      delete checkpoint.waiting_entity_type;
      delete checkpoint.waiting_source_id;

      return this.db
        .from('migration_run_items')
        .update({
          ...(detach ? { parent_source_ref: null } : {}),
          checkpoint,
          status: 'pending',
          error_class: null,
          error_message: null,
          lease_until: null,
          worker_id: null,
        })
        .eq('organization_id', ctx.orgId)
        .eq('id', row.id);
    };

    for (const row of unreachable) await revive(row, true);
    for (const row of cascade) await revive(row, false);

    const detached = unreachable.length + pendingUnreachable.length;

    if (detached > 0) {
      const missingParents = [
        ...new Set([
          ...unreachable.map((o) => o.parent_source_ref as string),
          ...pendingMissingParents,
        ]),
      ];

      await ctx.log(
        'warn',
        `pages: ${detached} page(s) reference ${missingParents.length} parent(s) that are ` +
          `not in the migrated set (deleted in the source) — attaching ` +
          `them at the space root instead of failing them`,
        { missingParents: missingParents.slice(0, 20) },
      );
    }

    if (cascade.length > 0) {
      await ctx.log(
        'warn',
        `pages: requeued ${cascade.length} page(s) that had been failed only because an ancestor ` +
          `was unreachable — they now migrate under their real parent`,
      );
    }
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const page = item.payload as unknown as NormalizedPage | null;

    if (!page?.sourceId) {
      throw new MigrationItemError(
        'permanent',
        'Page item is missing its snapshot',
      );
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen) return blockedOnSpace(ctx);

    const mapped = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      PAGE_ENTITY,
      page.sourceId,
    );
    const existing = ctx.dryRun
      ? mapped
      : await ctx.entityMap.getExistingWikiPageTarget(
          ctx.orgId,
          ctx.job.connection_id,
          page.sourceId,
          spaceId!,
        );

    if (mapped?.status === 'mapped' && !existing && mapped.target_id) {
      await ctx.entityMap.deleteExactStaleMapping(
        ctx.orgId,
        ctx.job.connection_id,
        PAGE_ENTITY,
        page.sourceId,
        mapped.target_id,
      );
    }

    if (existing) {
      if (existing.status === 'mapped') {
        return {
          kind: 'skipped',
          reason: 'page already migrated',
          targetId: existing.target_id,
        };
      }

      if (existing.status === 'planned' && ctx.dryRun) {
        return {
          kind: 'skipped',
          reason: 'already planned',
          targetId: existing.target_id,
        };
      }
    }

    /** Folder / Blog / year / month: no body, nothing to adopt, never content for later stages. */
    const isContainer = page.contentKind === 'folder';

    if (ctx.dryRun) {
      // Render and validate the real body, so a dry run answers the question it
      // is actually asked: "will this migrate?". Skipping the conversion made a
      // dry run pass on a space where every page was about to be refused by the
      // write gate. This costs one `getPageBody` per page — a dry run for a
      // CONTENT migration that never reads the content is not worth running.
      if (!isContainer) await this.validateContentOnly(ctx, page);

      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: PAGE_ENTITY,
        sourceId: page.sourceId,
        sourceKey: page.title,
        targetTable: 'wiki_pages',
        targetId: `planned:${page.sourceId}`,
        status: 'planned',
        // Approximate depth from the source ancestry so the dry-run tree gates correctly.
        // `space_ref` scopes the page to THIS space so the attachments producer never
        // enumerates pages from another space migrated on the same connection.
        metadata: {
          title: page.title,
          level: page.ancestors.length,
          space_ref: ctx.job.source_ref,
          ...(isContainer ? { is_folder: true } : {}),
        },
      });

      return { kind: 'planned' };
    }

    // Only a RETRY can have an orphan from an earlier attempt of this same item, so first attempts
    // (the overwhelming majority) skip the lookup entirely and pay nothing. Containers never adopt:
    // "Blog", "2024" and "November" are exactly the titles a human page may already carry.
    const adopted =
      item.retry_count > 0 && !isContainer
        ? await this.adoptOrphanedPage(ctx, page, spaceId!)
        : null;
    const result =
      adopted ??
      (isContainer
        ? await this.pageMapper.createContainer(ctx, page, spaceId!)
        : await this.pageMapper.createPage(ctx, page, spaceId!));

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: PAGE_ENTITY,
      sourceId: page.sourceId,
      sourceKey: page.title,
      targetTable: 'wiki_pages',
      targetId: result.targetId,
      status: 'mapped',
      metadata: {
        title: page.title,
        level: result.level,
        space_ref: ctx.job.source_ref,
        // `is_folder` is what the downstream content stages filter containers out on.
        ...(isContainer
          ? { is_folder: true }
          : {
              depth_flattened: result.depthFlattened,
              body_format: page.bodyFormat,
            }),
        ...(result.excerptContent
          ? { excerpt_content: result.excerptContent }
          : {}),
        // CF-B: flag pages with unresolved cross-page macros for the `page_relink` re-render pass.
        needs_relink: result.needsRelink,
        // Parent id lets the relink pass resolve `children` macros (list of child pages).
        parent_source_id: page.parentSourceId ?? null,
      },
    });

    await ctx.log(
      'info',
      `Created wiki ${isContainer ? 'folder' : 'page'} "${page.title}" (level ${result.level})`,
      {
        wikiPageId: result.targetId,
      },
    );

    return {
      kind: 'created',
      targetId: result.targetId,
      targetTable: 'wiki_pages',
    };
  }

  /**
   * Dry-run content check: render the page exactly as a live run would and put
   * the result through the SAME write gate, without creating anything.
   *
   * Uses `validateTipTapDoc` directly rather than a dry-run-specific copy — a
   * second, looser check would drift and defeat the purpose. A failure here is
   * `permanent` by construction: the document is deterministically invalid, so
   * retrying it only burns attempts.
   */
  private async validateContentOnly(
    ctx: StageContext,
    page: NormalizedPage,
  ): Promise<void> {
    const rendered = await this.pageMapper.renderTipTap(ctx, page);

    try {
      validateTipTapDoc(rendered.content);
    } catch (err) {
      if (err instanceof TipTapValidationError) {
        throw new MigrationItemError(
          'permanent',
          `Would fail on live run — "${page.title}" (${page.sourceId}): ${
            (err as Error).message
          }`,
        );
      }

      throw err;
    }
  }

  /**
   * Recover the page a FAILED PREVIOUS ATTEMPT already created, so a retry maps it instead of
   * inserting a duplicate.
   *
   * `createPage` inserts the wiki row and `recordMapping` writes the crosswalk as a SEPARATE call.
   * Anything landing between them — a watch-mode restart, a lost lease, a transient DB error —
   * leaves a real page with NO crosswalk row. The retry's crosswalk check then finds nothing and
   * inserts a second copy, orphaning the first. Observed live: 2 of 10,383 pages in the full M0 run
   * came out duplicated this way (`retry_count = 1` on both), each orphan a childless twin of the
   * mapped page.
   *
   * Confluence enforces unique page titles WITHIN a space, and the migration writes the source
   * title verbatim, so `(space_id, title)` identifies the source page in the target space. Adoption
   * is deliberately narrow: only an UNMAPPED row qualifies (a mapped one is a different source
   * page's page), and only when exactly one matches — anything ambiguous falls through to a normal
   * insert rather than guessing. It is logged, because silently adopting a row a human created
   * would be worse than a visible duplicate.
   *
   * This only ever runs where the code previously created a duplicate, so its worst case is the
   * behaviour we already had.
   */
  private async adoptOrphanedPage(
    ctx: StageContext,
    page: NormalizedPage,
    spaceId: string,
  ): Promise<{
    targetId: string;
    level: number;
    depthFlattened: boolean;
    needsRelink: boolean;
    excerptContent: string | null;
  } | null> {
    const title = page.title || 'Untitled';

    const { data, error } = (await this.db
      .from('wiki_pages')
      .select('id, level')
      .eq('space_id', spaceId)
      .eq('organization_id', ctx.orgId)
      .eq('title', title)
      .limit(2)) as {
      data: { id: string; level: number | null }[] | null;
      error: { message: string } | null;
    };

    // A lookup failure must not fail the item — fall through and insert as before.
    if (error || !data || data.length !== 1) return null;

    const candidate = data[0];

    // Claimed by ANY source page (this one or another) → not an orphan. `processItem` already
    // proved this source page has no mapping, so any claim here belongs to a different page.
    const { data: claimed } = (await this.db
      .from('migration_entity_map')
      .select('id')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('entity_type', PAGE_ENTITY)
      .eq('target_id', candidate.id)
      .limit(1)) as { data: { id: string }[] | null };

    if (claimed && claimed.length > 0) return null;

    await ctx.log(
      'warn',
      `Adopted an unmapped wiki page titled "${title}" left by a previous attempt — ` +
        `mapping it instead of creating a duplicate`,
      { wikiPageId: candidate.id, pageSourceId: page.sourceId },
    );

    // The prior attempt's `createPage` ran to completion, so content/parent are already correct;
    // re-render is the `page_relink` stage's job and is driven by `needs_relink` below.
    return {
      targetId: candidate.id,
      level: candidate.level ?? 0,
      depthFlattened: false,
      needsRelink: true,
      excerptContent: null,
    };
  }
}
