/** @fileoverview Dispatcher for queued send_notification outbox rows — resolves recipients, fans out in-app + email. @module src/workflow-outbox/dispatchers/send-notification.dispatcher @author Rajbha Manek */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MailService } from '../../mail/mail.service';
import { NotificationsBroadcastService } from '../../notifications/notifications-broadcast.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TemplatingService } from '../../workflow-engine/templating/expand';
import { PermissionsService } from '../../permissions/permissions.service';

/** Hard cap on fan-out to prevent runaway email blasts. Design Part 5.5. */
const MAX_FAN_OUT = 500;

/** Shape of a single recipient definition from the rule config. */
export type SendNotificationRecipient =
  | { kind: 'assignee' }
  | { kind: 'reporter' }
  | { kind: 'watchers' }
  | { kind: 'specific_user'; user_id: string }
  | { kind: 'specific_group'; group_id: string }
  | { kind: 'role'; role_id: string };

/** Outbox row payload shape for send_notification rules. */
export interface SendNotificationPayload {
  cfg: {
    recipients: SendNotificationRecipient[];
    subject: string;
    body: string;
    attach_task_as_pdf?: boolean;
  };
  context: Record<string, unknown>;
}

/** Internal shape of a resolved recipient before insert. */
interface ResolvedRecipient {
  userId: string;
  email: string | null;
  /** Recipient first name for the email greeting (null when unknown). */
  firstName: string | null;
  /** Recipient locale (`users.language`) for the email shell (null → `en`). */
  locale: string | null;
  recipientKind: SendNotificationRecipient['kind'];
}

/** Result of resolving a rule's recipients plus the task's deep-link keys. */
interface ResolvedRecipients {
  recipients: ResolvedRecipient[];
  /** Task business key (e.g. `PROJ-123`) for the email eyebrow + CTA link. */
  taskKey: string | null;
  /** Task's space id, used to resolve the space key for the CTA link. */
  spaceId: string | null;
}

/**
 * Resolves the rule's recipient list against task/org membership tables and
 * sends both an in-app notification and an email. In-app inserts are
 * idempotent (keyed on the outbox row id) so processor retries do not double
 * up notifications. Email failure is allowed to bubble — the processor will
 * retry the whole row with exponential backoff.
 */
