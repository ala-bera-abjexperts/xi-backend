import { Injectable, Logger } from '@nestjs/common';

import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import type { UserNameRow } from '../common/tester-eligibility.service';
import {
  RUN_STATUSES,
  STEP_STATUSES,
  type AttemptKind,
  type RunStatus,
  type StepResult,
  type StepStatus,
  type TestExecutionPage,
} from '../dto/test-execution.dto';
import type {
  AttemptDetail,
  AttemptHistoryItem,
  AttemptHistoryQueryDto,
  AttemptSnapshot,
  AttemptSortField,
} from '../dto/test-history.dto';
import { userRef } from '../executions/test-executions.service';
import { notFound, tmDbError } from '../test-management-errors';

const USER_COLUMNS = 'id, first_name, last_name, email, avatar_url';
const ID_CHUNK = 100;

const ATTEMPT_COLUMNS =
  'id, run_id, attempt_no, kind, case_revision, snapshot, status, status_overridden, step_results, ' +
  'comment, actual_minutes, started_at, finished_at, created_at, ' +
  `creator:users!test_run_attempts_created_by_fkey(${USER_COLUMNS})`;

type UserRow = UserNameRow & { id: string; avatar_url: string | null };

interface StoredStepResult {
  status: StepStatus;
  actual_result: string | null;
  comment: string | null;
  executed_by: string | null;
  executed_at: string;
}

interface AttemptRow {
  id: string;
  run_id: string;
  attempt_no: number;
  kind: 'initial' | AttemptKind;
  case_revision: number;
  snapshot: AttemptSnapshot;
  status: RunStatus;
  status_overridden: boolean;
  step_results: Record<string, StoredStepResult> | null;
  comment: string | null;
  actual_minutes: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  creator: UserRow | null;
}

function stepCounts(row: AttemptRow): Record<StepStatus, number> {
  const counts = Object.fromEntries(
    STEP_STATUSES.map((status) => [status, 0]),
  ) as Record<StepStatus, number>;

  for (const step of row.snapshot?.steps ?? []) {
    counts[row.step_results?.[step.id]?.status ?? 'TODO'] += 1;
  }

  return counts;
}

function toItem(row: AttemptRow, currentAttemptNo: number): AttemptHistoryItem {
  return {
    id: row.id,
    attempt_no: row.attempt_no,
    kind: row.kind,
    status: row.status,
    status_overridden: row.status_overridden,
    comment: row.comment,
    actual_minutes: row.actual_minutes,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
    created_by: userRef(row.creator),
    is_current: row.attempt_no === currentAttemptNo,
    counts: stepCounts(row),
  };
}

function passRate(item: AttemptHistoryItem): number {
  const total = STEP_STATUSES.reduce(
    (sum, status) => sum + item.counts[status],
    0,
  );

  return total === 0 ? -1 : item.counts.PASS / total;
}

function compareBy(
  a: AttemptHistoryItem,
  b: AttemptHistoryItem,
  field: AttemptSortField,
): number {
  switch (field) {
    case 'attempt':
      return a.attempt_no - b.attempt_no;
    case 'result':
      return RUN_STATUSES.indexOf(a.status) - RUN_STATUSES.indexOf(b.status);
    case 'steps':
      return passRate(a) - passRate(b);
    case 'tester':
      return (a.created_by?.name ?? '').localeCompare(b.created_by?.name ?? '');
    case 'ran':
      return (
        Date.parse(a.started_at ?? a.created_at) -
        Date.parse(b.started_at ?? b.created_at)
      );
    case 'time':
      return (a.actual_minutes ?? -1) - (b.actual_minutes ?? -1);
  }
}

/** `field:dir` sort; ties fall back to the newest attempt first. */
export function compareAttempts(sort = 'attempt:desc') {
  const [field, direction] = sort.split(':') as [AttemptSortField, string?];
  const factor = direction === 'asc' ? 1 : -1;

  return (a: AttemptHistoryItem, b: AttemptHistoryItem) =>
    compareBy(a, b, field) * factor || b.attempt_no - a.attempt_no;
}

