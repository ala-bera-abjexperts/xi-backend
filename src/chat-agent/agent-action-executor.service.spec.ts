import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { ChatAccessService } from '../chat/chat-access.service';
import type { ChatConversationsService } from '../chat/chat-conversations.service';
import type { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { TasksMineWriteService } from '../tasks/tasks-mine-write.service';
import {
  AgentActionExecutorService,
  failureReason,
  materialOf,
  plainToHtml,
} from './agent-action-executor.service';
import type {
  AgentResolved,
  AgentResolverService,
} from './agent-resolver.service';
import type { AgentRunViewService } from './agent-run-view.service';
import type { AgentRunsRepository } from './agent-runs.repository';

type Row = Record<string, unknown>;

/** In-memory tables answering eq / in / order / maybeSingle, and an insert that echoes its rows. */
function fakeDb(tables: Record<string, Row[]>) {
  const inserts: { table: string; row: Row }[] = [];
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    let inserted: Row[] | null = null;
    const run = () =>
      inserted ??
      (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
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
      order: () => q,
      insert: (row: Row) => {
        inserts.push({ table, row });
        inserted = [{ id: 'notif-1', ...row }];
        return q;
      },
      maybeSingle: () =>
        Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(resolve),
    };
    return q;
  };
  return { from, inserts };
}

const ME = 'user-me';
const ANNA = 'user-anna';
const user = { userId: ME, organizationId: 'org-1' } as RequestUser;

const create = (over: Row = {}) => ({
  spaceId: 'space-1',
  summary: 'Push-Crash beheben',
  description: 'Line <one>\n\nTwo',
  taskTypeId: 'task',
  statusId: 'st-open',
  priorityKey: 'high',
  assigneeId: ANNA,
  dueDate: '2026-10-23',
  labels: ['ios'],
  parentTaskId: null,
  customFieldValues: {},
  ...over,
});

const resolved = (over: Partial<AgentResolved> = {}): AgentResolved => ({
  title: 'Push-Crash beheben',
  description: null,
  confirmable: true,
  fields: [
    { key: 'space', state: 'ok', value: 'space-1', options: [] },
    { key: 'priority', state: 'ok', value: 'pr-high' },
  ],
  create: create() as AgentResolved['create'],
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
  entity_id: 'task-new-1',
  intent: { title: 'x' },
  overrides: {},
  resolved: resolved(),
  ...over,
});