@Injectable()
export class SendNotificationDispatcher {
  private readonly logger = new Logger(SendNotificationDispatcher.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly mailService: MailService,
    private readonly templating: TemplatingService,
    private readonly configService: ConfigService,
    @Optional()
    private readonly broadcastService?: NotificationsBroadcastService,
    @Optional() private readonly permissionsService?: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Dispatch one outbox row. Throws on failure so the processor records
   * `last_error` and either reschedules with backoff or dead-letters after 5
   * attempts.
   */
  async dispatch(row: {
    id: string;
    organization_id: string;
    task_id: string;
    transition_id: string | null;
    payload: SendNotificationPayload;
  }): Promise<void> {
    const { cfg, context } = row.payload;

    if (cfg.attach_task_as_pdf) {
      // Locked decision: backend no-op for v1. Frontend may render a PDF later;
      // for now just log so operators see the request was acknowledged.
      this.logger.warn(
        `attach_task_as_pdf=true ignored for outbox row ${row.id}`,
      );
    }

    const {
      recipients: resolved,
      taskKey,
      spaceId,
    } = await this.resolveRecipients(
      row.organization_id,
      row.task_id,
      cfg.recipients,
      this.actorUserId(context),
    );

    if (resolved.length === 0) {
      this.logger.warn(
        `Outbox row ${row.id} resolved to zero recipients — nothing to send`,
      );

      return;
    }

    // Apply the hard cap. We intentionally truncate rather than throw — the
    // safer behaviour is "deliver to the first N", not "fail the whole row".
    const capped = resolved.slice(0, MAX_FAN_OUT);

    if (capped.length < resolved.length) {
      this.logger.warn(
        `Outbox row ${row.id} fan-out capped at ${MAX_FAN_OUT} (resolved ${resolved.length})`,
      );
    }

    const expandedSubject = this.templating.expand(cfg.subject, context);
    const expandedBody = this.templating.expand(cfg.body, context);

    // ENG-H5: batch idempotency in a single round-trip instead of one
    // SELECT per recipient. The notifications table has no unique constraint
    // covering (user_id, reference_type, reference_id), so we fetch all rows
    // already created for this outbox row and skip those users.
    const { data: existingRows, error: lookupError } = await this.client
      .from('notifications')
      .select('user_id')
      .eq('reference_type', 'workflow_outbox')
      .eq('reference_id', row.id)
      .in(
        'user_id',
        capped.map((r) => r.userId),
      );

    if (lookupError) {
      throw new Error(
        `Notification idempotency lookup failed: ${lookupError.message}`,
      );
    }

    const alreadyNotified = new Set(
      ((existingRows ?? []) as Array<{ user_id: string }>).map(
        (r) => r.user_id,
      ),
    );

    const toInsert = capped
      .filter((r) => !alreadyNotified.has(r.userId))
      .map((recipient) => ({
        organization_id: row.organization_id,
        user_id: recipient.userId,
        type: 'workflowTransition',
        title: expandedSubject,
        body: expandedBody,
        reference_type: 'workflow_outbox',
        reference_id: row.id,
        metadata: {
          task_id: row.task_id,
          transition_id: row.transition_id,
          recipient_kind: recipient.recipientKind,
        },
      }));

    if (toInsert.length > 0) {
      const { data: insertedNotifs, error: insertError } = (await this.client
        .from('notifications')
        .insert(toInsert)
        .select()) as {
        data: Record<string, unknown>[] | null;
        error: { message: string } | null;
      };

      if (insertError) {
        throw new Error(`Notification insert failed: ${insertError.message}`);
      }

      for (const notif of insertedNotifs ?? []) {
        void this.broadcastService?.broadcastNotification(notif);
      }
    }

    // Resolve a deep link to the task so the email CTA button points somewhere
    // useful. Best-effort and resolved once per row (not per recipient): a task
    // without resolvable keys just omits the button rather than failing the row.
    const ctaUrl = await this.resolveTaskCtaUrl(taskKey, spaceId);

    // Honour the recipient's email preference. Batched in one round-trip for
    // the same reason as the idempotency lookup above — fan-out reaches
    // MAX_FAN_OUT, so a per-recipient query would reintroduce that N+1.
    // Only explicit `email: false` rows suppress: a missing row means the user
    // never touched the setting, which defaults to enabled. Fails OPEN on a
    // query error so a transient DB issue can never silently swallow mail.
    const emailable = capped.filter((r) => r.email);
    let emailOptOuts = new Set<string>();

    if (emailable.length > 0) {
      const { data: prefRows, error: prefError } = (await this.client
        .from('notification_preferences')
        .select('user_id, email')
        .eq('organization_id', row.organization_id)
        .eq('notification_type', 'workflowTransition')
        .in(
          'user_id',
          emailable.map((r) => r.userId),
        )) as {
        data: Array<{ user_id: string; email: boolean }> | null;
        error: { message: string } | null;
      };

      if (prefError) {
        this.logger.warn(
          `workflowTransition email-preference lookup failed, defaulting to enabled: ${prefError.message}`,
        );
      } else {
        emailOptOuts = new Set(
          (prefRows ?? [])
            .filter((p) => p.email === false)
            .map((p) => p.user_id),
        );
      }
    }

    // Email is best-effort per recipient but failures re-throw so the
    // processor retries — the batched in-app insert above is idempotent on
    // (reference_id, user_id) so a retry won't double up in-app rows.
    // Rendered through the branded notification template (per-tenant logo/colour
    // + recipient locale + greeting); the subject/body are templated once
    // upstream, so only the email shell varies per recipient.
    for (const recipient of capped) {
      if (recipient.email && !emailOptOuts.has(recipient.userId)) {
        await this.mailService.sendNotification(
          recipient.email,
          {
            title: expandedSubject,
            body: expandedBody,
            subject: expandedSubject,
            recipientName: recipient.firstName ?? undefined,
            eyebrow: taskKey ?? undefined,
            ctaUrl: ctaUrl ?? undefined,
          },
          { organizationId: row.organization_id, locale: recipient.locale },
        );
      }
    }
  }

  /**
   * Builds an absolute deep link to the task
   * (`{appUrl}/spaces/{spaceKey}/tasks/view/{taskKey}`) for the email CTA button.
   * Returns null when the task key or its space key cannot be resolved, so the
   * template simply renders without a button. Never throws — a failed lookup
   * must not fail the whole outbox row.
   */
  private async resolveTaskCtaUrl(
    taskKey: string | null,
    spaceId: string | null,
  ): Promise<string | null> {
    if (!taskKey || !spaceId) return null;

    try {
      const { data: spaceRow, error } = await this.client
        .from('spaces')
        .select('key')
        .eq('id', spaceId)
        .maybeSingle();

      if (error) {
        this.logger.warn(`Space lookup for CTA link failed: ${error.message}`);

        return null;
      }

      const spaceKey = (spaceRow as { key: string | null } | null)?.key;
      if (!spaceKey) return null;

      const appUrl = (
        this.configService.get<string>('appUrl') || 'http://localhost:3000'
      ).replace(/\/+$/, '');

      return `${appUrl}/spaces/${spaceKey}/tasks/view/${taskKey}`;
    } catch (err) {
      this.logger.warn(`CTA link resolution failed: ${(err as Error).message}`);

      return null;
    }
  }

  /**
   * Map the rule's recipient definitions to (userId, email) pairs. Returns
   * unique users — if the same user is reached via multiple recipient kinds
   * the first one wins.
   */
  private async resolveRecipients(
    organizationId: string,
    taskId: string,
    recipients: SendNotificationRecipient[],
    actorUserId: string | null,
  ): Promise<ResolvedRecipients> {
    const userIds = new Set<string>();
    const orderedUsers: Array<{
      userId: string;
      recipientKind: SendNotificationRecipient['kind'];
    }> = [];

    // 1. Load the task once so assignee/reporter/created_by are free lookups.
    //    Also grab key + space_id here so the caller can build the CTA deep link
    //    without a second round-trip to the tasks table.
    const { data: taskRow, error: taskError } = await this.client
      .from('tasks')
      .select('assigned_to, reporter, created_by, key, space_id')
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (taskError) {
      throw new Error(`Task lookup failed: ${taskError.message}`);
    }

    const task = (taskRow ?? {}) as {
      assigned_to: string | null;
      reporter: string | null;
      created_by: string | null;
      key: string | null;
      space_id: string | null;
    };

    const taskKey = task.key ?? null;
    const spaceId = task.space_id ?? null;

    const pushUser = (
      userId: string | null | undefined,
      kind: SendNotificationRecipient['kind'],
    ) => {
      if (!userId || userIds.has(userId)) return;
      userIds.add(userId);
      orderedUsers.push({ userId, recipientKind: kind });
    };

    for (const r of recipients) {
      switch (r.kind) {
        case 'assignee':
          pushUser(task.assigned_to, 'assignee');
          break;
        case 'reporter':
          pushUser(task.reporter ?? task.created_by, 'reporter');
          break;
        case 'watchers': {
          // Watchers table is best-effort: if it does not exist or the lookup
          // errors, log + skip rather than fail the whole row.
          const { data: watcherRows, error: watcherError } = await this.client
            .from('task_watchers')
            .select('user_id')
            .eq('task_id', taskId)
            .eq('organization_id', organizationId);

          if (watcherError) {
            this.logger.warn(
              `task_watchers lookup failed (${watcherError.message}) — skipping watchers for task ${taskId}`,
            );
            break;
          }
          const accessible = await this.filterAccessibleWatchers(
            organizationId,
            spaceId,
            (watcherRows ?? []) as Array<{ user_id: string }>,
            actorUserId,
          );
          for (const userId of accessible) {
            pushUser(userId, 'watchers');
          }
          break;
        }
        case 'specific_user':
          pushUser(r.user_id, 'specific_user');
          break;
        case 'specific_group': {
          // H4 fix — `user_group_members` has no `organization_id` column, so
          // we join through `user_groups!inner` and filter on its org column.
          // A rule that references a group from another tenant returns zero
          // members, preventing cross-org notification leakage.
          const { data: groupRows, error: groupError } = await this.client
            .from('user_group_members')
            .select('user_id, user_groups!inner(organization_id)')
            .eq('group_id', r.group_id)
            .eq('user_groups.organization_id', organizationId);

          if (groupError) {
            throw new Error(`Group lookup failed: ${groupError.message}`);
          }
          for (const row of (groupRows ?? []) as Array<{ user_id: string }>) {
            pushUser(row.user_id, 'specific_group');
          }
          break;
        }
        case 'role': {
          const { data: roleRows, error: roleError } = await this.client
            .from('user_role_assignments')
            .select('user_id')
            .eq('organization_id', organizationId)
            .eq('role_id', r.role_id);

          if (roleError) {
            throw new Error(`Role lookup failed: ${roleError.message}`);
          }
          for (const row of (roleRows ?? []) as Array<{ user_id: string }>) {
            pushUser(row.user_id, 'role');
          }
          break;
        }
      }
    }

    if (orderedUsers.length === 0) return { recipients: [], taskKey, spaceId };

    // Cap the SELECT in case a misconfigured rule produced thousands of users.
    const capped = orderedUsers.slice(0, MAX_FAN_OUT);

    const { data: userRows, error: userError } = await this.client
      .from('users')
      .select('id, email, first_name, language')
      .in(
        'id',
        capped.map((u) => u.userId),
      );

    if (userError) {
      throw new Error(`User email lookup failed: ${userError.message}`);
    }

    const detailsById = new Map<
      string,
      { email: string | null; firstName: string | null; locale: string | null }
    >();
    for (const u of (userRows ?? []) as Array<{
      id: string;
      email: string | null;
      first_name: string | null;
      language: string | null;
    }>) {
      detailsById.set(u.id, {
        email: u.email,
        firstName: u.first_name,
        locale: u.language,
      });
    }

    return {
      recipients: capped.map((u) => {
        const details = detailsById.get(u.userId);

        return {
          userId: u.userId,
          email: details?.email ?? null,
          firstName: details?.firstName ?? null,
          locale: details?.locale ?? null,
          recipientKind: u.recipientKind,
        };
      }),
      taskKey,
      spaceId,
    };
  }

  private async filterAccessibleWatchers(
    organizationId: string,
    spaceId: string | null,
    rows: Array<{ user_id: string }>,
    actorUserId: string | null,
  ): Promise<string[]> {
    if (!this.permissionsService || rows.length === 0) return [];
    const ids = [...new Set(rows.map((row) => row.user_id))].filter(
      (userId) => userId !== actorUserId,
    );
    if (!ids.length) return [];
    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id, users!inner(is_active)')
      .eq('organization_id', organizationId)
      .in('user_id', ids);
    if (error)
      throw new Error(`Watcher membership lookup failed: ${error.message}`);
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
      if (spaceId) {
        const access = await this.permissionsService.getUserSpacePermissions(
          row.user_id,
          organizationId,
          spaceId,
        );
        if (access.isMember && access.permissions['view_tasks'] === true) {
          allowed.push(row.user_id);
        }
      } else {
        const effective =
          await this.permissionsService.getUserEffectivePermissions(
            row.user_id,
            organizationId,
          );
        if (effective.effective_permissions?.can_view_tasks === true) {
          allowed.push(row.user_id);
        }
      }
    }
    return allowed;
  }

  private actorUserId(context: Record<string, unknown>): string | null {
    const user = context['user'];
    if (!user || typeof user !== 'object') return null;
    const actor = (user as Record<string, unknown>)['userId'];
    return typeof actor === 'string' ? actor : null;
  }
}
