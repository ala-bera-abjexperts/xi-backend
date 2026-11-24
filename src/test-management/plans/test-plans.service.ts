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
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TasksService } from '../../tasks/tasks.service';
import {
  planDayToTicketDate,
  planTextToTicketHtml,
  ticketDateToPlanDay,
  TEST_RECORD_DELETED_EVENT,
  TEST_RECORD_UPDATED_EVENT,
  type TestRecordDeletedEvent,
  type TestRecordUpdatedEvent,
  type TestTicketFieldChanges,
} from '../../tasks/test-ticket-events';
import { TestManagementAccessService } from '../access/test-management-access.service';
import { containsPattern } from '../cases/test-cases.service';
import { bulkSetArchived } from '../common/bulk-archive';
import { countRunResults, hasResults } from '../common/run-results';
import {
  assertRecordFolder,
  completeNewTicket,
  createRecordTicket,
  loadNewRecord,
  ticketEmbed,
  ticketKeyFields,
  ticketName,
  ticketRichText,
  ticketSearchFilter,
} from '../common/ticket-keys';
import type {
  BulkArchiveTestPlansDto,
  BulkDeleteTestPlansDto,
  CreateTestPlanDto,
  ListTestPlansQueryDto,
  TestPlan,
  TestPlanBulkDeleteResult,
  TestPlanDeleted,
  TestPlanPage,
  TestPlanPageQueryDto,
  UpdateTestPlanDto,
} from '../dto/test-plan.dto';
import type { TestRecordBulkArchiveResult } from '../dto/test-set.dto';
import { notFound, tmDbError } from '../test-management-errors';

// Counted by PostgREST in the same query, so a list never asks per plan.
const COUNTS =
  'test_count:test_plan_tests!test_plan_tests_plan_fkey(count), execution_count:test_executions!test_executions_plan_fkey(count)';

// The ticket holds the key, name, description and dates.
const PLAN_TICKET = ticketEmbed(
  'test_plans',
  'key, summary, description, start_date, due_date',
);

const PLAN_COLUMNS = `id, task_id, is_archived, archived_at, created_by, updated_by, created_at, updated_at, folder_id, ${PLAN_TICKET}`;

const PLAN_SELECT = `${PLAN_COLUMNS}, ${COUNTS}`;

// A plan that has been run keeps its results; any other error leaves the plan as it was.
function bulkDeleteReason(
  error: unknown,
): TestPlanBulkDeleteResult['skipped'][number]['reason'] {
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
  ['start_date', 'task(start_date)'],
  ['end_date', 'task(due_date)'],
  ['updated_at', 'updated_at'],
]);

interface PlanTicket {
  key: string;
  summary: string;
  description: string | null;
  start_date: string | null;
  due_date: string | null;
}

type CountedPlanRow = Omit<
  TestPlan,
  | 'test_count'
  | 'execution_count'
  | 'key'
  | 'key_number'
  | 'name'
  | 'description'
  | 'start_date'
  | 'end_date'
> & {
  test_count: { count: number }[] | null;
  execution_count: { count: number }[] | null;
  task?: PlanTicket;
};

interface PageResponse {
  data: unknown;
  error: { code?: string; message: string } | null;
  count: number | null;
  status?: number;
}

function withCounts({ task, ...row }: CountedPlanRow): TestPlan {
  return {
    ...row,
    test_count: row.test_count?.[0]?.count ?? 0,
    execution_count: row.execution_count?.[0]?.count ?? 0,
    ...(task
      ? {
          ...ticketKeyFields(task.key),
          name: ticketName(task.summary),
          description: ticketRichText(task.description),
          start_date: ticketDateToPlanDay(task.start_date),
          end_date: ticketDateToPlanDay(task.due_date),
        }
      : {}),
  } as TestPlan;
}

export function planArchivedError(): ConflictException {
  return new ConflictException({
    code: 'ARCHIVED',
    message: 'The test plan is archived. Restore it first.',
  });
}

/** A page past the end is answered with 416, whose PGRST103 body some gateways cut off; it comes back as an empty page with the real total. */
export async function fetchPage<Row>(
  logger: Logger,
  action: string,
  query: TestPlanPageQueryDto,
  rows: (from: number, to: number) => PromiseLike<PageResponse>,
  total: () => PromiseLike<PageResponse>,
): Promise<TestPlanPage<Row>> {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  const from = (page - 1) * pageSize;

  const { data, error, count, status } = await rows(from, from + pageSize - 1);

  if (error?.code === 'PGRST103' || status === 416) {
    const { count: all, error: countError } = await total();

    if (countError) throw tmDbError(logger, action, countError);

    return { items: [], total: all ?? 0, page, pageSize };
  }

  if (error) throw tmDbError(logger, action, error);

  return { items: (data ?? []) as Row[], total: count ?? 0, page, pageSize };
}

