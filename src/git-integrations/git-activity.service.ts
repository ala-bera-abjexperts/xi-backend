/**
 * @fileoverview Ticket 9: activity history and notifications for development events. A live webhook's state change
 * (git-pull-requests.service) becomes an {@link IGitActivity}; for each of its tasks a History row is written and,
 * for the events people are told about, a notification goes to the assignee, the watchers and (failed builds) the
 * pull request's author, following each person's preferences ("Development (GitHub, GitLab)"):
 *
 * - never to the person who caused it, to someone who cannot see the task or muted it, nor once the repository is
 *   disconnected, disabled or removed;
 * - bursts are combined: within {@link COALESCE_MS} the person's unread notification of the same type for the task is
 *   updated (with a count) instead of a new one, and at most one email goes out per person, type and task per window.
 *
 * Runs only for live deliveries (and the manual link), never for the import or the health backfill.
 * Never throws: a failure is logged and never fails the webhook delivery or the manual link.
 * The admin client bypasses RLS, so every query filters on `organization_id`.
 * @module src/git-integrations/git-activity.service
 */

import { Injectable, Logger } from '@nestjs/common';

import {
  GIT_NOTIFICATION_DEFAULTS,
  type GitNotificationType,
  httpUrl,
} from '../notifications/git-notifications';
import { NotificationEmailService } from '../notifications/notification-email.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WatchersService } from '../watchers/watchers.service';
import { displayName, GitIdentitiesService } from './git-identities.service';
import type {
  GitActivityKind,
  IGitActivity,
  IGitConnectionRow,
} from './git-integrations.types';
import { developmentTaskIds, isRepositoryLive } from './git-integrations.util';

/** Bursts within this window become one notification and at most one email. */
export const COALESCE_MS = 10 * 60_000;

type Recipient = 'assignee' | 'watchers' | 'author';

/** Who is told about what. Every other activity is History only. */
const NOTIFY: Partial<
  Record<GitActivityKind, { type: GitNotificationType; to: Recipient[] }>
> = {
  pr_merged: { type: 'git_pr_merged', to: ['assignee', 'watchers'] },
  build_failed: {
    type: 'git_build_failed',
    to: ['assignee', 'watchers', 'author'],
  },
  build_fixed: { type: 'git_build_fixed', to: ['assignee', 'watchers'] },
  pr_linked: { type: 'git_pr_linked', to: ['assignee'] },
};

interface ITask {
  id: string;
  key: string | null;
  space_id: string | null;
  assigned_to: string | null;
}

interface IPerson {
  userId: string;
  name: string | null;
}

interface IPreference {
  inApp: boolean;
  email: boolean;
}

@Injectable()
export class GitActivityService {
  private readonly logger = new Logger(GitActivityService.name);

