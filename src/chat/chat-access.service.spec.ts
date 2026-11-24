import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../permissions/permissions.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { ChatAccessService } from './chat-access.service';

/** Thenable query double: every builder call returns itself and records it. */
function chain(result: { data: unknown; error?: unknown }) {
  const calls: Array<[string, unknown[]]> = [];
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'then') {
          return (
            resolve: (v: unknown) => unknown,
            reject: (e: unknown) => unknown,
          ) =>
            Promise.resolve({ error: null, ...result }).then(resolve, reject);
        }
        if (prop === 'calls') return calls;
        return (...args: unknown[]) => {
          calls.push([prop, args]);
          return proxy;
        };
      },
    },
  );
  return proxy as Record<string, unknown> & {
    calls: Array<[string, unknown[]]>;
  };
}

describe('ChatAccessService', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;
  const dm = {
    id: 'conv-1',
    organization_id: 'org-1',
    kind: 'dm',
    space_id: null,
    archived_at: null,
  };
  const channel = {
    id: 'conv-2',
    organization_id: 'org-1',
    kind: 'space',
    space_id: 'space-1',
    archived_at: null,
  };

  let queues: Record<string, ReturnType<typeof chain>[]>;
  let getViewableSpaceIds: jest.Mock;
  /** Organization-level keys: everyone holds every key unless a test says otherwise. */
  let checkPermission: jest.Mock;
  let service: ChatAccessService;

  const queue = (table: string, ...results: { data: unknown }[]) => {
    queues[table] = [...(queues[table] ?? []), ...results.map((r) => chain(r))];
  };

  beforeEach(() => {
    queues = {};
    getViewableSpaceIds = jest.fn();
    checkPermission = jest.fn().mockResolvedValue(true);
    const from = jest.fn((table: string) => {
      const next = queues[table]?.shift();
      if (!next) throw new Error(`unexpected query on ${table}`);
      return next;
    });
    service = new ChatAccessService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {
        getViewableSpaceIds,
        checkPermission,
      } as unknown as PermissionsService,
    );
  });

  it('always scopes the conversation lookup to the caller organization', async () => {
    queue('chat_conversations', { data: dm });
    queue('chat_members', { data: { user_id: 'user-1', history_from_seq: 0 } });
    const convQuery = queues.chat_conversations[0];

    await service.getReadable(user, 'conv-1');

    expect(convQuery.calls).toContainEqual([
      'eq',
      ['organization_id', 'org-1'],
    ]);
  });

  it('scopes the membership lookup and the reader filter to the organization too', async () => {
    queue('chat_conversations', { data: dm });
    queue(
      'chat_members',
      { data: { user_id: 'user-1', history_from_seq: 0 } },
      { data: [{ user_id: 'u2' }] },
    );
    const [membershipQuery, readersQuery] = queues.chat_members;

    await service.getReadable(user, 'conv-1');
    await service.filterReaders(dm as never, ['u2']);

    for (const query of [membershipQuery, readersQuery]) {
      expect(query.calls).toContainEqual(['eq', ['organization_id', 'org-1']]);
    }
  });

  it('answers 404 for a conversation of another tenant (lookup finds nothing)', async () => {
    queue('chat_conversations', { data: null });

    await expect(service.getReadable(user, 'conv-x')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('answers 404 (not 403) to a DM non-member so existence does not leak', async () => {
    queue('chat_conversations', { data: dm });
    queue('chat_members', { data: null });

    await expect(service.getReadable(user, 'conv-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('lets a DM member read and reports their history cut-off', async () => {
    queue('chat_conversations', { data: dm });
    queue('chat_members', { data: { user_id: 'user-1', history_from_seq: 7 } });

    await expect(service.getReadable(user, 'conv-1')).resolves.toMatchObject({
      historyFromSeq: 7,
    });
  });

  it('opens a space channel only when the space is viewable', async () => {
    queue(
      'chat_conversations',
      { data: channel },
      { data: channel },
      { data: channel },
    );
    queue('chat_members', { data: null }, { data: null }, { data: null });

    getViewableSpaceIds.mockResolvedValueOnce(['space-1']);
    await expect(service.getReadable(user, 'conv-2')).resolves.toMatchObject({
      membership: null,
      historyFromSeq: 0,
    });

    getViewableSpaceIds.mockResolvedValueOnce(null); // org owner/admin sees every space
    await expect(service.getReadable(user, 'conv-2')).resolves.toBeDefined();

    getViewableSpaceIds.mockResolvedValueOnce([]);
    await expect(service.getReadable(user, 'conv-2')).rejects.toThrow(
      NotFoundException,
    );
    expect(getViewableSpaceIds).toHaveBeenLastCalledWith('user-1', 'org-1', [
      'space-1',
    ]);
  });

  it('hides a message before the member history cut-off', async () => {
    queue('chat_messages', {
      data: { id: 'm1', conversation_id: 'conv-1', seq: 3 },
    });
    queue('chat_conversations', { data: dm });
    queue('chat_members', { data: { user_id: 'user-1', history_from_seq: 5 } });

    await expect(service.getReadableMessage(user, 'm1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('refuses writes to archived conversations and archived or deleting spaces', async () => {
    await expect(
      service.assertWritable({
        conversation: { ...dm, archived_at: '2026-01-01' },
        membership: null,
        historyFromSeq: 0,
      } as never),
    ).rejects.toThrow(ForbiddenException);

    queue('spaces', { data: { is_archived: true, deleting_at: null } });
    await expect(
      service.assertWritable({
        conversation: channel,
        membership: null,
        historyFromSeq: 0,
      } as never),
    ).rejects.toThrow(ForbiddenException);

    queue('spaces', { data: { is_archived: false, deleting_at: null } });
    await expect(
      service.assertWritable({
        conversation: channel,
        membership: null,
        historyFromSeq: 0,
      } as never),
    ).resolves.toBeUndefined();
  });

  it('filters mention recipients to people who can read the conversation', async () => {
    queue('chat_members', { data: [{ user_id: 'u2' }] });
    await expect(
      service.filterReaders(dm as never, ['u2', 'u3']),
    ).resolves.toEqual(['u2']);

    getViewableSpaceIds
      .mockResolvedValueOnce(['space-1'])
      .mockResolvedValueOnce([]);
    await expect(
      service.filterReaders(channel as never, ['u2', 'u3']),
    ).resolves.toEqual(['u2']);
  });

  it('counts nobody as a reader who may not use chat: every chat route answers them 403', async () => {
    checkPermission.mockImplementation((userId: string) =>
      Promise.resolve(userId !== 'u3'),
    );

    queue('chat_members', { data: [{ user_id: 'u2' }, { user_id: 'u3' }] });
    await expect(
      service.filterReaders(dm as never, ['u2', 'u3']),
    ).resolves.toEqual(['u2']);
    expect(checkPermission).toHaveBeenCalledWith('u3', 'org-1', 'can_use_chat');

    getViewableSpaceIds.mockResolvedValue(['space-1']);
    await expect(
      service.filterReaders(channel as never, ['u2', 'u3']),
    ).resolves.toEqual(['u2']);
  });

  describe('resolveAttachmentAccess', () => {
    const message = (overrides: Record<string, unknown> = {}) => ({
      id: 'm1',
      organization_id: 'org-1',
      conversation_id: 'conv-2',
      seq: 3,
      kind: 'user',
      author_id: 'user-1',
      deleted_at: null,
      ...overrides,
    });
    /** Organization-level keys the caller holds (checkPermission double). */
    let granted: string[];
    let checkPermission: jest.Mock;
    let assertWritable: jest.SpyInstance;
    let svc: ChatAccessService;

    const readable = (overrides: Record<string, unknown> = {}) =>
      jest.spyOn(svc, 'getReadableMessage').mockResolvedValue({
        message: message(overrides),
        access: { conversation: channel, membership: null, historyFromSeq: 0 },
      } as never);

    beforeEach(() => {
      granted = ['can_use_chat'];
      checkPermission = jest.fn(
        (_userId: string, _organizationId: string, key: string) =>
          Promise.resolve(granted.includes(key)),
      );
      const from = jest.fn((table: string) => {
        const next = queues[table]?.shift();
        if (!next) throw new Error(`unexpected query on ${table}`);
        return next;
      });
      svc = new ChatAccessService(
        { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
        {
          getViewableSpaceIds,
          checkPermission,
        } as unknown as PermissionsService,
      );
      assertWritable = jest
        .spyOn(svc, 'assertWritable')
        .mockResolvedValue(undefined);
    });

    it('answers 404 for a message of another tenant', async () => {
      queue('chat_messages', { data: null });

      await expect(
        svc.resolveAttachmentAccess(user, 'm-x', 'view'),
      ).rejects.toThrow(NotFoundException);
    });

    it('view: any reader of a live message, with the channel space as spaceId', async () => {
      readable({ author_id: 'someone-else' });

      await expect(
        svc.resolveAttachmentAccess(user, 'm1', 'view'),
      ).resolves.toEqual({
        organizationId: 'org-1',
        spaceId: 'space-1',
        ownerId: 'someone-else',
        conversationId: 'conv-2',
      });
    });

    it('view: 404 once the message is deleted', async () => {
      readable({ deleted_at: '2026-10-01T00:00:00Z' });

      await expect(
        svc.resolveAttachmentAccess(user, 'm1', 'view'),
      ).rejects.toThrow(NotFoundException);
    });

    it('upload: only the author, on a live user message, in a writable conversation', async () => {
      readable();
      await expect(
        svc.resolveAttachmentAccess(user, 'm1', 'upload'),
      ).resolves.toMatchObject({ conversationId: 'conv-2' });
      expect(assertWritable).toHaveBeenCalled();

      for (const overrides of [
        { author_id: 'someone-else' },
        { kind: 'system' },
        { deleted_at: '2026-10-01T00:00:00Z' },
      ]) {
        readable(overrides);
        await expect(
          svc.resolveAttachmentAccess(user, 'm1', 'upload'),
        ).rejects.toThrow(ForbiddenException);
      }
    });

    it('delete: the author, or anyone holding can_delete_any_chat_message', async () => {
      readable();
      await expect(
        svc.resolveAttachmentAccess(user, 'm1', 'delete'),
      ).resolves.toBeDefined();
      expect(checkPermission).not.toHaveBeenCalledWith(
        'user-1',
        'org-1',
        'can_delete_any_chat_message',
      );

      readable({ author_id: 'someone-else' });
      await expect(
        svc.resolveAttachmentAccess(user, 'm1', 'delete'),
      ).rejects.toThrow(ForbiddenException);

      granted.push('can_delete_any_chat_message');
      await expect(
        svc.resolveAttachmentAccess(user, 'm1', 'delete'),
      ).resolves.toBeDefined();
      expect(checkPermission).toHaveBeenCalledWith(
        'user-1',
        'org-1',
        'can_delete_any_chat_message',
      );
    });

    // The attachments controller carries neither the chat permission guard nor
    // @ImpersonationBlocked(), so these two rules live in the service.
    it('refuses every action without can_use_chat, before looking at the message', async () => {
      granted = ['can_delete_any_chat_message'];
      const lookup = readable();

      for (const action of ['view', 'upload', 'delete'] as const) {
        await expect(
          svc.resolveAttachmentAccess(user, 'm1', action),
        ).rejects.toThrow(ForbiddenException);
      }
      expect(lookup).not.toHaveBeenCalled();
    });

    it('refuses upload and delete while impersonating, but still serves the file', async () => {
      const impersonator = {
        ...user,
        impersonation: { writeAccess: true },
      } as RequestUser;
      granted.push('can_delete_any_chat_message');
      readable();

      for (const action of ['upload', 'delete'] as const) {
        await expect(
          svc.resolveAttachmentAccess(impersonator, 'm1', action),
        ).rejects.toThrow('not available during impersonation');
      }
      await expect(
        svc.resolveAttachmentAccess(impersonator, 'm1', 'view'),
      ).resolves.toMatchObject({ conversationId: 'conv-2' });
    });
  });
});
