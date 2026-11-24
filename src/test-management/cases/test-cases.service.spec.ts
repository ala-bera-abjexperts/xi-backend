import type { HttpException, Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TasksService } from '../../tasks/tasks.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import type { TesterEligibilityService } from '../common/tester-eligibility.service';
import {
  BulkTestCasesDto,
  CreateTestCaseDto,
  ListTestCasesQueryDto,
  TestCaseHistoryQueryDto,
  UpdateTestCaseDto,
} from '../dto/test-case.dto';
import { tmDbError, tmRpcError } from '../test-management-errors';
import { caseSort, TestCasesService } from './test-cases.service';

const SPACE = '11111111-1111-4111-8111-111111111111';
const FOLDER = '22222222-2222-4222-8222-222222222222';
const CASE_A = '33333333-3333-4333-8333-333333333333';
const CASE_B = '44444444-4444-4444-8444-444444444444';

async function errorsOf<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return errors.map((e) => e.property);
}

function toQuery(plain: Record<string, unknown>): ListTestCasesQueryDto {
  return plainToInstance(ListTestCasesQueryDto, plain);
}

describe('caseSort', () => {
  it('defaults to key ascending, sorted by created_at', () => {
    expect(caseSort()).toEqual({ column: 'created_at', ascending: true });
    expect(caseSort('key')).toEqual({ column: 'created_at', ascending: true });
  });

  it('reads the direction', () => {
    expect(caseSort('updated_at:desc')).toEqual({
      column: 'updated_at',
      ascending: false,
    });
    expect(caseSort('title:asc')).toEqual({
      column: 'task(summary)',
      ascending: true,
    });
  });

  it('falls back to the default for unknown fields', () => {
    expect(caseSort('constructor')).toEqual({
      column: 'created_at',
      ascending: true,
    });
    expect(caseSort('id;drop:desc')).toEqual({
      column: 'created_at',
      ascending: true,
    });
  });
});

describe('ListTestCasesQueryDto', () => {
  it('accepts every whitelisted sort with or without a direction', async () => {
    for (const sort of [
      'key',
      'title:asc',
      'readiness:desc',
      'created_at',
      'updated_at:desc',
    ]) {
      expect(await errorsOf(ListTestCasesQueryDto, { sort })).toEqual([]);
    }
  });

  it('rejects unknown sorts', async () => {
    for (const sort of ['id', 'key:up', 'title:desc:x', 'key_number', '']) {
      expect(await errorsOf(ListTestCasesQueryDto, { sort })).toEqual(['sort']);
    }
  });

  it('turns a single readiness into a list', async () => {
    expect(toQuery({ readiness: 'draft' }).readiness).toEqual(['draft']);
    expect(
      await errorsOf(ListTestCasesQueryDto, { readiness: 'draft' }),
    ).toEqual([]);
  });

  it('accepts repeated and comma-separated readiness, without duplicates', async () => {
    expect(toQuery({ readiness: ['draft', 'ready'] }).readiness).toEqual([
      'draft',
      'ready',
    ]);
    expect(toQuery({ readiness: 'ready, deprecated,ready' }).readiness).toEqual(
      ['ready', 'deprecated'],
    );
    expect(
      await errorsOf(ListTestCasesQueryDto, {
        readiness: ['draft,ready', 'deprecated', 'draft'],
      }),
    ).toEqual([]);
  });

  it('rejects unknown or empty readiness values', async () => {
    for (const readiness of ['done', 'draft,done', '', 'draft,']) {
      expect(await errorsOf(ListTestCasesQueryDto, { readiness })).toEqual([
        'readiness',
      ]);
    }
  });

  it('checks folderId and the q length', async () => {
    expect(await errorsOf(ListTestCasesQueryDto, { folderId: FOLDER })).toEqual(
      [],
    );
    expect(await errorsOf(ListTestCasesQueryDto, { folderId: 'nope' })).toEqual(
      ['folderId'],
    );
    expect(
      await errorsOf(ListTestCasesQueryDto, { q: 'x'.repeat(200) }),
    ).toEqual([]);
    expect(
      await errorsOf(ListTestCasesQueryDto, { q: 'x'.repeat(201) }),
    ).toEqual(['q']);
  });

  it('accepts a test type of 1 to 100 characters, trimmed', async () => {
    expect(toQuery({ testType: ' manual ' }).testType).toBe('manual');
    expect(
      await errorsOf(ListTestCasesQueryDto, { testType: 'x'.repeat(100) }),
    ).toEqual([]);

    for (const testType of ['', '   ', 'x'.repeat(101)]) {
      expect(await errorsOf(ListTestCasesQueryDto, { testType })).toEqual([
        'testType',
      ]);
    }
  });
});

