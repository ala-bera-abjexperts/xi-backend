/**
 * Robert 1.23: the cards of what Robert suggests a plan lacks. Every value is checked as the invoker
 * against the plan's own data (one graph read per plan), and dates come from the server alone.
 */
import type { ChatAccessService } from '../chat/chat-access.service';
import type { ChatConversationsService } from '../chat/chat-conversations.service';
import type { FieldGroupsService } from '../custom-fields/field-groups.service';
import type { OrganizationModulesService } from '../organization-modules/organization-modules.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { TaskHierarchyConfigService } from '../task-hierarchy-config/task-hierarchy-config.service';
import type { TaskPrioritiesService } from '../task-priorities/task-priorities.service';
import type { TaskStatusesService } from '../task-statuses/task-statuses.service';
import type { WorkflowAssignmentsService } from '../workflow-assignments/workflow-assignments.service';
import type { AgentPlansService, ProductPlanRow } from './agent-plans.service';
import {
  type AgentFieldView,
  type AgentPlanDatesPlan,
  type AgentPlanDependencyPlan,
  type AgentPlanRiskPlan,
  type AgentPlanStakeholderPlan,
  type AgentResolveBatch,
  AgentResolverService,
  type AgentStoredIntent,
  reaches,
  siblingOf,
} from './agent-resolver.service';
import { materialOf } from './agent-action-executor.service';
import type { AgentRunsRepository } from './agent-runs.repository';

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const run = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, value: unknown) => {
        if (!col.includes('.')) filters.push((row) => row[col] === value);
        return q;
      },
      is: (col: string, value: unknown) => {
        filters.push((row) => (row[col] ?? null) === value);
        return q;
      },
      in: (col: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[col]));
        return q;
      },
      or: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve),
    };
    return q;
  };
  return { from };
}

const ME = '00000000-0000-4000-8000-000000000001';
const ANNA = '00000000-0000-4000-8000-000000000002';
const AMBER = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const Q4 = '20000000-0000-4000-8000-000000000001';
const Q4B = '20000000-0000-4000-8000-000000000002';
const OLD = '20000000-0000-4000-8000-000000000003';
const DONE = '20000000-0000-4000-8000-000000000004';
const VIEW_ONLY = '20000000-0000-4000-8000-000000000005';
const HIDDEN_SPACE = '10000000-0000-4000-8000-000000000009';

const person = { said: null, participant: null, is_requester: false };
const date = { said: null, iso: null };
const intent = (over: Partial<AgentStoredIntent> & Row = {}): AgentStoredIntent =>
  ({
    ref: 'i1',
    kind: 'plan_item',
    title: 'Pen test done',
    description: null,
    sources: ['m1'],
    space: null,
    type: null,
    status: null,
    priority: { said: null, level: 'none' },
    assignee: person,
    due: date,
    labels: [],
    parent: { item: null, key: null, said: null },
    asset_type: [],
    facts: [],
    owner: person,
    parent_page: null,
    page_type: null,
    publish: false,
    general_knowledge: false,
    revises: false,
    body: [],
    plan: 'Q4 Security',
    milestone: false,
    start: date,
    end: date,
    ...over,
  }) as AgentStoredIntent;

const plan = (over: Partial<ProductPlanRow>): ProductPlanRow => ({
  id: Q4,
  plan_key: 'AMBER-P1',
  name: 'Q4 Security',
  space_id: AMBER,
  status: 'active',
  is_archived: false,
  start_date: '2026-10-01',
  end_date: '2026-12-31',
  currency: 'EUR',
  ...over,
});


const item = (task_id: string, key: string, summary: string, over: Row = {}) => ({
  link_id: `l-${task_id}`,
  task_id,
  key,
  summary,
  item_type: 'task',
  start_date: null,
  end_date: null,
  duration: null,
  estimated_time: null,
  parent_task_id: null,
  robert: true,
  ...over,
});

