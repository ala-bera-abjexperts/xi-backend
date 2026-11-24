import { Logger } from '@nestjs/common';

import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { KindTypeColumn } from '../common/test-task-types';
import { TestTicketService } from './test-ticket.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const TASK = 'task-1';
const USER = 'user-1';

interface Resolved {
  data: unknown;
  error: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function buildChain(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of ['select', 'eq', 'insert']) {
    chain[name] = jest.fn(() => chain);
  }

  chain.single = jest.fn().mockResolvedValue(resolved);
  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  Object.assign(chain, {
    then: (onFulfilled: (value: Resolved) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled),
  });

  return chain;
}

const none = (): Chain => buildChain({ data: null, error: null });

function firstArg(mock: jest.Mock): unknown {
  return (mock.mock.calls as unknown[][])[0]?.[0];
}

describe('TestTicketService', () => {
  let service: TestTicketService;
  let from: jest.Mock;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    from = jest.fn();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();

    service = new TestTicketService({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService);
  });

  afterEach(() => jest.restoreAllMocks());

  const created = (kind: KindTypeColumn, summary = 'Login works') => ({
    organizationId: ORG,
    spaceId: SPACE,
    taskId: TASK,
    kind,
    summary,
    description: null,
    estimatedTime: null,
    userId: USER,
  });

  describe('onCreated', () => {
    it('creates a case linked to its ticket and the created history row', async () => {
      const insert = buildChain({ data: { id: 'case-1' }, error: null });
      const history = none();

      from
        .mockReturnValueOnce(none())
        .mockReturnValueOnce(insert)
        .mockReturnValueOnce(history);

      await service.onCreated(created('case_task_type_id', ' Login works '));

      expect(from.mock.calls).toEqual([
        ['test_cases'],
        ['test_cases'],
        ['test_case_history'],
      ]);
      expect(firstArg(insert.insert)).toEqual({
        organization_id: ORG,
        space_id: SPACE,
        task_id: TASK,
        created_by: USER,
        updated_by: USER,
      });
      expect(firstArg(history.insert)).toEqual({
        organization_id: ORG,
        space_id: SPACE,
        case_id: 'case-1',
        revision: 1,
        change_kind: 'created',
        changed_by: USER,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('cuts the title to 255 characters', async () => {
      const insert = none();

      from.mockReturnValueOnce(none()).mockReturnValueOnce(insert);

      await service.onCreated(
        created(
          'precondition_task_type_id',
          `  ${'a'.repeat(254)} b${'c'.repeat(50)}  `,
        ),
      );

      expect(firstArg(insert.insert)).toMatchObject({ title: 'a'.repeat(254) });
    });

    it('keeps the objective and estimate of a new case, and no other ticket field', async () => {
      const insert = buildChain({ data: { id: 'case-1' }, error: null });

      from
        .mockReturnValueOnce(none())
        .mockReturnValueOnce(insert)
        .mockReturnValueOnce(none());

      await service.onCreated({
        ...created('case_task_type_id'),
        description: '<p>Check the login</p>',
        estimatedTime: 45,
        startDate: '2026-10-26T00:00:00.000Z',
        dueDate: '2026-10-31T00:00:00.000Z',
        assignedTo: 'user-2',
      });

      expect(firstArg(insert.insert)).toEqual({
        organization_id: ORG,
        space_id: SPACE,
        task_id: TASK,
        objective: 'Check the login',
        estimate_minutes: 45,
        created_by: USER,
        updated_by: USER,
      });
    });

    it('does not insert when the ticket already has a case', async () => {
      from.mockReturnValueOnce(
        buildChain({ data: { id: 'case-1' }, error: null }),
      );

      await service.onCreated(created('case_task_type_id'));

      expect(from).toHaveBeenCalledTimes(1);
    });

    it('re-reads on a duplicate insert and does not throw', async () => {
      const reread = buildChain({ data: { id: 'case-1' }, error: null });

      from
        .mockReturnValueOnce(none())
        .mockReturnValueOnce(
          buildChain({
            data: null,
            error: { code: '23505', message: 'duplicate key' },
          }),
        )
        .mockReturnValueOnce(reread);

      await expect(
        service.onCreated(created('case_task_type_id')),
      ).resolves.toBeUndefined();

      expect(reread.eq).toHaveBeenCalledWith('task_id', TASK);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(['execution_task_type_id'] as const)(
      'creates nothing for a %s ticket',
      async (kind) => {
        await service.onCreated(created(kind));

        expect(from).not.toHaveBeenCalled();
      },
    );

    it('logs an insert error instead of throwing', async () => {
      from.mockReturnValueOnce(none()).mockReturnValueOnce(
        buildChain({
          data: null,
          error: { code: '23514', message: 'check' },
        }),
      );

      await expect(
        service.onCreated(created('case_task_type_id')),
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining(TASK));
    });

    it('creates a precondition named after a precondition ticket', async () => {
      const insert = none();

      from.mockReturnValueOnce(none()).mockReturnValueOnce(insert);

      await service.onCreated(created('precondition_task_type_id', ' Setup '));

      expect(from).toHaveBeenNthCalledWith(2, 'test_preconditions');
      expect(firstArg(insert.insert)).toEqual({
        organization_id: ORG,
        space_id: SPACE,
        task_id: TASK,
        title: 'Setup',
        created_by: USER,
        updated_by: USER,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('creates a set linked to a test set ticket, without copying its fields', async () => {
      const insert = none();

      from.mockReturnValueOnce(none()).mockReturnValueOnce(insert);

      await service.onCreated({
        ...created('set_task_type_id', ' Smoke '),
        description: '<p>Login</p>',
      });

      expect(from).toHaveBeenNthCalledWith(2, 'test_sets');
      expect(firstArg(insert.insert)).toEqual({
        organization_id: ORG,
        space_id: SPACE,
        task_id: TASK,
        created_by: USER,
        updated_by: USER,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not insert when the test set ticket already has a set', async () => {
      from.mockReturnValueOnce(
        buildChain({ data: { id: 'set-1' }, error: null }),
      );

      await service.onCreated(created('set_task_type_id'));

      expect(from).toHaveBeenCalledTimes(1);
      expect(from).toHaveBeenCalledWith('test_sets');
    });

    it('re-reads a set on a duplicate insert and does not throw', async () => {
      from
        .mockReturnValueOnce(none())
        .mockReturnValueOnce(
          buildChain({ data: null, error: { code: '23505', message: 'dup' } }),
        )
        .mockReturnValueOnce(
          buildChain({ data: { id: 'set-1' }, error: null }),
        );

      await service.onCreated(created('set_task_type_id'));

      expect(warn).not.toHaveBeenCalled();
    });

    it('creates a plan linked to a test plan ticket, without copying its fields', async () => {
      const insert = none();

      from.mockReturnValueOnce(none()).mockReturnValueOnce(insert);

      await service.onCreated({
        ...created('plan_task_type_id', ' Release 2 '),
        description: '<p>Scope &amp; risks</p>',
        estimatedTime: null,
        startDate: '2026-10-26T18:30:00+00:00',
        dueDate: '2026-10-31T00:00:00.000Z',
        assignedTo: 'user-2',
      });

      expect(from).toHaveBeenNthCalledWith(2, 'test_plans');
      expect(firstArg(insert.insert)).toEqual({
        organization_id: ORG,
        space_id: SPACE,
        task_id: TASK,
        created_by: USER,
        updated_by: USER,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not insert when the test plan ticket already has a plan', async () => {
      from.mockReturnValueOnce(
        buildChain({ data: { id: 'plan-1' }, error: null }),
      );

      await service.onCreated({
        ...created('plan_task_type_id'),
        description: null,
        estimatedTime: null,
      });

      expect(from).toHaveBeenCalledTimes(1);
      expect(from).toHaveBeenCalledWith('test_plans');
    });

    it('re-reads a plan on a duplicate insert and does not throw', async () => {
      from
        .mockReturnValueOnce(none())
        .mockReturnValueOnce(
          buildChain({ data: null, error: { code: '23505', message: 'dup' } }),
        )
        .mockReturnValueOnce(
          buildChain({ data: { id: 'plan-1' }, error: null }),
        );

      await service.onCreated({
        ...created('plan_task_type_id'),
        description: null,
        estimatedTime: null,
      });

      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('TestTicketService.onTicketUpdated', () => {
  let warn: jest.SpyInstance;

  type Reply = {
    data: unknown;
    error: { code?: string; message: string } | null;
  };

  // Each from() call answers with the next reply; the chain records every call.
  function mockClient(replies: Reply[], rpcReplies: Reply[] = []) {
    const calls: { method: string; args: unknown[] }[] = [];
    const from = jest.fn(() => {
      const reply = replies.shift() ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};

      for (const method of ['select', 'eq', 'update', 'insert']) {
        chain[method] = (...args: unknown[]) => {
          calls.push({ method, args });

          return chain;
        };
      }

      chain.maybeSingle = () => Promise.resolve(reply);
      chain.then = (resolve: (value: Reply) => unknown) =>
        Promise.resolve(reply).then(resolve);

      return chain;
    });
    const rpc = jest.fn(() =>
      Promise.resolve(rpcReplies.shift() ?? { data: {}, error: null }),
    );
    const service = new TestTicketService({
      getClient: () => ({ from, rpc }),
    } as unknown as SupabaseAdminService);

    return { service, from, rpc, calls };
  }

  const updated = (kind: KindTypeColumn, changes: Record<string, unknown>) => ({
    organizationId: ORG,
    spaceId: SPACE,
    taskId: TASK,
    kind,
    userId: USER,
    changes,
  });

  const caseRow = {
    id: 'case-1',
    objective: 'Old text',
    estimate_minutes: 30,
    revision: 4,
    is_archived: false,
  };

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('sends only the changed case fields to tm_update_case with the current revision', async () => {
    const { service, rpc, calls } = mockClient([
      { data: caseRow, error: null },
    ]);

    await service.onTicketUpdated(
      updated('case_task_type_id', {
        summary: ' New ',
        previousSummary: 'New',
        description: '<p>Old text</p>',
        estimatedTime: 45,
      }),
    );

    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['task_id', TASK] },
        { method: 'eq', args: ['space_id', SPACE] },
        { method: 'eq', args: ['organization_id', ORG] },
      ]),
    );
    expect(rpc).toHaveBeenCalledWith('tm_update_case', {
      p_organization_id: ORG,
      p_space_id: SPACE,
      p_actor_id: USER,
      p_case_id: 'case-1',
      p_expected_revision: 4,
      p_patch: { estimate_minutes: 45 },
    });
  });

  it('writes nothing when the case already has the values (an echo of its own change)', async () => {
    const { service, from, rpc, calls } = mockClient([
      { data: caseRow, error: null },
    ]);

    await service.onTicketUpdated(
      updated('case_task_type_id', {
        summary: 'Old',
        previousSummary: 'Old',
        estimatedTime: 30,
      }),
    );

    expect(rpc).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.method === 'update')).toBe(false);
    expect(calls.some((call) => call.method === 'insert')).toBe(false);
  });

  it('does nothing for a ticket without a test case', async () => {
    const { service, rpc } = mockClient([{ data: null, error: null }]);

    await service.onTicketUpdated(
      updated('case_task_type_id', { summary: 'New' }),
    );

    expect(rpc).not.toHaveBeenCalled();
  });

  it('reads the case again once after a revision conflict', async () => {
    const { service, rpc } = mockClient(
      [
        { data: caseRow, error: null },
        { data: { ...caseRow, revision: 5 }, error: null },
      ],
      [{ data: null, error: { code: 'TM001', message: 'conflict' } }],
    );

    await service.onTicketUpdated(
      updated('case_task_type_id', { estimatedTime: 45 }),
    );

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith(
      'tm_update_case',
      expect.objectContaining({ p_expected_revision: 5 }),
    );
  });

  it('throws so the ticket is put back when the case cannot be updated', async () => {
    const { service } = mockClient(
      [{ data: caseRow, error: null }],
      [{ data: null, error: { code: '23514', message: 'check' } }],
    );

    await expect(
      service.onTicketUpdated(
        updated('case_task_type_id', { estimatedTime: 45 }),
      ),
    ).rejects.toBeDefined();
  });

  it('updates an archived case directly and writes its history row', async () => {
    const { service, rpc, calls } = mockClient([
      { data: { ...caseRow, is_archived: true }, error: null },
      { data: [{ id: 'case-1' }], error: null },
      { data: null, error: null },
    ]);

    await service.onTicketUpdated(
      updated('case_task_type_id', { estimatedTime: 45 }),
    );

    expect(rpc).not.toHaveBeenCalled();
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          method: 'update',
          args: [{ estimate_minutes: 45, revision: 5, updated_by: USER }],
        },
        {
          method: 'insert',
          args: [
            expect.objectContaining({
              case_id: 'case-1',
              revision: 5,
              change_kind: 'updated',
              changes: { estimate_minutes: { from: 30, to: 45 } },
            }),
          ],
        },
      ]),
    );
  });

  it.each([
    ['set_task_type_id', 'test_sets'],
    ['plan_task_type_id', 'test_plans'],
    ['execution_task_type_id', 'test_executions'],
  ] as const)(
    'only updates updated_by on the linked record of a %s ticket',
    async (kind, table) => {
      const { service, from, calls } = mockClient([
        { data: null, error: null },
      ]);

      await service.onTicketUpdated(
        updated(kind, {
          summary: 'New',
          previousSummary: 'Old',
          description: '<p>More</p>',
          startDate: '2026-10-28T00:00:00.000Z',
          dueDate: null,
        }),
      );

      expect(from.mock.calls).toEqual([[table]]);
      expect(calls).toEqual([
        { method: 'update', args: [{ updated_by: USER }] },
        { method: 'eq', args: ['task_id', TASK] },
        { method: 'eq', args: ['organization_id', ORG] },
      ]);
    },
  );

  it.each([
    ['set_task_type_id', 'test_sets'],
    ['plan_task_type_id', 'test_plans'],
    ['execution_task_type_id', 'test_executions'],
  ] as const)(
    'only logs when the last updated of a %s ticket record cannot be saved',
    async (kind, table) => {
      const { service } = mockClient([
        { data: null, error: { message: 'no connection' } },
      ]);

      await expect(
        service.onTicketUpdated(updated(kind, { summary: 'New' })),
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining(table));
    },
  );

  describe('case rename', () => {
    const renamed = { summary: ' New ', previousSummary: 'Old' };
    const updates = (calls: { method: string; args: unknown[] }[]) =>
      calls.filter((call) => call.method === 'update');
    const inserts = (calls: { method: string; args: unknown[] }[]) =>
      calls.filter((call) => call.method === 'insert');

    it('bumps the revision and writes a history row with the old and new title', async () => {
      const { service, from, rpc, calls } = mockClient([
        { data: caseRow, error: null },
        { data: { revision: 4 }, error: null },
        { data: [{ id: 'case-1' }], error: null },
        { data: null, error: null },
      ]);

      await service.onTicketUpdated(updated('case_task_type_id', renamed));

      expect(rpc).not.toHaveBeenCalled();
      expect(from.mock.calls).toEqual([
        ['test_cases'],
        ['test_cases'],
        ['test_cases'],
        ['test_case_history'],
      ]);
      expect(updates(calls)).toEqual([
        { method: 'update', args: [{ revision: 5, updated_by: USER }] },
      ]);
      expect(calls).toContainEqual({ method: 'eq', args: ['revision', 4] });
      expect(inserts(calls)).toEqual([
        {
          method: 'insert',
          args: [
            {
              organization_id: ORG,
              space_id: SPACE,
              case_id: 'case-1',
              revision: 5,
              change_kind: 'updated',
              changes: { title: { from: 'Old', to: 'New' } },
              changed_by: USER,
            },
          ],
        },
      ]);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads the revision again once when another save got in first', async () => {
      const { service, calls } = mockClient([
        { data: caseRow, error: null },
        { data: { revision: 4 }, error: null },
        { data: [], error: null },
        { data: { revision: 5 }, error: null },
        { data: [{ id: 'case-1' }], error: null },
        { data: null, error: null },
      ]);

      await service.onTicketUpdated(updated('case_task_type_id', renamed));

      expect(updates(calls)).toEqual([
        { method: 'update', args: [{ revision: 5, updated_by: USER }] },
        { method: 'update', args: [{ revision: 6, updated_by: USER }] },
      ]);
      expect(inserts(calls)).toEqual([
        {
          method: 'insert',
          args: [expect.objectContaining({ revision: 6 })],
        },
      ]);
    });

    it('writes no history row when another save got in both times', async () => {
      const { service, calls } = mockClient([
        { data: caseRow, error: null },
        { data: { revision: 4 }, error: null },
        { data: [], error: null },
        { data: { revision: 5 }, error: null },
        { data: [], error: null },
      ]);

      await expect(
        service.onTicketUpdated(updated('case_task_type_id', renamed)),
      ).resolves.toBeUndefined();

      expect(updates(calls)).toHaveLength(2);
      expect(inserts(calls)).toEqual([]);
    });

    it('records nothing when only the spaces around the summary differ', async () => {
      const { service, from, calls } = mockClient([
        { data: caseRow, error: null },
      ]);

      await service.onTicketUpdated(
        updated('case_task_type_id', {
          summary: '  Old ',
          previousSummary: 'Old',
        }),
      );

      expect(from).toHaveBeenCalledTimes(1);
      expect(updates(calls)).toEqual([]);
      expect(inserts(calls)).toEqual([]);
    });

    it('also records the rename after the update function saved the case', async () => {
      const { service, rpc, calls } = mockClient([
        { data: caseRow, error: null },
        { data: { revision: 5 }, error: null },
        { data: [{ id: 'case-1' }], error: null },
        { data: null, error: null },
      ]);

      await service.onTicketUpdated(
        updated('case_task_type_id', { ...renamed, estimatedTime: 45 }),
      );

      expect(rpc).toHaveBeenCalledWith(
        'tm_update_case',
        expect.objectContaining({ p_patch: { estimate_minutes: 45 } }),
      );
      expect(updates(calls)).toEqual([
        { method: 'update', args: [{ revision: 6, updated_by: USER }] },
      ]);
      expect(inserts(calls)).toEqual([
        {
          method: 'insert',
          args: [
            expect.objectContaining({
              revision: 6,
              changes: { title: { from: 'Old', to: 'New' } },
            }),
          ],
        },
      ]);
    });

    it('also records the rename of an archived case', async () => {
      const { service, rpc, calls } = mockClient([
        { data: { ...caseRow, is_archived: true }, error: null },
        { data: [{ id: 'case-1' }], error: null },
        { data: null, error: null },
        { data: { revision: 5 }, error: null },
        { data: [{ id: 'case-1' }], error: null },
        { data: null, error: null },
      ]);

      await service.onTicketUpdated(
        updated('case_task_type_id', { ...renamed, estimatedTime: 45 }),
      );

      expect(rpc).not.toHaveBeenCalled();
      expect(updates(calls)).toEqual([
        {
          method: 'update',
          args: [{ estimate_minutes: 45, revision: 5, updated_by: USER }],
        },
        { method: 'update', args: [{ revision: 6, updated_by: USER }] },
      ]);
      expect(inserts(calls)).toEqual([
        {
          method: 'insert',
          args: [
            expect.objectContaining({
              revision: 5,
              changes: { estimate_minutes: { from: 30, to: 45 } },
            }),
          ],
        },
        {
          method: 'insert',
          args: [
            expect.objectContaining({
              revision: 6,
              changes: { title: { from: 'Old', to: 'New' } },
            }),
          ],
        },
      ]);
    });

    it.each([
      ['read', [{ data: null, error: { message: 'boom' } }]],
      [
        'update',
        [
          { data: { revision: 4 }, error: null },
          { data: null, error: { message: 'boom' } },
        ],
      ],
      [
        'history insert',
        [
          { data: { revision: 4 }, error: null },
          { data: [{ id: 'case-1' }], error: null },
          { data: null, error: { message: 'boom' } },
        ],
      ],
    ] as [string, Reply[]][])(
      'only logs when the rename %s fails',
      async (_step, replies) => {
        const { service } = mockClient([
          { data: caseRow, error: null },
          ...replies,
        ]);

        await expect(
          service.onTicketUpdated(updated('case_task_type_id', renamed)),
        ).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('Rename of test case case-1 not recorded'),
        );
      },
    );
  });
});

describe('TestTicketService.onTicketDeleting', () => {
  type Reply = {
    data: unknown;
    error: { code?: string; message: string } | null;
    count?: number | null;
  };

  // Each from() call answers with the next reply.
  function mockClient(replies: Reply[]) {
    const chains: Record<string, jest.Mock>[] = [];
    const from = jest.fn(() => {
      const reply = replies.shift() ?? { data: null, error: null };
      const chain: Record<string, jest.Mock> = {};

      for (const method of ['select', 'eq', 'neq', 'delete']) {
        chain[method] = jest.fn(() => chain);
      }

      chain.maybeSingle = jest.fn(() => Promise.resolve(reply));
      Object.assign(chain, {
        then: (resolve: (value: Reply) => unknown) =>
          Promise.resolve(reply).then(resolve),
      });
      chains.push(chain);

      return chain;
    });
    const service = new TestTicketService({
      getClient: () => ({ from }),
    } as unknown as SupabaseAdminService);

    return { service, from, chains };
  }

  const deleting = { organizationId: ORG, taskId: TASK, userId: USER };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('does nothing for a ticket without a plan', async () => {
    // The listener also checks for a linked case and a linked execution.
    const { service, from } = mockClient([
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);

    await expect(service.onTicketDeleting(deleting)).resolves.toBeUndefined();
    expect(from).toHaveBeenCalledTimes(3);
  });

  it('refuses while the plan executions have results and deletes nothing', async () => {
    const { service, chains } = mockClient([
      { data: null, error: null },
      { data: { id: 'plan-1', space_id: SPACE }, error: null },
      { data: null, error: null, count: 3 },
    ]);

    await expect(service.onTicketDeleting(deleting)).rejects.toMatchObject({
      response: { code: 'HAS_RESULTS', data: { results: 3 } },
    });
    expect(chains.some((chain) => chain.delete.mock.calls.length > 0)).toBe(
      false,
    );
  });

  it('deletes a plan without results', async () => {
    const { service, from, chains } = mockClient([
      { data: null, error: null },
      { data: { id: 'plan-1', space_id: SPACE }, error: null },
      { data: null, error: null, count: 0 },
      { data: null, error: null },
    ]);

    await service.onTicketDeleting(deleting);

    expect(from).toHaveBeenNthCalledWith(4, 'test_plans');
    expect(chains[3].delete).toHaveBeenCalled();
    expect(chains[3].eq).toHaveBeenCalledWith('id', 'plan-1');
    expect(chains[3].eq).toHaveBeenCalledWith('organization_id', ORG);
  });

  it('refuses the delete of a ticket whose test case has runs', async () => {
    const { service, from, chains } = mockClient([
      { data: { id: 'case-1' }, error: null },
      { data: null, error: null, count: 2 },
    ]);

    await expect(service.onTicketDeleting(deleting)).rejects.toMatchObject({
      status: 409,
      message:
        "This ticket's test case has execution results, so the ticket cannot be deleted.",
    });
    expect(from.mock.calls).toEqual([['test_cases'], ['test_runs']]);
    expect(chains[1].eq).toHaveBeenCalledWith('case_id', 'case-1');
    expect(chains[1].eq).toHaveBeenCalledWith('organization_id', ORG);
    expect(chains.some((chain) => chain.delete.mock.calls.length > 0)).toBe(
      false,
    );
  });

  it('allows the delete of a ticket whose test case has no runs', async () => {
    const { service, from } = mockClient([
      { data: { id: 'case-1' }, error: null },
      { data: null, error: null, count: 0 },
      { data: null, error: null },
      { data: null, error: null },
    ]);

    await expect(service.onTicketDeleting(deleting)).resolves.toBeUndefined();
    expect(from.mock.calls).toEqual([
      ['test_cases'],
      ['test_runs'],
      ['test_plans'],
      ['test_executions'],
    ]);
  });
});

describe('TestTicketService with a linked test execution', () => {
  type Reply = {
    data: unknown;
    error: { code?: string; message: string } | null;
    count?: number | null;
  };

  // Each from() call answers with the next reply and keeps its chain.
  function executionClient(replies: Reply[]) {
    const chains: Record<string, jest.Mock>[] = [];
    const from = jest.fn(() => {
      const reply = replies.shift() ?? { data: null, error: null };
      const chain: Record<string, jest.Mock> = {};

      for (const method of ['select', 'eq', 'neq', 'update', 'delete']) {
        chain[method] = jest.fn(() => chain);
      }

      chain.maybeSingle = jest.fn(() => Promise.resolve(reply));
      Object.assign(chain, {
        then: (resolve: (value: Reply) => unknown) =>
          Promise.resolve(reply).then(resolve),
      });
      chains.push(chain);

      return chain;
    });
    const rpc = jest.fn(() =>
      Promise.resolve({ data: { storage_paths: [] }, error: null }),
    );
    const service = new TestTicketService({
      getClient: () => ({ from, rpc }),
    } as unknown as SupabaseAdminService);

    return { service, from, rpc, chains };
  }

  const updated = (changes: Record<string, unknown>) => ({
    organizationId: ORG,
    spaceId: SPACE,
    taskId: TASK,
    kind: 'execution_task_type_id' as KindTypeColumn,
    userId: USER,
    changes,
  });

  const deleting = { organizationId: ORG, taskId: TASK, userId: USER };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it('renames the precondition, but not when archived or an echo', async () => {
    const precondition = {
      ...updated({ summary: '  New  ' }),
      kind: 'precondition_task_type_id' as const,
    };
    const renamed = executionClient([
      { data: { id: 'pc-1', title: 'Old', is_archived: false }, error: null },
      { data: null, error: null },
    ]);

    await renamed.service.onTicketUpdated(precondition);

    expect(renamed.from).toHaveBeenNthCalledWith(1, 'test_preconditions');
    expect(renamed.chains[1].update).toHaveBeenCalledWith({
      title: 'New',
      updated_by: USER,
    });

    for (const row of [
      { id: 'pc-1', title: 'Old', is_archived: true },
      { id: 'pc-1', title: 'New', is_archived: false },
    ]) {
      const unchanged = executionClient([{ data: row, error: null }]);

      await unchanged.service.onTicketUpdated(precondition);

      expect(unchanged.from).toHaveBeenCalledTimes(1);
    }
  });

  it('does nothing for a ticket with neither a plan nor an execution', async () => {
    const { service, from, chains } = executionClient([
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);

    await expect(service.onTicketDeleting(deleting)).resolves.toBeUndefined();
    expect(from.mock.calls).toEqual([
      ['test_cases'],
      ['test_plans'],
      ['test_executions'],
    ]);
    expect(chains.some((chain) => chain.delete.mock.calls.length > 0)).toBe(
      false,
    );
  });

  it('refuses while the execution has results and deletes nothing', async () => {
    const { service, chains } = executionClient([
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: 'exec-1', space_id: SPACE }, error: null },
      { data: null, error: null, count: 2 },
    ]);

    await expect(service.onTicketDeleting(deleting)).rejects.toMatchObject({
      response: { code: 'HAS_RESULTS', data: { results: 2 } },
    });
    expect(chains[3].eq).toHaveBeenCalledWith('run.execution_id', 'exec-1');
    expect(chains.some((chain) => chain.delete.mock.calls.length > 0)).toBe(
      false,
    );
  });

  it('deletes an execution without results', async () => {
    const { service, rpc } = executionClient([
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: 'exec-1', space_id: SPACE }, error: null },
      { data: null, error: null, count: 0 },
      { data: null, error: null },
    ]);

    await service.onTicketDeleting(deleting);

    expect(rpc).toHaveBeenCalledWith(
      'tm_delete_execution',
      expect.objectContaining({
        p_organization_id: ORG,
        p_execution_id: 'exec-1',
        p_dry_run: false,
      }),
    );
  });
});
