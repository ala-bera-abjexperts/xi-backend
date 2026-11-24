/**
 * Robert 1.22: Confirm of a plan and its items. The plan first, then its items parents first, each
 * under its reserved id through AgentPlansService; the WBS once per plan; the owner's bell, no email.
 */
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AgentActionExecutorService } from './agent-action-executor.service';
import { AgentGovernanceError } from './agent-governance.service';
import type { AgentPlanItemPlan, AgentPlanOf, AgentProductPlan, AgentResolved } from './agent-resolver.service';

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  const inserted: { table: string; payload: Row }[] = [];
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const run = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, value: unknown) => (filters.push((row) => row[col] === value), q),
      in: (col: string, values: unknown[]) => (filters.push((row) => values.includes(row[col])), q),
      order: () => q,
      insert: (payload: Row) => {
        inserted.push({ table, payload });
        return { select: () => Promise.resolve({ data: [{ id: 'n1', ...payload }], error: null }) };
      },
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve),
    };
    return q;
  };
  return { from, inserted };
}

const user = { userId: 'me', organizationId: 'org-1' } as RequestUser;

const PLAN: AgentProductPlan = {
  kind: 'plan',
  spaceId: 'space-a',
  name: 'Q4',
  description: null,
  planType: 'waterfall',
  startDate: '2026-10-01',
  endDate: '2026-12-31',
  ownerId: null,
};
const item = (over: Partial<AgentPlanItemPlan> = {}): AgentPlanItemPlan => ({
  kind: 'plan_item',
  spaceId: 'space-a',
  planId: null,
  pendingPlan: 1,
  parentTaskId: null,
  name: 'Build',
  description: null,
  itemType: 'phase',
  startDate: null,
  endDate: null,
  ownerId: null,
  priority: null,
  estimatedHours: null,
  estimatedCost: null,
  progress: null,
  ...over,
});

const row = (id: string, ordinal: number, kind: string, create: AgentPlanOf, depends_on: number | null = null): Row => ({
  id,
  ordinal,
  kind,
  depends_on,
  entity_id: `e-${id}`,
  organization_id: 'org-1',
  run_id: 'run-1',
  status: 'proposed',
  version: 1,
  intent: { ref: id },
  overrides: {},
  expires_at: '2999-01-01T00:00:00Z',
  resolved: { title: 'x', description: null, confirmable: true, fields: [], create } as AgentResolved,
});

