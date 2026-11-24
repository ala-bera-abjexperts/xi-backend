import { ForbiddenException, Injectable } from '@nestjs/common';
import { PermissionsService } from '../../../permissions/permissions.service';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { WikiPermissionsService } from '../../../wiki/wiki-permissions.service';
import { AtlassianRequestError } from '../../adapters/http/atlassian-http-client';
import { isConfluenceAdapter } from '../../adapters/source-adapter.interface';
import { PAGE_ENTITY } from '../../mappers/page.mapper';
import type { NormalizedWatcher } from '../../model/normalized';
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

export const CONFLUENCE_WATCHERS_STAGE = 'confluence_watchers';
export const CONFLUENCE_PAGE_WATCHER_ENTITY = 'confluence_page_watcher';
export const CONFLUENCE_SPACE_WATCHER_ENTITY = 'confluence_space_watcher';

const WATCHER_PAGE_SIZE = 100;

type WatcherSnapshot = NormalizedWatcher;

interface WatcherPayload {
  scope: 'page' | 'space';
  spaceSourceId: string;
  pageSourceId?: string;
  watcher: WatcherSnapshot;
}

interface WatcherCheckpoint {
  scope?: 'page' | 'space';
  pageOffset?: number;
  pageSourceId?: string;
  watcherCursor?: string | null;
  visitedCursors?: string[];
  seenWatcherIds?: string[];
}