/** Run attempt history (A24). Read-only: earlier attempts are never changed here. */
@Injectable()
export class TestHistoryService {
  private readonly logger = new Logger(TestHistoryService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Attempts of a run, newest first unless sorted, optionally filtered by result or kind. */
  async listAttempts(
    organizationId: string,
    spaceId: string,
    runId: string,
    query: AttemptHistoryQueryDto,
  ): Promise<TestExecutionPage<AttemptHistoryItem>> {
    await this.access.assertAvailable(organizationId, spaceId);

    const currentAttemptNo = await this.currentAttemptNo(
      organizationId,
      spaceId,
      runId,
    );
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const from = (page - 1) * pageSize;

    // loads every attempt of the run and sorts in code (Steps cannot be sorted in SQL); switch to SQL order + range if runs reach hundreds of attempts
    let request = this.client
      .from('test_run_attempts')
      .select(ATTEMPT_COLUMNS)
      .eq('run_id', runId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (query.status?.length) request = request.in('status', query.status);
    if (query.kind?.length) request = request.in('kind', query.kind);

    const { data, error } = await request;

    if (error) throw tmDbError(this.logger, 'load attempt history', error);

    const sorted = ((data ?? []) as unknown as AttemptRow[])
      .map((row) => toItem(row, currentAttemptNo))
      .sort(compareAttempts(query.sort));

    return {
      items: sorted.slice(from, from + pageSize),
      total: sorted.length,
      page,
      pageSize,
    };
  }

  /** One attempt with its snapshot and step results, read-only. */
  async getAttempt(
    organizationId: string,
    spaceId: string,
    attemptId: string,
  ): Promise<AttemptDetail> {
    await this.access.assertAvailable(organizationId, spaceId);

    const { data, error } = await this.client
      .from('test_run_attempts')
      // All columns, so a database without iterations still opens its attempts.
      .select(
        `*, creator:users!test_run_attempts_created_by_fkey(${USER_COLUMNS})`,
      )
      .eq('id', attemptId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle<Record<string, unknown>>();

    if (error) throw tmDbError(this.logger, 'load attempt', error);
    if (!data) throw notFound();

    const row = data as unknown as AttemptRow & {
      iterations: AttemptDetail['iterations'] | null;
    };
    const currentAttemptNo = await this.currentAttemptNo(
      organizationId,
      spaceId,
      row.run_id,
    );
    const stored = row.step_results ?? {};
    const people = await this.users(
      Object.values(stored)
        .map((result) => result.executed_by)
        .filter((id): id is string => Boolean(id)),
    );
    const stepResults: Record<string, StepResult> = {};

    for (const [stepId, result] of Object.entries(stored)) {
      stepResults[stepId] = {
        status: result.status,
        actual_result: result.actual_result ?? null,
        comment: result.comment ?? null,

        // A deleted user keeps the id but loses the name (OD-47).
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
      ...toItem(row, currentAttemptNo),
      run_id: row.run_id,
      case_revision: row.case_revision,
      snapshot: row.snapshot,
      step_results: stepResults,
      iterations: row.iterations ?? [],
    };
  }

  private async currentAttemptNo(
    organizationId: string,
    spaceId: string,
    runId: string,
  ): Promise<number> {
    const { data, error } = await this.client
      .from('test_runs')
      .select('current_attempt_no')
      .eq('id', runId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load test run', error);
    if (!data) throw notFound();

    return (data as { current_attempt_no: number }).current_attempt_no;
  }

  private async users(ids: string[]) {
    const unique = [...new Set(ids)];
    const found = new Map<string, NonNullable<ReturnType<typeof userRef>>>();

    for (let i = 0; i < unique.length; i += ID_CHUNK) {
      const { data, error } = await this.client
        .from('users')
        .select(USER_COLUMNS)
        .in('id', unique.slice(i, i + ID_CHUNK));

      if (error) throw tmDbError(this.logger, 'load result authors', error);

      for (const row of (data ?? []) as UserRow[]) {
        const ref = userRef(row);

        if (ref) found.set(row.id, ref);
      }
    }

    return found;
  }
}