function build(actions: Row[], over: { addItem?: jest.Mock; createPlan?: jest.Mock } = {}) {
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
    tasks: [{ id: 'e-item', organization_id: 'org-1', key: 'A-T7', spaces: { key: 'A' } }],
  };
  const db = fakeDb(tables);
  const calls: string[] = [];
  const completed: Row[] = [];
  const runs = {
    patchAction: jest.fn().mockResolvedValue({ updated: true, version: 2 }),
    claimActions: jest.fn((_o, _r, _a, versions: Record<string, number>) =>
      Promise.resolve(
        tables.agent_actions
          .filter((a) => versions[a.id as string] !== undefined)
          .map((a) => ({ ...a, status: 'executing', exec_token: `t-${a.id as string}` })),
      ),
    ),
    undoTask: jest.fn().mockResolvedValue({ deleted: true, blockers: [] }),
    markConfirming: jest.fn().mockResolvedValue(undefined),
    linkPlanTask: jest.fn().mockResolvedValue({ linked: true, adopted: false, id: 'x' }),
    addPlanDependency: jest.fn().mockResolvedValue({ created: true, adopted: false, id: 'rel-1' }),
    recordAudit: jest.fn().mockResolvedValue(undefined),
    completeAction: jest.fn((args: Row) => {
      completed.push(args);
      const a = tables.agent_actions.find((x) => x.id === args.actionId);
      if (a) a.status = args.outcome;
      return Promise.resolve({ completed: true });
    }),
  };
  const resolver = {
    batch: jest.fn((args: object) => ({ ...args, siblings: new Map(), memo: new Map() })),
    resolve: jest.fn((_b, action: { intent: Row }) =>
      Promise.resolve(tables.agent_actions.find((a) => a.id === action.intent.ref)?.resolved),
    ),
    hidesFromAudience: jest.fn().mockResolvedValue(false),
  };
  const plans = {
    createPlan: over.createPlan ?? jest.fn(async () => (calls.push('plan'), { adopted: false })),
    addItem:
      over.addItem ??
      jest.fn(async (_u: unknown, id: string) => (calls.push(`item:${id}`), { adopted: false })),
    recalculate: jest.fn().mockResolvedValue(undefined),
    planOfTask: jest.fn().mockResolvedValue('e-plan'),
    keepCreatorAdmin: jest.fn().mockResolvedValue(undefined),
    auditLinked: jest.fn().mockResolvedValue(undefined),
    auditDependency: jest.fn().mockResolvedValue(undefined),
  };
  const governance = { finishSpace: jest.fn().mockResolvedValue(undefined) };
  const broadcast = { broadcastNotification: jest.fn() };
  const service = new AgentActionExecutorService(
    { getClient: () => ({ from: db.from }) } as never,
    runs as never,
    { viewOne: jest.fn().mockResolvedValue({ id: 'run-1' }), announce: jest.fn() } as never,
    resolver as never,
    { getReadable: jest.fn().mockResolvedValue({ conversation: { id: 'c', kind: 'group', space_id: null } }) } as never,
    { loadUsers: jest.fn().mockResolvedValue(new Map([['me', { name: 'Anna' }]])) } as never,
    { createTask: jest.fn() } as never,
    broadcast as never,
    undefined,
    undefined,
    governance as never,
    undefined,
    plans as never,
  );
  return { service, tables, plans, calls, completed, inserted: db.inserted, broadcast, runs, governance };
}

const all = (rows: Row[]) => rows.map((r) => ({ id: r.id as string, version: 1 }));

