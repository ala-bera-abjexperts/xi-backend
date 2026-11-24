/**
 * Jira watcher migration. Identity resolution is deliberately read-only: this stage may attach an
 * existing active organization member to an imported task, but it never creates users, auth rows,
 * invitations, placeholders, or memberships.
 */
import { Injectable } from '@nestjs/common';
import { PermissionsService } from '../../../permissions/permissions.service';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedWatcher } from '../../model/normalized';
import { ISSUE_ENTITY } from './issues.stage';
import { runScope } from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type SeedItem,
  type StageContext,
} from './stage.interface';

export const WATCHERS_STAGE = 'watchers';
export const WATCHER_ENTITY = 'watcher';

const TABLE = 'task_watchers';
const PAGE_SIZE = 50;
const MEMBER_LOOKUP_PAGE_SIZE = 500;

interface WatcherPayload {
  issueSourceId: string;
  issueKey: string;
  watcher: NormalizedWatcher;
}

interface UserTarget {
  id: string;
}

@Injectable()
export class WatchersStage implements IStageHandler {
  readonly stage = WATCHERS_STAGE;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'watchers stage: non-Jira source — seeding 0');
      return { items: [], nextCheckpoint: null, done: true };
    }

    const checkpoint = collectionItem.checkpoint ?? {};
    const cursor =
      typeof checkpoint.cursor === 'string' ? checkpoint.cursor : null;
    const iterator = adapter.iterateIssues(ctx.job.source_ref, {
      cursor,
      pageSize: PAGE_SIZE,
      fields: ['summary'],
      ...(runScope(ctx).jql ? { jql: runScope(ctx).jql } : {}),
    });
    const first = await iterator.next();

    if (first.done || !first.value) {
      return { items: [], nextCheckpoint: null, done: true };
    }

    const page = first.value;
    const bySourceRef = new Map<string, SeedItem>();

    for (const issue of page.items) {
      // Errors deliberately propagate. A denied/disabled source endpoint must fail visibly rather
      // than masquerade as a genuine issue with no watchers.
      const result = await adapter.getIssueWatchers(
        issue.key || issue.sourceId,
      );

      for (const watcher of result.watchers) {
        const sourceRef = `${issue.sourceId}:${watcher.sourceId}`;
        bySourceRef.set(sourceRef, {
          entityType: WATCHER_ENTITY,
          sourceRef,
          payload: {
            issueSourceId: issue.sourceId,
            issueKey: issue.key,
            watcher,
          } as unknown as Record<string, unknown>,
        });
      }
    }

    return {
      items: [...bySourceRef.values()],
      nextCheckpoint: page.nextCursor ? { cursor: page.nextCursor } : null,
      done: page.nextCursor === null,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload = item.payload as unknown as WatcherPayload | null;

    if (!payload?.issueSourceId || !payload.watcher?.sourceId) {
      throw new MigrationItemError(
        'permanent',
        'Watcher item is missing its payload snapshot',
      );
    }

    const taskMap = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      ISSUE_ENTITY,
      payload.issueSourceId,
    );

    const taskIsMapped = taskMap?.status === 'mapped' && !!taskMap.target_id;
    const taskIsPlanned =
      ctx.dryRun && taskMap?.status === 'planned' && !!taskMap.target_id;

    if (!taskIsMapped && !taskIsPlanned) {
      return {
        kind: 'blocked',
        waitingFor: {
          entityType: ISSUE_ENTITY,
          sourceId: payload.issueSourceId,
        },
      };
    }

    if (payload.watcher.active === false) {
      return this.skip(ctx, item, payload, 'source watcher is inactive');
    }

    if (payload.watcher.active === null) {
      await ctx.log(
        'warn',
        'watcher source activity is unknown; validating the existing target account',
        {
          sourceRef: item.source_ref,
          issueSourceId: payload.issueSourceId,
          watcherSourceId: payload.watcher.sourceId,
          reason: 'source_activity_unknown',
        },
      );
    }

    const user = await this.resolveExistingUser(ctx, payload.watcher);

    if (!user) {
      return this.skip(
        ctx,
        item,
        payload,
        'watcher did not resolve to one active non-placeholder organization member',
      );
    }

    const task = taskIsMapped
      ? await this.loadTask(ctx, taskMap.target_id)
      : ctx.job.target_space_id
        ? { id: taskMap.target_id, space_id: ctx.job.target_space_id }
        : null;

    if (!task) {
      await ctx.log(
        'warn',
        'watcher skipped: mapped target task is unavailable',
        {
          sourceRef: item.source_ref,
          issueSourceId: payload.issueSourceId,
          targetTaskId: taskMap.target_id,
          reason: 'target_task_missing_or_cross_org',
        },
      );
      return {
        kind: 'blocked',
        waitingFor: {
          entityType: ISSUE_ENTITY,
          sourceId: payload.issueSourceId,
        },
      };
    }

    const access = await this.permissions.getUserSpacePermissions(
      user.id,
      ctx.orgId,
      task.space_id,
    );

    if (!(access.isMember && access.permissions['view_tasks'] === true)) {
      return this.skip(
        ctx,
        item,
        payload,
        'resolved user cannot currently view the target task',
        { userId: user.id, targetTaskId: task.id },
      );
    }

    const sourceRef =
      item.source_ref ?? `${payload.issueSourceId}:${payload.watcher.sourceId}`;

    if (ctx.dryRun) {
      await this.record(
        ctx,
        payload,
        sourceRef,
        `planned:${sourceRef}`,
        'planned',
      );
      return { kind: 'planned' };
    }

    // Subscription first, crosswalk second. If the crosswalk write fails, retrying safely upserts
    // the same pair and repairs a row that an administrator manually removed between runs.
    const { data, error } = (await this.db
      .from(TABLE)
      .upsert(
        {
          organization_id: ctx.orgId,
          task_id: task.id,
          user_id: user.id,
        },
        { onConflict: 'task_id,user_id' },
      )
      .select('id')
      .single()) as {
      data: { id: string } | null;
      error: { message: string } | null;
    };

    if (error || !data?.id) {
      throw new MigrationItemError(
        'transient',
        `Task watcher upsert failed for ${payload.issueKey}: ${error?.message ?? 'no row returned'}`,
      );
    }

    await this.record(ctx, payload, sourceRef, data.id, 'mapped');

    return { kind: 'created', targetId: data.id, targetTable: TABLE };
  }

  private async resolveExistingUser(
    ctx: StageContext,
    watcher: NormalizedWatcher,
  ): Promise<UserTarget | null> {
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

      return (await this.isActiveOrganizationMember(ctx, mapped.target_id))
        ? { id: mapped.target_id }
        : null;
    }

    const email = watcher.email?.trim().toLowerCase();
    if (!email) return null;

    const emailUserId = await this.findExistingUserByExactEmail(ctx, email);
    if (!emailUserId) return null;

    return (await this.isActiveOrganizationMember(ctx, emailUserId))
      ? { id: emailUserId }
      : null;
  }

  /**
   * Do not use ILIKE here: `%` and `_` are valid email characters but wildcard operators in SQL.
   * Page the org roster in bounded reads and compare normalized strings in code. Keeping at most two
   * matches proves uniqueness without retaining an unbounded member list.
   */
  private async findExistingUserByExactEmail(
    ctx: StageContext,
    normalizedEmail: string,
  ): Promise<string | null> {
    const matches = new Set<string>();

    for (let offset = 0; ; offset += MEMBER_LOOKUP_PAGE_SIZE) {
      const { data, error } = (await this.db
        .from('organization_members')
        .select('user_id, users!inner(id, is_active, email)')
        .eq('organization_id', ctx.orgId)
        .eq('users.is_active', true)
        .order('user_id', { ascending: true })
        .range(offset, offset + MEMBER_LOOKUP_PAGE_SIZE - 1)) as {
        data:
          | {
              user_id: string;
              users: {
                id: string;
                is_active: boolean;
                email: string | null;
              } | null;
            }[]
          | null;
        error: { message: string } | null;
      };

      if (error) {
        throw new MigrationItemError(
          'transient',
          `Watcher email lookup failed: ${error.message}`,
        );
      }

      const rows = data ?? [];
      for (const row of rows) {
        if (
          row.users?.is_active === true &&
          row.users.email?.trim().toLowerCase() === normalizedEmail
        ) {
          matches.add(row.user_id);
          if (matches.size > 1) return null;
        }
      }

      if (rows.length < MEMBER_LOOKUP_PAGE_SIZE) break;
    }

    const [only] = [...matches];
    return matches.size === 1 ? only : null;
  }

  private async isActiveOrganizationMember(
    ctx: StageContext,
    userId: string,
  ): Promise<boolean> {
    const { data: user, error: userError } = (await this.db
      .from('users')
      .select('id, is_active')
      .eq('id', userId)
      .eq('is_active', true)
      .maybeSingle()) as {
      data: { id: string; is_active: boolean } | null;
      error: { message: string } | null;
    };

    if (userError) {
      throw new MigrationItemError(
        'transient',
        `Watcher user lookup failed: ${userError.message}`,
      );
    }
    if (!user) return false;

    const { data: member, error: memberError } = (await this.db
      .from('organization_members')
      .select('role')
      .eq('organization_id', ctx.orgId)
      .eq('user_id', userId)
      .maybeSingle()) as {
      data: { role: string } | null;
      error: { message: string } | null;
    };

    if (memberError) {
      throw new MigrationItemError(
        'transient',
        `Watcher membership lookup failed: ${memberError.message}`,
      );
    }

    return member !== null;
  }

  private async loadTask(
    ctx: StageContext,
    taskId: string,
  ): Promise<{ id: string; space_id: string } | null> {
    const { data, error } = (await this.db
      .from('tasks')
      .select('id, space_id')
      .eq('id', taskId)
      .eq('organization_id', ctx.orgId)
      .maybeSingle()) as {
      data: { id: string; space_id: string } | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Watcher target task lookup failed: ${error.message}`,
      );
    }

    return data;
  }

  private async skip(
    ctx: StageContext,
    item: MigrationRunItemRow,
    payload: WatcherPayload,
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<ItemOutcome> {
    await ctx.log('warn', `watcher skipped: ${reason}`, {
      sourceRef: item.source_ref,
      issueSourceId: payload.issueSourceId,
      watcherSourceId: payload.watcher.sourceId,
      watcherEmail: payload.watcher.email,
      reason,
      ...extra,
    });
    return { kind: 'skipped', reason };
  }

  private async record(
    ctx: StageContext,
    payload: WatcherPayload,
    sourceRef: string,
    targetId: string,
    status: 'mapped' | 'planned',
  ): Promise<void> {
    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: WATCHER_ENTITY,
      sourceId: sourceRef,
      sourceKey: payload.issueKey,
      targetTable: TABLE,
      targetId,
      status,
      sourceEmail: payload.watcher.email ?? null,
      metadata: {
        issue_source_id: payload.issueSourceId,
        watcher_source_id: payload.watcher.sourceId,
        watcher_display_name: payload.watcher.displayName,
      },
    });
  }
}
