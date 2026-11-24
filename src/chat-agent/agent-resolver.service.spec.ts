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
import type { AgentCreatePlan } from './agent-resolver.service';
import {
  type AgentFieldView,
  type AgentResolveBatch,
  AgentResolverService,
  type AgentStoredIntent,
  stripMarkup,
  strictDay,
} from './agent-resolver.service';
import type { AgentRunsRepository } from './agent-runs.repository';

type Row = Record<string, unknown>;

/** In-memory tables for the eq / is / in / order / limit / maybeSingle chains the resolver builds. */
function fakeDb(tables: Record<string, Row[]>) {
  const reads: string[] = [];
  const from = (table: string) => {
    reads.push(table);
    const filters: ((row: Row) => boolean)[] = [];
    const run = () =>
      (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    const q: Record<string, unknown> = {
      select: () => q,
      // A column of an embedded table ("spaces.organization_id") is not filtered here.
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
      maybeSingle: () =>
        Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: run(), error: null }).then(resolve),
    };
    return q;
  };
  return { from, reads };
}

const ME = '00000000-0000-4000-8000-000000000001';
const ANNA = '00000000-0000-4000-8000-000000000002';
const RAJ = '00000000-0000-4000-8000-000000000003';
const AMBER = '10000000-0000-4000-8000-000000000001';
const SECRET = '10000000-0000-4000-8000-000000000002';
const READONLY = '10000000-0000-4000-8000-000000000003';

const person = { said: null, participant: null, is_requester: false };
const date = { said: null, iso: null };
const intent = (over: Partial<AgentStoredIntent> = {}): AgentStoredIntent => ({
  ref: 'i1',
  kind: 'task',
  title: 'Push-Crash beheben',
  description: null,
  sources: ['m1'],
  space: 'amber',
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
  plan: null,
  milestone: false,
  start: date,
  end: date,
  ...over,
});

const types = [
  {
    id: 'task',
    name: 'Task',
    parent_level_id: null,
    default_status: 'open',
    default_priority: 'medium',
  },
  {
    id: 'sub_task',
    name: 'Subtask',
    parent_level_id: 'task',
    default_status: 'open',
    default_priority: 'medium',
  },
];

