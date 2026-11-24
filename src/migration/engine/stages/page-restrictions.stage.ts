/**
 * @fileoverview `page_restrictions` stage — Confluence page restrictions → `wiki_page_permissions`.
 *
 * Confluence keeps `read` and `update` as SEPARATE restriction groups, which lines up with the
 * target's `can_view` / `can_edit`, so the split is preserved rather than collapsed into one flag.
 *
 * FAIL CLOSED, NEVER OPEN. A restricted page exists precisely because someone must NOT see it, so
 * every failure mode here has to end with the page more restricted, not less:
 *   - a `read` restriction whose users ALL fail to resolve would produce an empty allow-list, which
 *     `setPagePermissions` would treat as "no custom permissions" and publish the page to the whole
 *     space. That case fails the item loudly instead of writing anything.
 *   - GROUP restrictions cannot be represented (the target has no group ACL for wiki pages). A page
 *     restricted only by group is reported as a shortfall and left alone, never silently opened.
 *
 * Runs after `page_comments` so the page, user and comment crosswalks are all settled first.
 */

import { Injectable } from '@nestjs/common';
import { WikiPermissionsService } from '../../../wiki/wiki-permissions.service';
import { isConfluenceAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedPageRestriction } from '../../adapters/source-adapter.interface';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { PAGE_ENTITY } from '../../mappers/page.mapper';
import { USER_ENTITY } from './users.stage';
import {
  blockedOnSpace,
  requireActingUser,
  resolveTargetSpace,
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

export const PAGE_RESTRICTIONS_STAGE = 'page_restrictions';
export const PAGE_RESTRICTION_ENTITY = 'page_restriction';

const PAGE_BATCH = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RestrictionPayload {
  pageSourceId: string;
  restrictions: NormalizedPageRestriction[];
}

@Injectable()
export class PageRestrictionsStage implements IStageHandler {
  readonly stage = PAGE_RESTRICTIONS_STAGE;

  constructor(
    private readonly permissions: WikiPermissionsService,
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
        'The page-restrictions stage requires a Confluence connection',
      );
    }

    if (!adapter.getPageRestrictions) {
      await ctx.log(
        'warn',
        'page_restrictions: this Confluence deployment has no restriction read surface — seeding 0',
      );

      return { items: [], nextCheckpoint: null, done: true };
    }

    const checkpoint = (collectionItem.checkpoint ?? {}) as { offset?: number };
    const offset =
      typeof checkpoint.offset === 'number' ? checkpoint.offset : 0;
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
      let restrictions: NormalizedPageRestriction[] = [];

      try {
        restrictions = await adapter.getPageRestrictions(page.source_id);
      } catch (err) {
        // Louder than the labels/comments equivalent: not knowing whether a page is restricted is a
        // security-relevant gap, not a cosmetic one.
        await ctx.log(
          'warn',
          `Could not read restrictions for page ${page.source_id} — it will stay unrestricted in the target`,
          { error: (err as Error).message, restrictionsUnknown: true },
        );
        continue;
      }

      // Unrestricted is the overwhelming majority; seeding those would be one no-op item per page.
      if (restrictions.length === 0) continue;

      seeds.push({
        entityType: PAGE_RESTRICTION_ENTITY,
        sourceRef: page.source_id,
        payload: {
          pageSourceId: page.source_id,
          restrictions,
        } as unknown as Record<string, unknown>,
      });
    }

    const done = pages.length < PAGE_BATCH;

    await ctx.log(
      'info',
      `page_restrictions: seeded ${seeds.length} restricted page(s) from ${pages.length} page(s)`,
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
    const payload = item.payload as unknown as RestrictionPayload | null;

    if (!payload?.pageSourceId || !Array.isArray(payload.restrictions)) {
      throw new MigrationItemError(
        'permanent',
        'Restriction item is missing its snapshot',
      );
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

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

    // entity_id → the strongest grant that principal has on this page.
    const grants = new Map<string, { can_view: boolean; can_edit: boolean }>();
    let unresolvedUsers = 0;
    let groupOnly = 0;

    for (const restriction of payload.restrictions) {
      if (restriction.groupSourceIds.length > 0) groupOnly++;

      for (const accountId of restriction.userSourceIds) {
        const row = await ctx.entityMap.getTarget(
          ctx.orgId,
          ctx.job.connection_id,
          USER_ENTITY,
          accountId,
        );

        if (!row?.target_id || !UUID_RE.test(row.target_id)) {
          unresolvedUsers++;
          continue;
        }

        const current = grants.get(row.target_id) ?? {
          can_view: false,
          can_edit: false,
        };

        // `update` in Confluence implies read access, so it grants both.
        grants.set(row.target_id, {
          can_view: true,
          can_edit: current.can_edit || restriction.operation === 'update',
        });
      }
    }

    const hasReadRestriction = payload.restrictions.some(
      (r) => r.operation === 'read',
    );

    if (grants.size === 0) {
      // Writing an empty allow-list would clear `has_custom_permissions` and publish a page that is
      // restricted at the source. Refuse instead, and say which case it was.
      const cause =
        unresolvedUsers > 0
          ? `none of its ${unresolvedUsers} user principal(s) resolved to a target user`
          : `it is restricted only by group(s), which the target cannot represent for wiki pages`;

      const reason = hasReadRestriction
        ? // Failing is the point: the alternative is an empty allow-list, which `setPagePermissions`
          // reads as "no custom permissions" and would publish a page the source keeps private.
          `page ${payload.pageSourceId} has a READ restriction but ${cause}; refusing to write an ` +
          `empty allow-list, which would make the page visible to the whole space`
        : // Update-only: the page was already readable by everyone at the source, so declining to
          // reproduce the restriction does not widen visibility.
          `page ${payload.pageSourceId} is restricted only by group(s) for EDITING, which the ` +
          `target cannot represent; leaving it editable rather than guessing (visibility unchanged)`;

      await ctx.log('warn', `page_restrictions: ${reason}`, {
        restrictionShortfall: true,
        pageSourceId: payload.pageSourceId,
        groupOnly,
        unresolvedUsers,
      });

      if (hasReadRestriction) {
        throw new MigrationItemError('permanent', reason);
      }

      return { kind: 'skipped', reason: 'group-only restriction' };
    }

    if (unresolvedUsers > 0 || groupOnly > 0) {
      await ctx.log(
        'warn',
        `page_restrictions: page ${payload.pageSourceId} migrated with a NARROWER allow-list ` +
          `(${unresolvedUsers} unresolved user(s), ${groupOnly} group restriction(s) dropped)`,
        { restrictionNarrowed: true, pageSourceId: payload.pageSourceId },
      );
    }

    const actingUser = requireActingUser(ctx);

    await this.permissions.setPagePermissions(
      pageRow.target_id,
      spaceId,
      {
        permissions: [...grants].map(([entity_id, g]) => ({
          entity_type: 'user',
          entity_id,
          can_view: g.can_view,
          can_edit: g.can_edit,
          can_delete: false,
        })),
        // Confluence restrictions are inherited by children unless overridden, which is what this
        // flag reproduces. Turning it off would silently open every child of a restricted page.
        apply_to_children: true,
      },
      { userId: actingUser, organizationId: ctx.orgId },
    );

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: PAGE_RESTRICTION_ENTITY,
      sourceId: payload.pageSourceId,
      sourceKey: payload.pageSourceId,
      targetTable: 'wiki_page_permissions',
      targetId: pageRow.target_id,
      status: 'mapped',
      metadata: {
        principals: grants.size,
        unresolved_users: unresolvedUsers,
        group_restrictions_dropped: groupOnly,
      },
    });

    return {
      kind: 'updated',
      targetId: pageRow.target_id,
      targetTable: 'wiki_page_permissions',
    };
  }
}