describe('AgentResolverService: suggestions for an existing plan (1.23)', () => {
  let editable: ProductPlanRow[];
  let all: ProductPlanRow[];
  let admin: Set<string>;
  let graphs: Record<string, { items: Row[]; edges: Row[] }>;
  let tables: Record<string, Row[]>;
  let perms: Record<string, jest.Mock>;
  let runs: Record<string, jest.Mock>;
  let service: AgentResolverService;
  let batch: AgentResolveBatch;
  let rpcCalls: number;

  const field = (fields: AgentFieldView[], key: string) => fields.find((f) => f.key === key) as AgentFieldView;
  type Kind = 'plan_dependency' | 'plan_dates' | 'plan_risk' | 'plan_stakeholder' | 'plan_baseline';
  const resolve = (kind: Kind, over: Partial<AgentStoredIntent> & Row = {}, overrides: Row = {}) =>
    service.resolve(batch, { kind, intent: intent({ kind, plan: 'AMBER-P1', reason: 'Pen test waits for the build [m2]', ...over }), overrides, dependsOn: null });

  beforeEach(() => {
    all = [
      plan({ start_date: '2026-12-01', end_date: '2027-02-26' }),
      plan({ id: OLD, plan_key: 'AMBER-P2', name: 'Old plan', status: 'archived', is_archived: true }),
      plan({ id: DONE, plan_key: 'AMBER-P3', name: 'Finished plan', status: 'completed' }),
      plan({ id: VIEW_ONLY, plan_key: 'AMBER-P4', name: 'Look only' }),
    ];
    editable = all.filter((p) => p.id !== VIEW_ONLY);
    admin = new Set([Q4]);
    graphs = {
      [Q4]: {
        items: [
          item('build', 'AMBER-T1', 'Build', { start_date: '2026-12-01', end_date: '2026-12-11', robert: false }),
          item('pen', 'AMBER-T2', 'Pen test', { estimated_time: 16 * 60 }),
          item('report', 'AMBER-T3', 'Report', { estimated_time: 8 * 60 }),
          item('mine', 'AMBER-T4', 'Person item', { robert: false, estimated_time: 480 }),
          item('lone', 'AMBER-T5', 'Lonely'),
          item('late', 'AMBER-T6', 'Late', { estimated_time: 480 * 70 }),
        ],
        edges: [
          { id: 'e1', source: 'report', target: 'late', type: 'Finish to Start' },
          { id: 'e0', source: 'build', target: 'pen', type: 'Finish to Start' },
        ],
      },
      [DONE]: { items: [], edges: [] },
    };
    rpcCalls = 0;
    const plans = {
      editablePlans: jest.fn((_a: unknown, _s: unknown, level?: string) => Promise.resolve(level === 'view' ? all : editable)),
      planById: jest.fn((_actor: unknown, id: string) => Promise.resolve(all.find((p) => p.id === id) ?? null)),
      canDelete: jest.fn((_actor: unknown, p: ProductPlanRow) => Promise.resolve(admin.has(p.id))),
      findItems: jest.fn().mockResolvedValue([]),
    };
    Object.defineProperty(plans, 'available', { value: true });
    perms = {
      isAdminOrOwner: jest.fn().mockResolvedValue(false),
      getUserSpacePermissions: jest.fn((userId: string, _o: string, spaceId: string) =>
        Promise.resolve({ isMember: spaceId === AMBER && userId !== ANNA, permissions: { create_tasks: true, view_tasks: true } }),
      ),
    };
    tables = {
      spaces: [{ id: AMBER, organization_id: 'org-1', key: 'AMBER', name: 'Amber', is_archived: false }],
      space_members: [{ space_id: AMBER, is_active: true }],
      organization_members: [ME, ANNA].map((user_id) => ({ organization_id: 'org-1', user_id })),
      users: [ME, ANNA].map((id) => ({ id, is_active: true })),
      chat_members: [ME, ANNA].map((user_id) => ({ conversation_id: 'conv-1', organization_id: 'org-1', user_id })),
      plan_risks: [{ plan_id: Q4, name: 'Supplier delay' }],
      plan_stakeholders: [{ plan_id: Q4, name: 'CISO' }],
      holiday_schemes: [],
      holiday_scheme_days: [],
    };
    const db = fakeDb(tables);
    runs = { findMembers: jest.fn().mockResolvedValue([]) };
    service = new AgentResolverService(
      {
        getClient: () => ({
          from: db.from,
          rpc: (fn: string, args: { p_plan_id: string }) => {
            rpcCalls++;
            return Promise.resolve({ data: fn === 'agent_plan_graph' ? (graphs[args.p_plan_id] ?? { items: [], edges: [] }) : null, error: null });
          },
        }),
      } as unknown as SupabaseAdminService,
      perms as unknown as PermissionsService,
      { canViewSpace: jest.fn().mockResolvedValue(true) } as unknown as ChatAccessService,
      {
        loadUsers: jest.fn((ids: string[]) =>
          Promise.resolve(new Map(ids.map((id) => [id, { id, name: id === ANNA ? 'Anna Berg' : 'Me', email: null }]))),
        ),
      } as unknown as ChatConversationsService,
      {} as unknown as TaskHierarchyConfigService,
      {} as unknown as WorkflowAssignmentsService,
      {} as unknown as TaskStatusesService,
      {} as unknown as TaskPrioritiesService,
      {} as unknown as FieldGroupsService,
      {
        isEnabled: jest.fn().mockResolvedValue(true),
        getEnabledSpaceIds: jest.fn().mockResolvedValue([AMBER, OTHER]),
      } as unknown as OrganizationModulesService,
      runs as unknown as AgentRunsRepository,
      undefined,
      undefined,
      undefined,
      undefined,
      plans as unknown as AgentPlansService,
    );
    batch = service.batch({
      invoker: { userId: ME, organizationId: 'org-1' },
      conversation: { id: 'conv-1', kind: 'group', space_id: null },
      timezone: 'Europe/Vienna',
      now: new Date('2026-11-13T08:00:00Z'),
    });
  });

  describe('a suggested dependency', () => {
    const dep = (pred: string, succ: string, type = 'finish_to_start'): Row => ({
      predecessor: { key: pred, said: null },
      successor: { key: succ, said: null },
      dependency_type: type,
    });

    it('both ends, the type and the reason; Confirm writes exactly that', async () => {
      const r = await resolve('plan_dependency', dep('AMBER-T1', 'AMBER-T3'));
      expect(r.confirmable).toBe(true);
      expect(r.title).toBe('AMBER-T1 Build → AMBER-T3 Report');
      // Run handles mean nothing to a person: they go.
      expect(field(r.fields, 'reason').value).toBe('Pen test waits for the build');
      expect(r.create as AgentPlanDependencyPlan).toMatchObject({
        kind: 'plan_dependency', planId: Q4, sourceTaskId: 'build', targetTaskId: 'report', type: 'finish_to_start',
      });
    });

    it('never to itself, never between two items already linked (either way), never a circle', async () => {
      expect(field((await resolve('plan_dependency', dep('AMBER-T2', 'AMBER-T2'))).fields, 'dependency').code).toBe('dependency_self');
      expect(field((await resolve('plan_dependency', dep('AMBER-T6', 'AMBER-T3'))).fields, 'dependency').code).toBe('dependency_exists');
      // late → report closes nothing (report → late exists, so late → x → report would)
      graphs[Q4].edges.push({ id: 'e2', source: 'late', target: 'pen', type: 'Start to Start' });
      const cycle = await resolve('plan_dependency', dep('AMBER-T2', 'AMBER-T3'));
      expect(field(cycle.fields, 'dependency').code).toBe('dependency_cycle');
      expect(cycle.confirmable).toBe(false);
      expect(cycle.create).toBeNull();
    });

    it('a circle with an earlier suggestion of the same answer refuses only the second', async () => {
      const first = await resolve('plan_dependency', dep('AMBER-T1', 'AMBER-T3'));
      batch.siblings.set(1, siblingOf(1, 'plan_dependency', first));
      const second = await resolve('plan_dependency', dep('AMBER-T3', 'AMBER-T1'));
      expect(first.confirmable).toBe(true);
      expect(field(second.fields, 'dependency').code).toBe('dependency_cycle');
    });

    it('an unclear type is asked, an item not in the plan is asked', async () => {
      const unclear = await resolve('plan_dependency', dep('AMBER-T1', 'AMBER-T3', 'unclear'));
      expect(field(unclear.fields, 'dependencyType')).toMatchObject({ state: 'needs_input', code: 'dependency_type_unclear' });
      const chosen = await resolve('plan_dependency', dep('AMBER-T1', 'AMBER-T3', 'unclear'), { dependencyType: 'start_to_start' });
      expect((chosen.create as AgentPlanDependencyPlan).type).toBe('start_to_start');
      const missing = await resolve('plan_dependency', dep('AMBER-T1', 'OTHER-T9'));
      expect(field(missing.fields, 'successor')).toMatchObject({ state: 'needs_input', code: 'dependency_not_in_plan' });
    });

    it('a plan the invoker may only view, or an archived one: refused; a completed one warns', async () => {
      expect(field((await resolve('plan_dependency', { ...dep('AMBER-T1', 'AMBER-T2'), plan: 'AMBER-P4' })).fields, 'plan').code).toBe('no_edit_plan');
      expect(field((await resolve('plan_risk', { title: 'X', plan: 'AMBER-P4' })).fields, 'plan').code).toBe('no_edit_plan');
      expect(field((await resolve('plan_dependency', { ...dep('AMBER-T1', 'AMBER-T2'), plan: 'AMBER-P2' })).fields, 'plan').code).toBe('plan_archived');
      const done = await resolve('plan_risk', { title: 'Late audit', plan: 'AMBER-P3' });
      expect(field(done.fields, 'plan')).toMatchObject({ state: 'check', code: 'plan_state' });
      expect(done.confirmable).toBe(true);
    });
  });

  describe('suggested dates (worked out by the server)', () => {
    const dates = (key: string) => resolve('plan_dates', { task: { key, said: null }, reason: null });

    it("Robert's undated item: after Build ends, 16 h = 2 working days, and where each date comes from", async () => {
      const r = await dates('AMBER-T2');
      expect(r.confirmable).toBe(true);
      expect(r.create as AgentPlanDatesPlan).toMatchObject({ kind: 'plan_dates', taskId: 'pen', start: '2026-12-14', end: '2026-12-15', duration: 1 });
      expect((field(r.fields, 'source').value as { kind: string }[]).map((s) => s.kind)).toEqual(['after_end', 'estimate']);
      expect(field(r.fields, 'source').params).toEqual({ holidays: 0 });
    });

    it("D3: a person's item is shown, never written; D1: an item with dates is left; nothing to base on", async () => {
      const person = await dates('AMBER-T4');
      expect(field(person.fields, 'dates').code).toBe('person_item');
      expect(field(person.fields, 'start').value).toBe('2026-12-01');
      expect(person.confirmable).toBe(false);
      expect(person.create).toBeNull();
      expect(field((await dates('AMBER-T1')).fields, 'dates').code).toBe('has_dates');
      expect(field((await dates('AMBER-T5')).fields, 'dates').code).toBe('nothing_to_base');
    });

    it('a date that relies on a dependency card of the same answer says so, and changes without it at Confirm', async () => {
      const depCard = await resolve('plan_dependency', {
        predecessor: { key: 'AMBER-T2', said: null },
        successor: { key: 'AMBER-T3', said: null },
        dependency_type: 'finish_to_start',
      });
      batch.siblings.set(4, siblingOf(4, 'plan_dependency', depCard));
      const withDep = await dates('AMBER-T3');
      expect(field(withDep.fields, 'waits')).toMatchObject({ state: 'check', code: 'waits_for_card', value: [4] });
      expect((withDep.create as AgentPlanDatesPlan).start).toBe('2026-12-16');
      expect(withDep.confirmable).toBe(true);
      // Confirmed alone, without that card: worked out again, and the card no longer matches (409).
      batch.siblings.delete(4);
      batch.memo.clear();
      const alone = await dates('AMBER-T3');
      expect((alone.create as AgentPlanDatesPlan).start).toBe('2026-12-01');
      expect(materialOf(alone)).not.toBe(materialOf(withDep));
    });

    it('the dependency confirmed first, then the dates: the same card, no second edge and no 409', async () => {
      const depCard = await resolve('plan_dependency', {
        predecessor: { key: 'AMBER-T2', said: null },
        successor: { key: 'AMBER-T3', said: null },
        dependency_type: 'finish_to_start',
      });
      batch.siblings.set(4, siblingOf(4, 'plan_dependency', depCard));
      const proposed = await dates('AMBER-T3');
      // Confirmed: the row exists now, and the card is still a sibling of the run.
      graphs[Q4].edges.push({ id: 'e9', source: 'pen', target: 'report', type: 'Finish to Start' });
      batch.memo.clear();
      const atConfirm = await dates('AMBER-T3');
      expect((field(atConfirm.fields, 'source').value as { kind: string }[]).filter((s) => s.kind === 'after_end')).toHaveLength(1);
      expect(materialOf(atConfirm)).toBe(materialOf(proposed));
    });

    it('D7: outside the plan range only warns; dates changed on the card are what is written', async () => {
      const late = await dates('AMBER-T6');
      expect(field(late.fields, 'range')).toMatchObject({ state: 'check', code: 'outside_plan_range' });
      expect(late.confirmable).toBe(true);
      const edited = await service.resolve(batch, {
        kind: 'plan_dates',
        intent: intent({ kind: 'plan_dates', plan: 'AMBER-P1', task: { key: 'AMBER-T2', said: null } }),
        overrides: { start: '2026-12-21', end: '2026-12-22' },
        dependsOn: null,
      });
      expect(edited.create as AgentPlanDatesPlan).toMatchObject({ start: '2026-12-21', end: '2026-12-22', duration: 1 });
      const bad = await service.resolve(batch, {
        kind: 'plan_dates',
        intent: intent({ kind: 'plan_dates', plan: 'AMBER-P1', task: { key: 'AMBER-T2', said: null } }),
        overrides: { start: '2026-12-22', end: '2026-12-21' },
        dependsOn: null,
      });
      expect(field(bad.fields, 'dates').code).toBe('end_before_start');
      expect(bad.confirmable).toBe(false);
    });

    it('one graph read per plan and batch, however many cards (large plans)', async () => {
      for (const k of ['AMBER-T2', 'AMBER-T3', 'AMBER-T4', 'AMBER-T5', 'AMBER-T6']) await dates(k);
      expect(rpcCalls).toBe(1);
    });

    it('which items a "suggest dates" request is about: the undated ones, Robert\'s first, or those named', async () => {
      expect(await service.datesTargets(batch, intent({ kind: 'plan_dates', plan: 'AMBER-P1' }))).toEqual({
        planId: Q4, keys: ['AMBER-T2', 'AMBER-T3', 'AMBER-T5', 'AMBER-T6', 'AMBER-T4'], items: 6,
      });
      expect((await service.datesTargets(batch, intent({ kind: 'plan_dates', plan: 'AMBER-P1', dates_for: ['amber-t2', 'AMBER-T2'] })))?.keys).toEqual(['AMBER-T2']);
      expect(await service.datesTargets(batch, intent({ kind: 'plan_dates', plan: 'AMBER-P3' }))).toMatchObject({ keys: [], items: 0 });
      expect(await service.datesTargets(batch, intent({ kind: 'plan_dates', plan: 'nope' }))).toBeNull();
    });
  });

  describe('a suggested risk', () => {
    // Values the model may send outside the schema's types: the card has to cope (never trusted).
    const risk = (over: Row = {}) => ({ risk_type: 'risk', category: 'Schedule', probability: 4, impact: 5, mitigation: 'Second supplier', contingency: null, ...over }) as never;

    it('the values of the human form, as said; none said is the form default and says so', async () => {
      const r = await resolve('plan_risk', { title: 'Vendor late', description: 'The vendor may slip', risk: risk({ impact: null }) });
      expect(r.confirmable).toBe(true);
      expect(field(r.fields, 'impact')).toMatchObject({ state: 'check', code: 'default_value', value: 3 });
      expect(r.create as AgentPlanRiskPlan).toMatchObject({
        kind: 'plan_risk', planId: Q4, name: 'Vendor late', probability: 4, impact: 3, category: 'Schedule', mitigation: 'Second supplier', ownerId: null,
      });
    });

    it('a value outside the scale is asked, never clamped; the same name in the plan is refused (D4)', async () => {
      const r = await resolve('plan_risk', { title: 'Vendor late', risk: risk({ probability: 7 }) });
      expect(field(r.fields, 'probability')).toMatchObject({ state: 'needs_input', code: 'out_of_scale', said: '7' });
      expect(r.confirmable).toBe(false);
      const dup = await resolve('plan_risk', { title: '  supplier DELAY ', risk: risk() });
      expect(field(dup.fields, 'title')).toMatchObject({ state: 'blocked', code: 'same_name_in_plan' });
      expect(dup.confirmable).toBe(false);
    });

    it("an owner who is not an active member of the plan's space: the card asks", async () => {
      const r = await resolve('plan_risk', { title: 'Vendor late', risk: risk(), assignee: { said: 'Anna', participant: 'P2', is_requester: false, user_id: ANNA } });
      expect(field(r.fields, 'assignee')).toMatchObject({ state: 'needs_input', code: 'not_space_member' });
      expect(r.confirmable).toBe(false);
    });
  });

  describe('a suggested stakeholder', () => {
    const sh = (over: Row = {}) => ({ role: 'Approver', organization: 'IT', email: null, power: 9, interest: 6, attitude: 'supportive', engagement: 'Weekly update', ...over }) as never;

    it('a name only when no user is certain; the scales and attitude of the human form', async () => {
      const r = await resolve('plan_stakeholder', { title: 'Data protection officer', stakeholder: sh() });
      expect(r.confirmable).toBe(true);
      expect(field(r.fields, 'assignee')).toMatchObject({ state: 'check', code: 'name_only' });
      expect(r.create as AgentPlanStakeholderPlan).toMatchObject({ kind: 'plan_stakeholder', name: 'Data protection officer', power: 9, interest: 6, attitude: 'supportive', linkedUserId: null });
      const bad = await resolve('plan_stakeholder', { title: 'DPO', stakeholder: sh({ power: 11, attitude: 'angry', email: 'not an email' }) });
      expect(field(bad.fields, 'power').code).toBe('out_of_scale');
      expect(field(bad.fields, 'attitude').code).toBe('out_of_scale');
      expect(field(bad.fields, 'email').code).toBe('invalid_email');
      expect(bad.confirmable).toBe(false);
    });

    it('matched to the one user of that exact name who works in the space', async () => {
      runs.findMembers.mockResolvedValue([{ user_id: ME, full_name: 'Me Myself', email: 'me@x', exact: true }]);
      const r = await resolve('plan_stakeholder', { title: 'Me Myself', stakeholder: sh() });
      expect((r.create as AgentPlanStakeholderPlan).linkedUserId).toBe(ME);
      expect(field((await resolve('plan_stakeholder', { title: 'ciso', stakeholder: sh() })).fields, 'title').code).toBe('same_name_in_plan');
    });
  });

  describe('a baseline on request', () => {
    it('D6: no name, the card asks; never invented', async () => {
      const r = await resolve('plan_baseline', { title: '', reason: null });
      expect(field(r.fields, 'title')).toMatchObject({ state: 'needs_input', code: 'baseline_name' });
      expect(r.confirmable).toBe(false);
    });

    it('the plan, the name and how many items it holds; the human rule: plan admin', async () => {
      const r = await resolve('plan_baseline', { title: 'Before pen test', reason: null });
      expect(r.create).toMatchObject({ kind: 'plan_baseline', planId: Q4, name: 'Before pen test', items: 6 });
      expect(field(r.fields, 'items').value).toBe(6);
      admin.clear();
      const no = await resolve('plan_baseline', { title: 'Before pen test', reason: null });
      expect(field(no.fields, 'plan').code).toBe('no_baseline_right');
      expect(no.confirmable).toBe(false);
    });
  });

  it('reaches: the cycle check over edges', () => {
    expect(reaches([['a', 'b'], ['b', 'c']], 'a', 'c')).toBe(true);
    expect(reaches([['a', 'b'], ['b', 'c']], 'c', 'a')).toBe(false);
  });
});
