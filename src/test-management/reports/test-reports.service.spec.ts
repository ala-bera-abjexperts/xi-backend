import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { PdfRenderService } from '../../document-designer/rendering/pdf-render.service';
import type { PermissionsService } from '../../permissions/permissions.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import type { TestExecutionsService } from '../executions/test-executions.service';
import type { TestPlansService } from '../plans/test-plans.service';
import { moduleDisabled } from '../test-management-errors';
import { TestReportsService } from './test-reports.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const PLAN = '11111111-1111-4111-8111-111111111111';
const EXEC = '22222222-2222-4222-8222-222222222222';
const WHO = '33333333-3333-4333-8333-333333333333';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;
const RANGE = { from: '2026-10-01', to: '2026-10-21' };

interface Resolved {
  data: unknown;
  error: { code?: string; message: string } | null;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function buildChain(resolved: Resolved): Chain {
  const chain = {
    then: (onFulfilled: (value: Resolved) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled),
  } as Chain;

  for (const name of ['select', 'eq', 'is', 'in', 'order', 'range', 'limit']) {
    chain[name] = jest.fn(() => chain);
  }

  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);

  return chain;
}

const counts = (o: Partial<Record<string, number>> = {}) => ({
  total: 0,
  todo: 0,
  executing: 0,
  pass: 0,
  fail: 0,
  blocked: 0,
  aborted: 0,
  not_applicable: 0,
  ...o,
});

async function errorOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }

  throw new Error('expected an error');
}

const bodyOf = (error: HttpException) =>
  error.getResponse() as { code?: string; data?: Record<string, unknown> };

