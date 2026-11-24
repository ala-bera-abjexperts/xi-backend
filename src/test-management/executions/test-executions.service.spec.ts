import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TasksService } from '../../tasks/tasks.service';
import {
  TEST_RECORD_DELETED_EVENT,
  TEST_RECORD_UPDATED_EVENT,
} from '../../tasks/test-ticket-events';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import type { TesterEligibilityService } from '../common/tester-eligibility.service';
import {
  CreateTestExecutionDto,
  type ExecutionSourceFilter,
} from '../dto/test-execution.dto';
import { TestExecutionsService } from './test-executions.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const EXEC = 'exec-1';
const REQUEST = 'req-1';
const TICKET = 'task-new';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;

interface Resolved {
  data: unknown;
  error: { code?: string; message: string; details?: string } | null;
  count?: number | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function buildChain(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of [
    'select',
    'eq',
    'neq',
    'or',
    'not',
    'order',
    'range',
    'limit',
    'update',
    'in',
    'is',
    'delete',
  ]) {
    chain[name] = jest.fn(() => chain);
  }

  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  Object.assign(chain, {
    then: (onFulfilled: (value: Resolved) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled),
  });

  return chain;
}

function eqCalls(chain: Chain): unknown[][] {
  return chain.eq.mock.calls as unknown[][];
}

// Answers each table from its own queue and keeps every chain for later checks.
function byTable(from: jest.Mock, queues: Record<string, Resolved[]>) {
  const chains: Record<string, Chain[]> = {};

  from.mockImplementation((table: string) => {
    const chain = buildChain(
      queues[table]?.shift() ?? { data: [], error: null },
    );

    (chains[table] ??= []).push(chain);

    return chain;
  });

  return chains;
}

const executionRow = {
  id: EXEC,
  folder_id: null,
  task_id: 'task-1',
  environment: 'QA',
  source: 'manual',
  is_archived: false,
  archived_at: null,
  created_at: '2026-10-20T00:00:00Z',
  updated_at: '2026-10-20T00:00:00Z',
  plan: null,
  creator: {
    id: 'user-1',
    first_name: 'Ann',
    last_name: 'Lee',
    email: 'a@x',
    avatar_url: null,
  },
  task: { key: 'P-TE1', summary: 'Sprint', description: null },
  run_count: [{ count: 2 }],
};

const created = {
  changed: true,
  replayed: false,
  execution_id: EXEC,
  key: 'P-TE1',
  run_count: 2,
  skipped: [{ case_id: 'c3', key: 'P-TC3', reason: 'deprecated' }],
  warnings: [{ case_id: 'c2', key: 'P-TC2', reason: 'tester_ineligible' }],
};

// Answers the has-results count that every execution load makes.
const noResults = () => buildChain({ data: null, error: null, count: 0 });

const NONE: Resolved = { data: null, error: null };

// A plan, set or case read for the name of a new ticket.
const ticketSource = (
  key: string,
  summary: string,
  is_archived = false,
): Resolved => ({ data: { is_archived, task: { key, summary } }, error: null });

// A create that makes its own ticket finds no earlier request and reads the space's task type.
const newTicketTables = (
  extra: Record<string, Resolved[]> = {},
): Record<string, Resolved[]> => ({
  test_executions: [NONE],
  test_management_space_settings: [
    { data: { execution_task_type_id: 'type-exec' }, error: null },
  ],
  ...extra,
});

