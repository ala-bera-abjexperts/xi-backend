import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { containsPattern } from '../cases/test-cases.service';
import { bulkSetArchived } from '../common/bulk-archive';
import type {
  BulkArchiveTestSetsDto,
  BulkDeleteTestSetsDto,
  CreateTestSetDto,
  ListTestSetsQueryDto,
  TestRecordBulkArchiveResult,
  TestSetBulkDeleteResult,
  TestSetDetail,
  TestSetMember,
  TestSetMembersChange,
  TestSetMembersQueryDto,
  TestSetPage,
  TestSetPageQueryDto,
  TestSetSummary,
  UpdateTestSetDto,
} from '../dto/test-set.dto';
import { TEST_SET_LIMITS } from '../dto/test-set.dto';
import {
  notFound,
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../test-management-errors';
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

// Counted by PostgREST in the same query, so a list never asks per set.
const MEMBER_COUNT = 'member_count:test_set_members(count)';

// The ticket holds the key, name and description.
const SET_TICKET = ticketEmbed('test_sets', 'key, summary, description');

const SUMMARY_COLUMNS = `id, is_archived, updated_at, folder_id, ${SET_TICKET}`;

const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, archived_at, archived_by, created_by, updated_by, created_at, task_id`;

const MEMBER_COLUMNS = `id, readiness, test_type, is_archived, ${ticketEmbed(
  'test_cases',
  'key, summary, assignee:users!tasks_assigned_to_fkey(id, first_name, last_name, email, avatar_url)',
)}`;

// Fixed columns for the cases of a set; key follows creation order like the set list.
const MEMBER_SORT_COLUMNS = new Map<string, string>([
  ['key', 'created_at'],
  ['title', 'task(summary)'],
  ['readiness', 'readiness'],
  ['test_type', 'test_type'],
]);

// A ticket key is text, so creation order stands in for key order.
const SET_SORT_COLUMNS = new Map<string, string>([
  ['key', 'created_at'],
  ['name', 'task(summary)'],
  ['updated_at', 'updated_at'],
]);

interface SetTicket {
  key: string;
  summary: string;
  description: string | null;
}

type WithCountRow<T extends TestSetSummary> = Omit<T, 'member_count'> & {
  member_count: { count: number }[] | null;
};

interface PageResponse {
  data: unknown;
  error: { code?: string; message: string } | null;
  count: number | null;
  status?: number;
}

function withCount<T extends TestSetSummary>(row: WithCountRow<T>): T {
  return { ...row, member_count: row.member_count?.[0]?.count ?? 0 } as T;
}

// The key, name and description are read from the ticket.
function withTicket<T extends TestSetSummary>(row: T): T {
  if (!('task' in row)) return row;

  const { task, ...rest } = row as T & { task: SetTicket };

  return {
    ...rest,
    ...ticketKeyFields(task.key),
    name: ticketName(task.summary),
    description: ticketRichText(task.description),
  } as unknown as T;
}

function archivedError(): ConflictException {
  return new ConflictException({
    code: 'ARCHIVED',
    message: 'The test set is archived. Restore it first.',
  });
}

/** Test set CRUD and membership; members change only through tm_change_set_members. */
@Injectable()
export class TestSetsService {
  private readonly logger = new Logger(TestSetsService.name);

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
    query: ListTestSetsQueryDto,
  ): Promise<TestSetPage<TestSetSummary>> {
    await this.access.assertAvailable(organizationId, spaceId);

    const search = query.q ? containsPattern(query.q) : null;

    const sets = (columns: string, head = false) => {
      let builder = this.client
        .from('test_sets')
        .select(columns, { count: 'exact', head })
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

      return builder;
    };

    const [field, direction] = (query.sort ?? '').split(':');
    const column = SET_SORT_COLUMNS.get(field) ?? 'created_at';
    const ascending = SET_SORT_COLUMNS.has(field) ? direction !== 'desc' : true;

    const result = await this.fetchPage<WithCountRow<TestSetSummary>>(
      'list test sets',
      query,
      (from, to) => {
        let builder = sets(
          `${SUMMARY_COLUMNS}, ${MEMBER_COUNT}, updater:users!test_sets_updated_by_fkey(id, first_name, last_name, email, avatar_url)`,
        ).order(column, { ascending });

        // Equal names or times keep a stable order across pages.
        if (column !== 'created_at') {
          builder = builder.order('created_at', { ascending: true });
        }

        return builder.order('id', { ascending: true }).range(from, to);
      },
      () => sets(`id, ${ticketEmbed('test_sets', 'key')}`, true),
    );

    return {
      ...result,
      items: result.items.map((row) => withTicket(withCount(row))),
    };
  }

  async get(
    organizationId: string,
    spaceId: string,
    setId: string,
  ): Promise<TestSetDetail> {
    await this.access.assertAvailable(organizationId, spaceId);

    return this.load(organizationId, spaceId, setId);
  }

  async create(
    user: RequestUser,
    spaceId: string,
    dto: CreateTestSetDto,
  ): Promise<TestSetDetail> {
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
      'set_task_type_id',
      { summary: dto.name, description: dto.description ?? undefined },
    );

    const set = await completeNewTicket(deps, user, ticket.id, async () => {
      // The ticket listener made the set; a folder is the only field a ticket does not hold.
      const created = await loadNewRecord<{ id: string }>(
        this.client,
        this.logger,
        'test_sets',
        user.organizationId,
        ticket.id,
      );

      if (dto.folder_id) {
        const { error } = await this.client
          .from('test_sets')
          .update({ folder_id: dto.folder_id, updated_by: user.userId })
          .eq('id', created.id)
          .eq('organization_id', user.organizationId);

        if (error) throw tmDbError(this.logger, 'create test set', error);
      }

      return this.load(user.organizationId, spaceId, created.id);
    });

    void this.auditLogs.logActionForRequest(
      user,
      'test_set',
      set.id,
      'create',
      {
        key: set.key,
        name: set.name,
        space_id: spaceId,
      },
    );

    return set;
  }

  async update(
    user: RequestUser,
    spaceId: string,
    setId: string,
    dto: UpdateTestSetDto,
  ): Promise<TestSetDetail> {
    const changes: Record<string, unknown> = {};

    if (dto.name !== undefined) changes.name = dto.name;
    if (dto.description !== undefined) changes.description = dto.description;
    if (dto.folder_id !== undefined) changes.folder_id = dto.folder_id;

    if (Object.keys(changes).length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Provide a name, a description or a folder to update',
      });
    }

    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // The is_archived filter makes the archived check and the write one statement.
    const { data, error } = await this.client
      .from('test_sets')
      .update({
        ...(dto.folder_id !== undefined ? { folder_id: dto.folder_id } : {}),
        updated_by: user.userId,
      })
      .eq('id', setId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('is_archived', false)
      .select(`${DETAIL_COLUMNS}, ${MEMBER_COUNT}`)
      .maybeSingle();

    // Only the folder link can be missing on an update, so the folder is gone.
    if (error?.code === '23503' && dto.folder_id) {
      throw notFound({ folder_id: dto.folder_id });
    }

    if (error) throw tmDbError(this.logger, 'update test set', error);

    if (!data) {
      await this.load(user.organizationId, spaceId, setId, 'id');

      throw archivedError();
    }

    const saved = data as unknown as WithCountRow<TestSetDetail> & {
      task_id: string;
    };
    const current = withTicket(withCount<TestSetDetail>(saved));
    const ticketChanges: TestTicketFieldChanges = {};

    if (dto.name !== undefined && dto.name.trim() !== current.name) {
      ticketChanges.summary = dto.name;
    }

    if (
      dto.description !== undefined &&
      ticketRichText(dto.description) !== current.description
    ) {
      ticketChanges.description = dto.description;
    }

    const ticketChanged = Object.keys(ticketChanges).length > 0;

    if (ticketChanged) {
      if (!this.events) throw new Error('Ticket updates are not available');

      await this.events.emitAsync(TEST_RECORD_UPDATED_EVENT, {
        organizationId: user.organizationId,
        taskId: saved.task_id,
        userId: user.userId,
        changes: ticketChanges,
      } satisfies TestRecordUpdatedEvent);
    }

    // Logged only after the ticket took the change, so a refusal leaves no entry.
    void this.auditLogs.logActionForRequest(user, 'test_set', setId, 'update', {
      space_id: spaceId,
      changes,
    });

    return ticketChanged
      ? this.load(user.organizationId, spaceId, setId)
      : current;
  }

  /** Archiving an archived set (or restoring an active one) returns it unchanged. */
  async setArchived(
    user: RequestUser,
    spaceId: string,
    setId: string,
    archived: boolean,
  ): Promise<TestSetDetail> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const { data, error } = await this.client
      .from('test_sets')
      .update({
        is_archived: archived,
        archived_at: archived ? new Date().toISOString() : null,
        archived_by: archived ? user.userId : null,
        updated_by: user.userId,
      })
      .eq('id', setId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('is_archived', !archived)
      .select(`${DETAIL_COLUMNS}, ${MEMBER_COUNT}`)
      .maybeSingle();

    if (error) {
      throw tmDbError(
        this.logger,
        archived ? 'archive test set' : 'restore test set',
        error,
      );
    }

    if (!data) return this.load(user.organizationId, spaceId, setId);

    void this.auditLogs.logActionForRequest(
      user,
      'test_set',
      setId,
      archived ? 'archive' : 'restore',
      { space_id: spaceId },
    );

    return withTicket(
      withCount(data as unknown as WithCountRow<TestSetDetail>),
    );
  }

  /** Archives or restores the selected sets through setArchived(), so each keeps its own audit entry. */
  async bulkArchive(
    user: RequestUser,
    spaceId: string,
    dto: BulkArchiveTestSetsDto,
  ): Promise<TestRecordBulkArchiveResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const archived = dto.action === 'archive';

    return bulkSetArchived({
      client: this.client,
      logger: this.logger,
      table: 'test_sets',
      organizationId: user.organizationId,
      spaceId,
      ids: dto.set_ids,
      archived,
      setArchived: (id) => this.setArchived(user, spaceId, id, archived),
    });
  }

  /** Memberships cascade with the set; the ticket delete removes both. */
  async remove(user: RequestUser, spaceId: string, setId: string) {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const linked = await this.client
      .from('test_sets')
      .select(`task_id, ${ticketEmbed('test_sets', 'key, summary')}`)
      .eq('id', setId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (linked.error) {
      throw tmDbError(this.logger, 'load test set', linked.error);
    }

    if (!linked.data) throw notFound();

    const { task_id: taskId, task } = linked.data as unknown as {
      task_id: string;
      task: SetTicket;
    };

    if (!this.events) throw new Error('Ticket deletes are not available');

    // The ticket delete checks the task delete right; the database removes the set with it.
    await this.events.emitAsync(TEST_RECORD_DELETED_EVENT, {
      organizationId: user.organizationId,
      taskId,
      userId: user.userId,
    } satisfies TestRecordDeletedEvent);

    void this.auditLogs.logActionForRequest(user, 'test_set', setId, 'delete', {
      space_id: spaceId,
      key: task.key,
      name: ticketName(task.summary),
    });
  }

  /** Deletes up to 100 sets one by one through remove(), so each keeps its own ticket delete and audit entry. */
  async bulkRemove(
    user: RequestUser,
    spaceId: string,
    dto: BulkDeleteTestSetsDto,
  ): Promise<TestSetBulkDeleteResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // Only this space's sets get a key; any other id is reported as not found.
    const { data, error } = await this.client
      .from('test_sets')
      .select(`id, ${ticketEmbed('test_sets', 'key')}`)
      .in('id', dto.set_ids)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId);

    if (error) throw tmDbError(this.logger, 'load test sets to delete', error);

    const keys = new Map(
      ((data ?? []) as unknown as { id: string; task: { key: string } }[]).map(
        (row) => [row.id, row.task.key],
      ),
    );
    const result: TestSetBulkDeleteResult = {
      changed: false,
      deleted: [],
      skipped: [],
    };
    const skip = (setId: string, reason: 'not_found' | 'failed') =>
      result.skipped.push({
        set_id: setId,
        key: keys.get(setId) ?? '',
        reason: keys.has(setId) ? reason : 'not_found',
      });

    for (const [index, setId] of dto.set_ids.entries()) {
      if (!keys.has(setId)) {
        skip(setId, 'not_found');
        continue;
      }

      try {
        await this.remove(user, spaceId, setId);
        result.deleted.push({ set_id: setId, key: keys.get(setId) ?? '' });
      } catch (caught) {
        // Without the right to delete tickets every remaining set would fail the same way.
        if (caught instanceof ForbiddenException) {
          dto.set_ids.slice(index).forEach((id) => skip(id, 'failed'));
          break;
        }

        if (caught instanceof NotFoundException) {
          skip(setId, 'not_found');
          continue;
        }

        this.logger.warn(
          `Bulk delete of test set ${setId} failed: ${(caught as Error).message}`,
        );
        skip(setId, 'failed');
      }
    }

    result.changed = result.deleted.length > 0;

    return result;
  }

  async members(
    organizationId: string,
    spaceId: string,
    setId: string,
    query: TestSetMembersQueryDto,
  ): Promise<TestSetPage<TestSetMember>> {
    await this.access.assertAvailable(organizationId, spaceId);

    // Proves the set belongs to this space before listing its cases.
    await this.load(organizationId, spaceId, setId, 'id');

    const [field, direction] = (query.sort ?? '').split(':');
    const column = MEMBER_SORT_COLUMNS.get(field) ?? 'created_at';
    const ascending = direction !== 'desc';

    const cases = (columns: string, head = false) => {
      let builder = this.client
        .from('test_cases')
        .select(`${columns}, test_set_members!inner(set_id)`, {
          count: 'exact',
          head,
        })
        .eq('test_set_members.set_id', setId)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId);

      if (query.readiness?.length)
        builder = builder.in('readiness', query.readiness);
      if (query.testType) builder = builder.eq('test_type', query.testType);
      if (query.assignee === 'unassigned') {
        builder = builder.is('task.assigned_to', null);
      } else if (query.assignee) {
        builder = builder.eq('task.assigned_to', query.assignee);
      }
      if (query.q) {
        builder = builder.or(ticketSearchFilter(containsPattern(query.q)), {
          referencedTable: 'task',
        });
      }

      return builder;
    };

    // The count joins the ticket only when a filter reads from it.
    const filtersTicket = Boolean(query.q || query.assignee);

    const result = await this.fetchPage<
      Omit<TestSetMember, 'key' | 'task_key' | 'title' | 'assignee'> & {
        task: {
          key: string;
          summary: string;
          assignee?: TestSetMember['assignee'];
        };
      }
    >(
      'list test set cases',
      query,
      (from, to) =>
        cases(MEMBER_COLUMNS)
          .order(column, { ascending })
          .order('id', { ascending: true })
          .range(from, to),
      () =>
        cases(
          filtersTicket
            ? `id, ${ticketEmbed('test_cases', 'key, assigned_to')}`
            : 'id',
          true,
        ),
    );

    // Picks the case fields so the join column stays out of the response.
    return {
      ...result,
      items: result.items.map(
        ({ id, readiness, test_type, is_archived, task }) => ({
          id,
          key: task.key,
          task_key: task.key,
          title: ticketName(task.summary),
          readiness,
          test_type,
          is_archived,
          assignee: task.assignee ?? null,
        }),
      ),
    };
  }

  /** Ids of every case in the set (at most the member limit), so a picker can mark them as already added. */
  async memberIds(
    organizationId: string,
    spaceId: string,
    setId: string,
  ): Promise<string[]> {
    await this.access.assertAvailable(organizationId, spaceId);
    await this.load(organizationId, spaceId, setId, 'id');

    const { data, error } = await this.client
      .from('test_set_members')
      .select('case_id')
      .eq('set_id', setId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .limit(TEST_SET_LIMITS.members);

    if (error) throw tmDbError(this.logger, 'list test set case ids', error);

    return ((data ?? []) as { case_id: string }[]).map((row) => row.case_id);
  }

  async changeMembers(
    user: RequestUser,
    spaceId: string,
    setId: string,
    caseIds: string[],
    mode: 'add' | 'remove',
  ): Promise<TestSetMembersChange> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const { data, error } = (await this.client.rpc('tm_change_set_members', {
      p_organization_id: user.organizationId,
      p_space_id: spaceId,
      p_actor_id: user.userId,
      p_set_id: setId,
      p_add_ids: mode === 'add' ? caseIds : [],
      p_remove_ids: mode === 'remove' ? caseIds : [],
    })) as { data: TestSetMembersChange; error: TmRpcError | null };

    if (error) {
      throw tmRpcError(
        this.logger,
        mode === 'add' ? 'add cases to test set' : 'remove cases from test set',
        error,
      );
    }

    if (data.changed) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_set',
        setId,
        'update',
        { space_id: spaceId, added: data.added, removed: data.removed },
      );
    }

    return data;
  }

  /** A page past the end is answered with 416, whose PGRST103 body some gateways cut off; it comes back as an empty page with the real total. */
  private async fetchPage<Row>(
    action: string,
    query: TestSetPageQueryDto,
    rows: (from: number, to: number) => PromiseLike<PageResponse>,
    total: () => PromiseLike<PageResponse>,
  ): Promise<TestSetPage<Row>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const from = (page - 1) * pageSize;

    const { data, error, count, status } = await rows(
      from,
      from + pageSize - 1,
    );

    if (error?.code === 'PGRST103' || status === 416) {
      const { count: all, error: countError } = await total();

      if (countError) throw tmDbError(this.logger, action, countError);

      return { items: [], total: all ?? 0, page, pageSize };
    }

    if (error) throw tmDbError(this.logger, action, error);

    return { items: (data ?? []) as Row[], total: count ?? 0, page, pageSize };
  }

  private async load(
    organizationId: string,
    spaceId: string,
    setId: string,
    columns = `${DETAIL_COLUMNS}, ${MEMBER_COUNT}`,
  ): Promise<TestSetDetail> {
    const { data, error } = await this.client
      .from('test_sets')
      .select(columns)
      .eq('id', setId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load test set', error);
    if (!data) throw notFound();

    return withTicket(
      withCount(data as unknown as WithCountRow<TestSetDetail>),
    );
  }
}
