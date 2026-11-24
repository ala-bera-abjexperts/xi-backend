/**
 * Robert 1.23: Confirm of a suggestion. Only what the card shows is written, one row each, checked
 * again under the plan lock; a refused one leaves the others; a baseline through the human code.
 */
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AgentActionExecutorService } from './agent-action-executor.service';
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
    addPlanRisk: jest.fn().mockResolvedValue({ created: true, adopted: false }),
    addPlanStakeholder: jest.fn().mockResolvedValue({ created: true, adopted: false }),
    setPlanDates: jest.fn().mockResolvedValue({ set: true, adopted: false }),
    setBeforeValues: jest.fn().mockResolvedValue(undefined),
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
    auditChange: jest.fn().mockResolvedValue(undefined),
    activeBaseline: jest.fn().mockResolvedValue('bl-old'),
    takeBaseline: jest.fn().mockResolvedValue({ adopted: false }),
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
const base = { spaceId: 'space-a', planId: 'plan-q4', reason: 'from [m2]' };
const RISK: AgentPlanOf = { kind: 'plan_risk', ...base, name: 'Vendor late', description: 'd', riskType: 'risk', category: 'Schedule', probability: 4, impact: 3, mitigation: 'm', contingency: null, ownerId: 'anna' };
const SH: AgentPlanOf = { kind: 'plan_stakeholder', ...base, name: 'CISO', role: 'Approver', organization: 'IT', email: null, power: 9, interest: 6, attitude: 'supportive', engagement: 'weekly', linkedUserId: null };
const DEP: AgentPlanOf = { kind: 'plan_dependency', ...base, sourceTaskId: 'build', targetTaskId: 'pen', type: 'finish_to_start' };
const DATES: AgentPlanOf = { kind: 'plan_dates', ...base, reason: null, taskId: 'pen', start: '2026-12-14', end: '2026-12-15', duration: 1 };
const BASE: AgentPlanOf = { kind: 'plan_baseline', ...base, reason: null, name: 'Before pen test', items: 6 };

describe('AgentActionExecutorService: suggestions (1.23)', () => {
  it('writes exactly what each card shows, under its reserved id, in kind order (baseline last)', async () => {
    const rows = [
      row('bl', 5, 'plan_baseline', BASE),
      row('dates', 4, 'plan_dates', DATES),
      row('dep', 3, 'plan_dependency', DEP),
      row('sh', 2, 'plan_stakeholder', SH),
      row('risk', 1, 'plan_risk', RISK),
    ];
    const { service, runs, plans, completed } = build(rows);
    await service.confirm(user, 'run-1', all(rows));
    expect(completed.map((c) => [c.actionId, c.outcome])).toEqual([
      ['risk', 'executed'], ['sh', 'executed'], ['dep', 'executed'], ['dates', 'executed'], ['bl', 'executed'],
    ]);
    expect(runs.addPlanRisk).toHaveBeenCalledWith({
      organizationId: 'org-1', planId: 'plan-q4', riskId: 'e-risk', actorId: 'me',
      fields: { name: 'Vendor late', description: 'd', risk_type: 'risk', category: 'Schedule', probability: 4, impact: 3, mitigation_strategy: 'm', contingency_plan: null, owner_id: 'anna' },
    });
    expect(runs.addPlanStakeholder.mock.calls[0][0]).toMatchObject({ stakeholderId: 'e-sh', fields: { name: 'CISO', power_level: 9, interest_level: 6, attitude: 'supportive', user_id: null } });
    expect(runs.addPlanDependency).toHaveBeenCalledWith(expect.objectContaining({ id: 'e-dep', actionId: 'dep', sourceTaskId: 'build', targetTaskId: 'pen', typeName: 'Finish to Start' }));
    expect(runs.setPlanDates).toHaveBeenCalledWith({ organizationId: 'org-1', planId: 'plan-q4', actionId: 'dates', taskId: 'pen', start: '2026-12-14', end: '2026-12-15', duration: 1 });
    // The baseline active before is kept for the Undo, then the human baseline code runs.
    expect(runs.setBeforeValues).toHaveBeenCalledWith('org-1', 'bl', { previous_active_id: 'bl-old' });
    expect(plans.takeBaseline).toHaveBeenCalledWith(user, 'e-bl', 'plan-q4', 'Before pen test');
    // The audit rows a person's add writes.
    expect(plans.auditChange).toHaveBeenCalledWith(user, 'plan_risk', 'e-risk', 'create', expect.objectContaining({ plan_id: 'plan-q4' }));
    expect(plans.auditChange).toHaveBeenCalledWith(user, 'plan_item', 'pen', 'update', expect.objectContaining({ start_date: '2026-12-14' }));
    expect(plans.auditDependency).toHaveBeenCalledWith(user, 'plan-q4', 'e-dep', 'build', 'pen', 'finish_to_start');
  });

  it('a refusal under the plan lock fails that card only, with its reason; the others stand', async () => {
    const rows = [row('risk', 1, 'plan_risk', RISK), row('dates', 2, 'plan_dates', DATES), row('dep', 3, 'plan_dependency', DEP)];
    const { service, runs, plans, completed } = build(rows);
    runs.addPlanRisk.mockResolvedValue({ created: false, reason: 'same_name_in_plan' });
    runs.setPlanDates.mockResolvedValue({ set: false, reason: 'has_dates' });
    runs.addPlanDependency.mockResolvedValue({ created: false, reason: 'dependency_cycle' });
    await service.confirm(user, 'run-1', all(rows));
    expect(completed.map((c) => [c.actionId, c.outcome, c.reason])).toEqual([
      ['risk', 'failed', 'same_name_in_plan'], ['dep', 'failed', 'dependency_cycle'], ['dates', 'failed', 'has_dates'],
    ]);
    expect(plans.auditChange).not.toHaveBeenCalled();
  });

  it('a retry adopts what a crashed try wrote, and writes no second audit row', async () => {
    const rows = [row('risk', 1, 'plan_risk', RISK)];
    const { service, runs, plans, completed } = build(rows);
    runs.addPlanRisk.mockResolvedValue({ created: true, adopted: true });
    await service.confirm(user, 'run-1', all(rows));
    expect(completed[0]).toMatchObject({ outcome: 'executed', audit: { adopted: true } });
    expect(plans.auditChange).not.toHaveBeenCalled();
  });

  it('a card field outside the human form is refused before anything is saved', async () => {
    const rows = [row('risk', 1, 'plan_risk', RISK), row('sh', 2, 'plan_stakeholder', SH), row('dates', 3, 'plan_dates', DATES)];
    const { service } = build(rows);
    const edit = (id: string, fields: Row) => service.patch(user, 'run-1', [{ actionId: id, version: 1, fields }]);
    await expect(edit('risk', { probability: 6 })).rejects.toThrow(/Invalid value for probability/);
    await expect(edit('risk', { probability: 2.5 })).rejects.toThrow(/Invalid value/);
    await expect(edit('risk', { budget: 1 })).rejects.toThrow(/Unknown field budget/);
    await expect(edit('sh', { attitude: 'angry' })).rejects.toThrow(/Invalid value for attitude/);
    await expect(edit('sh', { power: 11 })).rejects.toThrow(/Invalid value for power/);
    await expect(edit('dates', { start: 'tomorrow' })).rejects.toThrow(/Invalid value for start/);
    await expect(edit('dates', { title: 'x' })).rejects.toThrow(/Unknown field title/);
  });
});