describe('AgentActionExecutorService', () => {
  let tables: Record<string, Row[]>;
  let db: ReturnType<typeof fakeDb>;
  let runs: Record<string, jest.Mock>;
  let views: Record<string, jest.Mock>;
  let resolver: Record<string, jest.Mock>;
  let access: Record<string, jest.Mock>;
  let tasks: Record<string, jest.Mock>;
  let broadcast: Record<string, jest.Mock>;
  let loadUsers: jest.Mock;
  let service: AgentActionExecutorService;
  const view = { id: 'run-1', phase: 'done' };

  beforeEach(() => {
    tables = {
      agent_runs: [
        {
          id: 'run-1',
          organization_id: 'org-1',
          conversation_id: 'conv-1',
          invoker_id: ME,
          status: 'completed',
          visibility: 'conversation',
          scope: { spaces: [], refs: [] },
          timezone: 'Europe/Vienna',
        },
      ],
      agent_actions: [actionRow()],
      tasks: [],
    };
    db = fakeDb(tables);
    runs = {
      patchAction: jest.fn().mockResolvedValue({ updated: true, version: 3 }),
      markConfirming: jest.fn().mockResolvedValue(undefined),
      claimActions: jest.fn((_o, _r, _a, versions: Record<string, number>) =>
        Promise.resolve(
          tables.agent_actions
            .filter((a) => versions[a.id as string] !== undefined)
            .map((a) => ({
              ...a,
              status: 'executing',
              exec_token: `tok-${a.id as string}`,
            })),
        ),
      ),
      completeAction: jest
        .fn()
        .mockResolvedValue({ completed: true, status: 'executed' }),
      cancelActions: jest.fn().mockResolvedValue(1),
      recordAudit: jest.fn().mockResolvedValue(undefined),
    };
    views = {
      viewOne: jest.fn().mockResolvedValue(view),
      announce: jest.fn().mockResolvedValue(undefined),
    };
    resolver = {
      batch: jest.fn((args: object) => ({
        ...args,
        siblings: new Map(),
        memo: new Map(),
      })),
      // Fresh data equal to what the invoker saw, unless a test says otherwise.
      resolve: jest.fn((_b, action: { overrides: Row }) =>
        Promise.resolve(
          Object.keys(action.overrides).length
            ? resolved({
                create: create(action.overrides) as AgentResolved['create'],
              })
            : resolved(),
        ),
      ),
      hidesFromAudience: jest.fn().mockResolvedValue(false),
    };
    access = {
      getReadable: jest.fn().mockResolvedValue({
        conversation: { id: 'conv-1', kind: 'group', space_id: null },
      }),
    };
    tasks = {
      createTask: jest.fn(
        (_u, dto: { summary: string }, trusted: { taskId: string }) =>
          Promise.resolve({
            task: {
              id: trusted.taskId,
              key: 'AMBER-T7',
              summary: dto.summary,
              assignee: { id: ANNA, name: 'Anna' },
              space: { id: 'space-1', key: 'AMBER', name: 'Amber' },
            },
          }),
      ),
    };
    broadcast = {
      broadcastNotification: jest.fn().mockResolvedValue(undefined),
    };
    loadUsers = jest
      .fn()
      .mockResolvedValue(new Map([[ME, { name: 'Prince Jadiya' }]]));
    service = new AgentActionExecutorService(
      {
        getClient: () => ({ from: db.from }),
      } as unknown as SupabaseAdminService,
      runs as unknown as AgentRunsRepository,
      views as unknown as AgentRunViewService,
      resolver as unknown as AgentResolverService,
      access as unknown as ChatAccessService,
      { loadUsers } as unknown as ChatConversationsService,
      tasks as unknown as TasksMineWriteService,
      broadcast as unknown as NotificationsBroadcastService,
    );
    // Logged failures are expected in several cases below.
    jest
      .spyOn(
        (
          service as unknown as {
            logger: { warn: () => void; error: () => void };
          }
        ).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    jest
      .spyOn(
        (
          service as unknown as {
            logger: { warn: () => void; error: () => void };
          }
        ).logger,
        'error',
      )
      .mockImplementation(() => undefined);
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  describe('confirm', () => {
    it('re-checks, claims once and creates the task from the resolved fields only, with the reserved id', async () => {
      await expect(
        service.confirm(user, 'run-1', [{ id: 'act-1', version: 2 }]),
      ).resolves.toBe(view);

      expect(resolver.resolve).toHaveBeenCalledTimes(1);
      expect(runs.claimActions).toHaveBeenCalledWith('org-1', 'run-1', ME, {
        'act-1': 2,
      });
      expect(tasks.createTask).toHaveBeenCalledWith(
        user,
        {
          spaceIdOrKey: 'space-1',
          summary: 'Push-Crash beheben',
          description: '<p>Line &lt;one&gt;</p><p>Two</p>',
          priority: 'high',
          assigneeId: ANNA,
          dueDate: '2026-10-23',
          labels: ['ios'],
          taskTypeId: 'task',
        },
        { taskId: 'task-new-1', status: 'st-open' },
      );
      expect(runs.completeAction).toHaveBeenCalledWith({
        actionId: 'act-1',
        execToken: 'tok-act-1',
        outcome: 'executed',
        reason: null,
        audit: undefined,
      });
      expect(views.announce).toHaveBeenCalledWith('run-1');
    });

    it("rings the assignee's bell with a link to the task, never the invoker's", async () => {
      await service.confirm(user, 'run-1', [{ id: 'act-1', version: 2 }]);
      await flush();

      expect(db.inserts).toEqual([
        {
          table: 'notifications',
          row: expect.objectContaining({
            organization_id: 'org-1',
            user_id: ANNA,
            type: 'robert_task_assigned',
            title:
              'Prince Jadiya created a task for you with Robert: Push-Crash beheben',
            reference_type: 'task',
            reference_id: 'task-new-1',
            metadata: {
              link: '/spaces/AMBER/tasks/view/AMBER-T7',
              taskId: 'task-new-1',
              taskKey: 'AMBER-T7',
              runId: 'run-1',
              task_key: 'AMBER-T7',
              space_key: 'AMBER',
            },
          }) as Row,
        },
      ]);
      expect(broadcast.broadcastNotification).toHaveBeenCalledTimes(1);

      db.inserts.length = 0;
      tables.agent_actions = [actionRow({ status: 'proposed' })];
      tasks.createTask.mockResolvedValueOnce({
        task: {
          id: 'task-new-1',
          key: 'K',
          summary: 's',
          assignee: { id: ME },
          space: null,
        },
      });
      await service.confirm(user, 'run-1', [{ id: 'act-1', version: 2 }]);
      await flush();
      expect(db.inserts).toEqual([]);
    });

    it('keeps the task when the bell fails', async () => {
      loadUsers.mockRejectedValue(new Error('down'));
      await expect(
        service.confirm(user, 'run-1', [{ id: 'act-1', version: 2 }]),
      ).resolves.toBe(view);
      await flush();
      expect(runs.completeAction).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'executed' }),
      );
      expect(db.inserts).toEqual([]);
    });

    it('a second click claims nothing, creates nothing and answers the view', async () => {
      tables.agent_actions = [actionRow({ status: 'executed' })];

      await expect(
        service.confirm(user, 'run-1', [{ id: 'act-1', version: 2 }]),
      ).resolves.toBe(view);
      expect(runs.claimActions).not.toHaveBeenCalled();
      expect(tasks.createTask).not.toHaveBeenCalled();
    });

    it('a parallel request that lost the claim creates nothing and says so (409 stale)', async () => {
      runs.claimActions.mockResolvedValue([]);

      const err = (await service
        .confirm(user, 'run-1', [{ id: 'act-1', version: 2 }])
        .catch((e: unknown) => e)) as ConflictException;
      expect(err).toBeInstanceOf(ConflictException);
      expect((err.getResponse() as { code: string }).code).toBe('stale');
      expect(tasks.createTask).not.toHaveBeenCalled();
    });

    it('answers 409 "changed" with the fresh view when the re-check found something (SEC-02)', async () => {
      const fresh = resolved({
        confirmable: false,
        fields: [
          {
            key: 'assignee',
            state: 'needs_input',
            code: 'not_space_member',
            value: ANNA,
          },
        ],
      });
      resolver.resolve.mockResolvedValue(fresh);

      const err = (await service
        .confirm(user, 'run-1', [{ id: 'act-1', version: 2 }])
        .catch((e: unknown) => e)) as ConflictException;

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual({
        message: 'Something changed, please check the proposal',
        code: 'changed',
        data: { run: view },
      });
      expect(runs.patchAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'act-1',
          version: 2,
          resolved: fresh,
          audit: { revalidated: true },
        }),
      );
      expect(runs.claimActions).not.toHaveBeenCalled();
      expect(tasks.createTask).not.toHaveBeenCalled();
    });

    it('answers 409 "changed" when the invoker lost create_tasks', async () => {
      resolver.resolve.mockResolvedValue(
        resolved({
          confirmable: false,
          fields: [
            {
              key: 'space',
              state: 'blocked',
              code: 'no_create_permission',
              value: 'space-1',
            },
          ],
        }),
      );
      await expect(
        service.confirm(user, 'run-1', [{ id: 'act-1', version: 2 }]),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tasks.createTask).not.toHaveBeenCalled();
    });

    it('answers 409 "stale" for a version the invoker did not see', async () => {
      const err = (await service
        .confirm(user, 'run-1', [{ id: 'act-1', version: 1 }])
        .catch((e: unknown) => e)) as ConflictException;

      expect((err.getResponse() as Row).code).toBe('stale');
      expect(runs.claimActions).not.toHaveBeenCalled();
    });

    it('adopts a task that already exists under the reserved id', async () => {
      tables.tasks = [{ id: 'task-new-1', organization_id: 'org-1' }];

      await service.confirm(user, 'run-1', [{ id: 'act-1', version: 2 }]);
      expect(tasks.createTask).not.toHaveBeenCalled();
      expect(runs.completeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'executed',
          audit: { adopted: true },
        }),
      );
    });

    it('adopts on a primary key collision (a parallel create won)', async () => {
      tasks.createTask.mockImplementation(() => {
        tables.tasks = [{ id: 'task-new-1', organization_id: 'org-1' }];
        return Promise.reject(
          new BadRequestException('duplicate key', {
            cause: { code: '23505' },
          }),
        );
      });

      await service.confirm(user, 'run-1', [{ id: 'act-1', version: 2 }]);
      expect(runs.completeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'executed',
          audit: { adopted: true },
        }),
      );
    });

    it('fails with a stable reason when the task service refuses', async () => {
      tasks.createTask.mockRejectedValue(
        new NotFoundException('Task not found'),
      );

      await service.confirm(user, 'run-1', [{ id: 'act-1', version: 2 }]);
      expect(runs.completeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'failed',
          reason: 'no_create_permission',
        }),
      );
    });

    it('creates the parent first and hangs the subtask under its reserved id', async () => {
      tables.agent_actions = [
        actionRow({
          id: 'act-2',
          ordinal: 2,
          depends_on: 1,
          kind: 'subtask',
          entity_id: 'task-new-2',
        }),
        actionRow(),
      ];
      // The view of the database answers them in card order.
      tables.agent_actions.reverse();

      await service.confirm(user, 'run-1', [
        { id: 'act-2', version: 2 },
        { id: 'act-1', version: 2 },
      ]);

      const calls = tasks.createTask.mock.calls as [unknown, unknown, Row][];
      expect(calls.map(([, , trusted]) => trusted.taskId)).toEqual([
        'task-new-1',
        'task-new-2',
      ]);
      expect(calls[1][2]).toMatchObject({ parentTaskId: 'task-new-1' });
    });

    it('fails a subtask whose parent failed, without a write', async () => {
      tables.agent_actions = [
        actionRow(),
        actionRow({
          id: 'act-2',
          ordinal: 2,
          depends_on: 1,
          kind: 'subtask',
          entity_id: 'task-new-2',
        }),
      ];
      tasks.createTask.mockRejectedValueOnce(new ForbiddenException());

      await service.confirm(user, 'run-1', [
        { id: 'act-1', version: 2 },
        { id: 'act-2', version: 2 },
      ]);

      expect(tasks.createTask).toHaveBeenCalledTimes(1);
      expect(runs.completeAction).toHaveBeenLastCalledWith(
        expect.objectContaining({
          actionId: 'act-2',
          outcome: 'failed',
          reason: 'parent_failed',
        }),
      );
    });

    it('answers 404 to anyone but the invoker, and for a conversation they can no longer read', async () => {
      await expect(
        service.confirm({ ...user, userId: ANNA }, 'run-1', [
          { id: 'act-1', version: 2 },
        ]),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.confirm({ ...user, organizationId: 'org-2' }, 'run-1', [
          { id: 'act-1', version: 2 },
        ]),
      ).rejects.toBeInstanceOf(NotFoundException);

      access.getReadable.mockRejectedValue(new NotFoundException());
      await expect(
        service.confirm(user, 'run-1', [{ id: 'act-1', version: 2 }]),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tasks.createTask).not.toHaveBeenCalled();
    });
  });

  describe('patch', () => {
    it('merges the edit, re-resolves and saves it by version', async () => {
      await expect(
        service.patch(user, 'run-1', [
          {
            actionId: 'act-1',
            version: 2,
            fields: { priority: '0b3e7000-0000-4000-8000-000000000009' },
          },
        ]),
      ).resolves.toBe(view);

      expect(resolver.resolve).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          overrides: { priority: '0b3e7000-0000-4000-8000-000000000009' },
        }),
      );
      expect(runs.patchAction).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          actionId: 'act-1',
          actorId: ME,
          version: 2,
          targetSpaceId: 'space-1',
          scope: {
            spaces: [{ id: 'space-1', perm: 'create_tasks' }],
            refs: [],
          },
          narrow: false,
          audit: { fields: ['priority'] },
        }),
      );
    });

    it('drops the picks that belonged to the old space', async () => {
      tables.agent_actions = [
        actionRow({
          overrides: {
            type: 'bug',
            status: 'x',
            priority: 'y',
            due: null,
            'custom:cf': 1,
          },
        }),
      ];
      await service.patch(user, 'run-1', [
        {
          actionId: 'act-1',
          version: 2,
          fields: { space: '0b3e7000-0000-4000-8000-000000000008' },
        },
      ]);

      expect(runs.patchAction).toHaveBeenCalledWith(
        expect.objectContaining({
          overrides: {
            due: null,
            space: '0b3e7000-0000-4000-8000-000000000008',
          },
        }),
      );
    });

    it('narrows the run when the new space is hidden from someone in the chat', async () => {
      resolver.hidesFromAudience.mockResolvedValue(true);
      await service.patch(user, 'run-1', [
        { actionId: 'act-1', version: 2, fields: { due: '2026-11-02' } },
      ]);

      expect(runs.patchAction).toHaveBeenCalledWith(
        expect.objectContaining({ narrow: true }),
      );
    });

    it('answers 409 "stale" with the fresh view in data.run', async () => {
      runs.patchAction.mockResolvedValue({ updated: false, version: 5 });

      const err = (await service
        .patch(user, 'run-1', [
          { actionId: 'act-1', version: 2, fields: { title: 'x' } },
        ])
        .catch((e: unknown) => e)) as ConflictException;
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: 'stale',
        data: { run: view },
      });
    });

    it.each([
      [{ owner: 'x' }],
      [{ title: 5 }],
      [{ due: '2026-02-30' }],
      [{ labels: 'ios' }],
      [{ assignee: 'not-a-uuid' }],
      [{ 'custom:0b3e7000-0000-4000-8000-000000000001': 'x' }],
    ])('refuses %j (400) before anything is saved', async (fields) => {
      await expect(
        service.patch(user, 'run-1', [
          { actionId: 'act-1', version: 2, fields },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(runs.patchAction).not.toHaveBeenCalled();
    });

    it('checks a custom value against the field on the card', async () => {
      const key = 'custom:0b3e7000-0000-4000-8000-000000000001';
      tables.agent_actions = [
        actionRow({
          resolved: resolved({
            fields: [
              {
                key,
                state: 'needs_input',
                value: null,
                fieldDef: {
                  field_key: 'severity',
                  name: 'Severity',
                  field_type: 'number',
                  validation_rules: {},
                },
              },
            ],
          }),
        }),
      ];
      await expect(
        service.patch(user, 'run-1', [
          { actionId: 'act-1', version: 2, fields: { [key]: 'abc' } },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.patch(user, 'run-1', [
          { actionId: 'act-1', version: 2, fields: { [key]: 3 } },
        ]),
      ).resolves.toBe(view);
    });

    it('answers 404 for an action of another run', async () => {
      await expect(
        service.patch(user, 'run-1', [
          { actionId: 'nope', version: 1, fields: {} },
        ]),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('cancels one proposal as the invoker', async () => {
    await expect(service.cancel(user, 'act-1')).resolves.toBe(view);
    expect(runs.cancelActions).toHaveBeenCalledWith('org-1', 'user', {
      actionIds: ['act-1'],
      actorId: ME,
    });

    await expect(
      service.cancel({ ...user, userId: ANNA }, 'act-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.cancel({ ...user, organizationId: 'org-2' }, 'act-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cancels the subtasks of a cancelled proposal with it, and nothing else', async () => {
    tables.agent_actions = [
      actionRow(),
      actionRow({ id: 'act-2', ordinal: 2, kind: 'subtask', depends_on: 1 }),
      actionRow({ id: 'act-3', ordinal: 3, kind: 'subtask', depends_on: 2 }),
      actionRow({ id: 'act-4', ordinal: 4 }),
    ];

    await service.cancel(user, 'act-1');

    expect(runs.cancelActions).toHaveBeenCalledWith('org-1', 'user', {
      actionIds: ['act-1', 'act-2', 'act-3'],
      actorId: ME,
    });
  });

  it('retries a failed proposal through the same Confirm', async () => {
    tables.agent_actions = [
      actionRow({ status: 'failed', reason: 'internal' }),
    ];

    await expect(service.retry(user, 'act-1', 2)).resolves.toBe(view);
    expect(runs.claimActions).toHaveBeenCalledWith('org-1', 'run-1', ME, {
      'act-1': 2,
    });
    expect(tasks.createTask).toHaveBeenCalledTimes(1);
  });

  it('stores feedback as an audit row of a finished run only', async () => {
    await service.feedback(user, 'run-1', 'up');
    expect(runs.recordAudit).toHaveBeenCalledWith({
      organizationId: 'org-1',
      event: 'run.feedback',
      actorId: ME,
      runId: 'run-1',
      conversationId: 'conv-1',
      data: { rating: 'up' },
    });

    tables.agent_runs[0].status = 'running';
    await expect(service.feedback(user, 'run-1', 'up')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  describe('reconcile', () => {
    const stuck = (over: Row = {}) =>
      ({
        ...actionRow({ status: 'executing', exec_token: 'tok-new' }),
        ...over,
      }) as never;

    it('finishes a hung Confirm whose task exists', async () => {
      tables.tasks = [{ id: 'task-new-1', organization_id: 'org-1' }];
      await service.reconcile(stuck());

      expect(runs.completeAction).toHaveBeenCalledWith({
        actionId: 'act-1',
        execToken: 'tok-new',
        outcome: 'executed',
        audit: { reconciled: true },
      });
    });

    it('puts a hung Confirm without a task back on the card', async () => {
      await service.reconcile(stuck());
      expect(runs.completeAction).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'released' }),
      );
    });

    it('leaves an undo alone and never throws', async () => {
      await service.reconcile(stuck({ status: 'undoing' }));
      expect(runs.completeAction).not.toHaveBeenCalled();

      runs.completeAction.mockRejectedValue(new Error('down'));
      await expect(service.reconcile(stuck())).resolves.toBeUndefined();
    });
  });
});

describe('executor helpers', () => {
  it('plainToHtml escapes everything and keeps paragraphs', () => {
    expect(plainToHtml('<img src=x>\nnext\n\n"q" & a')).toBe(
      '<p>&lt;img src=x&gt;<br>next</p><p>&quot;q&quot; &amp; a</p>',
    );
    expect(plainToHtml(null)).toBeUndefined();
  });

  it('failureReason maps task service errors to stable codes', () => {
    expect(failureReason(new NotFoundException())).toBe('no_create_permission');
    expect(
      failureReason(new BadRequestException('invalid task type for parent')),
    ).toBe('invalid_type');
    expect(failureReason(new BadRequestException('unknown priority'))).toBe(
      'invalid_input',
    );
    expect(failureReason(new Error('boom'))).toBe('internal');
  });

  it('materialOf ignores key order (jsonb) and the pickers, not the values', () => {
    const a = resolved();
    const reordered = JSON.parse(
      JSON.stringify({
        fields: a.fields,
        create: a.create,
        confirmable: true,
        title: a.title,
      }),
    ) as AgentResolved;
    reordered.fields[0].options = [{ value: 'x', label: 'X' }];

    expect(materialOf(reordered)).toBe(materialOf(a));
    expect(
      materialOf(
        resolved({
          create: create({ assigneeId: null }) as AgentResolved['create'],
        }),
      ),
    ).not.toBe(materialOf(a));
  });
});
