import { ConflictException, Injectable, Logger } from '@nestjs/common';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import {
  chunk,
  TesterEligibilityService,
  userDisplayName,
  type UserNameRow,
} from '../common/tester-eligibility.service';
import type { TestCaseReadiness } from '../dto/test-case.dto';
import type {
  AddPlanTestsDto,
  EligibleTester,
  FinalStatus,
  PlanTestsAdded,
  PlanTestsRemoved,
  TestPlan,
  TestPlanPage,
  TestPlanProgress,
  TestPlanTestsQueryDto,
  TestPlanRunHistory,
  TestPlanTest,
} from '../dto/test-plan.dto';
import { FINAL_STATUSES, TEST_PLAN_LIMITS } from '../dto/test-plan.dto';
import {
  notFound,
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../test-management-errors';
import {
  ticketEmbed,
  ticketKeyFields,
  ticketName,
  ticketSearchFilter,
} from '../common/ticket-keys';
import { containsPattern } from '../cases/test-cases.service';
import {
  fetchPage,
  planArchivedError,
  TestPlansService,
} from './test-plans.service';

// test_plan_tests has two FKs to users, so the tester embed names its FK.
const PLAN_TEST_COLUMNS = `id, readiness, test_type, is_archived, ${ticketEmbed('test_cases')}, test_plan_tests!test_plan_tests_case_fkey!inner(plan_id, added_at, tester:users!test_plan_tests_planned_tester_id_fkey(id, first_name, last_name, email, avatar_url))`;

const PLAN_TEST_ID_COLUMNS =
  'id, test_plan_tests!test_plan_tests_case_fkey!inner(plan_id)';

// The count needs the ticket join too when a search filters on it.
const PLAN_TEST_SEARCH_ID_COLUMNS = `${PLAN_TEST_ID_COLUMNS}, ${ticketEmbed('test_cases', 'key')}`;

// Sort fields map to fixed columns; the client value never reaches the query.
const PLAN_TEST_SORT_COLUMNS = new Map<string, string>([
  ['key', 'created_at'],
  ['title', 'task(summary)'],
  ['readiness', 'readiness'],
  ['test_type', 'test_type'],
]);

type PlanTestFilters = Pick<
  TestPlanTestsQueryDto,
  'q' | 'readiness' | 'testType' | 'tester'
>;

interface TesterRow extends UserNameRow {
  id: string;
  avatar_url: string | null;
}

interface PlanTestRow {
  id: string;
  readiness: TestCaseReadiness;
  test_type: string;
  is_archived: boolean;
  test_plan_tests: { added_at: string; tester: TesterRow | null }[];
  task: { key: string; summary: string };
}

interface AddPlanTestsResult {
  changed: boolean;
  added: string[];
  already_present: string[];
  skipped: PlanTestsAdded['skipped'];
  warnings: PlanTestsAdded['warnings'];
}

interface CaseStatusRow {
  case_id: string;
  status: string | null;
}

interface RunHistoryRow {
  finished_at: string;
  status: FinalStatus;
  run: { case_id: string };
}

interface ProgressRow {
  case_id: string;
  planned_tester_id: string | null;
  test_case: { readiness: TestCaseReadiness; is_archived: boolean } | null;
  tester: (UserNameRow & { avatar_url: string | null }) | null;
}

/** DETAIL json of a tm_* error, or {} when it is missing or not an object. */
function rpcDetail(error: TmRpcError): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(error.details ?? '');

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isFinalStatus(status: string | null): status is FinalStatus {
  return (FINAL_STATUSES as readonly (string | null)[]).includes(status);
}

/** Tests in a plan, their planned testers and the plan's progress. */
@Injectable()
export class TestPlanTestsService {
  private readonly logger = new Logger(TestPlanTestsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly auditLogs: AuditLogsService,
    private readonly plans: TestPlansService,
    private readonly eligibility: TesterEligibilityService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async tests(
    organizationId: string,
    spaceId: string,
    planId: string,
    query: TestPlanTestsQueryDto,
  ): Promise<TestPlanPage<TestPlanTest>> {
    await this.access.assertAvailable(organizationId, spaceId);

    // A foreign plan is a 404, not an empty page.
    await this.plans.load(organizationId, spaceId, planId, 'id');

    const [field, direction] = (query.sort ?? '').split(':');
    const column = PLAN_TEST_SORT_COLUMNS.get(field) ?? 'created_at';
    const ascending = direction !== 'desc';
    const filters: PlanTestFilters = {
      q: query.q,
      readiness: query.readiness,
      testType: query.testType,
      tester: query.tester,
    };

    const result = await fetchPage<PlanTestRow>(
      this.logger,
      'list test plan tests',
      query,
      (from, to) =>
        this.planTests(
          organizationId,
          spaceId,
          planId,
          PLAN_TEST_COLUMNS,
          false,
          filters,
        )
          .order(column, { ascending })
          .order('id', { ascending: true })
          .range(from, to),
      () =>
        this.planTests(
          organizationId,
          spaceId,
          planId,
          query.q ? PLAN_TEST_SEARCH_ID_COLUMNS : PLAN_TEST_ID_COLUMNS,
          true,
          filters,
        ),
    );

    return {
      ...result,
      items: await this.toPlanTests(organizationId, spaceId, result.items),
    };
  }

  /** Ids of every case in the plan (at most the plan limit), so a picker can mark them as already added. */
  async testIds(
    organizationId: string,
    spaceId: string,
    planId: string,
  ): Promise<string[]> {
    await this.access.assertAvailable(organizationId, spaceId);
    await this.plans.load(organizationId, spaceId, planId, 'id');

    const { data, error } = await this.client
      .from('test_plan_tests')
      .select('case_id')
      .eq('plan_id', planId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .range(0, TEST_PLAN_LIMITS.tests - 1);

    if (error) throw tmDbError(this.logger, 'list test plan case ids', error);

    return ((data ?? []) as { case_id: string }[]).map((row) => row.case_id);
  }

  async eligibleTesters(
    organizationId: string,
    spaceId: string,
    planId: string,
  ): Promise<EligibleTester[]> {
    await this.access.assertAvailable(organizationId, spaceId);
    await this.plans.load(organizationId, spaceId, planId, 'id');

    return this.eligibility.listEligible(organizationId, spaceId);
  }

  async add(
    user: RequestUser,
    spaceId: string,
    planId: string,
    dto: AddPlanTestsDto,
  ): Promise<PlanTestsAdded> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const { data, error } = (await this.client.rpc('tm_add_plan_tests', {
      p_organization_id: user.organizationId,
      p_space_id: spaceId,
      p_actor_id: user.userId,
      p_plan_id: planId,
      p_case_ids: dto.source === 'cases' ? dto.case_ids : null,
      p_set_id: dto.source === 'set' ? dto.set_id : null,
      p_folder_id: dto.source === 'folder' ? dto.folder_id : null,
      p_include_subfolders: dto.include_subfolders ?? true,
    })) as { data: AddPlanTestsResult; error: TmRpcError | null };

    if (error) throw this.addError(error);

    const result: PlanTestsAdded = {
      changed: data.changed,
      added: data.added.length,
      already_present: data.already_present.length,
      skipped: data.skipped,
      warnings: data.warnings,
    };

    if (result.changed) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_plan',
        planId,
        'update',
        { space_id: spaceId, added: result.added },
      );
    }

    return result;
  }

  /** Every id must be a case of this space; ids that are not in the plan are a no-op. */
  async remove(
    user: RequestUser,
    spaceId: string,
    planId: string,
    caseIds: string[],
  ): Promise<PlanTestsRemoved> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });
    await this.loadActive(user.organizationId, spaceId, planId);

    // Chunked: 500 uuids in one .in() make a URL the stack refuses with 414.
    const parts = chunk(caseIds);
    const found = new Set<string>();

    for (const part of parts) {
      const { data, error } = await this.client
        .from('test_cases')
        .select('id')
        .eq('space_id', spaceId)
        .eq('organization_id', user.organizationId)
        .in('id', part);

      if (error) throw tmDbError(this.logger, 'check test cases', error);

      for (const row of (data ?? []) as { id: string }[]) found.add(row.id);
    }

    const missing = caseIds.filter((id) => !found.has(id));

    if (missing.length > 0) throw notFound({ not_found: missing });

    let removed = 0;

    for (const part of parts) {
      const { data, error } = await this.client
        .from('test_plan_tests')
        .delete()
        .eq('plan_id', planId)
        .eq('space_id', spaceId)
        .eq('organization_id', user.organizationId)
        .in('case_id', part)
        .select('case_id');

      if (error) {
        throw tmDbError(this.logger, 'remove tests from test plan', error);
      }

      removed += (data ?? []).length;
    }

    if (removed > 0) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_plan',
        planId,
        'update',
        { space_id: spaceId, removed },
      );
    }

    return { removed };
  }

  async setPlannedTester(
    user: RequestUser,
    spaceId: string,
    planId: string,
    caseId: string,
    testerId: string | null,
  ): Promise<TestPlanTest> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });
    await this.loadActive(user.organizationId, spaceId, planId);

    if (testerId !== null) {
      await this.eligibility.assertEligible(
        user.organizationId,
        spaceId,
        testerId,
      );
    }

    const { data, error } = await this.client
      .from('test_plan_tests')
      .update({ planned_tester_id: testerId })
      .eq('plan_id', planId)
      .eq('case_id', caseId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .select('case_id');

    if (error) throw tmDbError(this.logger, 'set planned tester', error);
    if ((data ?? []).length === 0) throw notFound();

    void this.auditLogs.logActionForRequest(
      user,
      'test_plan',
      planId,
      'update',
      { space_id: spaceId, case_id: caseId, planned_tester_id: testerId },
    );

    const { data: row, error: readError } = await this.planTests(
      user.organizationId,
      spaceId,
      planId,
      PLAN_TEST_COLUMNS,
    )
      .eq('id', caseId)
      .maybeSingle();

    if (readError) throw tmDbError(this.logger, 'load plan test', readError);
    if (!row) throw notFound();

    const [test] = await this.toPlanTests(user.organizationId, spaceId, [
      row as unknown as PlanTestRow,
    ]);

    return test;
  }

  /**
   * Archived and deprecated cases stay in the plan but are left out of the totals and the
   * success rate; they are reported under `excluded` (archived wins when both apply).
   */
  async progress(
    organizationId: string,
    spaceId: string,
    planId: string,
  ): Promise<TestPlanProgress> {
    await this.access.assertAvailable(organizationId, spaceId);
    await this.plans.load(organizationId, spaceId, planId, 'id');

    const { data: statusData, error: statusError } = (await this.client.rpc(
      'tm_case_status_in_scope',
      {
        p_organization_id: organizationId,
        p_space_id: spaceId,
        p_plan_id: planId,
        p_case_ids: null,
        p_exclude_execution_id: null,
      },
    )) as { data: CaseStatusRow[] | null; error: TmRpcError | null };

    if (statusError) {
      throw tmRpcError(this.logger, 'load test plan progress', statusError);
    }

    const { data, error } = await this.client
      .from('test_plan_tests')
      .select(
        'case_id, planned_tester_id, test_case:test_cases!test_plan_tests_case_fkey(readiness, is_archived), tester:users!test_plan_tests_planned_tester_id_fkey(first_name, last_name, email, avatar_url)',
      )
      .eq('plan_id', planId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .range(0, TEST_PLAN_LIMITS.tests - 1);

    if (error) throw tmDbError(this.logger, 'load test plan progress', error);

    const statusByCase = new Map(
      (statusData ?? []).map((row) => [row.case_id, row.status]),
    );
    const counts: TestPlanProgress['counts'] = {
      PASS: 0,
      FAIL: 0,
      BLOCKED: 0,
      ABORTED: 0,
      NOT_APPLICABLE: 0,
      NOT_RUN: 0,
    };
    const excluded = { archived: 0, deprecated: 0 };
    const byTester = new Map<string | null, TestPlanProgress['by_tester'][0]>();
    let total = 0;

    for (const row of (data ?? []) as unknown as ProgressRow[]) {
      if (row.test_case?.is_archived) {
        excluded.archived += 1;
        continue;
      }

      if (row.test_case?.readiness === 'deprecated') {
        excluded.deprecated += 1;
        continue;
      }

      const status = statusByCase.get(row.case_id) ?? null;
      const final = isFinalStatus(status);

      counts[final ? status : 'NOT_RUN'] += 1;
      total += 1;

      const testerId = row.planned_tester_id;
      const entry = byTester.get(testerId) ?? {
        user_id: testerId,
        name: row.tester ? userDisplayName(row.tester) : null,
        avatar_url: row.tester?.avatar_url ?? null,
        total: 0,
        final: 0,
      };

      entry.total += 1;
      if (final) entry.final += 1;
      byTester.set(testerId, entry);
    }

    const denominator = total - counts.NOT_APPLICABLE;

    return {
      total_tests: total,
      counts,
      success_rate:
        denominator > 0
          ? Math.round((counts.PASS / denominator) * 10000) / 10000
          : null,
      excluded,
      by_tester: [...byTester.values()],
    };
  }

  /** Finished attempts in the plan's executions over the last `days` days, oldest first. */
  async runHistory(
    organizationId: string,
    spaceId: string,
    planId: string,
    days: number,
  ): Promise<TestPlanRunHistory> {
    await this.access.assertAvailable(organizationId, spaceId);
    await this.plans.load(organizationId, spaceId, planId, 'id');

    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    // The API returns at most 1000 rows, so read newest first and keep the newest.
    const { data, error } = await this.client
      .from('test_run_attempts')
      .select(
        'finished_at, status, run:test_runs!test_run_attempts_run_fkey!inner(case_id, execution:test_executions!test_runs_execution_fkey!inner(plan_id, is_archived))',
      )
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('run.execution.plan_id', planId)
      .eq('run.execution.is_archived', false)
      .in('status', FINAL_STATUSES)
      .not('finished_at', 'is', null)
      .gte('finished_at', since)
      .order('finished_at', { ascending: false })
      .range(0, 999);

    if (error) {
      throw tmDbError(this.logger, 'load test plan run history', error);
    }

    const items = ((data ?? []) as unknown as RunHistoryRow[])
      .reverse()
      .map((row) => ({
        finished_at: row.finished_at,
        status: row.status,
        case_id: row.run.case_id,
      }));

    return { since, items };
  }

  /** Cases of the plan, joined through test_plan_tests so the list sorts by case. */
  private planTests(
    organizationId: string,
    spaceId: string,
    planId: string,
    columns: string,
    head = false,
    filters?: PlanTestFilters,
  ) {
    let builder = this.client
      .from('test_cases')
      .select(columns, { count: 'exact', head })
      .eq('test_plan_tests.plan_id', planId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (filters?.readiness?.length)
      builder = builder.in('readiness', filters.readiness);
    if (filters?.testType) builder = builder.eq('test_type', filters.testType);
    if (filters?.tester === 'unassigned') {
      builder = builder.is('test_plan_tests.planned_tester_id', null);
    } else if (filters?.tester) {
      builder = builder.eq('test_plan_tests.planned_tester_id', filters.tester);
    }
    if (filters?.q) {
      builder = builder.or(ticketSearchFilter(containsPattern(filters.q)), {
        referencedTable: 'task',
      });
    }

    return builder;
  }

  private async toPlanTests(
    organizationId: string,
    spaceId: string,
    rows: PlanTestRow[],
  ): Promise<TestPlanTest[]> {
    const hasTester = rows.some((row) => row.test_plan_tests[0]?.tester);

    // One eligibility batch per request, and none when no test has a tester.
    const eligible = hasTester
      ? await this.eligibility.eligibleUserIds(organizationId, spaceId)
      : new Set<string>();

    return rows.map((row) => {
      const planTest = row.test_plan_tests[0];
      const tester = planTest?.tester ?? null;

      return {
        case_id: row.id,
        ...ticketKeyFields(row.task.key),
        title: ticketName(row.task.summary),
        readiness: row.readiness,
        test_type: row.test_type,
        is_archived: row.is_archived,
        added_at: planTest?.added_at ?? '',
        planned_tester: tester
          ? {
              id: tester.id,
              name: userDisplayName(tester),
              avatar_url: tester.avatar_url,
              eligible: eligible.has(tester.id),
            }
          : null,
      };
    });
  }

  /** 404 for a foreign or missing plan, 409 when it is archived. */
  private async loadActive(
    organizationId: string,
    spaceId: string,
    planId: string,
  ): Promise<TestPlan> {
    const plan = await this.plans.load(
      organizationId,
      spaceId,
      planId,
      'id, is_archived',
    );

    if (plan.is_archived) throw planArchivedError();

    return plan;
  }

  /** Errors whose DETAIL says more than the shared mapping can tell the client. */
  private addError(error: TmRpcError) {
    const detail = rpcDetail(error);

    if (error.code === '23503') {
      return new ConflictException({
        code: 'IN_USE',
        message: 'A test case was deleted while it was being added. Try again.',
      });
    }

    if (error.code === 'P0002' && Array.isArray(detail.missing)) {
      return notFound({ not_found: detail.missing });
    }

    if (error.code === 'TM004' && detail.set_id) {
      return new ConflictException({
        code: 'ARCHIVED',
        message: 'The test set is archived',
        data: { set_id: detail.set_id },
      });
    }

    return tmRpcError(this.logger, 'add tests to test plan', error);
  }
}