describe('BulkTestCasesDto', () => {
  it('needs folder_id for move, null meaning the root', async () => {
    const base = { action: 'move', case_ids: [CASE_A] };

    expect(
      await errorsOf(BulkTestCasesDto, { ...base, folder_id: FOLDER }),
    ).toEqual([]);
    expect(
      await errorsOf(BulkTestCasesDto, { ...base, folder_id: null }),
    ).toEqual([]);
    expect(await errorsOf(BulkTestCasesDto, base)).toEqual(['folder_id']);
    expect(
      await errorsOf(BulkTestCasesDto, { ...base, folder_id: 'nope' }),
    ).toEqual(['folder_id']);
  });

  it('forbids folder_id for archive and restore', async () => {
    for (const action of ['archive', 'restore']) {
      expect(
        await errorsOf(BulkTestCasesDto, { action, case_ids: [CASE_A] }),
      ).toEqual([]);
      expect(
        await errorsOf(BulkTestCasesDto, {
          action,
          case_ids: [CASE_A],
          folder_id: FOLDER,
        }),
      ).toEqual(['folder_id']);
      expect(
        await errorsOf(BulkTestCasesDto, {
          action,
          case_ids: [CASE_A],
          folder_id: null,
        }),
      ).toEqual(['folder_id']);
    }
  });

  it('checks the action and the id list', async () => {
    const ids = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );

    expect(
      await errorsOf(BulkTestCasesDto, {
        action: 'archive',
        case_ids: ids(500),
      }),
    ).toEqual([]);
    expect(
      await errorsOf(BulkTestCasesDto, {
        action: 'archive',
        case_ids: ids(501),
      }),
    ).toEqual(['case_ids']);
    expect(
      await errorsOf(BulkTestCasesDto, { action: 'archive', case_ids: [] }),
    ).toEqual(['case_ids']);
    expect(
      await errorsOf(BulkTestCasesDto, {
        action: 'archive',
        case_ids: [CASE_A, CASE_A],
      }),
    ).toEqual(['case_ids']);
    expect(
      await errorsOf(BulkTestCasesDto, {
        action: 'archive',
        case_ids: ['nope'],
      }),
    ).toEqual(['case_ids']);
    expect(
      await errorsOf(BulkTestCasesDto, {
        action: 'delete',
        case_ids: [CASE_A],
      }),
    ).toEqual(['action']);
    expect(
      await errorsOf(BulkTestCasesDto, {
        action: 'archive',
        case_ids: [CASE_A],
        extra: 1,
      }),
    ).toEqual(['extra']);
  });
});

type Call = [string, unknown[]];

interface QueryResult {
  data?: unknown;
  error: { code?: string; message: string } | null;
  count?: number | null;
}

/** Records every builder call; `range` answers with the next queued result, awaiting the builder with the one after. */
function mockClient(results: QueryResult[]) {
  const calls: Call[][] = [];
  const rpc = jest.fn();

  const from = (...args: unknown[]) => {
    const log: Call[] = [['from', args]];

    calls.push(log);

    const builder: Record<string, unknown> = {};

    for (const name of ['select', 'eq', 'in', 'or', 'order', 'limit']) {
      builder[name] = (...a: unknown[]) => {
        log.push([name, a]);

        return builder;
      };
    }

    builder.range = (...a: unknown[]) => {
      log.push(['range', a]);

      return Promise.resolve(results.shift());
    };
    builder.maybeSingle = (...a: unknown[]) => {
      log.push(['maybeSingle', a]);

      return Promise.resolve(results.shift());
    };
    builder.then = (resolve: (value: unknown) => void) =>
      resolve(results.shift());

    return builder;
  };

  return { client: { from, rpc }, calls, rpc };
}

function makeService(results: QueryResult[] = []) {
  const mock = mockClient(results);
  const access = { assertAvailable: jest.fn().mockResolvedValue(undefined) };
  const auditLogs = {
    logActionForRequest: jest.fn().mockResolvedValue(undefined),
  };
  const emitAsync = jest.fn().mockResolvedValue([]);
  const tasks = {
    create: jest.fn().mockResolvedValue({ id: 'task-1', key: 'P-T1' }),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const permissions = { checkPermission: jest.fn().mockResolvedValue(true) };
  const service = new TestCasesService(
    { getClient: () => mock.client } as unknown as SupabaseAdminService,
    access as unknown as TestManagementAccessService,
    auditLogs as unknown as AuditLogsService,
    { emitAsync } as unknown as EventEmitter2,
    undefined,
    tasks as unknown as TasksService,
    permissions as unknown as PermissionsService,
  );

  return { service, access, auditLogs, emitAsync, tasks, permissions, ...mock };
}

const user = {
  organizationId: 'org-1',
  userId: 'user-1',
} as unknown as RequestUser;

describe('TestCasesService.list', () => {
  it('keeps the default query unchanged apart from the id tiebreak', async () => {
    const { service, calls } = makeService([
      { data: [], error: null, count: 0 },
    ]);

    await service.list('org-1', SPACE, toQuery({}));

    expect(calls[0].map(([name]) => name)).toEqual([
      'from',
      'select',
      'eq',
      'eq',
      'eq',
      'order',
      'order',
      'range',
    ]);
    expect(calls[0]).toContainEqual(['eq', ['is_archived', false]]);
    expect(calls[0]).toContainEqual([
      'order',
      ['created_at', { ascending: true }],
    ]);
    expect(calls[0]).toContainEqual(['order', ['id', { ascending: true }]]);
    expect(calls[0]).toContainEqual(['range', [0, 49]]);
  });

  it('reads who last changed each case and passes it on', async () => {
    const updater = {
      id: 'user-2',
      first_name: 'Ada',
      last_name: 'Lee',
      email: 'ada@example.com',
      avatar_url: null,
    };
    const { service, calls } = makeService([
      {
        data: [
          {
            id: 'c1',
            objective: null,
            task: { key: 'P-T1', summary: 'Login' },
            updater,
          },
        ],
        error: null,
        count: 1,
      },
    ]);

    const page = await service.list('org-1', SPACE, toQuery({}));
    const select = calls[0].find(([name]) => name === 'select');

    expect(String(select?.[1][0])).toContain(
      'updater:users!test_cases_updated_by_fkey(id, first_name, last_name, email, avatar_url)',
    );
    expect(page.items[0].updater).toEqual(updater);
  });

  it('reads the key, title and assignee of each case from its ticket', async () => {
    const assignee = {
      id: 'user-2',
      first_name: 'Ada',
      last_name: 'Lee',
      email: 'ada@example.com',
      avatar_url: null,
    };
    const { service, calls } = makeService([
      {
        data: [
          {
            id: 'c1',
            objective: 'Sign in',
            task: { key: 'P-T12', summary: '  Login ', assignee },
            updater: null,
          },
          {
            id: 'c2',
            objective: null,
            task: { key: 'P-T13', summary: 'Logout', assignee: null },
            updater: null,
          },
        ],
        error: null,
        count: 2,
      },
    ]);

    const page = await service.list('org-1', SPACE, toQuery({}));
    const select = calls[0].find(([name]) => name === 'select');

    expect(String(select?.[1][0])).toContain(
      'task:tasks!test_cases_task_id_fkey!inner(key, summary, assignee:users!tasks_assigned_to_fkey(',
    );
    expect(page.items[0]).toEqual({
      id: 'c1',
      key: 'P-T12',
      key_number: 12,
      task_key: 'P-T12',
      title: 'Login',
      assignee,
      objective_preview: 'Sign in',
      updater: null,
    });
    expect(page.items[1]).toMatchObject({
      title: 'Logout',
      assignee: null,
      objective_preview: null,
    });
  });

  it('applies folder, readiness, search and sort', async () => {
    const { service, calls } = makeService([
      { data: [], error: null, count: 0 },
    ]);

    await service.list(
      'org-1',
      SPACE,
      toQuery({
        folderId: FOLDER,
        readiness: 'draft,ready',
        q: 'login',
        sort: 'updated_at:desc',
        archived: 'true',
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        ['eq', ['is_archived', true]],
        ['eq', ['folder_id', FOLDER]],
        ['in', ['readiness', ['draft', 'ready']]],
        [
          'or',
          [
            'key.ilike."%login%",summary.ilike."%login%"',
            { referencedTable: 'task' },
          ],
        ],
        ['order', ['updated_at', { ascending: false }]],
        ['order', ['id', { ascending: true }]],
      ]),
    );
  });

  it('counts a page past the end with the same filters', async () => {
    const { service, calls } = makeService([
      { data: null, error: { code: 'PGRST103', message: 'range' } },
      { error: null, count: 7 },
    ]);

    const result = await service.list(
      'org-1',
      SPACE,
      toQuery({ folderId: FOLDER, readiness: 'ready', q: 'pay', page: '9' }),
    );

    expect(result).toEqual({ items: [], total: 7, page: 9, pageSize: 50 });
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        [
          'select',
          [
            'id, task:tasks!test_cases_task_id_fkey!inner(key)',
            { count: 'exact', head: true },
          ],
        ],
        ['eq', ['folder_id', FOLDER]],
        ['in', ['readiness', ['ready']]],
        [
          'or',
          [
            'key.ilike."%pay%",summary.ilike."%pay%"',
            { referencedTable: 'task' },
          ],
        ],
      ]),
    );
  });

  it('filters by test type only when one is given', async () => {
    const { service, calls } = makeService([
      { data: [], error: null, count: 0 },
      { data: [], error: null, count: 0 },
    ]);

    await service.list('org-1', SPACE, toQuery({ testType: 'cucumber' }));
    await service.list('org-1', SPACE, toQuery({}));

    expect(calls[0]).toEqual(
      expect.arrayContaining([['eq', ['test_type', 'cucumber']]]),
    );
    expect(calls[1]).not.toEqual(
      expect.arrayContaining([['eq', ['test_type', expect.anything()]]]),
    );
  });
});

