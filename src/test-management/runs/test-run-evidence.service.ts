import { Injectable, Logger } from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import type { UserNameRow } from '../common/tester-eligibility.service';
import { ticketName } from '../common/ticket-keys';
import {
  TEST_EXECUTION_LIMITS,
  type RunEvidenceItem,
  type RunEvidenceQueryDto,
  type RunStatus,
  type TestExecutionPage,
} from '../dto/test-execution.dto';
import {
  TestExecutionsService,
  userRef,
} from '../executions/test-executions.service';
import { notFound, tmDbError } from '../test-management-errors';

// Keeps each .in() URL well under the 8 KB the stack accepts.
const ID_CHUNK = 100;

const RUN_SELECT =
  'id, case_id, execution_id, ' +
  'case:test_cases!test_runs_case_fkey(task:tasks!test_cases_task_id_fkey(key, summary)), ' +
  'execution:test_executions!test_runs_execution_fkey(task:tasks!test_executions_task_id_fkey(key))';

const FILE_SELECT =
  'id, entity_id, file_name, ' +
  'current_version:file_versions!file_attachments_current_version_fk(version_number, file_size, mime_type, uploaded_at, ' +
  'uploader:users!file_versions_uploaded_by_fkey(id, first_name, last_name, email, avatar_url))';

interface RunRow {
  id: string;
  case_id: string;
  execution_id: string;
  case: { task: { key: string; summary: string } | null } | null;
  execution: { task: { key: string } | null } | null;
}

interface AttemptRow {
  id: string;
  run_id: string;
  attempt_no: number;
  status: RunStatus;
}

interface FileRow {
  id: string;
  entity_id: string;
  file_name: string;
  current_version: {
    version_number: number;
    file_size: number | null;
    mime_type: string | null;
    uploaded_at: string;
    uploader: (UserNameRow & { id: string; avatar_url: string | null }) | null;
  } | null;
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];

  for (let i = 0; i < items.length; i += ID_CHUNK) {
    out.push(items.slice(i, i + ID_CHUNK));
  }

  return out;
}

function compareEvidence(sort: RunEvidenceQueryDto['sort']) {
  return (a: RunEvidenceItem, b: RunEvidenceItem): number => {
    const newest =
      Date.parse(b.uploaded_at) - Date.parse(a.uploaded_at) ||
      a.id.localeCompare(b.id);

    if (sort === 'oldest') {
      return (
        Date.parse(a.uploaded_at) - Date.parse(b.uploaded_at) ||
        a.id.localeCompare(b.id)
      );
    }

    if (sort === 'name' || sort === 'name:desc') {
      const sign = sort === 'name' ? 1 : -1;

      return sign * a.file_name.localeCompare(b.file_name) || newest;
    }

    return newest;
  };
}

/** Evidence files of run attempts, read where they are stored; nothing is copied. */
@Injectable()
export class TestRunEvidenceService {
  private readonly logger = new Logger(TestRunEvidenceService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly executions: TestExecutionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async forExecution(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    query: RunEvidenceQueryDto,
  ): Promise<TestExecutionPage<RunEvidenceItem>> {
    await this.access.assertAvailable(user.organizationId, spaceId);
    await this.executions.load(user.organizationId, spaceId, executionId);

    return this.list(user, spaceId, { execution_id: executionId }, query);
  }

  /** Archived executions are included: their evidence is still part of the case history. */
  async forCase(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    query: RunEvidenceQueryDto,
  ): Promise<TestExecutionPage<RunEvidenceItem>> {
    await this.access.assertAvailable(user.organizationId, spaceId);

    const { data, error } = await this.client
      .from('test_cases')
      .select('id')
      .eq('id', caseId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load test case', error);
    if (!data) throw notFound();

    const filter: Record<string, string> = { case_id: caseId };

    if (query.executionId) filter.execution_id = query.executionId;

    return this.list(user, spaceId, filter, query);
  }

  // Filters and pages in memory over at most 1,000 runs; a view or RPC if a scope ever holds more.
  private async list(
    user: RequestUser,
    spaceId: string,
    filter: Record<string, string>,
    query: RunEvidenceQueryDto,
  ): Promise<TestExecutionPage<RunEvidenceItem>> {
    const organizationId = user.organizationId;
    let runQuery = this.client
      .from('test_runs')
      .select(RUN_SELECT)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    for (const [column, value] of Object.entries(filter)) {
      runQuery = runQuery.eq(column, value);
    }

    const { data: runData, error: runError } = await runQuery.range(
      0,
      TEST_EXECUTION_LIMITS.runs - 1,
    );

    if (runError) throw tmDbError(this.logger, 'list evidence runs', runError);

    const runs = new Map(
      ((runData ?? []) as unknown as RunRow[]).map((run) => [run.id, run]),
    );
    const statuses = query.status?.length ? new Set(query.status) : null;
    const attempts = new Map<string, AttemptRow>();

    for (const chunk of chunks([...runs.keys()])) {
      const { data, error } = await this.client
        .from('test_run_attempts')
        .select('id, run_id, attempt_no, status')
        .in('run_id', chunk)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId);

      if (error) throw tmDbError(this.logger, 'list evidence attempts', error);

      for (const attempt of (data ?? []) as AttemptRow[]) {
        if (!statuses || statuses.has(attempt.status)) {
          attempts.set(attempt.id, attempt);
        }
      }
    }

    const needle = query.q?.toLowerCase();
    const items: RunEvidenceItem[] = [];

    for (const chunk of chunks([...attempts.keys()])) {
      const { data, error } = await this.client
        .from('file_attachments')
        .select(FILE_SELECT)
        .eq('entity_type', 'test_run_attempt')
        .in('entity_id', chunk)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)

        // A row without a current version has no bytes behind it.
        .not('current_version_id', 'is', null);

      if (error) throw tmDbError(this.logger, 'list run evidence', error);

      for (const file of (data ?? []) as unknown as FileRow[]) {
        const attempt = attempts.get(file.entity_id);
        const run = attempt && runs.get(attempt.run_id);
        const version = file.current_version;

        if (!attempt || !run || !version) continue;
        if (needle && !file.file_name.toLowerCase().includes(needle)) continue;

        items.push({
          id: file.id,
          file_name: file.file_name,
          file_size: version.file_size,
          mime_type: version.mime_type,
          version_number: version.version_number,
          uploaded_at: version.uploaded_at,
          uploader: userRef(version.uploader),
          attempt_id: attempt.id,
          attempt_no: attempt.attempt_no,
          attempt_status: attempt.status,
          run_id: run.id,
          case_id: run.case_id,
          case_key: run.case?.task?.key ?? '',
          case_title: ticketName(run.case?.task?.summary ?? ''),
          execution_id: run.execution_id,
          execution_key: run.execution?.task?.key ?? '',
        });
      }
    }

    items.sort(compareEvidence(query.sort));

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 10;
    const from = (page - 1) * pageSize;

    return {
      items: items.slice(from, from + pageSize),
      total: items.length,
      page,
      pageSize,
    };
  }
}
