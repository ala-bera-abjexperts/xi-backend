/**
 * @fileoverview Service for managing user notifications, including listing, marking as read,
 * and handling space invitation accept/decline actions.
 * @module src/notifications/notifications.service
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  SPACE_PERMISSION_COLUMN_KEYS,
  SPACE_ROLE_BASE_PERMISSIONS,
  normalizeSpacePermissions,
} from '../permissions/models/space-permissions.model';
import { GIT_NOTIFICATION_DEFAULTS } from './git-notifications';
import type { ListNotificationsQueryDto } from './dto/list-notifications-query.dto';
import type { MarkReadDto } from './dto/mark-read.dto';
import type { NotificationActionDto } from './dto/notification-action.dto';
import type {
  NotificationPreferenceRow,
  NotificationPreferencesMap,
  UpsertNotificationPreferenceDto,
} from './dto/notification-preference.dto';

/** Shape of a row from the `notifications` table. */
interface NotificationRow {
  id: string;
  organization_id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  is_read: boolean;
  action_status: string | null;
  reference_type: string | null;
  reference_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** Relevant columns from the `invitations` table. */
interface InvitationRow {
  id: string;
  status: string;
  expires_at: string;
  space_id: string | null;
  space_role: string | null;
  space_permissions: Record<string, boolean> | null;
  invited_by: string;
  organization_id: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Returns a paginated list of notifications for the calling user.
   * Optionally filters to unread-only.
   *
   * @param {string} userId - Authenticated user UUID
   * @param {string} orgId - Organization UUID from JWT
   * @param {ListNotificationsQueryDto} query - Pagination + filter params
   * @returns {Promise<{ data: NotificationRow[]; total: number }>}
   */
  async getUserNotifications(
    userId: string,
    orgId: string,
    query: ListNotificationsQueryDto,
  ): Promise<{ data: unknown[]; total: number }> {
    const limit = Math.min(
      Math.max(parseInt(query.limit ?? '50', 10) || 50, 1),
      100,
    );
    const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0);
    const unreadOnly = query.unread_only === 'true';

    let q = this.client
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (unreadOnly) {
      q = q.eq('is_read', false);
    }

    if (query.since) {
      q = q.gte('created_at', query.since);
    }

    const { data, error, count } = await q;

    if (error) {
      this.logger.error('Failed to get notifications:', error);
      throw new BadRequestException('Failed to get notifications');
    }

    return { data: data ?? [], total: count ?? 0 };
  }

  /**
   * Marks a single notification as read or unread.
   * Verifies that the notification belongs to the calling user.
   *
   * @param {string} notificationId - Notification UUID
   * @param {string} userId - Authenticated user UUID
   * @param {MarkReadDto} dto - `{ is_read: boolean }`
   * @returns {Promise<NotificationRow>} The updated notification row
   * @throws {NotFoundException} When the notification does not exist
   * @throws {ForbiddenException} When the notification belongs to a different user
   */
  async markAsRead(
    notificationId: string,
    userId: string,
    orgId: string,
    dto: MarkReadDto,
  ): Promise<unknown> {
    const fetchResult = await this.client
      .from('notifications')
      .select('*')
      .eq('id', notificationId)
      .maybeSingle();
    const notification = fetchResult.data as NotificationRow | null;

    if (fetchResult.error || !notification) {
      throw new NotFoundException('Notification not found');
    }

    if (
      notification.user_id !== userId ||
      notification.organization_id !== orgId
    ) {
      throw new ForbiddenException('Access denied');
    }

    const updateResult = await this.client
      .from('notifications')
      .update({ is_read: dto.is_read, updated_at: new Date().toISOString() })
      .eq('id', notificationId)
      .select('*')
      .single();
    const updated = updateResult.data as NotificationRow | null;

    if (updateResult.error || !updated) {
      this.logger.error('Failed to update notification:', updateResult.error);
      throw new BadRequestException('Failed to update notification');
    }

    void this.auditLogsService.logAction(
      orgId,
      userId,
      'notification',
      notificationId,
      'update',
      { is_read: dto.is_read },
    );

    return updated;
  }

