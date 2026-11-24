import { BadRequestException } from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AgentActionExecutorService, failureReason } from './agent-action-executor.service';
import { AgentGovernanceError } from './agent-governance.service';
import type { AgentPlanOf, AgentResolved } from './agent-resolver.service';

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const run = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, value: unknown) => (filters.push((row) => row[col] === value), q),
      in: (col: string, values: unknown[]) => (filters.push((row) => values.includes(row[col])), q),
      order: () => q,
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve),
    };
    return q;
  };
  return { from };
}

const user = { userId: 'me', organizationId: 'org-1' } as RequestUser;

const resolvedOf = (create: AgentPlanOf, confirmable = true): AgentResolved => ({
  title: 'x',
  description: null,
  confirmable,
  fields: [],
  create,
});

const task = (over: object = {}) => ({
  spaceId: null,
  pendingSpace: 1,
  summary: 'Do it',
  description: null,
  taskTypeId: null,
  statusId: null,
  priorityKey: null,
  assigneeId: null,
  dueDate: null,
  labels: [],
  parentTaskId: null,
  customFieldValues: {},
  ...over,
});

const row = (id: string, ordinal: number, kind: string, create: AgentPlanOf, depends_on: number | null = null, over: Row = {}): Row => ({
  id,
  ordinal,
  kind,
  depends_on,
  entity_id: `e-${id}`,
  organization_id: 'org-1',
  run_id: 'run-1',
  status: 'proposed',
  version: 1,
  intent: {},
  overrides: {},
  expires_at: '2999-01-01T00:00:00Z',
  resolved: resolvedOf(create),
  ...over,
});

const SPACE: AgentPlanOf = { kind: 'space', spaceId: null, name: 'Audit', key: 'AUDIT', description: null, enableWiki: true };
const MEMBER: AgentPlanOf = { kind: 'space_member_add', spaceId: null, pendingSpace: 1, userId: 'ala', role: 'admin', grant: [], revoke: [] };
const LEAVE: AgentPlanOf = { kind: 'space_member_remove', spaceId: null, pendingSpace: 1, userId: 'me', role: null, grant: [], revoke: [] };
const PROCESS: AgentPlanOf = { kind: 'process', spaceId: null, pendingSpace: 1, title: 'Review', description: null, requestType: 'Risiko', assigneeId: null, scores: {} };
const PAGE = (over: object = {}): AgentPlanOf =>
  ({
    kind: 'wiki_page',
    spaceId: null,
    pendingSpace: 1,
    parentPageId: null,
    title: 'Docs',
    doc: { type: 'doc', content: [] },
    labelIds: [],
    publish: false,
    items: [],
    readSpaces: [],
    restricted: false,
    ...over,
  }) as AgentPlanOf;

function build(actions: Row[]) {
  const tables: Record<string, Row[]> = {
    agent_runs: [
      {
        id: 'run-1',
        organization_id: 'org-1',
        conversation_id: 'c',
        invoker_id: 'me',
        status: 'completed',
        visibility: 'invoker',
        scope: { spaces: [], refs: [] },
        timezone: 'UTC',
      },
    ],
    agent_actions: actions,
  };
  const db = fakeDb(tables);
  const calls: string[] = [];
  const note = (name: string) => calls.push(name);
  const completed: Row[] = [];
  const runs = {
    patchAction: jest.fn().mockResolvedValue({ updated: true, version: 2 }),
    markConfirming: jest.fn().mockResolvedValue(undefined),
    claimActions: jest.fn((_o, _r, _a, versions: Record<string, number>) =>
      Promise.resolve(
        tables.agent_actions
          .filter((a) => versions[a.id as string] !== undefined)
          .map((a) => ({ ...a, status: 'executing', exec_token: `t-${a.id as string}` })),
      ),
    ),
    completeAction: jest.fn((args: Row) => (completed.push(args), Promise.resolve({ completed: true }))),
    cancelActions: jest.fn().mockResolvedValue(1),
    completeUndo: jest.fn().mockResolvedValue({ completed: true }),
  };
  const resolver = {
    batch: jest.fn((args: object) => ({ ...args, siblings: new Map(), memo: new Map() })),
    resolve: jest.fn((_b, action: { kind: string; intent: Row }) => {
      const stored = tables.agent_actions.find((a) => a.kind === action.kind);
      return Promise.resolve(stored?.resolved);
    }),
    hidesFromAudience: jest.fn().mockResolvedValue(false),
  };
  const governance = {
    createSpace: jest.fn(async () => (note('space'), { adopted: false })),
    createProcess: jest.fn(async () => (note('process'), { adopted: false })),
    changeMember: jest.fn(async (_u, c: { kind: string }) => (note(c.kind), { adopted: false })),
    memberChangeApplied: jest.fn().mockResolvedValue(true),
  };
  const tasks = {
    createTask: jest.fn(async (_u, dto: { summary: string }, trusted: { taskId: string }) => {
      note('task');
      return { task: { id: trusted.taskId, key: 'A-T1', summary: dto.summary, assignee: null } };
    }),
  };
  const wiki = { createWikiPage: jest.fn(async () => (note('page'), { page: { id: 'x' } })) };
  const wikiService = { createLink: jest.fn().mockResolvedValue({}) };
  const service = new AgentActionExecutorService(
    { getClient: () => ({ from: db.from }) } as never,
    runs as never,
    { viewOne: jest.fn().mockResolvedValue({ id: 'run-1' }), announce: jest.fn() } as never,
    resolver as never,
    { getReadable: jest.fn().mockResolvedValue({ conversation: { id: 'c', kind: 'group', space_id: null } }) } as never,
    { loadUsers: jest.fn().mockResolvedValue(new Map()) } as never,
    tasks as never,
    { broadcastNotification: jest.fn() } as never,
    wiki as never,
    undefined,
    governance as never,
    wikiService as never,
  );
  return { service, tables, governance, tasks, wiki, wikiService, runs, calls, completed };
}

