import {
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
import {
  removeEvidenceFiles,
  removeRecordFiles,
  type StorageCleanup,
} from '../common/evidence-storage';
import type { EligibleTester } from '../dto/test-plan.dto';
import { assertKnownTestType } from '../common/test-task-types';
import { TesterEligibilityService } from '../common/tester-eligibility.service';
import {
  assertRecordFolder,
  completeNewTicket,
  createRecordTicket,
  loadNewRecord,
  plainTextToTicketHtml,
  ticketEmbed,
  ticketKeyFields,
  ticketName,
  ticketSearchFilter,
} from '../common/ticket-keys';
import type {
  BulkDeleteTestCasesDto,
  BulkTestCasesDto,
  CreateTestCaseDto,
  ListTestCasesQueryDto,
  SaveTestStepsDto,
  TestCaseBulkDeleteResult,
  TestCaseBulkResult,
  TestCaseDetail,
  TestCaseHistoryEntry,
  TestCaseHistoryPage,
  TestCaseSummary,
  TestCaseAssigneeResult,
  TestRecordUser,
  UpdateTestCaseDto,
} from '../dto/test-case.dto';
import {
  notFound,
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../test-management-errors';
import { checkFilePath, invalid } from '../automation/automation-inputs';

const SUMMARY_COLUMNS =
  'id, folder_id, readiness, test_type, estimate_minutes, revision, is_archived, updated_at';

// The ticket holds the key, title and assignee.
const CASE_TICKET = ticketEmbed(
  'test_cases',
  'key, summary, assignee:users!tasks_assigned_to_fkey(id, first_name, last_name, email, avatar_url)',
);

// Enough of the objective for a one-line preview in the list.
const OBJECTIVE_PREVIEW_LENGTH = 200;

/** Search text as a quoted ilike pattern, so wildcards and PostgREST separators in it match literally. */
export function containsPattern(text: string): string {
  const literal = text
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');

  return `"%${literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}%"`;
}

// Sort fields map to fixed columns; the client value is never put into the query.
const SORT_COLUMNS = new Map<string, string>([
  ['key', 'created_at'],
  ['title', 'task(summary)'],
  ['readiness', 'readiness'],
  ['created_at', 'created_at'],
  ['updated_at', 'updated_at'],
]);

/** Parses `field[:asc|desc]`; anything unknown falls back to key ascending. */
export function caseSort(sort?: string): {
  column: string;
  ascending: boolean;
} {
  const [field, direction] = (sort ?? '').split(':');
  const column = SORT_COLUMNS.get(field);

  return column
    ? { column, ascending: direction !== 'desc' }
    : { column: 'created_at', ascending: true };
}

interface CaseTicket {
  key: string;
  summary: string;
  assignee?: TestRecordUser | null;
}

/** A case row with its key, title and assignee filled in from its ticket. */
function withCaseTicket<Row extends { task?: CaseTicket }>(row: Row) {
  const { task, ...rest } = row;

  return task
    ? {
        ...rest,
        ...ticketKeyFields(task.key),
        title: ticketName(task.summary),
        assignee: task.assignee ?? null,
      }
    : rest;
}

const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, objective, preconditions, automation_key, automation_spec_path, definition, labels, steps, archived_at, created_by, updated_by, created_at, task_id, ${CASE_TICKET}`;

/** Blank clears the linked test file; a run passes the name to the framework, so it follows the zip file name rule. */
function checkSpecPath(value: string | null): string | null {
  if (!value) return null;

  try {
    return checkFilePath(value);
  } catch {
    throw invalid(
      'automation_spec_path',
      'Use a relative path of letters, digits, . _ / and -, such as tests/login.spec.ts',
    );
  }
}

const HISTORY_COLUMNS =
  'id, revision, change_kind, changes, changed_by, changed_at, changed_by_user:users(id, first_name, last_name, email)';

const HISTORY_PAGE_SIZE = 30;

// A conflict other than CASE_HAS_RUNS, or any other error, leaves the case as it was.
function bulkDeleteReason(
  error: unknown,
): TestCaseBulkDeleteResult['skipped'][number]['reason'] {
  if (error instanceof NotFoundException) return 'not_found';

  const response =
    error instanceof HttpException ? error.getResponse() : undefined;

  return typeof response === 'object' &&
    (response as { code?: string }).code === 'CASE_HAS_RUNS'
    ? 'has_runs'
    : 'failed';
}

export interface TestCaseListItem extends TestCaseSummary {
  objective_preview: string | null;
  /** Key of the task ticket the case belongs to. */
  task_key: string | null;
  /** Who last changed the case, for the list row. */
  updater?: TestRecordUser | null;
  assignee?: TestRecordUser | null;
}

export interface TestCasePage {
  items: TestCaseListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TestCaseSaveResult {
  changed: boolean;
  revision: number;
  case: TestCaseDetail;
}

export interface TestCaseDeleteResult {
  deleted: boolean;
  has_runs: boolean;
  counts: Record<string, number>;
}

/** Test case CRUD; every write goes through a tm_* function that re-checks tenant, revision and limits. */
@Injectable()
export class TestCasesService {
  private readonly logger = new Logger(TestCasesService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly auditLogs: AuditLogsService,
    @Optional() private readonly events?: EventEmitter2,
    @Optional() private readonly eligibility?: TesterEligibilityService,
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly permissions?: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async rpc<T>(
    fn: string,
    args: Record<string, unknown>,
    action: string,
  ): Promise<T> {
    const { data, error } = (await this.client.rpc(fn, args)) as {
      data: T;
      error: TmRpcError | null;
    };

    if (error) throw tmRpcError(this.logger, action, error);

    return data;
  }

  async list(
    organizationId: string,
    spaceId: string,
    query: ListTestCasesQueryDto,
  ): Promise<TestCasePage> {
    await this.access.assertAvailable(organizationId, spaceId);

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const from = (page - 1) * pageSize;

    const sort = caseSort(query.sort);

    const { data, error, count, status } = await this.filteredCases(
      organizationId,
      spaceId,
      query,
      `${SUMMARY_COLUMNS}, objective, ${CASE_TICKET}, updater:users!test_cases_updated_by_fkey(id, first_name, last_name, email, avatar_url)`,
      { count: 'exact' },
    )
      .order(sort.column, { ascending: sort.ascending })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);

    // A page past the end is answered with 416, whose PGRST103 body some gateways cut off; return it as an empty page with the real total.
    if (error?.code === 'PGRST103' || status === 416) {
      const { count: all, error: countError } = await this.filteredCases(
        organizationId,
        spaceId,
        query,
        `id, ${ticketEmbed('test_cases', 'key')}`,
        { count: 'exact', head: true },
      );

      if (countError)
        throw tmDbError(this.logger, 'list test cases', countError);

      return { items: [], total: all ?? 0, page, pageSize };
    }

    if (error) throw tmDbError(this.logger, 'list test cases', error);

    const rows = (data ?? []) as unknown as (TestCaseSummary & {
      objective: string | null;
      task: CaseTicket;
      updater: TestRecordUser | null;
    })[];

    return {
      items: rows.map(({ objective, ...row }) => ({
        ...(withCaseTicket(row) as TestCaseSummary & {
          task_key: string;
          updater: TestRecordUser | null;
          assignee: TestRecordUser | null;
        }),
        objective_preview: objective
          ? objective.slice(0, OBJECTIVE_PREVIEW_LENGTH)
          : null,
      })),
      total: count ?? 0,
      page,
      pageSize,
    };
  }

  /** Cases of the space matching the list filters; the same filters back the page and its count. */
  private filteredCases(
    organizationId: string,
    spaceId: string,
    query: ListTestCasesQueryDto,
    columns: string,
    options: { count: 'exact'; head?: boolean },
  ) {
    let builder = this.client
      .from('test_cases')
      .select(columns, options)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .eq('is_archived', query.archived === true);

    if (query.folderId) builder = builder.eq('folder_id', query.folderId);
    if (query.taskId) builder = builder.eq('task_id', query.taskId);
    if (query.testType) builder = builder.eq('test_type', query.testType);
    if (query.readiness?.length)
      builder = builder.in('readiness', query.readiness);
    if (query.q) {
      builder = builder.or(ticketSearchFilter(containsPattern(query.q)), {
        referencedTable: 'task',
      });
    }

    return builder;
  }

  /** People who can be assigned to a test case: the same ones plans and runs accept. */
  async eligibleTesters(
    organizationId: string,
    spaceId: string,
  ): Promise<EligibleTester[]> {
    await this.access.assertAvailable(organizationId, spaceId);

    return this.requireEligibility().listEligible(organizationId, spaceId);
  }

  /** Changes the ticket's assignee; the database then updates open plan tests and not-started runs, while started or finished runs keep their tester. */
  async setAssignee(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    assigneeId: string | null,
  ): Promise<TestCaseAssigneeResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    if (assigneeId !== null) {
      await this.requireEligibility().assertEligible(
        user.organizationId,
        spaceId,
        assigneeId,
      );
    }

    const result = await this.rpc<
      Omit<TestCaseAssigneeResult, 'case' | 'ticket_warning'>
    >(
      'tm_set_case_assignee',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_case_id: caseId,
        p_assignee_id: assigneeId,
      },
      'set test case assignee',
    );

    if (result.changed) {
      await this.updateTicket(user, spaceId, caseId, {
        assignedTo: assigneeId,
      });

      void this.auditLogs.logActionForRequest(
        user,
        'test_case',
        caseId,
        'update',
        {
          space_id: spaceId,
          assignee_id: assigneeId,
          plan_tests: result.plan_tests,
          runs: result.runs,
        },
      );
    }

    return {
      changed: result.changed,
      plan_tests: result.plan_tests,
      runs: result.runs,
      case: await this.load(user.organizationId, spaceId, caseId),
      ticket_warning: false,
    };
  }

  /** Hands fields held on the ticket to it, so its history, audit log and automations run as for any edit. */
  private async updateTicket(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    changes: TestTicketFieldChanges,
  ): Promise<void> {
    if (!this.events) throw new Error('Ticket updates are not available');

    const { task_id: taskId } = await this.load(
      user.organizationId,
      spaceId,
      caseId,
      'id, task_id',
    );

    await this.events.emitAsync(TEST_RECORD_UPDATED_EVENT, {
      organizationId: user.organizationId,
      taskId: taskId as string,
      userId: user.userId,
      changes,
    } satisfies TestRecordUpdatedEvent);
  }

  private requireEligibility(): TesterEligibilityService {
    if (!this.eligibility)
      throw new Error('Tester eligibility is not available');

    return this.eligibility;
  }

  async get(
    organizationId: string,
    spaceId: string,
    caseId: string,
  ): Promise<TestCaseDetail> {
    await this.access.assertAvailable(organizationId, spaceId);

    return this.load(organizationId, spaceId, caseId);
  }

  async create(
    user: RequestUser,
    spaceId: string,
    dto: CreateTestCaseDto,
  ): Promise<TestCaseDetail> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    if (dto.automation_spec_path !== undefined) {
      dto.automation_spec_path = checkSpecPath(dto.automation_spec_path);
    }

    if (dto.folder_id) {
      await assertRecordFolder(
        this.client,
        this.logger,
        user.organizationId,
        spaceId,
        dto.folder_id,
      );
    }

    const deps = {
      client: this.client,
      logger: this.logger,
      tasks: this.tasks,
      permissions: this.permissions,
    };
    const ticket = await createRecordTicket(
      deps,
      user,
      spaceId,
      'case_task_type_id',
      {
        summary: dto.title,
        description: plainTextToTicketHtml(dto.objective) || undefined,
        estimated_time: dto.estimate_minutes ?? undefined,
      },
    );

    const caseId = await completeNewTicket(deps, user, ticket.id, async () => {
      // The ticket listener made the case; the fields a ticket does not hold are added here.
      const created = await loadNewRecord<{ id: string; revision: number }>(
        this.client,
        this.logger,
        'test_cases',
        user.organizationId,
        ticket.id,
        'id, revision',
      );
      const patch: Record<string, unknown> = { ...dto };

      delete patch.title;
      delete patch.folder_id;

      if (Object.keys(patch).length > 0) {
        await this.rpc(
          'tm_update_case',
          {
            p_organization_id: user.organizationId,
            p_space_id: spaceId,
            p_actor_id: user.userId,
            p_case_id: created.id,
            p_expected_revision: created.revision,
            p_patch: patch,
          },
          'create test case',
        );
      }

      if (dto.folder_id) {
        await this.rpc(
          'tm_bulk_update_cases',
          {
            p_organization_id: user.organizationId,
            p_space_id: spaceId,
            p_actor_id: user.userId,
            p_case_ids: [created.id],
            p_action: 'move',
            p_folder_id: dto.folder_id,
          },
          'create test case',
        );
      }

      return created.id;
    });

    void this.auditLogs.logActionForRequest(
      user,
      'test_case',
      caseId,
      'create',
      { key: ticket.key, title: dto.title, space_id: spaceId },
    );

    return this.load(user.organizationId, spaceId, caseId);
  }

  async update(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    dto: UpdateTestCaseDto,
  ): Promise<TestCaseSaveResult> {
    const { expected_revision, ...patch } = dto;

    if (patch.test_type !== undefined) {
      await assertKnownTestType(
        this.client,
        this.logger,
        user.organizationId,
        spaceId,
        patch.test_type,
      );
    }

    if (patch.automation_spec_path !== undefined) {
      patch.automation_spec_path = checkSpecPath(patch.automation_spec_path);
    }

    return this.save(user, spaceId, caseId, expected_revision, patch);
  }

  async saveSteps(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    dto: SaveTestStepsDto,
  ): Promise<TestCaseSaveResult> {
    return this.save(user, spaceId, caseId, dto.expected_revision, {
      steps: dto.steps,
    });
  }

  async setArchived(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    archived: boolean,
  ): Promise<TestCaseDetail> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const result = await this.rpc<{ changed: boolean }>(
      'tm_bulk_update_cases',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_case_ids: [caseId],
        p_action: archived ? 'archive' : 'restore',
        p_folder_id: null,
      },
      archived ? 'archive test case' : 'restore test case',
    );

    if (result.changed) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_case',
        caseId,
        archived ? 'archive' : 'restore',
        { space_id: spaceId },
      );
    }

    return this.load(user.organizationId, spaceId, caseId);
  }

  /** Moves, archives or restores up to 500 cases at once; already-done ones come back as skipped. */
  async bulk(
    user: RequestUser,
    spaceId: string,
    dto: BulkTestCasesDto,
  ): Promise<TestCaseBulkResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const result = await this.rpc<TestCaseBulkResult>(
      'tm_bulk_update_cases',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_case_ids: dto.case_ids,
        p_action: dto.action,
        p_folder_id: dto.folder_id ?? null,
      },
      `${dto.action} test cases`,
    );

    if (result.changed) {
      void this.auditLogs.logActionForRequest(
        user,
        'space',
        spaceId,
        dto.action === 'move' ? 'update' : dto.action,
        {
          entity_type: 'test_case',
          action: dto.action,
          count: result.updated.length,
        },
      );

      for (const caseId of result.updated) {
        void this.auditLogs.logActionForRequest(
          user,
          'test_case',
          caseId,
          dto.action === 'move' ? 'update' : dto.action,
          {
            action: `bulk_${dto.action}`,
            bulk: true,
            space_id: spaceId,
            ...(dto.action === 'move'
              ? { folder_id: dto.folder_id ?? null }
              : {}),
          },
        );
      }
    }

    return result;
  }

  /** dryRun returns what would be removed; a case with runs is refused (409 CASE_HAS_RUNS). */
  async remove(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    dryRun: boolean,
  ): Promise<TestCaseDeleteResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: !dryRun,
    });

    // Read before the delete, since the link is gone afterwards.
    const linked = dryRun
      ? null
      : await this.client
          .from('test_cases')
          .select('task_id')
          .eq('id', caseId)
          .eq('space_id', spaceId)
          .eq('organization_id', user.organizationId)
          .maybeSingle();

    if (linked?.error)
      throw tmDbError(this.logger, 'load test case ticket', linked.error);

    const ticketId = (linked?.data as { task_id: string | null } | null)
      ?.task_id;

    // A case with a ticket goes with its ticket in one delete, so neither is ever left alone.
    if (ticketId && this.events) {
      const preview = await this.rpc<TestCaseDeleteResult>(
        'tm_delete_case',
        {
          p_organization_id: user.organizationId,
          p_space_id: spaceId,
          p_actor_id: user.userId,
          p_case_id: caseId,
          p_dry_run: true,
        },
        'check test case delete',
      );

      if (preview.has_runs) {
        throw new ConflictException({
          code: 'CASE_HAS_RUNS',
          message:
            'The test case has runs and cannot be deleted. Archive it instead.',
        });
      }

      // The ticket delete checks the task delete right; the database removes the case with it.
      await this.events.emitAsync(TEST_RECORD_DELETED_EVENT, {
        organizationId: user.organizationId,
        taskId: ticketId,
        userId: user.userId,
      } satisfies TestRecordDeletedEvent);

      void this.auditLogs.logActionForRequest(
        user,
        'test_case',
        caseId,
        'delete',
        { space_id: spaceId, counts: preview.counts },
      );

      return { deleted: true, has_runs: false, counts: preview.counts };
    }

    const result = await this.rpc<
      TestCaseDeleteResult & { storage_paths?: string[] }
    >(
      'tm_delete_case',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_case_id: caseId,
        p_dry_run: dryRun,
      },
      'delete test case',
    );

    if (result.deleted) {
      await removeEvidenceFiles(
        this.client,
        this.logger,
        result.storage_paths ?? [],
        `Test case ${caseId} delete`,
      );

      void this.auditLogs.logActionForRequest(
        user,
        'test_case',
        caseId,
        'delete',
        { space_id: spaceId, counts: result.counts },
      );

      const taskId = (linked?.data as { task_id: string | null } | null)
        ?.task_id;

      // Awaited so the ticket is already gone when the API answers.
      if (taskId) {
        await this.events?.emitAsync(TEST_RECORD_DELETED_EVENT, {
          organizationId: user.organizationId,
          taskId,
          userId: user.userId,
        } satisfies TestRecordDeletedEvent);
      }
    }

    return {
      deleted: result.deleted,
      has_runs: result.has_runs,
      counts: result.counts,
    };
  }

  /** Deletes up to 100 cases one by one through remove(), so each keeps its own checks, ticket delete and audit entry. */
  async bulkRemove(
    user: RequestUser,
    spaceId: string,
    dto: BulkDeleteTestCasesDto,
  ): Promise<TestCaseBulkDeleteResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // Only this space's cases get a key; any other id is reported as not found.
    const { data, error } = await this.client
      .from('test_cases')
      .select(`id, ${ticketEmbed('test_cases', 'key')}`)
      .in('id', dto.case_ids)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId);

    if (error) throw tmDbError(this.logger, 'load test cases to delete', error);

    const keys = new Map(
      ((data ?? []) as unknown as { id: string; task: { key: string } }[]).map(
        (row) => [row.id, row.task.key],
      ),
    );
    const result: TestCaseBulkDeleteResult = {
      changed: false,
      deleted: [],
      skipped: [],
    };
    const skip = (
      caseId: string,
      reason: TestCaseBulkDeleteResult['skipped'][number]['reason'],
    ) =>
      result.skipped.push({
        case_id: caseId,
        key: keys.get(caseId) ?? '',
        reason: keys.has(caseId) ? reason : 'not_found',
      });

    for (const [index, caseId] of dto.case_ids.entries()) {
      if (!keys.has(caseId)) {
        skip(caseId, 'not_found');
        continue;
      }

      try {
        const done = await this.remove(user, spaceId, caseId, false);

        if (done.deleted) {
          result.deleted.push({ case_id: caseId, key: keys.get(caseId) ?? '' });
        } else {
          skip(caseId, done.has_runs ? 'has_runs' : 'failed');
        }
      } catch (caught) {
        // Without the right to delete tickets every remaining case would fail the same way.
        if (caught instanceof ForbiddenException) {
          dto.case_ids.slice(index).forEach((id) => skip(id, 'failed'));
          break;
        }

        const reason = bulkDeleteReason(caught);

        if (reason === 'failed') {
          this.logger.warn(
            `Bulk delete of test case ${caseId} failed: ${(caught as Error).message}`,
          );
        }

        skip(caseId, reason);
      }
    }

    result.changed = result.deleted.length > 0;

    return result;
  }

  async history(
    organizationId: string,
    spaceId: string,
    caseId: string,
    before?: string,
  ): Promise<TestCaseHistoryPage> {
    await this.access.assertAvailable(organizationId, spaceId);

    // Proves the case belongs to this space before reading its history.
    await this.load(organizationId, spaceId, caseId, 'id');

    // One page of steps_saved entries can still be large; load `changes` per entry if that is ever measured.
    let query = this.client
      .from('test_case_history')
      .select(HISTORY_COLUMNS)
      .eq('case_id', caseId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId);

    if (before) {
      const { data: cursor, error: cursorError } = await this.client
        .from('test_case_history')
        .select('id, revision, changed_at')
        .eq('id', before)
        .eq('case_id', caseId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (cursorError)
        throw tmDbError(this.logger, 'load history', cursorError);
      if (!cursor) throw notFound();

      const { id, revision, changed_at } = cursor as {
        id: string;
        revision: number;
        changed_at: string;
      };

      // Follows the full sort order, so entries with the same timestamp are neither skipped nor repeated.
      const older = `changed_at.lt."${changed_at}",and(changed_at.eq."${changed_at}",revision.lt.${revision}),and(changed_at.eq."${changed_at}",revision.eq.${revision},id.lt.${id})`;

      query = query.or(older);
    }

    const { data, error } = await query
      .order('changed_at', { ascending: false })
      .order('revision', { ascending: false })
      .order('id', { ascending: false })
      .limit(HISTORY_PAGE_SIZE + 1);

    if (error) throw tmDbError(this.logger, 'load history', error);

    const rows = (data ?? []) as unknown as TestCaseHistoryEntry[];

    return {
      items: rows.slice(0, HISTORY_PAGE_SIZE),
      has_more: rows.length > HISTORY_PAGE_SIZE,
    };
  }

  private async save(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    expectedRevision: number,
    patch: Record<string, unknown>,
  ): Promise<TestCaseSaveResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // The title is on the ticket; the function still checks the revision and archive state when nothing else is sent.
    const { title, ...fields } = patch;
    const result = await this.rpc<{
      changed: boolean;
      revision: number;
      changes: Record<string, unknown> & {
        steps?: { removed?: { id: string }[] };
      };
    }>(
      'tm_update_case',
      {
        p_organization_id: user.organizationId,
        p_space_id: spaceId,
        p_actor_id: user.userId,
        p_case_id: caseId,
        p_expected_revision: expectedRevision,
        p_patch: fields,
      },
      'update test case',
    );

    const removedStepIds = result.changed
      ? (result.changes?.steps?.removed ?? []).map((step) => step.id)
      : [];

    // Before the ticket steps: a ticket refusal does not bring removed steps back.
    if (removedStepIds.length) {
      await this.removeEntityFiles(
        user.organizationId,
        'test_step',
        removedStepIds,
        `Test case ${caseId} removed steps`,
      );
    }

    if (result.changed) {
      await this.syncTicket(
        user,
        spaceId,
        caseId,
        result.revision,
        result.changes,
      );
    }

    const before = await this.load(user.organizationId, spaceId, caseId);
    const newTitle = typeof title === 'string' ? title.trim() : undefined;
    const titleChanged = newTitle !== undefined && newTitle !== before.title;

    // The ticket listener raises the revision and writes the history row.
    if (titleChanged) {
      await this.updateTicket(user, spaceId, caseId, { summary: newTitle });
    }

    const changed = result.changed || titleChanged;
    const saved = titleChanged
      ? await this.load(user.organizationId, spaceId, caseId)
      : before;

    if (changed) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_case',
        caseId,
        'update',
        {
          space_id: spaceId,
          revision: saved.revision,
          changes: {
            ...result.changes,
            ...(titleChanged
              ? { title: { from: before.title, to: newTitle } }
              : {}),
          },
        },
      );
    }

    return { changed, revision: saved.revision, case: saved };
  }

  private async load(
    organizationId: string,
    spaceId: string,
    caseId: string,
    columns: string = DETAIL_COLUMNS,
  ): Promise<TestCaseDetail> {
    const { data, error } = await this.client
      .from('test_cases')
      .select(columns)
      .eq('id', caseId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load test case', error);
    if (!data) throw notFound();

    return withCaseTicket(
      data as unknown as TestCaseDetail & { task?: CaseTicket },
    ) as TestCaseDetail;
  }

  /**
   * Hands an estimate change to the ticket. When the ticket cannot take it, the case gets its old estimate back,
   * so both sides never differ.
   */
  private async syncTicket(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    revision: number,
    changes: Record<string, unknown>,
  ): Promise<void> {
    const shared = sharedCaseChanges(changes);

    if (!shared || !this.events) return;

    const { data, error } = await this.client
      .from('test_cases')
      .select('task_id')
      .eq('id', caseId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle<{ task_id: string | null }>();

    if (error) throw tmDbError(this.logger, 'load test case ticket', error);
    if (!data?.task_id) return;

    try {
      await this.events.emitAsync(TEST_RECORD_UPDATED_EVENT, {
        organizationId: user.organizationId,
        taskId: data.task_id,
        userId: user.userId,
        changes: shared.changes,
      } satisfies TestRecordUpdatedEvent);
    } catch (syncError) {
      try {
        await this.rpc(
          'tm_update_case',
          {
            p_organization_id: user.organizationId,
            p_space_id: spaceId,
            p_actor_id: user.userId,
            p_case_id: caseId,
            p_expected_revision: revision,
            p_patch: shared.previous,
          },
          'put back test case',
        );
      } catch (undoError) {
        this.logger.error(
          `Test case ${caseId} could not be put back after its ticket failed to update: ${(undoError as Error).message}`,
        );
      }

      throw syncError;
    }
  }

  // Files of removed steps or a deleted case go with them; those are already saved, so a failure only warns.
  private removeEntityFiles(
    organizationId: string,
    entityType: 'test_step' | 'test_case',
    entityIds: string[],
    context: string,
  ): Promise<StorageCleanup> {
    return removeRecordFiles(
      this.client,
      this.logger,
      organizationId,
      entityType,
      entityIds,
      context,
    );
  }
}

/** An estimate change of a case as a ticket field, with the old value to put back; null when it did not change. */
function sharedCaseChanges(changes: Record<string, unknown>): {
  changes: TestTicketFieldChanges;
  previous: Record<string, unknown>;
} | null {
  const shared: TestTicketFieldChanges = {};
  const previous: Record<string, unknown> = {};
  const estimate = changes.estimate_minutes as
    | { from: number | null; to: number | null }
    | undefined;

  if (estimate) {
    shared.estimatedTime = estimate.to;
    previous.estimate_minutes = estimate.from;
  }

  return Object.keys(shared).length > 0 ? { changes: shared, previous } : null;
}
