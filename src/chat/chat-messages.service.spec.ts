import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ROBERT_ID } from '../chat-agent/agent.constants';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { ChatAccessService } from './chat-access.service';
import type { ChatConversationsService } from './chat-conversations.service';
import { ChatMessagesService } from './chat-messages.service';
import type { ChatNotificationsService } from './chat-notifications.service';
import type { ChatRealtimeService } from './chat-realtime.service';
import type { ChatRefsService } from './chat-refs.service';
import { encodeSearchCursor } from './chat-search';

// jsdom-backed DOMPurify is ESM; the real sanitiser has its own spec.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: jest.fn(
    (value: string | null | undefined) =>
      value?.replace(/<script[\s\S]*?<\/script>/gi, '') ?? null,
  ),
}));

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

const U2 = '22222222-2222-4222-8222-222222222222';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'm1',
  organization_id: 'org-1',
  conversation_id: 'conv-1',
  seq: 1,
  kind: 'user',
  author_id: 'user-1',
  body_html: '<p>hi</p>',
  body_text: 'hi',
  thread_root_id: null,
  reply_count: 0,
  last_reply_at: null,
  quoted_message_id: null,
  quote_snapshot: null,
  edit_count: 0,
  edited_at: null,
  deleted_at: null,
  deleted_by: null,
  pinned_at: null,
  pinned_by: null,
  metadata: {},
  created_at: '2026-09-30T10:00:00Z',
  ...overrides,
});