describe('AgentActionExecutorService plans and plan items (1.22)', () => {
  it('creates the plan, then its items parents first, each under its reserved id, in the plan of this run', async () => {
    const rows = [
      row('child', 3, 'plan_item', item({ name: 'Code', itemType: 'task' }), 2),
      row('item', 2, 'plan_item', item(), 1),
      row('plan', 1, 'plan', PLAN),
    ];
    const { service, plans, calls } = build(rows);
    await service.confirm(user, 'run-1', all(rows));

    expect(calls).toEqual(['plan', 'item:e-item', 'item:e-child']);
    expect(plans.createPlan).toHaveBeenCalledWith(user, 'e-plan', { ...PLAN, spaceId: 'space-a' });
    // The plan of this run by its reserved id; a parent of this run by its reserved id.
    expect(plans.addItem.mock.calls[0].slice(1, 4)).toEqual(['e-item', 'e-plan', null]);
    expect(plans.addItem.mock.calls[1].slice(1, 4)).toEqual(['e-child', 'e-plan', 'e-item']);
    // The WBS once, after all items of the Confirm.
    expect(plans.recalculate).toHaveBeenCalledTimes(1);
    expect(plans.recalculate).toHaveBeenCalledWith(['e-plan', 'e-plan']);
  });

  it('an item in an existing plan under an existing item uses those ids', async () => {
    const rows = [row('item', 1, 'plan_item', item({ planId: 'plan-x', pendingPlan: null, parentTaskId: 'task-p' }))];
    const { service, plans } = build(rows);
    await service.confirm(user, 'run-1', all(rows));
    expect(plans.addItem.mock.calls[0].slice(1, 4)).toEqual(['e-item', 'plan-x', 'task-p']);
  });

  it('a failed plan fails its items with parent_failed, and nothing is renumbered', async () => {
    const rows = [row('plan', 1, 'plan', PLAN), row('item', 2, 'plan_item', item(), 1)];
    const { service, plans, completed } = build(rows, {
      createPlan: jest.fn().mockRejectedValue(new AgentGovernanceError('no_create_plan')),
    });
    await service.confirm(user, 'run-1', all(rows));
    expect(completed.map((c) => [c.actionId, c.outcome, c.reason])).toEqual([
      ['plan', 'failed', 'no_create_plan'],
      ['item', 'failed', 'parent_failed'],
    ]);
    expect(plans.addItem).not.toHaveBeenCalled();
    expect(plans.recalculate).not.toHaveBeenCalled();
  });

  it('an archived plan at Confirm is said in plain words', async () => {
    const rows = [row('item', 1, 'plan_item', item({ planId: 'plan-x', pendingPlan: null }))];
    const { service, completed } = build(rows, {
      addItem: jest.fn().mockRejectedValue(new AgentGovernanceError('plan_archived')),
    });
    await service.confirm(user, 'run-1', all(rows));
    expect(completed[0]).toMatchObject({ outcome: 'failed', reason: 'plan_archived' });
  });

  it('the owner gets a bell (not the invoker, not when adopted), never an email', async () => {
    const rows = [row('item', 1, 'plan_item', item({ planId: 'plan-x', pendingPlan: null, ownerId: 'ala', name: 'Pen test done' }))];
    const { service, inserted, broadcast } = build(rows);
    await service.confirm(user, 'run-1', all(rows));
    await new Promise((r) => setTimeout(r, 0));
    const bells = inserted.filter((i) => i.table === 'notifications');
    expect(bells).toHaveLength(1);
    expect(bells[0].payload).toMatchObject({
      user_id: 'ala',
      type: 'robert_task_assigned',
      title: 'Anna added a plan item for you with Robert: Pen test done',
      reference_id: 'e-item',
    });
    expect(broadcast.broadcastNotification).toHaveBeenCalledTimes(1);

    const mine = build([row('item', 1, 'plan_item', item({ planId: 'plan-x', pendingPlan: null, ownerId: 'me' }))]);
    await mine.service.confirm(user, 'run-1', all(mine.tables.agent_actions));
    const adopted = build([row('item', 1, 'plan_item', item({ planId: 'plan-x', pendingPlan: null, ownerId: 'ala' }))], {
      addItem: jest.fn().mockResolvedValue({ adopted: true }),
    });
    await adopted.service.confirm(user, 'run-1', all(adopted.tables.agent_actions));
    await new Promise((r) => setTimeout(r, 0));
    expect(mine.inserted.filter((i) => i.table === 'notifications')).toHaveLength(0);
    expect(adopted.inserted.filter((i) => i.table === 'notifications')).toHaveLength(0);
  });

  it('a hung Confirm of an item counts as done only with its plan link', async () => {
    const base = { id: 'item', kind: 'plan_item', status: 'executing', exec_token: 't', entity_id: 'e-item', organization_id: 'org-1', run_id: 'run-1' };
    const linked = build([]);
    await linked.service.reconcile(base as never);
    expect(linked.completed[0]).toMatchObject({ outcome: 'executed' });

    const unlinked = build([]);
    unlinked.plans.planOfTask.mockResolvedValue(null);
    await unlinked.service.reconcile(base as never);
    expect(unlinked.completed[0]).toMatchObject({ outcome: 'released' });
  });

  it('marks the run while it creates, so no Undo deletes a parent under a child being written (audit 2026-11-10)', async () => {
    const rows = [row('plan', 1, 'plan', PLAN), row('item', 2, 'plan_item', item(), 1)];
    const { service, runs } = build(rows);
    const order: string[] = [];
    runs.markConfirming.mockImplementation(async (_o: unknown, _r: unknown, on: boolean) => void order.push(on ? 'on' : 'off'));
    const claim = runs.claimActions.getMockImplementation();
    runs.claimActions.mockImplementation((...args: Parameters<NonNullable<typeof claim>>) => (order.push('claim'), claim!(...args)));
    await service.confirm(user, 'run-1', all(rows));
    expect(order).toEqual(['on', 'claim', 'claim', 'off']);
    expect(runs.markConfirming).toHaveBeenCalledWith('org-1', 'run-1', true);

    // Cleared also when creating fails.
    const failing = build(rows.map((r) => ({ ...r, status: 'proposed' })), { createPlan: jest.fn().mockRejectedValue(new Error('db down')) });
    await failing.service.confirm(user, 'run-1', all(rows)).catch(() => undefined);
    expect(failing.runs.markConfirming).toHaveBeenLastCalledWith('org-1', 'run-1', false);
  });

  it('a parent another tab confirmed meanwhile counts as done: its child is made, not failed (audit 2026-11-10)', async () => {
    const rows = [row('plan', 1, 'plan', PLAN), row('item', 2, 'plan_item', item(), 1)];
    const { service, tables, runs, completed } = build(rows);
    const claim = runs.claimActions.getMockImplementation();
    runs.claimActions.mockImplementation((o: unknown, r: unknown, a: unknown, versions: Record<string, number>) => {
      if (versions.plan !== undefined) {
        // The other tab got there first: the plan is made, this request claims nothing.
        tables.agent_actions.splice(0, tables.agent_actions.length, ...tables.agent_actions.map((x) => (x.id === 'plan' ? { ...x, status: 'executed' } : x)));
        return Promise.resolve([]);
      }
      return claim!(o, r, a, versions);
    });
    await service.confirm(user, 'run-1', all(rows));
    expect(completed.find((c) => c.actionId === 'item')).toMatchObject({ outcome: 'executed' });
  });

  it('at Confirm only executed cards and cards of this Confirm stand beside it (audit 2026-11-10)', async () => {
    const rows = [
      row('item', 2, 'plan_item', item({ planId: 'plan-x', pendingPlan: null })),
      { ...row('add', 1, 'space_member_add' as never, { kind: 'space_member_add' } as never), status: 'cancelled' },
      { ...row('open', 3, 'task' as never, { kind: 'task' } as never), status: 'proposed' },
    ];
    const { service } = build(rows);
    let seen: number[] = [];
    const resolverOf = service as unknown as { resolver: { resolve: jest.Mock } };
    const original = resolverOf.resolver.resolve.getMockImplementation();
    resolverOf.resolver.resolve.mockImplementation((b: { siblings: Map<number, unknown> }, a: unknown) => {
      seen = [...b.siblings.keys()];
      return original?.(b, a);
    });
    await service.confirm(user, 'run-1', [{ id: 'item', version: 1 }]);
    // Neither the cancelled member card nor the card left unconfirmed vouches for anything.
    expect(seen).toEqual([2]);
  });

  it('after a crash the sweep leaves nothing half made (audit 2026-11-10)', async () => {
    const base = { kind: 'plan_item', status: 'executing', exec_token: 't', organization_id: 'org-1', run_id: 'run-1', confirmed_by: 'me', created_at: '2026-11-10T10:00:00Z' };
    // An item task without its link goes, untouched; the card comes back and its Confirm makes it anew.
    const unlinked = build([]);
    unlinked.plans.planOfTask.mockResolvedValue(null);
    await unlinked.service.reconcile({ ...base, id: 'item', entity_id: 'e-item' } as never);
    expect(unlinked.runs.undoTask).toHaveBeenCalledWith({
      organizationId: 'org-1',
      taskId: 'e-item',
      actorId: 'me',
      since: '2026-11-10T10:00:00Z',
      runId: 'run-1',
    });
    expect(unlinked.completed[0]).toMatchObject({ outcome: 'released' });

    // A plan that stands gets its creator's admin row back.
    const plan = build([]);
    plan.tables.plans = [{ id: 'e-plan', organization_id: 'org-1' }];
    await plan.service.reconcile({ ...base, kind: 'plan', id: 'plan', entity_id: 'e-plan' } as never);
    expect(plan.completed[0]).toMatchObject({ outcome: 'executed' });
    expect(plan.plans.keepCreatorAdmin).toHaveBeenCalledWith('e-plan', 'me');

    // A space that stands gets its owner and modules.
    const space = build([]);
    space.tables.spaces = [{ id: 'e-space', organization_id: 'org-1' }];
    const create = { kind: 'space', name: 'Launch', key: 'LAUNCH', description: null, enableWiki: true, enablePlans: false };
    await space.service.reconcile({ ...base, kind: 'space', id: 'space', entity_id: 'e-space', resolved: { create } } as never);
    expect(space.governance.finishSpace).toHaveBeenCalledWith({ userId: 'me', organizationId: 'org-1' }, 'e-space', create, true);
  });

  it('an edit may set only the fields of its card, with values of the right shape', async () => {
    const rows = [row('item', 1, 'plan_item', item({ planId: 'plan-x', pendingPlan: null }))];
    const { service } = build(rows);
    const patch = (fields: Row) => service.patch(user, 'run-1', [{ actionId: 'item', version: 1, fields }]);
    await expect(patch({ progress: 50, start: '2026-11-01', itemType: 'milestone' })).resolves.toBeDefined();
    await expect(patch({ progress: 101 })).rejects.toThrow('Invalid value for progress');
    await expect(patch({ estimatedCost: -1 })).rejects.toThrow('Invalid value for estimatedCost');
    await expect(patch({ itemType: 'epic' })).rejects.toThrow('Invalid value for itemType');
    await expect(patch({ due: '2026-11-01' })).rejects.toThrow('Unknown field due');

    const plan = build([row('plan', 1, 'plan', PLAN)]);
    await expect(plan.service.patch(user, 'run-1', [{ actionId: 'plan', version: 1, fields: { planType: 'kanban' } }])).rejects.toThrow(
      'Invalid value for planType',
    );
    await expect(plan.service.patch(user, 'run-1', [{ actionId: 'plan', version: 1, fields: { status: 'active' } }])).rejects.toThrow(
      'Unknown field status',
    );
  });

  describe('existing tasks and dependencies (1.22.1)', () => {
    const link = (over: Row = {}) => ({
      kind: 'plan_link', spaceId: 'space-a', planId: 'plan-x', taskId: 'person-task', taskKey: 'A-T9', itemType: 'task', ...over,
    }) as never;

    it('adds an existing task: only the link under the reserved id, never a task write', async () => {
      const rows = [row('lnk', 1, 'plan_link', link())];
      const { service, runs, plans, completed } = build(rows);
      await service.confirm(user, 'run-1', all(rows));
      expect(runs.linkPlanTask).toHaveBeenCalledWith({ organizationId: 'org-1', planId: 'plan-x', taskId: 'person-task', linkId: 'e-lnk', itemType: 'task' });
      expect(plans.addItem).not.toHaveBeenCalled();
      expect(runs.undoTask).not.toHaveBeenCalled();
      expect(completed[0]).toMatchObject({ outcome: 'executed' });
      expect(plans.recalculate).toHaveBeenCalledWith(['plan-x']);
      expect(plans.auditLinked).toHaveBeenCalledWith(user, 'plan-x', 'person-task', 'task');
    });

    it('someone linked it a second before: a clean failure, the card says why', async () => {
      const rows = [row('lnk', 1, 'plan_link', link())];
      const { service, runs, completed } = build(rows);
      runs.linkPlanTask.mockResolvedValue({ linked: false, reason: 'already_in_plan' });
      await service.confirm(user, 'run-1', all(rows));
      expect(completed[0]).toMatchObject({ outcome: 'failed', reason: 'already_in_plan' });
    });

    it('a link into a plan of this run that failed fails with parent_failed', async () => {
      const rows = [row('plan', 1, 'plan', PLAN), row('lnk', 2, 'plan_link', link({ planId: null, pendingPlan: 1 }), 1)];
      const { service, completed } = build(rows, { createPlan: jest.fn().mockRejectedValue(new Error('down')) });
      await service.confirm(user, 'run-1', all(rows)).catch(() => undefined);
      expect(completed.find((c) => c.actionId === 'lnk')).toMatchObject({ outcome: 'failed', reason: 'parent_failed' });
    });

    it('writes dependencies after every card ran, in the right direction, to a linked task too', async () => {
      const rows = [
        row('pen', 1, 'plan_item', item({ planId: 'plan-x', pendingPlan: null, name: 'Pen test', dependencies: [
          { type: 'finish_to_start', thisIs: 'successor', otherTaskId: 'build-task', otherOrdinal: null },
          { type: 'start_to_start', thisIs: 'predecessor', otherTaskId: null, otherOrdinal: 2 },
        ] })),
        row('lnk', 2, 'plan_link', link()),
      ];
      const { service, runs, plans } = build(rows);
      await service.confirm(user, 'run-1', all(rows));
      expect(runs.addPlanDependency.mock.calls.map((c) => c[0])).toEqual([
        { organizationId: 'org-1', planId: 'plan-x', actionId: 'pen', sourceTaskId: 'build-task', targetTaskId: 'e-pen', typeName: 'Finish to Start' },
        { organizationId: 'org-1', planId: 'plan-x', actionId: 'pen', sourceTaskId: 'e-pen', targetTaskId: 'person-task', typeName: 'Start to Start' },
      ]);
      // After the link ran, so its task is in the plan.
      expect(runs.linkPlanTask.mock.invocationCallOrder[0]).toBeLessThan(runs.addPlanDependency.mock.invocationCallOrder[0]);
      expect(plans.auditDependency).toHaveBeenCalledTimes(2);
    });

    it('a dependency that fails leaves the item, and the card says which and why', async () => {
      const rows = [row('pen', 1, 'plan_item', item({ planId: 'plan-x', pendingPlan: null, dependencies: [
        { type: 'finish_to_start', thisIs: 'successor', otherTaskId: 'build-task', otherOrdinal: null },
        { type: 'finish_to_start', thisIs: 'successor', otherTaskId: null, otherOrdinal: 9 },
      ] }))];
      const { service, runs, completed } = build(rows);
      runs.addPlanDependency.mockResolvedValue({ created: false, reason: 'dependency_cycle' });
      await service.confirm(user, 'run-1', all(rows));
      expect(completed[0]).toMatchObject({ outcome: 'executed' });
      expect(runs.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'action.dependencies', actionId: 'pen', data: { dependency_failed: ['dependency_cycle', 'dependency_end_gone'] } }),
      );
    });

    it('a link card may change only its plan and type; a dependency row only one of the four types', async () => {
      const rows = [row('lnk', 1, 'plan_link', link())];
      const { service } = build(rows);
      const patch = (fields: Row) => service.patch(user, 'run-1', [{ actionId: 'lnk', version: 1, fields }]);
      await expect(patch({ start: '2026-11-01' })).rejects.toThrow(/Unknown field/);
      await expect(patch({ title: 'x' })).rejects.toThrow(/Unknown field/);
      const items = build([row('pen', 1, 'plan_item', item({ planId: 'plan-x', pendingPlan: null }))]);
      const patchItem = (fields: Row) => items.service.patch(user, 'run-1', [{ actionId: 'pen', version: 1, fields }]);
      await expect(patchItem({ 'dependency:0': 'sideways' })).rejects.toThrow(/Invalid/);
      await expect(patchItem({ 'dependency:0': 'start_to_start' })).resolves.toBeDefined();
    });

    it('a hung link Confirm counts as done only when its row is there; it never deletes the task', async () => {
      const base = { id: 'lnk', kind: 'plan_link', status: 'executing', exec_token: 't', entity_id: 'e-lnk', organization_id: 'org-1', run_id: 'run-1', confirmed_by: 'me' };
      const none = build([]);
      await none.service.reconcile(base as never);
      expect(none.completed[0]).toMatchObject({ outcome: 'released' });
      expect(none.runs.undoTask).not.toHaveBeenCalled();
      const there = build([]);
      there.tables.plan_tasks = [{ id: 'e-lnk', 'plan.organization_id': 'org-1' }];
      await there.service.reconcile(base as never);
      expect(there.completed[0]).toMatchObject({ outcome: 'executed' });
    });
  });
});
