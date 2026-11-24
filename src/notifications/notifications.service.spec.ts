/**
 * @fileoverview Unit tests for NotificationsService — list with filters,
 * mark single/all read with ownership checks, and the accept/decline flow
 * for space_invitation notifications.
 * @module src/notifications/notifications.service.spec
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let mockFrom: jest.Mock;

  const USER = 'user-1';
  const ORG = 'org-1';

  const mockNotification = {
    id: 'notif-1',
    organization_id: ORG,
    user_id: USER,
    type: 'space_invitation',
    title: "You've been invited",
    body: null,
    is_read: false,
    action_status: 'pending',
    reference_type: 'invitation',
    reference_id: 'inv-1',
    metadata: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };

  const mockInvitation = {
    id: 'inv-1',
    status: 'pending',
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    space_id: 'space-1',
    space_role: 'member',
    space_permissions: null,
    invited_by: 'admin-1',
    organization_id: ORG,
  };

  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    service = new NotificationsService(supa, {
      logAction: jest.fn().mockResolvedValue(undefined),
    } as never);
  });

  // ── getUserNotifications ───────────────────────────────────────────────

  describe('getUserNotifications', () => {
    it('returns paginated notifications', async () => {
      const chain = buildChain({
        data: [mockNotification],
        error: null,
        count: 1,
      });
      mockFrom.mockReturnValue(chain);

      const r = await service.getUserNotifications(USER, ORG, {});

      expect(r.data).toHaveLength(1);
      expect(r.total).toBe(1);
      expect(mockFrom).toHaveBeenCalledWith('notifications');
    });

    it('filters to unread when unread_only=true', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValue(chain);

      await service.getUserNotifications(USER, ORG, { unread_only: 'true' });

      const eqCalls = (chain.eq as jest.Mock).mock.calls.map((c) => [
        (c as unknown[])[0],
        (c as unknown[])[1],
      ]);
      expect(eqCalls).toEqual(expect.arrayContaining([['is_read', false]]));
    });

    it('caps limit at 100 and clamps offset to 0', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValue(chain);

      await service.getUserNotifications(USER, ORG, {
        limit: '500',
        offset: '-99',
      });

      expect(chain.range).toHaveBeenCalledWith(0, 99);
    });

    it('throws BadRequest when DB errors', async () => {
      const chain = buildChain({
        data: null,
        error: { message: 'boom' },
        count: 0,
      });
      mockFrom.mockReturnValue(chain);

      await expect(service.getUserNotifications(USER, ORG, {})).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── markAsRead ─────────────────────────────────────────────────────────

  describe('markAsRead', () => {
    it('updates the notification when caller owns it', async () => {
      const fetchChain = buildChain({ data: mockNotification, error: null });
      const updated = { ...mockNotification, is_read: true };
      const updateChain = buildChain({ data: updated, error: null });
      mockFrom.mockReturnValueOnce(fetchChain).mockReturnValueOnce(updateChain);

      const r = await service.markAsRead('notif-1', USER, ORG, {
        is_read: true,
      });

      expect(r).toEqual(updated);
    });

    it('throws NotFound when notification does not exist', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      await expect(
        service.markAsRead('missing', USER, ORG, { is_read: true }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws Forbidden when user does not own the notification', async () => {
      const fetchChain = buildChain({
        data: { ...mockNotification, user_id: 'other-user' },
        error: null,
      });
      mockFrom.mockReturnValue(fetchChain);

      await expect(
        service.markAsRead('notif-1', USER, ORG, { is_read: true }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequest when the update step fails', async () => {
      const fetchChain = buildChain({ data: mockNotification, error: null });
      const updateChain = buildChain({
        data: null,
        error: { message: 'update fail' },
      });
      mockFrom.mockReturnValueOnce(fetchChain).mockReturnValueOnce(updateChain);

      await expect(
        service.markAsRead('notif-1', USER, ORG, { is_read: true }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── markAllAsRead ──────────────────────────────────────────────────────

  describe('markAllAsRead', () => {
    it('marks all unread for user+org as read', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      const r = await service.markAllAsRead(USER, ORG);

      expect(r).toEqual({ success: true });
      expect(chain.update).toHaveBeenCalled();
    });

    it('throws BadRequest when DB errors', async () => {
      const chain = buildChain({
        data: null,
        error: { message: 'db down' },
      });
      mockFrom.mockReturnValue(chain);

      await expect(service.markAllAsRead(USER, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── handleAction (accept/decline) ──────────────────────────────────────

  describe('handleAction', () => {
    it('rejects when notification is missing', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      await expect(
        service.handleAction('missing', USER, ORG, { action: 'accept' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects when caller is not the notification owner', async () => {
      const fetchChain = buildChain({
        data: { ...mockNotification, user_id: 'other' },
        error: null,
      });
      mockFrom.mockReturnValue(fetchChain);

      await expect(
        service.handleAction('notif-1', USER, ORG, { action: 'accept' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects when action is already processed', async () => {
      const fetchChain = buildChain({
        data: { ...mockNotification, action_status: 'accepted' },
        error: null,
      });
      mockFrom.mockReturnValue(fetchChain);

      await expect(
        service.handleAction('notif-1', USER, ORG, { action: 'accept' }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects when notification type is not supported', async () => {
      const fetchChain = buildChain({
        data: { ...mockNotification, type: 'comment_mention' },
        error: null,
      });
      mockFrom.mockReturnValue(fetchChain);

      await expect(
        service.handleAction('notif-1', USER, ORG, { action: 'accept' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when notification has no reference_id', async () => {
      const fetchChain = buildChain({
        data: { ...mockNotification, reference_id: null },
        error: null,
      });
      mockFrom.mockReturnValue(fetchChain);

      await expect(
        service.handleAction('notif-1', USER, ORG, { action: 'accept' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFound when invitation row is missing', async () => {
      const fetchChain = buildChain({ data: mockNotification, error: null });
      const invChain = buildChain({ data: null, error: null });
      const notifUpdateChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(fetchChain)
        .mockReturnValueOnce(invChain)
        .mockReturnValueOnce(notifUpdateChain);

      await expect(
        service.handleAction('notif-1', USER, ORG, { action: 'accept' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequest when invitation is not pending', async () => {
      const fetchChain = buildChain({ data: mockNotification, error: null });
      const invChain = buildChain({
        data: { ...mockInvitation, status: 'accepted' },
        error: null,
      });
      const notifUpdateChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(fetchChain)
        .mockReturnValueOnce(invChain)
        .mockReturnValueOnce(notifUpdateChain);

      await expect(
        service.handleAction('notif-1', USER, ORG, { action: 'accept' }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects expired invitations and flips status to expired', async () => {
      const fetchChain = buildChain({ data: mockNotification, error: null });
      const invChain = buildChain({
        data: {
          ...mockInvitation,
          expires_at: new Date(Date.now() - 1000).toISOString(),
        },
        error: null,
      });
      const expireUpdateChain = buildChain({ data: null, error: null });
      const notifUpdateChain = buildChain({ data: null, error: null });
      mockFrom
        .mockReturnValueOnce(fetchChain)
        .mockReturnValueOnce(invChain)
        .mockReturnValueOnce(expireUpdateChain)
        .mockReturnValueOnce(notifUpdateChain);

      await expect(
        service.handleAction('notif-1', USER, ORG, { action: 'accept' }),
      ).rejects.toThrow(GoneException);
    });

    describe('accept', () => {
      it('inserts space_members and marks invitation accepted', async () => {
        const notifChain = buildChain({
          data: mockNotification,
          error: null,
        });
        const invChain = buildChain({ data: mockInvitation, error: null });
        const existingMemberChain = buildChain({ data: null, error: null });
        const memberInsertChain = buildChain({ data: null, error: null });
        const existingPermChain = buildChain({ data: null, error: null });
        const insertPermChain = buildChain({ data: null, error: null });
        const inviteUpdateChain = buildChain({ data: null, error: null });
        const notifUpdateChain = buildChain({ data: null, error: null });
        mockFrom
          .mockReturnValueOnce(notifChain) // notification fetch
          .mockReturnValueOnce(invChain) // invitation fetch
          .mockReturnValueOnce(existingMemberChain) // existing member check
          .mockReturnValueOnce(memberInsertChain) // space_members insert
          .mockReturnValueOnce(existingPermChain) // existing permissions check
          .mockReturnValueOnce(insertPermChain) // space_permissions insert
          .mockReturnValueOnce(inviteUpdateChain) // invitations update
          .mockReturnValueOnce(notifUpdateChain); // notifications update

        const r = await service.handleAction('notif-1', USER, ORG, {
          action: 'accept',
        });

        expect(r).toEqual({
          success: true,
          action: 'accepted',
          space_id: 'space-1',
        });
      });

      it('rejects accept when invitation has no space_id', async () => {
        const notifChain = buildChain({
          data: mockNotification,
          error: null,
        });
        const invChain = buildChain({
          data: { ...mockInvitation, space_id: null },
          error: null,
        });
        mockFrom.mockReturnValueOnce(notifChain).mockReturnValueOnce(invChain);

        await expect(
          service.handleAction('notif-1', USER, ORG, { action: 'accept' }),
        ).rejects.toThrow(BadRequestException);
      });

      it('upserts space_permissions when invitation carries custom perms (existing row)', async () => {
        const notifChain = buildChain({
          data: mockNotification,
          error: null,
        });
        const invChain = buildChain({
          data: {
            ...mockInvitation,
            space_permissions: { can_view: true, can_edit: false },
          },
          error: null,
        });
        const existingMemberChain = buildChain({ data: null, error: null });
        const memberInsertChain = buildChain({ data: null, error: null });
        const existingPermChain = buildChain({
          data: { id: 'perm-1' },
          error: null,
        });
        const updatePermChain = buildChain({ data: null, error: null });
        const inviteUpdateChain = buildChain({ data: null, error: null });
        const notifUpdateChain = buildChain({ data: null, error: null });

        mockFrom
          .mockReturnValueOnce(notifChain)
          .mockReturnValueOnce(invChain)
          .mockReturnValueOnce(existingMemberChain)
          .mockReturnValueOnce(memberInsertChain)
          .mockReturnValueOnce(existingPermChain)
          .mockReturnValueOnce(updatePermChain)
          .mockReturnValueOnce(inviteUpdateChain)
          .mockReturnValueOnce(notifUpdateChain);

        const r = await service.handleAction('notif-1', USER, ORG, {
          action: 'accept',
        });
        expect(r.action).toBe('accepted');
        expect(updatePermChain.update).toHaveBeenCalled();
      });

      it('inserts space_permissions when no existing row', async () => {
        const notifChain = buildChain({
          data: mockNotification,
          error: null,
        });
        const invChain = buildChain({
          data: {
            ...mockInvitation,
            space_permissions: { can_view: true },
          },
          error: null,
        });
        const existingMemberChain = buildChain({ data: null, error: null });
        const memberInsertChain = buildChain({ data: null, error: null });
        const existingPermChain = buildChain({ data: null, error: null });
        const insertPermChain = buildChain({ data: null, error: null });
        const inviteUpdateChain = buildChain({ data: null, error: null });
        const notifUpdateChain = buildChain({ data: null, error: null });

        mockFrom
          .mockReturnValueOnce(notifChain)
          .mockReturnValueOnce(invChain)
          .mockReturnValueOnce(existingMemberChain)
          .mockReturnValueOnce(memberInsertChain)
          .mockReturnValueOnce(existingPermChain)
          .mockReturnValueOnce(insertPermChain)
          .mockReturnValueOnce(inviteUpdateChain)
          .mockReturnValueOnce(notifUpdateChain);

        const r = await service.handleAction('notif-1', USER, ORG, {
          action: 'accept',
        });
        expect(r.action).toBe('accepted');
        expect(insertPermChain.insert).toHaveBeenCalled();
      });

      it('throws BadRequest when adding space_members fails', async () => {
        const notifChain = buildChain({
          data: mockNotification,
          error: null,
        });
        const invChain = buildChain({ data: mockInvitation, error: null });
        const existingMemberChain = buildChain({ data: null, error: null });
        const memberInsertChain = buildChain({
          data: null,
          error: { message: 'fk violation' },
        });
        mockFrom
          .mockReturnValueOnce(notifChain)
          .mockReturnValueOnce(invChain)
          .mockReturnValueOnce(existingMemberChain)
          .mockReturnValueOnce(memberInsertChain);

        await expect(
          service.handleAction('notif-1', USER, ORG, { action: 'accept' }),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('decline', () => {
      it('marks invitation declined and notification action_status=declined', async () => {
        const notifChain = buildChain({
          data: mockNotification,
          error: null,
        });
        const invChain = buildChain({ data: mockInvitation, error: null });
        const inviteUpdateChain = buildChain({ data: null, error: null });
        const notifUpdateChain = buildChain({ data: null, error: null });

        mockFrom
          .mockReturnValueOnce(notifChain)
          .mockReturnValueOnce(invChain)
          .mockReturnValueOnce(inviteUpdateChain)
          .mockReturnValueOnce(notifUpdateChain);

        const r = await service.handleAction('notif-1', USER, ORG, {
          action: 'decline',
        });

        expect(r).toEqual({
          success: true,
          action: 'declined',
          space_id: 'space-1',
        });
      });
    });
  });

  // ── upsertPreference (email channel) ───────────────────────────────────
  describe('watcher preference', () => {
    it('defaults both watcher-update channels to enabled', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: [], error: null }));

      await expect(service.getPreferences(USER, ORG)).resolves.toMatchObject({
        watcher_updates: { inApp: true, email: true },
      });
    });

    it('offers the chat preferences, on by default and switchable', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: [{ notification_type: 'chat_dm', in_app: true, email: false }],
          error: null,
        }),
      );

      await expect(service.getPreferences(USER, ORG)).resolves.toMatchObject({
        chat_mention: { inApp: true, email: true },
        chat_dm: { inApp: true, email: false },
      });
    });
  });

  describe('git development preferences (ticket 9)', () => {
    it('offers the four types with their defaults: email only for failed builds, "linked" opt-in', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: [], error: null }));

      await expect(service.getPreferences(USER, ORG)).resolves.toMatchObject({
        git_pr_merged: { inApp: true, email: false },
        git_build_failed: { inApp: true, email: true },
        git_build_fixed: { inApp: true, email: false },
        git_pr_linked: { inApp: false, email: false },
      });
    });

    it('a stored row overrides the default', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: [
            {
              notification_type: 'git_build_failed',
              in_app: false,
              email: false,
            },
          ],
          error: null,
        }),
      );

      await expect(service.getPreferences(USER, ORG)).resolves.toMatchObject({
        git_build_failed: { inApp: false, email: false },
      });
    });
  });

  describe('upsertPreference', () => {
    it('updates only the supplied channel when the row exists', async () => {
      const existing = buildChain({
        data: { notification_type: 'task_mention' },
        error: null,
      });
      const getPrefs = buildChain({
        data: [
          { notification_type: 'task_mention', in_app: false, email: false },
        ],
        error: null,
      });

      mockFrom
        .mockReturnValueOnce(existing) // partial update
        .mockReturnValueOnce(getPrefs); // getPreferences refetch

      const result = await service.upsertPreference(USER, ORG, {
        notification_type: 'task_mention',
        email: false,
      });

      expect(existing.update).toHaveBeenCalledWith(
        expect.objectContaining({ email: false }),
      );
      expect(existing.update).toHaveBeenCalledWith(
        expect.not.objectContaining({ in_app: expect.anything() }),
      );
      expect(result.task_mention).toEqual({ inApp: false, email: false });
    });

    it('defaults the missing channel from PREFERENCE_DEFAULTS when no row exists', async () => {
      const updateMissing = buildChain({ data: null, error: null });
      const insert = buildChain({ data: null, error: null });
      const getPrefs = buildChain({
        data: [
          { notification_type: 'task_mention', in_app: false, email: true },
        ],
        error: null,
      });

      mockFrom
        .mockReturnValueOnce(updateMissing)
        .mockReturnValueOnce(insert)
        .mockReturnValueOnce(getPrefs);

      await service.upsertPreference(USER, ORG, {
        notification_type: 'task_mention',
        in_app: false,
      });

      expect(insert.insert).toHaveBeenCalledWith(
        expect.objectContaining({ in_app: false, email: true }),
      );
    });

    it('retries the partial update when a concurrent insert wins', async () => {
      const updateMissing = buildChain({ data: null, error: null });
      const insertConflict = buildChain({
        data: null,
        error: { code: '23505', message: 'duplicate' },
      });
      const retryUpdate = buildChain({
        data: { notification_type: 'watcher_updates' },
        error: null,
      });
      const getPrefs = buildChain({
        data: [
          {
            notification_type: 'watcher_updates',
            in_app: false,
            email: false,
          },
        ],
        error: null,
      });

      mockFrom
        .mockReturnValueOnce(updateMissing)
        .mockReturnValueOnce(insertConflict)
        .mockReturnValueOnce(retryUpdate)
        .mockReturnValueOnce(getPrefs);

      await expect(
        service.upsertPreference(USER, ORG, {
          notification_type: 'watcher_updates',
          email: false,
        }),
      ).resolves.toMatchObject({
        watcher_updates: { inApp: false, email: false },
      });
      expect(retryUpdate.update).toHaveBeenCalledWith(
        expect.objectContaining({ email: false }),
      );
    });
  });
});