describe('TestExecutionsService', () => {
  let service: TestExecutionsService;
  let from: jest.Mock;
  let rpc: jest.Mock;
  let log: jest.Mock;
  let eligibleUserIds: jest.Mock;
  let assertEligible: jest.Mock;
  let assertAvailable: jest.Mock;
  let checkPermission: jest.Mock;
  let tasksCreate: jest.Mock;
  let tasksDelete: jest.Mock;
  let emitAsync: jest.Mock;

  // Same service with the ticket and event collaborators present.
  const linked = () =>
    new TestExecutionsService(
      { getClient: () => ({ from, rpc }) } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      {
        eligibleUserIds,
        assertEligible,
      } as unknown as TesterEligibilityService,
      { logActionForRequest: log } as unknown as AuditLogsService,
      { checkPermission } as unknown as PermissionsService,
      { create: tasksCreate, delete: tasksDelete } as unknown as TasksService,
      { emitAsync } as unknown as EventEmitter2,
    );

  beforeEach(() => {
    assertAvailable = jest.fn().mockResolvedValue(undefined);
    from = jest.fn();
    rpc = jest.fn();
    log = jest.fn().mockResolvedValue(undefined);
    eligibleUserIds = jest.fn().mockResolvedValue(new Set(['user-1']));
    assertEligible = jest.fn().mockResolvedValue(undefined);
    checkPermission = jest.fn().mockResolvedValue(true);
    tasksCreate = jest.fn().mockResolvedValue({ id: TICKET, key: 'P-TE1' });
    tasksDelete = jest.fn().mockResolvedValue(undefined);
    emitAsync = jest.fn().mockResolvedValue([]);

    service = new TestExecutionsService(
      { getClient: () => ({ from, rpc }) } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      {
        eligibleUserIds,
        assertEligible,
      } as unknown as TesterEligibilityService,
      { logActionForRequest: log } as unknown as AuditLogsService,
      { checkPermission } as unknown as PermissionsService,
    );
  });

  describe('create', () => {
    beforeEach(() => {
      service = linked();
    });

    it('passes the plan, request id and eligible testers, and adds draft warnings', async () => {
      rpc.mockResolvedValueOnce({ data: created, error: null });
      byTable(
        from,
        newTicketTables({
          test_plans: [ticketSource('P-TP1', 'Release')],
          test_runs: [
            {
              data: [{ case_id: 'c1', case: { task: { key: 'P-TC1' } } }],
              error: null,
            },
          ],
        }),
      );

      const result = await service.create(user, SPACE, {
        request_id: REQUEST,
        from: 'plan',
        plan_id: 'plan-1',
        environment: 'QA',
      });

      expect(rpc).toHaveBeenCalledWith('tm_create_execution', {
        p_organization_id: ORG,
        p_space_id: SPACE,
        p_actor_id: 'user-1',
        p_request_id: REQUEST,
        p_source: 'manual',
        p_task_id: TICKET,
        p_plan_id: 'plan-1',
        p_set_id: null,
        p_case_ids: null,
        p_environment: 'QA',
        p_eligible_user_ids: ['user-1'],
      });
      expect(result.replayed).toBe(false);
      expect(result.skipped).toHaveLength(1);
      expect(result.warnings.map((w) => w.reason)).toEqual([
        'tester_ineligible',
        'draft',
      ]);
      expect(result.ticket_warning).toBeNull();
      expect(log).toHaveBeenCalledWith(
        user,
        'test_execution',
        EXEC,
        'create',
        expect.objectContaining({ from: 'plan', run_count: 2 }),
      );
    });

    it('returns a replay as it is, without extra reads or audit', async () => {
      rpc.mockResolvedValueOnce({
        data: {
          ...created,
          changed: false,
          replayed: true,
          skipped: [],
          warnings: [],
        },
        error: null,
      });
      byTable(from, {
        test_executions: [{ data: { task_id: 'task-old' }, error: null }],
      });

      const result = await service.create(user, SPACE, {
        request_id: REQUEST,
        from: 'cases',
        case_ids: ['c1'],
      });

      expect(result.replayed).toBe(true);
      expect(from).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      expect(eligibleUserIds).not.toHaveBeenCalled();
    });

    it.each([
      [
        'P0002 with missing ids',
        { code: 'P0002', message: 'tm: x', details: '{"missing":["c9"]}' },
        NotFoundException,
        'NOT_FOUND',
      ],
      [
        'archived plan',
        { code: 'TM004', message: 'tm: x', details: '{"plan_id":"p"}' },
        ConflictException,
        'ARCHIVED',
      ],
      [
        'case deleted meanwhile',
        { code: '23503', message: 'fk' },
        ConflictException,
        'IN_USE',
      ],
      [
        'nothing runnable',
        {
          code: '22023',
          message: 'tm: no runnable case',
          details: '{"skipped":[]}',
        },
        BadRequestException,
        'VALIDATION_FAILED',
      ],
      [
        'too many runs',
        { code: 'TM013', message: 'tm: x', details: '{"limit":1000}' },
        BadRequestException,
        'LIMIT_EXCEEDED',
      ],
    ])('maps %s', async (_label, error, type, code) => {
      rpc.mockResolvedValueOnce({ data: null, error });
      byTable(
        from,
        newTicketTables({ test_sets: [ticketSource('P-TS1', 'Smoke set')] }),
      );

      const failure = service.create(user, SPACE, {
        request_id: REQUEST,
        from: 'set',
        set_id: 'set-1',
      });

      await expect(failure).rejects.toBeInstanceOf(type);
      await failure.catch((e: { getResponse: () => { code: string } }) =>
        expect(e.getResponse().code).toBe(code),
      );
    });

    it('answers 404 for a folder outside the space before creating anything', async () => {
      const folder = buildChain({ data: null, error: null });

      from.mockReturnValueOnce(folder);

      await expect(
        service.create(user, SPACE, {
          request_id: REQUEST,
          from: 'cases',
          case_ids: ['c1'],
          folder_id: 'folder-x',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(from).toHaveBeenCalledWith('test_folders');
      expect(eqCalls(folder)).toEqual(
        expect.arrayContaining([
          ['id', 'folder-x'],
          ['space_id', SPACE],
          ['organization_id', ORG],
        ]),
      );
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  describe('create without a source', () => {
    it('sends no plan, set or cases and reads no eligible testers', async () => {
      service = linked();
      rpc.mockResolvedValueOnce({
        data: { ...created, run_count: 0, skipped: [], warnings: [] },
        error: null,
      });
      byTable(from, newTicketTables());

      const result = await service.create(user, SPACE, {
        request_id: REQUEST,
        name: 'Smoke',
      });

      expect(tasksCreate).toHaveBeenCalledWith(
        ORG,
        'user-1',
        expect.objectContaining({ summary: 'Smoke' }),
        { testRightChecked: true },
      );
      expect(rpc).toHaveBeenCalledWith(
        'tm_create_execution',
        expect.objectContaining({
          p_task_id: TICKET,
          p_plan_id: null,
          p_set_id: null,
          p_case_ids: null,
          p_eligible_user_ids: [],
        }),
      );
      expect(eligibleUserIds).not.toHaveBeenCalled();
      expect(result.run_count).toBe(0);
    });

    it('accepts a create body without from, and still checks from when given', async () => {
      const errorsOf = async (plain: Record<string, unknown>) =>
        (
          await validate(plainToInstance(CreateTestExecutionDto, plain), {
            whitelist: true,
            forbidNonWhitelisted: true,
          })
        ).map((error) => error.property);

      const request_id = '11111111-1111-4111-8111-111111111111';

      expect(await errorsOf({ request_id })).toEqual([]);
      expect(await errorsOf({ request_id, from: 'plan' })).toEqual(['plan_id']);
      expect(await errorsOf({ request_id, from: 'nope' })).toEqual(['from']);
    });
  });

  describe('create with a ticket', () => {
    beforeEach(() => {
      service = linked();
      rpc.mockResolvedValue({
        data: { ...created, skipped: [], warnings: [] },
        error: null,
      });
    });

    const create = () =>
      service.create(user, SPACE, {
        request_id: REQUEST,
        from: 'cases',
        case_ids: ['c1'],
      });

    it('refuses with TICKET_TYPE_MISSING when the space has no execution task type', async () => {
      byTable(from, {
        test_executions: [NONE],
        test_management_space_settings: [NONE],
      });

      await expect(create()).rejects.toMatchObject({
        status: 400,
        response: { code: 'TICKET_TYPE_MISSING' },
      });
      expect(tasksCreate).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });

    it('refuses with TICKET_CREATE_FORBIDDEN when the caller may not create tasks', async () => {
      checkPermission.mockResolvedValueOnce(false);
      byTable(from, newTicketTables());

      await expect(create()).rejects.toMatchObject({
        status: 403,
        response: { code: 'TICKET_CREATE_FORBIDDEN' },
      });
      expect(checkPermission).toHaveBeenCalledWith(
        'user-1',
        ORG,
        'can_create_tasks',
      );
      expect(tasksCreate).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });

    it('creates the ticket first and passes it to the function', async () => {
      const chains = byTable(from, newTicketTables());

      const result = await create();

      expect(result.ticket_warning).toBeNull();
      expect(tasksCreate).toHaveBeenCalledWith(
        ORG,
        'user-1',
        {
          summary: 'Ad hoc execution',
          space_id: SPACE,
          task_type_id: 'type-exec',
        },
        { testRightChecked: true },
      );
      expect(tasksCreate.mock.invocationCallOrder[0]).toBeLessThan(
        rpc.mock.invocationCallOrder[0],
      );
      expect(rpc).toHaveBeenCalledWith(
        'tm_create_execution',
        expect.objectContaining({ p_task_id: TICKET }),
      );
      expect(eqCalls(chains.test_executions[0])).toEqual(
        expect.arrayContaining([
          ['space_id', SPACE],
          ['organization_id', ORG],
          ['request_id', REQUEST],
        ]),
      );
      expect(tasksDelete).not.toHaveBeenCalled();
    });

    it('does not create a second ticket for a replay that already has one', async () => {
      rpc.mockResolvedValueOnce({
        data: { ...created, replayed: true, skipped: [], warnings: [] },
        error: null,
      });
      byTable(from, {
        test_executions: [{ data: { task_id: 'task-old' }, error: null }],
      });

      const result = await create();

      expect(result.replayed).toBe(true);
      expect(result.ticket_warning).toBeNull();
      expect(rpc).toHaveBeenCalledWith(
        'tm_create_execution',
        expect.objectContaining({ p_task_id: 'task-old' }),
      );
      expect(checkPermission).not.toHaveBeenCalled();
      expect(tasksCreate).not.toHaveBeenCalled();
      expect(tasksDelete).not.toHaveBeenCalled();
    });

    it('removes its new ticket when the function refuses', async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'TM013', message: 'tm: x', details: '{"limit":1000}' },
      });
      byTable(from, newTicketTables());

      await expect(create()).rejects.toMatchObject({
        response: { code: 'LIMIT_EXCEEDED' },
      });
      expect(tasksDelete).toHaveBeenCalledWith(TICKET, ORG, 'user-1', {
        testRecordDeleted: true,
      });
      expect(log).not.toHaveBeenCalled();
    });

    it('keeps the function error when its new ticket cannot be removed', async () => {
      const error = jest
        .spyOn(
          (service as unknown as { logger: { error: () => void } }).logger,
          'error',
        )
        .mockImplementation(() => undefined);

      tasksDelete.mockRejectedValueOnce(new Error('tasks down'));
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'TM013', message: 'tm: x', details: '{"limit":1000}' },
      });
      byTable(from, newTicketTables());

      await expect(create()).rejects.toMatchObject({
        response: { code: 'LIMIT_EXCEEDED' },
      });
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });

    it('removes its new ticket when a parallel request won the race', async () => {
      rpc.mockResolvedValueOnce({
        data: { ...created, replayed: true, skipped: [], warnings: [] },
        error: null,
      });
      byTable(from, newTicketTables());

      const result = await create();

      expect(result.replayed).toBe(true);
      expect(tasksDelete).toHaveBeenCalledWith(TICKET, ORG, 'user-1', {
        testRecordDeleted: true,
      });
      expect(log).not.toHaveBeenCalled();
    });

    it('fails without calling the function when the ticket cannot be created', async () => {
      const down = new Error('tasks down');

      tasksCreate.mockRejectedValueOnce(down);
      byTable(from, newTicketTables());

      await expect(create()).rejects.toBe(down);
      expect(rpc).not.toHaveBeenCalled();
      expect(tasksDelete).not.toHaveBeenCalled();
    });

    it('sends the description to the new ticket as rich text', async () => {
      byTable(from, newTicketTables());

      await service.create(user, SPACE, {
        request_id: REQUEST,
        name: 'Smoke',
        description: 'a <b',
      });

      expect(tasksCreate).toHaveBeenCalledWith(
        ORG,
        'user-1',
        expect.objectContaining({
          summary: 'Smoke',
          description: '<p>a &lt;b</p>',
        }),
        { testRightChecked: true },
      );
    });

    const named: [
      string,
      Partial<CreateTestExecutionDto>,
      string,
      string,
      string,
    ][] = [
      [
        'the plan ticket summary',
        { from: 'plan', plan_id: 'p1' },
        'test_plans',
        ' Release ',
        'Release',
      ],
      [
        'the set ticket summary',
        { from: 'set', set_id: 's1' },
        'test_sets',
        'Smoke set',
        'Smoke set',
      ],
      [
        'the given name over the source ticket',
        { from: 'plan', plan_id: 'p1', name: ' Given ' },
        'test_plans',
        'Release',
        'Given',
      ],
    ];

    it.each(named)(
      'names the new ticket with %s',
      async (_label, dto, table, summary, expected) => {
        byTable(
          from,
          newTicketTables({ [table]: [ticketSource('P-X1', summary)] }),
        );

        await service.create(user, SPACE, { request_id: REQUEST, ...dto });

        expect(tasksCreate).toHaveBeenCalledWith(
          ORG,
          'user-1',
          expect.objectContaining({ summary: expected }),
          { testRightChecked: true },
        );
      },
    );

    it.each([
      ['plan', 'test_plans', { from: 'plan', plan_id: 'p1' }],
      ['set', 'test_sets', { from: 'set', set_id: 's1' }],
    ] as [string, string, Partial<CreateTestExecutionDto>][])(
      'makes no ticket for a missing or archived %s',
      async (_label, table, dto) => {
        byTable(from, newTicketTables({ [table]: [NONE] }));
        await expect(
          service.create(user, SPACE, { request_id: REQUEST, ...dto }),
        ).rejects.toBeInstanceOf(NotFoundException);

        byTable(
          from,
          newTicketTables({ [table]: [ticketSource('P-X1', 'Old', true)] }),
        );
        await expect(
          service.create(user, SPACE, { request_id: REQUEST, ...dto }),
        ).rejects.toMatchObject({ response: { code: 'ARCHIVED' } });

        expect(checkPermission).not.toHaveBeenCalled();
        expect(tasksCreate).not.toHaveBeenCalled();
        expect(rpc).not.toHaveBeenCalled();
      },
    );
  });

  describe('create with an existing ticket', () => {
    const TASK = 'task-9';
    const ticket = (typeId: string): Resolved => ({
      data: { id: TASK, task_type_id: typeId },
      error: null,
    });
    const ticketFields: Resolved = {
      data: { summary: 'Old', description: '<p>Old text</p>' },
      error: null,
    };
    const settings: Resolved = {
      data: { execution_task_type_id: 'type-exec' },
      error: null,
    };

    beforeEach(() => {
      service = linked();
      rpc.mockResolvedValue({
        data: { ...created, skipped: [], warnings: [] },
        error: null,
      });
    });

    const create = (fields: Partial<CreateTestExecutionDto> = {}) =>
      service.create(user, SPACE, {
        request_id: REQUEST,
        from: 'cases',
        case_ids: ['c1'],
        task_id: TASK,
        ...fields,
      });

    // The linked check and the request id lookup both find nothing.
    const freshTicket = () =>
      byTable(from, {
        tasks: [ticket('type-exec'), ticketFields],
        test_management_space_settings: [settings],
        test_executions: [NONE, NONE],
      });

    it('passes the given ticket to the function and creates no new one', async () => {
      const chains = freshTicket();

      const result = await create();

      expect(result.ticket_warning).toBeNull();
      expect(tasksCreate).not.toHaveBeenCalled();
      expect(checkPermission).not.toHaveBeenCalled();
      expect(eqCalls(chains.tasks[0])).toEqual(
        expect.arrayContaining([
          ['id', TASK],
          ['space_id', SPACE],
          ['organization_id', ORG],
        ]),
      );
      expect(rpc).toHaveBeenCalledWith(
        'tm_create_execution',
        expect.objectContaining({ p_task_id: TASK }),
      );
      expect(emitAsync).not.toHaveBeenCalled();
    });

    it('answers 404 for a ticket outside the space before creating anything', async () => {
      byTable(from, { tasks: [{ data: null, error: null }] });

      await expect(create()).rejects.toBeInstanceOf(NotFoundException);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('refuses a ticket of another type before creating anything', async () => {
      byTable(from, {
        tasks: [ticket('type-plan')],
        test_management_space_settings: [settings],
      });

      await expect(create()).rejects.toMatchObject({
        response: { code: 'NOT_EXECUTION_TICKET' },
      });
      expect(rpc).not.toHaveBeenCalled();
    });

    it('refuses a ticket that already has an execution', async () => {
      byTable(from, {
        tasks: [ticket('type-exec')],
        test_management_space_settings: [settings],
        test_executions: [
          { data: { id: 'exec-2', request_id: 'req-other' }, error: null },
        ],
      });

      await expect(create()).rejects.toBeInstanceOf(ConflictException);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('lets a resend of the same request through to its execution', async () => {
      rpc.mockResolvedValueOnce({
        data: { ...created, replayed: true, skipped: [], warnings: [] },
        error: null,
      });
      byTable(from, {
        tasks: [ticket('type-exec')],
        test_management_space_settings: [settings],
        test_executions: [
          { data: { id: EXEC, request_id: REQUEST }, error: null },
          { data: { task_id: TASK }, error: null },
        ],
      });

      const result = await create();

      expect(result.replayed).toBe(true);
      expect(result.ticket_warning).toBeNull();
    });

    it('renames the given ticket when the name or description differ', async () => {
      freshTicket();

      await create({ name: 'New name', description: 'a <b' });

      expect(emitAsync).toHaveBeenCalledWith(TEST_RECORD_UPDATED_EVENT, {
        organizationId: ORG,
        taskId: TASK,
        userId: 'user-1',
        changes: { summary: 'New name', description: '<p>a &lt;b</p>' },
      });
    });

    it('leaves the given ticket alone when the name and description match', async () => {
      freshTicket();

      await create({ name: 'Old', description: 'Old text' });

      expect(emitAsync).not.toHaveBeenCalled();
    });

    it('never deletes the given ticket when the function refuses', async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'TM013', message: 'tm: x', details: '{"limit":1000}' },
      });
      freshTicket();

      await expect(create()).rejects.toMatchObject({
        response: { code: 'LIMIT_EXCEEDED' },
      });
      expect(tasksDelete).not.toHaveBeenCalled();
    });

    it('never deletes the given ticket when a parallel request won the race', async () => {
      rpc.mockResolvedValueOnce({
        data: { ...created, replayed: true, skipped: [], warnings: [] },
        error: null,
      });
      freshTicket();

      const result = await create();

      expect(result.replayed).toBe(true);
      expect(tasksDelete).not.toHaveBeenCalled();
    });
  });

  describe('runNow', () => {
    beforeEach(() => {
      service = linked();
    });

    it('checks the caller is eligible and returns the run id', async () => {
      rpc.mockResolvedValueOnce({
        data: { ...created, run_count: 1 },
        error: null,
      });

      const chains = byTable(
        from,
        newTicketTables({
          test_cases: [ticketSource('P-TC1', 'Login')],
          test_runs: [{ data: { id: 'run-1' }, error: null }],
        }),
      );

      const result = await service.runNow(user, SPACE, 'case-1', {
        request_id: REQUEST,
      });

      expect(assertEligible).toHaveBeenCalledWith(ORG, SPACE, 'user-1');
      expect(tasksCreate).toHaveBeenCalledWith(
        ORG,
        'user-1',
        {
          summary: 'Run now P-TC1',
          space_id: SPACE,
          task_type_id: 'type-exec',
        },
        { testRightChecked: true },
      );
      expect(rpc).toHaveBeenCalledWith(
        'tm_create_execution',
        expect.objectContaining({
          p_source: 'run_now',
          p_task_id: TICKET,
          p_case_ids: ['case-1'],
          p_plan_id: null,
          p_set_id: null,
          p_eligible_user_ids: [],
        }),
      );
      expect(eqCalls(chains.test_runs[0])).toEqual(
        expect.arrayContaining([
          ['execution_id', EXEC],
          ['execution.source', 'run_now'],
          ['case_id', 'case-1'],
          ['space_id', SPACE],
          ['organization_id', ORG],
        ]),
      );
      expect(result).toEqual({
        replayed: false,
        execution_id: EXEC,
        key: 'P-TE1',
        run_id: 'run-1',
        ticket_warning: null,
      });
    });

    it('refuses a request id that belongs to another request instead of returning its run', async () => {
      rpc.mockResolvedValueOnce({
        data: { ...created, replayed: true, run_count: 1 },
        error: null,
      });
      byTable(from, {
        test_executions: [{ data: { task_id: 'task-old' }, error: null }],
        test_runs: [NONE],
      });

      await expect(
        service.runNow(user, SPACE, 'case-2', { request_id: REQUEST }),
      ).rejects.toMatchObject({
        response: { code: 'VALIDATION_FAILED' },
      });
      expect(tasksCreate).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('answers 404 for a missing case and ARCHIVED for an archived one, making no ticket', async () => {
      byTable(from, newTicketTables({ test_cases: [NONE] }));
      await expect(
        service.runNow(user, SPACE, 'case-1', { request_id: REQUEST }),
      ).rejects.toBeInstanceOf(NotFoundException);

      byTable(
        from,
        newTicketTables({ test_cases: [ticketSource('P-TC1', 'Login', true)] }),
      );
      await expect(
        service.runNow(user, SPACE, 'case-1', { request_id: REQUEST }),
      ).rejects.toMatchObject({
        response: { code: 'ARCHIVED', message: 'The test case is archived' },
      });
      expect(tasksCreate).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
    });

    it('refuses before creating anything when the caller is not eligible', async () => {
      assertEligible.mockRejectedValueOnce(new BadRequestException());

      await expect(
        service.runNow(user, SPACE, 'case-1', { request_id: REQUEST }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('refuses an empty change', async () => {
      await expect(
        service.update(user, SPACE, EXEC, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, {
        write: true,
      });
    });

    it('checks availability before the body', async () => {
      assertAvailable.mockRejectedValueOnce(new ForbiddenException());

      await expect(
        service.update(user, SPACE, EXEC, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('answers ARCHIVED before looking at results when the environment of an archived execution changes', async () => {
      from
        .mockReturnValueOnce(
          buildChain({
            data: { ...executionRow, is_archived: true },
            error: null,
          }),
        )
        .mockReturnValueOnce(noResults());

      await expect(
        service.update(user, SPACE, EXEC, { environment: 'Prod' }),
      ).rejects.toMatchObject({ response: { code: 'ARCHIVED' } });
      expect(from).toHaveBeenCalledTimes(2);
    });

    it('scopes the write and answers ARCHIVED when the execution was archived meanwhile', async () => {
      const write = buildChain({ data: null, error: null });

      from
        .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(write)
        .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
        .mockReturnValueOnce(noResults());

      const failure = service.update(user, SPACE, EXEC, { name: 'New' });

      await expect(failure).rejects.toBeInstanceOf(ConflictException);
      expect(write.update).toHaveBeenCalledWith({ updated_by: 'user-1' });
      expect(eqCalls(write)).toEqual(
        expect.arrayContaining([
          ['id', EXEC],
          ['space_id', SPACE],
          ['organization_id', ORG],
          ['is_archived', false],
        ]),
      );
    });

    it('allows an environment change after results exist', async () => {
      const write = buildChain({ data: { id: EXEC }, error: null });

      from
        .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(write)
        .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
        .mockReturnValueOnce(noResults());

      await service.update(user, SPACE, EXEC, { environment: 'Prod' });

      expect(write.update).toHaveBeenCalledWith({
        environment: 'Prod',
        updated_by: 'user-1',
      });
      expect(from).toHaveBeenCalledTimes(5);
    });

    it('lets the same environment through without checking results', async () => {
      from
        .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(buildChain({ data: { id: EXEC }, error: null }))
        .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
        .mockReturnValueOnce(noResults());

      await service.update(user, SPACE, EXEC, { environment: 'QA' });

      // Load, write and reload only; a results check would be a sixth read.
      expect(from).toHaveBeenCalledTimes(5);
    });
  });

  describe('update with a linked ticket', () => {
    const withDescription = {
      ...executionRow,
      task: { ...executionRow.task, description: '<p>Notes</p>' },
    };

    beforeEach(() => {
      service = linked();
    });

    it('sends the new name to the ticket', async () => {
      const write = buildChain({ data: { id: EXEC }, error: null });

      from
        .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(write)
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...executionRow,
              task: { ...executionRow.task, summary: 'Sprint 2' },
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(noResults());

      const execution = await service.update(user, SPACE, EXEC, {
        name: 'Sprint 2',
      });

      expect(execution.name).toBe('Sprint 2');
      expect(write.update).toHaveBeenCalledWith({ updated_by: 'user-1' });
      expect(emitAsync).toHaveBeenCalledWith(TEST_RECORD_UPDATED_EVENT, {
        organizationId: ORG,
        taskId: 'task-1',
        userId: 'user-1',
        changes: { summary: 'Sprint 2' },
      });
    });

    it('sends nothing when the name and description are unchanged', async () => {
      from
        .mockReturnValueOnce(buildChain({ data: withDescription, error: null }))
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(buildChain({ data: { id: EXEC }, error: null }))
        .mockReturnValueOnce(buildChain({ data: withDescription, error: null }))
        .mockReturnValueOnce(noResults());

      await service.update(user, SPACE, EXEC, {
        name: 'Sprint',
        description: 'Notes',
      });

      expect(emitAsync).not.toHaveBeenCalled();
    });

    it.each([
      ['a <b\nc', '<p>a &lt;b</p><p>c</p>'],
      [null, ''],
    ])('sends description %j to the ticket as %j', async (text, html) => {
      from
        .mockReturnValueOnce(buildChain({ data: withDescription, error: null }))
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(buildChain({ data: { id: EXEC }, error: null }))
        .mockReturnValueOnce(buildChain({ data: withDescription, error: null }))
        .mockReturnValueOnce(noResults());

      await service.update(user, SPACE, EXEC, { description: text });

      expect(emitAsync).toHaveBeenCalledWith(
        TEST_RECORD_UPDATED_EVENT,
        expect.objectContaining({ changes: { description: html } }),
      );
    });

    it('writes only the environment, folder and updated_by on the record', async () => {
      const write = buildChain({ data: { id: EXEC }, error: null });

      from
        .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(buildChain({ data: { id: 'f1' }, error: null }))
        .mockReturnValueOnce(write)
        .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
        .mockReturnValueOnce(noResults());

      await service.update(user, SPACE, EXEC, {
        name: 'Sprint 2',
        description: 'New',
        environment: 'Prod',
        folder_id: 'f1',
      });

      expect(write.update).toHaveBeenCalledWith({
        environment: 'Prod',
        folder_id: 'f1',
        updated_by: 'user-1',
      });
    });

    it('fails when the ticket refuses the rename and makes no undo write', async () => {
      const refused = new BadRequestException('ticket locked');

      emitAsync.mockRejectedValueOnce(refused);
      from
        .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(buildChain({ data: { id: EXEC }, error: null }));

      await expect(
        service.update(user, SPACE, EXEC, { name: 'Sprint 2' }),
      ).rejects.toBe(refused);
      expect(from).toHaveBeenCalledTimes(3);
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    const counts = { runs: 2, attempts: 3, step_results: 4, evidence_files: 0 };

    beforeEach(() => {
      service = linked();
    });

    it.each([true, false])(
      'refuses an execution with results with 409 HAS_RESULTS (dry run %s)',
      async (dryRun) => {
        const results = buildChain({ data: null, error: null, count: 4 });

        from
          .mockReturnValueOnce(
            buildChain({
              data: { ...executionRow, task_id: 'task-1' },
              error: null,
            }),
          )
          .mockReturnValueOnce(noResults())
          .mockReturnValueOnce(results);

        const error: unknown = await service
          .remove(user, SPACE, EXEC, dryRun)
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'HAS_RESULTS',
          data: { results: 4 },
        });
        expect(from).toHaveBeenNthCalledWith(2, 'test_run_attempts');
        expect(eqCalls(results)).toEqual(
          expect.arrayContaining([
            ['space_id', SPACE],
            ['organization_id', ORG],
            ['run.execution_id', EXEC],
          ]),
        );
        expect(results.neq).toHaveBeenCalledWith('status', 'TODO');
        expect(rpc).not.toHaveBeenCalled();
        expect(emitAsync).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
      },
    );

    it('previews the delete without touching the ticket', async () => {
      from
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...executionRow,
              task_id: 'task-1',
              task: { key: 'P-T9', summary: 'Sprint', description: null },
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 }));
      rpc.mockResolvedValueOnce({
        data: { deleted: false, counts, storage_paths: [] },
        error: null,
      });

      await expect(service.remove(user, SPACE, EXEC, true)).resolves.toEqual({
        dry_run: true,
        counts,
        ticket_key: 'P-T9',
      });
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, {
        write: false,
      });
      expect(rpc).toHaveBeenCalledWith('tm_delete_execution', {
        p_organization_id: ORG,
        p_space_id: SPACE,
        p_actor_id: 'user-1',
        p_execution_id: EXEC,
        p_dry_run: true,
      });
      expect(emitAsync).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('reads the counts from the dry run, then deletes the ticket and audits it', async () => {
      from
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...executionRow,
              task_id: 'task-1',
              task: { key: 'P-T9', summary: 'Sprint', description: null },
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 }));
      rpc.mockResolvedValueOnce({
        data: { deleted: false, counts, storage_paths: [] },
        error: null,
      });

      await expect(service.remove(user, SPACE, EXEC, false)).resolves.toEqual({
        dry_run: false,
        counts,
        ticket_key: 'P-T9',
      });
      expect(emitAsync).toHaveBeenCalledWith(TEST_RECORD_DELETED_EVENT, {
        organizationId: ORG,
        taskId: 'task-1',
        userId: 'user-1',
      });
      expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(
        emitAsync.mock.invocationCallOrder[0],
      );

      // The database removes the execution with its ticket, so there is no second call.
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith(
        'tm_delete_execution',
        expect.objectContaining({ p_execution_id: EXEC, p_dry_run: true }),
      );
      expect(log).toHaveBeenCalledWith(user, 'test_execution', EXEC, 'delete', {
        space_id: SPACE,
        key: 'P-T9',
        counts,
        ticket_key: 'P-T9',
      });
    });

    it('does not delete the ticket when the dry run fails', async () => {
      from
        .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 }));
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'P0002', message: 'tm: execution not found' },
      });

      await expect(
        service.remove(user, SPACE, EXEC, false),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(emitAsync).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('writes no audit when the ticket cannot be deleted', async () => {
      emitAsync.mockRejectedValueOnce(new ForbiddenException());
      from
        .mockReturnValueOnce(
          buildChain({
            data: { ...executionRow, task_id: 'task-1' },
            error: null,
          }),
        )
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(buildChain({ data: null, error: null, count: 0 }));
      rpc.mockResolvedValueOnce({
        data: { deleted: false, counts, storage_paths: [] },
        error: null,
      });

      await expect(
        service.remove(user, SPACE, EXEC, false),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    });

    it('answers 404 for a foreign execution before counting results', async () => {
      from.mockReturnValueOnce(buildChain({ data: null, error: null }));

      await expect(
        service.remove(user, SPACE, EXEC, true),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(from).toHaveBeenCalledTimes(1);
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  it('suggests environments newest first, case variants once', async () => {
    from.mockReturnValueOnce(
      buildChain({
        data: [
          { environment: 'QA' },
          { environment: 'qa' },
          { environment: 'Prod' },
        ],
        error: null,
      }),
    );

    expect(await service.environments(ORG, SPACE)).toEqual(['QA', 'Prod']);
  });

  it('counts the current attempt of each run per status', async () => {
    from
      .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
      .mockReturnValueOnce(noResults())
      .mockReturnValueOnce(
        buildChain({
          data: [
            {
              current_attempt_no: 2,
              attempts: [
                { attempt_no: 1, status: 'FAIL' },
                { attempt_no: 2, status: 'PASS' },
              ],
            },
            {
              current_attempt_no: 1,
              attempts: [{ attempt_no: 1, status: 'TODO' }],
            },
          ],
          error: null,
        }),
      );

    const detail = await service.get(ORG, SPACE, EXEC);

    expect(detail.status_counts).toEqual(
      expect.objectContaining({ PASS: 1, TODO: 1, FAIL: 0 }),
    );
    expect(detail.created_by).toEqual({
      id: 'user-1',
      name: 'Ann Lee',
      avatar_url: null,
    });
    expect(detail.run_count).toBe(2);
  });

  describe('summary', () => {
    const ann = {
      id: 'u-ann',
      first_name: 'Ann',
      last_name: 'Lee',
      email: 'ann@x.io',
    };
    const bob = {
      id: 'u-bob',
      first_name: 'Bob',
      last_name: 'Ray',
      email: 'bob@x.io',
    };
    const runs = [
      {
        current_attempt_no: 2,
        assignee: ann,
        attempts: [
          { attempt_no: 1, status: 'FAIL', actual_minutes: 9 },
          { attempt_no: 2, status: 'PASS', actual_minutes: 30 },
        ],
      },
      {
        current_attempt_no: 1,
        assignee: ann,
        attempts: [{ attempt_no: 1, status: 'FAIL', actual_minutes: null }],
      },
      {
        current_attempt_no: 1,
        assignee: null,
        attempts: [{ attempt_no: 1, status: 'TODO', actual_minutes: null }],
      },
      {
        current_attempt_no: 1,
        assignee: bob,
        attempts: [
          { attempt_no: 1, status: 'NOT_APPLICABLE', actual_minutes: 5 },
        ],
      },
    ];

    it('starts at the first started attempt and ends only when every run is final', async () => {
      const timed = (
        status: string,
        started: string | null,
        finished: string | null,
      ) => ({
        current_attempt_no: 1,
        assignee: ann,
        attempts: [
          {
            attempt_no: 1,
            status,
            actual_minutes: null,
            started_at: started,
            finished_at: finished,
          },
        ],
      });
      const open = [
        timed('PASS', '2026-10-21T10:05:00Z', '2026-10-21T10:20:00Z'),
        timed('EXECUTING', '2026-10-21T10:00:00Z', null),
      ];
      const done = [
        timed('PASS', '2026-10-21T10:05:00Z', '2026-10-21T10:20:00Z'),
        timed('FAIL', '2026-10-21T10:00:00Z', '2026-10-21T10:30:00Z'),
      ];

      byTable(from, {
        test_executions: [
          { data: executionRow, error: null },
          { data: executionRow, error: null },
        ],
        test_runs: [
          { data: open, error: null },
          { data: open, error: null },
          { data: done, error: null },
          { data: done, error: null },
        ],
      });

      const running = await service.summary(ORG, SPACE, EXEC);
      const finished = await service.summary(ORG, SPACE, EXEC);

      expect(running.started_at).toBe('2026-10-21T10:00:00Z');
      expect(running.finished_at).toBeNull();
      expect(finished.started_at).toBe('2026-10-21T10:00:00Z');
      expect(finished.finished_at).toBe('2026-10-21T10:30:00Z');
    });

    it('summarises counts, progress, testers and minutes', async () => {
      const chains = byTable(from, {
        test_executions: [{ data: executionRow, error: null }],
        test_runs: [
          { data: runs, error: null },
          { data: runs, error: null },
        ],
      });

      const summary = await service.summary(ORG, SPACE, EXEC);

      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE);
      expect(summary).toEqual({
        execution_id: EXEC,
        started_at: null,
        finished_at: null,
        total_runs: 4,
        status_counts: {
          TODO: 1,
          EXECUTING: 0,
          PASS: 1,
          FAIL: 1,
          BLOCKED: 0,
          ABORTED: 0,
          NOT_APPLICABLE: 1,
        },
        final_ratio: 0.75,
        success_rate: 0.3333,
        by_tester: [
          { user_id: 'u-ann', name: 'Ann Lee', total: 2, final: 2 },
          { user_id: null, name: null, total: 1, final: 0 },
          { user_id: 'u-bob', name: 'Bob Ray', total: 1, final: 1 },
        ],
        actual_minutes: { total: 35, recorded: 2, measured: 0 },
      });
      expect(eqCalls(chains.test_runs[1])).toEqual(
        expect.arrayContaining([
          ['execution_id', EXEC],
          ['space_id', SPACE],
          ['organization_id', ORG],
        ]),
      );
    });

    it('has no success rate when every run is not applicable', async () => {
      const allNa = [
        {
          current_attempt_no: 1,
          assignee: null,
          attempts: [
            { attempt_no: 1, status: 'NOT_APPLICABLE', actual_minutes: null },
          ],
        },
      ];

      byTable(from, {
        test_executions: [{ data: executionRow, error: null }],
        test_runs: [
          { data: allNa, error: null },
          { data: allNa, error: null },
        ],
      });

      const summary = await service.summary(ORG, SPACE, EXEC);

      expect(summary.success_rate).toBeNull();
      expect(summary.final_ratio).toBe(1);
      expect(summary.actual_minutes).toEqual({
        total: 0,
        recorded: 0,
        measured: 0,
      });
    });

    it('counts an empty execution as zero without dividing by zero', async () => {
      byTable(from, { test_executions: [{ data: executionRow, error: null }] });

      const summary = await service.summary(ORG, SPACE, EXEC);

      expect(summary.total_runs).toBe(0);
      expect(summary.final_ratio).toBe(0);
      expect(summary.success_rate).toBeNull();
      expect(summary.by_tester).toEqual([]);
    });

    it('adds measured time when no minutes were typed', async () => {
      const timed = [
        {
          case_id: 'c1',
          current_attempt_no: 1,
          assignee: null,
          attempts: [
            {
              attempt_no: 1,
              status: 'PASS',
              actual_minutes: null,
              started_at: '2026-10-21T10:00:00Z',
              finished_at: '2026-10-21T10:12:00Z',
            },
          ],
        },
        {
          case_id: 'c2',
          current_attempt_no: 1,
          assignee: null,
          attempts: [{ attempt_no: 1, status: 'FAIL', actual_minutes: 5 }],
        },
      ];

      byTable(from, {
        test_executions: [{ data: executionRow, error: null }],
        test_runs: [
          { data: timed, error: null },
          { data: timed, error: null },
        ],
      });

      const summary = await service.summary(ORG, SPACE, EXEC);

      expect(summary.actual_minutes).toEqual({
        total: 17,
        recorded: 1,
        measured: 1,
      });
    });

    it('answers 404 for an execution of another space and reads nothing else', async () => {
      const chains = byTable(from, {
        test_executions: [{ data: null, error: null }],
      });

      await expect(service.summary(ORG, SPACE, EXEC)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(chains.test_runs).toBeUndefined();
    });
  });

  describe('ticketed list', () => {
    it('lists only executions with a ticket when ticketed is set', async () => {
      const rows = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(rows);

      await service.list(ORG, SPACE, { ticketed: true });

      expect(rows.not).toHaveBeenCalledWith('task_id', 'is', null);
    });

    it('lists only the execution of a ticket when taskId is given', async () => {
      const rows = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(rows);

      await service.list(ORG, SPACE, { taskId: 'task-9' });

      expect(eqCalls(rows)).toContainEqual(['task_id', 'task-9']);
    });

    it('keeps executions without a ticket when ticketed is not set', async () => {
      const rows = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(rows);

      await service.list(ORG, SPACE, {});

      expect(rows.not).not.toHaveBeenCalled();
    });
  });

  describe('tickets without an execution', () => {
    const settings: Resolved = {
      data: { execution_task_type_id: 'type-exec' },
      error: null,
    };
    const ticket = (id: string) => ({
      id,
      key: `P-${id}`,
      summary: `Ticket ${id}`,
      created_at: '2026-10-29T00:00:00Z',
    });

    it('returns nothing and reads no tasks when the space has no execution type', async () => {
      const chains = byTable(from, {
        test_management_space_settings: [{ data: null, error: null }],
      });

      await expect(
        service.ticketsWithoutExecution(ORG, SPACE, {}),
      ).resolves.toEqual({ items: [], total: 0 });
      expect(chains.tasks).toBeUndefined();
    });

    it('lists only the tickets of the execution type that have no execution', async () => {
      const chains = byTable(from, {
        test_management_space_settings: [settings],
        tasks: [{ data: [ticket('t1'), ticket('t2')], error: null }],
        test_executions: [{ data: [{ task_id: 't1' }], error: null }],
      });

      const result = await service.ticketsWithoutExecution(ORG, SPACE, {});

      expect(result).toEqual({
        items: [
          {
            task_id: 't2',
            key: 'P-t2',
            summary: 'Ticket t2',
            created_at: '2026-10-29T00:00:00Z',
          },
        ],
        total: 1,
      });
      expect(eqCalls(chains.tasks[0])).toEqual(
        expect.arrayContaining([
          ['space_id', SPACE],
          ['organization_id', ORG],
          ['task_type_id', 'type-exec'],
        ]),
      );
      expect(chains.tasks[0].order).toHaveBeenCalledWith('created_at', {
        ascending: false,
      });
      expect(chains.test_executions[0].in).toHaveBeenCalledWith('task_id', [
        't1',
        't2',
      ]);
    });

    it('searches the ticket key and summary', async () => {
      const chains = byTable(from, {
        test_management_space_settings: [settings],
        tasks: [{ data: [], error: null }],
      });

      await service.ticketsWithoutExecution(ORG, SPACE, { q: 'T74' });

      expect(chains.tasks[0].or).toHaveBeenCalledWith(
        expect.stringContaining('key.ilike.'),
      );
      expect(chains.tasks[0].or).toHaveBeenCalledWith(
        expect.stringContaining('summary.ilike.'),
      );
    });
  });

  describe('folders', () => {
    const FOLDER = 'folder-1';

    it('lists only the executions in a folder when folderId is given', async () => {
      const rows = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(rows);

      await service.list(ORG, SPACE, { folderId: FOLDER });

      expect(eqCalls(rows)).toContainEqual(['folder_id', FOLDER]);
    });

    it('moves the execution to a folder of the space and returns its folder', async () => {
      const folder = buildChain({ data: { id: FOLDER }, error: null });
      const saved = buildChain({
        data: { ...executionRow, folder_id: FOLDER },
        error: null,
      });

      from
        .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(folder)
        .mockReturnValueOnce(saved)
        .mockReturnValueOnce(
          buildChain({
            data: { ...executionRow, folder_id: FOLDER },
            error: null,
          }),
        )
        .mockReturnValueOnce(noResults());

      const result = await service.update(user, SPACE, EXEC, {
        folder_id: FOLDER,
      });

      expect(eqCalls(folder)).toEqual(
        expect.arrayContaining([
          ['id', FOLDER],
          ['space_id', SPACE],
          ['organization_id', ORG],
        ]),
      );
      expect((saved.update.mock.calls as unknown[][])[0]?.[0]).toEqual({
        folder_id: FOLDER,
        updated_by: 'user-1',
      });
      expect(result.folder_id).toBe(FOLDER);
    });
  });

  describe('list ticket key', () => {
    it('reads the linked ticket key in the list query', async () => {
      const rows = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(rows);

      await service.list(ORG, SPACE, {});

      expect((rows.select.mock.calls as unknown[][])[0][0]).toContain(
        'task:tasks!test_executions_task_id_fkey!inner(key, summary, description)',
      );
    });

    it('returns the ticket key and drops the raw task', async () => {
      from
        .mockReturnValueOnce(
          buildChain({
            data: [
              {
                ...executionRow,
                task: { key: 'P-T7', summary: 'One', description: null },
              },
              {
                ...executionRow,
                id: 'exec-2',
                task: { key: 'P-T8', summary: 'Two', description: null },
              },
            ],
            error: null,
            count: 2,
          }),
        )
        .mockReturnValueOnce(buildChain({ data: [], error: null }));

      const page = await service.list(ORG, SPACE, {});

      expect(page.items.map((e) => e.task_key)).toEqual(['P-T7', 'P-T8']);
      expect(page.items[0]).not.toHaveProperty('task');
      expect(page.items[1]).not.toHaveProperty('task');
    });
  });

  describe('fields from the ticket', () => {
    it('keeps the API field names and turns the ticket description into plain text', async () => {
      from
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...executionRow,
              plan: {
                id: 'plan-1',
                task: { key: 'P-TP1', summary: ' Release ' },
              },
              task: {
                key: 'P-T12',
                summary: ' Sprint ',
                description: '<p>Line &amp; one</p><p>Two</p>',
              },
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(buildChain({ data: [], error: null }));

      const detail = await service.get(ORG, SPACE, EXEC);

      expect(detail).toMatchObject({
        key: 'P-T12',
        key_number: 12,
        task_key: 'P-T12',
        name: 'Sprint',
        description: 'Line & one\nTwo',
        plan: {
          id: 'plan-1',
          key: 'P-TP1',
          name: 'Release',
          task_key: 'P-TP1',
        },
      });
    });

    it('shows an empty ticket description as no description', async () => {
      from
        .mockReturnValueOnce(
          buildChain({
            data: {
              ...executionRow,
              task: { ...executionRow.task, description: '<p></p>' },
            },
            error: null,
          }),
        )
        .mockReturnValueOnce(noResults())
        .mockReturnValueOnce(buildChain({ data: [], error: null }));

      expect((await service.get(ORG, SPACE, EXEC)).description).toBeNull();
    });
  });

  describe('list sort and search', () => {
    it.each([
      [
        'newest first by default',
        undefined,
        [
          ['created_at', { ascending: false }],
          ['id', { ascending: false }],
        ],
      ],
      [
        'newest first for an unknown field',
        'nope:asc',
        [
          ['created_at', { ascending: false }],
          ['id', { ascending: false }],
        ],
      ],
      [
        'name by the ticket summary',
        'name:asc',
        [
          ['task(summary)', { ascending: true }],
          ['created_at', { ascending: false }],
          ['id', { ascending: false }],
        ],
      ],
    ])('sorts %s', async (_label, sort, expected) => {
      const rows = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(rows);

      await service.list(ORG, SPACE, { sort });

      expect(rows.order.mock.calls).toEqual(expected);
    });

    it('searches the ticket key and summary through the embed', async () => {
      const rows = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(rows);

      await service.list(ORG, SPACE, { q: 'smoke' });

      expect(rows.or).toHaveBeenCalledWith(
        'key.ilike."%smoke%",summary.ilike."%smoke%"',
        { referencedTable: 'task' },
      );
    });
  });

  describe('list filters', () => {
    const USER = '7d1f3c0e-2b4a-4c5d-9e6f-1a2b3c4d5e6f';

    it.each<[ExecutionSourceFilter, unknown[][], unknown[][], unknown[][]]>([
      ['plan', [['source', 'manual']], [['plan_id', 'is', null]], []],
      ['ad_hoc', [['source', 'manual']], [], [['plan_id', null]]],
      ['run_now', [['source', 'run_now']], [], []],
      ['junit', [['source', 'junit']], [], []],
    ])('source %s', async (source, eqs, nots, iss) => {
      const rows = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(rows);

      await service.list(ORG, SPACE, { source });

      expect(eqCalls(rows)).toEqual(expect.arrayContaining(eqs));
      expect(rows.not.mock.calls).toEqual(nots);
      expect(rows.is.mock.calls).toEqual(iss);
    });

    it('environment and creator', async () => {
      const rows = buildChain({ data: [], error: null, count: 0 });

      from.mockReturnValueOnce(rows);

      await service.list(ORG, SPACE, {
        environment: 'staging',
        createdBy: USER,
      });

      expect(eqCalls(rows)).toEqual(
        expect.arrayContaining([
          ['environment', 'staging'],
          ['created_by', USER],
        ]),
      );
      expect(eqCalls(rows).map(([column]) => column)).not.toContain('source');
    });

    it('applies the filters to the key number sort too', async () => {
      const chains = byTable(from, {
        test_executions: [{ data: [], error: null }],
      });

      await service.list(ORG, SPACE, { sort: 'key:desc', source: 'junit' });

      expect(eqCalls(chains.test_executions[0])).toContainEqual([
        'source',
        'junit',
      ]);
    });
  });

  describe('list key number sort and attempt count', () => {
    const keyed = (id: string, key: string) => ({
      ...executionRow,
      id,
      task: { ...executionRow.task, key },
    });

    const rows = [
      keyed('a', 'P-TE773'),
      keyed('b', 'P-TE1002'),
      keyed('c', 'P-TE9'),
    ];

    it.each([
      ['key:desc', ['P-TE1002', 'P-TE773', 'P-TE9']],
      ['key:asc', ['P-TE9', 'P-TE773', 'P-TE1002']],
    ])('sorts %s by the key number', async (sort, expected) => {
      byTable(from, {
        test_executions: [
          { data: rows, error: null },
          { data: rows, error: null },
        ],
      });

      const page = await service.list(ORG, SPACE, { sort });

      expect(page.items.map((item) => item.key)).toEqual(expected);
      expect(page.total).toBe(3);
    });

    it('adds up the attempts of every run, 0 without runs', async () => {
      byTable(from, {
        test_executions: [
          {
            data: [
              {
                ...executionRow,
                attempts: [
                  { current_attempt_no: 2 },
                  { current_attempt_no: 3 },
                ],
              },
              { ...executionRow, id: 'exec-2', attempts: [] },
            ],
            error: null,
            count: 2,
          },
        ],
      });

      const page = await service.list(ORG, SPACE, {});

      expect(page.items.map((item) => item.attempt_count)).toEqual([5, 0]);
    });
  });

  describe('has results', () => {
    it('marks only the listed executions with a started or finished attempt', async () => {
      const attempts = buildChain({
        data: [
          { run: { execution_id: 'exec-2' } },
          { run: { execution_id: 'exec-2' } },
        ],
        error: null,
      });

      from
        .mockReturnValueOnce(
          buildChain({
            data: [executionRow, { ...executionRow, id: 'exec-2' }],
            error: null,
            count: 2,
          }),
        )
        .mockReturnValueOnce(attempts);

      const page = await service.list(ORG, SPACE, {});

      expect(page.items.map((e) => e.has_results)).toEqual([false, true]);
      expect(from).toHaveBeenNthCalledWith(2, 'test_run_attempts');
      expect(attempts.in).toHaveBeenCalledWith('run.execution_id', [
        EXEC,
        'exec-2',
      ]);
      expect(attempts.neq).toHaveBeenCalledWith('status', 'TODO');
      expect(eqCalls(attempts)).toEqual(
        expect.arrayContaining([
          ['space_id', SPACE],
          ['organization_id', ORG],
        ]),
      );
    });

    it('skips the results read for an empty page', async () => {
      from.mockReturnValueOnce(buildChain({ data: [], error: null, count: 0 }));

      await service.list(ORG, SPACE, {});

      expect(from).not.toHaveBeenCalledWith('test_run_attempts');
    });

    it.each([
      [0, false],
      [3, true],
    ])('get returns has_results for %s results', async (results, expected) => {
      const count = buildChain({ data: null, error: null, count: results });

      from
        .mockReturnValueOnce(buildChain({ data: executionRow, error: null }))
        .mockReturnValueOnce(count)
        .mockReturnValueOnce(buildChain({ data: [], error: null }));

      const detail = await service.get(ORG, SPACE, EXEC);

      expect(detail.has_results).toBe(expected);
      expect(eqCalls(count)).toContainEqual(['run.execution_id', EXEC]);
      expect(count.neq).toHaveBeenCalledWith('status', 'TODO');
    });
  });

  describe('addTicketFields', () => {
    let getById: jest.Mock;
    let update: jest.Mock;

    const field = (
      field_key: string,
      field_type: string,
      extra: Record<string, unknown> = {},
    ) => ({
      field_key,
      field_type,
      name: field_key,
      validation_rules: {},
      options: [],
      contexts: ['task'],
      ...extra,
    });

    const withTasks = () =>
      new TestExecutionsService(
        { getClient: () => ({ from, rpc }) } as unknown as SupabaseAdminService,
        { assertAvailable } as unknown as TestManagementAccessService,
        {} as unknown as TesterEligibilityService,
        { logActionForRequest: log } as unknown as AuditLogsService,
        { checkPermission } as unknown as PermissionsService,
        { getById, update } as unknown as TasksService,
      );

    beforeEach(() => {
      getById = jest.fn().mockResolvedValue({
        labels: ['smoke', 'nightly'],
        custom_field_values: { build: '41' },
      });
      update = jest.fn().mockResolvedValue({});
    });

    it('appends only new labels and saves the fields an upload may fill', async () => {
      const chains = byTable(from, {
        test_executions: [{ data: executionRow, error: null }],
        test_run_attempts: [{ data: null, error: null, count: 0 }],
        custom_fields: [
          {
            data: [
              field('build', 'string'),
              field('browser', 'select', {
                options: [{ value: 'chrome', label: 'Chrome' }],
              }),
              field('owner', 'user_select'),
              field('stage', 'select', {
                options: [{ value: 'qa', label: 'QA' }],
              }),
              field('sprint', 'number', { contexts: '["task"]' }),
              field('asset_note', 'string', { contexts: ['asset'] }),
            ],
            error: null,
          },
        ],
      });

      const saved = await withTasks().addTicketFields(user, SPACE, EXEC, {
        labels: ['nightly', 'ci'],
        customFields: {
          build: '42',
          browser: 'chrome',
          owner: 'user-2',
          stage: 'prod',
          sprint: 7,
          asset_note: 'x',
          missing: 1,
        },
      });

      expect(saved).toEqual({
        ticketKey: 'P-TE1',
        unknownFields: ['asset_note', 'missing'],
        refusedFields: ['owner'],
        invalidFields: ['stage'],
        labelsCapped: false,
      });
      expect(update).toHaveBeenCalledWith('task-1', ORG, 'user-1', {
        labels: ['smoke', 'nightly', 'ci'],
        custom_field_values: { build: '42', browser: 'chrome', sprint: 7 },
      });

      const fields = chains.custom_fields[0];

      expect(eqCalls(fields)).toEqual(
        expect.arrayContaining([
          ['organization_id', ORG],
          ['is_active', true],
        ]),
      );
      expect(fields.or).toHaveBeenCalledWith(
        `space_id.eq.${SPACE},space_id.is.null`,
      );
      expect(fields.in).toHaveBeenCalledWith('field_key', [
        'build',
        'browser',
        'owner',
        'stage',
        'sprint',
        'asset_note',
        'missing',
      ]);
    });

    it('never rewrites existing labels and stops at 50', async () => {
      const full = Array.from({ length: 49 }, (_, i) => `Old ${i}`);

      getById.mockResolvedValue({ labels: full, custom_field_values: {} });
      byTable(from, {
        test_executions: [{ data: executionRow, error: null }],
        test_run_attempts: [{ data: null, error: null, count: 0 }],
      });

      const saved = await withTasks().addTicketFields(user, SPACE, EXEC, {
        labels: ['a', 'b'],
        customFields: {},
      });

      expect(saved.labelsCapped).toBe(true);
      expect(update).toHaveBeenCalledWith('task-1', ORG, 'user-1', {
        labels: [...full, 'a'],
      });
      expect(from).not.toHaveBeenCalledWith('custom_fields');
    });

    it('writes nothing when every label is already there', async () => {
      byTable(from, {
        test_executions: [{ data: executionRow, error: null }],
        test_run_attempts: [{ data: null, error: null, count: 0 }],
      });

      const saved = await withTasks().addTicketFields(user, SPACE, EXEC, {
        labels: ['smoke'],
        customFields: {},
      });

      expect(saved.ticketKey).toBe('P-TE1');
      expect(update).not.toHaveBeenCalled();
    });

    it('reports no ticket when tickets cannot be written', async () => {
      byTable(from, {
        test_executions: [{ data: executionRow, error: null }],
        test_run_attempts: [{ data: null, error: null, count: 0 }],
      });

      const saved = await service.addTicketFields(user, SPACE, EXEC, {
        labels: ['ci'],
        customFields: { build: '1' },
      });

      expect(saved.ticketKey).toBeNull();
      expect(from).not.toHaveBeenCalledWith('custom_fields');
    });

    it('is a 404 for an execution of another space', async () => {
      byTable(from, { test_executions: [NONE] });

      await expect(
        withTasks().addTicketFields(user, SPACE, EXEC, {
          labels: ['ci'],
          customFields: {},
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(update).not.toHaveBeenCalled();
    });
  });
});
