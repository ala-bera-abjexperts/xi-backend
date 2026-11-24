import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { ChatAccessService } from './chat-access.service';
import { ChatRealtimeService } from './chat-realtime.service';

const SECRET = 'test-secret-test-secret-test-secret';

/** chat_members query double; `filters` records every eq() it receives. */
function members(userIds: string[], filters: unknown[][]) {
  const query: Record<string, unknown> = {};
  query.select = () => query;
  query.eq = (...args: unknown[]) => {
    filters.push(args);
    return query;
  };
  // Like the database: never more rows than asked for.
  query.limit = (max: number) => {
    userIds = userIds.slice(0, max);
    return query;
  };
  query.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({
      data: userIds.map((user_id) => ({ user_id })),
      error: null,
    }).then(resolve);
  return query;
}

describe('ChatRealtimeService', () => {
  const user = {
    userId: 'user-1',
    authUserId: 'auth-1',
    organizationId: 'org-1',
  } as RequestUser;

  let config: Record<string, string>;
  let fetchMock: jest.Mock;
  let getReadable: jest.Mock;
  let memberIds: string[];
  let memberFilters: unknown[][];
  let service: ChatRealtimeService;
  const jwt = new JwtService({});

  const build = () =>
    new ChatRealtimeService(
      {
        get: (key: string, fallback?: string) => config[key] ?? fallback,
      } as unknown as ConfigService,
      {
        getClient: () => ({
          from: () => members(memberIds, memberFilters),
        }),
      } as unknown as SupabaseAdminService,
      { getReadable } as unknown as ChatAccessService,
      jwt,
    );

  /** The parsed body of the n-th fetch call. */
  const sent = (index = 0) => {
    const [, init] = fetchMock.mock.calls[index] as [string, { body: string }];
    return JSON.parse(init.body) as {
      messages: {
        topic: string;
        event: string;
        payload: unknown;
        private: boolean;
      }[];
    };
  };

  beforeEach(() => {
    config = {
      SUPABASE_URL: 'http://supabase.test/',
      SUPABASE_SERVICE_ROLE_KEY: 'service-key',
      'supabase.jwtSecret': SECRET,
    };
    memberIds = ['user-1', 'user-2'];
    memberFilters = [];
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;
    getReadable = jest.fn().mockResolvedValue({});
    service = build();
  });

  describe('broadcast', () => {
    it('sends every message in one private POST with a timeout signal', async () => {
      await service.broadcast([
        { topic: 'chat:c1', event: 'a', payload: {} },
        { topic: 'chat:c2', event: 'b', payload: {} },
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [
        string,
        { signal: unknown },
      ];
      expect(url).toBe('http://supabase.test/realtime/v1/api/broadcast');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(sent().messages.map((m) => m.private)).toEqual([true, true]);
    });

    it('never throws on a network error, timeout or HTTP error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('timeout'));
      await expect(
        service.broadcast([{ topic: 't', event: 'e', payload: {} }]),
      ).resolves.toBeUndefined();

      fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
      await expect(
        service.broadcast([{ topic: 't', event: 'e', payload: {} }]),
      ).resolves.toBeUndefined();
    });

    it('skips the request when there is nothing to send or no config', async () => {
      await service.broadcast([]);
      config = {};
      await build().broadcast([{ topic: 't', event: 'e', payload: {} }]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('messageCreated fans out inbox.changed to DM/group members in the same request', async () => {
    await service.messageCreated(
      { id: 'c1', kind: 'group', organization_id: 'org-1' },
      { messageId: 'm1', seq: 4, threadRootId: null },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent().messages).toEqual([
      {
        topic: 'chat:c1',
        event: 'message.created',
        payload: {
          conversationId: 'c1',
          messageId: 'm1',
          seq: 4,
          threadRootId: null,
        },
        private: true,
      },
      {
        topic: 'chat-user:user-1',
        event: 'inbox.changed',
        payload: { conversationId: 'c1' },
        private: true,
      },
      {
        topic: 'chat-user:user-2',
        event: 'inbox.changed',
        payload: { conversationId: 'c1' },
        private: true,
      },
    ]);
  });

  it('messageCreated in a space channel signals the inbox of its members too', async () => {
    // Without it their unread badge waits for the next inbox poll (up to 5 minutes).
    await service.messageCreated(
      { id: 'c1', kind: 'space', organization_id: 'org-1' },
      { messageId: 'm1', seq: 4, threadRootId: 'root' },
    );

    expect(sent().messages.map((m) => `${m.topic} ${m.event}`)).toEqual([
      'chat:c1 message.created',
      'chat-user:user-1 inbox.changed',
      'chat-user:user-2 inbox.changed',
    ]);
  });

  it.each([
    [500, 501],
    [501, 1],
  ])(
    'messageCreated with %i member rows sends %i signal(s): no per-user fan-out above 500',
    async (memberRows, signals) => {
      memberIds = Array.from({ length: memberRows }, (_, i) => `user-${i}`);

      await service.messageCreated(
        { id: 'c1', kind: 'space', organization_id: 'org-1' },
        { messageId: 'm1', seq: 4, threadRootId: null },
      );

      expect(sent().messages).toHaveLength(signals);
      expect(sent().messages[0].topic).toBe('chat:c1');
    },
  );

  it('conversationChanged also tells people who just left', async () => {
    await service.conversationChanged('c1', 'org-1', ['user-9']);

    expect(sent().messages.map((m) => `${m.topic} ${m.event}`)).toEqual([
      'chat:c1 conversation.changed',
      'chat-user:user-1 inbox.changed',
      'chat-user:user-2 inbox.changed',
      'chat-user:user-9 inbox.changed',
    ]);
  });

  it('loads the members to signal within the organization only', async () => {
    await service.messageCreated(
      { id: 'c1', kind: 'dm', organization_id: 'org-1' },
      { messageId: 'm1', seq: 4, threadRootId: null },
    );
    await service.conversationChanged('c2', 'org-2');
    await service.inboxChanged('c3', 'org-3');

    expect(memberFilters).toEqual([
      ['conversation_id', 'c1'],
      ['organization_id', 'org-1'],
      ['conversation_id', 'c2'],
      ['organization_id', 'org-2'],
      ['conversation_id', 'c3'],
      ['organization_id', 'org-3'],
    ]);
  });

  it('per-message helpers carry ids only', async () => {
    await service.messageUpdated('c1', 'm1');
    await service.messageDeleted('c1', 'm1');
    await service.reactionChanged('c1', 'm1');

    expect([0, 1, 2].map((i) => sent(i).messages[0])).toEqual(
      ['message.updated', 'message.deleted', 'reaction.changed'].map(
        (event) => ({
          topic: 'chat:c1',
          event,
          payload: { conversationId: 'c1', messageId: 'm1' },
          private: true,
        }),
      ),
    );
  });

  describe('agentRunUpdated', () => {
    const run = {
      conversationId: 'c1',
      invokerId: 'user-1',
      runId: 'r1',
      rev: 3,
    };
    const topicOf = async (
      visibility: 'pending' | 'invoker' | 'conversation',
      decided?: boolean,
    ) => {
      fetchMock.mockClear();
      await service.agentRunUpdated({ ...run, visibility }, decided);
      return sent().messages.map((m) => m.topic);
    };

    it('goes to the conversation while thinking and for a shared run, with ids only', async () => {
      await expect(topicOf('pending')).resolves.toEqual(['chat:c1']);
      await expect(topicOf('conversation')).resolves.toEqual(['chat:c1']);
      expect(sent().messages[0]).toEqual({
        topic: 'chat:c1',
        event: 'agent.run.updated',
        payload: { conversationId: 'c1', runId: 'r1', rev: 3 },
        private: true,
      });
    });

    it('goes only to the invoker for a private run, except at the moment its audience is decided', async () => {
      await expect(topicOf('invoker')).resolves.toEqual(['chat-user:user-1']);
      await expect(topicOf('invoker', true)).resolves.toEqual(['chat:c1']);
    });

    it('sends nothing for a private run whose invoker is gone', async () => {
      await service.agentRunUpdated({
        ...run,
        invokerId: null,
        visibility: 'invoker',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('mintToken', () => {
    it('grants the inbox topic plus only the readable conversations', async () => {
      getReadable.mockImplementation((_user: RequestUser, id: string) =>
        id === 'hidden'
          ? Promise.reject(new NotFoundException())
          : Promise.resolve({}),
      );

      const result = await service.mintToken(user, ['c1', 'hidden', 'c1']);

      expect(result.topics).toEqual(['chat-user:user-1', 'chat:c1']);
      const claims = jwt.verify<Record<string, unknown>>(result.token, {
        secret: SECRET,
      });
      expect(claims).toMatchObject({
        iss: 'xisuite-backend',
        sub: 'auth-1',
        role: 'authenticated',
        aud: 'authenticated',
        chat_topics: ['chat-user:user-1', 'chat:c1'],
        app_user_id: 'user-1',
        org_id: 'org-1',
      });
      expect((claims.exp as number) - (claims.iat as number)).toBe(600);
      expect(new Date(result.expiresAt).getTime()).toBe(
        (claims.exp as number) * 1000,
      );
    });

    it('answers 503 without a JWT secret', async () => {
      delete config['supabase.jwtSecret'];

      await expect(build().mintToken(user, [])).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('does not swallow unexpected access errors', async () => {
      getReadable.mockRejectedValue(new Error('db down'));

      await expect(service.mintToken(user, ['c1'])).rejects.toThrow('db down');
    });
  });
});