  /**
   * Marks all unread notifications as read for the calling user.
   *
   * @param {string} userId - Authenticated user UUID
   * @param {string} orgId - Organization UUID from JWT
   * @returns {Promise<{ success: true }>}
   */
  async markAllAsRead(
    userId: string,
    orgId: string,
  ): Promise<{ success: true }> {
    const { error } = await this.client
      .from('notifications')
      .update({ is_read: true, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('organization_id', orgId)
      .eq('is_read', false);

    if (error) {
      this.logger.error('Failed to mark all notifications as read:', error);
      throw new BadRequestException('Failed to mark all notifications as read');
    }

    void this.auditLogsService.logAction(
      orgId,
      userId,
      'notification',
      userId,
      'update',
      { mark_all_read: true },
    );

    return { success: true };
  }

  /**
   * Handles an accept or decline action on a space_invitation notification.
   *
   * Accept flow:
   * - Validates invitation is pending and not expired
   * - Inserts a `space_members` row for the user
   * - Upserts `space_permissions` if the invitation carries custom permissions
   * - Marks invitation `status=accepted`, notification `action_status=accepted`
   *
   * Decline flow:
   * - Marks invitation `status=declined`, `declined_at=now`
   * - Marks notification `action_status=declined`
   *
   * @param {string} notificationId - Notification UUID
   * @param {string} userId - Authenticated user UUID
   * @param {string} orgId - Organization UUID from JWT
   * @param {NotificationActionDto} dto - `{ action: 'accept' | 'decline' }`
   * @returns {Promise<{ success: true; action: string; space_id: string | null }>}
   * @throws {NotFoundException} When notification or invitation is not found
   * @throws {ForbiddenException} When the notification belongs to a different user
   * @throws {BadRequestException} When the action is invalid or cannot be performed
   */
  async handleAction(
    notificationId: string,
    userId: string,
    orgId: string,
    dto: NotificationActionDto,
  ): Promise<{ success: true; action: string; space_id: string | null }> {
    // Fetch notification and verify ownership
    const notifResult = await this.client
      .from('notifications')
      .select('*')
      .eq('id', notificationId)
      .maybeSingle();
    const notif = notifResult.data as NotificationRow | null;

    if (notifResult.error || !notif) {
      throw new NotFoundException('Notification not found');
    }

    if (notif.user_id !== userId || notif.organization_id !== orgId) {
      throw new ForbiddenException('Access denied');
    }

    if (notif.action_status !== 'pending') {
      throw new ConflictException(
        'Notification action has already been processed',
      );
    }

    if (
      notif.type !== 'space_invitation' ||
      notif.reference_type !== 'invitation'
    ) {
      throw new BadRequestException(
        'Action not supported for this notification type',
      );
    }

    if (!notif.reference_id) {
      throw new BadRequestException(
        'Notification has no associated invitation',
      );
    }

    // Fetch invitation
    const { data: invitation, error: invError } = await this.client
      .from('invitations')
      .select(
        'id, status, expires_at, space_id, space_role, space_permissions, invited_by, organization_id',
      )
      .eq('id', notif.reference_id)
      .maybeSingle();

    if (invError || !invitation) {
      await this.updateNotificationActionStatus(
        notificationId,
        'dismissed',
        true,
      );
      throw new NotFoundException('Invitation not found');
    }

    const inv = invitation as InvitationRow;

    if (inv.organization_id !== orgId) {
      throw new ForbiddenException('Access denied');
    }

    if (inv.status !== 'pending') {
      const statusMap: Record<string, string> = {
        accepted: 'accepted',
        declined: 'declined',
        revoked: 'dismissed',
        expired: 'dismissed',
      };

      await this.updateNotificationActionStatus(
        notificationId,
        statusMap[inv.status] ?? 'dismissed',
        true,
      );

      throw new ConflictException(`Invitation has already been ${inv.status}`);
    }

    if (new Date(inv.expires_at) < new Date()) {
      await this.client
        .from('invitations')
        .update({ status: 'expired' })
        .eq('id', inv.id);
      await this.updateNotificationActionStatus(
        notificationId,
        'dismissed',
        true,
      );
      throw new GoneException('Invitation has expired');
    }

    if (dto.action === 'accept') {
      return this.acceptSpaceInvitation(notificationId, userId, orgId, inv);
    }

    return this.declineSpaceInvitation(notificationId, userId, orgId, inv);
  }

  /** @private */
  private async acceptSpaceInvitation(
    notificationId: string,
    userId: string,
    orgId: string,
    inv: InvitationRow,
  ): Promise<{ success: true; action: string; space_id: string | null }> {
    if (!inv.space_id) {
      throw new BadRequestException('Invitation is not linked to a space');
    }

    const { data: existingMember, error: existingMemberError } =
      await this.client
        .from('space_members')
        .select('id')
        .eq('space_id', inv.space_id)
        .eq('user_id', userId)
        .eq('is_active', true)
        .maybeSingle();

    if (existingMemberError) {
      this.logger.error(
        'Failed to check existing space member on accept:',
        existingMemberError,
      );
      throw new BadRequestException('Failed to check space membership');
    }

    if (existingMember) {
      throw new ConflictException('User is already a member of this space');
    }

    // Add user as space member
    const { error: memberError } = await this.client
      .from('space_members')
      .insert({
        space_id: inv.space_id,
        member_type: 'user',
        user_id: userId,
        space_role: inv.space_role ?? 'member',
        permissions: inv.space_permissions ?? {},
        is_active: true,
        added_by: inv.invited_by,
      });

    if (memberError) {
      this.logger.error('Failed to add space member on accept:', memberError);
      throw new BadRequestException('Failed to add space membership');
    }

    const permData = this.buildSpacePermissionData(inv, userId);

    const { data: existingPerm, error: existingPermError } = await this.client
      .from('space_permissions')
      .select('id')
      .eq('space_id', inv.space_id)
      .eq('target_type', 'user')
      .eq('target_id', userId)
      .maybeSingle();

    if (existingPermError) {
      this.logger.error(
        'Failed to check existing space permissions on accept:',
        existingPermError,
      );
      throw new BadRequestException('Failed to check space permissions');
    }

    const permissionsResult = existingPerm
      ? await this.client
          .from('space_permissions')
          .update(permData)
          .eq('id', (existingPerm as { id: string }).id)
      : await this.client.from('space_permissions').insert(permData);

    if (permissionsResult.error) {
      this.logger.error(
        'Failed to upsert space permissions on accept:',
        permissionsResult.error,
      );
      throw new BadRequestException('Failed to update space permissions');
    }

    const inviteUpdate = await this.client
      .from('invitations')
      .update({ status: 'accepted', accepted_at: new Date().toISOString() })
      .eq('id', inv.id);

    if (inviteUpdate.error) {
      this.logger.error(
        'Failed to mark invitation accepted:',
        inviteUpdate.error,
      );
      throw new BadRequestException('Failed to accept invitation');
    }

    await this.updateNotificationActionStatus(notificationId, 'accepted', true);

    void this.auditLogsService.logAction(
      orgId,
      userId,
      'notification',
      notificationId,
      'update',
      {
        action_status: 'accepted',
        invitation_id: inv.id,
        space_id: inv.space_id,
      },
    );

    return { success: true, action: 'accepted', space_id: inv.space_id };
  }

  /** @private */
  private async declineSpaceInvitation(
    notificationId: string,
    userId: string,
    orgId: string,
    inv: InvitationRow,
  ): Promise<{ success: true; action: string; space_id: string | null }> {
    const inviteUpdate = await this.client
      .from('invitations')
      .update({
        status: 'declined',
        declined_at: new Date().toISOString(),
      })
      .eq('id', inv.id);

    if (inviteUpdate.error) {
      this.logger.error(
        'Failed to mark invitation declined:',
        inviteUpdate.error,
      );
      throw new BadRequestException('Failed to decline invitation');
    }

    await this.updateNotificationActionStatus(notificationId, 'declined', true);

    void this.auditLogsService.logAction(
      orgId,
      userId,
      'notification',
      notificationId,
      'update',
      {
        action_status: 'declined',
        invitation_id: inv.id,
        space_id: inv.space_id,
      },
    );

    return { success: true, action: 'declined', space_id: inv.space_id };
  }

  private buildSpacePermissionData(
    inv: InvitationRow,
    userId: string,
  ): Record<string, unknown> {
    const roleKey = SPACE_ROLE_BASE_PERMISSIONS[inv.space_role ?? 'member']
      ? (inv.space_role ?? 'member')
      : 'member';
    const source =
      inv.space_permissions && Object.keys(inv.space_permissions).length > 0
        ? inv.space_permissions
        : SPACE_ROLE_BASE_PERMISSIONS[roleKey];
    const rawPerms: Record<string, boolean> = {};

    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== 'boolean') continue;
      const flatKey = key.startsWith('can_') ? key.slice(4) : key;
      if (SPACE_PERMISSION_COLUMN_KEYS.has(flatKey)) rawPerms[flatKey] = value;
    }

    const normalized = normalizeSpacePermissions(rawPerms);
    const permData: Record<string, unknown> = {
      space_id: inv.space_id,
      target_type: 'user',
      target_id: userId,
    };

    for (const [key, value] of Object.entries(normalized)) {
      if (SPACE_PERMISSION_COLUMN_KEYS.has(key)) {
        permData[`can_${key}`] = value;
      }
    }

    return permData;
  }