  /**
   * Last email per `user:type:task`.
   * ponytail: per instance, so several instances may each send one email per window; a table if that matters.
   */
  private readonly emailed = new Map<string, number>();

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly identities: GitIdentitiesService,
    private readonly watchers: WatchersService,
    private readonly broadcast: NotificationsBroadcastService,
    private readonly email: NotificationEmailService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** Records one activity for each of its tasks independently, skipping spaces with Development off. Never throws. */
  async record(activity: IGitActivity): Promise<void> {
    if (!activity.taskIds.length) return;

    try {
      const taskIds = await developmentTaskIds(
        this.db,
        activity.organizationId,
        activity.taskIds,
        activity.repositoryId,
      );

      if (!taskIds.size) return;

      const actor: IPerson | null = activity.manualBy
        ? await this.person(activity.manualBy)
        : await this.identities.resolveActor(
            activity.organizationId,
            activity.provider,
            activity.actor,
            activity.host,
          );

      for (const taskId of taskIds) {
        try {
          await this.recordForTask(activity, taskId, actor);
        } catch (error) {
          this.logger.warn(
            `git activity ${activity.kind} task ${taskId}: ${message(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `git activity ${activity.kind} org ${activity.organizationId}: ${message(error)}`,
      );
    }
  }

  private async recordForTask(
    activity: IGitActivity,
    taskId: string,
    actor: IPerson | null,
  ): Promise<void> {
    const task = await this.task(activity.organizationId, taskId);

    if (!task) return;

    let kind = activity.kind;

    // A pass is only worth telling after a failure ("build fixed"); History keeps the last build outcome.
    if (kind === 'build_passed') {
      if (
        (await this.lastBuildEvent(
          activity.organizationId,
          taskId,
          activity.subject.branch ?? null,
        )) !== 'build_failed'
      )
        return;

      kind = 'build_fixed';
    }

    if (!activity.manualBy)
      await this.writeHistory(activity, kind, task, actor);

    const rule = NOTIFY[kind];

    if (rule) await this.notify(activity, kind, rule, task, actor);
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  private async writeHistory(
    activity: IGitActivity,
    kind: GitActivityKind,
    task: ITask,
    actor: IPerson | null,
  ): Promise<void> {
    const { subject } = activity;
    const link = kind === 'pr_linked' || kind === 'pr_unlinked';
    const metadata = {
      source: 'git',
      provider: activity.provider,
      event: kind,
      subject: { ...subject, url: httpUrl(subject.url) },
      actor: {
        login: activity.actor.login,
        userId: actor?.userId ?? null,
        name: actor?.name ?? null,
      },
      ...(link ? { auto: true } : {}),
    };

    const { error } = await this.db.from('task_history').insert({
      task_id: task.id,
      organization_id: activity.organizationId,
      // Automatic links reuse the manual link rows (ticket 4), so History reads them the same way.
      action: link
        ? kind === 'pr_linked'
          ? 'pull_request_linked'
          : 'pull_request_unlinked'
        : 'git_activity',
      field_name: null,
      old_value: null,
      new_value: link
        ? {
            provider: activity.provider,
            repository: subject.repository ?? null,
            number: subject.number ?? null,
            title: subject.title ?? null,
            url: httpUrl(subject.url),
          }
        : null,
      changed_by: actor?.userId ?? null,
      metadata,
    });

    if (error)
      this.logger.warn(`git activity history ${task.id}: ${error.message}`);
  }

  /** The task's last recorded build outcome on `branch` (null: none). */
  private async lastBuildEvent(
    org: string,
    taskId: string,
    branch: string | null,
  ): Promise<string | null> {
    let query = this.db
      .from('task_history')
      .select('metadata')
      .eq('organization_id', org)
      .eq('task_id', taskId)
      .eq('action', 'git_activity')
      .in('metadata->>event', ['build_failed', 'build_fixed']);

    query = branch
      ? query.eq('metadata->subject->>branch', branch)
      : query.is('metadata->subject->>branch', null);

    const { data, error } = await query
      .order('changed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);

    return (
      (data as { metadata: { event?: string } | null } | null)?.metadata
        ?.event ?? null
    );
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  private async notify(
    activity: IGitActivity,
    kind: GitActivityKind,
    rule: { type: GitNotificationType; to: Recipient[] },
    task: ITask,
    actor: IPerson | null,
  ): Promise<void> {
    const org = activity.organizationId;

    if (
      activity.repositoryId &&
      !(await this.repositoryLive(org, activity.repositoryId))
    )
      return;

    const ids: string[] = [];

    if (rule.to.includes('assignee') && task.assigned_to)
      ids.push(task.assigned_to);
    if (rule.to.includes('watchers'))
      ids.push(...(await this.watchers.taskWatcherIds(org, task.id)));
    if (rule.to.includes('author')) ids.push(...(await this.authors(activity)));

    // Active members who can see the task, without the person who caused it.
    const visible = await this.watchers.visibleTaskUsers(
      org,
      task.space_id,
      ids,
      actor?.userId ?? '',
    );

    if (!visible.length) return;

    const muted = await this.watchers.mutedTaskUsers(org, task.id, visible);
    const recipients = visible.filter((id) => !muted.has(id));

    if (!recipients.length) return;

    const prefs = await this.preferences(org, rule.type, recipients);
    const { subject } = activity;
    const metadata = {
      task_key: task.key,
      space_key: await this.spaceKey(org, task.space_id),
      provider: activity.provider,
      event: kind,
      subject: {
        kind: subject.kind,
        number: subject.number ?? null,
        title: subject.title ?? null,
        url: httpUrl(subject.url),
        branch: subject.branch ?? null,
        repository: subject.repository ?? null,
      },
      actor_login: activity.actor.login,
      actor_name: actor?.name ?? null,
      ...(kind === 'pr_linked' && !activity.manualBy ? { auto: true } : {}),
      count: 1,
    };

    for (const userId of recipients) {
      try {
        await this.deliver(
          org,
          rule.type,
          task.id,
          userId,
          metadata,
          prefs.get(userId)!,
        );
      } catch (error) {
        this.logger.warn(
          `git notification ${rule.type} task ${task.id} user ${userId}: ${message(error)}`,
        );
      }
    }
  }

  /**
   * One person's notification: updates their unread one of the same type for the task from the last
   * {@link COALESCE_MS} (count + 1, newest details) or inserts a new one; emails only the first of a window.
   */
  private async deliver(
    org: string,
    type: GitNotificationType,
    taskId: string,
    userId: string,
    metadata: Record<string, unknown>,
    pref: IPreference,
  ): Promise<void> {
    if (!pref.inApp && !pref.email) return;

    let row: Record<string, unknown> | null = null;
    let combined = false;

    if (pref.inApp) {
      const { data: open, error } = await this.db
        .from('notifications')
        .select('id, metadata')
        .eq('organization_id', org)
        .eq('user_id', userId)
        .eq('type', type)
        .eq('reference_type', 'task')
        .eq('reference_id', taskId)
        .eq('is_read', false)
        .gte('created_at', new Date(Date.now() - COALESCE_MS).toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw new Error(error.message);

      const previous = open as {
        id: string;
        metadata: Record<string, unknown> | null;
      } | null;
      const next = previous
        ? { ...metadata, count: (Number(previous.metadata?.count) || 1) + 1 }
        : metadata;
      const text = this.email.gitText(type, next, 'en');
      const res = previous
        ? await this.db
            .from('notifications')
            .update({
              title: text.title,
              body: text.body,
              metadata: next,
              updated_at: new Date().toISOString(),
            })
            .eq('id', previous.id)
            .eq('organization_id', org)
            .select()
            .single()
        : await this.db
            .from('notifications')
            .insert({
              organization_id: org,
              user_id: userId,
              type,
              title: text.title,
              body: text.body,
              is_read: false,
              reference_type: 'task',
              reference_id: taskId,
              metadata: next,
            })
            .select()
            .single();

      if (res.error) throw new Error(res.error.message);

      row = res.data as Record<string, unknown>;
      combined = !!previous;
      void this.broadcast.broadcastNotification(row);
    }

    if (
      !pref.email ||
      combined ||
      !this.claimEmail(`${userId}:${type}:${taskId}`)
    )
      return;

    const text = this.email.gitText(type, metadata, 'en');

    void this.email.emailForNotifications([
      row ?? {
        organization_id: org,
        user_id: userId,
        type,
        title: text.title,
        body: text.body,
        reference_type: 'task',
        reference_id: taskId,
        metadata,
      },
    ]);
  }

  /** True once per key and window. */
  private claimEmail(key: string): boolean {
    const now = Date.now();

    if (this.emailed.size > 1000)
      for (const [k, at] of this.emailed)
        if (now - at >= COALESCE_MS) this.emailed.delete(k);

    const last = this.emailed.get(key);

    if (last !== undefined && now - last < COALESCE_MS) return false;

    this.emailed.set(key, now);

    return true;
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  private async task(org: string, taskId: string): Promise<ITask | null> {
    const { data, error } = await this.db
      .from('tasks')
      .select('id, key, space_id, assigned_to')
      .eq('id', taskId)
      .eq('organization_id', org)
      .maybeSingle();

    if (error) throw new Error(error.message);

    return (data as ITask | null) ?? null;
  }

  /** The manual linker, named as everywhere else in the integration. */
  private async person(userId: string): Promise<IPerson> {
    const { data, error } = await this.db
      .from('users')
      .select('first_name, last_name, email')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw new Error(error.message);

    return {
      userId,
      name: data
        ? displayName(
            data as {
              first_name: string | null;
              last_name: string | null;
              email: string | null;
            },
            '',
          ) || null
        : null,
    };
  }

  private async spaceKey(
    org: string,
    spaceId: string | null,
  ): Promise<string | null> {
    if (!spaceId) return null;

    const { data, error } = await this.db
      .from('spaces')
      .select('key')
      .eq('id', spaceId)
      .eq('organization_id', org)
      .maybeSingle();

    if (error) throw new Error(error.message);

    return (data as { key: string | null } | null)?.key ?? null;
  }

  /** A disconnected connection, or a repository switched off or no longer granted, sends nothing. */
  private async repositoryLive(
    org: string,
    repositoryId: string,
  ): Promise<boolean> {
    const { data, error } = await this.db
      .from('git_repositories')
      .select(
        'is_enabled, removed_at, connection:git_connections!git_repositories_connection_fkey(status)',
      )
      .eq('id', repositoryId)
      .eq('organization_id', org)
      .maybeSingle();

    if (error) throw new Error(error.message);

    const repository = data as {
      is_enabled: boolean;
      removed_at: string | null;
      connection: Pick<IGitConnectionRow, 'status'> | null;
    } | null;

    return (
      !!repository?.connection &&
      isRepositoryLive(repository.connection, repository)
    );
  }

  /** Failed build: the XISUITE accounts of the authors of the open pull requests whose head is the commit. */
  private async authors(activity: IGitActivity): Promise<string[]> {
    if (!activity.subject.sha || !activity.repositoryId) return [];

    const { data, error } = await this.db
      .from('git_pull_requests')
      .select('author_external_id, author_login')
      .eq('organization_id', activity.organizationId)
      .eq('repository_id', activity.repositoryId)
      .eq('head_sha', activity.subject.sha.toLowerCase())
      .eq('state', 'open');

    if (error) throw new Error(error.message);

    const authors = (
      (data ?? []) as {
        author_external_id: string | null;
        author_login: string | null;
      }[]
    ).flatMap((row) =>
      row.author_external_id
        ? [
            {
              externalId: row.author_external_id,
              login: row.author_login ?? '',
            },
          ]
        : [],
    );

    if (!authors.length) return [];

    const resolved = await this.identities.resolveAuthors(
      activity.organizationId,
      activity.provider,
      authors,
      activity.host,
    );

    return [...resolved.values()].map((person) => person.userId);
  }

  /** Each recipient's switches for `type`; no row means the type's default. */
  private async preferences(
    org: string,
    type: GitNotificationType,
    userIds: string[],
  ): Promise<Map<string, IPreference>> {
    const { data, error } = await this.db
      .from('notification_preferences')
      .select('user_id, in_app, email')
      .eq('organization_id', org)
      .eq('notification_type', type)
      .in('user_id', userIds);

    if (error) throw new Error(error.message);

    const rows = new Map(
      (
        (data ?? []) as { user_id: string; in_app: boolean; email: boolean }[]
      ).map((row) => [row.user_id, row]),
    );
    const defaults = GIT_NOTIFICATION_DEFAULTS[type];

    return new Map(
      userIds.map((userId) => {
        const row = rows.get(userId);

        return [
          userId,
          {
            inApp: row?.in_app ?? defaults.inApp,
            email: row?.email ?? defaults.email,
          },
        ];
      }),
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
