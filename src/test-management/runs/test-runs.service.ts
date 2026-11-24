import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TaskPickerItem } from '../../tasks/task-picker/task-picker.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import { removeRecordFiles } from '../common/evidence-storage';
import { TaskVisibilityService } from '../common/task-visibility.service';
import {
  TesterEligibilityService,
  type UserNameRow,
} from '../common/tester-eligibility.service';
import type { RunDefect, RunDefectSource } from '../dto/test-defect.dto';
import {
  RUN_STATUSES,
  STEP_STATUSES,
  TEST_EXECUTION_LIMITS,
  type AddableCase,
  type AddableCasesQueryDto,
  type AddRunsResult,
  type AssignRunsResult,
  type AttemptKind,
  type AttemptSummary,
  type ClaimRunResult,
  type ListTestRunsQueryDto,
  type MyRun,
  type PlanSyncStatus,
  type RemoveRunsResult,
  type RunStatus,
  type StepResult,
  type StepStatus,
  type TestExecutionPage,
  type TestRunDetail,
  type TestRunListItem,
} from '../dto/test-execution.dto';
import type { TestCaseReadiness } from '../dto/test-case.dto';
import type { TestSetPageQueryDto } from '../dto/test-set.dto';
import type { ResultIteration } from '../dto/test-transfer.dto';
import {
  executionArchivedError,
  rpcDetail,
  TestExecutionsService,
  userRef,
} from '../executions/test-executions.service';
import { containsPattern, TestCasesService } from '../cases/test-cases.service';
import {
  notFound,
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../test-management-errors';
import {
  ticketEmbed,
  ticketKeyNumber,
  ticketName,
  ticketSearchFilter,
} from '../common/ticket-keys';

// Keeps each .in() URL well under the 8 KB the stack accepts.
const ID_CHUNK = 100;

// My runs filters and pages in memory over at most this many runs; a view or RPC if people hold more.
const MY_RUNS_CAP = 1000;

// What counts as a result on a run: any recorded attempt work or a linked defect.
const EVIDENCE_SELECT =
  'attempts:test_run_attempts(id, status, step_results, comment, actual_minutes), defects:test_ticket_links(id)';

interface RunEvidence {
  attempts: {
    id: string;
    status: RunStatus;
    step_results: Record<string, unknown> | null;
    comment: string | null;
    actual_minutes: number | null;
  }[];
  defects: { id: string }[];
}

// An attempt aborted before anything was recorded holds no evidence, so it does not block removal.
const EMPTY_STATUSES = new Set<RunStatus>(['TODO', 'ABORTED']);

function hasResults(run: RunEvidence): boolean {
  return (
    run.defects.length > 0 ||
    run.attempts.some(
      (attempt) =>
        !EMPTY_STATUSES.has(attempt.status) ||
        Object.keys(attempt.step_results ?? {}).length > 0 ||
        attempt.comment !== null ||
        attempt.actual_minutes !== null,
    )
  );
}

const USER_COLUMNS = 'id, first_name, last_name, email, avatar_url';

// The current attempt is the one numbered current_attempt_no; PostgREST cannot join on that, so all attempts come along.
const RUN_LIST_SELECT =
  'id, case_id, assignee_id, current_attempt_no, ' +
  'case:test_cases!test_runs_case_fkey(readiness, task:tasks!test_cases_task_id_fkey(key, summary)), ' +
  `assignee:users!test_runs_assignee_id_fkey(${USER_COLUMNS}), ` +
  'attempts:test_run_attempts!test_run_attempts_run_fkey(attempt_no, status, status_overridden, status_changed_at, started_at, finished_at, actual_minutes)';

type UserRow = UserNameRow & { id: string; avatar_url: string | null };

interface RunRow {
  id: string;
  case_id: string;
  assignee_id: string | null;
  current_attempt_no: number;
  case: {
    readiness: TestCaseReadiness;
    task: { key: string; summary: string };
  };
  assignee: UserRow | null;
  attempts: {
    attempt_no: number;
    status: RunStatus;
    status_overridden: boolean;
    status_changed_at: string;
    started_at: string | null;
    finished_at: string | null;
    actual_minutes: number | null;
  }[];
}

type MyRunRow = RunRow & {
  execution: {
    id: string;
    environment: string | null;
    task: { key: string; summary: string };
  };
};

interface StoredStepResult {
  status: StepStatus;
  actual_result: string | null;
  comment: string | null;
  executed_by: string | null;
  executed_at: string;
}

interface CurrentAttemptRow {
  id: string;
  attempt_no: number;
  kind: 'initial' | AttemptKind;
  case_revision: number;
  snapshot: TestRunDetail['current_attempt']['snapshot'];
  status: RunStatus;
  status_overridden: boolean;
  status_changed_at: string;
  step_results: Record<string, StoredStepResult>;
  comment: string | null;
  actual_minutes: number | null;
  started_at: string | null;
  finished_at: string | null;

  // Missing on a database without the Cucumber columns.
  iterations?: ResultIteration[];
}

interface RunDetailRow {
  id: string;
  current_attempt_no: number;
  assignee_id: string | null;
  execution: {
    id: string;
    environment: string | null;
    is_archived: boolean;
    task: { key: string; summary: string };
    plan: { id: string; task: { key: string; summary: string } } | null;
  };
  case: {
    id: string;
    revision: number;
    is_archived: boolean;
    test_type?: string | null;
    definition?: string | null;
    estimate_minutes?: number | null;
    task_id?: string | null;
    task: { key: string };
  };
  assignee: UserRow | null;
  attempts: AttemptSummary[];
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];

  for (let i = 0; i < items.length; i += ID_CHUNK) {
    out.push(items.slice(i, i + ID_CHUNK));
  }

  return out;
}

