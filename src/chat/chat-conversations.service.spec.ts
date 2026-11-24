import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ROBERT_ID } from '../chat-agent/agent.constants';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { ChatAccessService } from './chat-access.service';
import { ChatConversationsService } from './chat-conversations.service';
import type { ChatRealtimeService } from './chat-realtime.service';

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

const summaryRow = (overrides: Record<string, unknown> = {}) => ({
  conversation_id: 'conv-1',
  kind: 'dm',
  title: null,
  space_id: null,
  dm_key: 'user-1:user-2',
  is_announcement: false,
  last_seq: 4,
  last_read_seq: 2,
  unread_count: 2,
  mention_count: 1,
  last_message_at: '2026-09-30T10:00:00Z',
  muted: false,
  pinned_at: null,
  notify_level: 'all',
  last_message_id: 'm4',
  last_message_author_id: 'user-2',
  last_message_kind: 'user',
  last_message_deleted: false,
  last_message_preview: 'see you',
  ...overrides,
});

describe('ChatConversationsService', () => {
  const user = { userId: 'user-1', organizationId: 'org-1' } as RequestUser;

  let rpc: jest.Mock;
  let from: jest.Mock;
  let tableResults: Record<string, unknown>;
  let access: Record<string, jest.Mock>;
  let service: ChatConversationsService;

  beforeEach(() => {
    tableResults = {
      users: [
        {
          id: 'user-2',
          first_name: 'Ben',
          last_name: 'Berger',
          email: 'b@x',
          avatar_url: null,
        },
      ],
    };
    rpc = jest.fn().mockResolvedValue({ data: [], error: null });
    from = jest.fn((table: string) =>
      chain({ data: tableResults[table] ?? [] }),
    );
    access = {
      getViewableSpaceIds: jest.fn().mockResolvedValue(['space-1']),
      canViewSpace: jest.fn().mockResolvedValue(true),
      getReadable: jest.fn(),
      assertWritable: jest.fn().mockResolvedValue(undefined),
    };
    service = new ChatConversationsService(
      { getClient: () => ({ from, rpc }) } as unknown as SupabaseAdminService,
      access as unknown as ChatAccessService,
      {
        inboxChanged: jest.fn().mockResolvedValue(undefined),
        conversationChanged: jest.fn().mockResolvedValue(undefined),
      } as unknown as ChatRealtimeService,
    );
  });

  describe('listInbox', () => {
    it('reads Robert statuses in batches, so a long inbox does not lose them all', async () => {
      const agent = (n: number) =>
        summaryRow({
          conversation_id: `c-${n}`,
          last_message_id: `m-${n}`,
          last_message_kind: 'agent',
          last_message_author_id: null,
          last_message_preview: null,
        });
      const rows = Array.from({ length: 250 }, (_, n) => agent(n));
      rpc
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({ data: rows, error: null });

      await service.listInbox(user);

      expect(from.mock.calls.filter(([table]) => table === 'agent_runs')).toHaveLength(3);
    });

    it("gives Robert's last messages their run state from one agent_runs read, never the reply", async () => {
      const agent = (id: string) =>
        summaryRow({
          conversation_id: id,
          last_message_id: `m-${id}`,
          last_message_kind: 'agent',
          last_message_author_id: null,
          last_message_preview: null,
        });
      rpc
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({
          data: [
            agent('queued'),
            agent('running'),
            agent('completed'),
            agent('cancelled'),
            agent('failed'),
            agent('orphan'),
            summaryRow({ conversation_id: 'human' }),
          ],
          error: null,
        });
      tableResults.agent_runs = [
        'queued',
        'running',
        'completed',
        'cancelled',
        'failed',
      ].map((status) => ({
        id: `run-${status}`,
        agent_message_id: `m-${status}`,
        status,
      }));

      const inbox = await service.listInbox(user);
      const status = (id: string) =>
        inbox.find((entry) => entry.id === id)?.lastMessage?.agentStatus;

      expect(
        ['queued', 'running', 'completed', 'cancelled', 'failed', 'orphan'].map(
          status,
        ),
      ).toEqual([
        'thinking',
        'thinking',
        'done',
        'cancelled',
        'failed',
        'failed',
      ]);
      expect(
        inbox.find((entry) => entry.id === 'human')?.lastMessage,
      ).not.toHaveProperty('agentStatus');

      const reads = from.mock.calls.filter(([table]) => table === 'agent_runs');
      expect(reads).toHaveLength(1);
      const query = from.mock.results[
        from.mock.calls.findIndex(([table]) => table === 'agent_runs')
      ].value as { calls: Array<[string, unknown[]]> };
      expect(query.calls).toContainEqual(['eq', ['organization_id', 'org-1']]);
    });

    it('says "proposed" for a finished run whose proposal waits for its invoker, in one more read', async () => {
      rpc
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({
          data: ['waiting', 'answered'].map((id) =>
            summaryRow({
              conversation_id: id,
              last_message_id: `m-${id}`,
              last_message_kind: 'agent',
              last_message_author_id: null,
              last_message_preview: null,
            }),
          ),
          error: null,
        });
      tableResults.agent_runs = ['waiting', 'answered'].map((id) => ({
        id: `run-${id}`,
        agent_message_id: `m-${id}`,
        status: 'completed',
      }));
      tableResults.agent_actions = [{ run_id: 'run-waiting' }];

      const inbox = await service.listInbox(user);
      const status = (id: string) =>
        inbox.find((entry) => entry.id === id)?.lastMessage?.agentStatus;

      expect([status('waiting'), status('answered')]).toEqual([
        'proposed',
        'done',
      ]);
      const reads = from.mock.calls.filter(
        ([table]) => table === 'agent_actions',
      );
      expect(reads).toHaveLength(1);
      const query = from.mock.results[
        from.mock.calls.findIndex(([table]) => table === 'agent_actions')
      ].value as { calls: Array<[string, unknown[]]> };
      expect(query.calls).toContainEqual(['eq', ['organization_id', 'org-1']]);
      expect(query.calls).toContainEqual([
        'in',
        ['status', ['proposed', 'failed']],
      ]);
    });

    it('does not read agent_runs when no last message is from Robert', async () => {
      await service.listInbox(user);

      expect(from).not.toHaveBeenCalledWith('agent_runs');
    });

    it('syncs space channels with the viewable spaces before summarising', async () => {
      await service.listInbox(user);

      expect(rpc).toHaveBeenNthCalledWith(
        1,
        'chat_sync_space_channel_members',
        {
          p_organization_id: 'org-1',
          p_user_id: 'user-1',
          p_space_ids: ['space-1'],
        },
      );
      expect(rpc).toHaveBeenNthCalledWith(2, 'chat_unread_summary', {
        p_organization_id: 'org-1',
        p_user_id: 'user-1',
      });
    });

    it('does not auto-join an org admin (all spaces viewable) to every channel', async () => {
      access.getViewableSpaceIds.mockResolvedValue(null);

      await service.listInbox(user);

      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith(
        'chat_unread_summary',
        expect.anything(),
      );
    });

    it('titles a DM with the other person and keeps pinned conversations first', async () => {
      rpc
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce({
          data: [
            summaryRow(),
            summaryRow({
              conversation_id: 'conv-2',
              kind: 'group',
              title: 'Audit',
              dm_key: null,
              pinned_at: '2026-09-01T00:00:00Z',
              last_message_at: '2026-01-01T00:00:00Z',
            }),
          ],
          error: null,
        });

      const inbox = await service.listInbox(user);

      expect(inbox.map((item) => item.id)).toEqual(['conv-2', 'conv-1']);
      expect(inbox[1]).toMatchObject({
        title: 'Ben Berger',
        unreadCount: 2,
        mentionCount: 1,
        lastMessage: { authorName: 'Ben Berger', preview: 'see you' },
      });
    });
  });

  // The conversation with Robert is a DM with ONE member, like the self-DM. The key
  // is least(user, Robert) || ':' || greatest(user, Robert), so Robert can be on
  // either side of it.
  describe.each([`user-1:${ROBERT_ID}`, `${ROBERT_ID}:user-1`])(
    'my conversation with Robert (dm_key %s)',
    (dmKey) => {
      const me = {
        id: 'user-1',
        first_name: 'Anna',
        last_name: 'Auer',
        email: 'a@x',
        avatar_url: null,
      };

      beforeEach(() => {
        tableResults.users = [me, ...(tableResults.users as unknown[])];
        tableResults.chat_members = [
          { user_id: 'user-1', role: 'member', joined_at: '2026-10-11' },
        ];
      });

      it('is marked in the inbox, titled "Robert" and has no counterpart', async () => {
        rpc
          .mockResolvedValueOnce({ data: null, error: null })
          .mockResolvedValueOnce({
            data: [
              summaryRow({ conversation_id: 'robert', dm_key: dmKey }),
              summaryRow({ conversation_id: 'self', dm_key: 'user-1:user-1' }),
              summaryRow({ conversation_id: 'ben' }),
              summaryRow({
                conversation_id: 'group',
                kind: 'group',
                title: 'Audit',
                dm_key: null,
              }),
            ],
            error: null,
          });

        const inbox = await service.listInbox(user);
        const item = (id: string) => inbox.find((entry) => entry.id === id);

        expect(item('robert')).toMatchObject({
          kind: 'dm',
          isAgentDm: true,
          title: 'Robert',
          counterpart: null,
        });
        // "Notes to self" is the DM whose counterpart is the caller: never Robert's.
        expect(item('self')).toMatchObject({
          isAgentDm: false,
          title: 'Anna Auer',
          counterpart: { id: 'user-1' },
        });
        expect(item('ben')).toMatchObject({
          isAgentDm: false,
          title: 'Ben Berger',
        });
        expect(item('group')).toMatchObject({
          isAgentDm: false,
          title: 'Audit',
        });
      });

      it('is marked in the conversation view, titled "Robert" and has no counterpart', async () => {
        const readable = (key: string) => ({
          conversation: {
            id: 'conv-1',
            organization_id: 'org-1',
            kind: 'dm',
            dm_key: key,
            title: null,
          },
          membership: { role: 'member' },
          historyFromSeq: 0,
        });

        access.getReadable.mockResolvedValue(readable(dmKey));
        const robert = await service.getConversation(user, 'conv-1');

        expect(robert).toMatchObject({
          kind: 'dm',
          isAgentDm: true,
          title: 'Robert',
          counterpart: null,
        });
        expect(robert.members.map((member) => member.id)).toEqual(['user-1']);

        access.getReadable.mockResolvedValue(readable('user-1:user-1'));
        await expect(
          service.getConversation(user, 'conv-1'),
        ).resolves.toMatchObject({
          isAgentDm: false,
          title: 'Anna Auer',
          counterpart: { id: 'user-1' },
        });
      });

      it('is labelled "Robert" for search hits', async () => {
        tableResults.chat_conversations = [
          { id: 'r', kind: 'dm', title: null, space_id: null, dm_key: dmKey },
        ];

        const labels = await service.labels(user, ['r']);

        expect(labels.get('r')).toEqual({
          id: 'r',
          kind: 'dm',
          title: 'Robert',
        });
      });
    },
  );

  it.each([ROBERT_ID, ROBERT_ID.toUpperCase()])(
    'refuses to open an ordinary DM with Robert (%s): he has his own route',
    async (robertId) => {
      await expect(service.openDm(user, robertId)).rejects.toThrow(
        BadRequestException,
      );
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it('still opens the DM with a colleague', async () => {
    rpc.mockResolvedValue({ data: 'conv-1', error: null });
    access.getReadable.mockResolvedValue({
      conversation: {
        id: 'conv-1',
        kind: 'dm',
        dm_key: 'user-1:user-2',
      },
      membership: { role: 'member' },
      historyFromSeq: 0,
    });
    tableResults.chat_members = [
      { user_id: 'user-2', role: 'member', joined_at: '2026-10-11' },
    ];

    await expect(service.openDm(user, 'user-2')).resolves.toMatchObject({
      id: 'conv-1',
      isAgentDm: false,
      title: 'Ben Berger',
    });
    expect(rpc).toHaveBeenCalledWith('chat_get_or_create_dm', {
      p_organization_id: 'org-1',
      p_user_id: 'user-1',
      p_other_user_id: 'user-2',
    });
  });

  it('answers 404 for the channel of a space the caller cannot view', async () => {
    access.canViewSpace.mockResolvedValue(false);

    await expect(service.getSpaceChannel(user, 'space-9')).rejects.toThrow(
      NotFoundException,
    );
    expect(rpc).not.toHaveBeenCalled();
  });

  describe('updateConversation', () => {
    const readable = (kind: string, role: string | null) => ({
      conversation: { id: 'conv-1', organization_id: 'org-1', kind },
      membership: role ? { role } : null,
      historyFromSeq: 0,
    });

    it('only renames groups', async () => {
      access.getReadable.mockResolvedValue(readable('dm', 'member'));

      await expect(
        service.updateConversation(user, 'conv-1', { title: 'x' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('only lets owners rename', async () => {
      access.getReadable.mockResolvedValue(readable('group', 'member'));

      await expect(
        service.updateConversation(user, 'conv-1', { title: 'x' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('my state in a conversation', () => {
    const readable = (membership: Record<string, unknown>) => ({
      conversation: { id: 'conv-1', organization_id: 'org-1', kind: 'group' },
      membership: { role: 'member', notify_level: 'all', ...membership },
      historyFromSeq: 0,
    });

    it('stores muteMentions for the caller only, next to the other settings', async () => {
      access.getReadable.mockResolvedValue(readable({}));

      await service.updateMyState(user, 'conv-1', {
        muteMentions: true,
        notifyLevel: 'none',
      });

      const update = from.mock.results
        .map((result) => result.value as ReturnType<typeof chain>)
        .find((query) => query.calls[0][0] === 'update');
      expect(update?.calls).toEqual([
        ['update', [{ notify_level: 'none', mute_mentions: true }]],
        ['eq', ['conversation_id', 'conv-1']],
        ['eq', ['user_id', 'user-1']],
        ['eq', ['organization_id', 'org-1']],
      ]);
    });

    it.each([
      [true, true],
      [false, false],
      // a database without the column yet
      [undefined, false],
    ])('returns muteMentions %s as %s in "me"', async (stored, expected) => {
      access.getReadable.mockResolvedValue(readable({ mute_mentions: stored }));

      const conversation = await service.getConversation(user, 'conv-1');

      expect(conversation.me?.muteMentions).toBe(expected);
    });
  });

  it('passes the organization from the user to membership RPCs', async () => {
    access.getReadable.mockResolvedValue({
      conversation: {},
      membership: {},
      historyFromSeq: 0,
    });
    rpc.mockResolvedValue({ data: 2, error: null });

    await expect(
      service.addMembers(user, 'conv-1', {
        userIds: ['user-3', 'user-4'],
        fullHistory: false,
      }),
    ).resolves.toEqual({ added: 2 });
    expect(rpc).toHaveBeenCalledWith('chat_add_members', {
      p_organization_id: 'org-1',
      p_conversation_id: 'conv-1',
      p_actor_id: 'user-1',
      p_user_ids: ['user-3', 'user-4'],
      p_full_history: false,
      p_members_can_add: true,
    });
  });

  it('maps a database refusal to the matching HTTP error', async () => {
    access.getReadable.mockResolvedValue({
      conversation: {},
      membership: {},
      historyFromSeq: 0,
    });
    rpc.mockResolvedValue({
      data: null,
      error: {
        code: '42501',
        message: 'chat: membership can only be changed in groups',
      },
    });

    await expect(service.leave(user, 'conv-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  describe('labels', () => {
    it('names each conversation for the caller: the other person, the group title, the space', async () => {
      tableResults.chat_conversations = [
        {
          id: 'dm-1',
          kind: 'dm',
          title: null,
          space_id: null,
          dm_key: 'user-1:user-2',
        },
        {
          id: 'group-1',
          kind: 'group',
          title: 'Security',
          space_id: null,
          dm_key: null,
        },
        {
          id: 'channel-1',
          kind: 'space',
          title: null,
          space_id: 'space-1',
          dm_key: null,
        },
      ];
      tableResults.spaces = [{ id: 'space-1', name: 'Operations', key: 'OPS' }];

      const labels = await service.labels(user, [
        'dm-1',
        'group-1',
        'channel-1',
        'dm-1',
      ]);

      expect([...labels.values()]).toEqual([
        { id: 'dm-1', kind: 'dm', title: 'Ben Berger' },
        { id: 'group-1', kind: 'group', title: 'Security' },
        { id: 'channel-1', kind: 'space', title: 'Operations' },
      ]);

      // Tenant boundary: only conversations and spaces of the caller's organization.
      const query = (table: string) =>
        from.mock.results[from.mock.calls.findIndex(([name]) => name === table)]
          .value as ReturnType<typeof chain>;
      expect(query('chat_conversations').calls).toEqual([
        ['select', ['id, kind, title, space_id, dm_key']],
        ['eq', ['organization_id', 'org-1']],
        ['in', ['id', ['dm-1', 'group-1', 'channel-1']]],
      ]);
      expect(query('spaces').calls).toContainEqual([
        'eq',
        ['organization_id', 'org-1'],
      ]);
      expect(query('users').calls).toContainEqual(['in', ['id', ['user-2']]]);
    });

    it('has an empty title where there is no name: an unnamed group, a removed person, a lost space', async () => {
      tableResults.chat_conversations = [
        { id: 'g', kind: 'group', title: null, space_id: null, dm_key: null },
        {
          id: 'd',
          kind: 'dm',
          title: null,
          space_id: null,
          dm_key: 'user-1:gone',
        },
        { id: 'c', kind: 'space', title: null, space_id: 'x', dm_key: null },
      ];

      const labels = await service.labels(user, ['g', 'd', 'c']);

      expect([...labels.values()].map((label) => label.title)).toEqual([
        '',
        '',
        '',
      ]);
    });

    it('asks nothing for an empty list', async () => {
      await expect(service.labels(user, [])).resolves.toEqual(new Map());
      expect(from).not.toHaveBeenCalled();
    });
  });
});
