import { NotFoundException } from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { ChatAccessService } from '../chat/chat-access.service';
import type { ChatConversationsService } from '../chat/chat-conversations.service';
import type { ChatRealtimeService } from '../chat/chat-realtime.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AgentRunViewService } from './agent-run-view.service';

type Row = Record<string, unknown>;

/** In-memory tables answering the eq / in / limit filters the service builds. */
function fakeDb(tables: Record<string, Row[]>) {
  const queries: string[] = [];
  const from = (table: string) => {
    queries.push(table);
    const filters: ((row: Row) => boolean)[] = [];
    let max = Infinity;
    let sort: (a: Row, b: Row) => number = () => 0;
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, value: unknown) => {
        filters.push((row) => row[col] === value);
        return q;
      },
      in: (col: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[col]));
        return q;
      },
      limit: (n: number) => {
        max = n;
        return q;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        sort = (a, b) =>
          (Number(a[col]) - Number(b[col])) *
          (opts?.ascending === false ? -1 : 1);
        return q;
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: (tables[table] ?? [])
            .filter((row) => filters.every((f) => f(row)))
            .sort(sort)
            .slice(0, max),
          error: null,
        }).then(resolve),
    };
    return q;
  };
  return { from, queries };
}

const ME = 'user-me';
const ANNA = 'user-anna';

const runRow = (over: Row = {}): Row => ({
  id: 'run-1',
  organization_id: 'org-1',
  conversation_id: 'group-1',
  trigger_message_id: 'msg-t',
  agent_message_id: 'msg-a',
  invoker_id: ANNA,
  status: 'completed',
  visibility: 'conversation',
  rev: 7,
  error_code: null,
  step: 'understanding',
  budget_month: '2026-10-01',
  budget_day: '2026-10-22',
  cancelled_by: null,
  provider: 'openai',
  timezone: 'Europe/Vienna',
  trigger_seq: 12,
  thread_root_id: null,
  trigger_edit_count: 0,
  context_message_ids: ['msg-1', 'msg-2', 'msg-3'],
  context_min_seq: 10,
  context_capped: false,
  reply_text: 'Freitag.',
  reply_lang: 'de',
  more_items: false,
  unsupported: 'none',
  is_first_for_invoker: true,
  created_at: '2026-10-22T10:32:00Z',
  ...over,
});