/** Test plan CRUD; tests in a plan are handled by TestPlanTestsService. */
@Injectable()
export class TestPlansService {
  private readonly logger = new Logger(TestPlansService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly auditLogs: AuditLogsService,
    @Optional() private readonly events?: EventEmitter2,
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly permissions?: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async list(
    organizationId: string,
    spaceId: string,
    query: ListTestPlansQueryDto,
  ): Promise<TestPlanPage<TestPlan>> {
    await this.access.assertAvailable(organizationId, spaceId);

    const search = query.q ? containsPattern(query.q) : null;
    const [field, direction] = (query.sort ?? '').split(':');
    const column = SORT_COLUMNS.get(field) ?? 'created_at';
    const ascending = SORT_COLUMNS.has(field) ? direction !== 'desc' : true;

    // Plans need one planned test matching both filters; the empty embed only filters and returns nothing.
    const matched =
      query.testerId || query.testType
        ? `, matched:test_plan_tests!test_plan_tests_plan_fkey!inner(${
            query.testType
              ? 'test:test_cases!test_plan_tests_case_fkey!inner()'
              : ''
          })`
        : '';

    const plans = (columns: string, head = false) => {
      let builder = this.client
        .from('test_plans')
        .select(`${columns}${matched}`, { count: 'exact', head })
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .eq('is_archived', query.archived === true);

      if (search) {
        builder = builder.or(ticketSearchFilter(search), {
          referencedTable: 'task',
        });
      }

      if (query.taskId) builder = builder.eq('task_id', query.taskId);
      if (query.folderId) builder = builder.eq('folder_id', query.folderId);
      if (query.testerId)
        builder = builder.eq('matched.planned_tester_id', query.testerId);
      if (query.testType)
        builder = builder.eq('matched.test.test_type', query.testType);

      return builder;
    };

    const result = await fetchPage<CountedPlanRow>(
      this.logger,
      'list test plans',
      query,
      (from, to) => {
        // Empty dates sort last in both directions.
        let builder = plans(
          `${PLAN_SELECT}, updater:users!test_plans_updated_by_fkey(id, first_name, last_name, email, avatar_url)`,
        ).order(column, {
          ascending,
          nullsFirst: false,
        });

        if (column !== 'created_at') {
          builder = builder.order('created_at', { ascending: true });
        }

        return builder.order('id', { ascending: true }).range(from, to);
      },
      () => plans(`id, ${ticketEmbed('test_plans', 'key')}`, true),
    );

    return {
      ...result,
      items: result.items.map((row) => withCounts(row)),
    };
  }

  async get(
    organizationId: string,
    spaceId: string,
    planId: string,
  ): Promise<TestPlan> {
    await this.access.assertAvailable(organizationId, spaceId);

    return this.load(organizationId, spaceId, planId);
  }

  async create(
    user: RequestUser,
    spaceId: string,
    dto: CreateTestPlanDto,
  ): Promise<TestPlan> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

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
      'plan_task_type_id',
      {
        summary: dto.name,
        description: dto.description
          ? planTextToTicketHtml(dto.description)
          : undefined,
        start_date: planDayToTicketDate(dto.start_date ?? null) ?? undefined,
        due_date: planDayToTicketDate(dto.end_date ?? null) ?? undefined,
      },
    );

    const plan = await completeNewTicket(deps, user, ticket.id, async () => {
      // The ticket listener made the plan; a folder is the only field a ticket does not hold.
      const created = await loadNewRecord<{ id: string }>(
        this.client,
        this.logger,
        'test_plans',
        user.organizationId,
        ticket.id,
      );

      if (dto.folder_id) {
        const { error } = await this.client
          .from('test_plans')
          .update({ folder_id: dto.folder_id, updated_by: user.userId })
          .eq('id', created.id)
          .eq('organization_id', user.organizationId);

        if (error) throw tmDbError(this.logger, 'create test plan', error);
      }

      return this.load(user.organizationId, spaceId, created.id);
    });

    void this.auditLogs.logActionForRequest(
      user,
      'test_plan',
      plan.id,
      'create',
      { key: plan.key, name: plan.name, space_id: spaceId },
    );

