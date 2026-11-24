/**
 * @fileoverview chat_message attachments: access is delegated to ChatAccessService, check-out /
 * check-in are refused, and every other entity type keeps its space-permission path.
 * @module src/attachments/attachments.chat-message-access.spec
 */

import { ForbiddenException } from '@nestjs/common';

import { AttachmentsService } from './attachments.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { ChatAccessService } from '../chat/chat-access.service';
import type { ChatRealtimeService } from '../chat/chat-realtime.service';

const USER = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'u@test',
  memberships: [],
} as unknown as Parameters<AttachmentsService['getDownloadInfo']>[0]['user'];

const CHAT_CTX = {
  organizationId: 'org-1',
  spaceId: null,
  ownerId: 'user-1',
  conversationId: 'conv-1',
};

const chatAttachment = {
  id: 'att-1',
  organization_id: 'org-1',
  space_id: null,
  entity_type: 'chat_message',
  entity_id: 'msg-1',
  file_name: 'a.pdf',
  current_version_id: 'v-1',
  checked_out_by: null,
};

function harness(options: { withChat?: boolean; row?: unknown } = {}) {
  const resolved = {
    data: options.row ?? { organization_id: 'org-1', space_id: 'space-1' },
    error: null,
  };
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const method of ['select', 'eq', 'is', 'not', 'order', 'update']) {
    chain[method] = jest.fn().mockImplementation(self);
  }
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled);

  const from = jest.fn(() => chain);
  const permissions = {
    getUserSpacePermissions: jest.fn().mockResolvedValue({
      isMember: true,
      spaceRole: 'member',
      globalRole: null,
      permissions: { view_tasks: true },
    }),
  };
  const chatAccess = {
    resolveAttachmentAccess: jest.fn().mockResolvedValue(CHAT_CTX),
  };
  const chatRealtime = {
    messageUpdated: jest.fn().mockResolvedValue(undefined),
  };

  const service = new AttachmentsService(
    {
      getClient: () => ({ from, storage: { from: jest.fn(() => ({})) } }),
    } as unknown as SupabaseAdminService,
    permissions as unknown as PermissionsService,
    {
      logAction: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditLogsService,
    undefined,
    undefined,
    undefined,
    undefined,
    options.withChat === false
      ? undefined
      : (chatAccess as unknown as ChatAccessService),
    chatRealtime as unknown as ChatRealtimeService,
  );

  return { service, from, permissions, chatAccess, chatRealtime };
}

/** Private members, for stubbing the storage half of an upload. */
type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

describe('chat_message attachments', () => {
  it('delegates view access to ChatAccessService instead of a space permission', async () => {
    const h = harness({ row: [] });

    await h.service.listForEntity({
      user: USER,
      entityType: 'chat_message',
      entityId: 'msg-1',
    });

    expect(h.chatAccess.resolveAttachmentAccess).toHaveBeenCalledWith(
      USER,
      'msg-1',
      'view',
    );
    expect(h.permissions.getUserSpacePermissions).not.toHaveBeenCalled();
    expect(h.from).not.toHaveBeenCalledWith('chat_messages');
  });

  it('propagates the chat access refusal', async () => {
    const h = harness();
    h.chatAccess.resolveAttachmentAccess.mockRejectedValue(
      new ForbiddenException('not the author'),
    );

    await expect(
      h.service.listForEntity({
        user: USER,
        entityType: 'chat_message',
        entityId: 'msg-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed when ChatAccessService is unavailable', async () => {
    const h = harness({ withChat: false });

    await expect(
      h.service.listForEntity({
        user: USER,
        entityType: 'chat_message',
        entityId: 'msg-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('uploads with the chat context and signals message.updated', async () => {
    const h = harness();
    const internals = h.service as unknown as Internals;
    const created = { ...chatAttachment, current_version_id: null };
    jest
      .spyOn(internals, 'findAttachmentByEntityAndName')
      .mockResolvedValue(null);
    const create = jest
      .spyOn(internals, 'createAttachment')
      .mockResolvedValue(created);
    jest
      .spyOn(internals, 'uploadVersionWithRetry')
      .mockResolvedValue({ version: { id: 'v-1', version_number: 1 } });
    jest
      .spyOn(internals, 'findAttachmentById')
      .mockResolvedValue(chatAttachment);

    await h.service.upload({
      user: USER,
      entityType: 'chat_message',
      entityId: 'msg-1',
      file: {
        originalname: 'a.pdf',
        size: 10,
        mimetype: 'application/pdf',
      } as Express.Multer.File,
    });

    expect(h.chatAccess.resolveAttachmentAccess).toHaveBeenCalledWith(
      USER,
      'msg-1',
      'upload',
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 'org-1',
        space_id: null,
        entity_type: 'chat_message',
        entity_id: 'msg-1',
      }),
    );
    expect(h.chatRealtime.messageUpdated).toHaveBeenCalledWith(
      'conv-1',
      'msg-1',
    );
  });

  it('refuses check-out and check-in with 403', async () => {
    const h = harness();
    jest
      .spyOn(h.service as unknown as Internals, 'findAttachmentById')
      .mockResolvedValue(chatAttachment);

    await expect(
      h.service.checkOut({ attachmentId: 'att-1', user: USER }),
    ).rejects.toThrow('not supported for chat attachments');
    await expect(
      h.service.checkIn({ attachmentId: 'att-1', user: USER }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('leaves other entity types on the space-permission path', async () => {
    const h = harness();

    await h.service.listForEntity({
      user: USER,
      entityType: 'task',
      entityId: 'task-1',
    });

    expect(h.permissions.getUserSpacePermissions).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      'space-1',
    );
    expect(h.chatAccess.resolveAttachmentAccess).not.toHaveBeenCalled();
  });
});
