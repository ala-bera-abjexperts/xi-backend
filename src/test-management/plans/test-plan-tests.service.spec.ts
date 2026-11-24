import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import type { TesterEligibilityService } from '../common/tester-eligibility.service';
import { TestPlanTestsService } from './test-plan-tests.service';
import type { TestPlansService } from './test-plans.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const PLAN = 'plan-1';
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
    'in',
    'is',
    'or',
    'order',
    'range',
    'update',
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

function firstArg(mock: jest.Mock): unknown {
  return (mock.mock.calls as unknown[][])[0]?.[0];
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('Expected the call to fail');
}

function response(error: unknown): { code?: string; data?: unknown } {
  return (error as ConflictException).getResponse() as {
    code?: string;
    data?: unknown;
  };
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `case-${i}`);
}

describe('TestPlanTestsService', () => {
  let service: TestPlanTestsService;
  let from: jest.Mock;
  let rpc: jest.Mock;
  let assertAvailable: jest.Mock;
  let log: jest.Mock;
  let loadPlan: jest.Mock;
  let assertEligible: jest.Mock;
  let eligibleUserIds: jest.Mock;

  const next = (resolved: Resolved) => {
    const chain = buildChain(resolved);

    from.mockReturnValueOnce(chain);

    return chain;
  };

  beforeEach(() => {
    from = jest.fn();
    rpc = jest.fn();
    assertAvailable = jest.fn().mockResolvedValue(undefined);
    log = jest.fn().mockResolvedValue(undefined);
    loadPlan = jest.fn().mockResolvedValue({ id: PLAN, is_archived: false });
    assertEligible = jest.fn().mockResolvedValue(undefined);
    eligibleUserIds = jest.fn().mockResolvedValue(new Set(['tester-1']));

    service = new TestPlanTestsService(
      { getClient: () => ({ from, rpc }) } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { logActionForRequest: log } as unknown as AuditLogsService,
      { load: loadPlan } as unknown as TestPlansService,
      {
        assertEligible,
        eligibleUserIds,
      } as unknown as TesterEligibilityService,
    );
  });

  describe('tests', () => {
    it('lists the tests of the plan with key and title from their tickets', async () => {
      const chain = next({
        data: [
          {
            id: 'case-1',
            readiness: 'ready',
            test_type: 'manual',
            is_archived: false,
            task: { key: 'P-T4', summary: 'Login' },
            test_plan_tests: [
              { added_at: '2026-10-20T10:00:00Z', tester: null },
            ],
          },
        ],
        error: null,
        count: 1,
      });

      const page = await service.tests(ORG, SPACE, PLAN, {});

      expect(loadPlan).toHaveBeenCalledWith(ORG, SPACE, PLAN, 'id');
      expect(firstArg(chain.select)).toContain(
        'task:tasks!test_cases_task_id_fkey!inner(key, summary)',
      );
      expect(chain.eq).toHaveBeenCalledWith('test_plan_tests.plan_id', PLAN);
      expect(chain.order).toHaveBeenNthCalledWith(1, 'created_at', {
        ascending: true,
      });
      expect(page.total).toBe(1);
      expect(page.items).toEqual([
        {
          case_id: 'case-1',
          key: 'P-T4',
          key_number: 4,
          task_key: 'P-T4',
          title: 'Login',
          readiness: 'ready',
          test_type: 'manual',
          is_archived: false,
          added_at: '2026-10-20T10:00:00Z',
          planned_tester: null,
        },
      ]);
      expect(eligibleUserIds).not.toHaveBeenCalled();
    });

    it('applies no filter and keeps the added order when none is sent', async () => {
      const chain = next({ data: [], error: null, count: 0 });

      await service.tests(ORG, SPACE, PLAN, {});

      expect(chain.in).not.toHaveBeenCalled();
      expect(chain.is).not.toHaveBeenCalled();
      expect(chain.or).not.toHaveBeenCalled();
      expect(chain.order).toHaveBeenNthCalledWith(1, 'created_at', {
        ascending: true,
      });
      expect(chain.order).toHaveBeenNthCalledWith(2, 'id', {
        ascending: true,
      });
    });

    it('filters by search, readiness, test type and planned tester', async () => {
      const chain = next({ data: [], error: null, count: 0 });

      await service.tests(ORG, SPACE, PLAN, {
        q: '50%_off',
        readiness: ['draft', 'ready'],
        testType: 'manual',
        tester: 'tester-1',
      });

      expect(chain.in).toHaveBeenCalledWith('readiness', ['draft', 'ready']);
      expect(chain.eq).toHaveBeenCalledWith('test_type', 'manual');
      expect(chain.eq).toHaveBeenCalledWith(
        'test_plan_tests.planned_tester_id',
        'tester-1',
      );
      expect(chain.or).toHaveBeenCalledWith(
        'key.ilike."%50\\\\%\\\\_off%",summary.ilike."%50\\\\%\\\\_off%"',
        { referencedTable: 'task' },
      );
    });

    it('finds tests without a planned tester', async () => {
      const chain = next({ data: [], error: null, count: 0 });

      await service.tests(ORG, SPACE, PLAN, { tester: 'unassigned' });

      expect(chain.is).toHaveBeenCalledWith(
        'test_plan_tests.planned_tester_id',
        null,
      );
      expect(chain.eq).not.toHaveBeenCalledWith(
        'test_plan_tests.planned_tester_id',
        expect.anything(),
      );
    });

    it.each([
      ['key', 'created_at', true],
      ['key:desc', 'created_at', false],
      ['title', 'task(summary)', true],
      ['title:desc', 'task(summary)', false],
      ['readiness:asc', 'readiness', true],
      ['readiness:desc', 'readiness', false],
      ['test_type', 'test_type', true],
      ['test_type:desc', 'test_type', false],
    ])('sorts by %s', async (sort, column, ascending) => {
      const chain = next({ data: [], error: null, count: 0 });

      await service.tests(ORG, SPACE, PLAN, { sort });

      expect(chain.order).toHaveBeenNthCalledWith(1, column, { ascending });
      expect(chain.order).toHaveBeenNthCalledWith(2, 'id', {
        ascending: true,
      });
    });

    it('counts a page past the end with the same search', async () => {
      const page = next({
        data: null,
        error: { code: 'PGRST103', message: 'range' },
      });
      const count = next({ data: null, error: null, count: 3 });

      const result = await service.tests(ORG, SPACE, PLAN, {
        page: 9,
        pageSize: 10,
        q: 'login',
      });

      expect(page.or).toHaveBeenCalled();
      expect(firstArg(count.select)).toContain(
        'task:tasks!test_cases_task_id_fkey!inner(key)',
      );
      expect(count.or).toHaveBeenCalledWith(
        'key.ilike."%login%",summary.ilike."%login%"',
        { referencedTable: 'task' },
      );
      expect(result).toEqual({ items: [], total: 3, page: 9, pageSize: 10 });
    });
  });

  describe('add', () => {
    const added = {
      changed: true,
      added: ['case-1', 'case-2'],
      already_present: ['case-3'],
      skipped: [],
      warnings: [],
    };

    it('sends case ids to the database function and returns counts', async () => {
      rpc.mockResolvedValueOnce({ data: added, error: null });

      await expect(
        service.add(user, SPACE, PLAN, {
          source: 'cases',
          case_ids: ['case-1', 'case-2', 'case-3'],
        }),
      ).resolves.toEqual({
        changed: true,
        added: 2,
        already_present: 1,
        skipped: [],
        warnings: [],
      });
      expect(rpc).toHaveBeenCalledWith('tm_add_plan_tests', {
        p_organization_id: ORG,
        p_space_id: SPACE,
        p_actor_id: 'user-1',
        p_plan_id: PLAN,
        p_case_ids: ['case-1', 'case-2', 'case-3'],
        p_set_id: null,
        p_folder_id: null,
        p_include_subfolders: true,
      });
      expect(assertAvailable).toHaveBeenCalledWith(ORG, SPACE, { write: true });
      expect(log).toHaveBeenCalledWith(user, 'test_plan', PLAN, 'update', {
        space_id: SPACE,
        added: 2,
      });
    });

    it.each([
      [
        { source: 'set' as const, set_id: 'set-1' },
        {
          p_case_ids: null,
          p_set_id: 'set-1',
          p_folder_id: null,
          p_include_subfolders: true,
        },
      ],
      [
        {
          source: 'folder' as const,
          folder_id: 'folder-1',
          include_subfolders: false,
        },
        {
          p_case_ids: null,
          p_set_id: null,
          p_folder_id: 'folder-1',
          p_include_subfolders: false,
        },
      ],
    ])('sends only the chosen source (%o)', async (dto, expected) => {
      rpc.mockResolvedValueOnce({ data: added, error: null });

      await service.add(user, SPACE, PLAN, dto);

      expect((rpc.mock.calls as unknown[][])[0][1]).toMatchObject(expected);
    });

    it('logs nothing when nothing was added', async () => {
      rpc.mockResolvedValueOnce({
        data: { ...added, changed: false, added: [] },
        error: null,
      });

      await service.add(user, SPACE, PLAN, {
        source: 'cases',
        case_ids: ['case-3'],
      });

      expect(log).not.toHaveBeenCalled();
    });

    it('answers a case deleted while adding with 409 IN_USE', async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: '23503', message: 'fk' },
      });

      const error = await caught(
        service.add(user, SPACE, PLAN, {
          source: 'cases',
          case_ids: ['case-1'],
        }),
      );

      expect(error).toBeInstanceOf(ConflictException);
      expect(response(error).code).toBe('IN_USE');
    });

    it('lists the missing case ids in a 404', async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: {
          code: 'P0002',
          message: 'tm: missing',
          details: JSON.stringify({ missing: ['case-9'] }),
        },
      });

      const error = await caught(
        service.add(user, SPACE, PLAN, {
          source: 'cases',
          case_ids: ['case-9'],
        }),
      );

      expect(error).toBeInstanceOf(NotFoundException);
      expect(response(error).data).toEqual({ not_found: ['case-9'] });
    });

    it('names the archived set in a 409', async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: {
          code: 'TM004',
          message: 'tm: archived',
          details: JSON.stringify({ set_id: 'set-1' }),
        },
      });

      const error = await caught(
        service.add(user, SPACE, PLAN, { source: 'set', set_id: 'set-1' }),
      );

      expect(response(error)).toMatchObject({
        code: 'ARCHIVED',
        data: { set_id: 'set-1' },
      });
    });

    it('passes other errors through the shared mapping', async () => {
      rpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'TM013', message: 'tm: too many tests' },
      });

      const error = await caught(
        service.add(user, SPACE, PLAN, {
          source: 'cases',
          case_ids: ['case-1'],
        }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect(response(error).code).toBe('LIMIT_EXCEEDED');
    });
  });

  describe('remove', () => {
    it('refuses an archived plan before any query', async () => {
      loadPlan.mockResolvedValueOnce({ id: PLAN, is_archived: true });

      const error = await caught(service.remove(user, SPACE, PLAN, ['case-1']));

      expect(response(error).code).toBe('ARCHIVED');
      expect(from).not.toHaveBeenCalled();
    });

    it('answers ids that are not cases of the space with 404 and removes nothing', async () => {
      next({ data: [{ id: 'case-1' }], error: null });

      const error = await caught(
        service.remove(user, SPACE, PLAN, ['case-1', 'case-x']),
      );

      expect(error).toBeInstanceOf(NotFoundException);
      expect(response(error).data).toEqual({ not_found: ['case-x'] });
      expect(from).toHaveBeenCalledTimes(1);
    });

    it('checks and removes in chunks of 100 and logs the total', async () => {
      const all = ids(150);
      const lookup1 = next({
        data: all.slice(0, 100).map((id) => ({ id })),
        error: null,
      });

      next({ data: all.slice(100).map((id) => ({ id })), error: null });
      const delete1 = next({
        data: all.slice(0, 60).map((id) => ({ case_id: id })),
        error: null,
      });

      next({ data: [{ case_id: 'case-120' }], error: null });

      await expect(service.remove(user, SPACE, PLAN, all)).resolves.toEqual({
        removed: 61,
      });
      expect(lookup1.in).toHaveBeenCalledWith('id', all.slice(0, 100));
      expect(delete1.in).toHaveBeenCalledWith('case_id', all.slice(0, 100));
      expect(delete1.eq).toHaveBeenCalledWith('plan_id', PLAN);
      expect(log).toHaveBeenCalledWith(user, 'test_plan', PLAN, 'update', {
        space_id: SPACE,
        removed: 61,
      });
    });

    it('logs nothing when no id was in the plan', async () => {
      next({ data: [{ id: 'case-1' }], error: null });
      next({ data: [], error: null });

      await expect(
        service.remove(user, SPACE, PLAN, ['case-1']),
      ).resolves.toEqual({
        removed: 0,
      });
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('setPlannedTester', () => {
    const planTestRow = (tester: unknown) => ({
      id: 'case-1',
      readiness: 'ready',
      test_type: 'manual',
      is_archived: false,
      task: { key: 'P-T1', summary: 'Login' },
      test_plan_tests: [{ added_at: '2026-10-20T10:00:00Z', tester }],
    });

    it('checks eligibility, saves the tester and returns the test', async () => {
      const update = next({ data: [{ case_id: 'case-1' }], error: null });

      next({
        data: planTestRow({
          id: 'tester-1',
          first_name: 'Amy',
          last_name: 'Tester',
          email: 'amy@example.com',
          avatar_url: null,
        }),
        error: null,
      });

      const test = await service.setPlannedTester(
        user,
        SPACE,
        PLAN,
        'case-1',
        'tester-1',
      );

      expect(assertEligible).toHaveBeenCalledWith(ORG, SPACE, 'tester-1');
      expect(firstArg(update.update)).toEqual({
        planned_tester_id: 'tester-1',
      });
      expect(update.eq).toHaveBeenCalledWith('case_id', 'case-1');
      expect(test.planned_tester).toEqual({
        id: 'tester-1',
        name: 'Amy Tester',
        avatar_url: null,
        eligible: true,
      });
      expect(log).toHaveBeenCalledWith(user, 'test_plan', PLAN, 'update', {
        space_id: SPACE,
        case_id: 'case-1',
        planned_tester_id: 'tester-1',
      });
    });

    it('clears the tester without an eligibility check', async () => {
      const update = next({ data: [{ case_id: 'case-1' }], error: null });

      next({ data: planTestRow(null), error: null });

      const test = await service.setPlannedTester(
        user,
        SPACE,
        PLAN,
        'case-1',
        null,
      );

      expect(assertEligible).not.toHaveBeenCalled();
      expect(eligibleUserIds).not.toHaveBeenCalled();
      expect(firstArg(update.update)).toEqual({ planned_tester_id: null });
      expect(test.planned_tester).toBeNull();
    });

    it('returns the key and title from the test case ticket', async () => {
      next({ data: [{ case_id: 'case-1' }], error: null });
      const read = next({
        data: {
          ...planTestRow(null),
          task: { key: 'NEWSPACE-T9', summary: ' Login ' },
        },
        error: null,
      });

      const linked = await service.setPlannedTester(
        user,
        SPACE,
        PLAN,
        'case-1',
        null,
      );

      expect(firstArg(read.select)).toContain(
        'task:tasks!test_cases_task_id_fkey!inner(key, summary)',
      );
      expect(linked).toMatchObject({
        key: 'NEWSPACE-T9',
        key_number: 9,
        task_key: 'NEWSPACE-T9',
        title: 'Login',
      });
      expect(linked).not.toHaveProperty('task');
    });

    it('saves nothing for an ineligible user', async () => {
      assertEligible.mockRejectedValueOnce(new BadRequestException());

      await expect(
        service.setPlannedTester(user, SPACE, PLAN, 'case-1', 'stranger'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(from).not.toHaveBeenCalled();
    });

    it('answers a test that is not in the plan with 404', async () => {
      next({ data: [], error: null });

      await expect(
        service.setPlannedTester(user, SPACE, PLAN, 'case-9', null),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('progress', () => {
    const row = (
      caseId: string,
      testerId: string | null,
      testCase: { readiness: string; is_archived: boolean },
    ) => ({
      case_id: caseId,
      planned_tester_id: testerId,
      test_case: testCase,
      tester: testerId
        ? { first_name: testerId.toUpperCase(), last_name: null, email: null }
        : null,
    });
    const ready = { readiness: 'ready', is_archived: false };

    it('counts the latest results and leaves archived and deprecated cases out', async () => {
      rpc.mockResolvedValueOnce({
        data: [
          { case_id: 'c1', status: 'PASS' },
          { case_id: 'c2', status: 'FAIL' },
          { case_id: 'c3', status: 'NOT_APPLICABLE' },
          { case_id: 'c5', status: 'EXECUTING' },
          { case_id: 'c6', status: 'PASS' },
        ],
        error: null,
      });
      next({
        data: [
          row('c1', 't1', ready),
          row('c2', 't1', ready),
          row('c3', null, ready),
          row('c4', 't2', ready),
          row('c5', 't2', ready),
          row('c6', 't1', { readiness: 'ready', is_archived: true }),
          row('c7', 't1', { readiness: 'deprecated', is_archived: false }),
          row('c8', 't1', { readiness: 'deprecated', is_archived: true }),
        ],
        error: null,
      });

      const progress = await service.progress(ORG, SPACE, PLAN);

      expect(progress.total_tests).toBe(5);
      expect(progress.counts).toEqual({
        PASS: 1,
        FAIL: 1,
        BLOCKED: 0,
        ABORTED: 0,
        NOT_APPLICABLE: 1,
        NOT_RUN: 2,
      });
      expect(progress.success_rate).toBe(0.25);
      expect(progress.excluded).toEqual({ archived: 2, deprecated: 1 });
      expect(progress.by_tester).toEqual([
        { user_id: 't1', name: 'T1', avatar_url: null, total: 2, final: 2 },
        { user_id: null, name: null, avatar_url: null, total: 1, final: 1 },
        { user_id: 't2', name: 'T2', avatar_url: null, total: 2, final: 0 },
      ]);
      expect(rpc).toHaveBeenCalledWith('tm_case_status_in_scope', {
        p_organization_id: ORG,
        p_space_id: SPACE,
        p_plan_id: PLAN,
        p_case_ids: null,
        p_exclude_execution_id: null,
      });
    });

    it('has no success rate when every test is not applicable', async () => {
      rpc.mockResolvedValueOnce({
        data: [{ case_id: 'c1', status: 'NOT_APPLICABLE' }],
        error: null,
      });
      next({ data: [row('c1', null, ready)], error: null });

      await expect(service.progress(ORG, SPACE, PLAN)).resolves.toMatchObject({
        total_tests: 1,
        success_rate: null,
      });
    });

    it('answers a foreign plan with 404 before reading results', async () => {
      loadPlan.mockRejectedValueOnce(new NotFoundException());

      await expect(service.progress(ORG, SPACE, PLAN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  describe('runHistory', () => {
    // The shared chain has no not/gte, so they are added here.
    const historyChain = (resolved: Resolved) => {
      const chain = next(resolved);

      chain.not = jest.fn(() => chain);
      chain.gte = jest.fn(() => chain);

      return chain;
    };

    it('maps finished attempts of the plan and filters by space, org, plan, date and final status', async () => {
      const chain = historyChain({
        data: [
          {
            finished_at: '2026-10-21T11:00:00Z',
            status: 'FAIL',
            run: { case_id: 'c2', execution: { plan_id: PLAN } },
          },
          {
            finished_at: '2026-10-20T10:00:00Z',
            status: 'PASS',
            run: { case_id: 'c1', execution: { plan_id: PLAN } },
          },
        ],
        error: null,
      });
      const before = Date.now();

      const history = await service.runHistory(ORG, SPACE, PLAN, 7);

      expect(history.items).toEqual([
        { finished_at: '2026-10-20T10:00:00Z', status: 'PASS', case_id: 'c1' },
        { finished_at: '2026-10-21T11:00:00Z', status: 'FAIL', case_id: 'c2' },
      ]);
      expect(from).toHaveBeenCalledWith('test_run_attempts');
      expect(chain.eq).toHaveBeenCalledWith('space_id', SPACE);
      expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(chain.eq).toHaveBeenCalledWith('run.execution.plan_id', PLAN);
      expect(chain.in).toHaveBeenCalledWith('status', [
        'PASS',
        'FAIL',
        'BLOCKED',
        'ABORTED',
        'NOT_APPLICABLE',
      ]);
      expect(chain.not).toHaveBeenCalledWith('finished_at', 'is', null);
      expect(chain.gte).toHaveBeenCalledWith('finished_at', history.since);
      expect(chain.range).toHaveBeenCalledWith(0, 999);

      const sinceMs = Date.parse(history.since);
      const week = 7 * 86_400_000;

      expect(sinceMs).toBeGreaterThanOrEqual(before - week);
      expect(sinceMs).toBeLessThanOrEqual(Date.now() - week);
    });

    it('returns no items when nothing finished in the period', async () => {
      historyChain({ data: [], error: null });

      const history = await service.runHistory(ORG, SPACE, PLAN, 30);

      expect(history.items).toEqual([]);
      expect(typeof history.since).toBe('string');
    });

    it('answers a foreign plan with 404 before reading attempts', async () => {
      loadPlan.mockRejectedValueOnce(new NotFoundException());

      await expect(
        service.runHistory(ORG, SPACE, PLAN, 30),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(from).not.toHaveBeenCalled();
    });
  });
});
