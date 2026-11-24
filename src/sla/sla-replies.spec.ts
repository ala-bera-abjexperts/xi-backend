import { ForbiddenException } from '@nestjs/common';
import { SlaRepliesService } from './sla-replies.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { SlaAccessService } from './sla-access.service';

describe('customer publication boundary', () => {
  const user = { userId: 'staff', organizationId: 'org' } as any;
  it('checks task permission before reading or publishing', async () => {
    const db = { from: jest.fn(), rpc: jest.fn() };
    const access = {
      authorizeTask: jest.fn().mockRejectedValue(new ForbiddenException()),
    };
    const service = new SlaRepliesService(
      { getClient: () => db } as any,
      access as any,
    );
    await expect(
      service.publish(user, 'task', {
        content: 'Reply',
        request_id: 'request',
        idempotency_key: 'key',
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it('reads only published replies after requester ownership check, never comments', async () => {
    const query: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null }),
      order: jest.fn(),
    };
    const db = { from: jest.fn().mockReturnValue(query) };
    const service = new SlaRepliesService(
      { getClient: () => db } as any,
      {} as any,
    );
    await expect(
      service.requesterReplies('request', 'other-user'),
    ).rejects.toThrow('Support request not found');
    expect(db.from).toHaveBeenCalledTimes(1);
    expect(query.eq).toHaveBeenCalledWith('created_by', 'other-user');
  });
});

describe('publication content and retries', () => {
  const request = { id: 'request', organization_id: 'org' };
  const user = { userId: 'staff' } as any;
  it('sanitizes content and commits reply/evidence through a single atomic RPC', async () => {
    const rpc = jest
      .fn()
      .mockResolvedValue({ data: { id: 'reply' }, error: null });
    const service = new SlaRepliesService(
      { getClient: () => ({ rpc }) } as any,
      {} as any,
    );
    jest.spyOn(service, 'linkedRequest').mockResolvedValue(request as any);
    await service.publish(user, 'task', {
      content: '<script>alert(1)</script><p>Hello</p>',
      request_id: 'request',
      idempotency_key: 'stable-key',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      'sla_publish_customer_reply',
      expect.objectContaining({
        p_content: '<p>Hello</p>',
        p_request_id: 'request',
        p_idempotency_key: 'stable-key',
        p_actor_id: 'staff',
      }),
    );
  });
  it('rejects missing linkage and content stripped to nothing', async () => {
    const rpc = jest.fn();
    const service = new SlaRepliesService(
      { getClient: () => ({ rpc }) } as any,
      {} as any,
    );
    const link = jest.spyOn(service, 'linkedRequest').mockResolvedValue(null);
    await expect(
      service.publish(user, 'task', {
        content: 'hello',
        request_id: 'request',
        idempotency_key: 'key',
      }),
    ).rejects.toThrow('Link a support request');
    link.mockResolvedValue(request as any);
    await expect(
      service.publish(user, 'task', {
        content: '<script>alert(1)</script>',
        request_id: 'request',
        idempotency_key: 'key',
      }),
    ).rejects.toThrow('readable text');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects publication when another staff member changed the displayed requester', async () => {
    const rpc = jest.fn();
    const service = new SlaRepliesService(
      { getClient: () => ({ rpc }) } as any,
      {} as any,
    );
    jest
      .spyOn(service, 'linkedRequest')
      .mockResolvedValue({ ...request, id: 'new-request' } as any);
    await expect(
      service.publish(user, 'task', {
        content: 'Hello',
        request_id: 'request',
        idempotency_key: 'key',
      }),
    ).rejects.toThrow('requester changed');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('propagates idempotency and locked-association conflicts', async () => {
    const rpc = jest.fn().mockResolvedValue({ error: { code: '23505' } });
    const access = {
      authorizeTask: jest.fn().mockResolvedValue({ organization_id: 'org' }),
    };
    const service = new SlaRepliesService(
      { getClient: () => ({ rpc }) } as any,
      access as any,
    );
    jest.spyOn(service, 'linkedRequest').mockResolvedValue(request as any);
    await expect(
      service.publish(user, 'task', {
        content: 'Different content',
        request_id: 'request',
        idempotency_key: 'same-key',
      }),
    ).rejects.toThrow('conflicts');
    await expect(service.link(user, 'task', null)).rejects.toThrow('conflicts');
    expect(rpc).toHaveBeenLastCalledWith('sla_link_request_task', {
      p_request_id: 'request',
      p_task_id: null,
      p_organization_id: 'org',
    });
  });
});

describe('linkable support request choices', () => {
  const user = { userId: 'staff', organizationId: 'org' } as any;
  const row = { id: 'r', ticket_number: 1, subject: 'Access request' };
  function mock(results: any[]) {
    const chains: any[] = [];
    const db = {
      from: jest.fn(() => {
        const result = results.shift();
        const chain: any = {
          then: (resolve: any) => Promise.resolve(result).then(resolve),
        };
        for (const key of ['select', 'eq', 'is', 'ilike', 'order', 'limit'])
          chain[key] = jest.fn(() => chain);
        chains.push(chain);
        return chain;
      }),
    };
    const access = {
      authorizeTask: jest
        .fn()
        .mockResolvedValue({ organization_id: 'org', space_id: 'space' }),
    };
    return {
      service: new SlaRepliesService(
        { getClient: () => db } as any,
        access as any,
      ),
      db,
      access,
      chains,
    };
  }
  it('authorizes actual task and exposes only unlinked unlocked requests in its tenant and space', async () => {
    const m = mock([{ data: [row], error: null }]);
    expect(await m.service.supportRequestOptions(user, 'task')).toEqual({
      options: [row],
      hasMore: false,
    });
    expect(m.access.authorizeTask).toHaveBeenCalledWith(
      user,
      'task',
      'publish_customer_replies',
    );
    expect(m.chains[0].eq).toHaveBeenCalledWith('organization_id', 'org');
    expect(m.chains[0].eq).toHaveBeenCalledWith('space_id', 'space');
    expect(m.chains[0].is).toHaveBeenCalledWith('task_id', null);
    expect(m.chains[0].is).toHaveBeenCalledWith('association_locked_at', null);
    expect(m.chains[0].limit).toHaveBeenCalledWith(51);
  });
  it('escapes search literals, deduplicates both search columns and reports overflow', async () => {
    const m = mock([
      { data: [row], error: null },
      { data: [row], error: null },
    ]);
    expect(
      await m.service.supportRequestOptions(user, 'task', 'Access%'),
    ).toEqual({ options: [row], hasMore: false });
    expect(m.chains[0].ilike).toHaveBeenCalledWith('subject', '%Access\\%%');
    expect(m.chains).toHaveLength(1);
    const many = mock([
      {
        data: Array.from({ length: 51 }, (_, i) => ({ ...row, id: String(i) })),
        error: null,
      },
    ]);
    const result = await many.service.supportRequestOptions(user, 'task');
    expect(result.options).toHaveLength(50);
    expect(result.hasMore).toBe(true);
  });
  it('uses exact bigint ticket matching and sorts numeric results safely', async () => {
    const m = mock([
      { data: [{ ...row, id: 'ten', ticket_number: 10 }], error: null },
      { data: [{ ...row, id: 'two', ticket_number: 2 }], error: null },
    ]);
    const result = await m.service.supportRequestOptions(user, 'task', '#10');
    expect(result.options.map((option) => option.ticket_number)).toEqual([
      2, 10,
    ]);
    expect(m.chains[0].eq).toHaveBeenCalledWith('ticket_number', '10');
    for (const chain of m.chains)
      expect(chain.ilike).not.toHaveBeenCalledWith(
        'ticket_number',
        expect.anything(),
      );
  });
  it('fails closed for denied access, malformed input and database errors', async () => {
    const denied = mock([]);
    denied.access.authorizeTask.mockRejectedValue(new ForbiddenException());
    await expect(
      denied.service.supportRequestOptions(user, 'task'),
    ).rejects.toThrow(ForbiddenException);
    expect(denied.db.from).not.toHaveBeenCalled();
    await expect(
      mock([]).service.supportRequestOptions(user, 'task', 'x'.repeat(201)),
    ).rejects.toThrow('Invalid');
    await expect(
      mock([
        { error: { message: 'private' }, data: null },
      ]).service.supportRequestOptions(user, 'task'),
    ).rejects.toThrow('Unable');
  });
});

describe('customer reply thread', () => {
  type Linked = Awaited<ReturnType<SlaRepliesService['linkedRequest']>>;
  type Chain = Record<string, jest.Mock> & { then: unknown };
  const user = {
    userId: 'staff',
    organizationId: 'org',
  } as unknown as RequestUser;
  const request = { id: 'request', organization_id: 'org' } as Linked;
  function mock(results: Record<string, unknown>) {
    const chains: Record<string, Chain> = {};
    const db = {
      from: jest.fn((table: string) => {
        const chain = {
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(results[table]).then(resolve),
        } as Chain;
        for (const key of ['select', 'eq', 'in'])
          chain[key] = jest.fn(() => chain);
        chains[table] = chain;
        return chain;
      }),
    };
    const service = (access: unknown = {}) =>
      new SlaRepliesService(
        { getClient: () => db } as unknown as SupabaseAdminService,
        access as SlaAccessService,
      );
    return { service, db, chains };
  }
  it('returns [] without querying when no request is linked', async () => {
    const m = mock({});
    const service = m.service();
    jest.spyOn(service, 'linkedRequest').mockResolvedValue(null);
    expect(await service.thread(user, 'task')).toEqual([]);
    expect(m.db.from).not.toHaveBeenCalled();
  });
  it('merges replies and portal comments sorted by time, without emails', async () => {
    const staff = {
      id: 'staff',
      first_name: 'S',
      last_name: 'T',
      avatar_url: null,
    };
    const editor = {
      id: 'editor',
      first_name: 'E',
      last_name: 'D',
      avatar_url: null,
    };
    const at = (day: number) => `2026-01-0${day}T00:00:00Z`;
    const m = mock({
      support_customer_replies: {
        data: [
          {
            id: 'r2',
            content: '<p>b</p>',
            published_at: at(3),
            author_id: 'staff',
          },
          {
            id: 'r1',
            content: '<p>a</p>',
            published_at: at(1),
            author_id: 'staff',
          },
        ],
        error: null,
      },
      task_comments: {
        data: [
          {
            id: 'c1',
            task_id: 'task',
            content: '<p>c</p>',
            created_at: at(2),
            updated_at: null,
            created_by: null,
            edited_by: 'editor',
          },
        ],
        error: null,
      },
      users: { data: [staff, editor], error: null },
    });
    const service = m.service();
    jest.spyOn(service, 'linkedRequest').mockResolvedValue(request);
    expect(await service.thread(user, 'task')).toEqual([
      {
        id: 'r1',
        kind: 'reply',
        content: '<p>a</p>',
        created_at: at(1),
        updated_at: at(1),
        author: staff,
      },
      {
        id: 'c1',
        kind: 'comment',
        task_id: 'task',
        content: '<p>c</p>',
        created_at: at(2),
        updated_at: at(2),
        edited_by: 'editor',
        author: null,
        editor: { id: 'editor', first_name: 'E', last_name: 'D' },
      },
      {
        id: 'r2',
        kind: 'reply',
        content: '<p>b</p>',
        created_at: at(3),
        updated_at: at(3),
        author: staff,
      },
    ]);
    const { support_customer_replies: replies, task_comments: comments } =
      m.chains;
    expect(replies.eq).toHaveBeenCalledWith('request_id', 'request');
    expect(replies.eq).toHaveBeenCalledWith('organization_id', 'org');
    expect(comments.eq).toHaveBeenCalledWith('support_request_id', 'request');
    expect(comments.eq).toHaveBeenCalledWith('organization_id', 'org');
    expect(m.chains.users.in).toHaveBeenCalledWith('id', ['staff', 'editor']);
    expect(comments.select).toHaveBeenCalledWith(
      expect.stringContaining('task_id'),
    );
    expect(comments.select).toHaveBeenCalledWith(
      expect.stringContaining('edited_by'),
    );
    for (const chain of Object.values(m.chains))
      expect(chain.select).not.toHaveBeenCalledWith(
        expect.stringContaining('email'),
      );
  });
  it('propagates task authorization failure before reading any data', async () => {
    const m = mock({});
    const access = {
      authorizeTask: jest.fn().mockRejectedValue(new ForbiddenException()),
    };
    await expect(m.service(access).thread(user, 'task')).rejects.toThrow(
      ForbiddenException,
    );
    expect(access.authorizeTask).toHaveBeenCalledWith(
      user,
      'task',
      'publish_customer_replies',
    );
    expect(m.db.from).not.toHaveBeenCalled();
  });
});