  private async updateNotificationActionStatus(
    notificationId: string,
    status: string,
    isRead: boolean,
  ): Promise<void> {
    const { error } = await this.client
      .from('notifications')
      .update({
        action_status: status,
        is_read: isRead,
        updated_at: new Date().toISOString(),
      })
      .eq('id', notificationId);

    if (error) {
      this.logger.error('Failed to update notification action status:', error);
      throw new BadRequestException('Failed to update notification');
    }
  }

  // ---------------------------------------------------------------------------
  // Notification Preferences
  // ---------------------------------------------------------------------------

  private static readonly PREFERENCE_DEFAULTS: NotificationPreferencesMap = {
    space_invitation: { inApp: true, email: true },
    task_mention: { inApp: true, email: true },
    comment_mention: { inApp: true, email: true },
    attachment_checkout_message: { inApp: true, email: true },
    file_explorer_reminder: { inApp: true, email: true },
    management_letter: { inApp: true, email: true },
    wiki_review: { inApp: true, email: true },
    workflowTransition: { inApp: true, email: true },
    watcher_updates: { inApp: true, email: true },
    calendar_reminder: { inApp: true, email: true },
    chat_mention: { inApp: true, email: true },
    chat_dm: { inApp: true, email: true },
    custom_image_approval: { inApp: true, email: true },
    // Git integration ticket 9: "Development (GitHub, GitLab)" group.
    ...GIT_NOTIFICATION_DEFAULTS,
  };