describe('TestCasesService.history', () => {
  const HISTORY_ID = '55555555-5555-4555-8555-555555555555';
  const CHANGED_AT = '2026-10-19T10:00:00.123456+00:00';
  const caseRow = { data: { id: CASE_A }, error: null };
  const entries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `h-${i}`, revision: n - i }));

  it('returns the newest page in a stable order', async () => {
    const { service, calls } = makeService([
      caseRow,
      { data: entries(3), error: null },
    ]);

    const page = await service.history('org-1', SPACE, CASE_A);

    expect(page).toEqual({ items: entries(3), has_more: false });
    expect(calls[1].filter(([name]) => name === 'order')).toEqual([
      ['order', ['changed_at', { ascending: false }]],
      ['order', ['revision', { ascending: false }]],
      ['order', ['id', { ascending: false }]],
    ]);
    expect(calls[1]).toContainEqual(['limit', [31]]);
    expect(calls[1].some(([name]) => name === 'or')).toBe(false);
  });

  it('keeps 30 items and reports has_more only when a 31st row came back', async () => {
    const more = makeService([caseRow, { data: entries(31), error: null }]);
    const full = makeService([caseRow, { data: entries(30), error: null }]);

    const first = await more.service.history('org-1', SPACE, CASE_A);
    const second = await full.service.history('org-1', SPACE, CASE_A);

    expect(first.items).toHaveLength(30);
    expect(first.items).toEqual(entries(31).slice(0, 30));
    expect(first.has_more).toBe(true);
    expect(second.items).toHaveLength(30);
    expect(second.has_more).toBe(false);
  });

  it('continues after the cursor row', async () => {
    const { service, calls } = makeService([
      caseRow,
      {
        data: { id: HISTORY_ID, revision: 7, changed_at: CHANGED_AT },
        error: null,
      },
      { data: [], error: null },
    ]);

    await service.history('org-1', SPACE, CASE_A, HISTORY_ID);

    const lookup = calls.find((log) =>
      log.some(
        ([name, args]) =>
          name === 'select' && args[0] === 'id, revision, changed_at',
      ),
    );

    expect(lookup).toEqual(
      expect.arrayContaining([
        ['eq', ['id', HISTORY_ID]],
        ['eq', ['case_id', CASE_A]],
        ['eq', ['space_id', SPACE]],
        ['eq', ['organization_id', 'org-1']],
        ['maybeSingle', []],
      ]),
    );

    const filter = calls[1].find(([name]) => name === 'or')?.[1][0];

    expect(filter).toContain(`changed_at.lt."${CHANGED_AT}"`);
    expect(filter).toContain('revision.lt.7');
    expect(filter).toContain(`id.lt.${HISTORY_ID}`);
  });

  it('answers an unknown cursor with 404', async () => {
    const { service } = makeService([caseRow, { data: null, error: null }]);

    await expect(
      service.history('org-1', SPACE, CASE_A, HISTORY_ID),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('only accepts a uuid as the cursor', async () => {
    expect(await errorsOf(TestCaseHistoryQueryDto, {})).toEqual([]);
    expect(
      await errorsOf(TestCaseHistoryQueryDto, { before: HISTORY_ID }),
    ).toEqual([]);
    expect(await errorsOf(TestCaseHistoryQueryDto, { before: 'nope' })).toEqual(
      ['before'],
    );
  });
});

describe('TestCasesService.setAssignee', () => {
  function assigneeService(results: QueryResult[]) {
    const mock = mockClient(results);
    const access = { assertAvailable: jest.fn().mockResolvedValue(undefined) };
    const auditLogs = {
      logActionForRequest: jest.fn().mockResolvedValue(undefined),
    };
    const eligibility = {
      assertEligible: jest.fn().mockResolvedValue(undefined),
    };
    const emitAsync = jest.fn().mockResolvedValue([]);
    const service = new TestCasesService(
      { getClient: () => mock.client } as unknown as SupabaseAdminService,
      access as unknown as TestManagementAccessService,
      auditLogs as unknown as AuditLogsService,
      { emitAsync } as unknown as EventEmitter2,
      eligibility as unknown as TesterEligibilityService,
    );

    return { service, auditLogs, eligibility, emitAsync, rpc: mock.rpc };
  }

  const saved = {
    id: CASE_A,
    task_id: 'task-1',
    task: { key: 'TC-1', summary: 'Login', assignee: null },
  };

  it('checks the person, updates open work and reports what changed', async () => {
    const { service, rpc, eligibility, emitAsync, auditLogs } = assigneeService(
      [
        { data: saved, error: null },
        { data: saved, error: null },
      ],
    );

    rpc.mockResolvedValue({
      data: { changed: true, plan_tests: 2, runs: 3 },
      error: null,
    });

    const result = await service.setAssignee(user, SPACE, CASE_A, 'user-2');

    expect(eligibility.assertEligible).toHaveBeenCalledWith(
      'org-1',
      SPACE,
      'user-2',
    );
    expect(rpc).toHaveBeenCalledWith('tm_set_case_assignee', {
      p_organization_id: 'org-1',
      p_space_id: SPACE,
      p_actor_id: 'user-1',
      p_case_id: CASE_A,
      p_assignee_id: 'user-2',
    });
    expect(emitAsync).toHaveBeenCalledWith('tasks.test_record.updated', {
      organizationId: 'org-1',
      taskId: 'task-1',
      userId: 'user-1',
      changes: { assignedTo: 'user-2' },
    });
    expect(result).toMatchObject({
      changed: true,
      plan_tests: 2,
      runs: 3,
      ticket_warning: false,
    });
    expect(result.case.id).toBe(CASE_A);
    expect(auditLogs.logActionForRequest).toHaveBeenCalledTimes(1);
  });

  it('clears without a permission check and skips the audit when nothing changed', async () => {
    const { service, rpc, eligibility, emitAsync, auditLogs } = assigneeService(
      [{ data: saved, error: null }],
    );

    rpc.mockResolvedValue({
      data: { changed: false, plan_tests: 0, runs: 0 },
      error: null,
    });

    await service.setAssignee(user, SPACE, CASE_A, null);

    expect(eligibility.assertEligible).not.toHaveBeenCalled();
    expect(emitAsync).not.toHaveBeenCalled();
    expect(auditLogs.logActionForRequest).not.toHaveBeenCalled();
  });

  it('passes a change on to the ticket, and fails when the ticket refuses', async () => {
    const { service, rpc, emitAsync, auditLogs } = assigneeService([
      { data: saved, error: null },
    ]);

    emitAsync.mockRejectedValue(new Error('refused'));
    rpc.mockResolvedValue({
      data: { changed: true, plan_tests: 0, runs: 0 },
      error: null,
    });

    await expect(
      service.setAssignee(user, SPACE, CASE_A, 'user-2'),
    ).rejects.toThrow('refused');
    expect(emitAsync).toHaveBeenCalledWith(
      'tasks.test_record.updated',
      expect.objectContaining({
        taskId: 'task-1',
        changes: { assignedTo: 'user-2' },
      }),
    );
    expect(auditLogs.logActionForRequest).not.toHaveBeenCalled();
  });

  it('refuses someone who cannot run tests before anything is written', async () => {
    const { service, rpc, eligibility } = assigneeService([]);

    eligibility.assertEligible.mockRejectedValue(new Error('not eligible'));

    await expect(
      service.setAssignee(user, SPACE, CASE_A, 'user-3'),
    ).rejects.toThrow('not eligible');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('TestCasesService.get', () => {
  it('reads the key, title and assignee from the ticket', async () => {
    const { service, calls } = makeService([
      {
        data: {
          id: CASE_A,
          revision: 2,
          task_id: 'task-1',
          task: { key: 'P-T7', summary: ' Login ' },
        },
        error: null,
      },
    ]);

    const result = await service.get('org-1', SPACE, CASE_A);

    expect(result).toEqual({
      id: CASE_A,
      revision: 2,
      task_id: 'task-1',
      key: 'P-T7',
      key_number: 7,
      task_key: 'P-T7',
      title: 'Login',
      assignee: null,
    });
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        ['eq', ['id', CASE_A]],
        ['eq', ['space_id', SPACE]],
        ['eq', ['organization_id', 'org-1']],
      ]),
    );
  });
});

describe('TestCasesService.create', () => {
  const folderRow = { data: { id: FOLDER }, error: null };
  const settings = { data: { case_task_type_id: 'type-case' }, error: null };
  const newCase = { data: { id: CASE_A, revision: 1 }, error: null };
  const loaded = {
    data: { id: CASE_A, revision: 2, task: { key: 'P-T1', summary: 'Login' } },
    error: null,
  };
  const failed = {
    data: null,
    error: { code: 'P0002', message: 'tm: not found', details: null },
  };

  it('makes the ticket first, then adds what a ticket does not hold', async () => {
    const { service, tasks, rpc, calls, auditLogs } = makeService([
      folderRow,
      settings,
      newCase,
      loaded,
    ]);

    rpc.mockResolvedValue({ data: { changed: true }, error: null });

    const result = await service.create(user, SPACE, {
      title: 'Login',
      objective: '<4 items',
      estimate_minutes: 5,
      folder_id: FOLDER,
    });

    expect(calls[0]).toEqual(
      expect.arrayContaining([
        ['from', ['test_folders']],
        ['eq', ['id', FOLDER]],
        ['eq', ['space_id', SPACE]],
      ]),
    );
    expect(tasks.create).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      {
        summary: 'Login',
        description: '<p>&lt;4 items</p>',
        estimated_time: 5,
        space_id: SPACE,
        task_type_id: 'type-case',
      },
      { testRightChecked: true },
    );
    expect(calls[2]).toEqual(
      expect.arrayContaining([
        ['from', ['test_cases']],
        ['eq', ['task_id', 'task-1']],
        ['eq', ['organization_id', 'org-1']],
      ]),
    );
    expect(rpc).toHaveBeenCalledWith('tm_update_case', {
      p_organization_id: 'org-1',
      p_space_id: SPACE,
      p_actor_id: 'user-1',
      p_case_id: CASE_A,
      p_expected_revision: 1,
      p_patch: { objective: '<4 items', estimate_minutes: 5 },
    });
    expect(rpc).toHaveBeenCalledWith(
      'tm_bulk_update_cases',
      expect.objectContaining({
        p_case_ids: [CASE_A],
        p_action: 'move',
        p_folder_id: FOLDER,
      }),
    );
    expect(rpc).not.toHaveBeenCalledWith('tm_create_case', expect.anything());
    expect(result).toMatchObject({ id: CASE_A, key: 'P-T1', title: 'Login' });
    expect(tasks.delete).not.toHaveBeenCalled();
    expect(auditLogs.logActionForRequest).toHaveBeenCalledWith(
      user,
      'test_case',
      CASE_A,
      'create',
      { key: 'P-T1', title: 'Login', space_id: SPACE },
    );
  });

  it('needs no further save when only a title is given', async () => {
    const { service, tasks, rpc, calls } = makeService([
      settings,
      newCase,
      loaded,
    ]);

    await service.create(user, SPACE, { title: 'Login' });

    expect(tasks.create).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      {
        summary: 'Login',
        description: undefined,
        estimated_time: undefined,
        space_id: SPACE,
        task_type_id: 'type-case',
      },
      { testRightChecked: true },
    );
    expect(calls[0]).toContainEqual([
      'from',
      ['test_management_space_settings'],
    ]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('makes no ticket when the folder is missing', async () => {
    const { service, tasks } = makeService([{ data: null, error: null }]);

    await expect(
      service.create(user, SPACE, { title: 'Login', folder_id: FOLDER }),
    ).rejects.toMatchObject({
      status: 404,
      response: { data: { folder_id: FOLDER } },
    });
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it('refuses a user who cannot create tasks', async () => {
    const { service, tasks, permissions } = makeService();

    permissions.checkPermission.mockResolvedValue(false);

    await expect(
      service.create(user, SPACE, { title: 'Login' }),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'TICKET_CREATE_FORBIDDEN' },
    });
    expect(permissions.checkPermission).toHaveBeenCalledWith(
      'user-1',
      'org-1',
      'can_create_tasks',
    );
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it('refuses a space with no task type for test cases', async () => {
    const { service, tasks } = makeService([
      { data: { set_task_type_id: 'type-set' }, error: null },
    ]);

    await expect(
      service.create(user, SPACE, { title: 'Login' }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'TICKET_TYPE_MISSING' },
    });
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it('removes the ticket when the listener made no case', async () => {
    const { service, tasks, auditLogs } = makeService([
      settings,
      { data: null, error: null },
    ]);

    await expect(
      service.create(user, SPACE, { title: 'Login' }),
    ).rejects.toMatchObject({ response: { code: 'RECORD_NOT_CREATED' } });
    expect(tasks.delete).toHaveBeenCalledWith('task-1', 'org-1', 'user-1', {
      testRecordDeleted: true,
    });
    expect(auditLogs.logActionForRequest).not.toHaveBeenCalled();
  });

  it('removes the ticket when a later save fails', async () => {
    const { service, tasks, rpc, auditLogs } = makeService([settings, newCase]);

    rpc.mockResolvedValue(failed);

    await expect(
      service.create(user, SPACE, { title: 'Login', objective: 'Sign in' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(tasks.delete).toHaveBeenCalledWith('task-1', 'org-1', 'user-1', {
      testRecordDeleted: true,
    });
    expect(auditLogs.logActionForRequest).not.toHaveBeenCalled();
  });

  it('removes the ticket when the folder move fails', async () => {
    const { service, tasks, rpc } = makeService([folderRow, settings, newCase]);

    rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'tm_bulk_update_cases' ? failed : { data: {}, error: null },
      ),
    );

    await expect(
      service.create(user, SPACE, { title: 'Login', folder_id: FOLDER }),
    ).rejects.toMatchObject({ status: 404 });
    expect(tasks.delete).toHaveBeenCalledTimes(1);
  });

  it('keeps the first error when the ticket cannot be removed', async () => {
    const { service, tasks } = makeService([
      settings,
      { data: null, error: null },
    ]);

    tasks.delete.mockRejectedValue(new Error('delete failed'));

    await expect(
      service.create(user, SPACE, { title: 'Login' }),
    ).rejects.toMatchObject({ response: { code: 'RECORD_NOT_CREATED' } });
  });
});

describe('TestCasesService.update title and estimate', () => {
  const row = (revision: number, summary: string) => ({
    data: {
      id: CASE_A,
      revision,
      task_id: 'task-1',
      task: { key: 'P-T1', summary },
    },
    error: null,
  });
  const dto = (fields: Record<string, unknown>) =>
    plainToInstance(UpdateTestCaseDto, { expected_revision: 3, ...fields });
  const nothing = {
    data: { changed: false, revision: 3, changes: {} },
    error: null,
  };

  it('sends a changed title to the ticket and still checks the revision', async () => {
    const { service, rpc, emitAsync, auditLogs } = makeService([
      row(3, 'Old'),
      { data: { id: CASE_A, task_id: 'task-1' }, error: null },
      row(4, 'New'),
    ]);

    rpc.mockResolvedValue(nothing);

    const result = await service.update(
      user,
      SPACE,
      CASE_A,
      dto({ title: 'New' }),
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('tm_update_case', {
      p_organization_id: 'org-1',
      p_space_id: SPACE,
      p_actor_id: 'user-1',
      p_case_id: CASE_A,
      p_expected_revision: 3,
      p_patch: {},
    });
    expect(emitAsync).toHaveBeenCalledTimes(1);
    expect(emitAsync).toHaveBeenCalledWith('tasks.test_record.updated', {
      organizationId: 'org-1',
      taskId: 'task-1',
      userId: 'user-1',
      changes: { summary: 'New' },
    });
    expect(result).toMatchObject({ changed: true, revision: 4 });
    expect(result.case.title).toBe('New');
    expect(auditLogs.logActionForRequest).toHaveBeenCalledWith(
      user,
      'test_case',
      CASE_A,
      'update',
      {
        space_id: SPACE,
        revision: 4,
        changes: { title: { from: 'Old', to: 'New' } },
      },
    );
  });

  it('leaves the ticket alone when the title did not change', async () => {
    const { service, rpc, emitAsync, auditLogs } = makeService([
      row(3, 'Same'),
    ]);

    rpc.mockResolvedValue(nothing);

    const result = await service.update(
      user,
      SPACE,
      CASE_A,
      dto({ title: ' Same ' }),
    );

    expect(emitAsync).not.toHaveBeenCalled();
    expect(result).toMatchObject({ changed: false, revision: 3 });
    expect(auditLogs.logActionForRequest).not.toHaveBeenCalled();
  });

  it('makes no ticket update when the revision check fails', async () => {
    const { service, rpc, emitAsync } = makeService();

    rpc.mockResolvedValue({
      data: null,
      error: { code: 'TM001', message: 'tm: conflict', details: null },
    });

    await expect(
      service.update(user, SPACE, CASE_A, dto({ title: 'New' })),
    ).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
    expect(emitAsync).not.toHaveBeenCalled();
  });

  it('puts the old estimate back when the ticket refuses it', async () => {
    const { service, rpc, emitAsync } = makeService([
      { data: { task_id: 'task-1' }, error: null },
    ]);

    rpc.mockResolvedValue({
      data: {
        changed: true,
        revision: 4,
        changes: { estimate_minutes: { from: 5, to: 10 } },
      },
      error: null,
    });
    emitAsync.mockRejectedValue(new Error('refused'));

    await expect(
      service.update(user, SPACE, CASE_A, dto({ estimate_minutes: 10 })),
    ).rejects.toThrow('refused');
    expect(emitAsync).toHaveBeenCalledWith(
      'tasks.test_record.updated',
      expect.objectContaining({ changes: { estimatedTime: 10 } }),
    );
    expect(rpc).toHaveBeenLastCalledWith(
      'tm_update_case',
      expect.objectContaining({
        p_expected_revision: 4,
        p_patch: { estimate_minutes: 5 },
      }),
    );
  });
});

describe('TestCasesService.bulk', () => {
  it('calls tm_bulk_update_cases, audits the summary and each changed case and returns the result unchanged', async () => {
    const { service, rpc, access, auditLogs } = makeService();
    const result = {
      changed: true,
      updated: [CASE_A],
      skipped: [{ case_id: CASE_B, key: 'TC-2', reason: 'already_in_state' }],
    };

    rpc.mockResolvedValue({ data: result, error: null });

    const dto = plainToInstance(BulkTestCasesDto, {
      action: 'move',
      case_ids: [CASE_A, CASE_B],
      folder_id: null,
    });

    await expect(service.bulk(user, SPACE, dto)).resolves.toEqual(result);
    expect(access.assertAvailable).toHaveBeenCalledWith('org-1', SPACE, {
      write: true,
    });
    expect(rpc).toHaveBeenCalledWith('tm_bulk_update_cases', {
      p_organization_id: 'org-1',
      p_space_id: SPACE,
      p_actor_id: 'user-1',
      p_case_ids: [CASE_A, CASE_B],
      p_action: 'move',
      p_folder_id: null,
    });
    expect(auditLogs.logActionForRequest).toHaveBeenCalledTimes(2);
    expect(auditLogs.logActionForRequest).toHaveBeenCalledWith(
      user,
      'space',
      SPACE,
      'update',
      { entity_type: 'test_case', action: 'move', count: 1 },
    );
    expect(auditLogs.logActionForRequest).toHaveBeenCalledWith(
      user,
      'test_case',
      CASE_A,
      'update',
      expect.objectContaining({ action: 'bulk_move', bulk: true }),
    );
  });

  it('sends a null folder for archive and skips the audit when nothing changed', async () => {
    const { service, rpc, auditLogs } = makeService();

    rpc.mockResolvedValue({
      data: { changed: false, updated: [], skipped: [] },
      error: null,
    });

    await service.bulk(
      user,
      SPACE,
      plainToInstance(BulkTestCasesDto, {
        action: 'archive',
        case_ids: [CASE_A],
      }),
    );

    expect(rpc).toHaveBeenCalledWith(
      'tm_bulk_update_cases',
      expect.objectContaining({ p_action: 'archive', p_folder_id: null }),
    );
    expect(auditLogs.logActionForRequest).not.toHaveBeenCalled();
  });

  it('answers unknown or foreign ids with 404', async () => {
    const { service, rpc } = makeService();

    rpc.mockResolvedValue({
      data: null,
      error: {
        code: 'P0002',
        message: 'tm: case not found',
        details: JSON.stringify({ not_found: [CASE_B] }),
      },
    });

    await expect(
      service.bulk(
        user,
        SPACE,
        plainToInstance(BulkTestCasesDto, {
          action: 'restore',
          case_ids: [CASE_B],
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('automation key byte length', () => {
  const create = (automation_key: string) =>
    validate(
      plainToInstance(CreateTestCaseDto, { title: 'x', automation_key }),
      {
        whitelist: true,
        forbidNonWhitelisted: true,
      },
    );

  it('accepts up to 1000 UTF-8 bytes', async () => {
    expect(await create('a'.repeat(1000))).toHaveLength(0);
    expect(await create('€'.repeat(333))).toHaveLength(0);
  });

  it('rejects more than 1000 bytes', async () => {
    expect(await create('€'.repeat(334))).toHaveLength(1);
  });

  it('rejects a lone surrogate instead of throwing', async () => {
    expect(await create('\ud800')).toHaveLength(1);
    expect(await create('ok\udc00')).toHaveLength(1);
  });
});

describe('test management error mapping', () => {
  const fakeLogger = () => {
    const logger = { warn: jest.fn(), error: jest.fn() };

    return { logger, asLogger: logger as unknown as Logger };
  };
  const detail = { current_attempt_no: 2 };

  it.each([
    ['TM002', 409, 'RESULT_CONFLICT', detail],
    ['TM003', 409, 'ATTEMPT_NOT_CURRENT', detail],
    ['TM009', 409, 'IMPORT_ALREADY_APPLIED', detail],
    ['TM011', 403, 'NOT_ASSIGNEE', detail],
    ['TM012', 409, 'ATTEMPT_ABORTED', undefined],
  ])('maps %s to %i %s', (code, status, apiCode, data) => {
    const { asLogger } = fakeLogger();
    const error = tmRpcError(asLogger, 'save result', {
      code,
      message: 'tm: x',
      details: JSON.stringify(detail),
    });

    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toMatchObject({ code: apiCode });
    expect((error.getResponse() as { data?: unknown }).data).toEqual(data);
  });

  it('maps a statement timeout to 503 TIMEOUT and warns', () => {
    const { logger, asLogger } = fakeLogger();
    const error: HttpException = tmDbError(asLogger, 'load history', {
      code: '57014',
      message: 'canceling statement due to statement timeout',
    });

    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({ code: 'TIMEOUT' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[57014]'),
    );
  });

  it('keeps TM900 a 500 and logs its code', () => {
    const { logger, asLogger } = fakeLogger();
    const error = tmRpcError(asLogger, 'update test case', {
      code: 'TM900',
      message: 'tm: test_cases.space_id cannot be changed',
    });

    expect(error.getStatus()).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[TM900]'),
    );
  });

  it('answers 23503 with 404 and warns', () => {
    const { logger, asLogger } = fakeLogger();
    const error = tmDbError(asLogger, 'create test case', {
      code: '23503',
      message: 'violates foreign key constraint',
    });

    expect(error.getStatus()).toBe(404);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[23503]'),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('TestCasesService.remove ticket delete', () => {
  const deleted = { deleted: true, has_runs: false, counts: {} };

  function withEvents(results: QueryResult[]) {
    const mock = mockClient(results);
    const emitAsync = jest.fn().mockResolvedValue([]);
    const service = new TestCasesService(
      { getClient: () => mock.client } as unknown as SupabaseAdminService,
      {
        assertAvailable: jest.fn().mockResolvedValue(undefined),
      } as unknown as TestManagementAccessService,
      {
        logActionForRequest: jest.fn().mockResolvedValue(undefined),
      } as unknown as AuditLogsService,
      { emitAsync } as unknown as EventEmitter2,
    );

    return { service, emitAsync, ...mock };
  }

  it('asks the task module to delete the linked ticket', async () => {
    const { service, emitAsync, rpc } = withEvents([
      { data: { task_id: 'task-1' }, error: null },
    ]);

    rpc.mockResolvedValue({ data: deleted, error: null });

    await service.remove(user, SPACE, CASE_A, false);

    expect(emitAsync).toHaveBeenCalledWith('tasks.test_record.deleted', {
      organizationId: 'org-1',
      taskId: 'task-1',
      userId: 'user-1',
    });
  });

  it('sends nothing for a case without a ticket', async () => {
    const { service, emitAsync, rpc } = withEvents([
      { data: { task_id: null }, error: null },
    ]);

    rpc.mockResolvedValue({ data: deleted, error: null });

    await service.remove(user, SPACE, CASE_A, false);

    expect(emitAsync).not.toHaveBeenCalled();
  });

  it('neither reads the ticket nor sends anything on a dry run', async () => {
    const { service, emitAsync, rpc, calls } = withEvents([]);

    rpc.mockResolvedValue({
      data: { deleted: false, has_runs: false, counts: {} },
      error: null,
    });

    await service.remove(user, SPACE, CASE_A, true);

    expect(calls).toHaveLength(0);
    expect(emitAsync).not.toHaveBeenCalled();
  });

  it('keeps the ticket when the case is refused', async () => {
    const { service, emitAsync, rpc } = withEvents([
      { data: { task_id: 'task-1' }, error: null },
    ]);

    rpc.mockResolvedValue({
      data: { deleted: false, has_runs: true, counts: {} },
      error: null,
    });

    await expect(
      service.remove(user, SPACE, CASE_A, false),
    ).rejects.toMatchObject({ response: { code: 'CASE_HAS_RUNS' } });

    expect(emitAsync).not.toHaveBeenCalled();
  });
});

describe('UpdateTestCaseDto test_type', () => {
  it('accepts a test type of 1 to 100 characters, trimmed', async () => {
    const base = { expected_revision: 1 };

    expect(
      await errorsOf(UpdateTestCaseDto, { ...base, test_type: 'generic' }),
    ).toEqual([]);
    expect(
      plainToInstance(UpdateTestCaseDto, { ...base, test_type: '  generic ' })
        .test_type,
    ).toBe('generic');
    expect(
      await errorsOf(UpdateTestCaseDto, {
        ...base,
        test_type: 'x'.repeat(101),
      }),
    ).toEqual(['test_type']);
    expect(
      await errorsOf(UpdateTestCaseDto, { ...base, test_type: '   ' }),
    ).toEqual(['test_type']);
    expect(await errorsOf(UpdateTestCaseDto, base)).toEqual([]);
  });
});

describe('TestCasesService.update test_type', () => {
  it('refuses a test type the space does not have, before saving', async () => {
    const { service, rpc, calls } = makeService([
      { data: { test_types: [{ id: 'generic' }] }, error: null },
    ]);

    await expect(
      service.update(
        user,
        SPACE,
        CASE_A,
        plainToInstance(UpdateTestCaseDto, {
          expected_revision: 1,
          test_type: 'unknown',
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: 'VALIDATION_FAILED', field: 'test_type' },
    });
    expect(calls[0]).toContainEqual([
      'from',
      ['test_management_space_settings'],
    ]);
    expect(calls[0]).toContainEqual(['eq', ['organization_id', 'org-1']]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('saves a known test type, and manual even without settings', async () => {
    for (const [settings, testType] of [
      [{ test_types: [{ id: 'generic' }] }, 'generic'],
      [null, 'manual'],
    ] as const) {
      const { service, rpc } = makeService([{ data: settings, error: null }]);

      rpc.mockResolvedValue({ data: null, error: { message: 'stop' } });

      await expect(
        service.update(
          user,
          SPACE,
          CASE_A,
          plainToInstance(UpdateTestCaseDto, {
            expected_revision: 3,
            test_type: testType,
          }),
        ),
      ).rejects.toBeDefined();
      expect(rpc).toHaveBeenCalledWith(
        'tm_update_case',
        expect.objectContaining({
          p_expected_revision: 3,
          p_patch: { test_type: testType },
        }),
      );
    }
  });

  it('does not read the settings when the test type is not changed', async () => {
    const { service, rpc, calls } = makeService();

    rpc.mockResolvedValue({ data: null, error: { message: 'stop' } });

    await expect(
      service.update(
        user,
        SPACE,
        CASE_A,
        plainToInstance(UpdateTestCaseDto, {
          expected_revision: 1,
          title: 'T',
        }),
      ),
    ).rejects.toBeDefined();
    expect(calls).toEqual([]);
  });
});

describe('test case linked test file', () => {
  const update = (automation_spec_path: unknown) =>
    plainToInstance(UpdateTestCaseDto, {
      expected_revision: 2,
      automation_spec_path,
    });
  const sentPatch = async (automation_spec_path: unknown) => {
    const { service, rpc } = makeService();

    rpc.mockResolvedValue({ data: null, error: { message: 'stop' } });

    await expect(
      service.update(user, SPACE, CASE_A, update(automation_spec_path)),
    ).rejects.toBeDefined();

    return (rpc.mock.calls as [string, { p_patch: unknown }][])[0][1].p_patch;
  };

  it('accepts the field on create and update, and nothing else new', async () => {
    await expect(
      errorsOf(CreateTestCaseDto, {
        title: 'x',
        automation_spec_path: 'tests/a.spec.ts',
      }),
    ).resolves.toEqual([]);
    await expect(
      errorsOf(UpdateTestCaseDto, {
        expected_revision: 1,
        automation_spec_path: null,
      }),
    ).resolves.toEqual([]);
    await expect(
      errorsOf(UpdateTestCaseDto, {
        expected_revision: 1,
        automation_spec_path: 5,
      }),
    ).resolves.toEqual(['automation_spec_path']);
  });

  it('saves a trimmed path and clears it when blank or null', async () => {
    await expect(sentPatch('  tests/a.spec.ts ')).resolves.toEqual({
      automation_spec_path: 'tests/a.spec.ts',
    });
    await expect(sentPatch('   ')).resolves.toEqual({
      automation_spec_path: null,
    });
    await expect(sentPatch(null)).resolves.toEqual({
      automation_spec_path: null,
    });
  });

  it.each(['../a.spec.ts', '/etc/passwd', '-rf', 'a b.spec.ts', 'a//b.ts'])(
    'refuses %j on its own field, before saving',
    async (path) => {
      const { service, rpc } = makeService();

      await expect(
        service.update(user, SPACE, CASE_A, update(path)),
      ).rejects.toMatchObject({
        response: { code: 'VALIDATION_FAILED', field: 'automation_spec_path' },
      });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it('checks the path on create before the ticket is made', async () => {
    const { service, tasks } = makeService();

    await expect(
      service.create(user, SPACE, {
        title: 'Login',
        automation_spec_path: '../outside.ts',
      }),
    ).rejects.toMatchObject({
      response: { field: 'automation_spec_path' },
    });
    expect(tasks.create).not.toHaveBeenCalled();
  });
});