describe('AgentResolverService', () => {
  let tables: Record<string, Row[]>;
  let db: ReturnType<typeof fakeDb>;
  let perms: Record<string, jest.Mock>;
  let access: Record<string, jest.Mock>;
  let hierarchy: Record<string, jest.Mock>;
  let assignments: Record<string, jest.Mock>;
  let fieldGroups: Record<string, jest.Mock>;
  let modules: Record<string, jest.Mock>;
  let runs: Record<string, jest.Mock>;
  let service: AgentResolverService;
  let batch: AgentResolveBatch;

  const field = (fields: AgentFieldView[], key: string) =>
    fields.find((f) => f.key === key) as AgentFieldView;

  const resolve = (
    over: Partial<AgentStoredIntent> = {},
    overrides: Row = {},
    dependsOn: number | null = null,
    kind: 'task' | 'subtask' = 'task',
  ) =>
    service.resolve(batch, {
      kind,
      intent: intent(over),
      overrides,
      dependsOn,
    });

  beforeEach(() => {
    tables = {
      spaces: [
        {
          id: AMBER,
          organization_id: 'org-1',
          key: 'AMBER',
          name: 'Amber',
          is_archived: false,
        },
        {
          id: SECRET,
          organization_id: 'org-1',
          key: 'SEC',
          name: 'Secret',
          is_archived: false,
        },
        {
          id: READONLY,
          organization_id: 'org-1',
          key: 'RO',
          name: 'Readonly',
          is_archived: false,
        },
      ],
      space_members: [
        { space_id: AMBER, is_active: true },
        { space_id: READONLY, is_active: true },
      ],
      organization_members: [ME, ANNA, RAJ].map((user_id) => ({
        organization_id: 'org-1',
        user_id,
      })),
      users: [ME, ANNA, RAJ].map((id) => ({ id, is_active: true })),
      chat_members: [ME, ANNA].map((user_id) => ({
        conversation_id: 'conv-1',
        organization_id: 'org-1',
        user_id,
      })),
      tasks: [
        {
          id: 'task-200',
          organization_id: 'org-1',
          key: 'AMBER-T200',
          summary: 'Push',
          space_id: AMBER,
          task_type_id: 'task',
        },
        {
          id: 'task-300',
          organization_id: 'org-1',
          key: 'RO-T300',
          summary: 'Elsewhere',
          space_id: READONLY,
          task_type_id: 'task',
        },
      ],
      workflows: [],
      custom_fields: [],
    };
    db = fakeDb(tables);
    perms = {
      isAdminOrOwner: jest.fn().mockResolvedValue(false),
      getUserSpacePermissions: jest.fn(
        (userId: string, _org: string, spaceId: string) =>
          Promise.resolve({
            isMember:
              spaceId === AMBER || (spaceId === READONLY && userId === ME),
            permissions: { create_tasks: spaceId === AMBER },
          }),
      ),
    };
    access = { canViewSpace: jest.fn().mockResolvedValue(true) };
    hierarchy = {
      getActiveTypes: jest.fn().mockResolvedValue(types),
      getValidChildTypesFor: jest.fn().mockResolvedValue([types[1]]),
    };
    assignments = {
      findActiveAssignmentForType: jest.fn().mockResolvedValue(null),
    };
    fieldGroups = {
      getLevelFieldsConfiguration: jest
        .fn()
        .mockResolvedValue({ standalone_fields: [], groups: [] }),
    };
    modules = {
      isEnabled: jest.fn().mockResolvedValue(true),
      getEnabledSpaceIds: jest
        .fn()
        .mockResolvedValue([AMBER, SECRET, READONLY]),
    };
    runs = {
      findMembers: jest.fn().mockResolvedValue([]),
      spaceLabels: jest.fn().mockResolvedValue(['ios']),
    };
    service = new AgentResolverService(
      {
        getClient: () => ({ from: db.from }),
      } as unknown as SupabaseAdminService,
      perms as unknown as PermissionsService,
      access as unknown as ChatAccessService,
      {
        loadUsers: jest.fn((ids: string[]) =>
          Promise.resolve(
            new Map(
              ids.map((id) => [
                id,
                {
                  id,
                  name: id === ANNA ? 'Anna Berg' : 'Someone',
                  email: null,
                },
              ]),
            ),
          ),
        ),
      } as unknown as ChatConversationsService,
      hierarchy as unknown as TaskHierarchyConfigService,
      assignments as unknown as WorkflowAssignmentsService,
      {
        getAll: jest.fn().mockResolvedValue([
          { id: 'st-open', key: 'open', name: 'Open' },
          { id: 'st-prog', key: 'in_progress', name: 'In Progress' },
        ]),
      } as unknown as TaskStatusesService,
      {
        getAll: jest.fn().mockResolvedValue([
          { id: 'pr-med', key: 'medium', name: 'Medium', space_id: null },
          { id: 'pr-high', key: 'high', name: 'High', space_id: null },
        ]),
      } as unknown as TaskPrioritiesService,
      fieldGroups as unknown as FieldGroupsService,
      modules as unknown as OrganizationModulesService,
      runs as unknown as AgentRunsRepository,
    );
    batch = service.batch({
      invoker: { userId: ME, organizationId: 'org-1' },
      conversation: { id: 'conv-1', kind: 'group', space_id: null },
      timezone: 'Europe/Vienna',
      now: new Date('2026-10-22T08:00:00Z'), // a Thursday
    });
  });

  it('resolves a complete request: every id from a lookup, nothing from the model', async () => {
    const r = await resolve({
      priority: { said: 'high priority', level: 'high' },
      assignee: {
        said: 'Anna',
        participant: 'P2',
        is_requester: false,
        user_id: ANNA,
      },
      due: { said: 'by Friday', iso: '2026-10-23' },
      labels: ['ios'],
    });

    expect(r.confirmable).toBe(true);
    expect(r.create).toEqual({
      spaceId: AMBER,
      summary: 'Push-Crash beheben',
      description: null,
      taskTypeId: 'task',
      statusId: 'st-open',
      priorityKey: 'high',
      assigneeId: ANNA,
      dueDate: '2026-10-23',
      labels: ['ios'],
      parentTaskId: null,
      customFieldValues: {},
    });
    expect(r.fields.map((f) => [f.key, f.state])).toEqual([
      ['title', 'ok'],
      ['description', 'ok'],
      ['space', 'ok'],
      ['type', 'ok'],
      ['status', 'ok'],
      ['priority', 'ok'],
      ['assignee', 'ok'],
      ['due', 'ok'],
      ['labels', 'ok'],
    ]);
    expect(field(r.fields, 'space')).toMatchObject({
      value: AMBER,
      display: 'Amber',
      said: 'amber',
      options: [{ value: AMBER, label: 'Amber', hint: 'AMBER' }],
    });
    expect(field(r.fields, 'assignee')).toMatchObject({
      value: ANNA,
      display: 'Anna Berg',
    });
  });

  describe('space', () => {
    it('asks "which space?" in a chat without one, offering only spaces the invoker can create in', async () => {
      const r = await resolve({ space: null });

      expect(r.confirmable).toBe(false);
      expect(field(r.fields, 'space')).toMatchObject({
        state: 'needs_input',
        code: 'unknown_space',
        value: null,
        options: [{ value: AMBER, label: 'Amber', hint: 'AMBER' }],
      });
      expect(r.create?.spaceId).toBeNull();
    });

    it('takes the space of a space channel', async () => {
      batch.conversation = { id: 'chan', kind: 'space', space_id: AMBER };
      const r = await resolve({ space: null });

      expect(field(r.fields, 'space')).toMatchObject({
        state: 'ok',
        value: AMBER,
      });
    });

    it('is blocked with nothing to pick when the invoker can create tasks nowhere', async () => {
      perms.getUserSpacePermissions.mockResolvedValue({
        isMember: true,
        permissions: {},
      });
      const r = await resolve({ space: null });

      expect(field(r.fields, 'space')).toMatchObject({
        state: 'blocked',
        code: 'no_space_available',
        options: [],
      });
    });

    it('says no_create_permission for a space the invoker belongs to without create_tasks', async () => {
      const r = await resolve({ space: 'RO' });

      expect(field(r.fields, 'space')).toMatchObject({
        state: 'blocked',
        code: 'no_create_permission',
        value: READONLY,
      });
      expect(r.confirmable).toBe(false);
    });

    it('never reveals a space the invoker cannot see: it is just unknown', async () => {
      const r = await resolve({ space: 'Secret' });

      expect(field(r.fields, 'space')).toMatchObject({
        state: 'needs_input',
        code: 'unknown_space',
        value: null,
      });
      expect(field(r.fields, 'space')).not.toHaveProperty('display');
    });

    it('is blocked when the tasks module is off in the space or the organization', async () => {
      modules.getEnabledSpaceIds.mockResolvedValue([SECRET]);
      expect(field((await resolve()).fields, 'space')).toMatchObject({
        state: 'blocked',
        code: 'module_off',
      });

      batch = service.batch({ ...batch });
      modules.isEnabled.mockResolvedValue(false);
      expect(field((await resolve()).fields, 'space')).toMatchObject({
        state: 'blocked',
        code: 'module_off',
      });
    });

    it('blocks a picked space that was archived or deleted since', async () => {
      tables.spaces[0].is_archived = true;
      const r = await resolve({}, { space: AMBER });

      expect(field(r.fields, 'space')).toMatchObject({
        state: 'blocked',
        code: 'no_space_available',
      });
    });

    it('accepts a space and a type the invoker picked', async () => {
      batch.conversation = { id: 'dm', kind: 'dm', space_id: null };
      const r = await resolve(
        { space: null },
        { space: AMBER, type: 'sub_task' },
      );

      expect(r.create).toMatchObject({
        spaceId: AMBER,
        taskTypeId: 'sub_task',
      });
    });

    it('finds the group and role members too (the full permission resolve, cached)', async () => {
      await resolve();
      await resolve({ title: 'Second' });

      expect(perms.getUserSpacePermissions).toHaveBeenCalledWith(
        ME,
        'org-1',
        AMBER,
      );
      // One batch: the type list and the space list are read once for both proposals.
      expect(hierarchy.getActiveTypes).toHaveBeenCalledTimes(1);
      expect(db.reads.filter((t) => t === 'space_members')).toHaveLength(1);
    });
  });

  describe('title and description', () => {
    it('keeps plain text only: no HTML, images, links or mention markup', async () => {
      const r = await resolve({
        title:
          'Fix <b>login</b> ![x](http://evil/x.png) [see](http://evil) <span data-type="mention" data-id="u1">@Anna</span>',
        description: 'Line one\n\n<img src=x onerror=alert(1)>Line two',
      });

      expect(r.title).toBe('Fix login see @Anna');
      expect(r.description).toBe('Line one\n\nLine two');
    });

    it('cuts a long title and says so; blocks an empty one', async () => {
      const long = await resolve({ title: 'x'.repeat(600) });
      expect(field(long.fields, 'title')).toMatchObject({
        state: 'check',
        code: 'too_long',
        params: { max: 500 },
      });
      expect(long.title).toHaveLength(500);
      expect(long.confirmable).toBe(true);

      const empty = await resolve({ title: '<p> </p>' });
      expect(field(empty.fields, 'title')).toMatchObject({
        state: 'blocked',
        code: 'required_missing',
      });
    });
  });

  describe('type and status', () => {
    it('asks for a type it cannot match', async () => {
      const r = await resolve({ type: 'Epic' });

      expect(field(r.fields, 'type')).toMatchObject({
        state: 'needs_input',
        code: 'unknown_type',
        said: 'Epic',
        options: [
          { value: 'task', label: 'Task' },
          { value: 'sub_task', label: 'Subtask' },
        ],
      });
    });

    it('shows the workflow start status, fixed', async () => {
      assignments.findActiveAssignmentForType.mockResolvedValue({
        workflow_id: 'wf-1',
      });
      tables.workflows = [
        { id: 'wf-1', organization_id: 'org-1', initial_status_id: 'st-prog' },
      ];
      const r = await resolve({ status: 'Open' });

      expect(field(r.fields, 'status')).toMatchObject({
        state: 'ok',
        code: 'status_fixed_by_workflow',
        value: 'st-prog',
        display: 'In Progress',
        editable: false,
      });
      expect((r.create as AgentCreatePlan | null)?.statusId).toBeNull();
    });

    it('checks a status it cannot match and keeps the default', async () => {
      const r = await resolve({ status: 'Waiting' });

      expect(field(r.fields, 'status')).toMatchObject({
        state: 'check',
        code: 'unknown_status',
        value: 'st-open',
      });
      expect(r.confirmable).toBe(true);
    });
  });

  it('checks a priority it cannot match ("blocker") and offers the real ones', async () => {
    const r = await resolve({
      priority: { said: 'blocker', level: 'highest' },
    });

    expect(field(r.fields, 'priority')).toMatchObject({
      state: 'check',
      code: 'unknown_priority',
      value: 'pr-med',
      options: [
        { value: 'pr-med', label: 'Medium' },
        { value: 'pr-high', label: 'High' },
      ],
    });
    expect((r.create as AgentCreatePlan | null)?.priorityKey).toBe('medium');
    expect(r.confirmable).toBe(true);
  });

  describe('assignee', () => {
    it('never guesses between namesakes', async () => {
      runs.findMembers.mockResolvedValue([
        { user_id: ANNA, full_name: 'Anna Berg', email: 'a@x', exact: true },
        { user_id: RAJ, full_name: 'Anna Kern', email: 'k@x', exact: true },
      ]);
      const r = await resolve({
        assignee: { said: 'Anna', participant: null, is_requester: false },
      });

      expect(field(r.fields, 'assignee')).toMatchObject({
        state: 'needs_input',
        code: 'ambiguous_person',
        value: null,
        options: [
          { value: ANNA, label: 'Anna Berg', hint: 'a@x' },
          { value: RAJ, label: 'Anna Kern', hint: 'k@x' },
        ],
      });
      expect((r.create as AgentCreatePlan | null)?.assigneeId).toBeNull();
    });

    it('asks when nobody matches the name', async () => {
      const r = await resolve({
        assignee: { said: 'Zed', participant: null, is_requester: false },
      });

      expect(field(r.fields, 'assignee')).toMatchObject({
        state: 'needs_input',
        code: 'unknown_person',
      });
    });

    it('reads "assign it to me" as the invoker', async () => {
      const r = await resolve({
        assignee: { said: 'me', participant: null, is_requester: true },
      });

      expect((r.create as AgentCreatePlan | null)?.assigneeId).toBe(ME);
      expect(runs.findMembers).not.toHaveBeenCalled();
    });

    it('asks again when the assignee is not a member of the space', async () => {
      perms.getUserSpacePermissions.mockImplementation(
        (userId: string, _o: string, spaceId: string) =>
          Promise.resolve({
            isMember: userId !== ANNA && spaceId === AMBER,
            permissions: { create_tasks: true },
          }),
      );
      const r = await resolve({
        assignee: {
          said: 'Anna',
          participant: 'P2',
          is_requester: false,
          user_id: ANNA,
        },
      });

      expect(field(r.fields, 'assignee')).toMatchObject({
        state: 'needs_input',
        code: 'not_space_member',
        value: ANNA,
      });
    });

    it('only hints when the assignee is not in this conversation', async () => {
      const r = await resolve({}, { assignee: RAJ });

      expect(field(r.fields, 'assignee')).toMatchObject({
        state: 'check',
        code: 'assignee_not_in_conversation',
        advisory: true,
      });
      expect(r.confirmable).toBe(true);
    });

    it('gives no such hint in a space this request creates', async () => {
      batch.siblings.set(1, { kind: 'space', spaceId: null, pendingSpace: 1, taskTypeId: null });
      batch.siblings.set(2, { kind: 'space_member_add', userId: RAJ, spaceId: null, pendingSpace: 1, taskTypeId: null });
      const r = await resolve({ space: null }, { assignee: RAJ }, 1);

      expect(field(r.fields, 'assignee')?.code).toBeUndefined();
    });

    it('never takes a deactivated or foreign user', async () => {
      tables.users[2].is_active = false;
      const r = await resolve({}, { assignee: RAJ });

      expect(field(r.fields, 'assignee')).toMatchObject({
        state: 'needs_input',
        code: 'unknown_person',
      });
    });
  });

  describe('due date', () => {
    it('reads the words in the invoker timezone, over the model', async () => {
      // 23:30 in Vienna on 22 October: "tomorrow" is the 23rd, although UTC is still the 22nd.
      batch.now = new Date('2026-10-22T21:30:00Z');
      const r = await resolve({ due: { said: 'tomorrow', iso: '2026-10-24' } });

      expect((r.create as AgentCreatePlan | null)?.dueDate).toBe('2026-10-23');
    });

    it('checks a date in the past without blocking', async () => {
      const r = await resolve({}, { due: '2026-10-01' });

      expect(field(r.fields, 'due')).toMatchObject({
        state: 'check',
        code: 'date_in_past',
      });
      expect(r.confirmable).toBe(true);
    });

    it('asks for a date it cannot read', async () => {
      const r = await resolve({ due: { said: 'soonish', iso: '2026-02-30' } });

      expect(field(r.fields, 'due')).toMatchObject({
        state: 'needs_input',
        code: 'invalid_date',
        said: 'soonish',
      });
    });
  });

  it('hints at labels the space does not use yet', async () => {
    const r = await resolve({ labels: ['iOS', 'crash'] });

    expect(field(r.fields, 'labels')).toMatchObject({
      state: 'check',
      code: 'new_label',
      advisory: true,
      params: { labels: 'crash', count: 1 },
      value: ['iOS', 'crash'],
    });
  });

  describe('parent', () => {
    it('makes a subtask of a task in the same space', async () => {
      const r = await resolve(
        { parent: { item: null, key: 'amber-t200', said: null } },
        {},
        null,
        'subtask',
      );

      expect(r.create).toMatchObject({
        parentTaskId: 'task-200',
        taskTypeId: 'sub_task',
      });
      expect(hierarchy.getValidChildTypesFor).toHaveBeenCalledWith(
        'org-1',
        AMBER,
        'task',
      );
    });

    it('blocks a parent in another space', async () => {
      const r = await resolve(
        { parent: { item: null, key: 'RO-T300', said: null } },
        {},
        null,
        'subtask',
      );

      expect(field(r.fields, 'parent')).toMatchObject({
        state: 'blocked',
        code: 'parent_other_space',
      });
      expect((r.create as AgentCreatePlan | null)?.parentTaskId).toBeNull();
    });

    it('asks for a parent it cannot find', async () => {
      const r = await resolve(
        { parent: { item: null, key: 'NOPE-1', said: null } },
        {},
        null,
        'subtask',
      );

      expect(field(r.fields, 'parent')).toMatchObject({
        state: 'needs_input',
        code: 'parent_not_found',
      });
    });

    it('waits for a parent proposal of the same run, in its space', async () => {
      batch.siblings.set(1, { spaceId: AMBER, taskTypeId: 'task' });
      const r = await resolve({ space: null }, {}, 1, 'subtask');

      expect(field(r.fields, 'parent')).toMatchObject({
        state: 'ok',
        params: { ordinal: 1 },
      });
      expect(r.create).toMatchObject({
        spaceId: AMBER,
        parentTaskId: null,
        taskTypeId: 'sub_task',
      });
      expect(r.fields.at(-1)?.key).toBe('parent');
    });
  });

  describe('a process in its hierarchy', () => {
    const ladder = [
      { id: 'gp', requestType: 'Geschäftsprozessbewertung', parentLevelId: null, allowedChildren: ['prozess'] },
      { id: 'prozess', requestType: 'Prozessbewertung', parentLevelId: 'gp', allowedChildren: ['schwach'] },
      { id: 'schwach', requestType: 'Schwachstelle', parentLevelId: null, allowedChildren: ['massnahme'] },
      { id: 'massnahme', requestType: 'Maßnahme', parentLevelId: 'schwach', allowedChildren: [] },
    ];
    const OTHER_SPACE = 'other-space';
    let getDefaultConfig: jest.Mock;
    let getConfig: jest.Mock;
    const processOf = (over: Partial<AgentStoredIntent> = {}, overrides: Row = {}, dependsOn: number | null = 1) =>
      service.resolve(batch, { kind: 'process', intent: intent({ space: null, ...over }), overrides, dependsOn });

    beforeEach(() => {
      getDefaultConfig = jest.fn().mockResolvedValue({ levels: ladder });
      getConfig = jest.fn().mockResolvedValue({ config: { levels: ladder } });
      (service as unknown as { processHierarchy: unknown }).processHierarchy = { getDefaultConfig, getConfig };
      perms.isAdminOrOwner.mockResolvedValue(true);
      batch.siblings.set(1, { kind: 'space', spaceId: null, pendingSpace: 1, taskTypeId: null, title: 'New' });
      tables.business_processes = [
        { id: 'p-amber', organization_id: 'org-1', space_id: AMBER, key: 'AMBER-P1', title: 'Top', request_type: 'Geschäftsprozessbewertung', hierarchy_level_id: 'gp' },
        { id: 'p-other', organization_id: 'org-1', space_id: OTHER_SPACE, key: 'OTHER-P1', title: 'Elsewhere', request_type: 'Geschäftsprozessbewertung', hierarchy_level_id: 'gp' },
        { id: 'p-org', organization_id: 'org-2', space_id: AMBER, key: 'FOREIGN-P1', title: 'Foreign', request_type: 'Geschäftsprozessbewertung', hierarchy_level_id: 'gp' },
      ];
    });

    it('stores the level, and a new space uses the default ladder', async () => {
      const r = await processOf({ title: 'Business', request_type: 'Geschäftsprozessbewertung' });
      expect(r.create).toMatchObject({ hierarchyLevelId: 'gp', requestType: 'Geschäftsprozessbewertung' });
      expect(getDefaultConfig).toHaveBeenCalled();
      expect(getConfig).not.toHaveBeenCalled();
      expect(r.confirmable).toBe(true);
    });

    it('nests under a process of the same request, level by level', async () => {
      batch.siblings.set(2, { kind: 'process', spaceId: null, pendingSpace: 1, taskTypeId: null, title: 'Top', hierarchyLevelId: 'gp', requestType: 'Geschäftsprozessbewertung' });
      const r = await processOf({ title: 'Child', request_type: 'Prozessbewertung' }, {}, 2);
      expect(r.create).toMatchObject({ hierarchyLevelId: 'prozess' });
      expect(field(r.fields, 'process')).toMatchObject({ state: 'ok', params: { ordinal: 2 } });
    });

    it('asks when the ladder does not allow the child, with what it allows', async () => {
      batch.siblings.set(2, { kind: 'process', spaceId: null, pendingSpace: 1, taskTypeId: null, title: 'Top', hierarchyLevelId: 'gp', requestType: 'Geschäftsprozessbewertung' });
      const r = await processOf({ title: 'Child', request_type: 'Maßnahme', process_scores: [{ key: 'action_c_p', value: 1 }] }, {}, 2);
      expect(r.confirmable).toBe(false);
      const row = field(r.fields, 'requestType');
      expect(row).toMatchObject({ state: 'needs_input', code: 'level_not_allowed' });
      expect(row?.options?.map((o) => o.value)).toEqual(['Prozessbewertung']);
    });

    it('asks when a type cannot stand at the top', async () => {
      const r = await processOf({ title: 'Alone', request_type: 'Prozessbewertung' });
      expect(field(r.fields, 'requestType')).toMatchObject({ state: 'needs_input', code: 'level_needs_parent' });
      expect(r.confirmable).toBe(false);
    });

    it('gives a child without a type the level allowed under its parent', async () => {
      batch.siblings.set(2, { kind: 'process', spaceId: null, pendingSpace: 1, taskTypeId: null, title: 'Top', hierarchyLevelId: 'gp', requestType: 'Geschäftsprozessbewertung' });
      const r = await processOf({ title: 'Child', request_type: null }, {}, 2);
      expect(r.create).toMatchObject({ requestType: 'Prozessbewertung', hierarchyLevelId: 'prozess' });
      expect(r.confirmable).toBe(true);
    });

    it('keeps only the scores of its type, in range, and shows them', async () => {
      batch.siblings.set(2, { kind: 'process', spaceId: null, pendingSpace: 1, taskTypeId: null, title: 'Top', hierarchyLevelId: 'gp', requestType: 'Geschäftsprozessbewertung' });
      const r = await processOf(
        { title: 'Child', request_type: 'Prozessbewertung', process_scores: [
          { key: 'vuln_c_p', value: 3 }, { key: 'vuln_a_i', value: 9 }, { key: 'action_c_p', value: 2 }, { key: 'level_c_p', value: 2 }, { key: 'owner', value: 1 },
        ] },
        {},
        2,
      );
      expect((r.create as { scores: object }).scores).toEqual({ vuln_c_p: 3 });
      expect(field(r.fields, 'scores')).toMatchObject({ state: 'ok', value: { vuln_c_p: 3 }, params: { prefix: 'vuln_' } });
    });

    it('takes scores edited on the card over those of the model', async () => {
      const r = await processOf(
        { title: 'Weak', request_type: 'Schwachstelle', process_scores: [{ key: 'vuln_c_p', value: 3 }] },
        { scores: { vuln_c_p: 1, vuln_i_i: 2 } },
      );
      expect((r.create as { scores: object }).scores).toEqual({ vuln_c_p: 1, vuln_i_i: 2 });
    });

    it('still asks for the scores a Schwachstelle must have, and lets the card fill them', async () => {
      const r = await processOf({ title: 'Weak', request_type: 'Schwachstelle' });
      const row = field(r.fields, 'scores');
      expect(row).toMatchObject({ state: 'needs_input', code: 'scores_missing' });
      expect(row?.editable).not.toBe(false);
      expect(r.confirmable).toBe(false);
    });

    it('nests under an existing process of the same space only', async () => {
      const inAmber = await processOf({ title: 'Child', request_type: 'Prozessbewertung', space: 'Amber', parent: { item: null, key: 'amber-p1', said: null } }, {}, null);
      expect(inAmber.create).toMatchObject({ parentId: 'p-amber', hierarchyLevelId: 'prozess' });
      expect(field(inAmber.fields, 'process')).toMatchObject({ state: 'ok', value: 'p-amber', display: 'AMBER-P1 Top' });

      for (const key of ['OTHER-P1', 'FOREIGN-P1', 'NOPE-P9']) {
        const r = await processOf({ title: 'Child', request_type: 'Prozessbewertung', space: 'Amber', parent: { item: null, key, said: null } }, {}, null);
        expect(field(r.fields, 'process')).toMatchObject({ state: 'needs_input', code: 'parent_not_found' });
        expect(r.confirmable).toBe(false);
        expect((r.create as { parentId?: string }).parentId).toBeUndefined();
      }
    });

    it('says only what is wrong when the named parent does not exist', async () => {
      const r = await processOf({ title: 'Child', request_type: 'Prozessbewertung', space: 'Amber', parent: { item: null, key: 'NOPE-P9', said: null } }, {}, null);
      expect(field(r.fields, 'process')?.code).toBe('parent_not_found');
      expect(field(r.fields, 'requestType')?.state).toBe('ok');
    });

    it('offers nothing when the process above can have no children', async () => {
      batch.siblings.set(2, { kind: 'process', spaceId: null, pendingSpace: 1, taskTypeId: null, title: 'Top', hierarchyLevelId: 'massnahme', requestType: 'Maßnahme' });
      const r = await processOf({ title: 'Child', request_type: 'Risiko' }, {}, 2);
      const row = field(r.fields, 'requestType');
      expect(row).toMatchObject({ state: 'needs_input', code: 'level_no_children' });
      expect(row?.options ?? []).toEqual([]);
    });

    it('cannot name an existing parent for a space of this request', async () => {
      const r = await processOf({ title: 'Child', request_type: 'Prozessbewertung', parent: { item: null, key: 'AMBER-P1', said: null } });
      expect(field(r.fields, 'process')).toMatchObject({ state: 'needs_input', code: 'parent_not_found' });
    });
  });

  describe('required custom fields', () => {
    beforeEach(() => {
      fieldGroups.getLevelFieldsConfiguration.mockResolvedValue({
        standalone_fields: [
          { is_required: true, custom_field: { id: 'cf-1', is_active: true } },
          { is_required: true, is_hidden: true, custom_field: { id: 'cf-2' } },
          { is_required: false, custom_field: { id: 'cf-3' } },
        ],
        groups: [],
      });
      tables.custom_fields = [
        {
          id: 'cf-1',
          organization_id: 'org-1',
          name: 'Severity',
          field_key: 'severity',
          field_type: 'select',
          validation_rules: {},
          options: [{ value: 'high', label: 'High' }],
        },
      ];
    });

    it('asks for a required field, with its definition for the client', async () => {
      const r = await resolve();

      expect(field(r.fields, 'custom:cf-1')).toMatchObject({
        state: 'needs_input',
        code: 'required_missing',
        value: null,
        fieldDef: expect.objectContaining({
          id: 'cf-1',
          field_type: 'select',
          is_required: true,
        }) as object,
      });
      expect(r.fields.some((f) => f.key === 'custom:cf-2')).toBe(false);
      expect(r.confirmable).toBe(false);
    });

    it('takes a valid value, keyed by field_key, and refuses an invalid one', async () => {
      const ok = await resolve({}, { 'custom:cf-1': 'high' });
      expect(ok.confirmable).toBe(true);
      expect((ok.create as AgentCreatePlan | null)?.customFieldValues).toEqual({ severity: 'high' });

      const bad = await resolve({}, { 'custom:cf-1': 'blocker' });
      expect(field(bad.fields, 'custom:cf-1').state).toBe('needs_input');
      expect((bad.create as AgentCreatePlan | null)?.customFieldValues).toEqual({});
    });
  });

  it('turns a failed lookup into one blocked card instead of an error', async () => {
    hierarchy.getActiveTypes.mockRejectedValue(new Error('db down'));
    const r = await resolve();

    expect(r).toMatchObject({ confirmable: false, create: null });
    expect(field(r.fields, 'space')).toMatchObject({
      state: 'blocked',
      code: 'resolve_failed',
    });
  });

  describe('spaceNamedIn', () => {
    it.each([
      ['in AMBER create a task for Rajbha', 'AMBER'],
      ['create it in the amber space, please', 'AMBER'],
      ['create a task for Rajbha', null],
      // RO is not a space the invoker may create in; SEC is not even visible.
      ['put it in RO or SEC', null],
      // A key inside another word is not a mention of the space.
      ['the AMBERLIGHT project needs a task', null],
    ])('%s → %s', async (request, key) => {
      await expect(service.spaceNamedIn(batch, request)).resolves.toBe(key);
    });
  });

  describe('hidesFromAudience', () => {
    it('narrows when a member of the chat cannot view a target space', async () => {
      access.canViewSpace.mockImplementation((userId: string) =>
        Promise.resolve(userId === ME),
      );
      await expect(service.hidesFromAudience(batch, [AMBER])).resolves.toBe(
        true,
      );

      access.canViewSpace.mockResolvedValue(true);
      await expect(
        service.hidesFromAudience(batch, [AMBER, null]),
      ).resolves.toBe(false);
      await expect(service.hidesFromAudience(batch, [])).resolves.toBe(false);
    });

    it('narrows a space channel for any other space', async () => {
      batch.conversation = { id: 'chan', kind: 'space', space_id: AMBER };

      await expect(service.hidesFromAudience(batch, [AMBER])).resolves.toBe(
        false,
      );
      await expect(service.hidesFromAudience(batch, [SECRET])).resolves.toBe(
        true,
      );
    });
  });
});

describe('pure helpers', () => {
  it('stripMarkup keeps comparisons and arrows, takes only real tags (audit 2026-11-10)', () => {
    expect(stripMarkup('Response time < 5 min\nwhen load is high\nerror rate > 2%')).toBe(
      'Response time < 5 min\nwhen load is high\nerror rate > 2%',
    );
    expect(stripMarkup('a <-> b, x<y, <b>bold</b> <p class="x">p</p><br/>')).toBe('a <-> b, x<y, bold p');
    expect(stripMarkup('<script>alert(1)</script>ok')).toBe('alert(1)ok');
  });

  it('stripMarkup leaves plain text', () => {
    expect(stripMarkup('a​b  <i>c</i>\n\n\n\nd')).toBe('ab c\n\nd');
    expect(stripMarkup(null)).toBe('');
  });

  it('strictDay accepts real calendar days only', () => {
    expect(strictDay('2028-02-29')).toBe('2028-02-29');
    expect(strictDay('2026-02-29')).toBeNull();
    expect(strictDay('2026-1-5')).toBeNull();
    expect(strictDay(20261005)).toBeNull();
  });
});