  /**
   * Returns the merged notification preferences for a user in an org.
   * Missing rows fall back to the default (enabled).
   *
   * @param {string} userId - Authenticated user UUID
   * @param {string} orgId - Organization UUID from JWT
   * @returns {Promise<NotificationPreferencesMap>} Keyed by notification_type
   */
  async getPreferences(
    userId: string,
    orgId: string,
  ): Promise<NotificationPreferencesMap> {
    const { data, error } = await this.client
      .from('notification_preferences')
      .select('notification_type, in_app, email')
      .eq('user_id', userId)
      .eq('organization_id', orgId);

    if (error) {
      this.logger.error('Failed to fetch notification preferences:', error);
      throw new BadRequestException('Failed to fetch notification preferences');
    }

    const rows = (data ?? []) as NotificationPreferenceRow[];
    const result: NotificationPreferencesMap = {
      ...NotificationsService.PREFERENCE_DEFAULTS,
    };

    // Only apply DB rows for types still in PREFERENCE_DEFAULTS — prevents old
    // rows for types no longer offered from suppressing delivery. Note that
    // `workflowTransition` IS offered again as of the dispatcher honouring it,
    // so any pre-existing row for it now takes effect rather than being ignored.
    const knownTypes = new Set(
      Object.keys(NotificationsService.PREFERENCE_DEFAULTS),
    );

    for (const row of rows) {
      if (knownTypes.has(row.notification_type)) {
        result[row.notification_type] = {
          inApp: row.in_app,
          email: row.email,
        };
      }
    }

    return result;
  }

  /**
   * Upserts a single notification preference for a user.
   *
   * @param {string} userId - Authenticated user UUID
   * @param {string} orgId - Organization UUID from JWT
   * @param {UpsertNotificationPreferenceDto} dto - Type + in_app value
   * @returns {Promise<NotificationPreferencesMap>} Full updated preferences map
   */
  async upsertPreference(
    userId: string,
    orgId: string,
    dto: UpsertNotificationPreferenceDto,
  ): Promise<NotificationPreferencesMap> {
    const defaults = NotificationsService.PREFERENCE_DEFAULTS[
      dto.notification_type
    ] ?? { inApp: true, email: true };
    const patch = {
      ...(dto.in_app === undefined ? {} : { in_app: dto.in_app }),
      ...(dto.email === undefined ? {} : { email: dto.email }),
      updated_at: new Date().toISOString(),
    };
    const updateExisting = () =>
      this.client
        .from('notification_preferences')
        .update(patch)
        .eq('user_id', userId)
        .eq('organization_id', orgId)
        .eq('notification_type', dto.notification_type)
        .select('notification_type')
        .maybeSingle();

    let { data, error } = await updateExisting();
    if (!error && !data) {
      const inserted = await this.client
        .from('notification_preferences')
        .insert({
          user_id: userId,
          organization_id: orgId,
          notification_type: dto.notification_type,
          in_app: dto.in_app ?? defaults.inApp,
          email: dto.email ?? defaults.email,
          updated_at: patch.updated_at,
        });

      if (inserted.error?.code === '23505') {
        ({ data, error } = await updateExisting());
        if (!data && !error) {
          this.logger.error(
            'Notification preference row disappeared during conflict retry',
          );
          throw new BadRequestException(
            'Failed to update notification preference',
          );
        }
      } else {
        error = inserted.error;
      }
    }

    if (error) {
      this.logger.error('Failed to update notification preference:', error);
      throw new BadRequestException('Failed to update notification preference');
    }

    return this.getPreferences(userId, orgId);
  }
}
