import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { fetchAllRows } from '../../common/utils/fetch-all-rows';
import type { CustomField } from '../../custom-fields/models/custom-field.model';
import { validateFieldValue } from '../../custom-fields/utils/custom-field-validation';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TasksService } from '../../tasks/tasks.service';
import {
  TEST_RECORD_DELETED_EVENT,
  TEST_RECORD_UPDATED_EVENT,
  type TestRecordDeletedEvent,
  type TestRecordUpdatedEvent,
  type TestTicketFieldChanges,
} from '../../tasks/test-ticket-events';
import { TestManagementAccessService } from '../access/test-management-access.service';
import { containsPattern } from '../cases/test-cases.service';
import { bulkSetArchived } from '../common/bulk-archive';
import { TEST_CASE_LABEL_LIMITS } from '../common/case-labels';
import { countRunResults, hasResults } from '../common/run-results';
import { kindTaskTypeId } from '../common/test-task-types';
import {
  createRecordTicket,
  plainTextToTicketHtml,
  removeNewTicket,
  ticketEmbed,
  ticketKeyFields,
  ticketKeyNumber,
  ticketName,
  ticketPlainText,
  ticketSearchFilter,
} from '../common/ticket-keys';
import {
  chunk,
  TesterEligibilityService,
  userDisplayName,
  type UserNameRow,
} from '../common/tester-eligibility.service';
import {
  RUN_STATUSES,
  TEST_EXECUTION_LIMITS,
  type BulkArchiveTestExecutionsDto,
  type BulkDeleteTestExecutionsDto,
  type CreateTestExecutionDto,
  type ExecutionSkip,
  type ExecutionSummary,
  type ExecutionTesterSummary,
  type ExecutionTicket,
  type ExecutionTicketsQueryDto,
  type ExecutionWarning,
  type ListTestExecutionsQueryDto,
  type RunNowCreated,
  type RunNowDto,
  type RunStatus,
  type TestExecution,
  type TestExecutionBulkDeleteResult,
  type TestExecutionCreated,
  type TestExecutionDeleteCounts,
  type TestExecutionDeleted,
  type TestExecutionDetail,
  type TestExecutionListItem,
  type TestExecutionPage,
  type UpdateTestExecutionDto,
  type UserRef,
} from '../dto/test-execution.dto';
import { FINAL_STATUSES } from '../dto/test-plan.dto';
import type { TestRecordBulkArchiveResult } from '../dto/test-set.dto';
import { fetchPage } from '../plans/test-plans.service';
import {
  notFound,
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../test-management-errors';

// The ticket holds the key, name and description.
const EXECUTION_SELECT =
  'id, folder_id, task_id, environment, source, is_archived, archived_at, created_at, updated_at, ' +
  'plan:test_plans!test_executions_plan_fkey(id, task:tasks!test_plans_task_id_fkey(key, summary)), ' +
  'creator:users!test_executions_created_by_fkey(id, first_name, last_name, email, avatar_url), ' +
  `${ticketEmbed('test_executions', 'key, summary, description')}, ` +
  'run_count:test_runs!test_runs_execution_fkey(count), ' +
  'attempts:test_runs!test_runs_execution_fkey(current_attempt_no)';

// An execution that has been run keeps its results; any other error leaves it as it was.
function bulkDeleteReason(
  error: unknown,
): TestExecutionBulkDeleteResult['skipped'][number]['reason'] {
  if (error instanceof NotFoundException) return 'not_found';

  const response =
    error instanceof HttpException ? error.getResponse() : undefined;

  return typeof response === 'object' &&
    (response as { code?: string }).code === 'HAS_RESULTS'
    ? 'has_results'
    : 'failed';
}

// Sort fields map to fixed columns; the client value is never put into the query.
const SORT_COLUMNS = new Map<string, string>([
  ['key', 'created_at'],
  ['name', 'task(summary)'],
  ['source', 'source'],
  ['created_at', 'created_at'],
  ['updated_at', 'updated_at'],
]);

// Recent executions read for suggestions before de-duplication.
const ENVIRONMENT_SCAN = 500;

// only the newest tickets are scanned; page through them if a space ever has more.
const TICKET_SCAN = 1000;
const TICKETS_SHOWN = 100;
const ENVIRONMENT_SUGGESTIONS = 50;

type UserRow = UserNameRow & { id: string; avatar_url: string | null };

interface ExecutionRow {
  id: string;
  folder_id: string | null;
  task_id: string;
  environment: string | null;
  source: TestExecution['source'];
  is_archived: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  plan: {
    id: string;
    task: { key: string; summary: string };
  } | null;
  creator: UserRow | null;
  task: { key: string; summary: string; description: string | null };
  run_count: { count: number }[] | null;
  attempts?: { current_attempt_no: number }[] | null;
}

interface CreateResult {
  replayed: boolean;
  execution_id: string;
  key: string;
  run_count: number;
  skipped: ExecutionSkip[];
  warnings: ExecutionWarning[];
}

interface DeleteResult {
  deleted: boolean;
  counts: TestExecutionDeleteCounts;
  storage_paths: string[];
}

export function userRef(user: UserRow | null): UserRef | null {
  return user
    ? {
        id: user.id,
        name: userDisplayName(user) || null,
        avatar_url: user.avatar_url,
      }
    : null;
}

function toExecution(row: ExecutionRow, hasResults: boolean): TestExecution {
  return {
    id: row.id,
    ...ticketKeyFields(row.task.key),
    folder_id: row.folder_id,
    name: ticketName(row.task.summary),
    description: ticketPlainText(row.task.description),
    plan: row.plan
      ? {
          id: row.plan.id,
          key: row.plan.task.key,
          name: ticketName(row.plan.task.summary),
          task_key: row.plan.task.key,
        }
      : null,
    environment: row.environment,
    source: row.source,
    is_archived: row.is_archived,
    archived_at: row.archived_at,
    created_by: userRef(row.creator),
    created_at: row.created_at,
    updated_at: row.updated_at,
    run_count: row.run_count?.[0]?.count ?? 0,

    // Each run's attempt number is how many times it was run.
    attempt_count: (row.attempts ?? []).reduce(
      (sum, run) => sum + run.current_attempt_no,
      0,
    ),
    has_results: hasResults,
    task_id: row.task_id,
  };
}

export function rpcDetail(error: TmRpcError): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(error.details ?? '');

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function executionArchivedError(): ConflictException {
  return new ConflictException({
    code: 'ARCHIVED',
    message: 'The test execution is archived. Restore it first.',
  });
}

// Field types a results upload may fill; people, files, assets, tickets and the like need a picker.
const UPLOAD_FIELD_TYPES = new Set([
  'string',
  'number',
  'url',
  'date',
  'datetime',
  'checkbox',
  'select',
  'multiselect',
]);

type UploadFieldRow = Pick<
  CustomField,
  'field_key' | 'field_type' | 'name' | 'validation_rules' | 'options'
> & { contexts: unknown };

export interface TicketFieldsSaved {
  ticketKey: string | null;
  unknownFields: string[];
  refusedFields: string[];
  invalidFields: string[];
  labelsCapped: boolean;
}

// contexts is jsonb on new databases and JSON text on older ones; the task screen shows only task fields.
function isTaskField(contexts: unknown): boolean {
  let list = contexts;

  if (typeof list === 'string') {
    try {
      list = JSON.parse(list) as unknown;
    } catch {
      return false;
    }
  }

  return Array.isArray(list) && list.includes('task');
}

/** Test executions, Run now and environment suggestions; runs and results live in their own services. */
@Injectable()
export class TestExecutionsService {
  private readonly logger = new Logger(TestExecutionsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly eligibility: TesterEligibilityService,
    private readonly auditLogs: AuditLogsService,
    private readonly permissions: PermissionsService,
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async list(
    organizationId: string,
    spaceId: string,
    query: ListTestExecutionsQueryDto,
  ): Promise<TestExecutionPage<TestExecutionListItem>> {
    await this.access.assertAvailable(organizationId, spaceId);

    const search = query.q ? containsPattern(query.q) : null;
    const [field, direction] = (query.sort ?? '').split(':');
    const column = SORT_COLUMNS.get(field) ?? 'created_at';

    // Newest first unless a known field asks otherwise.
    const ascending = SORT_COLUMNS.has(field) ? direction === 'asc' : false;

    const executions = (columns: string, head = false) => {
      let builder = this.client
        .from('test_executions')
        .select(columns, { count: 'exact', head })
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .eq('is_archived', query.archived === true);

      if (search) {
        builder = builder.or(ticketSearchFilter(search), {
          referencedTable: 'task',
        });
      }

      if (query.planId) builder = builder.eq('plan_id', query.planId);
      if (query.folderId) builder = builder.eq('folder_id', query.folderId);
      if (query.ticketed) builder = builder.not('task_id', 'is', null);
      if (query.taskId) builder = builder.eq('task_id', query.taskId);

      // Plan and ad hoc are both manual executions, told apart by the plan.
      if (query.source === 'plan') {
        builder = builder.eq('source', 'manual').not('plan_id', 'is', null);
      } else if (query.source === 'ad_hoc') {
        builder = builder.eq('source', 'manual').is('plan_id', null);
      } else if (query.source) {
        builder = builder.eq('source', query.source);
      }

      if (query.environment) {
        builder = builder.eq('environment', query.environment);
      }

      if (query.createdBy) builder = builder.eq('created_by', query.createdBy);

      return builder;
    };

    // runs and key sorts read every matching execution and sort in code (neither the run count nor the key number is a column); store a counter if a space reaches thousands of executions
    if (field === 'runs' || field === 'key') {
      type CountRow = Pick<
        ExecutionRow,
        'id' | 'created_at' | 'run_count' | 'task'
      >;

      const runCount = (row: CountRow) => row.run_count?.[0]?.count ?? 0;

      // Key compares the ticket number, so T1002 comes after T773.
      const value = (row: CountRow) =>
        field === 'key' ? ticketKeyNumber(row.task.key) : runCount(row);
      const runsAscending = direction === 'asc';

      const { rows: counted } = await fetchAllRows<CountRow>(
        async (from, to) => {
          const batch = await executions(
            `id, created_at, ${ticketEmbed('test_executions', 'key')}, ` +
              'run_count:test_runs!test_runs_execution_fkey(count)',
          )
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to);

          if (batch.error) {
            throw tmDbError(this.logger, 'list test executions', batch.error);
          }

          return { data: batch.data as unknown as CountRow[], error: null };
        },
        Infinity,
      );

      // A stable sort keeps newest first among equal counts.
      counted.sort((a, b) =>
        runsAscending ? value(a) - value(b) : value(b) - value(a),
      );

      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 50;
      const from = (page - 1) * pageSize;
      const ids = counted.slice(from, from + pageSize).map((row) => row.id);
      let rows: ExecutionRow[] = [];

      if (ids.length > 0) {
        const { data, error } = await executions(EXECUTION_SELECT).in(
          'id',
          ids,
        );

        if (error) {
          throw tmDbError(this.logger, 'list test executions', error);
        }

        const byId = new Map(
          (data as unknown as ExecutionRow[]).map((row) => [row.id, row]),
        );

        rows = ids.flatMap((id) => byId.get(id) ?? []);
      }

      const run = await this.executionsWithResults(
        organizationId,
        spaceId,
        rows.map((row) => row.id),
      );

      return {
        items: rows.map((row) => toExecution(row, run.has(row.id))),
        total: counted.length,
        page,
        pageSize,
      };
    }

    const result = await fetchPage<ExecutionRow>(
      this.logger,
      'list test executions',
      query,
      (from, to) => {
        let builder = executions(EXECUTION_SELECT).order(column, {
          ascending,
        });

        if (column !== 'created_at') {
          builder = builder.order('created_at', { ascending: false });
        }

        return builder.order('id', { ascending: false }).range(from, to);
      },
      () => executions(`id, ${ticketEmbed('test_executions', 'key')}`, true),
    );

    const run = await this.executionsWithResults(
      organizationId,
      spaceId,
      result.items.map((row) => row.id),
    );

    return {
      ...result,
      items: result.items.map((row) => toExecution(row, run.has(row.id))),
    };
  }

  async get(
    organizationId: string,
    spaceId: string,
    executionId: string,
  ): Promise<TestExecutionDetail> {
    await this.access.assertAvailable(organizationId, spaceId);

    const execution = await this.load(organizationId, spaceId, executionId);

    return {
      ...execution,
      status_counts: await this.statusCounts(
        organizationId,
        spaceId,
        executionId,
      ),
    };
  }

  async create(
    user: RequestUser,
    spaceId: string,
    dto: CreateTestExecutionDto,
  ): Promise<TestExecutionCreated> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // A missing folder is refused before anything is written.
    if (dto.folder_id) {
      await this.assertFolder(user.organizationId, spaceId, dto.folder_id);
    }

    if (dto.task_id) {
      await this.assertLinkableTicket(
        user.organizationId,
        spaceId,
        dto.task_id,
        dto.request_id,
      );
    }

    // Planned testers are kept only when they may still run tests here.
    const eligible =
      dto.from === 'plan'
        ? [
            ...(await this.eligibility.eligibleUserIds(
              user.organizationId,
              spaceId,
            )),
          ]
        : [];

    const result = await this.createExecution(user, spaceId, {
      request_id: dto.request_id,
      source: 'manual',
      task_id: dto.task_id ?? null,
      name: dto.name ?? null,
      description: dto.description ?? null,
      plan_id: dto.from === 'plan' ? (dto.plan_id ?? null) : null,
      set_id: dto.from === 'set' ? (dto.set_id ?? null) : null,
      case_ids: dto.from === 'cases' ? (dto.case_ids ?? null) : null,
      environment: dto.environment ?? null,
      eligible,
    });

    // A resend may arrive after the first try failed half-way, so the folder step runs again.
    if (dto.folder_id) {
      await this.setFolder(user, spaceId, result.execution_id, dto.folder_id);
    }

    if (result.replayed) return { ...result, ticket_warning: null };

    const drafts = await this.draftWarnings(
      user.organizationId,
      spaceId,
      result.execution_id,
    );

    void this.auditLogs.logActionForRequest(
      user,
      'test_execution',
      result.execution_id,
      'create',
      {
        space_id: spaceId,
        key: result.key,
        from: dto.from,
        run_count: result.run_count,
      },
    );

    return {
      ...result,
      warnings: [...result.warnings, ...drafts],
      ticket_warning: null,
    };
  }

  /** One run of one case, assigned to the caller; deprecated cases are refused and drafts are allowed. */
  async runNow(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    dto: RunNowDto,
  ): Promise<RunNowCreated> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });
    await this.eligibility.assertEligible(
      user.organizationId,
      spaceId,
      user.userId,
    );

    const result = await this.createExecution(user, spaceId, {
      request_id: dto.request_id,
      source: 'run_now',
      task_id: null,
      name: null,
      description: null,
      plan_id: null,
      set_id: null,
      case_ids: [caseId],
      environment: dto.environment ?? null,
      eligible: [],
    });

    const { data, error } = await this.client
      .from('test_runs')
      .select(
        'id, execution:test_executions!test_runs_execution_fkey!inner(source)',
      )
      .eq('execution_id', result.execution_id)
      .eq('execution.source', 'run_now')
      .eq('case_id', caseId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load run now run', error);

    // The request id already belongs to another request (another case or a non Run now execution).
    if (!data) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'This request id was already used for another request',
      });
    }

    if (!result.replayed) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_execution',
        result.execution_id,
        'create',
        { space_id: spaceId, key: result.key, run_now: caseId },
      );
    }

    return {
      replayed: result.replayed,
      execution_id: result.execution_id,
      key: result.key,
      run_id: (data as { id: string }).id,
      ticket_warning: null,
    };
  }

  async update(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    dto: UpdateTestExecutionDto,
  ): Promise<TestExecution> {
    const changes: Record<string, unknown> = {};

    if (dto.name !== undefined) changes.name = dto.name;
    if (dto.description !== undefined) changes.description = dto.description;
    if (dto.environment !== undefined) changes.environment = dto.environment;
    if (dto.folder_id !== undefined) changes.folder_id = dto.folder_id;

    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    if (Object.keys(changes).length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message:
          'Provide a name, a description, an environment or a folder to update',
      });
    }

    const current = await this.load(user.organizationId, spaceId, executionId);

    if (current.is_archived) throw executionArchivedError();

    if (dto.folder_id) {
      await this.assertFolder(user.organizationId, spaceId, dto.folder_id);
    }

    // The is_archived filter makes the archived check and the write one statement.
    const { data, error } = await this.client
      .from('test_executions')
      .update({
        ...(dto.environment !== undefined
          ? { environment: dto.environment }
          : {}),
        ...(dto.folder_id !== undefined ? { folder_id: dto.folder_id } : {}),
        updated_by: user.userId,
      })
      .eq('id', executionId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('is_archived', false)
      .select('id')
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'update test execution', error);

    if (!data) {
      await this.load(user.organizationId, spaceId, executionId);

      throw executionArchivedError();
    }

    await this.updateTicket(user, current, dto.name, dto.description);

    void this.auditLogs.logActionForRequest(
      user,
      'test_execution',
      executionId,
      'update',
      { space_id: spaceId, changes },
    );

    return this.load(user.organizationId, spaceId, executionId);
  }

  /** Archiving an archived execution (or restoring an active one) returns it unchanged. */
  async setArchived(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    archived: boolean,
  ): Promise<TestExecution> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const { data, error } = await this.client
      .from('test_executions')
      .update({
        is_archived: archived,
        archived_at: archived ? new Date().toISOString() : null,
        archived_by: archived ? user.userId : null,
        updated_by: user.userId,
      })
      .eq('id', executionId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('is_archived', !archived)
      .select(EXECUTION_SELECT)
      .maybeSingle();

    if (error) {
      throw tmDbError(
        this.logger,
        archived ? 'archive test execution' : 'restore test execution',
        error,
      );
    }

    if (!data) return this.load(user.organizationId, spaceId, executionId);

    void this.auditLogs.logActionForRequest(
      user,
      'test_execution',
      executionId,
      archived ? 'archive' : 'restore',
      { space_id: spaceId },
    );

    return toExecution(
      data as unknown as ExecutionRow,
      await this.hasRunResults(user.organizationId, spaceId, executionId),
    );
  }

  /** Archives or restores the selected executions through setArchived(), so each keeps its own audit entry. */
  async bulkArchive(
    user: RequestUser,
    spaceId: string,
    dto: BulkArchiveTestExecutionsDto,
  ): Promise<TestRecordBulkArchiveResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const archived = dto.action === 'archive';

    return bulkSetArchived({
      client: this.client,
      logger: this.logger,
      table: 'test_executions',
      organizationId: user.organizationId,
      spaceId,
      ids: dto.execution_ids,
      archived,
      setArchived: (id) => this.setArchived(user, spaceId, id, archived),
    });
  }

  /** An empty execution for a results upload; its runs come from the file. */
  async createImport(
    user: RequestUser,
    spaceId: string,
    input: {
      request_id: string;
      name: string;
      description: string | null;
      plan_id: string | null;
      environment: string | null;
    },
  ): Promise<CreateResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const result = await this.createExecution(user, spaceId, {
      ...input,
      source: 'junit',
      task_id: null,
      set_id: null,
      case_ids: null,
      eligible: [],
    });

    if (result.replayed) return result;

    void this.auditLogs.logActionForRequest(
      user,
      'test_execution',
      result.execution_id,
      'create',
      { space_id: spaceId, key: result.key, from: 'import', run_count: 0 },
    );

    return result;
  }

  /**
   * Adds labels and custom field values from a results upload to the execution's ticket. Labels already
   * there stay as they are; fields the space doesn't have, can't take from a file, or whose value doesn't fit are returned.
   */
  async addTicketFields(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    fields: { labels: string[]; customFields: Record<string, unknown> },
  ): Promise<TicketFieldsSaved> {
    const saved: TicketFieldsSaved = {
      ticketKey: null,
      unknownFields: [],
      refusedFields: [],
      invalidFields: [],
      labelsCapped: false,
    };
    const execution = await this.load(
      user.organizationId,
      spaceId,
      executionId,
    );

    if (!execution.task_id || !this.tasks) return saved;

    saved.ticketKey = execution.key;

    const keys = Object.keys(fields.customFields);
    const values: Record<string, unknown> = {};

    if (keys.length > 0) {
      const { data, error } = await this.client
        .from('custom_fields')
        .select(
          'field_key, field_type, name, validation_rules, options, contexts',
        )
        .eq('organization_id', user.organizationId)
        .eq('is_active', true)
        .or('is_deleted.is.null,is_deleted.eq.false')
        .or(`space_id.eq.${spaceId},space_id.is.null`)
        .in('field_key', keys);

      if (error) throw tmDbError(this.logger, 'load custom fields', error);

      const defs = new Map(
        ((data ?? []) as UploadFieldRow[])
          .filter((row) => isTaskField(row.contexts))
          .map((row) => [row.field_key, row]),
      );

      for (const key of keys) {
        const def = defs.get(key);

        if (!def) {
          saved.unknownFields.push(key);
          continue;
        }

        if (!UPLOAD_FIELD_TYPES.has(def.field_type)) {
          saved.refusedFields.push(key);
          continue;
        }

        try {
          validateFieldValue(def, fields.customFields[key]);
          values[key] = fields.customFields[key];
        } catch {
          saved.invalidFields.push(key);
        }
      }
    }

    const current = await this.tasks.getById(
      execution.task_id,
      user.organizationId,
    );
    const labels = current.labels ?? [];
    const fresh = fields.labels.filter((label) => !labels.includes(label));
    const room = Math.max(TEST_CASE_LABEL_LIMITS.perCase - labels.length, 0);
    const patch: {
      labels?: string[];
      custom_field_values?: Record<string, unknown>;
    } = {};

    saved.labelsCapped = fresh.length > room;

    if (fresh.length > 0 && room > 0) {
      patch.labels = [...labels, ...fresh.slice(0, room)];
    }

    if (Object.keys(values).length > 0) {
      patch.custom_field_values = {
        ...(current.custom_field_values ?? {}),
        ...values,
      };
    }

    if (Object.keys(patch).length > 0) {
      await this.tasks.update(
        execution.task_id,
        user.organizationId,
        user.userId,
        patch,
      );
    }

    return saved;
  }

  /** Takes back the ticket of an upload that failed, so it needs no delete right; never one with results. */
  async removeFailedImport(
    user: RequestUser,
    spaceId: string,
    executionId: string,
  ): Promise<void> {
    const { task_id: taskId } = await this.load(
      user.organizationId,
      spaceId,
      executionId,
    );

    if (await this.hasRunResults(user.organizationId, spaceId, executionId)) {
      return;
    }

    await removeNewTicket(
      {
        client: this.client,
        logger: this.logger,
        tasks: this.tasks,
        permissions: this.permissions,
      },
      user,
      taskId as string,
    );

    // The ticket delete swallows errors, so only log once the execution is really gone.
    const left = await this.client
      .from('test_executions')
      .select('id')
      .eq('id', executionId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (!left.error && !left.data) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_execution',
        executionId,
        'delete',
        { action: 'import_failed', space_id: spaceId },
      );
    }
  }

  /**
   * dryRun returns what would be removed. An execution that has been run is refused (409 HAS_RESULTS);
   * otherwise its ticket is deleted first (that checks the task delete right), then the execution.
   */
  async remove(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    dryRun: boolean,
  ): Promise<TestExecutionDeleted> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: !dryRun,
    });

    const execution = await this.load(
      user.organizationId,
      spaceId,
      executionId,
    );

    // An execution that has been run keeps its results; it can only be archived.
    const results = await countRunResults(
      this.client,
      this.logger,
      user.organizationId,
      spaceId,
      { executionId },
    );

    if (results > 0) {
      throw hasResults(
        `This test execution has already been run (${results} results) and cannot be deleted. Archive it instead.`,
        results,
      );
    }

    // Read first: the ticket delete below removes the execution with it.
    const { counts } = await this.deleteExecution(
      user.organizationId,
      spaceId,
      user.userId,
      executionId,
      true,
    );

    if (dryRun) {
      return { dry_run: true, counts, ticket_key: execution.task_key };
    }

    // only the newest tickets are scanned; page through them if a space ever has more.
    if (!this.events) throw new Error('Ticket deletes are not available');

    await this.events.emitAsync(TEST_RECORD_DELETED_EVENT, {
      organizationId: user.organizationId,
      taskId: execution.task_id as string,
      userId: user.userId,
    } satisfies TestRecordDeletedEvent);

    void this.auditLogs.logActionForRequest(
      user,
      'test_execution',
      executionId,
      'delete',
      {
        space_id: spaceId,
        key: execution.key,
        counts,
        ticket_key: execution.task_key,
      },
    );

    return { dry_run: false, counts, ticket_key: execution.task_key };
  }

  /** Deletes the selected executions one at a time through remove(), so each keeps its own checks, ticket delete and audit entry. */
  async bulkRemove(
    user: RequestUser,
    spaceId: string,
    dto: BulkDeleteTestExecutionsDto,
  ): Promise<TestExecutionBulkDeleteResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // Only this space's executions get a key; any other id is reported as not found.
    const { data, error } = await this.client
      .from('test_executions')
      .select(`id, ${ticketEmbed('test_executions', 'key')}`)
      .in('id', dto.execution_ids)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId);

    if (error) {
      throw tmDbError(this.logger, 'load test executions to delete', error);
    }

    const keys = new Map(
      ((data ?? []) as unknown as { id: string; task: { key: string } }[]).map(
        (row) => [row.id, row.task.key],
      ),
    );
    const result: TestExecutionBulkDeleteResult = {
      changed: false,
      deleted: [],
      skipped: [],
    };
    const skip = (
      executionId: string,
      reason: TestExecutionBulkDeleteResult['skipped'][number]['reason'],
    ) =>
      result.skipped.push({
        execution_id: executionId,
        key: keys.get(executionId) ?? '',
        reason: keys.has(executionId) ? reason : 'not_found',
      });

    for (const [index, executionId] of dto.execution_ids.entries()) {
      if (!keys.has(executionId)) {
        skip(executionId, 'not_found');
        continue;
      }

      try {
        await this.remove(user, spaceId, executionId, false);
        result.deleted.push({
          execution_id: executionId,
          key: keys.get(executionId) ?? '',
        });
      } catch (caught) {
        // Without the right to delete tickets every remaining execution would fail the same way.
        if (caught instanceof ForbiddenException) {
          dto.execution_ids.slice(index).forEach((id) => skip(id, 'failed'));
          break;
        }

        const reason = bulkDeleteReason(caught);

        if (reason === 'failed') {
          this.logger.warn(
            `Bulk delete of test execution ${executionId} failed: ${(caught as Error).message}`,
          );
        }

        skip(executionId, reason);
      }
    }

    result.changed = result.deleted.length > 0;

    return result;
  }

  /** Distinct environments used in this space, newest first; case variants count once. */
  async environments(
    organizationId: string,
    spaceId: string,
  ): Promise<string[]> {
    await this.access.assertAvailable(organizationId, spaceId);

    const { data, error } = await this.client
      .from('test_executions')
      .select('environment')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .not('environment', 'is', null)
      .order('created_at', { ascending: false })
      .range(0, ENVIRONMENT_SCAN - 1);

    if (error) throw tmDbError(this.logger, 'list environments', error);

    const seen = new Set<string>();
    const names: string[] = [];

    for (const row of (data ?? []) as { environment: string }[]) {
      const id = row.environment.trim().toLowerCase();

      if (seen.has(id)) continue;
      seen.add(id);
      names.push(row.environment);
      if (names.length === ENVIRONMENT_SUGGESTIONS) break;
    }

    return names;
  }

  /** Test execution tickets of the space that have no execution yet, newest first. */
  async ticketsWithoutExecution(
    organizationId: string,
    spaceId: string,
    query: ExecutionTicketsQueryDto,
  ): Promise<{ items: ExecutionTicket[]; total: number }> {
    await this.access.assertAvailable(organizationId, spaceId);

    const typeId = await kindTaskTypeId(
      this.client,
      this.logger,
      organizationId,
      spaceId,
      'execution_task_type_id',
    );

    if (!typeId) return { items: [], total: 0 };

    const search = query.q ? containsPattern(query.q) : null;
    let builder = this.client
      .from('tasks')
      .select('id, key, summary, created_at')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('task_type_id', typeId);

    if (search)
      builder = builder.or(`key.ilike.${search},summary.ilike.${search}`);

    const { data, error } = await builder
      .order('created_at', { ascending: false })
      .order('id')
      .range(0, TICKET_SCAN - 1);

    if (error) throw tmDbError(this.logger, 'list execution tickets', error);

    const tickets = (data ?? []) as {
      id: string;
      key: string;
      summary: string;
      created_at: string;
    }[];
    const linked = new Set<string>();

    for (const ids of chunk(tickets.map((ticket) => ticket.id))) {
      const { data: rows, error: linkedError } = await this.client
        .from('test_executions')
        .select('task_id')
        .in('task_id', ids)
        .eq('organization_id', organizationId);

      if (linkedError) {
        throw tmDbError(this.logger, 'read linked executions', linkedError);
      }

      for (const row of (rows ?? []) as { task_id: string }[]) {
        linked.add(row.task_id);
      }
    }

    const items = tickets
      .filter((ticket) => !linked.has(ticket.id))
      .slice(0, TICKETS_SHOWN)
      .map((ticket) => ({
        task_id: ticket.id,
        key: ticket.key,
        summary: ticket.summary,
        created_at: ticket.created_at,
      }));

    return { items, total: items.length };
  }

  /** Counts, progress, testers and minutes of one execution; status counts are the ones the detail shows. */
  async summary(
    organizationId: string,
    spaceId: string,
    executionId: string,
  ): Promise<ExecutionSummary> {
    await this.access.assertAvailable(organizationId, spaceId);
    await this.load(organizationId, spaceId, executionId);

    const [counts, runs] = await Promise.all([
      this.statusCounts(organizationId, spaceId, executionId),
      this.summaryRuns(organizationId, spaceId, executionId),
    ]);
    const total = runs.length;
    const isFinal = (status: RunStatus | null) =>
      status !== null && (FINAL_STATUSES as readonly string[]).includes(status);
    const finalCount = Object.entries(counts).reduce(
      (sum, [status, n]) => sum + (isFinal(status as RunStatus) ? n : 0),
      0,
    );
    const denominator = total - counts.NOT_APPLICABLE;
    const testers = new Map<string | null, ExecutionTesterSummary>();
    let minutes = 0;
    let recorded = 0;
    let measured = 0;

    for (const run of runs) {
      const key = run.assignee?.id ?? null;
      const entry = testers.get(key) ?? {
        user_id: key,
        name: run.assignee ? userDisplayName(run.assignee) || null : null,
        total: 0,
        final: 0,
      };

      entry.total += 1;
      if (isFinal(run.status)) entry.final += 1;
      testers.set(key, entry);

      // Typed minutes win; otherwise the time between start and finish of the attempt.
      if (run.actual_minutes !== null) {
        minutes += run.actual_minutes;
        recorded += 1;
      } else if (run.measured_minutes !== null) {
        minutes += run.measured_minutes;
        measured += 1;
      }
    }

    // Testing started with the first started attempt; it ended only once every run has a final status.
    const starts = runs.flatMap((run) =>
      run.started_at ? [run.started_at] : [],
    );
    const ends = runs.flatMap((run) =>
      run.finished_at ? [run.finished_at] : [],
    );
    const allFinal = total > 0 && finalCount === total;

    return {
      execution_id: executionId,
      started_at:
        starts.length > 0 ? starts.reduce((a, b) => (a < b ? a : b)) : null,
      finished_at:
        allFinal && ends.length > 0
          ? ends.reduce((a, b) => (a > b ? a : b))
          : null,
      total_runs: total,
      status_counts: counts,
      final_ratio:
        total > 0 ? Math.round((finalCount / total) * 10000) / 10000 : 0,
      success_rate:
        denominator > 0
          ? Math.round((counts.PASS / denominator) * 10000) / 10000
          : null,
      by_tester: [...testers.values()],
      actual_minutes: { total: minutes, recorded, measured },
    };
  }

  /** Scoped load without the access check; foreign and missing executions are the same 404. */
  async load(
    organizationId: string,
    spaceId: string,
    executionId: string,
  ): Promise<TestExecution> {
    const { data, error } = await this.client
      .from('test_executions')
      .select(EXECUTION_SELECT)
      .eq('id', executionId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load test execution', error);
    if (!data) throw notFound();

    return toExecution(
      data as unknown as ExecutionRow,
      await this.hasRunResults(organizationId, spaceId, executionId),
    );
  }

  private async hasRunResults(
    organizationId: string,
    spaceId: string,
    executionId: string,
  ): Promise<boolean> {
    const results = await countRunResults(
      this.client,
      this.logger,
      organizationId,
      spaceId,
      { executionId },
    );

    return results > 0;
  }

  /** Ids of the given executions that have a started or finished attempt (same rule as countRunResults). */
  private async executionsWithResults(
    organizationId: string,
    spaceId: string,
    executionIds: string[],
  ): Promise<Set<string>> {
    if (executionIds.length === 0) return new Set();

    const { rows } = await fetchAllRows<{ run: { execution_id: string } }>(
      async (from, to) => {
        const page = await this.client
          .from('test_run_attempts')
          .select(
            'id, run:test_runs!test_run_attempts_run_fkey!inner(execution_id)',
          )
          .in('run.execution_id', executionIds)
          .neq('status', 'TODO')
          .eq('space_id', spaceId)
          .eq('organization_id', organizationId)
          .order('id')
          .range(from, to);

        if (page.error) {
          throw tmDbError(this.logger, 'list run results', page.error);
        }

        return {
          data: page.data as unknown as { run: { execution_id: string } }[],
          error: null,
        };
      },
    );

    return new Set(rows.map((row) => row.run.execution_id));
  }

  /** Hands a changed name or description to the ticket, so its history, audit log and automations run as for any edit. */
  private async updateTicket(
    user: RequestUser,
    current: TestExecution,
    name: string | null | undefined,
    description: string | null | undefined,
  ): Promise<void> {
    const changes: TestTicketFieldChanges = {};

    if (name && name.trim() !== current.name) changes.summary = name;

    if (
      description !== undefined &&
      (description || null) !== current.description
    ) {
      changes.description = plainTextToTicketHtml(description);
    }

    if (Object.keys(changes).length === 0) return;

    if (!this.events) throw new Error('Ticket updates are not available');

    await this.events.emitAsync(TEST_RECORD_UPDATED_EVENT, {
      organizationId: user.organizationId,
      taskId: current.task_id as string,
      userId: user.userId,
      changes,
    } satisfies TestRecordUpdatedEvent);
  }

  /** The ticket must be an unlinked test execution ticket of this space; a resend of the same request may reuse it. */
  private async assertLinkableTicket(
    organizationId: string,
    spaceId: string,
    taskId: string,
    requestId: string,
  ): Promise<void> {
    const { data: task, error } = await this.client
      .from('tasks')
      .select('id, task_type_id')
      .eq('id', taskId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle<{ id: string; task_type_id: string | null }>();

    if (error) throw tmDbError(this.logger, 'load execution ticket', error);
    if (!task) throw notFound({ task_id: taskId });

    const typeId = await kindTaskTypeId(
      this.client,
      this.logger,
      organizationId,
      spaceId,
      'execution_task_type_id',
    );

    if (!typeId || task.task_type_id !== typeId) {
      throw new BadRequestException({
        code: 'NOT_EXECUTION_TICKET',
        message: 'The ticket is not a test execution ticket',
      });
    }

    const { data: linked, error: linkedError } = await this.client
      .from('test_executions')
      .select('id, request_id')
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle<{ id: string; request_id: string | null }>();

    if (linkedError) {
      throw tmDbError(this.logger, 'check linked execution', linkedError);
    }

    if (linked && linked.request_id !== requestId) {
      throw new ConflictException({
        code: 'TICKET_ALREADY_LINKED',
        message: 'This ticket already has a test execution',
      });
    }
  }

  private async assertFolder(
    organizationId: string,
    spaceId: string,
    folderId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('test_folders')
      .select('id')
      .eq('id', folderId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load test folder', error);
    if (!data) throw notFound({ folder_id: folderId });
  }

  private async setFolder(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    folderId: string,
  ): Promise<void> {
    const { error } = await this.client
      .from('test_executions')
      .update({ folder_id: folderId, updated_by: user.userId })
      .eq('id', executionId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId);

    if (error) throw tmDbError(this.logger, 'file test execution', error);
  }

  /** The ticket comes first because it holds the name; a retry of the same request is answered without a new ticket. */
  private async createExecution(
    user: RequestUser,
    spaceId: string,
    input: {
      request_id: string;
      source: 'manual' | 'run_now' | 'junit';
      task_id: string | null;
      name: string | null;
      description: string | null;
      plan_id: string | null;
      set_id: string | null;
      case_ids: string[] | null;
      environment: string | null;
      eligible: string[];
    },
  ): Promise<CreateResult> {
    const { data: earlier, error: earlierError } = await this.client
      .from('test_executions')
      .select('task_id')
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('request_id', input.request_id)
      .maybeSingle<{ task_id: string }>();

    if (earlierError) {
      throw tmDbError(this.logger, 'check test execution', earlierError);
    }

    if (earlier) return this.callCreate(user, spaceId, earlier.task_id, input);

    const deps = {
      client: this.client,
      logger: this.logger,
      tasks: this.tasks,
      permissions: this.permissions,
    };

    if (input.task_id) {
      const result = await this.callCreate(user, spaceId, input.task_id, input);

      await this.renameSuppliedTicket(user, input.task_id, input);

      return result;
    }

    const name = await this.defaultName(user.organizationId, spaceId, input);
    const ticket = await createRecordTicket(
      deps,
      user,
      spaceId,
      'execution_task_type_id',
      {
        summary: name,
        description: plainTextToTicketHtml(input.description) || undefined,
      },
    );

    try {
      const result = await this.callCreate(user, spaceId, ticket.id, input);

      // A parallel request with the same id won, so this request's ticket is not needed.
      if (result.replayed) await removeNewTicket(deps, user, ticket.id);

      return result;
    } catch (error) {
      await removeNewTicket(deps, user, ticket.id);

      throw error;
    }
  }

  private async callCreate(
    user: RequestUser,
    spaceId: string,
    taskId: string,
    input: {
      request_id: string;
      source: 'manual' | 'run_now' | 'junit';
      plan_id: string | null;
      set_id: string | null;
      case_ids: string[] | null;
      environment: string | null;
      eligible: string[];
    },
  ): Promise<CreateResult> {
    const { data, error } = (await this.client.rpc('tm_create_execution', {
      p_organization_id: user.organizationId,
      p_space_id: spaceId,
      p_actor_id: user.userId,
      p_request_id: input.request_id,
      p_source: input.source,
      p_task_id: taskId,
      p_plan_id: input.plan_id,
      p_set_id: input.set_id,
      p_case_ids: input.case_ids,
      p_environment: input.environment,
      p_eligible_user_ids: input.eligible,
    })) as { data: CreateResult | null; error: TmRpcError | null };

    if (error) throw this.createError(error);
    if (!data) throw notFound();

    return {
      replayed: data.replayed,
      execution_id: data.execution_id,
      key: data.key,
      run_count: data.run_count,
      skipped: data.skipped ?? [],
      warnings: data.warnings ?? [],
    };
  }

  /** The Add tests form lets the user edit the name and description prefilled from a ticket. */
  private async renameSuppliedTicket(
    user: RequestUser,
    taskId: string,
    input: { name: string | null; description: string | null },
  ): Promise<void> {
    const { data, error } = await this.client
      .from('tasks')
      .select('summary, description')
      .eq('id', taskId)
      .eq('organization_id', user.organizationId)
      .maybeSingle<{ summary: string; description: string | null }>();

    if (error) throw tmDbError(this.logger, 'load execution ticket', error);
    if (!data) return;

    await this.updateTicket(
      user,
      {
        task_id: taskId,
        name: ticketName(data.summary),
        description: ticketPlainText(data.description),
      } as TestExecution,
      input.name,
      input.description ?? undefined,
    );
  }

  /** The name the new ticket takes when the user gave none; also refuses an archived or missing source first. */
  private async defaultName(
    organizationId: string,
    spaceId: string,
    input: {
      source: 'manual' | 'run_now' | 'junit';
      name: string | null;
      plan_id: string | null;
      set_id: string | null;
      case_ids: string[] | null;
    },
  ): Promise<string> {
    const source = input.plan_id
      ? { table: 'test_plans' as const, id: input.plan_id }
      : input.set_id
        ? { table: 'test_sets' as const, id: input.set_id }
        : input.source === 'run_now' && input.case_ids?.length === 1
          ? { table: 'test_cases' as const, id: input.case_ids[0] }
          : null;

    if (!source) return input.name?.trim() || 'Ad hoc execution';

    const { data, error } = await this.client
      .from(source.table)
      .select(`is_archived, ${ticketEmbed(source.table)}`)
      .eq('id', source.id)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load execution source', error);
    if (!data) throw notFound({ [source.table]: source.id });

    const row = data as unknown as {
      is_archived: boolean;
      task: { key: string; summary: string };
    };

    if (row.is_archived) {
      throw new ConflictException({
        code: 'ARCHIVED',
        message:
          source.table === 'test_cases'
            ? 'The test case is archived'
            : 'The test plan or set is archived',
      });
    }

    return (
      input.name?.trim() ||
      (source.table === 'test_cases'
        ? `Run now ${row.task.key}`
        : ticketName(row.task.summary))
    );
  }

  private async deleteExecution(
    organizationId: string,
    spaceId: string,
    actorId: string,
    executionId: string,
    dryRun: boolean,
  ): Promise<DeleteResult> {
    const { data, error } = (await this.client.rpc('tm_delete_execution', {
      p_organization_id: organizationId,
      p_space_id: spaceId,
      p_actor_id: actorId,
      p_execution_id: executionId,
      p_dry_run: dryRun,
    })) as { data: DeleteResult | null; error: TmRpcError | null };

    if (error) {
      throw tmRpcError(
        this.logger,
        dryRun ? 'preview test execution delete' : 'delete test execution',
        error,
      );
    }

    if (!data) throw notFound();

    return { ...data, storage_paths: data.storage_paths ?? [] };
  }

  /** Runs of draft cases are created but flagged. */
  private async draftWarnings(
    organizationId: string,
    spaceId: string,
    executionId: string,
  ): Promise<ExecutionWarning[]> {
    const { data, error } = await this.client
      .from('test_runs')
      .select(
        'case_id, case:test_cases!test_runs_case_fkey!inner(readiness, task:tasks!test_cases_task_id_fkey!inner(key))',
      )
      .eq('execution_id', executionId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('case.readiness', 'draft')
      .range(0, TEST_EXECUTION_LIMITS.runs - 1);

    if (error) throw tmDbError(this.logger, 'list draft runs', error);

    return (
      (data ?? []) as unknown as {
        case_id: string;
        case: { task: { key: string } };
      }[]
    )
      .sort(
        (a, b) =>
          ticketKeyNumber(a.case.task.key) - ticketKeyNumber(b.case.task.key),
      )
      .map((row) => ({
        case_id: row.case_id,
        key: row.case.task.key,
        reason: 'draft' as const,
      }));
  }

  private async statusCounts(
    organizationId: string,
    spaceId: string,
    executionId: string,
  ): Promise<Record<RunStatus, number>> {
    const { data, error } = await this.client
      .from('test_runs')
      .select(
        'current_attempt_no, attempts:test_run_attempts!test_run_attempts_run_fkey(attempt_no, status)',
      )
      .eq('execution_id', executionId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .range(0, TEST_EXECUTION_LIMITS.runs - 1);

    if (error) throw tmDbError(this.logger, 'count run statuses', error);

    const counts = Object.fromEntries(
      RUN_STATUSES.map((status) => [status, 0]),
    ) as Record<RunStatus, number>;

    for (const run of (data ?? []) as unknown as {
      current_attempt_no: number;
      attempts: { attempt_no: number; status: RunStatus }[];
    }[]) {
      const current = run.attempts.find(
        (attempt) => attempt.attempt_no === run.current_attempt_no,
      );

      if (current) counts[current.status] += 1;
    }

    return counts;
  }

  /** Assignee and the current attempt's status and minutes of every run. */
  private async summaryRuns(
    organizationId: string,
    spaceId: string,
    executionId: string,
  ): Promise<
    {
      case_id: string;
      assignee: (UserNameRow & { id: string }) | null;
      status: RunStatus | null;
      actual_minutes: number | null;
      measured_minutes: number | null;
      started_at: string | null;
      finished_at: string | null;
    }[]
  > {
    const { data, error } = await this.client
      .from('test_runs')
      .select(
        'case_id, current_attempt_no, ' +
          'assignee:users!test_runs_assignee_id_fkey(id, first_name, last_name, email), ' +
          'attempts:test_run_attempts!test_run_attempts_run_fkey(attempt_no, status, actual_minutes, started_at, finished_at)',
      )
      .eq('execution_id', executionId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .range(0, TEST_EXECUTION_LIMITS.runs - 1);

    if (error) throw tmDbError(this.logger, 'load run summary', error);

    return (
      (data ?? []) as unknown as {
        case_id: string;
        current_attempt_no: number;
        assignee: (UserNameRow & { id: string }) | null;
        attempts: {
          attempt_no: number;
          status: RunStatus;
          actual_minutes: number | null;
          started_at?: string | null;
          finished_at?: string | null;
        }[];
      }[]
    ).map((run) => {
      const current = run.attempts.find(
        (attempt) => attempt.attempt_no === run.current_attempt_no,
      );

      const started = current?.started_at
        ? Date.parse(current.started_at)
        : NaN;
      const finished = current?.finished_at
        ? Date.parse(current.finished_at)
        : NaN;

      return {
        case_id: run.case_id,
        assignee: run.assignee,
        status: current?.status ?? null,
        actual_minutes: current?.actual_minutes ?? null,
        measured_minutes:
          finished >= started ? Math.round((finished - started) / 60000) : null,
        started_at: current?.started_at ?? null,
        finished_at: current?.finished_at ?? null,
      };
    });
  }

  private createError(error: TmRpcError) {
    const detail = rpcDetail(error);

    // A case was deleted between the check and the insert of its run.
    if (error.code === '23503') {
      return new ConflictException({
        code: 'IN_USE',
        message:
          'A test case changed while the execution was being created. Try again.',
      });
    }

    if (error.code === 'P0002' && Array.isArray(detail.missing)) {
      return notFound({ not_found: detail.missing });
    }

    if (error.code === 'TM004') {
      return new ConflictException({
        code: 'ARCHIVED',
        message: detail.case_id
          ? 'The test case is archived'
          : 'The test plan or set is archived',
        data: detail,
      });
    }

    return tmRpcError(this.logger, 'create test execution', error);
  }
}
