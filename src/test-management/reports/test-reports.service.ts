import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { PdfRenderService } from '../../document-designer/rendering/pdf-render.service';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import {
  chunk,
  userDisplayName,
  type UserNameRow,
} from '../common/tester-eligibility.service';
import {
  TEST_REPORT_FILTERS,
  TEST_REPORT_LIMITS,
  type EffortCounts,
  type EffortRow,
  type ExecutionProgressRow,
  type ExecutionProgressTotals,
  type PlanProgressCounts,
  type PlanProgressRow,
  type PlanTrendPoint,
  type RunHistoryRow,
  type RunHistoryTotals,
  type RunStatusCounts,
  type TestReportExportQueryDto,
  type TestReportFilterKey,
  type TestReportLang,
  type TestReportPage,
  type TestReportQueryDto,
  type TestReportRange,
  type TestReportRoute,
  type TesterWorkloadRow,
} from '../dto/test-report.dto';
import { TestExecutionsService } from '../executions/test-executions.service';
import { TestPlansService } from '../plans/test-plans.service';
import {
  notFound,
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../test-management-errors';
import {
  PDF_PAGE,
  REPORT_TITLES,
  exportTable,
  toCsv,
  toPdfHtml,
  type ExportRows,
} from './test-report-export';

const DAY_MS = 86_400_000;

const ZERO_COUNTS: RunStatusCounts = {
  total: 0,
  todo: 0,
  executing: 0,
  pass: 0,
  fail: 0,
  blocked: 0,
  aborted: 0,
  not_applicable: 0,
};

type TmReportName =
  | 'execution_progress'
  | 'plan_progress'
  | 'tester_workload'
  | 'run_history'
  | 'effort';

interface DbEffortRow extends Omit<EffortCounts, 'variance'> {
  dimension: 'total' | 'execution' | 'plan' | 'tester';
  dimension_id: string | null;
  dimension_key: string | null;
}

interface ReportContext {
  user: RequestUser;
  spaceId: string;
  range: TestReportRange;
  filters: Partial<Record<TestReportFilterKey, string>>;
  archivedExecution: boolean;
}

type AnyReportPage =
  | TestReportPage<ExecutionProgressRow, ExecutionProgressTotals>
  | TestReportPage<PlanProgressRow, PlanProgressCounts>
  | TestReportPage<TesterWorkloadRow, RunStatusCounts>
  | TestReportPage<RunHistoryRow, RunHistoryTotals>
  | TestReportPage<EffortRow, EffortCounts>;

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0
    ? Math.round((numerator / denominator) * 10000) / 10000
    : null;

/** Today in the zone, as YYYY-MM-DD. */
function todayIn(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Reports of one space, each from one `tm_report` call (one statement, so one snapshot). */
@Injectable()
export class TestReportsService {
  private readonly logger = new Logger(TestReportsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly permissions: PermissionsService,
    private readonly plans: TestPlansService,
    private readonly executions: TestExecutionsService,
    private readonly pdf: PdfRenderService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async report(
    user: RequestUser,
    spaceId: string,
    route: TestReportRoute,
    query: TestReportQueryDto,
  ): Promise<AnyReportPage> {
    const context = await this.prepare(user, spaceId, route, query);

    return this.paged(route, context, query.page ?? 1, query.pageSize ?? 50);
  }

  async exportReport(
    user: RequestUser,
    spaceId: string,
    route: TestReportRoute,
    query: TestReportExportQueryDto,
  ): Promise<{ body: Buffer; contentType: string; fileName: string }> {
    const context = await this.prepare(user, spaceId, route, query);
    const lang: TestReportLang = query.lang ?? 'en';
    const rows = await this.allRows(route, context);

    // Counted before anything is built, so a too large export never produces a partial file.
    if (rows.rows.length > TEST_REPORT_LIMITS.exportRows) {
      throw new BadRequestException({
        code: 'EXPORT_TOO_LARGE',
        message: `The export has more than ${TEST_REPORT_LIMITS.exportRows} rows. Narrow the filters.`,
        data: { rows: rows.rows.length, max: TEST_REPORT_LIMITS.exportRows },
      });
    }

    const spaceKey = await this.spaceKey(user.organizationId, spaceId);
    const table = exportTable(rows, lang);
    const name = `${spaceKey}-${route}-${context.range.from}-${context.range.to}`;

    if (query.format === 'pdf') {
      const html = toPdfHtml(
        table,
        { title: REPORT_TITLES[route][lang], spaceKey, range: context.range },
        lang,
      );

      return {
        body: await this.pdf.renderPdf(html, PDF_PAGE),
        contentType: 'application/pdf',
        fileName: `${name}.pdf`,
      };
    }

    return {
      body: toCsv(table, lang),
      contentType: 'text/csv; charset=utf-8',
      fileName: `${name}.csv`,
    };
  }

  /** Availability, allowed filters, filter ids of this space (same 404 otherwise) and the date range. */
  private async prepare(
    user: RequestUser,
    spaceId: string,
    route: TestReportRoute,
    query: TestReportQueryDto,
  ): Promise<ReportContext> {
    const organizationId = user.organizationId;

    await this.access.assertAvailable(organizationId, spaceId);

    const filters: Partial<Record<TestReportFilterKey, string>> = {
      ...(query.planId !== undefined && { planId: query.planId }),
      ...(query.executionId !== undefined && {
        executionId: query.executionId,
      }),
      ...(query.environment !== undefined && {
        environment: query.environment,
      }),
      ...(query.assigneeId !== undefined && { assigneeId: query.assigneeId }),
    };
    const refused = (Object.keys(filters) as TestReportFilterKey[]).filter(
      (key) => !TEST_REPORT_FILTERS[route].includes(key),
    );

    if (refused.length > 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'This report does not support these filters',
        data: { filters: refused },
      });
    }

    const [, execution] = await Promise.all([
      filters.planId
        ? this.plans.load(organizationId, spaceId, filters.planId, 'id')
        : null,
      filters.executionId
        ? this.executions.load(organizationId, spaceId, filters.executionId)
        : null,
      filters.assigneeId
        ? this.assertAssignee(organizationId, spaceId, filters.assigneeId)
        : null,
    ]);
    const tz = query.tz ?? 'UTC';
    const to = query.to ?? todayIn(tz);
    const from =
      query.from ??
      new Date(Date.parse(to) - (TEST_REPORT_LIMITS.defaultDays - 1) * DAY_MS)
        .toISOString()
        .slice(0, 10);

    return {
      user,
      spaceId,
      range: { from, to, tz },
      filters,
      archivedExecution: execution?.is_archived ?? false,
    };
  }

  /** A tester filter must have runs in this space or be allowed to see its tests. */
  private async assertAssignee(
    organizationId: string,
    spaceId: string,
    assigneeId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('test_runs')
      .select('id')
      .eq('assignee_id', assigneeId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .limit(1);

    if (error) throw tmDbError(this.logger, 'check tester filter', error);
    if ((data ?? []).length > 0) return;

    const allowed = await this.permissions.hasSpacePermission(
      assigneeId,
      organizationId,
      spaceId,
      'view_tests',
    );

    if (!allowed) throw notFound();
  }

  private async tmReport<Row>(
    context: ReportContext,
    name: TmReportName,
  ): Promise<Row[]> {
    const { filters, range } = context;
    const { data, error } = (await this.client.rpc('tm_report', {
      p_organization_id: context.user.organizationId,
      p_space_id: context.spaceId,
      p_report: name,
      p_from: range.from,
      p_to: range.to,
      p_tz: range.tz,
      p_filters: {
        ...(filters.planId && { plan_id: filters.planId }),
        ...(filters.executionId && { execution_id: filters.executionId }),
        ...(filters.environment && { environment: filters.environment }),
        ...(filters.assigneeId && { assignee_id: filters.assigneeId }),
      },
    })) as { data: Row[] | null; error: TmRpcError | null };

    if (error) throw tmRpcError(this.logger, `load report ${name}`, error);

    return data ?? [];
  }

  private async paged(
    route: TestReportRoute,
    context: ReportContext,
    page: number,
    pageSize: number,
  ): Promise<AnyReportPage> {
    const base = {
      range: context.range,
      page,
      pageSize,
      ...(context.archivedExecution && { archived_filter: true }),
    };
    const slice = <Row>(rows: Row[]) =>
      rows.slice((page - 1) * pageSize, page * pageSize);

    switch (route) {
      case 'run-history': {
        // Every day of the range on one page, so the series is never cut.
        const rows = await this.runHistory(context);

        return {
          ...base,
          report: route,
          page: 1,
          pageSize: rows.length,
          items: rows,
          total: rows.length,
          totals: runHistoryTotals(rows),
        };
      }
      case 'execution-progress': {
        const rows = await this.executionProgress(context);

        return {
          ...base,
          report: route,
          items: slice(rows),
          total: rows.length,
          totals: {
            ...sumCounts(rows),
            active: rows.filter((r) => r.todo + r.executing > 0).length,
          },
        };
      }
      case 'plan-progress': {
        const rows = await this.planProgress(context);

        return {
          ...base,
          report: route,
          items: slice(rows),
          total: rows.length,
          totals: sumPlanCounts(rows),
        };
      }
      case 'tester-workload': {
        const rows = await this.workload(context);

        return {
          ...base,
          report: route,
          items: slice(rows),
          total: rows.length,
          totals: sumCounts(rows),
        };
      }
      case 'effort': {
        const { rows, totals } = await this.effort(context);

        return {
          ...base,
          report: route,
          items: slice(rows),
          total: rows.length,
          totals,
        };
      }
    }
  }

  private async allRows(
    route: TestReportRoute,
    context: ReportContext,
  ): Promise<ExportRows> {
    switch (route) {
      case 'execution-progress':
        return { route, rows: await this.executionProgress(context) };
      case 'plan-progress':
        return { route, rows: await this.planProgress(context) };
      case 'tester-workload':
        return { route, rows: await this.workload(context) };
      case 'run-history':
        return { route, rows: await this.runHistory(context) };
      case 'effort':
        return { route, rows: (await this.effort(context)).rows };
    }
  }

  private async executionProgress(
    context: ReportContext,
  ): Promise<ExecutionProgressRow[]> {
    const rows = await this.tmReport<
      Omit<ExecutionProgressRow, 'final_ratio' | 'success_rate'>
    >(context, 'execution_progress');

    return rows.map((row) => ({
      ...row,
      final_ratio: ratio(row.total - row.todo - row.executing, row.total) ?? 0,
      success_rate: ratio(row.pass, row.total - row.not_applicable),
    }));
  }

  private async planProgress(
    context: ReportContext,
  ): Promise<PlanProgressRow[]> {
    const rows = await this.tmReport<
      Omit<PlanProgressRow, 'success_rate' | 'trend'> & {
        trend: PlanTrendPoint[] | null;
      }
    >(context, 'plan_progress');

    return rows.map((row) => ({
      ...row,
      trend: row.trend ?? [],
      success_rate: ratio(row.pass, row.tests - row.not_applicable),
    }));
  }

  private async runHistory(context: ReportContext): Promise<RunHistoryRow[]> {
    return this.tmReport<RunHistoryRow>(context, 'run_history');
  }

  private async workload(context: ReportContext): Promise<TesterWorkloadRow[]> {
    const rows = await this.tmReport<
      RunStatusCounts & { assignee_id: string | null }
    >(context, 'tester_workload');
    const names = await this.userNames(
      rows.map((r) => r.assignee_id).filter((id): id is string => Boolean(id)),
    );
    const byTester = new Map<string | null, TesterWorkloadRow>();

    // A deleted tester comes back as NULL or as an id without a user: both are "Unassigned".
    for (const row of rows) {
      const name = row.assignee_id ? names.get(row.assignee_id) : undefined;
      const key = name ? row.assignee_id : null;
      const entry = byTester.get(key) ?? {
        ...ZERO_COUNTS,
        assignee_id: key,
        name: name ?? null,
      };

      byTester.set(key, {
        ...addCounts(entry, row),
        assignee_id: key,
        name: entry.name,
      });
    }

    return [...byTester.values()].sort((a, b) =>
      a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name),
    );
  }

  private async effort(
    context: ReportContext,
  ): Promise<{ rows: EffortRow[]; totals: EffortCounts }> {
    const db = await this.tmReport<DbEffortRow>(context, 'effort');
    const names = await this.userNames(
      db
        .filter((r) => r.dimension === 'tester' && r.dimension_id)
        .map((r) => r.dimension_id as string),
    );
    const withVariance = (
      row: Omit<EffortCounts, 'variance'>,
    ): EffortCounts => ({
      runs: row.runs,
      estimate_minutes: row.estimate_minutes,
      actual_minutes: row.actual_minutes,
      no_estimate_runs: row.no_estimate_runs,
      no_estimate_actual_minutes: row.no_estimate_actual_minutes,
      variance:
        row.actual_minutes -
        row.no_estimate_actual_minutes -
        row.estimate_minutes,
    });
    const total = db.find((r) => r.dimension === 'total');
    const rows: EffortRow[] = [];
    let unassigned: EffortRow | null = null;

    for (const row of db) {
      if (row.dimension === 'total') continue;

      if (row.dimension === 'tester') {
        const name = row.dimension_id ? names.get(row.dimension_id) : undefined;

        if (!name) {
          unassigned = {
            ...withVariance(sumEffort(unassigned, row)),
            dimension: 'tester',
            dimension_id: null,
            dimension_key: null,
            name: null,
          };
          continue;
        }

        rows.push({
          ...withVariance(row),
          dimension: 'tester',
          dimension_id: row.dimension_id,
          dimension_key: null,
          name,
        });
        continue;
      }

      rows.push({
        ...withVariance(row),
        dimension: row.dimension,
        dimension_id: row.dimension_id,
        dimension_key: row.dimension_key,
        name: null,
      });
    }

    if (unassigned) rows.push(unassigned);

    return {
      rows,
      totals: withVariance(
        total ?? {
          runs: 0,
          estimate_minutes: 0,
          actual_minutes: 0,
          no_estimate_runs: 0,
          no_estimate_actual_minutes: 0,
        },
      ),
    };
  }

  /** Names of testers returned by a report, so only people linked to runs of the space are named. */
  private async userNames(ids: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();

    for (const part of chunk([...new Set(ids)])) {
      const { data, error } = await this.client
        .from('users')
        .select('id, first_name, last_name, email')
        .in('id', part);

      if (error) throw tmDbError(this.logger, 'load tester names', error);

      for (const row of (data ?? []) as (UserNameRow & { id: string })[]) {
        names.set(row.id, userDisplayName(row) || row.id);
      }
    }

    return names;
  }

  private async spaceKey(
    organizationId: string,
    spaceId: string,
  ): Promise<string> {
    const { data, error } = await this.client
      .from('spaces')
      .select('key')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load space key', error);
    if (!data) throw notFound();

    return (data as { key: string }).key;
  }
}

function addCounts<T extends RunStatusCounts>(
  target: T,
  row: RunStatusCounts,
): T {
  return {
    ...target,
    total: target.total + row.total,
    todo: target.todo + row.todo,
    executing: target.executing + row.executing,
    pass: target.pass + row.pass,
    fail: target.fail + row.fail,
    blocked: target.blocked + row.blocked,
    aborted: target.aborted + row.aborted,
    not_applicable: target.not_applicable + row.not_applicable,
  };
}

function sumCounts(rows: RunStatusCounts[]): RunStatusCounts {
  return rows.reduce<RunStatusCounts>((sum, row) => addCounts(sum, row), {
    ...ZERO_COUNTS,
  });
}

function sumPlanCounts(rows: PlanProgressCounts[]): PlanProgressCounts {
  return rows.reduce<PlanProgressCounts>(
    (sum, r) => ({
      tests: sum.tests + r.tests,
      pass: sum.pass + r.pass,
      fail: sum.fail + r.fail,
      blocked: sum.blocked + r.blocked,
      not_run: sum.not_run + r.not_run,
      not_applicable: sum.not_applicable + r.not_applicable,
    }),
    { tests: 0, pass: 0, fail: 0, blocked: 0, not_run: 0, not_applicable: 0 },
  );
}

function runHistoryTotals(rows: RunHistoryRow[]): RunHistoryTotals {
  const sum = rows.reduce(
    (acc, r) => ({
      total: acc.total + r.total,
      pass: acc.pass + r.pass,
      fail: acc.fail + r.fail,
      blocked: acc.blocked + r.blocked,
      aborted: acc.aborted + r.aborted,
      not_applicable: acc.not_applicable + r.not_applicable,
    }),
    { total: 0, pass: 0, fail: 0, blocked: 0, aborted: 0, not_applicable: 0 },
  );

  return { ...sum, pass_rate: ratio(sum.pass, sum.total - sum.not_applicable) };
}

function sumEffort(
  current: Omit<EffortCounts, 'variance'> | null,
  row: Omit<EffortCounts, 'variance'>,
): Omit<EffortCounts, 'variance'> {
  return {
    runs: (current?.runs ?? 0) + row.runs,
    estimate_minutes: (current?.estimate_minutes ?? 0) + row.estimate_minutes,
    actual_minutes: (current?.actual_minutes ?? 0) + row.actual_minutes,
    no_estimate_runs: (current?.no_estimate_runs ?? 0) + row.no_estimate_runs,
    no_estimate_actual_minutes:
      (current?.no_estimate_actual_minutes ?? 0) +
      row.no_estimate_actual_minutes,
  };
}