describe('ChatMessagesService', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;
  const conversation = { id: 'conv-1', organization_id: 'org-1', kind: 'dm' };

  let rpc: jest.Mock;
  let from: jest.Mock;
  let tableResults: Record<string, unknown>;
  /** Results handed out one per query of a table, before `tableResults` applies. */
  let tableQueues: Record<string, unknown[]>;
  let access: Record<string, jest.Mock>;
  let onMessage: jest.Mock;
  let onRead: jest.Mock;
  let realtime: Record<string, jest.Mock>;
  let resolveRefs: jest.Mock;
  let labels: jest.Mock;
  let loadUsers: jest.Mock;
  let service: ChatMessagesService;

  /** The [functionName, args] of the n-th rpc call. */
  const rpcCall = (index = 0) =>
    rpc.mock.calls[index] as [string, Record<string, unknown>];

  /** Every query made on a table, in order. */
  const queriesOf = (table: string) =>
    from.mock.calls
      .map(([name], index) => [name, from.mock.results[index].value] as const)
      .filter(([name]) => name === table)
      .map(([, query]) => query as ReturnType<typeof chain>);

  beforeEach(() => {
    tableResults = {};
    tableQueues = {};
    rpc = jest.fn();
    from = jest.fn((table: string) => {
      const queued = tableQueues[table]?.length
        ? tableQueues[table].shift()
        : undefined;

      return chain({ data: queued ?? tableResults[table] ?? [] });
    });
    access = {
      getReadable: jest
        .fn()
        .mockResolvedValue({ conversation, membership: {}, historyFromSeq: 0 }),
      getReadableMessage: jest.fn().mockResolvedValue({
        message: row(),
        access: { conversation, membership: {}, historyFromSeq: 0 },
      }),
      assertWritable: jest.fn().mockResolvedValue(undefined),
      getViewableSpaceIds: jest.fn().mockResolvedValue([]),
      hasPermission: jest.fn().mockResolvedValue(false),
    };
    onMessage = jest.fn().mockResolvedValue(undefined);
    onRead = jest.fn().mockResolvedValue(undefined);
    realtime = {
      messageCreated: jest.fn().mockResolvedValue(undefined),
      messageUpdated: jest.fn().mockResolvedValue(undefined),
      messageDeleted: jest.fn().mockResolvedValue(undefined),
      reactionChanged: jest.fn().mockResolvedValue(undefined),
    };
    resolveRefs = jest.fn().mockResolvedValue({ results: [] });
    labels = jest.fn().mockResolvedValue(new Map());
    loadUsers = jest.fn().mockResolvedValue(new Map());
    service = new ChatMessagesService(
      { getClient: () => ({ from, rpc }) } as unknown as SupabaseAdminService,
      access as unknown as ChatAccessService,
      { onMessage, onRead } as unknown as ChatNotificationsService,
      realtime as unknown as ChatRealtimeService,
      { resolve: resolveRefs } as unknown as ChatRefsService,
      { labels, loadUsers } as unknown as ChatConversationsService,
    );
  });

  describe('send', () => {
    const mentionHtml = `<p>Hi <span data-user-mention data-user-id="${U2}">@Ben</span></p><script>x()</script>`;

    it('sanitises, derives the text server-side and takes the org from the user', async () => {
      rpc.mockResolvedValue({
        data: [{ message_id: 'm1', duplicate: false }],
        error: null,
      });

      await service.send(user, 'conv-1', { id: 'm1', bodyHtml: mentionHtml });

      const [fn, args] = rpcCall();
      expect(fn).toBe('chat_post_message');
      expect(args.p_organization_id).toBe('org-1');
      expect(args.p_author_id).toBe('user-1');
      expect(args.p_body_html).not.toContain('<script>');
      expect(args.p_body_text).toBe('Hi @Ben');
      expect(args.p_refs).toEqual([{ type: 'user', id: U2 }]);
    });

    it('notifies new mentions once, and never on an idempotent resend', async () => {
      rpc.mockResolvedValueOnce({
        data: [{ message_id: 'm1', message_seq: 7, duplicate: false }],
        error: null,
      });
      await service.send(user, 'conv-1', { id: 'm1', bodyHtml: mentionHtml });
      // Ids only: the notification service never receives the message text.
      expect(onMessage.mock.calls).toEqual([
        [user, conversation, { id: 'm1', seq: 7, threadRootId: null }, [U2]],
      ]);

      onMessage.mockClear();
      rpc.mockResolvedValueOnce({
        data: [{ message_id: 'm1', message_seq: 7, duplicate: true }],
        error: null,
      });
      const result = await service.send(user, 'conv-1', {
        id: 'm1',
        bodyHtml: mentionHtml,
      });
      expect(result.duplicate).toBe(true);
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('hands every new message to the notifications, also without a mention (DM, thread reply)', async () => {
      rpc.mockResolvedValue({
        data: [{ message_id: 'm1', message_seq: 9, duplicate: false }],
        error: null,
      });

      await service.send(user, 'conv-1', {
        id: 'm1',
        bodyHtml: '<p>plain</p>',
        threadRootId: 'root-1',
      });

      expect(onMessage.mock.calls).toEqual([
        [user, conversation, { id: 'm1', seq: 9, threadRootId: 'root-1' }, []],
      ]);
    });

    it('ignores malformed mention ids instead of failing the message', async () => {
      rpc.mockResolvedValue({
        data: [{ message_id: 'm1', duplicate: false }],
        error: null,
      });

      await service.send(user, 'conv-1', {
        id: 'm1',
        bodyHtml: '<p><span data-user-id="not-a-uuid">@x</span> hello</p>',
      });

      expect(rpcCall()[1].p_refs).toEqual([]);
    });

    it('passes object references through next to mentions', async () => {
      rpc.mockResolvedValue({
        data: [{ message_id: 'm1', duplicate: false }],
        error: null,
      });
      const taskId = '33333333-3333-4333-8333-333333333333';

      await service.send(user, 'conv-1', {
        id: 'm1',
        bodyHtml: '<p>see this</p>',
        objectRefs: [{ type: 'task', id: taskId }],
      });

      expect(rpcCall()[1].p_refs).toEqual([{ type: 'task', id: taskId }]);
    });

    it('rejects an empty message before touching the database', async () => {
      await expect(
        service.send(user, 'conv-1', {
          id: 'm1',
          bodyHtml: '<p>  </p><script>x()</script>',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('rejects text over 10,000 characters', async () => {
      await expect(
        service.send(user, 'conv-1', {
          id: 'm1',
          bodyHtml: `<p>${'a'.repeat(10001)}</p>`,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it.each(['quotedMessageId', 'threadRootId'] as const)(
      'answers 404 when %s is not readable (history cut-off), before the database function runs',
      async (field) => {
        // A member with cut-off 10 pointing at seq 5: getReadableMessage answers 404.
        access.getReadableMessage.mockRejectedValue(
          new NotFoundException('Message not found'),
        );

        await expect(
          service.send(user, 'conv-1', {
            id: 'm1',
            bodyHtml: '<p>re</p>',
            [field]: 'old-1',
          }),
        ).rejects.toThrow(NotFoundException);
        expect(access.getReadableMessage).toHaveBeenCalledWith(user, 'old-1');
        expect(rpc).not.toHaveBeenCalled();
      },
    );

    it('returns the stored message when two sends of the same id race', async () => {
      // The loser of the race fails on the primary key; asked again, the function
      // finds the winner's row.
      rpc
        .mockResolvedValueOnce({
          data: null,
          error: {
            code: '23505',
            message:
              'duplicate key value violates unique constraint "chat_messages_pkey"',
          },
        })
        .mockResolvedValueOnce({
          data: [{ message_id: 'm1', message_seq: 7, duplicate: true }],
          error: null,
        });

      const result = await service.send(user, 'conv-1', {
        id: 'm1',
        bodyHtml: mentionHtml,
      });

      expect(result.duplicate).toBe(true);
      expect(rpc).toHaveBeenCalledTimes(2);
      expect(rpcCall(1)).toEqual(rpcCall(0));
      expect(onMessage).not.toHaveBeenCalled();
      expect(realtime.messageCreated).not.toHaveBeenCalled();
    });

    it('retries a conflict once only: an id that is really taken stays a 409', async () => {
      rpc.mockResolvedValue({
        data: null,
        error: { code: '23505', message: 'chat: message id already used' },
      });

      await expect(
        service.send(user, 'conv-1', { id: 'm1', bodyHtml: '<p>x</p>' }),
      ).rejects.toThrow(new ConflictException('message id already used'));
      expect(rpc).toHaveBeenCalledTimes(2);
    });
  });

  it.each([true, false])(
    'remove passes can_delete_any_chat_message = %s to the database function',
    async (canDeleteAny) => {
      access.hasPermission.mockResolvedValue(canDeleteAny);
      rpc.mockResolvedValue({ data: true, error: null });

      await service.remove(user, 'm1');

      expect(access.hasPermission).toHaveBeenCalledWith(
        user,
        'can_delete_any_chat_message',
      );
      expect(rpcCall()).toEqual([
        'chat_delete_message',
        {
          p_organization_id: 'org-1',
          p_message_id: 'm1',
          p_actor_id: 'user-1',
          p_can_delete_any: canDeleteAny,
        },
      ]);
    },
  );

  it('edit notifies only the mentions the database reports as new', async () => {
    rpc.mockResolvedValueOnce({ data: [U2], error: null });
    await service.edit(user, 'm1', { bodyHtml: '<p>edited</p>' });
    // The last argument marks an edit: no DM or thread notification is repeated.
    expect(onMessage.mock.calls).toEqual([
      [
        user,
        conversation,
        { id: 'm1', seq: 1, threadRootId: null },
        [U2],
        true,
      ],
    ]);

    onMessage.mockClear();
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await service.edit(user, 'm1', { bodyHtml: '<p>edited again</p>' });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('markRead tells the notifications how far the caller has really read', async () => {
    // Asked for 12, but the database stored 9 (never past the last message).
    rpc.mockResolvedValue({ data: 9, error: null });

    await expect(
      service.markRead(user, 'conv-1', { seq: 12 }),
    ).resolves.toEqual({ lastReadSeq: 9 });
    expect(onRead.mock.calls).toEqual([[user, 'conv-1', 9]]);
  });

  describe('list', () => {
    it('never returns content of a deleted message', async () => {
      tableResults.chat_messages = [
        row({
          id: 'm2',
          seq: 2,
          deleted_at: '2026-09-30T11:00:00Z',
          deleted_by: 'admin-1',
          pinned_at: 'x',
        }),
      ];

      const { messages } = await service.list(user, 'conv-1', {});

      expect(messages[0]).toMatchObject({
        deleted: true,
        bodyHtml: null,
        bodyText: null,
        refs: [],
        reactions: [],
        pinnedAt: null,
        deletedByModerator: true,
      });
    });

    it('applies the history cut-off and pages newest-first by default', async () => {
      access.getReadable.mockResolvedValue({
        conversation,
        membership: {},
        historyFromSeq: 4,
      });
      tableResults.chat_messages = [row({ seq: 9 }), row({ id: 'm8', seq: 8 })];

      const { messages } = await service.list(user, 'conv-1', { limit: 2 });
      const query = from.mock.results[0].value as ReturnType<typeof chain>;

      expect(query.calls).toContainEqual(['gt', ['seq', 4]]);
      expect(query.calls).toContainEqual(['eq', ['organization_id', 'org-1']]);
      expect(query.calls).toContainEqual([
        'order',
        ['seq', { ascending: false }],
      ]);
      expect(messages.map((m) => m.seq)).toEqual([8, 9]);
    });

    it('catches up oldest-first after a given seq', async () => {
      await service.list(user, 'conv-1', { afterSeq: 12 });
      const query = from.mock.results[0].value as ReturnType<typeof chain>;

      expect(query.calls).toContainEqual(['gt', ['seq', 12]]);
      expect(query.calls).toContainEqual([
        'order',
        ['seq', { ascending: true }],
      ]);
    });

    it('answers a plain page without the window fields', async () => {
      await expect(service.list(user, 'conv-1', {})).resolves.toEqual({
        messages: [],
        hasMore: false,
      });
      expect(access.getReadableMessage).not.toHaveBeenCalled();
    });
  });

  describe('list around a message', () => {
    /** The message the window is asked for. */
    const anchor = (overrides: Record<string, unknown> = {}) => {
      access.getReadableMessage.mockResolvedValue({
        message: row({ id: 'm10', seq: 10, ...overrides }),
        access: { conversation, membership: {}, historyFromSeq: 0 },
      });
    };
    const seqs = (...values: number[]) =>
      values.map((seq) => row({ id: `m${seq}`, seq }));

    it('returns the messages around it, oldest first, with both "more" flags and the anchor', async () => {
      anchor();
      // Older side: newest first, the centre included; newer side: oldest first.
      tableQueues.chat_messages = [seqs(10, 9, 8, 7), seqs(11, 12)];

      const page = await service.list(user, 'conv-1', {
        aroundMessageId: 'm10',
        limit: 4,
      });

      expect(access.getReadableMessage).toHaveBeenCalledWith(user, 'm10');
      expect(page.messages.map((m) => m.seq)).toEqual([8, 9, 10, 11]);
      expect(page).toMatchObject({
        hasMore: true,
        hasNewer: true,
        anchor: { id: 'm10', seq: 10, threadRootId: null },
      });

      const [before, after] = queriesOf('chat_messages');
      for (const query of [before, after]) {
        expect(query.calls).toContainEqual([
          'eq',
          ['conversation_id', 'conv-1'],
        ]);
        expect(query.calls).toContainEqual([
          'eq',
          ['organization_id', 'org-1'],
        ]);
        expect(query.calls).toContainEqual(['is', ['thread_root_id', null]]);
      }
      // One row more than shown on each side: 2 older + the centre + 1, and 1 newer + 1.
      expect(before.calls.slice(-3)).toEqual([
        ['lte', ['seq', 10]],
        ['order', ['seq', { ascending: false }]],
        ['limit', [4]],
      ]);
      expect(after.calls.slice(-3)).toEqual([
        ['gt', ['seq', 10]],
        ['order', ['seq', { ascending: true }]],
        ['limit', [2]],
      ]);
    });

    it('is 25 older, the message and 24 newer by default, and knows when a side ends', async () => {
      anchor();
      tableQueues.chat_messages = [seqs(10, 9), seqs(11)];

      const page = await service.list(user, 'conv-1', {
        aroundMessageId: 'm10',
      });

      const [before, after] = queriesOf('chat_messages');
      expect(before.calls).toContainEqual(['limit', [27]]);
      expect(after.calls).toContainEqual(['limit', [25]]);
      expect(page.messages.map((m) => m.seq)).toEqual([9, 10, 11]);
      expect(page).toMatchObject({ hasMore: false, hasNewer: false });
    });

    it('reports no more on a side that is exactly full', async () => {
      anchor();
      // limit 4 shows 2 older + the message + 1 newer: nothing is left over.
      tableQueues.chat_messages = [seqs(10, 9, 8), seqs(11)];

      const page = await service.list(user, 'conv-1', {
        aroundMessageId: 'm10',
        limit: 4,
      });

      expect(page.messages.map((m) => m.seq)).toEqual([8, 9, 10, 11]);
      expect(page).toMatchObject({ hasMore: false, hasNewer: false });
    });

    it('returns just the message for limit 1', async () => {
      anchor();
      tableQueues.chat_messages = [seqs(10, 9), seqs(11)];

      const page = await service.list(user, 'conv-1', {
        aroundMessageId: 'm10',
        limit: 1,
      });

      expect(page.messages.map((m) => m.seq)).toEqual([10]);
      expect(page).toMatchObject({ hasMore: true, hasNewer: true });
    });

    it.each([{ beforeSeq: 5 }, { afterSeq: 5 }, { beforeSeq: 0 }])(
      'refuses the combination with %j before reading anything',
      async (paging) => {
        await expect(
          service.list(user, 'conv-1', { aroundMessageId: 'm10', ...paging }),
        ).rejects.toThrow(BadRequestException);
        expect(access.getReadableMessage).not.toHaveBeenCalled();
        expect(from).not.toHaveBeenCalled();
      },
    );

    it('answers 404 when the caller may not read the message (other organization, left group, before the cut-off)', async () => {
      access.getReadableMessage.mockRejectedValue(
        new NotFoundException('Message not found'),
      );

      await expect(
        service.list(user, 'conv-1', { aroundMessageId: 'm10' }),
      ).rejects.toThrow(NotFoundException);
      expect(from).not.toHaveBeenCalled();
    });

    it('answers 404 for a readable message of another conversation', async () => {
      anchor({ conversation_id: 'conv-2' });

      await expect(
        service.list(user, 'conv-1', { aroundMessageId: 'm10' }),
      ).rejects.toThrow(new NotFoundException('Message not found'));
      expect(from).not.toHaveBeenCalled();
    });

    it('never reaches behind the history cut-off, on either side', async () => {
      access.getReadableMessage.mockResolvedValue({
        message: row({ id: 'm10', seq: 10 }),
        access: { conversation, membership: {}, historyFromSeq: 8 },
      });
      tableQueues.chat_messages = [seqs(10, 9), seqs(11)];

      await service.list(user, 'conv-1', { aroundMessageId: 'm10' });

      const [before, after] = queriesOf('chat_messages');
      expect(before.calls).toContainEqual(['gt', ['seq', 8]]);
      expect(after.calls).toContainEqual(['gt', ['seq', 8]]);
    });

    it('centres a thread reply on its thread root in the main timeline', async () => {
      anchor({ id: 'reply', seq: 20, thread_root_id: 'root-1' });
      tableQueues.chat_messages = [{ seq: 12 }, seqs(12, 11), seqs(13)];

      const page = await service.list(user, 'conv-1', {
        aroundMessageId: 'reply',
      });

      const [root, before, after] = queriesOf('chat_messages');
      expect(root.calls).toEqual([
        ['select', ['seq']],
        ['eq', ['id', 'root-1']],
        ['eq', ['conversation_id', 'conv-1']],
        ['eq', ['organization_id', 'org-1']],
        ['maybeSingle', []],
      ]);
      expect(before.calls).toContainEqual(['is', ['thread_root_id', null]]);
      expect(before.calls).toContainEqual(['lte', ['seq', 12]]);
      expect(after.calls).toContainEqual(['gt', ['seq', 12]]);
      expect(page.messages.map((m) => m.seq)).toEqual([11, 12, 13]);
      // The anchor is the message that was asked for, not the root.
      expect(page.anchor).toEqual({
        id: 'reply',
        seq: 20,
        threadRootId: 'root-1',
      });
    });

    it('stays inside the thread when threadRootId is given', async () => {
      anchor({ id: 'reply', seq: 20, thread_root_id: 'root-1' });
      tableQueues.chat_messages = [
        [
          row({ id: 'reply', seq: 20, thread_root_id: 'root-1' }),
          row({ id: 'r19', seq: 19, thread_root_id: 'root-1' }),
        ],
        [row({ id: 'r21', seq: 21, thread_root_id: 'root-1' })],
      ];

      const page = await service.list(user, 'conv-1', {
        aroundMessageId: 'reply',
        threadRootId: 'root-1',
      });

      // No look-up of the root: the reply's own seq is the centre.
      const [before, after] = queriesOf('chat_messages');
      expect(before.calls).toContainEqual(['eq', ['thread_root_id', 'root-1']]);
      expect(before.calls).toContainEqual(['lte', ['seq', 20]]);
      expect(after.calls).toContainEqual(['eq', ['thread_root_id', 'root-1']]);
      expect(after.calls).toContainEqual(['gt', ['seq', 20]]);
      expect(page.messages.map((m) => m.id)).toEqual(['r19', 'reply', 'r21']);
      expect(page.anchor).toEqual({
        id: 'reply',
        seq: 20,
        threadRootId: 'root-1',
      });
    });

    it('fails as a whole when one side cannot be loaded', async () => {
      anchor();
      from.mockImplementationOnce(() => chain({ data: seqs(10) }));
      from.mockImplementationOnce(() =>
        chain({ data: null, error: { message: 'boom' } }),
      );

      await expect(
        service.list(user, 'conv-1', { aroundMessageId: 'm10' }),
      ).rejects.toThrow('Could not load messages');
    });
  });

  describe('search', () => {
    const M1 = 'aaaaaaaa-0000-4000-8000-000000000001';
    const M2 = 'aaaaaaaa-0000-4000-8000-000000000002';
    const M3 = 'aaaaaaaa-0000-4000-8000-000000000003';
    const M4 = 'aaaaaaaa-0000-4000-8000-000000000004';
    const TASK = 'bbbbbbbb-0000-4000-8000-000000000001';
    const PAGE = 'bbbbbbbb-0000-4000-8000-000000000002';
    const CONV = 'cccccccc-0000-4000-8000-000000000001';
    const START = String.fromCharCode(2);
    const STOP = String.fromCharCode(3);

    /** A row of chat_search_messages. */
    const found = (id: string, overrides: Record<string, unknown> = {}) => ({
      message_id: id,
      conversation_id: 'conv-1',
      created_at: `2026-09-30T10:00:0${id.slice(-1)}.123456+00:00`,
      matched_on: 'text',
      snippet: null,
      object_refs: [],
      ...overrides,
    });
    /** What the function answers, read after read. */
    const reads = (...pages: unknown[][]) => {
      for (const data of pages)
        rpc.mockResolvedValueOnce({ data, error: null });
    };
    /** The stored messages every search row is looked up in. */
    const store = (...ids: string[]) => {
      tableResults.chat_messages = ids.map((id) => row({ id }));
    };
    const hidden = (id: string) =>
      found(id, {
        matched_on: 'object',
        object_refs: [{ type: 'task', id: TASK }],
      });

    beforeEach(() => {
      rpc.mockResolvedValue({ data: [], error: null });
      labels.mockResolvedValue(
        new Map([
          ['conv-1', { id: 'conv-1', kind: 'dm', title: 'Ben Berger' }],
        ]),
      );
      loadUsers.mockResolvedValue(
        new Map([['user-1', { id: 'user-1', name: 'Ada Lovelace' }]]),
      );
    });

    it('hands every filter to the database function, with the organization and the user from the session', async () => {
      access.getViewableSpaceIds.mockResolvedValue(['space-1']);

      await service.search(user, {
        q: 'firewall',
        conversationId: CONV,
        authorId: U2,
        from: '2026-09-01T00:00:00Z',
        to: '2026-09-30T23:59:59Z',
        hasAttachment: true,
        hasObject: true,
        objectType: 'wiki_page',
        pinned: true,
        mentionsMe: true,
        limit: 5,
      });

      expect(rpc.mock.calls).toEqual([
        [
          'chat_search_messages',
          {
            p_organization_id: 'org-1',
            p_user_id: 'user-1',
            p_space_ids: ['space-1'],
            p_q: 'firewall',
            p_not: null,
            p_conversation_id: CONV,
            p_author_id: U2,
            p_from: '2026-09-01T00:00:00Z',
            p_to: '2026-09-30T23:59:59Z',
            p_has_attachment: true,
            p_has_object: true,
            p_object_type: 'wiki_page',
            p_pinned: true,
            p_mentions_me: true,
            p_before_created_at: null,
            p_before_id: null,
            p_limit: 5,
          },
        ],
      ]);
    });

    it('sends every argument of the function, null for what is not set, and asks for 20 hits by default', async () => {
      await service.search(user, { q: 'firewall' });

      expect(rpcCall()[1]).toEqual({
        p_organization_id: 'org-1',
        p_user_id: 'user-1',
        p_space_ids: [],
        p_q: 'firewall',
        p_not: null,
        p_conversation_id: null,
        p_author_id: null,
        p_from: null,
        p_to: null,
        p_has_attachment: null,
        p_has_object: null,
        p_object_type: null,
        p_pinned: null,
        p_mentions_me: null,
        p_before_created_at: null,
        p_before_id: null,
        p_limit: 20,
      });
    });

    it.each([
      ['someone who may view every space', null],
      ['a member of two spaces', ['space-1', 'space-2']],
      ['someone without any space', []],
    ])('passes the viewable spaces of %s', async (_who, spaces) => {
      access.getViewableSpaceIds.mockResolvedValue(spaces);

      await service.search(user, { q: 'firewall' });

      expect(access.getViewableSpaceIds).toHaveBeenCalledWith(user);
      expect(rpcCall()[1].p_space_ids).toEqual(spaces);
    });

    it.each([
      {},
      { limit: 5 },
      { q: '   ' },
      { q: '-' },
      // A boolean filter only narrows when it is true.
      {
        hasAttachment: false,
        hasObject: false,
        pinned: false,
        mentionsMe: false,
      },
    ])(
      'answers 400 for %j: a search term or a filter is required',
      async (query) => {
        await expect(service.search(user, query)).rejects.toThrow(
          new BadRequestException('Enter a search term or choose a filter'),
        );
        expect(access.getViewableSpaceIds).not.toHaveBeenCalled();
        expect(rpc).not.toHaveBeenCalled();
      },
    );

    it.each([
      { conversationId: CONV },
      { authorId: U2 },
      { from: '2026-09-01T00:00:00Z' },
      { to: '2026-09-30T00:00:00Z' },
      { hasAttachment: true },
      { hasObject: true },
      { objectType: 'task' as const },
      { pinned: true },
      { mentionsMe: true },
    ])('searches with the filter %j alone, without words', async (query) => {
      await expect(service.search(user, query)).resolves.toEqual({
        hits: [],
        nextCursor: null,
        messages: [],
      });
      expect(rpcCall()[1]).toMatchObject({ p_q: null, p_not: null });
    });

    it('splits the excluded words out of q', async () => {
      await service.search(user, {
        q: 'rechnung -lieferant "mai -juni" -"alt angebot"',
      });
      expect(rpcCall()[1]).toMatchObject({
        p_q: 'rechnung "mai -juni"',
        p_not: 'lieferant alt angebot',
      });

      // Only an exclusion is a search as well: everything but that word.
      await service.search(user, { q: '-lieferant' });
      expect(rpcCall(1)[1]).toMatchObject({ p_q: null, p_not: 'lieferant' });
    });

    it('returns the hits in the order of the function, each with its view, conversation, author and match', async () => {
      reads([
        found(M1, {
          snippet: `the ${START}<b>firewall</b>${STOP} is <i>down</i>`,
        }),
        found(M2, { matched_on: 'file', snippet: 'never shown' }),
        found(M3, { matched_on: 'filter' }),
      ]);
      // Stored order differs from the search order.
      tableResults.chat_messages = [
        row({ id: M3, author_id: null }),
        row({ id: M2 }),
        row({ id: M1 }),
      ];
      tableResults.chat_message_refs = [
        { message_id: M1, ref_type: 'task', ref_id: TASK },
      ];
      tableResults.chat_reactions = [
        { message_id: M1, emoji: '👍', user_id: 'user-1' },
      ];
      tableResults.file_attachments = [
        {
          id: 'a1',
          entity_id: M2,
          file_name: 'firewall.pdf',
          created_at: '2026-09-30T10:01:00Z',
          current_version: { file_size: 10, mime_type: 'application/pdf' },
        },
      ];

      const result = await service.search(user, { q: 'firewall' });

      expect(result.hits.map((hit) => hit.message.id)).toEqual([M1, M2, M3]);
      expect(result.hits[0]).toMatchObject({
        message: {
          id: M1,
          conversationId: 'conv-1',
          refs: [{ type: 'task', id: TASK }],
          reactions: [{ emoji: '👍', count: 1, reactedByMe: true }],
        },
        conversation: { id: 'conv-1', kind: 'dm', title: 'Ben Berger' },
        authorName: 'Ada Lovelace',
        matchedOn: 'text',
        // Plain text: the html of the message is not interpreted, escaped or removed.
        snippet: [
          { text: 'the ', hit: false },
          { text: '<b>firewall</b>', hit: true },
          { text: ' is <i>down</i>', hit: false },
        ],
      });
      expect(result.hits[1]).toMatchObject({
        message: { attachments: [{ id: 'a1', fileName: 'firewall.pdf' }] },
        matchedOn: 'file',
        snippet: [],
      });
      expect(result.hits[2]).toMatchObject({
        authorName: null,
        matchedOn: 'filter',
        snippet: [],
      });
      // The old client reads `messages`.
      expect(result.messages).toEqual(result.hits.map((hit) => hit.message));
      expect(result.nextCursor).toBeNull();

      expect(queriesOf('chat_messages')[0].calls).toEqual([
        ['select', [expect.stringContaining('body_html')]],
        ['eq', ['organization_id', 'org-1']],
        ['in', ['id', [M1, M2, M3]]],
        ['is', ['deleted_at', null]],
      ]);
      expect(labels).toHaveBeenCalledWith(user, ['conv-1', 'conv-1', 'conv-1']);
      expect(loadUsers).toHaveBeenCalledWith(['user-1', 'user-1']);
    });

    it('leaves out a hit whose message was deleted a moment ago', async () => {
      reads([found(M1), found(M2)]);
      store(M2);

      const { hits, messages } = await service.search(user, { q: 'x' });

      expect(hits.map((hit) => hit.message.id)).toEqual([M2]);
      expect(messages.map((message) => message.id)).toEqual([M2]);
    });

    describe('paging', () => {
      it('ends without a cursor on a page that is exactly full', async () => {
        // limit 2 and two rows: the function found no third one.
        reads([found(M1), found(M2)]);
        store(M1, M2);

        const result = await service.search(user, { q: 'x', limit: 2 });

        expect(result.hits.map((hit) => hit.message.id)).toEqual([M1, M2]);
        expect(result.nextCursor).toBeNull();
        expect(rpc).toHaveBeenCalledTimes(1);
      });

      it('hands out a cursor at the last hit and continues exactly there', async () => {
        // limit 2: the third row only says that there is more.
        reads([found(M1), found(M2), found(M3)], [found(M3)]);
        store(M1, M2, M3);

        const first = await service.search(user, { q: 'x', limit: 2 });

        expect(first.hits.map((hit) => hit.message.id)).toEqual([M1, M2]);
        expect(first.nextCursor).toEqual(expect.any(String));

        const second = await service.search(user, {
          q: 'x',
          limit: 2,
          cursor: first.nextCursor as string,
        });

        expect(rpcCall(1)[1]).toMatchObject({
          // Microseconds included, exactly as the database printed them.
          p_before_created_at: '2026-09-30T10:00:02.123456+00:00',
          p_before_id: M2,
          p_limit: 2,
        });
        expect(second.hits.map((hit) => hit.message.id)).toEqual([M3]);
        expect(second.nextCursor).toBeNull();
        expect(rpc).toHaveBeenCalledTimes(2);
      });

      it('answers 400 for a tampered cursor before the database is asked', async () => {
        const cursor = encodeSearchCursor({
          createdAt: '2026-09-30T10:00:02.123456+00:00',
          id: M2,
        });

        for (const tampered of [
          cursor.slice(0, -4),
          `x${cursor}`,
          Buffer.from(JSON.stringify(['now()', M2])).toString('base64url'),
        ]) {
          await expect(
            service.search(user, { q: 'x', cursor: tampered }),
          ).rejects.toThrow(new BadRequestException('Invalid cursor'));
        }
        expect(access.getViewableSpaceIds).not.toHaveBeenCalled();
        expect(rpc).not.toHaveBeenCalled();
      });
    });

    describe('hits by the title of a referenced object', () => {
      it('keeps one only when the caller may open the object', async () => {
        reads([
          found(M1),
          found(M2, {
            matched_on: 'object',
            object_refs: [{ type: 'task', id: TASK }],
          }),
          found(M3, {
            matched_on: 'object',
            object_refs: [
              { type: 'task', id: TASK },
              { type: 'wiki_page', id: PAGE },
            ],
          }),
          found(M4, { matched_on: 'file' }),
        ]);
        resolveRefs.mockResolvedValue({
          results: [
            { type: 'task', id: TASK, status: 'restricted' },
            { type: 'wiki_page', id: PAGE, status: 'ok', title: 'Firewall' },
          ],
        });
        store(M1, M2, M3, M4);

        const { hits, messages } = await service.search(user, { q: 'fire' });

        expect(resolveRefs.mock.calls).toEqual([
          [
            user,
            [
              { type: 'task', id: TASK },
              { type: 'task', id: TASK },
              { type: 'wiki_page', id: PAGE },
            ],
          ],
        ]);
        expect(hits.map((hit) => hit.message.id)).toEqual([M1, M3, M4]);
        expect(hits[1].matchedOn).toBe('object');
        expect(messages.map((message) => message.id)).toEqual([M1, M3, M4]);
        // The dropped message is not even loaded.
        expect(queriesOf('chat_messages')[0].calls).toContainEqual([
          'in',
          ['id', [M1, M3, M4]],
        ]);
      });

      it.each(['restricted', 'deleted'])(
        'drops one whose object is %s for the caller',
        async (status) => {
          reads([hidden(M1)]);
          resolveRefs.mockResolvedValue({
            results: [{ type: 'task', id: TASK, status }],
          });
          store(M1);

          await expect(service.search(user, { q: 'secret' })).resolves.toEqual({
            hits: [],
            nextCursor: null,
            messages: [],
          });
          expect(from).not.toHaveBeenCalled();
        },
      );

      it('checks many objects 100 at a time: their ids ride in a query string', async () => {
        const tasks = Array.from({ length: 150 }, (_, i) => ({
          type: 'task',
          id: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`,
        }));
        reads([found(M1, { matched_on: 'object', object_refs: tasks })]);
        // Only the very last one may be opened: it is in the second lot.
        resolveRefs.mockImplementation((_user: unknown, refs: typeof tasks) =>
          Promise.resolve({
            results: refs.map((ref) => ({
              ...ref,
              status: ref.id === tasks[149].id ? 'ok' : 'restricted',
            })),
          }),
        );
        store(M1);

        const { hits } = await service.search(user, { q: 'fire' });

        expect(
          resolveRefs.mock.calls.map(([, refs]) => (refs as unknown[]).length),
        ).toEqual([100, 50]);
        expect(hits.map((hit) => hit.message.id)).toEqual([M1]);
      });

      it('does not ask for permissions when nothing matched by an object alone', async () => {
        reads([found(M1), found(M2, { matched_on: 'file' })]);
        store(M1, M2);

        await service.search(user, { q: 'x' });

        expect(resolveRefs).not.toHaveBeenCalled();
      });

      it('does not let a hidden hit show as "more": it reads on and ends without a cursor', async () => {
        // limit 1: the function reports a second row, but the caller may not see it.
        reads([found(M1), hidden(M2)], []);
        store(M1);

        const result = await service.search(user, { q: 'secret', limit: 1 });

        expect(result.hits.map((hit) => hit.message.id)).toEqual([M1]);
        expect(result.nextCursor).toBeNull();
        // The second read continues behind the hidden row.
        expect(rpc).toHaveBeenCalledTimes(2);
        expect(rpcCall(1)[1]).toMatchObject({
          p_before_created_at: '2026-09-30T10:00:02.123456+00:00',
          p_before_id: M2,
          p_limit: 50,
        });
      });

      it('fills the page behind hidden hits and puts the cursor at the last hit returned', async () => {
        reads([hidden(M1), found(M2)], [found(M3), found(M4)]);
        store(M2, M3, M4);

        const result = await service.search(user, { q: 'secret', limit: 1 });

        expect(result.hits.map((hit) => hit.message.id)).toEqual([M2]);

        reads([]);
        await service.search(user, {
          q: 'secret',
          limit: 1,
          cursor: result.nextCursor as string,
        });
        expect(rpcCall(2)[1]).toMatchObject({ p_before_id: M2 });
      });

      it('stops after four extra reads of hidden hits and continues from where it stopped', async () => {
        const many = (size: number) =>
          Array.from({ length: size + 1 }, () => hidden(M1));
        reads(many(1), many(50), many(50), many(50), [...many(49), hidden(M4)]);

        const result = await service.search(user, { q: 'secret', limit: 1 });

        expect(rpc).toHaveBeenCalledTimes(5);
        expect(result.hits).toEqual([]);

        reads([]);
        await service.search(user, {
          q: 'secret',
          cursor: result.nextCursor as string,
        });
        expect(rpcCall(5)[1]).toMatchObject({ p_before_id: M4 });
      });
    });

    it('gives a caller from another organization nothing: the function is asked for their organization only', async () => {
      const stranger = {
        userId: 'user-9',
        organizationId: 'org-2',
      } as RequestUser;
      // What chat_search_messages answers for an organization without these messages.
      reads([]);

      await expect(
        service.search(stranger, { q: 'firewall', conversationId: CONV }),
      ).resolves.toEqual({ hits: [], nextCursor: null, messages: [] });
      expect(rpcCall()[1]).toMatchObject({
        p_organization_id: 'org-2',
        p_user_id: 'user-9',
        p_conversation_id: CONV,
      });
      expect(from).not.toHaveBeenCalled();
      expect(labels).not.toHaveBeenCalled();
    });

    it('loads the found messages inside the organization of the caller only', async () => {
      const stranger = {
        userId: 'user-9',
        organizationId: 'org-2',
      } as RequestUser;
      reads([found(M1)]);

      await service.search(stranger, { q: 'firewall' });

      for (const table of ['chat_messages']) {
        expect(queriesOf(table)[0].calls).toContainEqual([
          'eq',
          ['organization_id', 'org-2'],
        ]);
      }
      expect(labels).toHaveBeenCalledWith(stranger, ['conv-1']);
    });

    it('maps an error of the function like every chat function', async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: {
          code: '22023',
          message: 'chat: limit must be between 1 and 100',
        },
      });
      await expect(service.search(user, { q: 'x' })).rejects.toThrow(
        new BadRequestException('limit must be between 1 and 100'),
      );

      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function' },
      });
      await expect(service.search(user, { q: 'x' })).rejects.toThrow(
        'Chat request failed',
      );
    });
  });

  describe('reactions and pins', () => {
    it('rejects invalid emoji', async () => {
      await expect(service.addReaction(user, 'm1', ' ')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.addReaction(user, 'm1', 'a b')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses to react to or pin a deleted message', async () => {
      access.getReadableMessage.mockResolvedValue({
        message: row({ deleted_at: '2026-09-30T11:00:00Z' }),
        access: { conversation, membership: {}, historyFromSeq: 0 },
      });

      await expect(service.addReaction(user, 'm1', '👍')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.setPinned(user, 'm1', true)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('checks the conversation is writable before reacting', async () => {
      await service.addReaction(user, 'm1', '👍');

      expect(access.assertWritable).toHaveBeenCalled();
      // The first chat_reactions query is the write; the second reloads the summary.
      const reactionQueries = from.mock.calls
        .map(
          ([table], index) => [table, from.mock.results[index].value] as const,
        )
        .filter(([table]) => table === 'chat_reactions')
        .map(([, query]) => query as ReturnType<typeof chain>);
      expect(reactionQueries[0].calls[0]).toEqual([
        'upsert',
        [
          {
            message_id: 'm1',
            organization_id: 'org-1',
            user_id: 'user-1',
            emoji: '👍',
          },
          { onConflict: 'message_id,user_id,emoji', ignoreDuplicates: true },
        ],
      ]);
    });
  });

  describe('attachments', () => {
    it('allows an empty body when files are announced and stores the count', async () => {
      rpc.mockResolvedValue({
        data: [{ message_id: 'm1', message_seq: 7, duplicate: false }],
        error: null,
      });

      await service.send(user, 'conv-1', {
        id: 'm1',
        bodyHtml: '',
        attachmentCount: 2,
      });

      expect(rpcCall()[1].p_metadata).toEqual({ attachmentCount: 2 });
    });

    it('still rejects an empty body without files', async () => {
      await expect(
        service.send(user, 'conv-1', {
          id: 'm1',
          bodyHtml: '',
          attachmentCount: 0,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('attaches uploaded files and the pending count to views, never to tombstones', async () => {
      tableResults.chat_messages = [
        row({ id: 'm1', metadata: { attachmentCount: 3 } }),
        row({ id: 'm2', seq: 2, deleted_at: '2026-09-30T11:00:00Z' }),
      ];
      tableResults.file_attachments = [
        {
          id: 'a1',
          entity_id: 'm1',
          file_name: 'report.pdf',
          created_at: '2026-09-30T10:01:00Z',
          current_version: { file_size: 1234, mime_type: 'application/pdf' },
        },
      ];

      const { messages } = await service.list(user, 'conv-1', {});

      const query = from.mock.calls
        .map(([table], i) => [table, from.mock.results[i].value] as const)
        .find(([table]) => table === 'file_attachments')?.[1] as ReturnType<
        typeof chain
      >;
      expect(query.calls).toContainEqual([
        'eq',
        ['entity_type', 'chat_message'],
      ]);
      expect(query.calls).toContainEqual(['eq', ['organization_id', 'org-1']]);
      expect(query.calls).toContainEqual(['in', ['entity_id', ['m1']]]);

      const byId = new Map(messages.map((m) => [m.id, m]));
      expect(byId.get('m1')).toMatchObject({
        attachments: [
          {
            id: 'a1',
            fileName: 'report.pdf',
            size: 1234,
            mimeType: 'application/pdf',
            createdAt: '2026-09-30T10:01:00Z',
          },
        ],
        pendingAttachments: 2,
        metadata: {},
      });
      expect(byId.get('m2')).toMatchObject({
        attachments: [],
        pendingAttachments: 0,
      });
    });
  });

  describe('Robert (the after-send hook)', () => {
    const askRobert = `<p><span data-user-mention data-user-id="${ROBERT_ID}" data-user-name="Robert">@Robert</span> what did we agree?</p>`;
    const stored = (duplicate = false) =>
      rpc.mockResolvedValue({
        data: [{ message_id: 'm1', message_seq: 7, duplicate }],
        error: null,
      });
    let afterSend: jest.Mock;

    beforeEach(() => {
      afterSend = jest.fn().mockResolvedValue({ id: 'run-1', messageId: 'a1' });
      service.setAfterSend(afterSend);
    });

    afterEach(() => jest.useRealTimers());

    it('starts a run for a mention of Robert and returns it with the message', async () => {
      stored();
      const result = await service.send(user, 'conv-1', {
        id: 'm1',
        bodyHtml: askRobert,
        timezone: 'Europe/Vienna',
      });

      expect(afterSend).toHaveBeenCalledWith({
        user,
        conversation,
        messageId: 'm1',
        timezone: 'Europe/Vienna',
      });
      expect(result.agentRun).toEqual({ id: 'run-1', messageId: 'a1' });
    });

    it('starts a run for every message in the Robert chat, mention or not', async () => {
      const robertChat = { ...conversation, dm_key: `user-1:${ROBERT_ID}` };
      access.getReadable.mockResolvedValue({
        conversation: robertChat,
        membership: {},
        historyFromSeq: 0,
      });
      stored();
      await service.send(user, 'conv-1', { id: 'm1', bodyHtml: '<p>hi</p>' });

      expect(afterSend).toHaveBeenCalledWith(
        expect.objectContaining({ conversation: robertChat, timezone: null }),
      );
    });

    it('does not call Robert for other messages, nor for "@robert" typed as text', async () => {
      stored();
      const result = await service.send(user, 'conv-1', {
        id: 'm1',
        bodyHtml: '<p>@robert hi</p>',
      });

      expect(afterSend).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('agentRun');
    });

    it('asks again on a resend, so a retry after a lost response gets the same run', async () => {
      stored(true);
      const result = await service.send(user, 'conv-1', {
        id: 'm1',
        bodyHtml: askRobert,
      });

      expect(afterSend).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        duplicate: true,
        agentRun: { id: 'run-1', messageId: 'a1' },
      });
    });

    it('never fails the send when the start fails', async () => {
      stored();
      afterSend.mockRejectedValue(new Error('database down'));
      const result = await service.send(user, 'conv-1', {
        id: 'm1',
        bodyHtml: askRobert,
      });

      expect(result.id).toBe('m1');
      expect(result).not.toHaveProperty('agentRun');
    });

    it('waits at most 2 seconds for the start', async () => {
      jest.useFakeTimers();
      stored();
      afterSend.mockReturnValue(new Promise(() => {}));
      let done = false;
      const sending = service
        .send(user, 'conv-1', { id: 'm1', bodyHtml: askRobert })
        .finally(() => (done = true));

      await jest.advanceTimersByTimeAsync(1999);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      const result = await sending;

      expect(result.id).toBe('m1');
      expect(result).not.toHaveProperty('agentRun');
    });

    it('never starts a run on an edit, even one that adds the mention (BR-7)', async () => {
      rpc.mockResolvedValue({ data: [ROBERT_ID], error: null });
      await service.edit(user, 'm1', { bodyHtml: askRobert });

      expect(afterSend).not.toHaveBeenCalled();
    });

    it("shows Robert's run id on his message and nothing on a user message", async () => {
      access.getReadableMessage.mockResolvedValueOnce({
        message: row({
          kind: 'agent',
          author_id: null,
          body_html: '',
          body_text: '',
          metadata: { run_id: 'run-1' },
        }),
        access: { conversation, membership: {}, historyFromSeq: 0 },
      });
      stored();
      const agent = await service.send(user, 'conv-1', {
        id: 'm1',
        bodyHtml: '<p>x</p>',
      });
      expect(agent).toMatchObject({
        kind: 'agent',
        metadata: { run_id: 'run-1' },
        pendingAttachments: 0,
      });

      access.getReadableMessage.mockResolvedValueOnce({
        message: row({ metadata: { attachmentCount: 0 } }),
        access: { conversation, membership: {}, historyFromSeq: 0 },
      });
      const user1 = await service.send(user, 'conv-1', {
        id: 'm1',
        bodyHtml: '<p>x</p>',
      });
      expect(user1.metadata).toEqual({});
    });
  });

  describe('realtime', () => {
    it('signals a new message, but not an idempotent resend', async () => {
      rpc.mockResolvedValueOnce({
        data: [{ message_id: 'm1', message_seq: 7, duplicate: false }],
        error: null,
      });
      await service.send(user, 'conv-1', { id: 'm1', bodyHtml: '<p>x</p>' });
      expect(realtime.messageCreated).toHaveBeenCalledWith(conversation, {
        messageId: 'm1',
        seq: 7,
        threadRootId: null,
      });

      realtime.messageCreated.mockClear();
      rpc.mockResolvedValueOnce({
        data: [{ message_id: 'm1', message_seq: 7, duplicate: true }],
        error: null,
      });
      await service.send(user, 'conv-1', { id: 'm1', bodyHtml: '<p>x</p>' });
      expect(realtime.messageCreated).not.toHaveBeenCalled();
    });

    it('signals edit, delete, reactions and pins', async () => {
      rpc.mockResolvedValueOnce({ data: [], error: null });
      await service.edit(user, 'm1', { bodyHtml: '<p>e</p>' });
      expect(realtime.messageUpdated).toHaveBeenCalledWith('conv-1', 'm1');

      rpc.mockResolvedValueOnce({ data: true, error: null });
      await service.remove(user, 'm1');
      expect(realtime.messageDeleted).toHaveBeenCalledWith('conv-1', 'm1');

      await service.addReaction(user, 'm1', '👍');
      await service.removeReaction(user, 'm1', '👍');
      expect(realtime.reactionChanged).toHaveBeenCalledTimes(2);

      realtime.messageUpdated.mockClear();
      await service.setPinned(user, 'm1', true);
      expect(realtime.messageUpdated).toHaveBeenCalledWith('conv-1', 'm1');
    });

    it('does not signal when the write fails', async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: '42501', message: 'chat: nope' },
      });
      await expect(service.remove(user, 'm1')).rejects.toThrow();
      expect(realtime.messageDeleted).not.toHaveBeenCalled();
    });
  });
});