const all = (rows: Row[]) => rows.map((r) => ({ id: r.id as string, version: 1 }));

describe('AgentActionExecutorService spaces, members and processes (1.20)', () => {
  const plan = () => [
    row('leave', 6, 'space_member_remove', LEAVE, 1),
    row('page', 5, 'wiki_page', PAGE(), 3),
    row('task', 4, 'task', task(), 3),
    row('proc', 3, 'process', PROCESS, 1),
    row('ala', 2, 'space_member_add', MEMBER, 1),
    row('space', 1, 'space', SPACE),
  ];

  it('runs space, members, process, tasks, pages, then whoever leaves', async () => {
    const rows = plan();
    const { service, calls } = build(rows);
    await service.confirm(user, 'run-1', all(rows));
    expect(calls).toEqual(['space', 'space_member_add', 'process', 'task', 'page', 'space_member_remove']);
  });

  it('runs by kind, not by card order: whoever leaves goes last even as an early card', async () => {
    const rows = [
      row('space', 1, 'space', SPACE),
      row('leave', 2, 'space_member_remove', LEAVE, 1),
      row('page', 3, 'wiki_page', PAGE({ pendingSpace: 1 }), 1),
      row('task', 4, 'task', task(), 1),
    ];
    const { service, calls } = build(rows);
    await service.confirm(user, 'run-1', all(rows));
    expect(calls).toEqual(['space', 'task', 'page', 'space_member_remove']);
  });

  it('puts everything in the reserved id of the new space, as the person confirming', async () => {
    const rows = plan();
    const { service, governance, tasks, wiki } = build(rows);
    await service.confirm(user, 'run-1', all(rows));
    expect(governance.createSpace).toHaveBeenCalledWith(user, 'e-space', SPACE);
    expect(governance.createProcess).toHaveBeenCalledWith(user, 'e-proc', 'e-space', PROCESS);
    expect(governance.changeMember.mock.calls[0]).toEqual([
      user,
      { kind: 'space_member_add', spaceId: 'e-space', userId: 'ala', role: 'admin', grant: [], revoke: [] },
    ]);
    const [, taskDto, trusted] = tasks.createTask.mock.calls[0] as unknown as [unknown, Row, Row];
    expect(taskDto.spaceIdOrKey).toBe('e-space');
    expect(trusted).toMatchObject({ taskId: 'e-task', processId: 'e-proc' });
    expect(trusted.parentTaskId).toBeUndefined();
    const [, pageDto] = wiki.createWikiPage.mock.calls[0] as unknown as [unknown, Row];
    expect(pageDto.spaceIdOrKey).toBe('e-space');
    expect(pageDto.parentPageId).toBeUndefined();
  });

  it('creates a sub-process under the reserved id of its main process, in the new space', async () => {
    const rows = [row('space', 1, 'space', SPACE), row('main', 2, 'process', PROCESS, 1), row('sub', 3, 'process', PROCESS, 2)];
    const { service, governance, calls } = build(rows);
    await service.confirm(user, 'run-1', all(rows));
    expect(calls).toEqual(['space', 'process', 'process']);
    expect(governance.createProcess).toHaveBeenCalledWith(user, 'e-main', 'e-space', PROCESS);
    expect(governance.createProcess).toHaveBeenCalledWith(user, 'e-sub', 'e-space', { ...PROCESS, parentId: 'e-main' });
  });

  it('keeps a parent that already exists, and goes three levels deep', async () => {
    const top = { ...PROCESS, spaceId: 's', pendingSpace: null, parentId: 'existing' } as AgentPlanOf;
    const alone = [row('a', 1, 'process', top)];
    const first = build(alone);
    await first.service.confirm(user, 'run-1', all(alone));
    expect(first.governance.createProcess).toHaveBeenCalledWith(user, 'e-a', 's', top);

    const rows = [row('space', 1, 'space', SPACE), row('a', 2, 'process', PROCESS, 1), row('b', 3, 'process', PROCESS, 2), row('c', 4, 'process', PROCESS, 3)];
    const { service, governance } = build(rows);
    await service.confirm(user, 'run-1', all(rows));
    expect(governance.createProcess).toHaveBeenCalledWith(user, 'e-b', 'e-space', { ...PROCESS, parentId: 'e-a' });
    expect(governance.createProcess).toHaveBeenCalledWith(user, 'e-c', 'e-space', { ...PROCESS, parentId: 'e-b' });
  });

  it('checks scores edited on a card', async () => {
    const rows = [row('p', 1, 'process', { ...PROCESS, spaceId: 's', pendingSpace: null } as AgentPlanOf)];
    const { service } = build(rows);
    const edit = (scores: unknown) => service.patch(user, 'run-1', [{ actionId: 'p', version: 1, fields: { scores } }]);
    await expect(edit({ vuln_c_p: 9 })).rejects.toThrow('Invalid value');
    await expect(edit({ owner: 1 })).rejects.toThrow('Invalid value');
    await expect(edit('high')).rejects.toThrow('Invalid value');
    await expect(edit([1])).rejects.toThrow('Invalid value');
  });

  it('links a page to its process, and keeps the page if the link fails', async () => {
    const rows = plan();
    const first = build(rows);
    await first.service.confirm(user, 'run-1', all(rows));
    expect(first.wikiService.createLink).toHaveBeenCalledWith('e-page', { target_type: 'process', target_id: 'e-proc' }, 'me', 'org-1');

    const again = plan();
    const second = build(again);
    second.wikiService.createLink.mockRejectedValue(new Error('no'));
    await second.service.confirm(user, 'run-1', all(again));
    const done = second.completed.find((c) => c.actionId === 'page');
    expect(done).toMatchObject({ outcome: 'executed', audit: { process_link_failed: true } });
  });

  it('gives a subtask the process of its parent task, and keeps the parent', async () => {
    const rows = [
      row('space', 1, 'space', SPACE),
      row('proc', 2, 'process', PROCESS, 1),
      row('task', 3, 'task', task(), 2),
      row('sub', 4, 'subtask', task(), 3),
    ];
    const { service, tasks } = build(rows);
    await service.confirm(user, 'run-1', all(rows));
    const trusted = tasks.createTask.mock.calls[1][2] as unknown as Row;
    expect(trusted).toMatchObject({ parentTaskId: 'e-task', processId: 'e-proc' });
  });

  it('stops the children when the space fails, and says which reason', async () => {
    const rows = plan();
    const { service, governance, tasks, wiki, completed } = build(rows);
    governance.createSpace.mockRejectedValue(new AgentGovernanceError('no_create_space'));
    await service.confirm(user, 'run-1', all(rows));
    expect(tasks.createTask).not.toHaveBeenCalled();
    expect(wiki.createWikiPage).not.toHaveBeenCalled();
    expect(governance.createProcess).not.toHaveBeenCalled();
    expect(governance.changeMember).not.toHaveBeenCalled();
    expect(completed.find((c) => c.actionId === 'space')?.reason).toBe('no_create_space');
    expect(completed.find((c) => c.actionId === 'proc')?.reason).toBe('parent_failed');
    expect(completed.find((c) => c.actionId === 'task')?.reason).toBe('parent_failed');
    expect(completed.find((c) => c.actionId === 'leave')?.reason).toBe('parent_failed');
  });

  it('stops the tasks of a failed process but not the member changes beside it', async () => {
    const rows = plan();
    const { service, governance, tasks, calls } = build(rows);
    governance.createProcess.mockRejectedValue(new AgentGovernanceError('no_create_process'));
    await service.confirm(user, 'run-1', all(rows));
    expect(tasks.createTask).not.toHaveBeenCalled();
    expect(calls).toEqual(['space', 'space_member_add', 'space_member_remove']);
  });

  it('refuses a child without its parent, and writes nothing', async () => {
    const rows = plan();
    const { service, governance, runs } = build(rows);
    await expect(service.confirm(user, 'run-1', [{ id: 'proc', version: 1 }])).rejects.toMatchObject({
      response: { code: 'parent_first' },
    });
    expect(governance.createProcess).not.toHaveBeenCalled();
    expect(runs.claimActions).not.toHaveBeenCalled();
  });

  it('cancels the whole tree under a cancelled space', async () => {
    const rows = [...plan()].sort((a, b) => (a.ordinal as number) - (b.ordinal as number));
    const { service, runs } = build(rows);
    await service.cancel(user, 'space');
    expect((runs.cancelActions.mock.calls[0][2] as { actionIds: string[] }).actionIds.sort()).toEqual(
      ['ala', 'leave', 'page', 'proc', 'space', 'task'].sort(),
    );
  });

  it('refuses a card field that kind does not have, and a bad role', async () => {
    const rows = [row('ala', 1, 'space_member_add', { ...MEMBER, pendingSpace: null, spaceId: 's' })];
    const { service } = build(rows);
    const edit = (fields: Row) => service.patch(user, 'run-1', [{ actionId: 'ala', version: 1, fields }]);
    await expect(edit({ title: 'x' })).rejects.toThrow('Unknown field title');
    await expect(edit({ priority: 'high' })).rejects.toThrow('Unknown field priority');
    await expect(edit({ role: 'superuser' })).rejects.toThrow('Invalid value for role');
    await expect(edit({ member: 'not-an-id' })).rejects.toThrow('Invalid value for member');
    await expect(edit({ space: 'not-an-id' })).rejects.toThrow('Invalid value for space');
  });

  it('never lets a card rewrite what permissions a change gives', async () => {
    const rows = [row('flags', 1, 'space_member_permissions', { ...MEMBER, kind: 'space_member_permissions', pendingSpace: null, spaceId: 's' })];
    const { service } = build(rows);
    await expect(
      service.patch(user, 'run-1', [{ actionId: 'flags', version: 1, fields: { grant: ['delete_space'] } }]),
    ).rejects.toThrow('Unknown field grant');
  });

  it('calls a gateway hiccup no input problem', () => {
    expect(failureReason(new BadRequestException('An invalid response was received from the upstream server'))).toBe('internal');
    expect(failureReason(new BadRequestException('title is invalid'))).toBe('invalid_input');
  });

  it('keeps the code of a governance refusal for the card', () => {
    expect(failureReason(new AgentGovernanceError('last_owner'))).toBe('last_owner');
  });

  describe('an Undo the sweep finds hung', () => {
    const hung = (kind: string) =>
      row('x', 1, kind, {} as never, null, { status: 'undoing', exec_token: 'tok', undone_by: 'u-9' });

    it('is undone when the object went', async () => {
      const { service, runs } = build([hung('process')]);
      await service.reconcile(hung('process') as never);
      expect(runs.completeUndo).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'undone', execToken: 'tok', actorId: 'u-9' }));
    });

    it('goes back to the card with a reason when it did not', async () => {
      const task = hung('task');
      const { service, runs, tables } = build([task]);
      tables.tasks = [{ id: task.entity_id, organization_id: task.organization_id }];
      await service.reconcile(task as never);
      expect(runs.completeUndo).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'blocked', reason: 'undo_interrupted' }));
    });

    it('calls an archived page undone', async () => {
      const page = hung('wiki_page');
      const { service, runs, tables } = build([page]);
      tables.wiki_pages = [{ id: page.entity_id, organization_id: page.organization_id, is_archived: true }];
      await service.reconcile(page as never);
      expect(runs.completeUndo).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'undone' }));
    });

    it('leaves a claim whose token is gone', async () => {
      const { service, runs } = build([]);
      await service.reconcile({ ...hung('task'), exec_token: null } as never);
      expect(runs.completeUndo).not.toHaveBeenCalled();
    });
  });

  it('looks at the member row when the sweep finds a hung Confirm', async () => {
    const member = row('x', 1, 'space_member_role', { ...MEMBER, kind: 'space_member_role', pendingSpace: null, spaceId: 's' }, null, {
      status: 'executing',
      exec_token: 'tok',
    });
    const { service, governance, runs } = build([member]);
    await service.reconcile(member as never);
    expect(governance.memberChangeApplied).toHaveBeenCalled();
    expect(runs.completeAction).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'executed' }));
  });
});
