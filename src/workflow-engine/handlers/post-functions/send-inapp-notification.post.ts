/**
 * @fileoverview Post-function: sends an immediate in-app notification to one or
 * more recipients without queuing an outbox row or sending email. Resolves
 * recipients synchronously, inserts notification rows directly, and broadcasts
 * via NotificationsBroadcastService for real-time delivery. Mirrors the
 * recipient resolution logic of SendNotificationDispatcher but skips the async
 * outbox drain entirely.
 * @module src/workflow-engine/handlers/post-functions/send-inapp-notification.post
 * @author Rajbha Manek
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { z } from 'zod';

import { NotificationsBroadcastService } from '../../../notifications/notifications-broadcast.service';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { PermissionsService } from '../../../permissions/permissions.service';
import { TemplatingService } from '../../templating/expand';
import { buildTokenContext } from './add-comment.post';
import type {
  IPostFunctionHandler,
  IEvaluationContext,
  IRuleReference,
} from '../handler.types';

/** Hard cap on fan-out — matches SendNotificationDispatcher. */
const MAX_FAN_OUT = 500;

/**
 * Canonical UUID shape. `notifications.reference_id` is a `uuid` column, but the
 * cron runtime's execution id is a composite string
 * (`cron:<transitionId>:<taskId>:<iso>`), so we only put execution_id there when
 * it is UUID-shaped and otherwise fall back to the (always-uuid) transition id.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const recipientSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assignee') }),
  z.object({ kind: z.literal('reporter') }),
  z.object({ kind: z.literal('watchers') }),
  z.object({ kind: z.literal('specific_user'), user_id: z.string().uuid() }),
  z.object({ kind: z.literal('specific_group'), group_id: z.string().uuid() }),
  z.object({ kind: z.literal('role'), role_id: z.string().uuid() }),
]);

const cfgSchema = z.object({
  type: z.literal('send_inapp_notification'),
  recipients: z.array(recipientSchema).min(1).max(20),
  title: z.string().min(1).max(200),
  body: z.string().max(2000).optional(),
});

export type SendInAppNotificationConfig = z.infer<typeof cfgSchema>;

type Recipient = SendInAppNotificationConfig['recipients'][number];

@Injectable()
export class SendInAppNotificationPostFunction implements IPostFunctionHandler<SendInAppNotificationConfig> {
  readonly type = 'send_inapp_notification';
  readonly phase = 'post_function' as const;
  readonly schema = cfgSchema;

  private readonly logger = new Logger(SendInAppNotificationPostFunction.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly templating: TemplatingService,
    @Optional() private readonly broadcast?: NotificationsBroadcastService,
    @Optional() private readonly permissionsService?: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async run(
    cfg: SendInAppNotificationConfig,
    ctx: IEvaluationContext,
  ): Promise<void> {
    if (!ctx.taskId) return;

    const tokens = buildTokenContext(ctx);
    const title = this.templating.expand(cfg.title, tokens);
    const body = cfg.body
      ? this.templating.expand(cfg.body, tokens)
      : undefined;

    let userIds = await this.resolveRecipients(ctx, cfg.recipients);
    const explicitWatcherMode = cfg.recipients.some(
      (recipient) => recipient.kind === 'watchers',
    );

    // Fallback: when the configured recipients resolve to nobody (e.g. recipient
    // "assignee" on a task with no assignee), notify the user who triggered the
    // transition so the notification still fires. This only affects the
    // previously-silent zero-recipient case — any resolvable recipient set is
    // left untouched, so working notifications are unchanged.
    if (userIds.length === 0 && ctx.userId && !explicitWatcherMode) {
      userIds = [ctx.userId];
    }

    if (userIds.length === 0) {
      this.logger.warn(
        `send_inapp_notification: resolved zero recipients for task ${ctx.taskId}`,
      );

      return;
    }

    const toInsert = userIds.map((userId) => ({
      organization_id: ctx.organizationId,
      user_id: userId,
      type: 'workflowTransition',
      title,
      body: body ?? null,
      reference_type: 'workflow_execution',
      // execution_id is the idempotency key for this run and fills the uuid
      // reference_id column. The cron runtime's execution id is a composite
      // string (not a uuid), so only use it when UUID-shaped; otherwise fall
      // back to the transition id (always a uuid) so the insert never fails.
      reference_id:
        ctx.execution_id && UUID_RE.test(ctx.execution_id)
          ? ctx.execution_id
          : ctx.transitionId,
    }));

    const { data: rows, error } = (await this.client
      .from('notifications')
      .insert(toInsert)
      .select()) as {
      data: Record<string, unknown>[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new Error(
        `send_inapp_notification insert failed: ${error.message}`,
      );
    }

    for (const row of rows ?? []) {
      void this.broadcast?.broadcastNotification(row);
    }
  }

  findReferences(cfg: SendInAppNotificationConfig): IRuleReference[] {
    const refs: IRuleReference[] = [];

    for (const r of cfg.recipients) {
      switch (r.kind) {
        case 'specific_user':
          refs.push({ kind: 'user', id: r.user_id });
          break;
        case 'specific_group':
          refs.push({ kind: 'group', id: r.group_id });
          break;
        case 'role':
          refs.push({ kind: 'role', id: r.role_id });
          break;
      }
    }

    return refs;
  }

  /**
   * Resolve the rule's recipient definitions to a deduplicated list of user IDs.
   * Uses ctx.task for assignee/reporter (free — already loaded) and falls back
   * to DB lookups for watchers, groups, and roles.
   */
  private async resolveRecipients(
    ctx: IEvaluationContext,
    recipients: Recipient[],
  ): Promise<string[]> {
    const userIds = new Set<string>();

    const pushUser = (id: string | null | undefined) => {
      if (id && !userIds.has(id)) userIds.add(id);
    };

    for (const r of recipients) {
      switch (r.kind) {
        case 'assignee': {
          // ctx.task is pre-loaded by the engine; avoid an extra round-trip.
          const fromCtx = ctx.task?.['assigned_to'] as
            | string
            | null
            | undefined;
          if (fromCtx) {
            pushUser(fromCtx);
          } else if (ctx.taskId) {
            const { data } = await this.client
              .from('tasks')
              .select('assigned_to')
              .eq('id', ctx.taskId)
              .eq('organization_id', ctx.organizationId)
              .maybeSingle();

            pushUser(
              (data as { assigned_to: string | null } | null)?.assigned_to,
            );
          }

          break;
        }

        case 'reporter': {
          const fromCtx =
            (ctx.task?.['reporter'] as string | null | undefined) ??
            (ctx.task?.['created_by'] as string | null | undefined);

          if (fromCtx) {
            pushUser(fromCtx);
          } else if (ctx.taskId) {
            const { data } = await this.client
              .from('tasks')
              .select('reporter, created_by')
              .eq('id', ctx.taskId)
              .eq('organization_id', ctx.organizationId)
              .maybeSingle();

            const row = data as {
              reporter: string | null;
              created_by: string | null;
            } | null;

            pushUser(row?.reporter ?? row?.created_by);
          }

          break;
        }

        case 'watchers': {
          const { data: taskRow, error: taskError } = await this.client
            .from('tasks')
            .select('space_id')
            .eq('id', ctx.taskId!)
            .eq('organization_id', ctx.organizationId)
            .maybeSingle();
          if (taskError || !taskRow) {
            this.logger.warn(
              `task lookup failed while resolving watchers for ${ctx.taskId}`,
            );
            break;
          }
          // task_watchers is best-effort; log + skip on error.
          const { data: watcherRows, error: watcherError } = await this.client
            .from('task_watchers')
            .select('user_id')
            .eq('task_id', ctx.taskId!)
            .eq('organization_id', ctx.organizationId);

          if (watcherError) {
            this.logger.warn(
              `task_watchers lookup failed (${watcherError.message}) — skipping watchers for task ${ctx.taskId}`,
            );
            break;
          }

          const accessible = await this.filterAccessibleWatchers(
            {
              ...ctx,
              spaceId: (taskRow as { space_id: string | null }).space_id,
            },
            (watcherRows ?? []) as Array<{ user_id: string }>,
          );
          for (const userId of accessible) {
            pushUser(userId);
          }

          break;
        }

        case 'specific_user':
          pushUser(r.user_id);
          break;

        case 'specific_group': {
          // Org-scoped join via user_groups!inner to prevent cross-tenant leakage.
          const { data: groupRows, error: groupError } = await this.client
            .from('user_group_members')
            .select('user_id, user_groups!inner(organization_id)')
            .eq('group_id', r.group_id)
            .eq('user_groups.organization_id', ctx.organizationId);

          if (groupError) {
            throw new Error(`Group lookup failed: ${groupError.message}`);
          }

          for (const row of (groupRows ?? []) as Array<{ user_id: string }>) {
            pushUser(row.user_id);
          }

          break;
        }

        case 'role': {
          const { data: roleRows, error: roleError } = await this.client
            .from('user_role_assignments')
            .select('user_id')
            .eq('organization_id', ctx.organizationId)
            .eq('role_id', r.role_id);

          if (roleError) {
            throw new Error(`Role lookup failed: ${roleError.message}`);
          }

          for (const row of (roleRows ?? []) as Array<{ user_id: string }>) {
            pushUser(row.user_id);
          }

          break;
        }
      }

      // Enforce cap early to avoid unnecessary iterations on large groups/roles.
      if (userIds.size >= MAX_FAN_OUT) break;
    }

    return Array.from(userIds).slice(0, MAX_FAN_OUT);
  }

  private async filterAccessibleWatchers(
    ctx: IEvaluationContext,
    rows: Array<{ user_id: string }>,
  ): Promise<string[]> {
    if (!this.permissionsService || rows.length === 0) return [];
    const ids = [...new Set(rows.map((row) => row.user_id))].filter(
      (userId) => userId !== ctx.userId,
    );
    if (!ids.length) return [];
    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id, users!inner(is_active)')
      .eq('organization_id', ctx.organizationId)
      .in('user_id', ids);
    if (error) {
      this.logger.warn(
        `task watcher membership lookup failed (${error.message})`,
      );
      return [];
    }
    const active = (
      (data ?? []) as Array<{
        user_id: string;
        users: { is_active: boolean | null } | { is_active: boolean | null }[];
      }>
    ).filter((row) => {
      const user = Array.isArray(row.users) ? row.users[0] : row.users;
      return ids.includes(row.user_id) && user?.is_active === true;
    });
    const allowed: string[] = [];
    for (const row of active) {
      if (ctx.spaceId) {
        const access = await this.permissionsService.getUserSpacePermissions(
          row.user_id,
          ctx.organizationId,
          ctx.spaceId,
        );
        if (access.isMember && access.permissions['view_tasks'] === true) {
          allowed.push(row.user_id);
        }
      } else {
        const effective =
          await this.permissionsService.getUserEffectivePermissions(
            row.user_id,
            ctx.organizationId,
          );
        if (effective.effective_permissions?.can_view_tasks === true) {
          allowed.push(row.user_id);
        }
      }
    }
    return allowed;
  }
}