interface ClaimTarget {
  assigneeId: string | null;
  archived: boolean;
  caseId: string;
  planId: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String((error as { message?: unknown } | null)?.message ?? error);
}

function toListItem(row: RunRow, eligible: Set<string>): TestRunListItem {
  const current = row.attempts.find(
    (attempt) => attempt.attempt_no === row.current_attempt_no,
  );

  return {
    id: row.id,
    case_id: row.case_id,
    case_key: row.case.task.key,
    case_task_key: row.case.task.key,
    case_title: ticketName(row.case.task.summary),
    case_readiness: row.case.readiness,
    assignee: userRef(row.assignee),
    assignee_eligible:
      row.assignee_id === null ? true : eligible.has(row.assignee_id),
    current_attempt_no: row.current_attempt_no,
    status: current?.status ?? 'TODO',
    status_overridden: current?.status_overridden ?? false,
    status_changed_at: current?.status_changed_at ?? '',
    started_at: current?.started_at ?? null,
    finished_at: current?.finished_at ?? null,
    actual_minutes: current?.actual_minutes ?? null,
  };
}

interface SortableRun {
  item: TestRunListItem;
  keyNumber: number;
  assigneeId: string | null;
}

// To do runs count as not executed yet, like the empty "Last executed" cell.
function changedAt(item: TestRunListItem): string | null {
  return item.status === 'TODO' || !item.status_changed_at
    ? null
    : item.status_changed_at;
}

// Same rule as the Duration column: typed minutes first, else finish minus start.
function runMinutes(item: TestRunListItem): number | null {
  if (item.actual_minutes !== null) return item.actual_minutes;
  if (!item.started_at || !item.finished_at) return null;

  const minutes = Math.round(
    (Date.parse(item.finished_at) - Date.parse(item.started_at)) / 60000,
  );

  return Number.isFinite(minutes) ? Math.max(0, minutes) : null;
}

function compareTimes(left: string, right: string): number {
  const diff = Date.parse(left) - Date.parse(right);

  return Number.isFinite(diff) ? diff : left.localeCompare(right);
}

function compareRuns(sort: string | undefined) {
  const [field, direction] = (sort ?? '').split(':');
  const sign = direction === 'desc' ? -1 : 1;

  return (a: SortableRun, b: SortableRun): number => {
    // Unassigned runs sort last in both directions.
    if (field === 'assignee' && !a.item.assignee !== !b.item.assignee) {
      return a.item.assignee ? -1 : 1;
    }

    // To do runs and runs without a status change sort last in both directions.
    if (
      field === 'updated' &&
      (changedAt(a.item) === null) !== (changedAt(b.item) === null)
    ) {
      return changedAt(a.item) === null ? 1 : -1;
    }

    // Runs without a duration sort last in both directions.
    if (
      field === 'duration' &&
      (runMinutes(a.item) === null) !== (runMinutes(b.item) === null)
    ) {
      return runMinutes(a.item) === null ? 1 : -1;
    }

    let result: number;

    if (field === 'title') {
      result = a.item.case_title.localeCompare(b.item.case_title);
    } else if (field === 'status') {
      result =
        RUN_STATUSES.indexOf(a.item.status) -
        RUN_STATUSES.indexOf(b.item.status);
    } else if (field === 'assignee') {
      result = (a.item.assignee?.name ?? '').localeCompare(
        b.item.assignee?.name ?? '',
      );
    } else if (field === 'updated') {
      const left = changedAt(a.item);
      const right = changedAt(b.item);

      result = left === null || right === null ? 0 : compareTimes(left, right);
    } else if (field === 'duration') {
      const left = runMinutes(a.item);
      const right = runMinutes(b.item);

      result = left === null || right === null ? 0 : left - right;
    } else {
      result = a.keyNumber - b.keyNumber;
    }

    // The id keeps the order fixed when keys tie, so a row never shows on two pages.
    return (
      sign * result ||
      a.keyNumber - b.keyNumber ||
      a.item.id.localeCompare(b.item.id)
    );
  };
}

function matchesSearch(item: TestRunListItem, q: string | undefined): boolean {
  if (!q) return true;

  const needle = q.toLowerCase();

  return (
    item.case_key.toLowerCase().includes(needle) ||
    !!item.case_task_key?.toLowerCase().includes(needle) ||
    item.case_title.toLowerCase().includes(needle)
  );
}

function pageOf<T>(items: T[], page = 1, pageSize = 50): TestExecutionPage<T> {
  const from = (page - 1) * pageSize;

  return {
    items: items.slice(from, from + pageSize),
    total: items.length,
    page,
    pageSize,
  };
}

