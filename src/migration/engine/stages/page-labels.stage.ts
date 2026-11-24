/**
 * @fileoverview `page_labels` stage — Confluence page labels → `wiki_labels` + `wiki_page_labels`.
 *
 * Seeds ONE item per migrated page (not per label): `setPageLabels` replaces a page's whole label set
 * in a single call, so a per-label item would make several items fight over the same row.
 *
 * The tricky part is scope. A Confluence label is INSTANCE-global — a bare name reused across every
 * space, with its own id — whereas `wiki_labels` is space-scoped with a UUID primary key. So the label
 * is resolved BY NAME within the target space and created on first sight; the source's label ids are
 * deliberately ignored. Measured on the customer's space: 200 page→label rows resolving to exactly 1
 * distinct name (`meeting-notes`), i.e. 199 of the 200 must reuse the same row.
 *
 * Runs after `page_relink` so every page exists and the crosswalk is complete.
 */

import { Injectable } from '@nestjs/common';
import { WikiLabelsService } from '../../../wiki/wiki-labels.service';
import { isConfluenceAdapter } from '../../adapters/source-adapter.interface';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { PAGE_ENTITY } from '../../mappers/page.mapper';
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

export const PAGE_LABELS_STAGE = 'page_labels';
export const PAGE_LABELS_ENTITY = 'page_labels';

/** Pages enumerated per produce() pass — mirrors `page_attachments`. */
const PAGE_BATCH = 50;

/** `SetPageLabelsDto` caps the assignment array at 50. */
const MAX_LABELS_PER_PAGE = 50;

interface LabelsPayload {
  pageSourceId: string;
  labels: string[];
}

@Injectable()
export class PageLabelsStage implements IStageHandler {
  readonly stage = PAGE_LABELS_STAGE;

  constructor(
    private readonly labels: WikiLabelsService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isConfluenceAdapter(adapter)) {
      throw new MigrationItemError(
        'permanent',
        'The page-labels stage requires a Confluence connection',
      );
    }

    const checkpoint = (collectionItem.checkpoint ?? {}) as { offset?: number };
    const offset =
      typeof checkpoint.offset === 'number' ? checkpoint.offset : 0;

    // Scoped to THIS space so a second space migrated on the same connection is never enumerated,
    // and `planned` is included for dry-runs (which never reach `mapped`). Same as page_attachments.
    const pageStatuses = ctx.dryRun ? ['mapped', 'planned'] : ['mapped'];

    const { data: pages, error } = (await this.db
      .from('migration_entity_map')
      .select('source_id')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('entity_type', PAGE_ENTITY)
      .filter('metadata->>space_ref', 'eq', ctx.job.source_ref)
      // Folder containers have no content. `neq` alone would also drop rows WITHOUT the key.
      .or('metadata->>is_folder.is.null,metadata->>is_folder.neq.true')
      .in('status', pageStatuses)
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE_BATCH - 1)) as {
      data: { source_id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Failed to enumerate migrated pages: ${error.message}`,
      );
    }

    if (!pages || pages.length === 0) {
      return { items: [], nextCheckpoint: null, done: true };
    }

    const seeds: SeedItem[] = [];

    for (const page of pages) {
      let labels: string[] = [];

      try {
        labels = await adapter.getPageLabels(page.source_id);
      } catch (err) {
        // A label read must never cost us the page — it already migrated.
        await ctx.log(
          'warn',
          `Could not list labels for page ${page.source_id}`,
          {
            error: (err as Error).message,
          },
        );
        continue;
      }

      // Unlabelled pages are the common case; seeding them would be one no-op item per page.
      if (labels.length === 0) continue;

      seeds.push({
        entityType: PAGE_LABELS_ENTITY,
        sourceRef: page.source_id,
        payload: {
          pageSourceId: page.source_id,
          labels,
        } as unknown as Record<string, unknown>,
      });
    }

    const done = pages.length < PAGE_BATCH;

    await ctx.log(
      'info',
      `page_labels: seeded ${seeds.length} labelled page(s) from ${pages.length} page(s)`,
      { count: seeds.length },
    );

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
    const payload = item.payload as unknown as LabelsPayload | null;

    if (!payload?.pageSourceId || !Array.isArray(payload.labels)) {
      throw new MigrationItemError(
        'permanent',
        'Page-labels item is missing its snapshot',
      );
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    // A dry run gates OPEN with a null `spaceId` (the space is only `planned`), so the dry-run check
    // has to come before the id is required — testing `!spaceId` first reports every item as blocked
    // and the plan would show zero labels.
    if (!gateOpen) return blockedOnSpace(ctx);

    const pageRow = ctx.dryRun
      ? await ctx.entityMap.getTarget(
          ctx.orgId,
          ctx.job.connection_id,
          PAGE_ENTITY,
          payload.pageSourceId,
        )
      : await ctx.entityMap.getExistingWikiPageTarget(
          ctx.orgId,
          ctx.job.connection_id,
          payload.pageSourceId,
          spaceId!,
        );

    if (!pageRow?.target_id) {
      return {
        kind: 'blocked',
        waitingFor: {
          entityType: PAGE_ENTITY,
          sourceId: payload.pageSourceId,
        },
      };
    }

    if (ctx.dryRun) return { kind: 'planned' };

    if (!spaceId) return blockedOnSpace(ctx);

    const labelIds: string[] = [];

    for (const name of payload.labels.slice(0, MAX_LABELS_PER_PAGE)) {
      const id = await this.resolveLabelId(spaceId, name);

      if (id) labelIds.push(id);
    }

    if (labelIds.length === 0) {
      return { kind: 'skipped', reason: 'no label resolved' };
    }

    await this.labels.setPageLabels(pageRow.target_id, spaceId, {
      // De-duplicated: Confluence can list the same name twice via different label ids, and
      // `wiki_page_labels` has a unique (page, label) constraint.
      label_ids: [...new Set(labelIds)],
    });

    return {
      kind: 'updated',
      targetId: pageRow.target_id,
      targetTable: 'wiki_page_labels',
    };
  }

  /**
   * Space-scoped label id for `name`, creating the label on first sight.
   *
   * Read-then-create races between concurrent workers on the same new name, so a failed insert
   * re-reads rather than failing the item: by then the other worker has committed the row.
   */
  private async resolveLabelId(
    spaceId: string,
    name: string,
  ): Promise<string | null> {
    const trimmed = name.trim().slice(0, 100);

    if (!trimmed) return null;

    const existing = await this.findLabelId(spaceId, trimmed);

    if (existing) return existing;

    try {
      const created = (await this.labels.createLabel(spaceId, {
        name: trimmed,
      })) as { id?: string };

      if (created?.id) return created.id;
    } catch {
      // Fall through to the re-read below.
    }

    return this.findLabelId(spaceId, trimmed);
  }

  private async findLabelId(
    spaceId: string,
    name: string,
  ): Promise<string | null> {
    const { data } = (await this.db
      .from('wiki_labels')
      .select('id')
      .eq('space_id', spaceId)
      .eq('name', name)
      .maybeSingle()) as { data: { id: string } | null };

    return data?.id ?? null;
  }
}
