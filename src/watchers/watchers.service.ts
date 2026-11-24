import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';

import { NotificationEmailService } from '../notifications/notification-email.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WikiPermissionsService } from '../wiki/wiki-permissions.service';

const MAX_RECIPIENTS = 500;

export interface TaskWatcherEvent {
  organizationId: string;
  spaceId: string | null;
  taskId: string;
  actorUserId: string;
  taskKey: string;
  title: string;
  changeKind: string;
}

export interface WikiWatcherEvent {
  organizationId: string;
  spaceId: string;
  pageId: string;
  actorUserId: string;
  title: string;
  changeKind: string;
}

@Injectable()
export class WatchersService {
  private readonly logger = new Logger(WatchersService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
    @Inject(forwardRef(() => WikiPermissionsService))
    private readonly wikiPermissions: WikiPermissionsService,
    private readonly broadcast: NotificationsBroadcastService,
    private readonly email: NotificationEmailService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getTaskWatchState(
    organizationId: string,
    userId: string,
    taskId: string,
  ): Promise<{ watching: boolean }> {
    await this.assertTaskWatchAccess(organizationId, userId, taskId);
    const { data, error } = await this.client
      .from('task_watchers')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('task_id', taskId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    return { watching: Boolean(data) };
  }

  async setTaskWatch(
    organizationId: string,
    userId: string,
    taskId: string,
    watching: boolean,
  ): Promise<{ watching: boolean }> {
    await this.assertTaskWatchAccess(organizationId, userId, taskId);

    if (watching) {
      const { error } = await this.client
        .from('task_watchers')
        .upsert(
          { organization_id: organizationId, task_id: taskId, user_id: userId },
          { onConflict: 'task_id,user_id', ignoreDuplicates: true },
        );
      if (error) throw new BadRequestException(error.message);
    } else {
      const { error } = await this.client
        .from('task_watchers')
        .delete()
        .eq('organization_id', organizationId)
        .eq('task_id', taskId)
        .eq('user_id', userId);
      if (error) throw new BadRequestException(error.message);
    }

    return { watching };
  }

  async getWikiWatchState(
    organizationId: string,
    userId: string,
    spaceId: string,
    pageId?: string,
  ): Promise<{ watching: boolean }> {
    await this.assertWikiWatchAccess(organizationId, userId, spaceId, pageId);
    let query = this.client
      .from('wiki_watches')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('scope', pageId ? 'page' : 'space')
      .eq('user_id', userId);
    query = pageId ? query.eq('page_id', pageId) : query.is('page_id', null);
    const { data, error } = await query.maybeSingle();

    if (error) throw new BadRequestException(error.message);
    return { watching: Boolean(data) };
  }

  async setWikiWatch(
    organizationId: string,
    userId: string,
    spaceId: string,
    pageId: string | undefined,
    scope: 'page' | 'space',
    watching: boolean,
  ): Promise<{ watching: boolean }> {
    const effectivePageId = scope === 'page' ? pageId : undefined;
    if (scope === 'page' && !effectivePageId) {
      throw new BadRequestException('pageId is required for page watches');
    }
    await this.assertWikiWatchAccess(
      organizationId,
      userId,
      spaceId,
      effectivePageId,
    );

    if (watching) {
      const { error } = await this.client.from('wiki_watches').upsert(
        {
          organization_id: organizationId,
          space_id: spaceId,
          page_id: effectivePageId ?? null,
          scope,
          user_id: userId,
        },
        {
          onConflict: 'space_id,page_id,user_id',
          ignoreDuplicates: true,
        },
      );
      if (error) throw new BadRequestException(error.message);
    } else {
      let query = this.client
        .from('wiki_watches')
        .delete()
        .eq('organization_id', organizationId)
        .eq('space_id', spaceId)
        .eq('scope', scope)
        .eq('user_id', userId);
      query = effectivePageId
        ? query.eq('page_id', effectivePageId)
        : query.is('page_id', null);
      const { error } = await query;
      if (error) throw new BadRequestException(error.message);
    }

    return { watching };
  }

  /** Git integration ticket 9: whether the user muted notifications for the task (History is still written). */
  async getTaskMuteState(
    organizationId: string,
    userId: string,
    taskId: string,
  ): Promise<{ muted: boolean }> {
    await this.assertTaskWatchAccess(organizationId, userId, taskId);
    const { data, error } = await this.client
      .from('task_notification_mutes')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('task_id', taskId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    return { muted: Boolean(data) };
  }

  async setTaskMute(
    organizationId: string,
    userId: string,
    taskId: string,
    muted: boolean,
  ): Promise<{ muted: boolean }> {
    await this.assertTaskWatchAccess(organizationId, userId, taskId);

    if (muted) {
      const { error } = await this.client
        .from('task_notification_mutes')
        .upsert(
          { organization_id: organizationId, task_id: taskId, user_id: userId },
          { onConflict: 'task_id,user_id', ignoreDuplicates: true },
        );
      if (error) throw new BadRequestException(error.message);
    } else {
      const { error } = await this.client
        .from('task_notification_mutes')
        .delete()
        .eq('organization_id', organizationId)
        .eq('task_id', taskId)
        .eq('user_id', userId);
      if (error) throw new BadRequestException(error.message);
    }

    return { muted };
  }

  /** The task's watchers. */
  async taskWatcherIds(
    organizationId: string,
    taskId: string,
  ): Promise<string[]> {
    const { data, error } = await this.client
      .from('task_watchers')
      .select('user_id')
      .eq('organization_id', organizationId)
      .eq('task_id', taskId);
    if (error) throw error;
    return ((data ?? []) as Array<{ user_id: string }>).map(
      (row) => row.user_id,
    );
  }

  /** Of `userIds`: those who muted notifications for the task. */
  async mutedTaskUsers(
    organizationId: string,
    taskId: string,
    userIds: string[],
  ): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const { data, error } = await this.client
      .from('task_notification_mutes')
      .select('user_id')
      .eq('organization_id', organizationId)
      .eq('task_id', taskId)
      .in('user_id', userIds);
    if (error) throw error;
    return new Set(
      ((data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id),
    );
  }

  /**
   * Of `userIds`: the active organization members other than the actor who can see a task in `spaceId`
   * (`view_tasks` in the space; without a space, the organization's `can_view_tasks`).
   */
  async visibleTaskUsers(
    organizationId: string,
    spaceId: string | null,
    userIds: string[],
    actorUserId: string,
  ): Promise<string[]> {
    const candidates = await this.activeOrgUsers(
      organizationId,
      userIds,
      actorUserId,
    );
    const allowed: string[] = [];
    for (const userId of candidates) {
      if (!spaceId) {
        const effective = await this.permissions.getUserEffectivePermissions(
          userId,
          organizationId,
        );
        if (effective.effective_permissions?.can_view_tasks === true) {
          allowed.push(userId);
        }
        continue;
      }
      const access = await this.permissions.getUserSpacePermissions(
        userId,
        organizationId,
        spaceId,
      );
      if (access.isMember && access.permissions['view_tasks'] === true) {
        allowed.push(userId);
      }
    }
    return allowed;
  }

  async notifyTaskWatchers(input: TaskWatcherEvent): Promise<void> {
    try {
      const task = await this.getTaskForDelivery(
        input.organizationId,
        input.taskId,
      );
      const { data, error } = await this.client
        .from('task_watchers')
        .select('user_id')
        .eq('organization_id', input.organizationId)
        .eq('task_id', input.taskId);
      if (error) throw error;

      const visible = await this.visibleTaskUsers(
        input.organizationId,
        task.space_id,
        ((data ?? []) as Array<{ user_id: string }>).map((row) => row.user_id),
        input.actorUserId,
      );
      // A watcher who muted the task gets nothing for it (History is still written).
      const muted = await this.mutedTaskUsers(
        input.organizationId,
        input.taskId,
        visible,
      );
      const allowed = visible.filter((userId) => !muted.has(userId));

      await this.deliver(this.capRecipients(allowed), {
        organizationId: input.organizationId,
        title: `Task updated: ${input.title}`,
        referenceType: 'task',
        referenceId: input.taskId,
        metadata: {
          task_key: input.taskKey || task.key,
          space_key: await this.getSpaceKey(
            input.organizationId,
            task.space_id,
          ),
          change_kind: input.changeKind,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Task watcher delivery failed for ${input.taskId}: ${(error as Error).message}`,
      );
    }
  }

  async notifyWikiWatchers(input: WikiWatcherEvent): Promise<void> {
    try {
      const page = await this.getPageForDelivery(
        input.organizationId,
        input.spaceId,
        input.pageId,
      );
      const pageQuery = this.client
        .from('wiki_watches')
        .select('user_id')
        .eq('organization_id', input.organizationId)
        .eq('space_id', input.spaceId)
        .eq('scope', 'page')
        .eq('page_id', input.pageId);
      const spaceQuery = this.client
        .from('wiki_watches')
        .select('user_id')
        .eq('organization_id', input.organizationId)
        .eq('space_id', input.spaceId)
        .eq('scope', 'space')
        .is('page_id', null);
      const [pageRows, spaceRows] = await Promise.all([pageQuery, spaceQuery]);
      if (pageRows.error) throw pageRows.error;
      if (spaceRows.error) throw spaceRows.error;

      const ids = [
        ...((pageRows.data ?? []) as Array<{ user_id: string }>),
        ...((spaceRows.data ?? []) as Array<{ user_id: string }>),
      ].map((row) => row.user_id);
      const candidates = await this.activeOrgUsers(
        input.organizationId,
        ids,
        input.actorUserId,
      );
      const allowed: string[] = [];
      for (const userId of candidates) {
        const spaceAccess = await this.permissions.getUserSpacePermissions(
          userId,
          input.organizationId,
          input.spaceId,
        );
        if (
          !spaceAccess.isMember ||
          spaceAccess.permissions['view_wiki_pages'] !== true
        ) {
          continue;
        }
        if (
          (spaceAccess.globalRole === 'admin' ||
            spaceAccess.globalRole === 'owner') &&
          !(await this.hasExplicitSpaceMembership(
            input.organizationId,
            userId,
            input.spaceId,
          ))
        ) {
          continue;
        }
        const trace = await this.wikiPermissions.resolveWithTrace(
          userId,
          input.pageId,
          input.spaceId,
        );
        if (trace.decision.can_view) allowed.push(userId);
      }

      await this.deliver(this.capRecipients(allowed), {
        organizationId: input.organizationId,
        title: `Wiki page updated: ${input.title || page.title}`,
        referenceType: 'wiki_page',
        referenceId: input.pageId,
        metadata: {
          page_id: input.pageId,
          space_key: await this.getSpaceKey(
            input.organizationId,
            input.spaceId,
          ),
          change_kind: input.changeKind,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Wiki watcher delivery failed for ${input.pageId}: ${(error as Error).message}`,
      );
    }
  }

  private async assertTaskWatchAccess(
    organizationId: string,
    userId: string,
    taskId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('tasks')
      .select('id, space_id')
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Task not found');
    await this.assertActiveOrgUser(organizationId, userId);
    const spaceId = (data as { space_id?: string | null }).space_id ?? null;
    if (!spaceId) {
      const effective = await this.permissions.getUserEffectivePermissions(
        userId,
        organizationId,
      );
      if (effective.effective_permissions?.can_view_tasks !== true) {
        throw new NotFoundException('Task not found');
      }
      return;
    }
    const access = await this.permissions.getUserSpacePermissions(
      userId,
      organizationId,
      spaceId,
    );
    if (!access.isMember || access.permissions['view_tasks'] !== true) {
      throw new NotFoundException('Task not found');
    }
  }

  private async assertWikiWatchAccess(
    organizationId: string,
    userId: string,
    spaceId: string,
    pageId?: string,
  ): Promise<void> {
    await this.assertWikiResource(organizationId, spaceId, pageId);
    await this.assertActiveOrgUser(organizationId, userId);
    const spaceAccess = await this.permissions.getUserSpacePermissions(
      userId,
      organizationId,
      spaceId,
    );
    if (
      !spaceAccess.isMember ||
      spaceAccess.permissions['view_wiki_pages'] !== true
    ) {
      throw new NotFoundException(
        pageId ? 'Page not found' : 'Space not found',
      );
    }
    if (
      (spaceAccess.globalRole === 'admin' ||
        spaceAccess.globalRole === 'owner') &&
      !(await this.hasExplicitSpaceMembership(organizationId, userId, spaceId))
    ) {
      throw new NotFoundException(
        pageId ? 'Page not found' : 'Space not found',
      );
    }
    if (pageId) {
      const trace = await this.wikiPermissions.resolveWithTrace(
        userId,
        pageId,
        spaceId,
      );
      if (!trace.decision.can_view)
        throw new NotFoundException('Page not found');
    }
  }

  private async assertWikiResource(
    organizationId: string,
    spaceId: string,
    pageId?: string,
  ): Promise<void> {
    const table = pageId ? 'wiki_pages' : 'spaces';
    let query = this.client
      .from(table)
      .select('id')
      .eq('id', pageId ?? spaceId)
      .eq('organization_id', organizationId);
    if (pageId) query = query.eq('space_id', spaceId);
    const { data, error } = await query.maybeSingle();
    if (error) throw new BadRequestException(error.message);
    if (!data)
      throw new NotFoundException(
        pageId ? 'Page not found' : 'Space not found',
      );
  }

  private async getTaskForDelivery(organizationId: string, taskId: string) {
    const { data, error } = await this.client
      .from('tasks')
      .select('id, key, summary, space_id')
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error || !data) throw new Error(error?.message ?? 'Task not found');
    return data as {
      id: string;
      key: string;
      summary: string;
      space_id: string | null;
    };
  }

  private async getPageForDelivery(
    organizationId: string,
    spaceId: string,
    pageId: string,
  ) {
    const { data, error } = await this.client
      .from('wiki_pages')
      .select('id, title, organization_id')
      .eq('id', pageId)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .maybeSingle();
    if (error || !data) throw new Error(error?.message ?? 'Page not found');
    return data as { id: string; title: string };
  }

  private async getSpaceKey(
    organizationId: string,
    spaceId: string | null,
  ): Promise<string | null> {
    if (!spaceId) return null;
    const { data } = await this.client
      .from('spaces')
      .select('id, key')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    return (data as { key?: string } | null)?.key ?? null;
  }

  private async activeOrgUsers(
    organizationId: string,
    rawIds: string[],
    actorUserId: string,
  ): Promise<string[]> {
    const ids = [...new Set(rawIds)].filter((id) => id !== actorUserId);
    if (!ids.length) return [];
    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id, users!inner(is_active)')
      .eq('organization_id', organizationId)
      .in('user_id', ids);
    if (error) throw error;
    return (
      (data ?? []) as Array<{
        user_id: string;
        users: { is_active: boolean | null } | { is_active: boolean | null }[];
      }>
    )
      .filter((row) => {
        const user = Array.isArray(row.users) ? row.users[0] : row.users;
        return user?.is_active === true;
      })
      .map((row) => row.user_id);
  }

  private async assertActiveOrgUser(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const active = await this.activeOrgUsers(organizationId, [userId], '');
    if (!active.includes(userId))
      throw new NotFoundException('Resource not found');
  }

  private async hasExplicitSpaceMembership(
    organizationId: string,
    userId: string,
    spaceId: string,
  ): Promise<boolean> {
    const explicitMember = async (
      memberType: 'user' | 'group' | 'role',
      column: 'user_id' | 'group_id' | 'role_id',
      ids: string[],
    ): Promise<boolean> => {
      if (!ids.length) return false;
      let query = this.client
        .from('space_members')
        .select('id, spaces!inner(organization_id)')
        .eq('space_id', spaceId)
        .eq('spaces.organization_id', organizationId)
        .eq('member_type', memberType)
        .eq('is_active', true);
      query =
        ids.length === 1 ? query.eq(column, ids[0]) : query.in(column, ids);
      const { data, error } = await query.limit(1);
      if (error) throw error;
      return Boolean((data as unknown[] | null)?.length);
    };

    if (await explicitMember('user', 'user_id', [userId])) return true;

    const [
      { data: groupRows, error: groupError },
      { data: roleRows, error: roleError },
    ] = await Promise.all([
      this.client
        .from('user_group_members')
        .select(
          'group_id, role_id, user_groups!inner(organization_id, is_deleted)',
        )
        .eq('user_id', userId)
        .eq('user_groups.organization_id', organizationId)
        .eq('user_groups.is_deleted', false),
      this.client
        .from('user_role_assignments')
        .select('role_id')
        .eq('user_id', userId)
        .eq('organization_id', organizationId),
    ]);
    if (groupError) throw groupError;
    if (roleError) throw roleError;

    const groups = (groupRows ?? []) as Array<{
      group_id: string;
      role_id?: string | null;
    }>;
    const groupIds = [...new Set(groups.map((row) => row.group_id))];
    const roleIds = [
      ...new Set([
        ...groups.flatMap((row) => (row.role_id ? [row.role_id] : [])),
        ...((roleRows ?? []) as Array<{ role_id: string }>).map(
          (row) => row.role_id,
        ),
      ]),
    ];

    if (await explicitMember('group', 'group_id', groupIds)) return true;
    if (!roleIds.length) return false;

    const { data: activeRoles, error: activeRoleError } = await this.client
      .from('custom_roles')
      .select('id')
      .eq('organization_id', organizationId)
      .in('id', roleIds)
      .eq('is_active', true)
      .eq('is_deleted', false);
    if (activeRoleError) throw activeRoleError;
    const activeRoleIds = ((activeRoles ?? []) as Array<{ id: string }>).map(
      (role) => role.id,
    );
    return explicitMember('role', 'role_id', activeRoleIds);
  }

  private capRecipients(userIds: string[]): string[] {
    if (userIds.length > MAX_RECIPIENTS) {
      this.logger.warn(
        `Watcher fan-out capped at ${MAX_RECIPIENTS} (accessible ${userIds.length})`,
      );
    }
    return [...userIds].sort().slice(0, MAX_RECIPIENTS);
  }

  private async deliver(
    userIds: string[],
    event: {
      organizationId: string;
      title: string;
      referenceType: 'task' | 'wiki_page';
      referenceId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!userIds.length) return;
    const { data, error } = await this.client
      .from('notification_preferences')
      .select('user_id, in_app, email')
      .eq('organization_id', event.organizationId)
      .eq('notification_type', 'watcher_updates')
      .in('user_id', userIds);
    if (error) throw error;
    const prefs = new Map(
      (
        (data ?? []) as Array<{
          user_id: string;
          in_app: boolean;
          email: boolean;
        }>
      ).map((row) => [row.user_id, row]),
    );
    const makeRow = (userId: string) => ({
      organization_id: event.organizationId,
      user_id: userId,
      type: 'watcher_updates',
      title: event.title,
      body: null,
      is_read: false,
      reference_type: event.referenceType,
      reference_id: event.referenceId,
      metadata: event.metadata,
    });

    const inAppRows = userIds
      .filter((userId) => prefs.get(userId)?.in_app !== false)
      .map(makeRow);
    if (inAppRows.length) {
      const { data: inserted, error: insertError } = await this.client
        .from('notifications')
        .insert(inAppRows)
        .select();
      if (insertError) throw insertError;
      for (const row of inserted ?? []) {
        void this.broadcast.broadcastNotification(
          row as Record<string, unknown>,
        );
      }
    }

    const emailRows = userIds
      .filter((userId) => prefs.get(userId)?.email !== false)
      .map(makeRow);
    if (emailRows.length) void this.email.emailForNotifications(emailRows);
  }
}