/** Runs of an execution, My runs and the run detail. Result writes live in TestResultsService. */
@Injectable()
export class TestRunsService {
  private readonly logger = new Logger(TestRunsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly eligibility: TesterEligibilityService,
    private readonly executions: TestExecutionsService,
    private readonly auditLogs: AuditLogsService,
    @Optional() private readonly cases?: TestCasesService,
    @Optional() private readonly visibility?: TaskVisibilityService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** At most 1,000 runs per execution, so the current-attempt filters and sort run in memory. */
  async list(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    query: ListTestRunsQueryDto,
  ): Promise<TestExecutionPage<TestRunListItem>> {
    await this.access.assertAvailable(user.organizationId, spaceId);
    await this.executions.load(user.organizationId, spaceId, executionId);

    const { data, error } = await this.client
      .from('test_runs')
      .select(RUN_LIST_SELECT)
      .eq('execution_id', executionId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .range(0, TEST_EXECUTION_LIMITS.runs - 1);

    if (error) throw tmDbError(this.logger, 'list test runs', error);

    const eligible = await this.eligibility.eligibleUserIds(
      user.organizationId,
      spaceId,
    );
    const statuses = query.status?.length ? new Set(query.status) : null;
    const assignee =
      query.assignee === 'me'
        ? user.userId
        : query.assignee === 'unassigned'
          ? null
          : query.assignee?.toLowerCase();

    const items = ((data ?? []) as unknown as RunRow[])
      .map((row) => ({
        item: toListItem(row, eligible),
        keyNumber: ticketKeyNumber(row.case.task.key),
        assigneeId: row.assignee_id,
      }))
      .filter(
        ({ item, assigneeId }) =>
          (!statuses || statuses.has(item.status)) &&
          (assignee === undefined || assigneeId === assignee) &&
          matchesSearch(item, query.q),
      )
      .sort(compareRuns(query.sort))
      .map(({ item }) => item);

    const page = pageOf(items, query.page, query.pageSize);

    if (query.include !== 'steps' || page.items.length === 0) return page;

    return {
      ...page,
      items: await this.withStepCounts(
        user.organizationId,
        spaceId,
        page.items,
      ),
    };
  }

  /** Step totals of each run's current attempt; a step without a result is TODO. Read for one page only. */
  private async withStepCounts(
    organizationId: string,
    spaceId: string,
    items: TestRunListItem[],
  ): Promise<TestRunListItem[]> {
    const { data, error } = await this.client
      .from('test_run_attempts')
      .select('run_id, attempt_no, steps:snapshot->steps, step_results')
      .in(
        'run_id',
        items.map((item) => item.id),
      )
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (error) throw tmDbError(this.logger, 'count run steps', error);

    const attempts = (data ?? []) as {
      run_id: string;
      attempt_no: number;
      steps: { id: string; position: number; action: string }[] | null;
      step_results: Record<string, { status: StepStatus }> | null;
    }[];

    return items.map((item) => {
      const current = attempts.find(
        (attempt) =>
          attempt.run_id === item.id &&
          attempt.attempt_no === item.current_attempt_no,
      );
      const counts = Object.fromEntries(
        STEP_STATUSES.map((status) => [status, 0]),
      ) as Record<StepStatus, number>;
      const steps = (current?.steps ?? []).map((step) => ({
        position: step.position,
        action: step.action,
        status: current?.step_results?.[step.id]?.status ?? 'TODO',
      }));

      for (const step of steps) counts[step.status] += 1;

      return { ...item, step_total: steps.length, step_counts: counts, steps };
    });
  }

  /** Every id must be a run of this execution; null unassigns. Validated first, then written in chunks of 100. */
  async assign(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    runIds: string[],
    assigneeId: string | null,
  ): Promise<AssignRunsResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const execution = await this.executions.load(
      user.organizationId,
      spaceId,
      executionId,
    );

    // Archived executions are read-only; the database only guards result writes.
    if (execution.is_archived) throw executionArchivedError();

    if (assigneeId !== null) {
      await this.eligibility.assertEligible(
        user.organizationId,
        spaceId,
        assigneeId,
      );
    }

    const found = new Map<string, string | null>();
    const caseIds: string[] = [];

    for (const chunk of chunks(runIds)) {
      const { data, error } = await this.client
        .from('test_runs')
        .select('id, assignee_id, case_id')
        .in('id', chunk)
        .eq('execution_id', executionId)
        .eq('space_id', spaceId)
        .eq('organization_id', user.organizationId);

      if (error) throw tmDbError(this.logger, 'check runs to assign', error);

      for (const row of (data ?? []) as {
        id: string;
        assignee_id: string | null;
        case_id: string;
      }[]) {
        found.set(row.id, row.assignee_id);
        caseIds.push(row.case_id);
      }
    }

    const missing = runIds.filter((id) => !found.has(id));

    if (missing.length) throw notFound({ not_found: missing });

    const unchanged = runIds.filter((id) => found.get(id) === assigneeId);
    const toChange = runIds.filter((id) => found.get(id) !== assigneeId).sort();
    let assigned = 0;

    for (const chunk of chunks(toChange)) {
      const { data, error } = await this.client
        .from('test_runs')
        .update({ assignee_id: assigneeId, updated_by: user.userId })
        .in('id', chunk)
        .eq('execution_id', executionId)
        .eq('space_id', spaceId)
        .eq('organization_id', user.organizationId)
        .select('id');

      // A user deleted meanwhile breaks the assignee FK: same generic answer as an ineligible one.
      if (error?.code === '23503') {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'The user cannot be assigned',
        });
      }

      if (error) throw tmDbError(this.logger, 'assign test runs', error);

      assigned += (data ?? []).length;
    }