@Injectable()
export class ConfluenceWatchersStage implements IStageHandler {
  readonly stage = CONFLUENCE_WATCHERS_STAGE;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
    private readonly wikiPermissions: WikiPermissionsService,
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
        'The Confluence watcher stage requires a Confluence connection',
      );
    }

    const checkpoint = (collectionItem.checkpoint ?? {}) as WatcherCheckpoint;
    const scope = checkpoint.scope ?? 'space';

    if (scope === 'space') {
      try {
        const page = await adapter.getSpaceWatchers(ctx.job.source_ref, {
          cursor: checkpoint.watcherCursor ?? null,
          pageSize: WATCHER_PAGE_SIZE,
        });

        return await this.pageResult(
          ctx,
          checkpoint,
          'space',
          ctx.job.source_ref,
          page,
        );
      } catch (error) {
        if (!this.isReportableReadFailure(error)) throw error;
        await this.reportUnreadable(ctx, 'space', ctx.job.source_ref, error);

        return {
          items: [],
          nextCheckpoint: { scope: 'page', pageOffset: 0 },
          done: false,
        };
      }
    }

    const pageOffset = checkpoint.pageOffset ?? 0;
    const statuses = ctx.dryRun ? ['mapped', 'planned'] : ['mapped'];
    const { data: pages, error } = (await this.db
      .from('migration_entity_map')
      .select('source_id')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('entity_type', PAGE_ENTITY)
      .filter('metadata->>space_ref', 'eq', ctx.job.source_ref)
      .or('metadata->>is_folder.is.null,metadata->>is_folder.neq.true')
      .in('status', statuses)
      .order('created_at', { ascending: true })
      .order('source_id', { ascending: true })
      .range(pageOffset, pageOffset)) as {
      data: { source_id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Failed to enumerate migrated pages for watchers: ${error.message}`,
      );
    }

    const pageSourceId = pages?.[0]?.source_id;
    if (!pageSourceId) return { items: [], nextCheckpoint: null, done: true };

    const sameResource =
      !checkpoint.pageSourceId || checkpoint.pageSourceId === pageSourceId;
    const resourceCheckpoint = sameResource
      ? checkpoint
      : { scope: 'page' as const, pageOffset };

    try {
      const page = await adapter.getPageWatchers(pageSourceId, {
        cursor: resourceCheckpoint.watcherCursor ?? null,
        pageSize: WATCHER_PAGE_SIZE,
      });

      return await this.pageResult(
        ctx,
        resourceCheckpoint,
        'page',
        pageSourceId,
        page,
      );
    } catch (error) {
      if (!this.isReportableReadFailure(error)) throw error;
      await this.reportUnreadable(ctx, 'page', pageSourceId, error);

      return {
        items: [],
        nextCheckpoint: { scope: 'page', pageOffset: pageOffset + 1 },
        done: false,
      };
    }
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload = item.payload as unknown as WatcherPayload | null;

    if (
      !payload?.watcher?.sourceId ||
      (payload.scope !== 'page' && payload.scope !== 'space') ||
      (payload.scope === 'page' && !payload.pageSourceId)
    ) {
      throw new MigrationItemError(
        'permanent',
        'Confluence watcher item is missing its normalized snapshot',
      );
    }

    if (payload.watcher.active === false) {
      return this.skipIdentity(ctx, payload, 'source watcher is inactive');
    }
    if (payload.watcher.active === null) {
      await ctx.log(
        'warn',
        `Confluence ${payload.scope} watcher activity is unknown`,
        {
          watcherSourceId: payload.watcher.sourceId,
          pageSourceId: payload.pageSourceId,
        },
      );
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);
    if (!gateOpen) return blockedOnSpace(ctx);

    const pageTarget =
      payload.scope === 'page'
        ? ctx.dryRun
          ? await ctx.entityMap.getTarget(
              ctx.orgId,
              ctx.job.connection_id,
              PAGE_ENTITY,
              payload.pageSourceId!,
            )
          : await ctx.entityMap.getExistingWikiPageTarget(
              ctx.orgId,
              ctx.job.connection_id,
              payload.pageSourceId!,
              spaceId!,
            )
        : null;

    if (payload.scope === 'page' && !pageTarget?.target_id) {
      return {
        kind: 'blocked',
        waitingFor: {
          entityType: PAGE_ENTITY,
          sourceId: payload.pageSourceId!,
        },
      };
    }

    const userId = await this.resolveExistingActiveMember(ctx, payload.watcher);
    if (!userId)
      return this.skipIdentity(
        ctx,
        payload,
        'no active existing organization member matched',
      );

    if (!spaceId) {
      // A wholly new dry-run space has no physical permission graph. Identity fidelity was still
      // checked above, and no target write is possible or attempted.
      return ctx.dryRun ? { kind: 'planned' } : blockedOnSpace(ctx);
    }

    const access = await this.permissions.getUserSpacePermissions(
      userId,
      ctx.orgId,
      spaceId,
    );
    if (
      !access.isMember ||
      access.permissions.view_wiki_pages !== true ||
      ((access.globalRole === 'admin' || access.globalRole === 'owner') &&
        !(await this.hasExplicitSpaceMembership(ctx.orgId, userId, spaceId)))
    ) {
      return this.skipIdentity(
        ctx,
        payload,
        'matched member cannot view wiki pages',
      );
    }

    const plannedPage =
      payload.scope === 'page' &&
      ctx.dryRun &&
      pageTarget?.status === 'planned';

    if (payload.scope === 'page' && !plannedPage) {
      try {
        await this.wikiPermissions.assertPageAccess(
          pageTarget!.target_id,
          userId,
          spaceId,
          'can_view',
        );
      } catch (error) {
        if (error instanceof ForbiddenException) {
          return this.skipIdentity(
            ctx,
            payload,
            'matched member cannot view the target page',
          );
        }

        throw new MigrationItemError(
          'transient',
          `Failed to verify Confluence watcher page access: ${(error as Error).message}`,
        );
      }
    }

    if (ctx.dryRun) return { kind: 'planned' };

    const relation = {
      organization_id: ctx.orgId,
      space_id: spaceId,
      page_id: payload.scope === 'page' ? pageTarget!.target_id : null,
      scope: payload.scope,
      user_id: userId,
    };
    const { data, error } = (await this.db
      .from('wiki_watches')
      .upsert(relation, { onConflict: 'space_id,page_id,user_id' })
      .select('id')
      .single()) as {
      data: { id: string } | null;
      error: { message: string } | null;
    };

    if (error || !data) {
      throw new MigrationItemError(
        'transient',
        `Failed to upsert Confluence watcher: ${error?.message ?? 'no row returned'}`,
      );
    }

    const entityType =
      payload.scope === 'page'
        ? CONFLUENCE_PAGE_WATCHER_ENTITY
        : CONFLUENCE_SPACE_WATCHER_ENTITY;
    const resourceSourceId = payload.pageSourceId ?? payload.spaceSourceId;

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType,
      sourceId: `${resourceSourceId}:${payload.watcher.sourceId}`,
      sourceKey: payload.watcher.displayName,
      sourceEmail: payload.watcher.email ?? undefined,
      targetTable: 'wiki_watches',
      targetId: data.id,
      status: 'mapped',
      matchMethod: 'source_relation',
      isPlaceholder: false,
      metadata: {
        scope: payload.scope,
        resource_source_id: resourceSourceId,
        user_source_id: payload.watcher.sourceId,
      },
    });

    return { kind: 'created', targetId: data.id, targetTable: 'wiki_watches' };
  }

  private async hasExplicitSpaceMembership(
    organizationId: string,
    userId: string,
    spaceId: string,
  ): Promise<boolean> {
    const { data: direct, error: directError } = await this.db
      .from('space_members')
      .select('id, spaces!inner(organization_id)')
      .eq('space_id', spaceId)
      .eq('spaces.organization_id', organizationId)
      .eq('member_type', 'user')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();

    if (directError) {
      throw new MigrationItemError(
        'transient',
        `Failed to verify Confluence watcher space membership: ${directError.message}`,
      );
    }
    if (direct) return true;

    const [groupResult, roleResult] = await Promise.all([
      this.db
        .from('user_group_members')
        .select(
          'group_id, role_id, group:user_groups(organization_id, is_deleted)',
        )
        .eq('user_id', userId),
      this.db
        .from('user_role_assignments')
        .select('role_id')
        .eq('user_id', userId)
        .eq('organization_id', organizationId),
    ]);

    if (groupResult.error || roleResult.error) {
      throw new MigrationItemError(
        'transient',
        `Failed to verify Confluence watcher indirect membership: ${groupResult.error?.message ?? roleResult.error?.message}`,
      );
    }

    const groupIds = new Set<string>();
    const roleIds = new Set<string>();
    for (const row of (groupResult.data ?? []) as Array<{
      group_id?: string | null;
      role_id?: string | null;
      group?:
        | { organization_id?: string | null; is_deleted?: boolean | null }
        | Array<{
            organization_id?: string | null;
            is_deleted?: boolean | null;
          }>;
    }>) {
      const group = Array.isArray(row.group) ? row.group[0] : row.group;
      if (
        group?.organization_id !== organizationId ||
        group.is_deleted === true
      ) {
        continue;
      }
      if (row.group_id) groupIds.add(row.group_id);
      if (row.role_id) roleIds.add(row.role_id);
    }
    for (const row of (roleResult.data ?? []) as Array<{
      role_id?: string | null;
    }>) {
      if (row.role_id) roleIds.add(row.role_id);
    }

    if (groupIds.size === 0 && roleIds.size === 0) return false;

    const { data: memberships, error: membershipError } = await this.db
      .from('space_members')
      .select('member_type, group_id, role_id, spaces!inner(organization_id)')
      .eq('space_id', spaceId)
      .eq('spaces.organization_id', organizationId)
      .eq('is_active', true);

    if (membershipError) {
      throw new MigrationItemError(
        'transient',
        `Failed to verify Confluence watcher indirect space membership: ${membershipError.message}`,
      );
    }

    return (
      (memberships ?? []) as Array<{
        member_type?: string | null;
        group_id?: string | null;
        role_id?: string | null;
      }>
    ).some(
      (row) =>
        (row.member_type === 'group' &&
          Boolean(row.group_id && groupIds.has(row.group_id))) ||
        (row.member_type === 'role' &&
          Boolean(row.role_id && roleIds.has(row.role_id))),
    );
  }

  private async resolveExistingActiveMember(
    ctx: StageContext,
    watcher: WatcherSnapshot,
  ): Promise<string | null> {
    let userId: string | null = null;
    const sourceIds = [watcher.sourceId];
    const username = watcher.username?.trim();
    if (username && username !== watcher.sourceId) sourceIds.push(username);

    for (const sourceId of sourceIds) {
      const mapped = await ctx.entityMap.getTarget(
        ctx.orgId,
        ctx.job.connection_id,
        'user',
        sourceId,
      );
      if (!mapped) continue;
      if (
        mapped.status !== 'mapped' ||
        mapped.is_placeholder === true ||
        !mapped.target_id
      ) {
        return null;
      }
      userId = mapped.target_id;
      break;
    }

    if (!userId && watcher.email?.trim()) {
      const email = watcher.email
        .trim()
        .toLowerCase()
        .replace(/[%_\\]/g, '\\$&');
      const { data, error } = (await this.db
        .from('organization_members')
        .select('user_id, users!inner(id, is_active, email)')
        .eq('organization_id', ctx.orgId)
        .eq('users.is_active', true)
        .ilike('users.email', email)
        .limit(2)) as {
        data: { user_id: string }[] | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new MigrationItemError(
          'transient',
          `Failed to match watcher email: ${error.message}`,
        );
      }
      if (data?.length === 1) userId = data[0].user_id;
    }

    if (!userId) return null;

    const [
      { data: user, error: userError },
      { data: member, error: memberError },
    ] = await Promise.all([
      this.db
        .from('users')
        .select('id, is_active')
        .eq('id', userId)
        .eq('is_active', true)
        .maybeSingle(),
      this.db
        .from('organization_members')
        .select('user_id')
        .eq('organization_id', ctx.orgId)
        .eq('user_id', userId)
        .maybeSingle(),
    ]);

    if (userError || memberError) {
      throw new MigrationItemError(
        'transient',
        `Failed to validate watcher membership: ${userError?.message ?? memberError?.message}`,
      );
    }

    return user && member ? userId : null;
  }

  private async pageResult(
    ctx: StageContext,
    checkpoint: WatcherCheckpoint,
    scope: 'page' | 'space',
    resourceSourceId: string,
    page: { items: WatcherSnapshot[]; nextCursor: string | null },
  ): Promise<ProduceResult> {
    const visited = new Set(checkpoint.visitedCursors ?? []);
    const requestedCursor = checkpoint.watcherCursor ?? null;
    if (requestedCursor) visited.add(requestedCursor);

    const seen = new Set(checkpoint.seenWatcherIds ?? []);
    const unique = new Map<string, WatcherSnapshot>();
    for (const watcher of page.items) {
      if (!seen.has(watcher.sourceId) && !unique.has(watcher.sourceId)) {
        unique.set(watcher.sourceId, watcher);
      }
    }

    if (unique.size === 0 && page.nextCursor) {
      await ctx.log(
        'warn',
        `Confluence ${scope} watcher pagination made no identity progress`,
        {
          resourceSourceId,
          cursor: page.nextCursor,
        },
      );
      return this.advanceResource(checkpoint, scope);
    }

    const entityType =
      scope === 'page'
        ? CONFLUENCE_PAGE_WATCHER_ENTITY
        : CONFLUENCE_SPACE_WATCHER_ENTITY;
    const items: SeedItem[] = [...unique.values()].map((watcher) => ({
      entityType,
      sourceRef: `${resourceSourceId}:${watcher.sourceId}`,
      payload: {
        scope,
        spaceSourceId: ctx.job.source_ref,
        ...(scope === 'page' ? { pageSourceId: resourceSourceId } : {}),
        watcher,
      } as unknown as Record<string, unknown>,
    }));

    if (page.nextCursor && visited.has(page.nextCursor)) {
      await ctx.log(
        'warn',
        `Confluence ${scope} watcher pagination repeated a cursor`,
        {
          resourceSourceId,
          cursor: page.nextCursor,
        },
      );
      return this.advanceResource(checkpoint, scope, items);
    }

    if (!page.nextCursor) return this.advanceResource(checkpoint, scope, items);

    return {
      items,
      nextCheckpoint: {
        scope,
        ...(scope === 'page'
          ? {
              pageOffset: checkpoint.pageOffset ?? 0,
              pageSourceId: resourceSourceId,
            }
          : {}),
        watcherCursor: page.nextCursor,
        // Only a bounded recent window is needed for short cursor cycles. Stable relationship
        // source refs provide global duplicate idempotency without growing checkpoint JSON forever.
        ...(visited.size ? { visitedCursors: [...visited].slice(-64) } : {}),
        ...(unique.size
          ? { seenWatcherIds: [...unique.keys()].slice(-WATCHER_PAGE_SIZE) }
          : {}),
      },
      done: false,
    };
  }

  private advanceResource(
    checkpoint: WatcherCheckpoint,
    scope: 'page' | 'space',
    items: SeedItem[] = [],
  ): ProduceResult {
    return {
      items,
      nextCheckpoint:
        scope === 'space'
          ? { scope: 'page', pageOffset: 0 }
          : { scope: 'page', pageOffset: (checkpoint.pageOffset ?? 0) + 1 },
      done: false,
    };
  }

  private isReportableReadFailure(error: unknown): boolean {
    return (
      (error instanceof AtlassianRequestError &&
        [401, 403, 404, 422].includes(error.status)) ||
      (error instanceof Error &&
        /watcher.*(?:pagination|identity)|(?:pagination|identity).*watcher/i.test(
          error.message,
        ))
    );
  }

  private async reportUnreadable(
    ctx: StageContext,
    scope: 'page' | 'space',
    sourceId: string,
    error: unknown,
  ): Promise<void> {
    await ctx.log('warn', `Could not read Confluence ${scope} watchers`, {
      sourceId,
      error: (error as Error).message,
      ...(error instanceof AtlassianRequestError
        ? { status: error.status }
        : {}),
    });
  }

  private async skipIdentity(
    ctx: StageContext,
    payload: WatcherPayload,
    reason: string,
  ): Promise<ItemOutcome> {
    await ctx.log('warn', `Skipped Confluence ${payload.scope} watcher`, {
      reason,
      watcherSourceId: payload.watcher.sourceId,
      pageSourceId: payload.pageSourceId,
    });

    return { kind: 'skipped', reason };
  }
}