describe('TestReportsService', () => {
  let service: TestReportsService;
  let rpc: jest.Mock;
  let from: jest.Mock;
  let tables: Record<string, Resolved[]>;
  let assertAvailable: jest.Mock;
  let hasSpacePermission: jest.Mock;
  let loadPlan: jest.Mock;
  let loadExecution: jest.Mock;
  let renderPdf: jest.Mock;

  // tm_report answers by report name.
  let reports: Record<string, Resolved>;

  beforeEach(() => {
    tables = {};
    reports = {};
    rpc = jest.fn((_name: string, args: { p_report: string }) =>
      Promise.resolve(reports[args.p_report] ?? { data: [], error: null }),
    );
    from = jest.fn((table: string) =>
      buildChain(tables[table]?.shift() ?? { data: [], error: null }),
    );
    assertAvailable = jest.fn().mockResolvedValue(undefined);
    hasSpacePermission = jest.fn().mockResolvedValue(false);
    loadPlan = jest.fn().mockResolvedValue({ id: PLAN });
    loadExecution = jest
      .fn()
      .mockResolvedValue({ id: EXEC, is_archived: false, plan: { id: PLAN } });
    renderPdf = jest.fn().mockResolvedValue(Buffer.from('%PDF'));

    service = new TestReportsService(
      { getClient: () => ({ rpc, from }) } as unknown as SupabaseAdminService,
      { assertAvailable } as unknown as TestManagementAccessService,
      { hasSpacePermission } as unknown as PermissionsService,
      { load: loadPlan } as unknown as TestPlansService,
      { load: loadExecution } as unknown as TestExecutionsService,
      { renderPdf } as unknown as PdfRenderService,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('reads nothing when the module is not available', async () => {
    assertAvailable.mockRejectedValueOnce(moduleDisabled());

    expect(
      (await errorOf(service.report(user, SPACE, 'effort', RANGE))).getStatus(),
    ).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('sends one tm_report call with only the filters given, in database names', async () => {
    await service.report(user, SPACE, 'run-history', {
      ...RANGE,
      tz: 'Europe/Berlin',
      planId: PLAN,
      environment: 'Staging',
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('tm_report', {
      p_organization_id: ORG,
      p_space_id: SPACE,
      p_report: 'run_history',
      p_from: '2026-10-01',
      p_to: '2026-10-21',
      p_tz: 'Europe/Berlin',
      p_filters: { plan_id: PLAN, environment: 'Staging' },
    });
  });

  it('defaults to the last 30 days ending today in the requested zone', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-21T22:30:00Z') });

    const page = await service.report(user, SPACE, 'run-history', {
      tz: 'Europe/Berlin',
    });

    // 22:30 UTC is already the 22nd in Berlin.
    expect(page.range).toEqual({
      from: '2026-09-23',
      to: '2026-10-22',
      tz: 'Europe/Berlin',
    });
  });

  it('maps a database validation error to 400 and a timeout to 503', async () => {
    reports.effort = {
      data: null,
      error: { code: '22023', message: 'tm: unknown time zone' },
    };
    expect(
      (await errorOf(service.report(user, SPACE, 'effort', RANGE))).getStatus(),
    ).toBe(400);

    reports.effort = {
      data: null,
      error: {
        code: '57014',
        message: 'canceling statement due to statement timeout',
      },
    };
    expect(
      (await errorOf(service.report(user, SPACE, 'effort', RANGE))).getStatus(),
    ).toBe(503);
  });

  it('refuses a filter the report cannot apply, before any database call', async () => {
    const error = await errorOf(
      service.report(user, SPACE, 'plan-progress', {
        ...RANGE,
        executionId: EXEC,
      }),
    );

    expect(error.getStatus()).toBe(400);
    expect(bodyOf(error).data).toEqual({ filters: ['executionId'] });
    expect(rpc).not.toHaveBeenCalled();
    expect(loadExecution).not.toHaveBeenCalled();
  });

  it('answers 404 for a plan or execution of another space', async () => {
    loadPlan.mockRejectedValueOnce(
      new NotFoundException({ code: 'NOT_FOUND' }),
    );

    expect(
      (
        await errorOf(
          service.report(user, SPACE, 'effort', { ...RANGE, planId: PLAN }),
        )
      ).getStatus(),
    ).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('answers 404 for a tester with no runs and no access, and skips the access check when runs exist', async () => {
    const missing = await errorOf(
      service.report(user, SPACE, 'tester-workload', {
        ...RANGE,
        assigneeId: WHO,
      }),
    );

    expect(missing.getStatus()).toBe(404);
    expect(hasSpacePermission).toHaveBeenCalledWith(
      WHO,
      ORG,
      SPACE,
      'view_tests',
    );

    hasSpacePermission.mockClear();
    tables.test_runs = [{ data: [{ id: 'r1' }], error: null }];
    await service.report(user, SPACE, 'tester-workload', {
      ...RANGE,
      assigneeId: WHO,
    });

    expect(hasSpacePermission).not.toHaveBeenCalled();
  });

  it('pages execution progress and counts totals over every row', async () => {
    reports.execution_progress = {
      data: [
        {
          execution_id: 'e1',
          execution_key: 'TE1',
          execution_name: 'A',
          plan_id: null,
          environment: null,
          created_at: '2026-10-02',
          ...counts({ total: 4, todo: 1, pass: 2, not_applicable: 1 }),
        },
        {
          execution_id: 'e2',
          execution_key: 'TE2',
          execution_name: 'B',
          plan_id: null,
          environment: null,
          created_at: '2026-10-03',
          ...counts({ total: 2, pass: 1, fail: 1 }),
        },
        {
          execution_id: 'e3',
          execution_key: 'TE3',
          execution_name: 'C',
          plan_id: null,
          environment: null,
          created_at: '2026-10-04',
          ...counts({ total: 1, not_applicable: 1 }),
        },
      ],
      error: null,
    };

    const page = await service.report(user, SPACE, 'execution-progress', {
      ...RANGE,
      page: 1,
      pageSize: 2,
    });

    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      final_ratio: 0.75,
      success_rate: 0.6667,
    });
    expect(page.totals).toMatchObject({ total: 7, pass: 3, active: 1 });

    const last = await service.report(user, SPACE, 'execution-progress', {
      ...RANGE,
      page: 3,
      pageSize: 2,
    });

    expect(last.items).toEqual([]);
    expect(last.total).toBe(3);
  });

  it('keeps the whole day series on one page and gives no pass rate without results', async () => {
    reports.run_history = {
      data: Array.from({ length: 21 }, (_, i) => ({
        day: `2026-10-${String(i + 1).padStart(2, '0')}`,
        total: 0,
        pass: 0,
        fail: 0,
        blocked: 0,
        aborted: 0,
        not_applicable: 0,
      })),
      error: null,
    };

    const page = await service.report(user, SPACE, 'run-history', {
      ...RANGE,
      pageSize: 5,
    });

    expect(page.items).toHaveLength(21);
    expect(page.totals).toMatchObject({ total: 0, pass_rate: null });
  });

  it('folds unassigned and unknown testers into one row with names for the rest', async () => {
    reports.tester_workload = {
      data: [
        { assignee_id: 'u1', ...counts({ total: 2, todo: 2 }) },
        { assignee_id: 'gone', ...counts({ total: 1, pass: 1 }) },
        { assignee_id: null, ...counts({ total: 3, todo: 3 }) },
      ],
      error: null,
    };
    tables.users = [
      {
        data: [{ id: 'u1', first_name: 'Ada', last_name: 'Lee', email: 'a@x' }],
        error: null,
      },
    ];

    const page = await service.report(user, SPACE, 'tester-workload', RANGE);

    expect(page.items).toEqual([
      { assignee_id: 'u1', name: 'Ada Lee', ...counts({ total: 2, todo: 2 }) },
      {
        assignee_id: null,
        name: null,
        ...counts({ total: 4, todo: 3, pass: 1 }),
      },
    ]);
  });

  it('moves the effort total to totals and adds the variance over estimated runs', async () => {
    const effort = (o: Record<string, unknown>) => ({
      runs: 0,
      estimate_minutes: 0,
      actual_minutes: 0,
      no_estimate_runs: 0,
      no_estimate_actual_minutes: 0,
      dimension_key: null,
      ...o,
    });

    reports.effort = {
      data: [
        effort({
          dimension: 'total',
          dimension_id: null,
          runs: 3,
          estimate_minutes: 90,
          actual_minutes: 120,
          no_estimate_runs: 1,
          no_estimate_actual_minutes: 25,
        }),
        effort({
          dimension: 'plan',
          dimension_id: null,
          runs: 3,
          estimate_minutes: 90,
          actual_minutes: 120,
        }),
        effort({
          dimension: 'tester',
          dimension_id: null,
          runs: 1,
          actual_minutes: 25,
          no_estimate_runs: 1,
          no_estimate_actual_minutes: 25,
        }),
      ],
      error: null,
    };

    const page = await service.report(user, SPACE, 'effort', RANGE);

    expect(page.totals).toMatchObject({
      estimate_minutes: 90,
      actual_minutes: 120,
      variance: 5,
    });
    expect(page.items).toHaveLength(2);
    expect(page.items[1]).toMatchObject({
      dimension: 'tester',
      name: null,
      variance: 0,
    });
  });

  it('flags a report filtered by an archived execution', async () => {
    loadExecution.mockResolvedValueOnce({
      id: EXEC,
      is_archived: true,
      plan: null,
    });

    const page = await service.report(user, SPACE, 'execution-progress', {
      ...RANGE,
      executionId: EXEC,
    });

    expect(page.archived_filter).toBe(true);
  });

  describe('export', () => {
    beforeEach(() => {
      tables.spaces = [{ data: { key: 'SK' }, error: null }];
    });

    it('writes CSV with BOM, CRLF, German headers, neutralised text and plain negative numbers', async () => {
      reports.effort = {
        data: [
          {
            dimension: 'execution',
            dimension_id: 'e1',
            dimension_key: '=HYPERLINK("x")',
            runs: 1,
            estimate_minutes: 60,
            actual_minutes: 30,
            no_estimate_runs: 0,
            no_estimate_actual_minutes: 0,
          },
        ],
        error: null,
      };

      const file = await service.exportReport(user, SPACE, 'effort', {
        ...RANGE,
        format: 'csv',
        lang: 'de',
      });
      const text = file.body.toString('utf8');

      expect(file.contentType).toBe('text/csv; charset=utf-8');
      expect(file.fileName).toBe('SK-effort-2026-10-01-2026-10-21.csv');
      expect(text.startsWith('﻿Gruppiert nach,')).toBe(true);
      expect(text).toContain('\r\n');
      expect(text).toContain(`"'=HYPERLINK(""x"")"`);
      expect(text).toContain(',-30,');
      expect(text).not.toContain("'-30");
    });

    it('writes a header-only CSV when there are no rows', async () => {
      const file = await service.exportReport(user, SPACE, 'tester-workload', {
        ...RANGE,
        format: 'csv',
      });

      expect(
        file.body.toString('utf8').split('\r\n').filter(Boolean),
      ).toHaveLength(1);
    });

    it('refuses more than 10,000 rows before building anything', async () => {
      reports.run_history = {
        data: Array.from({ length: 10_001 }, () => ({
          day: '2026-10-01',
          total: 0,
          pass: 0,
          fail: 0,
          blocked: 0,
          aborted: 0,
          not_applicable: 0,
        })),
        error: null,
      };

      const error = await errorOf(
        service.exportReport(user, SPACE, 'run-history', {
          ...RANGE,
          format: 'pdf',
        }),
      );

      expect(error.getStatus()).toBe(400);
      expect(bodyOf(error).code).toBe('EXPORT_TOO_LARGE');
      expect(renderPdf).not.toHaveBeenCalled();
    });

    it('renders PDF from escaped HTML and passes a disabled renderer through', async () => {
      reports.execution_progress = {
        data: [
          {
            execution_id: 'e1',
            execution_key: 'TE1',
            execution_name: '<img src=x onerror=alert(1)>',
            plan_id: null,
            environment: null,
            created_at: '2026-10-02',
            ...counts({ total: 1, pass: 1 }),
          },
        ],
        error: null,
      };

      const file = await service.exportReport(
        user,
        SPACE,
        'execution-progress',
        { ...RANGE, format: 'pdf' },
      );
      const [html, page] = renderPdf.mock.calls[0] as [string, unknown];

      expect(file.contentType).toBe('application/pdf');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain('<img');
      expect(page).toEqual({ widthPx: 1123, heightPx: 794 });

      tables.spaces = [{ data: { key: 'SK' }, error: null }];
      renderPdf.mockRejectedValueOnce(
        new HttpException('PDF export is disabled', HttpStatus.NOT_IMPLEMENTED),
      );

      expect(
        (
          await errorOf(
            service.exportReport(user, SPACE, 'execution-progress', {
              ...RANGE,
              format: 'pdf',
            }),
          )
        ).getStatus(),
      ).toBe(501);
    });
  });
});