    return plan;
  }

  async update(
    user: RequestUser,
    spaceId: string,
    planId: string,
    dto: UpdateTestPlanDto,
  ): Promise<TestPlan> {
    const changes: Record<string, unknown> = {};

    if (dto.name !== undefined) changes.name = dto.name;
    if (dto.description !== undefined) changes.description = dto.description;
    if (dto.start_date !== undefined) changes.start_date = dto.start_date;
    if (dto.end_date !== undefined) changes.end_date = dto.end_date;
    if (dto.folder_id !== undefined) changes.folder_id = dto.folder_id;

    if (Object.keys(changes).length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Provide a name, a description, a date or a folder to update',
      });
    }

    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // The is_archived filter makes the archived check and the write one statement.
    const { data, error } = await this.client
      .from('test_plans')
      .update({
        ...(dto.folder_id !== undefined ? { folder_id: dto.folder_id } : {}),
        updated_by: user.userId,
      })
      .eq('id', planId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('is_archived', false)
      .select(PLAN_SELECT)
      .maybeSingle();

    // Only the folder link can be missing on an update, so the folder is gone.
    if (error?.code === '23503' && dto.folder_id) {
      throw notFound({ folder_id: dto.folder_id });
    }

    if (error) throw tmDbError(this.logger, 'update test plan', error);

    if (!data) {
      await this.load(user.organizationId, spaceId, planId, 'id');

      throw planArchivedError();
    }

    const current = withCounts(data as unknown as CountedPlanRow);
    const ticketChanges: TestTicketFieldChanges = {};

    if (dto.name !== undefined && dto.name.trim() !== current.name) {
      ticketChanges.summary = dto.name;
    }

    if (
      dto.description !== undefined &&
      ticketRichText(dto.description) !== current.description
    ) {
      ticketChanges.description = planTextToTicketHtml(dto.description);
    }

    if (dto.start_date !== undefined && dto.start_date !== current.start_date) {
      ticketChanges.startDate = planDayToTicketDate(dto.start_date);
    }

    if (dto.end_date !== undefined && dto.end_date !== current.end_date) {
      ticketChanges.dueDate = planDayToTicketDate(dto.end_date);
    }

    const ticketChanged = Object.keys(ticketChanges).length > 0;

    if (ticketChanged) {
      if (!this.events) throw new Error('Ticket updates are not available');

      // A date change that puts the end before the start is refused by the ticket (TEST_DATES_ORDER).
      await this.events.emitAsync(TEST_RECORD_UPDATED_EVENT, {
        organizationId: user.organizationId,
        taskId: current.task_id as string,
        userId: user.userId,
        changes: ticketChanges,
      } satisfies TestRecordUpdatedEvent);
    }

    // Logged only after the ticket took the change, so a refusal leaves no entry.
    void this.auditLogs.logActionForRequest(
      user,
      'test_plan',
      planId,
      'update',
      { space_id: spaceId, changes },
    );

    return ticketChanged
      ? this.load(user.organizationId, spaceId, planId)
      : current;
  }

  /** Archiving an archived plan (or restoring an active one) returns it unchanged. */
  async setArchived(
    user: RequestUser,
    spaceId: string,
    planId: string,
    archived: boolean,
  ): Promise<TestPlan> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const { data, error } = await this.client
      .from('test_plans')
      .update({
        is_archived: archived,
        archived_at: archived ? new Date().toISOString() : null,
        archived_by: archived ? user.userId : null,
        updated_by: user.userId,
      })
      .eq('id', planId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('is_archived', !archived)
      .select(PLAN_SELECT)
      .maybeSingle();

    if (error) {
      throw tmDbError(
        this.logger,
        archived ? 'archive test plan' : 'restore test plan',
        error,
      );
    }

    if (!data) return this.load(user.organizationId, spaceId, planId);

    void this.auditLogs.logActionForRequest(
      user,
      'test_plan',
      planId,
      archived ? 'archive' : 'restore',
      { space_id: spaceId },
    );

    return withCounts(data as unknown as CountedPlanRow);
  }

  /** Archives or restores the selected plans through setArchived(), so each keeps its own audit entry. */
  async bulkArchive(
    user: RequestUser,
    spaceId: string,
    dto: BulkArchiveTestPlansDto,
  ): Promise<TestRecordBulkArchiveResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const archived = dto.action === 'archive';

    return bulkSetArchived({
      client: this.client,
      logger: this.logger,
      table: 'test_plans',
      organizationId: user.organizationId,
      spaceId,
      ids: dto.plan_ids,
      archived,
      setArchived: (id) => this.setArchived(user, spaceId, id, archived),
    });
  }

  /**
   * Plan tests cascade; executions only lose plan_id and stay as ad hoc ones.
   * The detached count is read just before the delete, so a concurrent change can make it stale.
   */
  async remove(
    user: RequestUser,
    spaceId: string,
    planId: string,
  ): Promise<TestPlanDeleted> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const { count, error: countError } = await this.client
      .from('test_executions')
      .select('id', { count: 'exact', head: true })
      .eq('plan_id', planId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId);

    if (countError) {
      throw tmDbError(this.logger, 'count plan executions', countError);
    }

    // A plan whose executions have been run keeps them; it can only be archived.
    if ((count ?? 0) > 0) {
      const results = await countRunResults(
        this.client,
        this.logger,
        user.organizationId,
        spaceId,
        { planId },
      );

      if (results > 0) {
        throw hasResults(
          'Executions of this test plan have already been run and it cannot be deleted. Archive it instead.',
          results,
        );
      }
    }

    const plan = await this.load(user.organizationId, spaceId, planId);

    if (!this.events) throw new Error('Ticket deletes are not available');

    // The ticket delete checks the task delete right; the database removes the plan with it.
    await this.events.emitAsync(TEST_RECORD_DELETED_EVENT, {
      organizationId: user.organizationId,
      taskId: plan.task_id as string,
      userId: user.userId,
    } satisfies TestRecordDeletedEvent);

    const executionsDetached = count ?? 0;

    void this.auditLogs.logActionForRequest(
      user,
      'test_plan',
      planId,
      'delete',
      {
        space_id: spaceId,
        key: plan.key,
        name: plan.name,
        executions_detached: executionsDetached,
      },
    );

    return { executions_detached: executionsDetached };
  }

  /** Deletes the selected plans one at a time through remove(), so each keeps its own checks, ticket delete and audit entry. */
  async bulkRemove(
    user: RequestUser,
    spaceId: string,
    dto: BulkDeleteTestPlansDto,
  ): Promise<TestPlanBulkDeleteResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // Only this space's plans get a key; any other id is reported as not found.
    const { data, error } = await this.client
      .from('test_plans')
      .select(`id, ${ticketEmbed('test_plans', 'key')}`)
      .in('id', dto.plan_ids)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId);

    if (error) throw tmDbError(this.logger, 'load test plans to delete', error);

    const keys = new Map(
      ((data ?? []) as unknown as { id: string; task: { key: string } }[]).map(
        (row) => [row.id, row.task.key],
      ),
    );
    const result: TestPlanBulkDeleteResult = {
      changed: false,
      deleted: [],
      skipped: [],
    };
    const skip = (
      planId: string,
      reason: TestPlanBulkDeleteResult['skipped'][number]['reason'],
    ) =>
      result.skipped.push({
        plan_id: planId,
        key: keys.get(planId) ?? '',
        reason: keys.has(planId) ? reason : 'not_found',
      });

    for (const [index, planId] of dto.plan_ids.entries()) {
      if (!keys.has(planId)) {
        skip(planId, 'not_found');
        continue;
      }

      try {
        const done = await this.remove(user, spaceId, planId);

        result.deleted.push({
          plan_id: planId,
          key: keys.get(planId) ?? '',
          executions_detached: done.executions_detached,
        });
      } catch (caught) {
        // Without the right to delete tickets every remaining plan would fail the same way.
        if (caught instanceof ForbiddenException) {
          dto.plan_ids.slice(index).forEach((id) => skip(id, 'failed'));
          break;
        }

        const reason = bulkDeleteReason(caught);

        if (reason === 'failed') {
          this.logger.warn(
            `Bulk delete of test plan ${planId} failed: ${(caught as Error).message}`,
          );
        }

        skip(planId, reason);
      }
    }

    result.changed = result.deleted.length > 0;

    return result;
  }

  /** Scoped load without the access check; foreign and missing plans are the same 404. */
  async load(
    organizationId: string,
    spaceId: string,
    planId: string,
    columns = PLAN_SELECT,
  ): Promise<TestPlan> {
    const { data, error } = await this.client
      .from('test_plans')
      .select(columns)
      .eq('id', planId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load test plan', error);
    if (!data) throw notFound();

    return withCounts(data as unknown as CountedPlanRow);
  }
}