    if (assigned > 0) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_execution',
        executionId,
        'update',
        {
          space_id: spaceId,
          action: assigneeId ? 'assign_runs' : 'unassign_runs',
          assignee_id: assigneeId,
          runs: assigned,
        },
      );
    }

    const result: AssignRunsResult = { assigned, unchanged };

    // Unassigning leaves the plan's planned tester as it is.
    if (assigneeId !== null && execution.plan) {
      result.plan_sync = await this.syncPlannedTester(
        user.organizationId,
        spaceId,
        execution.plan.id,
        caseIds,
        assigneeId,
      );
    }

    if (assigneeId !== null) {
      const failed = await this.passAssigneeToCases(
        user,
        spaceId,
        [...new Set(caseIds)],
        assigneeId,
      );

      if (failed > 0) result.case_sync_failed = failed;
    }

    return result;
  }

  // The runs are already saved, so a test that can't follow (archived, say) is reported and not undone.
  private async passAssigneeToCases(
    user: RequestUser,
    spaceId: string,
    caseIds: string[],
    assigneeId: string,
  ): Promise<number> {
    let failed = 0;

    for (const caseId of caseIds) {
      try {
        const saved = await this.cases?.setAssignee(
          user,
          spaceId,
          caseId,
          assigneeId,
        );

        if (saved?.ticket_warning) failed += 1;
      } catch (error) {
        this.logger.warn(
          `Assignee not copied to test case ${caseId}: ${errorMessage(error)}`,
        );
        failed += 1;
      }
    }

    return failed;
  }

  /** One conditional update; a retried claim by the same user succeeds again. */
  async claim(
    user: RequestUser,
    spaceId: string,
    runId: string,
  ): Promise<ClaimRunResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });
    await this.eligibility.assertEligible(
      user.organizationId,
      spaceId,
      user.userId,
    );

    const before = await this.loadForClaim(user.organizationId, spaceId, runId);

    // Archived executions are read-only; the database only guards result writes.
    if (before.archived) throw executionArchivedError();

    const { data, error } = await this.client
      .from('test_runs')
      .update({ assignee_id: user.userId, updated_by: user.userId })
      .eq('id', runId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .is('assignee_id', null)
      .select('id, execution_id')
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'claim test run', error);

    if (data) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_execution',
        (data as { execution_id: string }).execution_id,
        'update',
        { space_id: spaceId, action: 'claim_run', run_id: runId },
      );

      return this.claimed(user, spaceId, runId, before, false);
    }

    // Nothing changed: someone holds the run, or it is gone.
    const after = await this.loadForClaim(user.organizationId, spaceId, runId);

    if (after.assigneeId === user.userId) {
      return this.claimed(user, spaceId, runId, after, true);
    }

    throw new ConflictException({
      code: 'ALREADY_ASSIGNED',
      message: 'Someone else already took this run',
    });
  }

  /** Removes a run that holds no result yet: every attempt still TODO with no step result, note or time. */
  async remove(
    user: RequestUser,
    spaceId: string,
    runId: string,
  ): Promise<{ run_id: string; execution_id: string }> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const { data, error } = await this.client
      .from('test_runs')
      .select(
        `id, execution_id, case_id, execution:test_executions!test_runs_execution_fkey(is_archived), ${EVIDENCE_SELECT}`,
      )
      .eq('id', runId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load run to remove', error);
    if (!data) throw notFound();

    const row = data as unknown as RunEvidence & {
      execution_id: string;
      case_id: string;
      execution: { is_archived: boolean } | null;
    };

    if (row.execution?.is_archived) throw executionArchivedError();

    if (
      hasResults(row) ||
      (
        await this.attemptsWithFiles(
          user.organizationId,
          row.attempts.map((attempt) => attempt.id),
        )
      ).size > 0
    ) {
      throw new ConflictException({
        code: 'HAS_RESULTS',
        message: 'Results are recorded for this run, so it cannot be removed',
      });
    }

    // Check then delete; a result saved in between is removed too. A database function closes it if it matters.
    const { data: removed, error: deleteError } = await this.client
      .from('test_runs')
      .delete()
      .eq('id', runId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .select('id');

    if (deleteError)
      throw tmDbError(this.logger, 'remove test run', deleteError);
    if (!removed?.length) throw notFound();

    // A file may have been added after the check above; nothing else would remove it.
    await removeRecordFiles(
      this.client,
      this.logger,
      user.organizationId,
      'test_run_attempt',
      row.attempts.map((attempt) => attempt.id),
      `Test run ${runId} removed`,
    );

    void this.auditLogs.logActionForRequest(
      user,
      'test_execution',
      row.execution_id,
      'update',
      {
        space_id: spaceId,
        action: 'remove_run',
        run_id: runId,
        case_id: row.case_id,
      },
    );

    return { run_id: runId, execution_id: row.execution_id };
  }

  /**
   * Bulk form of remove: every id must be a run of this execution (else 404, nothing written).
   * Runs with results are skipped and listed; the rest go in chunks of 100.
   */
  async removeMany(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    runIds: string[],
  ): Promise<RemoveRunsResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const execution = await this.executions.load(
      user.organizationId,
      spaceId,
      executionId,
    );

    if (execution.is_archived) throw executionArchivedError();

    const found = new Map<string, boolean>();
    const attemptRuns = new Map<string, string>();

    for (const chunk of chunks(runIds)) {
      const { data, error } = await this.client
        .from('test_runs')
        .select(`id, ${EVIDENCE_SELECT}`)
        .in('id', chunk)
        .eq('execution_id', executionId)
        .eq('space_id', spaceId)
        .eq('organization_id', user.organizationId);

      if (error) throw tmDbError(this.logger, 'check runs to remove', error);

      for (const row of (data ?? []) as unknown as (RunEvidence & {
        id: string;
      })[]) {
        found.set(row.id, hasResults(row));

        if (!found.get(row.id)) {
          for (const attempt of row.attempts) {
            attemptRuns.set(attempt.id, row.id);
          }
        }
      }
    }

    const missing = runIds.filter((id) => !found.has(id));

    if (missing.length) throw notFound({ not_found: missing });

    // Evidence files on any attempt count as results too.
    for (const attemptId of await this.attemptsWithFiles(user.organizationId, [
      ...attemptRuns.keys(),
    ])) {
      const runId = attemptRuns.get(attemptId);

      if (runId) found.set(runId, true);
    }

    const skipped = runIds.filter((id) => found.get(id));
    const toRemove = runIds.filter((id) => !found.get(id)).sort();
    let removed = 0;

    // Same check-then-delete gap as remove(); a database function closes it if it matters.
    for (const chunk of chunks(toRemove)) {
      const { data, error } = await this.client
        .from('test_runs')
        .delete()
        .in('id', chunk)
        .eq('execution_id', executionId)
        .eq('space_id', spaceId)
        .eq('organization_id', user.organizationId)
        .select('id');

      if (error) throw tmDbError(this.logger, 'remove test runs', error);

      removed += (data ?? []).length;
    }

    // Same gap as remove(): a file added after the check would stay behind.
    const removedRuns = new Set(toRemove);

    await removeRecordFiles(
      this.client,
      this.logger,
      user.organizationId,
      'test_run_attempt',
      [...attemptRuns]
        .filter(([, runId]) => removedRuns.has(runId))
        .map(([attemptId]) => attemptId),
      `Test runs of execution ${executionId} removed`,
    );

    if (removed > 0) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_execution',
        executionId,
        'update',
        { space_id: spaceId, action: 'remove_runs', runs: removed },
      );
    }

    return { removed, skipped };
  }

  /** Adds cases to an open execution; the database skips ones already there, archived or deprecated. */
  async addRuns(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    caseIds: string[],
  ): Promise<AddRunsResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const { data, error } = (await this.client.rpc('tm_add_execution_runs', {
      p_organization_id: user.organizationId,
      p_space_id: spaceId,
      p_actor_id: user.userId,
      p_execution_id: executionId,
      p_case_ids: caseIds,
    })) as { data: AddRunsResult | null; error: TmRpcError | null };

    // The function lists missing case ids under "missing"; the shared mapper reads "not_found".
    if (error?.code === 'P0002' && Array.isArray(rpcDetail(error).missing)) {
      throw notFound({ not_found: rpcDetail(error).missing });
    }

    if (error) throw tmRpcError(this.logger, 'add test runs', error);

    const result = data ?? { added: 0, skipped: [] };

    if (result.added > 0) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_execution',
        executionId,
        'update',
        { space_id: spaceId, action: 'add_runs', runs: result.added },
      );
    }

    if (result.added === 0) return result;

    const skipped = new Set(result.skipped.map((item) => item.case_id));
    const planSync = await this.addToPlan(
      user,
      spaceId,
      executionId,
      [...new Set(caseIds)].filter((id) => !skipped.has(id)),
    );

    return planSync ? { ...result, plan_sync: planSync } : result;
  }

  /** Active, non-deprecated cases of the space that have no run in this execution yet, for the add picker. */
  async addableCases(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    query: AddableCasesQueryDto,
  ): Promise<TestExecutionPage<AddableCase>> {
    await this.access.assertAvailable(user.organizationId, spaceId);
    await this.executions.load(user.organizationId, spaceId, executionId);

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const from = (page - 1) * pageSize;

    // The runs filter plus `runs is null` keeps only cases without a run in this execution.
    let builder = this.client
      .from('test_cases')
      .select(
        `id, readiness, ${ticketEmbed('test_cases')}, runs:test_runs!test_runs_case_fkey(id)`,
        {
          count: 'exact',
        },
      )
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('is_archived', false)
      .neq('readiness', 'deprecated')
      .eq('runs.execution_id', executionId)
      .is('runs', null);

    if (query.q) {
      builder = builder.or(ticketSearchFilter(containsPattern(query.q)), {
        referencedTable: 'task',
      });
    }

    const { data, error, count } = await builder
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw tmDbError(this.logger, 'list addable test cases', error);

    const rows = (data ?? []) as unknown as (Pick<
      AddableCase,
      'id' | 'readiness'
    > & {
      task: { key: string; summary: string };
    })[];

    return {
      items: rows.map(({ id, task, readiness }) => ({
        id,
        key: task.key,
        task_key: task.key,
        title: ticketName(task.summary),
        readiness,
      })),
      total: count ?? 0,
      page,
      pageSize,
    };
  }

  /** Runs of one case in active executions of this space, newest execution first. */
  async caseRuns(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    query: TestSetPageQueryDto,
  ): Promise<TestExecutionPage<MyRun>> {
    await this.access.assertAvailable(user.organizationId, spaceId);

    const { data, error } = await this.client
      .from('test_runs')
      .select(
        `${RUN_LIST_SELECT}, execution:test_executions!test_runs_execution_fkey!inner(id, environment, is_archived, task:tasks!test_executions_task_id_fkey(key, summary))`,
      )
      .eq('case_id', caseId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('execution.is_archived', false)
      .order('created_at', { ascending: false })
      .order('id')
      .range(0, MY_RUNS_CAP - 1);

    if (error) throw tmDbError(this.logger, 'list case runs', error);

    const eligible = await this.eligibility.eligibleUserIds(
      user.organizationId,
      spaceId,
    );

    const items = ((data ?? []) as unknown as MyRunRow[])
      .sort(
        (a, b) =>
          ticketKeyNumber(b.execution.task.key) -
          ticketKeyNumber(a.execution.task.key),
      )
      .map((row) => ({
        ...toListItem(row, eligible),
        execution: {
          id: row.execution.id,
          key: row.execution.task.key,
          name: ticketName(row.execution.task.summary),
          environment: row.execution.environment,
        },
      }));

    return pageOf(items, query.page, query.pageSize);
  }

  async get(
    user: RequestUser,
    spaceId: string,
    runId: string,
  ): Promise<TestRunDetail> {
    const organizationId = user.organizationId;

    await this.access.assertAvailable(organizationId, spaceId);

    const { data, error } = await this.client
      .from('test_runs')
      .select(
        'id, current_attempt_no, assignee_id, ' +
          'execution:test_executions!test_runs_execution_fkey(id, environment, is_archived, task:tasks!test_executions_task_id_fkey(key, summary), plan:test_plans!test_executions_plan_fkey(id, task:tasks!test_plans_task_id_fkey(key, summary))), ' +
          'case:test_cases!test_runs_case_fkey(id, task_id, revision, is_archived, test_type, definition, estimate_minutes, task:tasks!test_cases_task_id_fkey(key)), ' +
          `assignee:users!test_runs_assignee_id_fkey(${USER_COLUMNS}), ` +
          'attempts:test_run_attempts!test_run_attempts_run_fkey(id, attempt_no, kind, status, created_at)',
      )
      .eq('id', runId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load test run', error);
    if (!data) throw notFound();

    const run = data as unknown as RunDetailRow;

    const { data: attempt, error: attemptError } = await this.client
      .from('test_run_attempts')
      // Every column, so a database without iterations still opens its runs; the response below names each field.
      .select('*')
      .eq('run_id', runId)
      .eq('attempt_no', run.current_attempt_no)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle<CurrentAttemptRow>();

    if (attemptError) {
      throw tmDbError(this.logger, 'load current attempt', attemptError);
    }

    if (!attempt) throw notFound();

    const current = attempt;
    const eligible = await this.eligibility.eligibleUserIds(
      organizationId,
      spaceId,
    );
    const people = await this.users(
      Object.values(current.step_results)
        .map((result) => result.executed_by)
        .filter((id): id is string => Boolean(id)),
    );

    const stepResults: Record<string, StepResult> = {};

    for (const [stepId, result] of Object.entries(current.step_results)) {
      stepResults[stepId] = {
        status: result.status,
        actual_result: result.actual_result ?? null,
        comment: result.comment ?? null,

        // A deleted user keeps the id but loses the name.
        executed_by: result.executed_by
          ? (people.get(result.executed_by) ?? {
              id: result.executed_by,
              name: null,
              avatar_url: null,
            })
          : null,
        executed_at: result.executed_at,
      };
    }

    return {
      id: run.id,
      execution: {
        id: run.execution.id,
        key: run.execution.task.key,
        name: ticketName(run.execution.task.summary),
        environment: run.execution.environment,
        is_archived: run.execution.is_archived,
        plan: run.execution.plan
          ? {
              id: run.execution.plan.id,
              key: run.execution.plan.task.key,
              name: ticketName(run.execution.plan.task.summary),
            }
          : null,
      },
      case: {
        id: run.case.id,
        key: run.case.task.key,
        task_key: run.case.task.key,
        revision: run.case.revision,
        is_archived: run.case.is_archived,
        test_type: run.case.test_type,
        definition: run.case.definition,
        estimate_minutes: run.case.estimate_minutes,
        task_id: run.case.task_id,
      },
      assignee: userRef(run.assignee),
      assignee_eligible:
        run.assignee_id === null ? true : eligible.has(run.assignee_id),
      current_attempt: {
        id: current.id,
        attempt_no: current.attempt_no,
        kind: current.kind,
        case_revision: current.case_revision,
        snapshot: current.snapshot,
        status: current.status,
        status_overridden: current.status_overridden,
        status_changed_at: current.status_changed_at,
        step_results: stepResults,
        comment: current.comment,
        actual_minutes: current.actual_minutes,
        started_at: current.started_at,
        finished_at: current.finished_at,
        iterations: current.iterations ?? [],
      },
      attempts: [...run.attempts].sort((a, b) => b.attempt_no - a.attempt_no),
      defects: await this.defects(user, spaceId, runId, run.case.id),
    };
  }

  /**
   * Tickets linked as defects to this run, and to its test case or a test set or plan that contains the
   * case. A ticket reached in several ways is listed once, by the closest link: run, case, set, plan.
   */
  private async defects(
    user: RequestUser,
    spaceId: string,
    runId: string,
    caseId: string,
  ): Promise<RunDefect[]> {
    const organizationId = user.organizationId;

    const { data, error } = await this.client
      .from('test_ticket_links')
      .select('task_id, attempt_no, created_at')
      .eq('run_id', runId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) throw tmDbError(this.logger, 'load run defects', error);

    const [setsResult, plansResult] = await Promise.all([
      this.client
        .from('test_set_members')
        .select('set_id')
        .eq('case_id', caseId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId),
      this.client
        .from('test_plan_tests')
        .select('plan_id')
        .eq('case_id', caseId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId),
    ]);

    if (setsResult.error) {
      throw tmDbError(this.logger, 'load sets of the case', setsResult.error);
    }

    if (plansResult.error) {
      throw tmDbError(this.logger, 'load plans of the case', plansResult.error);
    }

    const setIds = ((setsResult.data ?? []) as { set_id: string }[]).map(
      (row) => row.set_id,
    );
    const planIds = ((plansResult.data ?? []) as { plan_id: string }[]).map(
      (row) => row.plan_id,
    );
    const targets = [
      `case_id.eq.${caseId}`,
      ...(setIds.length ? [`set_id.in.(${setIds.join(',')})`] : []),
      ...(planIds.length ? [`plan_id.in.(${planIds.join(',')})`] : []),
    ];

    const { data: itemData, error: itemError } = await this.client
      .from('test_ticket_links')
      .select(
        'task_id, created_at, case_id, set_id, plan_id, ' +
          'set:test_sets!test_ticket_links_set_fkey(task:tasks!test_sets_task_id_fkey(key)), plan:test_plans!test_ticket_links_plan_fkey(task:tasks!test_plans_task_id_fkey(key))',
      )
      .eq('link_type', 'defect')
      .is('run_id', null)
      .or(targets.join(','))
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (itemError) {
      throw tmDbError(this.logger, 'load case defects', itemError);
    }

    const RANK: Record<RunDefectSource, number> = {
      run: 0,
      case: 1,
      set: 2,
      plan: 3,
    };

    const candidates = [
      ...(
        (data ?? []) as {
          task_id: string;
          attempt_no: number | null;
          created_at: string;
        }[]
      ).map((row) => ({
        ...row,
        source: 'run' as RunDefectSource,
        via_key: null as string | null,
      })),
      ...(
        (itemData ?? []) as unknown as {
          task_id: string;
          created_at: string;
          case_id: string | null;
          set_id: string | null;
          set: { task: { key: string } } | null;
          plan: { task: { key: string } } | null;
        }[]
      ).map((row) => {
        const source: RunDefectSource = row.case_id
          ? 'case'
          : row.set_id
            ? 'set'
            : 'plan';

        return {
          task_id: row.task_id,
          attempt_no: null,
          created_at: row.created_at,
          source,
          via_key:
            source === 'set'
              ? (row.set?.task.key ?? null)
              : source === 'plan'
                ? (row.plan?.task.key ?? null)
                : null,
        };
      }),
    ];

    // The closest link wins; the list keeps run links first, then the others oldest first.
    const byTask = new Map<string, (typeof candidates)[number]>();

    for (const row of candidates) {
      const kept = byTask.get(row.task_id);

      if (!kept || RANK[row.source] < RANK[kept.source]) {
        byTask.set(row.task_id, row);
      }
    }

    const rows = candidates.filter((row) => byTask.get(row.task_id) === row);

    if (rows.length === 0) return [];

    const visible =
      (await this.visibility?.visibleTasks(
        user,
        rows.map((row) => row.task_id),
      )) ?? new Map<string, TaskPickerItem>();

    return rows.map((row): RunDefect => {
      const item = visible.get(row.task_id);

      if (!item) {
        return {
          task_id: row.task_id,
          restricted: true,
          source: row.source,
          via_key: row.via_key,
          attempt_no: row.attempt_no,
          created_at: row.created_at,
        };
      }

      return {
        task_id: row.task_id,
        restricted: false,
        source: row.source,
        via_key: row.via_key,
        key: item.key,
        summary: item.summary,
        status: item.status
          ? {
              name: item.status.name,
              color: item.status.color,
              is_completed: item.status.isCompleted,
            }
          : null,
        space_key: item.spaceKey,
        attempt_no: row.attempt_no,
        created_at: row.created_at,
      };
    });
  }

  /** Attempts among these ids that hold evidence files or File Explorer file links. */
  private async attemptsWithFiles(
    organizationId: string,
    attemptIds: string[],
  ): Promise<Set<string>> {
    const withFiles = new Set<string>();

    for (const chunk of chunks(attemptIds)) {
      const { data, error } = await this.client
        .from('file_attachments')
        .select('entity_id')
        .eq('entity_type', 'test_run_attempt')
        .in('entity_id', chunk)
        .eq('organization_id', organizationId);

      if (error)
        throw tmDbError(this.logger, 'check run evidence files', error);

      for (const row of (data ?? []) as { entity_id: string }[]) {
        withFiles.add(row.entity_id);
      }
    }

    // Linked File Explorer files are evidence too; only attempts not already found are checked.
    for (const chunk of chunks(attemptIds.filter((id) => !withFiles.has(id)))) {
      const { data, error } = await this.client
        .from('entity_file_links')
        .select('entity_id')
        .eq('entity_type', 'test_run_attempt')
        .in('entity_id', chunk)
        .eq('organization_id', organizationId);

      if (error)
        throw tmDbError(this.logger, 'check run evidence file links', error);

      for (const row of (data ?? []) as { entity_id: string }[]) {
        withFiles.add(row.entity_id);
      }
    }

    return withFiles;
  }

  private async loadForClaim(
    organizationId: string,
    spaceId: string,
    runId: string,
  ): Promise<ClaimTarget> {
    const { data, error } = await this.client
      .from('test_runs')
      .select(
        'assignee_id, case_id, execution:test_executions!test_runs_execution_fkey(is_archived, plan_id)',
      )
      .eq('id', runId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load run to claim', error);
    if (!data) throw notFound();

    const row = data as unknown as {
      assignee_id: string | null;
      case_id: string;
      execution: { is_archived: boolean; plan_id: string | null } | null;
    };

    return {
      assigneeId: row.assignee_id,
      archived: row.execution?.is_archived ?? false,
      caseId: row.case_id,
      planId: row.execution?.plan_id ?? null,
    };
  }

  private async claimed(
    user: RequestUser,
    spaceId: string,
    runId: string,
    target: ClaimTarget,
    alreadyYours: boolean,
  ): Promise<ClaimRunResult> {
    const result: ClaimRunResult = {
      run_id: runId,
      assignee_id: user.userId,
      already_yours: alreadyYours,
    };

    if (target.planId) {
      result.plan_sync = await this.syncPlannedTester(
        user.organizationId,
        spaceId,
        target.planId,
        [target.caseId],
        user.userId,
      );
    }

    return result;
  }

  /** Same write as setting a planned tester in the plan; only cases already in the plan change. Never throws. */
  private async syncPlannedTester(
    organizationId: string,
    spaceId: string,
    planId: string,
    caseIds: string[],
    testerId: string,
  ): Promise<PlanSyncStatus> {
    try {
      const { data, error } = await this.client
        .from('test_plans')
        .select('is_archived')
        .eq('id', planId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error('test plan not found');

      if ((data as { is_archived: boolean }).is_archived) {
        this.logger.warn(
          `Planned tester not copied: plan ${planId} is archived`,
        );

        return 'skipped_archived';
      }

      for (const chunk of chunks(caseIds)) {
        const { error: updateError } = await this.client
          .from('test_plan_tests')
          .update({ planned_tester_id: testerId })
          .eq('plan_id', planId)
          .in('case_id', chunk)
          .eq('space_id', spaceId)
          .eq('organization_id', organizationId);

        if (updateError) throw updateError;
      }

      return 'ok';
    } catch (error) {
      this.logger.warn(
        `Planned tester not copied to plan ${planId}: ${errorMessage(error)}`,
      );

      return 'failed';
    }
  }

  /** Adds newly added execution cases to the execution's plan; undefined when it has no plan. Never throws. */
  async addToPlan(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    caseIds: string[],
  ): Promise<PlanSyncStatus | undefined> {
    let planId: string | undefined;

    try {
      const execution = await this.executions.load(
        user.organizationId,
        spaceId,
        executionId,
      );

      planId = execution.plan?.id;

      if (!planId) return undefined;
      if (caseIds.length === 0) return 'ok';

      const { data, error } = (await this.client.rpc('tm_add_plan_tests', {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_plan_id: planId,
        p_case_ids: caseIds,
        p_set_id: null,
        p_folder_id: null,
        p_include_subfolders: true,
      })) as {
        data: { changed: boolean; added: string[] } | null;
        error: TmRpcError | null;
      };

      if (error?.code === 'TM004') {
        this.logger.warn(`Cases not added: plan ${planId} is archived`);

        return 'skipped_archived';
      }

      if (error) throw new Error(error.message);

      if (data?.changed && data.added.length > 0) {
        void this.auditLogs.logActionForRequest(
          user,
          'test_plan',
          planId,
          'update',
          {
            action: 'tests_added_from_execution',
            space_id: spaceId,
            execution_id: executionId,
            case_ids: data.added,
          },
        );
      }

      return 'ok';
    } catch (error) {
      this.logger.warn(
        `Cases of execution ${executionId} not added to plan ${planId ?? '?'}: ${errorMessage(error)}`,
      );

      return 'failed';
    }
  }

  private async users(ids: string[]) {
    const unique = [...new Set(ids)];
    const found = new Map<string, NonNullable<ReturnType<typeof userRef>>>();

    for (const chunk of chunks(unique)) {
      const { data, error } = await this.client
        .from('users')
        .select(USER_COLUMNS)
        .in('id', chunk);

      if (error) throw tmDbError(this.logger, 'load result authors', error);

      for (const row of (data ?? []) as UserRow[]) {
        const ref = userRef(row);

        if (ref) found.set(row.id, ref);
      }
    }

    return found;
  }
}