describe('AgentRunViewService', () => {
  const me = { userId: ME, organizationId: 'org-1' } as RequestUser;
  let tables: Record<string, Row[]>;
  let db: ReturnType<typeof fakeDb>;
  let access: Record<string, jest.Mock>;
  let loadUsers: jest.Mock;
  let agentRunUpdated: jest.Mock;
  let service: AgentRunViewService;

  beforeEach(() => {
    tables = {
      agent_runs: [runRow()],
      chat_conversations: [
        {
          id: 'group-1',
          organization_id: 'org-1',
          kind: 'group',
          space_id: null,
        },
        {
          id: 'chan-1',
          organization_id: 'org-1',
          kind: 'space',
          space_id: 'space-1',
        },
      ],
      chat_members: [
        {
          conversation_id: 'group-1',
          organization_id: 'org-1',
          user_id: ME,
          history_from_seq: 0,
        },
      ],
      chat_messages: [
        {
          id: 'msg-t',
          organization_id: 'org-1',
          edit_count: 0,
          deleted_at: null,
          created_at: '2026-10-22T10:31:30Z',
        },
        {
          id: 'msg-1',
          organization_id: 'org-1',
          edit_count: 0,
          deleted_at: null,
          created_at: '2026-10-22T10:02:00Z',
        },
        {
          id: 'msg-3',
          organization_id: 'org-1',
          edit_count: 0,
          deleted_at: null,
          created_at: '2026-10-22T10:31:00Z',
        },
      ],
      agent_audit_events: [
        {
          organization_id: 'org-1',
          event: 'run.completed',
          run_id: 'run-1',
          data: { intents: 2 },
        },
      ],
    };
    db = fakeDb(tables);
    access = {
      getViewableSpaceIds: jest.fn().mockResolvedValue(['space-1']),
      hasPermission: jest.fn().mockResolvedValue(false),
    };
    loadUsers = jest.fn(
      (ids: string[]) =>
        new Map(
          ids.map((id) => [id, { id, name: id === ANNA ? 'Anna' : 'Me' }]),
        ),
    );
    agentRunUpdated = jest.fn().mockResolvedValue(undefined);
    service = new AgentRunViewService(
      {
        getClient: () => ({ from: db.from }),
      } as unknown as SupabaseAdminService,
      access as unknown as ChatAccessService,
      { loadUsers } as unknown as ChatConversationsService,
      { agentRunUpdated } as unknown as ChatRealtimeService,
    );
  });

  const resolveOne = async (
    ids: { runIds?: string[]; triggerMessageIds?: string[] } = {
      runIds: ['run-1'],
    },
  ) => (await service.resolve(me, ids))[0];

  it('gives a member the full view of a shared run: codes, ids and ISO dates only', async () => {
    const view = await resolveOne();

    expect(view).toEqual({
      id: 'run-1',
      rev: 7,
      conversationId: 'group-1',
      messageId: 'msg-a',
      triggerMessageId: 'msg-t',
      threadRootId: null,
      access: 'full',
      viewer: 'member',
      visibility: 'conversation',
      invoker: { id: ANNA, name: 'Anna' },
      phase: 'done',
      serverNow: expect.any(String) as string,
      createdAt: '2026-10-22T10:32:00Z',
      reply: 'Freitag.',
      replyLang: 'de',
      context: {
        messageIds: ['msg-1', 'msg-2', 'msg-3'],
        count: 3,
        from: '2026-10-22T10:02:00Z',
        to: '2026-10-22T10:31:00Z',
        capped: false,
      },
      actions: [],
      moreItems: false,
      unsupported: null,
      flags: {
        requestEdited: false,
        requestDeleted: false,
        itemsDeferred: 2,
        unsupportedKinds: [],
      },
      expiresAt: null,
      undoUntil: null,
    });
  });

  it('gives the invoker the disclosure of their first run and the feedback slot', async () => {
    tables.agent_runs = [runRow({ invoker_id: ME })];

    expect(await resolveOne()).toMatchObject({
      viewer: 'invoker',
      disclosure: { provider: 'openai' },
      feedback: null,
    });
  });

  it('gives a "from now on" member the stub, never the summary of messages they cannot read', async () => {
    tables.chat_members[0].history_from_seq = 10;
    const view = await resolveOne();

    expect(view).toMatchObject({ access: 'stub', resultRefs: [] });
    expect(view).not.toHaveProperty('reply');
    expect(view).not.toHaveProperty('context');
  });

  it('gives others the stub of a private run', async () => {
    tables.agent_runs = [runRow({ visibility: 'invoker' })];

    expect(await resolveOne()).toMatchObject({ access: 'stub' });
  });

  it('shows a thinking run with its step', async () => {
    tables.agent_runs = [
      runRow({
        status: 'running',
        visibility: 'pending',
        reply_text: null,
        invoker_id: ME,
      }),
    ];
    const view = await resolveOne();

    expect(view).toMatchObject({ phase: 'thinking', step: 'understanding' });
    expect(view).not.toHaveProperty('context');
    expect(view).not.toHaveProperty('notice');
  });

  it('leaves out runs of conversations the caller cannot read, even their own', async () => {
    tables.chat_members = [];
    tables.agent_runs = [runRow(), runRow({ id: 'run-2', invoker_id: ME })];

    await expect(
      service.resolve(me, { runIds: ['run-1', 'run-2'] }),
    ).resolves.toEqual([]);
  });

  it('leaves out runs of another organization (cross-tenant ids)', async () => {
    tables.agent_runs = [runRow({ organization_id: 'org-2' })];

    await expect(service.resolve(me, { runIds: ['run-1'] })).resolves.toEqual(
      [],
    );
    await expect(service.viewOne(me, 'run-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("leaves out someone else's refusal: it is a notice for its invoker only", async () => {
    tables.agent_runs = [
      runRow({
        status: 'refused',
        agent_message_id: null,
        error_code: 'disabled',
        visibility: 'invoker',
      }),
    ];

    await expect(service.resolve(me, { runIds: ['run-1'] })).resolves.toEqual(
      [],
    );
  });

  it('checks space channels against one read of the viewable spaces', async () => {
    tables.agent_runs = [
      runRow({ id: 'run-1', conversation_id: 'chan-1' }),
      runRow({ id: 'run-2', conversation_id: 'chan-1' }),
    ];
    await expect(
      service.resolve(me, { runIds: ['run-1', 'run-2'] }),
    ).resolves.toHaveLength(2);
    expect(access.getViewableSpaceIds).toHaveBeenCalledTimes(1);

    access.getViewableSpaceIds.mockResolvedValue(['space-9']);
    await expect(service.resolve(me, { runIds: ['run-1'] })).resolves.toEqual(
      [],
    );
  });

  it('reads many runs with the same number of queries as one (no N+1)', async () => {
    await service.resolve(me, { runIds: ['run-1'] });
    const forOne = db.queries.length;

    tables.agent_runs = Array.from({ length: 40 }, (_, i) =>
      runRow({ id: `run-${i}` }),
    );
    db.queries.length = 0;
    const views = await service.resolve(me, {
      runIds: tables.agent_runs.map((r) => r.id as string),
    });

    expect(views).toHaveLength(40);
    expect(db.queries.length).toBe(forOne);
    expect(loadUsers).toHaveBeenCalledTimes(2);
  });

  it('finds every run of a request by its trigger id, oldest first', async () => {
    tables.agent_runs = [
      runRow({ id: 'run-2', created_at: '2026-10-22T11:00:00Z' }),
      runRow({ id: 'run-1' }),
    ];
    const views = await service.resolve(me, { triggerMessageIds: ['msg-t'] });

    expect(views.map((v) => v.id)).toEqual(['run-1', 'run-2']);
  });

  describe('notices', () => {
    const asInvoker = (over: Row) => {
      tables.agent_runs = [
        runRow({ invoker_id: ME, reply_text: null, ...over }),
      ];
      return resolveOne();
    };

    it.each([
      ['budget_org', { period: 'month', resetsAt: '2026-11-01T00:00:00.000Z' }],
      ['budget_user', { period: 'day', resetsAt: '2026-10-23T00:00:00.000Z' }],
    ])(
      'carries the period and reset time of a %s refusal',
      async (code, params) => {
        expect(
          await asInvoker({
            status: 'refused',
            agent_message_id: null,
            error_code: code,
            visibility: 'invoker',
          }),
        ).toMatchObject({
          phase: 'refused',
          messageId: null,
          notice: { code, params, retryable: false, adminLink: false },
        });
      },
    );

    it('rolls a December budget over into January', async () => {
      const view = await asInvoker({
        status: 'refused',
        error_code: 'budget_org',
        budget_month: '2026-12-01',
      });
      expect(view.notice?.params).toEqual({
        period: 'month',
        resetsAt: '2027-01-01T00:00:00.000Z',
      });
    });

    it.each([
      ['rate_limited', true],
      ['provider_down', true],
      ['timeout', true],
      ['busy', true],
      ['interrupted', true],
      ['failed', true],
      ['invalid_key', false],
    ])('marks a %s failure retryable: %s', async (code, retryable) => {
      expect(
        await asInvoker({ status: 'failed', error_code: code }),
      ).toMatchObject({
        phase: 'failed',
        notice: { code, retryable },
      });
    });

    it('links Robert managers, and only them, to the AI settings on a key problem', async () => {
      expect(
        (await asInvoker({ status: 'failed', error_code: 'invalid_key' }))
          .notice?.adminLink,
      ).toBe(false);

      access.hasPermission.mockResolvedValue(true);
      expect(
        (await asInvoker({ status: 'failed', error_code: 'invalid_key' }))
          .notice?.adminLink,
      ).toBe(true);
      expect(access.hasPermission).toHaveBeenLastCalledWith(
        me,
        'can_manage_robert',
      );
      expect(
        (await asInvoker({ status: 'failed', error_code: 'timeout' })).notice
          ?.adminLink,
      ).toBe(false);
    });

    it('names who stopped a run, without a notice', async () => {
      const view = await asInvoker({ status: 'cancelled', cancelled_by: ME });

      expect(view).toMatchObject({
        phase: 'cancelled',
        cancelledBy: { id: ME, name: 'Me' },
      });
      expect(view).not.toHaveProperty('notice');
    });
  });

  it('flags a request that was edited or deleted after the run', async () => {
    tables.chat_messages[0].edit_count = 1;
    expect((await resolveOne()).flags).toMatchObject({
      requestEdited: true,
      requestDeleted: false,
    });

    tables.chat_messages[0].deleted_at = '2026-10-22T12:00:00Z';
    expect((await resolveOne()).flags).toMatchObject({
      requestEdited: false,
      requestDeleted: true,
    });
  });

  it('offers Re-run on the newest run of an edited request only, refused or not', async () => {
    tables.chat_messages[0].edit_count = 1;
    const older = runRow({ created_at: '2026-10-22T09:00:00Z' });

    for (const newer of [
      runRow({ id: 'run-2', created_at: '2026-10-22T10:00:00Z' }),
      runRow({
        id: 'run-2',
        status: 'refused',
        error_code: 'rate_limited',
        agent_message_id: null,
        created_at: '2026-10-22T10:00:00Z',
      }),
    ]) {
      tables.agent_runs = [older, newer];

      expect((await resolveOne()).flags?.requestEdited).toBe(false);
    }

    tables.agent_runs = [
      older,
      runRow({ id: 'run-2', created_at: '2026-10-22T10:00:00Z' }),
    ];
    expect((await resolveOne({ runIds: ['run-2'] })).flags?.requestEdited).toBe(
      true,
    );
  });

  describe('getOwnRun', () => {
    it('finds only the caller own run in their organization', async () => {
      await expect(service.getOwnRun(me, 'run-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      tables.agent_runs = [runRow({ invoker_id: ME })];
      await expect(service.getOwnRun(me, 'run-1')).resolves.toMatchObject({
        id: 'run-1',
      });

      tables.agent_runs = [
        runRow({ invoker_id: ME, organization_id: 'org-2' }),
      ];
      await expect(service.getOwnRun(me, 'run-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('announce', () => {
    it('sends the current rev and audience of the run', async () => {
      await service.announce('run-1', true);

      expect(agentRunUpdated).toHaveBeenCalledWith(
        {
          conversationId: 'group-1',
          invokerId: ANNA,
          visibility: 'conversation',
          runId: 'run-1',
          rev: 7,
        },
        true,
      );
    });

    it('never throws', async () => {
      agentRunUpdated.mockRejectedValue(new Error('down'));
      await expect(service.announce('run-1')).resolves.toBeUndefined();

      tables.agent_runs = [];
      await expect(service.announce('run-1')).resolves.toBeUndefined();
    });
  });

  describe('proposals (1.14)', () => {
    const field = (over: Row = {}) => ({
      key: 'space',
      state: 'ok',
      value: 'space-1',
      display: 'AMBER',
      options: [{ value: 'space-1', label: 'AMBER' }],
      ...over,
    });
    const actionRow = (over: Row = {}): Row => ({
      id: 'act-1',
      organization_id: 'org-1',
      run_id: 'run-1',
      ordinal: 1,
      kind: 'task',
      status: 'proposed',
      version: 2,
      depends_on: null,
      entity_id: 'task-1',
      confirmed_by: null,
      exec_started_at: null,
      reason: null,
      reason_params: null,
      expires_at: '2026-10-23T10:32:00Z',
      resolved: {
        title: 'Push-Crash beheben',
        description: null,
        confirmable: true,
        fields: [field()],
        create: { spaceId: 'space-1' },
      },
      ...over,
    });

    describe('Undo on the card (1.21)', () => {
      const FUTURE = new Date(Date.now() + 300_000).toISOString();
      const PAST = new Date(Date.now() - 1000).toISOString();
      const created = { resolved: { title: 'T', description: null, confirmable: true, fields: [], create: { spaceId: 'space-1' } } };
      const rules = { isTenantAdmin: jest.fn().mockResolvedValue(false), mayDelete: jest.fn().mockResolvedValue(true) };
      let rpc: jest.Mock;

      const withRules = () => {
        rpc = jest.fn().mockResolvedValue({ data: [], error: null });
        rules.isTenantAdmin.mockResolvedValue(false);
        rules.mayDelete.mockResolvedValue(true);
        return new AgentRunViewService(
          { getClient: () => ({ from: db.from, rpc }) } as unknown as SupabaseAdminService,
          access as unknown as ChatAccessService,
          { loadUsers } as unknown as ChatConversationsService,
          { agentRunUpdated } as unknown as ChatRealtimeService,
          rules as never,
        );
      };
      const done = (over: Row = {}) => actionRow({ status: 'executed', entity_id: 't1', undo_until: FUTURE, ...created, ...over });

      it('gives who may press it the time from the server', async () => {
        tables.agent_runs = [runRow({ invoker_id: ME })];
        tables.agent_actions = [done()];
        const view = await withRules().viewOne(me, 'run-1');
        const result = view.actions?.[0].result;
        expect(result?.undoSecondsLeft).toBeGreaterThan(290);
        expect(result?.undoBlocked).toBeUndefined();
        expect(view.undoUntil).toBe(FUTURE);
      });

      it('gives nothing to another member, not even a read of the blockers', async () => {
        tables.agent_runs = [runRow({ invoker_id: ANNA, visibility: 'conversation' })];
        tables.agent_actions = [done()];
        const view = await withRules().viewOne(me, 'run-1');
        expect(view.actions?.[0].result?.undoSecondsLeft).toBeUndefined();
        expect(rpc).not.toHaveBeenCalled();
      });

      it('gives it to a tenant admin who can see the card', async () => {
        tables.agent_runs = [runRow({ invoker_id: ANNA, visibility: 'conversation' })];
        tables.agent_actions = [done()];
        const service = withRules();
        rules.isTenantAdmin.mockResolvedValue(true);
        const view = await service.viewOne(me, 'run-1');
        expect(view.actions?.[0].result?.undoSecondsLeft).toBeGreaterThan(0);
      });

      it.each([['past its window', PAST], ['from before this release, without one', null]])('says expired for an action %s, with no read', async (_n, until) => {
        tables.agent_runs = [runRow({ invoker_id: ME })];
        tables.agent_actions = [done({ undo_until: until })];
        const view = await withRules().viewOne(me, 'run-1');
        expect(view.actions?.[0].result?.undoBlocked?.code).toBe('expired');
        expect(rpc).not.toHaveBeenCalled();
      });

      it('says in plain words that a space or a member change is not offered', async () => {
        tables.agent_runs = [runRow({ invoker_id: ME })];
        tables.agent_actions = [done({ kind: 'space' }), done({ id: 'act-2', ordinal: 2, kind: 'space_member_add' })];
        const view = await withRules().viewOne(me, 'run-1');
        expect(view.actions?.map((a) => a.result?.undoBlocked?.code)).toEqual(['not_undoable', 'not_undoable']);
      });

      it('names the first blocker, with the person', async () => {
        tables.agent_runs = [runRow({ invoker_id: ME })];
        tables.agent_actions = [done()];
        const service = withRules();
        rpc.mockResolvedValue({ data: [{ action_id: 'act-1', blockers: [{ code: 'changed_by_other', count: 2, by: ANNA }] }], error: null });
        const view = await service.viewOne(me, 'run-1');
        expect(view.actions?.[0].result?.undoBlocked).toEqual({ code: 'changed_by_other', params: { count: 2, name: 'Anna' } });
      });

      it('says when this person has no right to delete it', async () => {
        tables.agent_runs = [runRow({ invoker_id: ME })];
        tables.agent_actions = [done()];
        const service = withRules();
        rules.mayDelete.mockResolvedValue(false);
        const view = await service.viewOne(me, 'run-1');
        expect(view.actions?.[0].result?.undoBlocked?.code).toBe('no_permission');
      });

      it('shows everyone who undid it', async () => {
        tables.agent_runs = [runRow({ invoker_id: ANNA, visibility: 'conversation' })];
        tables.agent_actions = [done({ status: 'undone', undone_by: ANNA, undone_at: FUTURE })];
        const view = await withRules().viewOne(me, 'run-1');
        expect(view.actions?.[0].result?.undoneBy).toEqual({ id: ANNA, name: 'Anna' });
        expect(view.phase).toBe('undone');
      });
    });

    // 1.22: a plan item stays a plan item on its card; a plan opens by its key, which names its space.
    it('keeps a plan item a plan item and gives a created plan its key', async () => {
      tables.agent_runs = [runRow({ invoker_id: ME })];
      const created = { resolved: { title: 'Q4', description: null, confirmable: true, fields: [], create: { spaceId: 'space-1' } } };
      tables.plans = [{ id: 'plan-1', organization_id: 'org-1', plan_key: 'AMBER-P3' }];
      tables.agent_actions = [
        actionRow({ id: 'act-plan', ordinal: 1, kind: 'plan', entity_type: 'plan', status: 'executed', entity_id: 'plan-1', ...created }),
        actionRow({ id: 'act-item', ordinal: 2, depends_on: 1, kind: 'plan_item', status: 'proposed' }),
      ];
      const view = await service.viewOne(me, 'run-1');
      const byId = new Map(view.actions?.map((a) => [a.id, a]));
      expect(byId.get('act-item')?.kind).toBe('plan_item');
      expect(byId.get('act-plan')?.result?.ref).toEqual({ type: 'plan', id: 'plan-1', key: 'AMBER-P3' });
    });

    it('says on the result when a page could not be linked to its process', async () => {
      tables.agent_runs = [runRow({ invoker_id: ME })];
      const created = { resolved: { title: 'Doc', description: null, confirmable: true, fields: [], create: { spaceId: 'space-1' } } };
      tables.agent_actions = [
        actionRow({ id: 'act-p', ordinal: 1, kind: 'process', status: 'executed', entity_id: 'proc-1', ...created }),
        actionRow({ id: 'act-a', ordinal: 2, depends_on: 1, kind: 'wiki_page', status: 'executed', entity_id: 'page-a', ...created }),
        actionRow({ id: 'act-b', ordinal: 3, depends_on: 1, kind: 'wiki_page', status: 'executed', entity_id: 'page-b', ...created }),
      ];
      tables.agent_audit_events.push(
        { organization_id: 'org-1', event: 'action.executed', run_id: 'run-1', action_id: 'act-a', data: { process_link_failed: true } },
        { organization_id: 'org-1', event: 'action.executed', run_id: 'run-1', action_id: 'act-b', data: {} },
      );

      const view = await service.viewOne(me, 'run-1');
      const byId = new Map(view.actions?.map((a) => [a.id, a]));

      expect(byId.get('act-a')?.result).toMatchObject({ ref: { id: 'page-a' }, note: 'process_link_failed' });
      expect(byId.get('act-b')?.result?.note).toBeUndefined();
      expect(byId.get('act-p')?.result?.note).toBeUndefined();
    });

    // 1.22.1 fix (found in the 1.23 research): the executor writes the note as its own event.
    it('says on an item which dependencies were not set, from the action.dependencies event', async () => {
      tables.agent_runs = [runRow({ invoker_id: ME })];
      const created = { resolved: { title: 'Pen test', description: null, confirmable: true, fields: [], create: { spaceId: 'space-1' } } };
      tables.agent_actions = [
        actionRow({ id: 'act-i', ordinal: 1, kind: 'plan_item', status: 'executed', entity_id: 'task-i', ...created }),
      ];
      tables.agent_audit_events.push(
        { organization_id: 'org-1', event: 'action.executed', run_id: 'run-1', action_id: 'act-i', data: {} },
        { organization_id: 'org-1', event: 'action.dependencies', run_id: 'run-1', action_id: 'act-i', data: { dependency_failed: ['dependency_cycle'] } },
      );
      const view = await service.viewOne(me, 'run-1');
      expect(view.actions?.[0].result).toMatchObject({ note: 'dependency_failed' });
    });

    it('gives the invoker the cards with their pickers, the expiry and the proposed phase', async () => {
      tables.agent_runs = [runRow({ invoker_id: ME })];
      tables.agent_actions = [
        actionRow({
          id: 'act-2',
          ordinal: 2,
          depends_on: 1,
          kind: 'subtask',
          expires_at: '2026-10-23T11:00:00Z',
        }),
        actionRow(),
      ];
      const view = await resolveOne();

      expect(view.phase).toBe('proposed');
      expect(view.expiresAt).toBe('2026-10-23T10:32:00Z');
      expect(view.actions).toEqual([
        {
          id: 'act-1',
          version: 2,
          ordinal: 1,
          kind: 'task',
          status: 'proposed',
          title: 'Push-Crash beheben',
          description: null,
          confirmable: true,
          dependsOn: null,
          fields: [field()],
        },
        expect.objectContaining({ id: 'act-2', kind: 'subtask', dependsOn: 1 }),
      ]);
    });

    it('shows members the values but never the option lists', async () => {
      tables.agent_actions = [actionRow()];
      const view = await resolveOne();

      expect(view.viewer).toBe('member');
      expect(view.actions?.[0].fields).toEqual([
        { key: 'space', state: 'ok', value: 'space-1', display: 'AMBER' },
      ]);
    });

    it('is needs_input while an open card cannot be confirmed', async () => {
      tables.agent_actions = [
        actionRow(),
        actionRow({
          id: 'act-2',
          ordinal: 2,
          resolved: { title: 'x', confirmable: false, fields: [] },
        }),
      ];
      const view = await resolveOne();

      expect(view.phase).toBe('needs_input');
      expect(view.actions?.map((a) => a.confirmable)).toEqual([true, false]);
    });

    it('is done with result refs, and names who confirmed and when', async () => {
      tables.agent_runs = [runRow({ invoker_id: ME })];
      tables.agent_actions = [
        actionRow({
          status: 'executed',
          confirmed_by: ME,
          exec_started_at: '2026-10-22T10:40:00Z',
        }),
      ];
      const view = await resolveOne();

      expect(view).toMatchObject({
        phase: 'done',
        expiresAt: null,
        confirmedBy: { id: ME, name: 'Me' },
        confirmedAt: '2026-10-22T10:40:00Z',
        undoUntil: null,
      });
      expect(view.actions?.[0]).toMatchObject({
        confirmable: false,
        result: { ref: { type: 'task', id: 'task-1' } },
      });
    });

    it('is partial with the reason of a cancelled card beside a created one', async () => {
      tables.agent_actions = [
        actionRow({ status: 'executed' }),
        actionRow({
          id: 'act-2',
          ordinal: 2,
          status: 'cancelled',
          reason: 'user',
        }),
      ];
      const view = await resolveOne();

      expect(view.phase).toBe('partial');
      expect(view.actions?.[1].result).toEqual({ reasonCode: 'user' });
    });

    it('points a stub at the created tasks only', async () => {
      tables.agent_runs = [runRow({ visibility: 'invoker' })];
      tables.agent_actions = [
        actionRow({ status: 'executed' }),
        actionRow({ id: 'act-2', ordinal: 2, entity_id: 'task-2' }),
      ];
      const view = await resolveOne();

      expect(view).toMatchObject({
        access: 'stub',
        resultRefs: [{ type: 'task', id: 'task-1' }],
      });
      expect(view).not.toHaveProperty('actions');
    });

    // 1.22.1 fix: a link's object is a plan_tasks row; the stub points at the person's task it added.
    it('points a stub at the task a link added, never at the link row, and at no suggestion', async () => {
      tables.agent_runs = [runRow({ visibility: 'invoker' })];
      tables.agent_actions = [
        actionRow({ kind: 'plan_link', entity_type: 'plan_link', status: 'executed', entity_id: 'link-1',
          resolved: { title: 'X', description: null, confirmable: true, fields: [], create: { kind: 'plan_link', taskId: 'task-9' } } }),
        actionRow({ id: 'act-2', ordinal: 2, kind: 'plan_risk', entity_type: 'plan_risk', status: 'executed', entity_id: 'risk-1' }),
      ];
      const view = await resolveOne();
      expect(view).toMatchObject({ access: 'stub', resultRefs: [{ type: 'task', id: 'task-9' }] });
    });

    it('never shows the cards of another organization', async () => {
      tables.agent_actions = [actionRow({ organization_id: 'org-2' })];

      expect((await resolveOne()).actions).toEqual([]);
    });

    it("gives the invoker their latest thumbs, nobody else's", async () => {
      tables.agent_runs = [runRow({ invoker_id: ME })];
      tables.agent_audit_events.push(
        {
          organization_id: 'org-1',
          event: 'run.feedback',
          run_id: 'run-1',
          actor_id: ME,
          seq: 5,
          data: { rating: 'up' },
        },
        {
          organization_id: 'org-1',
          event: 'run.feedback',
          run_id: 'run-1',
          actor_id: ME,
          seq: 9,
          data: { rating: 'down' },
        },
        {
          organization_id: 'org-1',
          event: 'run.feedback',
          run_id: 'run-1',
          actor_id: ANNA,
          seq: 12,
          data: { rating: 'up' },
        },
      );

      expect((await resolveOne()).feedback).toBe('down');
    });

    it('names the kinds Robert cannot create yet', async () => {
      tables.agent_audit_events[0].data = {
        intents: 3,
        deferred: 1,
        unsupported_kinds: ['wiki_page'],
      };

      expect((await resolveOne()).flags).toMatchObject({
        itemsDeferred: 1,
        unsupportedKinds: ['wiki_page'],
      });
    });
  });
});
