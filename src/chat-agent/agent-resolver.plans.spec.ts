/**
 * Robert 1.22 (ROB-08): the cards of a new plan and of a plan item. Everything on them comes from
 * a lookup as the invoker, never from the model.
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
  type AgentPlanItemPlan,
  type AgentProductPlan,
  type AgentResolveBatch,
  AgentResolverService,
  type AgentStoredIntent,
  siblingOf,
} from './agent-resolver.service';
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

describe('AgentResolverService: plans and plan items (1.22)', () => {
  let editable: ProductPlanRow[];
  let all: ProductPlanRow[];
  let items: { taskId: string; key: string | null; summary: string; itemType: string }[];
  let plans: Record<string, jest.Mock>;
  let perms: Record<string, jest.Mock>;
  let service: AgentResolverService;
  let batch: AgentResolveBatch;

  const field = (fields: AgentFieldView[], key: string) => fields.find((f) => f.key === key) as AgentFieldView;
  const resolve = (kind: 'plan' | 'plan_item' | 'plan_link', over: Partial<AgentStoredIntent> & Row = {}, overrides: Row = {}, dependsOn: number | null = null) =>
    service.resolve(batch, { kind, intent: intent({ kind, ...over }), overrides, dependsOn });

  beforeEach(() => {
    all = [
      plan({}),
      plan({ id: Q4B, plan_key: 'OTHER-P1', space_id: OTHER, name: 'Q4 Security' }),
      plan({ id: OLD, plan_key: 'AMBER-P2', name: 'Old plan', status: 'archived', is_archived: true }),
      plan({ id: DONE, plan_key: 'AMBER-P3', name: 'Finished plan', status: 'completed' }),
      plan({ id: VIEW_ONLY, plan_key: 'AMBER-P4', name: 'Look only' }),
    ];
    editable = all.filter((p) => p.id !== VIEW_ONLY);
    items = [
      { taskId: 'task-phase', key: 'AMBER-T1', summary: 'Build', itemType: 'phase' },
      { taskId: 'task-go', key: 'AMBER-T2', summary: 'Go-live', itemType: 'milestone' },
    ];
    plans = {
      editablePlans: jest.fn(() => Promise.resolve(editable)),
      planById: jest.fn((_actor: unknown, id: string) => Promise.resolve(all.find((p) => p.id === id) ?? null)),
      findItems: jest.fn((_plan: string, words: string) =>
        Promise.resolve(items.filter((i) => i.key === words.toUpperCase() || i.summary.toLowerCase() === words.toLowerCase())),
      ),
      canCreateIn: jest.fn((_actor: unknown, spaceId: string) => Promise.resolve(spaceId === AMBER)),
    };
    Object.defineProperty(plans, 'available', { value: true });
    perms = {
      isAdminOrOwner: jest.fn().mockResolvedValue(false),
      getUserSpacePermissions: jest.fn((_u: string, _o: string, spaceId: string) =>
        Promise.resolve({ isMember: spaceId !== HIDDEN_SPACE, permissions: { create_tasks: true, view_tasks: true } }),
      ),
    };
    const tables: Record<string, Row[]> = {
      spaces: [
        { id: AMBER, organization_id: 'org-1', key: 'AMBER', name: 'Amber', is_archived: false },
        { id: OTHER, organization_id: 'org-1', key: 'OTHER', name: 'Other', is_archived: false },
      ],
      space_members: [{ space_id: AMBER, is_active: true }, { space_id: OTHER, is_active: true }],
      organization_members: [ME, ANNA].map((user_id) => ({ organization_id: 'org-1', user_id })),
      users: [ME, ANNA].map((id) => ({ id, is_active: true })),
      chat_members: [ME, ANNA].map((user_id) => ({ conversation_id: 'conv-1', organization_id: 'org-1', user_id })),
      // 1.22.1: existing tasks a link may name.
      tasks: [
        { id: 'task-x', key: 'AMBER-T9', summary: 'Vendor review', organization_id: 'org-1', space_id: AMBER, parent_task_id: null, start_date: '2026-11-02', end_date: '2026-11-20', assigned_to: ANNA, status_id: 'st-open' },
        { id: 'task-done', key: 'AMBER-T10', summary: 'Old audit', organization_id: 'org-1', space_id: AMBER, parent_task_id: null, start_date: null, end_date: null, assigned_to: null, status_id: 'st-done' },
        { id: 'task-sub', key: 'AMBER-T11', summary: 'A subtask', organization_id: 'org-1', space_id: AMBER, parent_task_id: 'task-x', start_date: null, end_date: null, assigned_to: null, status_id: 'st-open' },
        { id: 'task-other', key: 'OTHER-T1', summary: 'Elsewhere', organization_id: 'org-1', space_id: OTHER, parent_task_id: null, start_date: null, end_date: null, assigned_to: null, status_id: 'st-open' },
        { id: 'task-hidden', key: 'HR-T1', summary: 'Salary secret', organization_id: 'org-1', space_id: HIDDEN_SPACE, parent_task_id: null, start_date: null, end_date: null, assigned_to: null, status_id: 'st-open' },
        { id: 'task-phase', key: 'AMBER-T1', summary: 'Build', organization_id: 'org-1', space_id: AMBER, parent_task_id: null, start_date: '2026-11-01', end_date: '2026-11-30', assigned_to: null, status_id: 'st-open' },
      ],
      plan_tasks: [
        { id: 'pt-1', plan_id: Q4, task_id: 'task-phase' },
        { id: 'pt-2', plan_id: Q4, task_id: 'task-go' },
        { id: 'pt-3', plan_id: DONE, task_id: 'task-x' },
      ],
      plans: [{ id: DONE, plan_key: 'AMBER-P3', name: 'Finished plan' }],
      task_statuses: [
        { id: 'st-open', is_completed: false, category: { is_done_like: false } },
        { id: 'st-done', is_completed: true, category: { is_done_like: true } },
      ],
    };
    const db = fakeDb(tables);
    service = new AgentResolverService(
      { getClient: () => ({ from: db.from }) } as unknown as SupabaseAdminService,
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
      { findMembers: jest.fn().mockResolvedValue([]) } as unknown as AgentRunsRepository,
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
      now: new Date('2026-10-22T08:00:00Z'),
    });
  });

  describe('a plan item', () => {
    it('ROB-08 AC-1: the plan by name, the milestone and its date, all validated', async () => {
      // Two plans of that name: one picker, never a guess (BR-1, G4).
      const twice = await resolve('plan_item', { milestone: true, start: { said: '15 Oct', iso: '2026-10-15' } });
      expect(field(twice.fields, 'plan')).toMatchObject({ state: 'needs_input', code: 'ambiguous_plan' });
      expect(field(twice.fields, 'plan').options?.map((o) => o.value)).toEqual([Q4, Q4B]);
      expect(twice.confirmable).toBe(false);

      const r = await resolve('plan_item', { plan: 'AMBER-P1', milestone: true, start: { said: null, iso: '2026-10-15' } });
      expect(field(r.fields, 'plan')).toMatchObject({ state: 'ok', value: Q4, display: 'AMBER-P1 Q4 Security' });
      expect(field(r.fields, 'itemType').value).toBe('milestone');
      const create = r.create as AgentPlanItemPlan;
      expect(create).toMatchObject({ kind: 'plan_item', planId: Q4, spaceId: AMBER, itemType: 'milestone' });
      expect([create.startDate, create.endDate]).toEqual(['2026-10-15', '2026-10-15']);
      expect(r.confirmable).toBe(true);
    });

    it('ROB-08 AC-2: an end before the start stops Confirm', async () => {
      const r = await resolve('plan_item', {
        plan: 'AMBER-P1',
        start: { said: null, iso: '2026-11-20' },
        end: { said: null, iso: '2026-11-10' },
      });
      expect(field(r.fields, 'end')).toMatchObject({ state: 'needs_input', code: 'end_before_start' });
      expect(r.confirmable).toBe(false);
    });

    it('BR-2: a date outside the plan only warns, it is not moved', async () => {
      const r = await resolve('plan_item', { plan: 'AMBER-P1', start: { said: null, iso: '2027-01-15' } });
      expect(field(r.fields, 'start')).toMatchObject({
        state: 'check',
        code: 'outside_plan_range',
        value: '2027-01-15',
        params: { start: '2026-10-01', end: '2026-12-31' },
      });
      expect(r.confirmable).toBe(true);
    });

    it('a milestone has exactly one date', async () => {
      const two = await resolve('plan_item', {
        plan: 'AMBER-P1',
        milestone: true,
        start: { said: null, iso: '2026-11-01' },
        end: { said: null, iso: '2026-11-03' },
      });
      expect(field(two.fields, 'start')).toMatchObject({ state: 'needs_input', code: 'milestone_one_date' });
      const none = await resolve('plan_item', { plan: 'AMBER-P1', milestone: true });
      expect(field(none.fields, 'start')).toMatchObject({ state: 'needs_input', code: 'milestone_one_date' });
      expect(none.confirmable).toBe(false);
    });

    it('in a space channel the one active plan there, when none is named', async () => {
      batch = { ...batch, conversation: { id: 'conv-1', kind: 'space', space_id: AMBER }, memo: new Map() };
      const r = await resolve('plan_item', { plan: null });
      expect(field(r.fields, 'plan')).toMatchObject({ state: 'ok', value: Q4 });
    });

    it('anywhere else, a picker when none is named', async () => {
      const r = await resolve('plan_item', { plan: null });
      expect(field(r.fields, 'plan')).toMatchObject({ state: 'needs_input', code: 'plan_required' });
      // Archived plans are never offered.
      expect(field(r.fields, 'plan').options?.map((o) => o.value)).not.toContain(OLD);
    });

    it('never invents a plan: one nobody can find is a question', async () => {
      const r = await resolve('plan_item', { plan: 'Moonshot' });
      expect(field(r.fields, 'plan')).toMatchObject({ state: 'needs_input', code: 'unknown_plan' });
      expect(r.create).toMatchObject({ planId: null });
    });

    it('an archived plan is refused, a completed one warns', async () => {
      const old = await resolve('plan_item', { plan: 'Old plan' });
      expect(field(old.fields, 'plan')).toMatchObject({ state: 'blocked', code: 'plan_archived' });
      const done = await resolve('plan_item', { plan: 'Finished plan' });
      expect(field(done.fields, 'plan')).toMatchObject({ state: 'check', code: 'plan_state', params: { status: 'completed' } });
      expect(done.confirmable).toBe(true);
    });

    it('a plan in a space with plans switched off says so, instead of "not found"', async () => {
      editable = [...editable, plan({ id: 'p-off', plan_key: 'OFF-P1', space_id: '10000000-0000-4000-8000-000000000009', name: 'Dark plan' })];
      const r = await resolve('plan_item', { plan: 'Dark plan' });
      expect(field(r.fields, 'plan')).toMatchObject({ state: 'blocked', code: 'module_off', value: 'p-off' });
      expect(r.confirmable).toBe(false);
    });

    it('a plan the invoker may only view, named: refused with the reason, it exists for them anyway', async () => {
      plans.editablePlans.mockImplementation((_a: unknown, _s: unknown, level?: string) =>
        Promise.resolve(level === 'view' ? all : editable),
      );
      const r = await resolve('plan_item', { plan: 'Look only' });
      expect(field(r.fields, 'plan')).toMatchObject({ state: 'blocked', code: 'no_edit_plan', value: VIEW_ONLY });
    });

    it('a plan the invoker may only view is refused when picked by id', async () => {
      const r = await resolve('plan_item', {}, { plan: VIEW_ONLY });
      expect(field(r.fields, 'plan')).toMatchObject({ state: 'blocked', code: 'no_edit_plan' });
    });

    it('a parent item of the plan by name; a milestone takes no children; a missing one is asked for', async () => {
      const r = await resolve('plan_item', { plan: 'AMBER-P1', parent: { item: null, key: null, said: 'Build' } });
      expect(field(r.fields, 'parent')).toMatchObject({ state: 'ok', value: 'task-phase' });
      expect((r.create as AgentPlanItemPlan).parentTaskId).toBe('task-phase');

      const under = await resolve('plan_item', { plan: 'AMBER-P1', parent: { item: null, key: 'AMBER-T2', said: null } });
      expect(field(under.fields, 'parent')).toMatchObject({ state: 'needs_input', code: 'milestone_children' });

      const gone = await resolve('plan_item', { plan: 'AMBER-P1', parent: { item: null, key: null, said: 'Nowhere' } });
      expect(field(gone.fields, 'parent')).toMatchObject({ state: 'needs_input', code: 'parent_not_in_plan' });
    });

    it('estimates are numbers within their range, the cost in the plan currency', async () => {
      const r = await resolve('plan_item', { plan: 'AMBER-P1', estimated_hours: 12.5, estimated_cost: 900, progress: 40 } as Row);
      expect(r.create).toMatchObject({ estimatedHours: 12.5, estimatedCost: 900, progress: 40 });
      expect(field(r.fields, 'estimatedCost').params).toEqual({ currency: 'EUR' });

      const bad = await resolve('plan_item', { plan: 'AMBER-P1', estimated_hours: -3, progress: 150 } as Row);
      expect(field(bad.fields, 'estimatedHours')).toMatchObject({ state: 'needs_input', code: 'invalid_number' });
      expect(field(bad.fields, 'progress')).toMatchObject({ state: 'needs_input', code: 'invalid_number' });
      expect(bad.confirmable).toBe(false);
    });

    it('a priority said that matches none is asked about, not dropped; limits on hours and cost (audit 2026-11-10)', async () => {
      const r = await resolve('plan_item', { plan: 'AMBER-P1', priority: { said: 'asap', level: 'none' } } as Row);
      expect(field(r.fields, 'priority')).toMatchObject({ state: 'check', code: 'unknown_priority', said: 'asap', value: null });
      const ok = await resolve('plan_item', { plan: 'AMBER-P1', priority: { said: 'dringend', level: 'high' } } as Row);
      expect(field(ok.fields, 'priority')).toMatchObject({ state: 'ok', value: 'high' });

      const big = await resolve('plan_item', { plan: 'AMBER-P1', estimated_hours: 2_000_000, estimated_cost: 1e11 } as Row);
      expect(field(big.fields, 'estimatedHours')).toMatchObject({ state: 'needs_input', code: 'invalid_number' });
      expect(field(big.fields, 'estimatedCost')).toMatchObject({ state: 'needs_input', code: 'invalid_number' });
    });

    it('in a plan of the same request: waits for it, and its range applies', async () => {
      const newPlan = await resolve('plan', {
        title: 'Launch',
        space: 'Amber',
        plan: null,
        start: { said: null, iso: '2026-11-01' },
        end: { said: null, iso: '2026-11-30' },
      });
      batch.siblings.set(1, siblingOf(1, 'plan', newPlan));
      const r = await resolve('plan_item', { plan: null, start: { said: null, iso: '2026-12-15' } }, {}, 1);
      expect(field(r.fields, 'plan')).toMatchObject({ state: 'ok', params: { ordinal: 1 } });
      expect(r.create).toMatchObject({ planId: null, pendingPlan: 1, spaceId: AMBER });
      expect(field(r.fields, 'start')).toMatchObject({ state: 'check', code: 'outside_plan_range' });
    });
  });

  describe('a new plan', () => {
    it('is always a draft, its type read from plain words', async () => {
      const r = await resolve('plan', { title: 'Q4 Security', space: 'Amber', plan: null, plan_type: 'Scrum', status: 'active' } as Row);
      expect(field(r.fields, 'planType').value).toBe('agile');
      expect(field(r.fields, 'status')).toMatchObject({ state: 'check', code: 'starts_as_draft', value: 'draft' });
      expect(r.create).toMatchObject({ kind: 'plan', spaceId: AMBER, planType: 'agile', name: 'Q4 Security' } as Partial<AgentProductPlan>);
      expect(r.confirmable).toBe(true);
    });

    it('a type nobody knows is asked for', async () => {
      const r = await resolve('plan', { title: 'Q4', space: 'Amber', plan: null, plan_type: 'spiral' } as Row);
      expect(field(r.fields, 'planType')).toMatchObject({ state: 'needs_input', code: 'unknown_plan_type' });
    });

    it('needs create_plans as a member of the space, as a person does: an org admin has no shortcut', async () => {
      perms.isAdminOrOwner.mockResolvedValue(true);
      const r = await resolve('plan', { title: 'Q4', space: 'Other', plan: null });
      expect(field(r.fields, 'space')).toMatchObject({ state: 'blocked', code: 'no_create_plan' });
      expect(r.confirmable).toBe(false);
      // Nor does the picker offer them a space they can't create plans in.
      expect(field(r.fields, 'space').options?.map((o) => o.value)).toEqual([AMBER]);
    });

    it('an end before its start stops Confirm', async () => {
      const r = await resolve('plan', {
        title: 'Q4',
        space: 'Amber',
        plan: null,
        start: { said: null, iso: '2026-12-01' },
        end: { said: null, iso: '2026-11-01' },
      });
      expect(field(r.fields, 'end')).toMatchObject({ state: 'needs_input', code: 'end_before_start' });
    });
  });

  describe('a plan link (1.22.1)', () => {
    const link = (over: Row = {}, overrides: Row = {}) =>
      resolve('plan_link', { title: 'AMBER-T9', plan: 'AMBER-P1', task: { key: 'AMBER-T9', said: null }, ...over }, overrides);

    it('adds an existing task: only the link, its own values shown read-only', async () => {
      const r = await link();
      expect(r.confirmable).toBe(true);
      expect(r.create).toEqual({ kind: 'plan_link', spaceId: AMBER, planId: Q4, taskId: 'task-x', taskKey: 'AMBER-T9', itemType: 'task' });
      expect(field(r.fields, 'task')).toMatchObject({ state: 'ok', value: 'task-x', editable: false });
      expect(field(r.fields, 'start')).toMatchObject({ value: '2026-11-02', editable: false });
      expect(field(r.fields, 'assignee')).toMatchObject({ value: ANNA, editable: false });
      // It is in another plan as well: allowed, and said.
      expect(field(r.fields, 'otherPlans')).toMatchObject({ state: 'ok', params: { plans: 'AMBER-P3 Finished plan' } });
    });

    it('a task nobody may see, or none at all: asked about, never named', async () => {
      for (const key of ['HR-T1', 'AMBER-T404']) {
        const r = await link({ title: key, task: { key, said: null } });
        expect(r.confirmable).toBe(false);
        expect(field(r.fields, 'task')).toMatchObject({ state: 'needs_input', code: 'task_not_found' });
        expect(JSON.stringify(r)).not.toContain('Salary secret');
      }
    });

    it('a task of another space is refused; one in the plan already offers nothing', async () => {
      const other = await link({ title: 'OTHER-T1', task: { key: 'OTHER-T1', said: null } });
      expect(field(other.fields, 'task')).toMatchObject({ state: 'blocked', code: 'task_other_space' });
      const inPlan = await link({ title: 'AMBER-T1', task: { key: 'AMBER-T1', said: null } });
      expect(field(inPlan.fields, 'task')).toMatchObject({ state: 'blocked', code: 'already_in_plan' });
      expect(inPlan.confirmable).toBe(false);
    });

    it('never moves the task: under a phase it is not under, it goes in at top level, and the card says so', async () => {
      const r = await link({ parent: { item: null, key: 'AMBER-T1', said: null } });
      expect(field(r.fields, 'placement')).toMatchObject({ state: 'check', code: 'link_top_level' });
      expect(r.confirmable).toBe(true);
    });

    it('says what stays out and what is unusual: subtasks, a parent outside the plan, a done task', async () => {
      const withSubs = await link();
      expect(field(withSubs.fields, 'subtasks')).toMatchObject({ state: 'check', code: 'subtasks_stay_out', params: { count: 1 } });
      const sub = await link({ title: 'AMBER-T11', task: { key: 'AMBER-T11', said: null } });
      expect(field(sub.fields, 'placement')).toMatchObject({ state: 'check', code: 'link_top_level' });
      const done = await link({ title: 'AMBER-T10', task: { key: 'AMBER-T10', said: null } });
      expect(field(done.fields, 'status')).toMatchObject({ state: 'check', code: 'task_done', editable: false });
    });
  });

  describe('dependencies of a plan item (1.22.1)', () => {
    const dep = (over: Row) => ({ item: null, key: null, said: null, type: 'finish_to_start', this_is: 'successor', words: '', ordinal: null, ...over });
    const item = (depends: Row[], over: Row = {}) => resolve('plan_item', { title: 'Pen test', plan: 'AMBER-P1', depends, ...over } as Row);

    it('the words decide the type, in English and German; the other end an item of the plan', async () => {
      const cases: [string, string][] = [
        ['starts after Build ends', 'finish_to_start'],
        ['startet nach Build', 'finish_to_start'],
        ['starts with Build', 'start_to_start'],
        ['beginnt mit Build', 'start_to_start'],
        ['finishes with Build', 'finish_to_finish'],
        ['endet mit Build', 'finish_to_finish'],
        ["can't finish until Build starts", 'start_to_finish'],
        ['kann erst enden, wenn Build beginnt', 'start_to_finish'],
      ];
      for (const [words, type] of cases) {
        const r = await item([dep({ key: 'AMBER-T1', words, type: 'unclear' })]);
        expect([words, field(r.fields, 'dependency:0').state]).toEqual([words, 'ok']);
        expect((r.create as AgentPlanItemPlan).dependencies).toEqual([
          { type, thisIs: 'successor', otherTaskId: 'task-phase', otherOrdinal: null },
        ]);
      }
    });

    it('words that say no type are asked about, never guessed', async () => {
      const r = await item([dep({ key: 'AMBER-T1', words: 'Pen test and Build belong together', type: 'finish_to_start' })]);
      expect(field(r.fields, 'dependency:0')).toMatchObject({ state: 'needs_input', code: 'dependency_type_unclear' });
      expect(r.confirmable).toBe(false);
      const answered = await resolve('plan_item', { title: 'Pen test', plan: 'AMBER-P1', depends: [dep({ key: 'AMBER-T1', words: 'belong together' })] } as Row, { 'dependency:0': 'start_to_start' });
      expect((answered.create as AgentPlanItemPlan).dependencies?.[0]).toMatchObject({ type: 'start_to_start' });
    });

    it('refuses an end outside the plan, or the item itself; the item still goes', async () => {
      const r = await item([
        dep({ key: 'OTHER-T1', words: 'after Elsewhere ends' }),
        dep({ item: 'i1', ordinal: null, words: 'after itself ends' }),
      ]);
      expect(field(r.fields, 'dependency:0')).toMatchObject({ state: 'check', code: 'dependency_not_in_plan' });
      expect(field(r.fields, 'dependency:1')).toMatchObject({ state: 'check', code: 'dependency_self' });
      expect(r.confirmable).toBe(true);
      expect((r.create as AgentPlanItemPlan).dependencies).toEqual([]);
    });

    // Found by Postman folder 17: "add T9 to the plan, and a task after T9 ends" names T9 by key, and
    // T9 is only linked by a card of the same answer: that card is the other end.
    it('a key of a task linked by a card of the same answer is that card', async () => {
      batch.siblings.set(1, siblingOf(1, 'plan_link', {
        title: 'Vendor review',
        create: { kind: 'plan_link', spaceId: AMBER, planId: Q4, taskId: 'task-x', taskKey: 'AMBER-T9', itemType: 'task' },
      }));
      const r = await item([dep({ key: 'amber-t9', words: 'starts after AMBER-T9 ends' })]);
      expect(field(r.fields, 'dependency:0')).toMatchObject({ state: 'ok', value: 'finish_to_start' });
      expect((r.create as AgentPlanItemPlan).dependencies).toEqual([
        { type: 'finish_to_start', thisIs: 'successor', otherTaskId: null, otherOrdinal: 1 },
      ]);
    });

    it('dates that break it only warn (the human Gantt neither warns nor moves anything)', async () => {
      const r = await item([dep({ key: 'AMBER-T1', words: 'starts after Build ends' })], {
        start: { said: null, iso: '2026-11-10' },
        end: { said: null, iso: '2026-11-15' },
      });
      expect(field(r.fields, 'dependency:0')).toMatchObject({ state: 'check', code: 'dependency_dates' });
      expect((r.create as AgentPlanItemPlan).dependencies).toHaveLength(1);
    });

    it('an item of this request in the same plan is the other end by its card', async () => {
      batch.siblings.set(2, { ...siblingOf(2, 'plan_item', { title: 'Build 2', fields: [], confirmable: true, create: { kind: 'plan_item', planId: Q4 } } as never) });
      const r = await item([dep({ item: 'i2', ordinal: 2, words: 'after Build 2 ends' })]);
      expect((r.create as AgentPlanItemPlan).dependencies).toEqual([
        { type: 'finish_to_start', thisIs: 'successor', otherTaskId: null, otherOrdinal: 2 },
      ]);
      batch.siblings.set(3, { ...siblingOf(3, 'plan_item', { title: 'Far', fields: [], confirmable: true, create: { kind: 'plan_item', planId: Q4B } } as never) });
      const far = await item([dep({ item: 'i3', ordinal: 3, words: 'after Far ends' })]);
      expect(field(far.fields, 'dependency:0')).toMatchObject({ state: 'check', code: 'dependency_other_plan' });
    });
  });
});
