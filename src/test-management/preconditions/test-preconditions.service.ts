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
import {
  TEST_RECORD_DELETED_EVENT,
  TEST_RECORD_UPDATED_EVENT,
  type TestRecordDeletedEvent,
  type TestRecordUpdatedEvent,
} from '../../tasks/test-ticket-events';
import { TestManagementAccessService } from '../access/test-management-access.service';
import { containsPattern } from '../cases/test-cases.service';
import { bulkSetArchived } from '../common/bulk-archive';
import { assertKnownTestType } from '../common/test-task-types';
import {
  ticketEmbed,
  ticketName,
  ticketSearchFilter,
} from '../common/ticket-keys';
import type {
  BulkArchiveTestPreconditionsDto,
  BulkDeleteTestPreconditionsDto,
  ChangePreconditionCasesDto,
  CreateTestPreconditionDto,
  ListTestPreconditionsQueryDto,
  PreconditionCase,
  PreconditionCasesChange,
  PreconditionCasesPage,
  PreconditionCasesQueryDto,
  SetCasePreconditionsDto,
  TestPrecondition,
  TestPreconditionAssignee,
  TestPreconditionBulkDeleteResult,
  TestPreconditionPage,
  TestPreconditionTicketStatus,
  UpdateTestPreconditionDto,
} from '../dto/test-precondition.dto';
import type { TestRecordBulkArchiveResult } from '../dto/test-set.dto';
import {
  notFound,
  tmDbError,
  tmRpcError,
  type TmRpcError,
} from '../test-management-errors';

const TABLE = 'test_preconditions';

const COLUMNS =
  'id, key, key_number, title, test_type, definition, is_archived, archived_at, created_by, updated_by, created_at, updated_at, task:tasks!test_preconditions_task_id_fkey(id, key, status:task_statuses!tasks_status_id_fkey(id, name, color, icon, is_completed), assignee:users!tasks_assigned_to_fkey(id, first_name, last_name, email, avatar_url))';

// The found ids go into the next request's URL, so their number is capped.
const TICKET_SEARCH_LIMIT = 150;

// Keys sort by number so PC2 comes before PC10.
const SORT_COLUMNS = new Map<string, string>([
  ['key', 'key_number'],
  ['title', 'title'],
  ['updated_at', 'updated_at'],
]);

interface LinkedCase {
  id: string;
  test_type: string;
  is_archived: boolean;
  precondition_ids: string[];
  revision: number;
}

// Read apart from the response columns so the precondition shape stays the same.
interface EditableFields {
  title: string;
  definition: string | null;
  test_type: string;
  task_id: string | null;
  is_archived: boolean;
}

// The ticket's fields are returned flat, so the screens can show them directly.
function withTicket<T extends object>(row: T): T {
  if (!('task' in row)) return row;

  const { task, ...rest } = row as T & {
    task: {
      id: string;
      key: string;
      status:
        | (Omit<TestPreconditionTicketStatus, 'is_completed'> & {
            is_completed: boolean | null;
          })
        | null;
      assignee: TestPreconditionAssignee | null;
    } | null;
  };

  return {
    ...rest,
    task_id: task?.id ?? null,
    task_key: task?.key ?? null,
    task_status: task?.status
      ? { ...task.status, is_completed: task.status.is_completed === true }
      : null,
    task_assignee: task?.assignee ?? null,
  } as unknown as T;
}

function caseArchivedError(): ConflictException {
  return new ConflictException({
    code: 'ARCHIVED',
    message: 'The test case is archived. Restore it first.',
  });
}

function archivedError(): ConflictException {
  return new ConflictException({
    code: 'ARCHIVED',
    message: 'The precondition is archived. Restore it first.',
  });
}

// data.tests lets the screen offer "Remove from N tests and continue".
function inUseError(tests: number): ConflictException {
  return new ConflictException({
    code: 'IN_USE',
    message: `${tests} test case${tests === 1 ? ' uses' : 's use'} this precondition. Remove it from them first.`,
    data: { tests },
  });
}

const CASE_COLUMNS = `id, test_type, readiness, is_archived, ${ticketEmbed('test_cases')}`;

// Fixed columns for the cases of a precondition; key follows creation order.
const CASE_SORT_COLUMNS = new Map<string, string>([
  ['key', 'created_at'],
  ['title', 'task(summary)'],
  ['test_type', 'test_type'],
  ['readiness', 'readiness'],
]);

// PostgREST answers at most 1000 rows per request.
const READ_PAGE = 1000;

// Audit entries keep the first ids only; the count is always exact.
const AUDIT_IDS = 100;

const auditIds = (ids: string[]) => ({
  count: ids.length,
  case_ids: ids.slice(0, AUDIT_IDS),
});

type LinkArgs = Partial<{
  p_add: string[];
  p_remove: string[];
  p_remove_all: boolean;
  p_delete: boolean;
  p_test_type: string;
}>;

/** Reusable setup steps of a space, kept apart from the test cases that use them. */
@Injectable()
export class TestPreconditionsService {
  private readonly logger = new Logger(TestPreconditionsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly auditLogs: AuditLogsService,
    @Optional() private readonly events?: EventEmitter2,
    @Optional() private readonly permissions?: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async list(
    organizationId: string,
    spaceId: string,
    query: ListTestPreconditionsQueryDto,
  ): Promise<TestPreconditionPage> {
    await this.access.assertAvailable(organizationId, spaceId);

    const search = query.q ? containsPattern(query.q) : null;
    const caseIds = query.caseId
      ? (await this.loadCase(organizationId, spaceId, query.caseId))
          .precondition_ids
      : null;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;

    if (caseIds?.length === 0) return { items: [], total: 0, page, pageSize };

    const ticketMatches = search
      ? await this.idsByTicketKey(organizationId, spaceId, search)
      : [];

    const rows = (columns: string, head = false) => {
      let builder = this.client
        .from(TABLE)
        .select(columns, { count: 'exact', head })
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId);

      // A case's list includes archived preconditions, so saving it never drops them silently.
      // A ticket also finds its record when that is archived.
      if (!caseIds && !query.taskId)
        builder = builder.eq('is_archived', query.archived === true);

      if (search) {
        builder = builder.or(
          [
            `key.ilike.${search}`,
            `title.ilike.${search}`,
            ...(ticketMatches.length
              ? [`id.in.(${ticketMatches.join(',')})`]
              : []),
          ].join(','),
        );
      }

      if (query.taskId) builder = builder.eq('task_id', query.taskId);
      if (query.testType) builder = builder.eq('test_type', query.testType);
      if (caseIds) builder = builder.in('id', caseIds);

      return builder;
    };

    const [field, direction] = (query.sort ?? '').split(':');
    const column = SORT_COLUMNS.get(field) ?? 'key_number';
    const ascending = SORT_COLUMNS.has(field) ? direction !== 'desc' : true;
    const from = (page - 1) * pageSize;

    let builder = rows(COLUMNS).order(column, { ascending });

    // Equal titles or times keep a stable order across pages.
    if (column !== 'key_number') {
      builder = builder.order('key_number', { ascending: true });
    }

    const { data, error, count, status } = await builder.range(
      from,
      from + pageSize - 1,
    );

    // A page past the end is answered with 416, whose PGRST103 body some gateways cut off; it comes back empty with the real total.
    if (error?.code === 'PGRST103' || status === 416) {
      const { count: all, error: countError } = await rows('id', true);

      if (countError)
        throw tmDbError(this.logger, 'list preconditions', countError);

      return { items: [], total: all ?? 0, page, pageSize };
    }

    if (error) throw tmDbError(this.logger, 'list preconditions', error);

    const items = ((data ?? []) as unknown as TestPrecondition[]).map(
      withTicket,
    );

    return {
      items: query.withTests
        ? await this.withTestsCount(organizationId, spaceId, items)
        : items,
      total: count ?? 0,
      page,
      pageSize,
    };
  }

  async get(
    organizationId: string,
    spaceId: string,
    preconditionId: string,
  ): Promise<TestPrecondition> {
    await this.access.assertAvailable(organizationId, spaceId);

    return this.load(organizationId, spaceId, preconditionId);
  }

  async create(
    user: RequestUser,
    spaceId: string,
    dto: CreateTestPreconditionDto,
  ): Promise<TestPrecondition> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    if (dto.test_type !== undefined) {
      await assertKnownTestType(
        this.client,
        this.logger,
        user.organizationId,
        spaceId,
        dto.test_type,
      );
    }

    // key and key_number are assigned by the insert trigger.
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: user.organizationId,
        space_id: spaceId,
        title: dto.title,
        ...(dto.test_type !== undefined && { test_type: dto.test_type }),
        definition: dto.definition ?? null,
        created_by: user.userId,
        updated_by: user.userId,
      })
      .select(COLUMNS)
      .single();

    if (error) throw tmDbError(this.logger, 'create precondition', error);

    const row = withTicket(data as unknown as TestPrecondition);

    void this.auditLogs.logActionForRequest(
      user,
      'test_precondition',
      row.id,
      'create',
      { key: row.key, title: row.title, space_id: spaceId },
    );

    return row;
  }

  async update(
    user: RequestUser,
    spaceId: string,
    preconditionId: string,
    dto: UpdateTestPreconditionDto,
    unlinkTests = false,
  ): Promise<TestPrecondition> {
    const changes: Record<string, unknown> = {};

    if (dto.title !== undefined) changes.title = dto.title;
    if (dto.test_type !== undefined) changes.test_type = dto.test_type;
    if (dto.definition !== undefined) changes.definition = dto.definition;

    if (Object.keys(changes).length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Provide a title, test type or definition to update',
      });
    }

    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // Linked test cases of another type would no longer match; they are taken off only when asked.
    let others: string[] = [];

    if (dto.test_type !== undefined) {
      await assertKnownTestType(
        this.client,
        this.logger,
        user.organizationId,
        spaceId,
        dto.test_type,
      );

      others = await this.linkedCaseIds(
        user.organizationId,
        spaceId,
        preconditionId,
        dto.test_type,
      );

      if (others.length > 0 && !unlinkTests) throw inUseError(others.length);
    }

    // Old values and ticket, so a ticket that cannot take the new title gets the record put back.
    const previous = (await this.load(
      user.organizationId,
      spaceId,
      preconditionId,
      'title, definition, test_type, task_id, is_archived',
    )) as unknown as EditableFields;
    const rename =
      this.events &&
      previous.task_id &&
      dto.title !== undefined &&
      dto.title !== previous.title
        ? { taskId: previous.task_id, title: dto.title }
        : null;

    let unlinked: PreconditionCasesChange | null = null;
    let saved: TestPrecondition;

    if (others.length > 0) {
      // The unlink and type change cannot be undone, so the record and its ticket must accept the rest first.
      if (previous.is_archived) throw archivedError();

      if (rename) await this.renameTicket(user, rename.taskId, rename.title);

      try {
        unlinked = await this.applyLinks(user, spaceId, preconditionId, {
          p_remove: others,
          p_test_type: dto.test_type,
        });
        saved = await this.writeChanges(user, spaceId, preconditionId, changes);
      } catch (error) {
        if (rename) {
          try {
            await this.renameTicket(user, rename.taskId, previous.title);
          } catch (undoError) {
            this.logger.error(
              `The ticket of precondition ${preconditionId} kept its new title after the update failed: ${undoError instanceof Error ? undoError.message : String(undoError)}`,
            );
          }

          await this.putBack(user, spaceId, preconditionId, {
            title: previous.title,
          });
        }

        throw error;
      }
    } else {
      saved = await this.writeChanges(user, spaceId, preconditionId, changes);

      if (rename) {
        try {
          await this.renameTicket(user, rename.taskId, rename.title);
        } catch (error) {
          await this.putBack(user, spaceId, preconditionId, {
            title: previous.title,
            definition: previous.definition,
            test_type: previous.test_type,
          });

          throw error;
        }
      }
    }

    void this.auditLogs.logActionForRequest(
      user,
      'test_precondition',
      preconditionId,
      'update',
      {
        space_id: spaceId,
        changes,
        ...(unlinked ? { unlinked: auditIds(unlinked.removed) } : {}),
      },
    );

    return saved;
  }

  private async writeChanges(
    user: RequestUser,
    spaceId: string,
    preconditionId: string,
    changes: Record<string, unknown>,
  ): Promise<TestPrecondition> {
    // The is_archived filter makes the archived check and the write one statement.
    const { data, error } = await this.client
      .from(TABLE)
      .update({ ...changes, updated_by: user.userId })
      .eq('id', preconditionId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('is_archived', false)
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'update precondition', error);

    if (!data) {
      await this.load(user.organizationId, spaceId, preconditionId, 'id');

      throw archivedError();
    }

    return withTicket(data as unknown as TestPrecondition);
  }

  // Only the title is shared with the ticket; a refusal reaches the caller.
  private async renameTicket(
    user: RequestUser,
    taskId: string,
    summary: string,
  ): Promise<void> {
    await this.events?.emitAsync(TEST_RECORD_UPDATED_EVENT, {
      organizationId: user.organizationId,
      taskId,
      userId: user.userId,
      changes: { summary },
    } satisfies TestRecordUpdatedEvent);
  }

  private async putBack(
    user: RequestUser,
    spaceId: string,
    preconditionId: string,
    fields: Partial<EditableFields>,
  ): Promise<void> {
    const { error } = await this.client
      .from(TABLE)
      .update({ ...fields, updated_by: user.userId })
      .eq('id', preconditionId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId);

    if (error) {
      this.logger.error(
        `Precondition ${preconditionId} could not be put back after its ticket failed to update: ${error.message}`,
      );
    }
  }

  /** Archiving an archived precondition (or restoring an active one) returns it unchanged. */
  async setArchived(
    user: RequestUser,
    spaceId: string,
    preconditionId: string,
    archived: boolean,
  ): Promise<TestPrecondition> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const { data, error } = await this.client
      .from(TABLE)
      .update({
        is_archived: archived,
        archived_at: archived ? new Date().toISOString() : null,
        archived_by: archived ? user.userId : null,
        updated_by: user.userId,
      })
      .eq('id', preconditionId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('is_archived', !archived)
      .select(COLUMNS)
      .maybeSingle();

    if (error) {
      throw tmDbError(
        this.logger,
        archived ? 'archive precondition' : 'restore precondition',
        error,
      );
    }

    if (!data) return this.load(user.organizationId, spaceId, preconditionId);

    void this.auditLogs.logActionForRequest(
      user,
      'test_precondition',
      preconditionId,
      archived ? 'archive' : 'restore',
      { space_id: spaceId },
    );

    return withTicket(data as unknown as TestPrecondition);
  }

  /**
   * Test cases that use the precondition make it a 409 IN_USE unless they are taken off first (needs edit_tests too).
   * Its ticket goes first, so a ticket that refuses leaves everything as it was.
   */
  async remove(
    user: RequestUser,
    spaceId: string,
    preconditionId: string,
    unlinkTests = false,
  ): Promise<void> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const linked = await this.linkedCaseIds(
      user.organizationId,
      spaceId,
      preconditionId,
    );

    if (linked.length > 0 && !unlinkTests) throw inUseError(linked.length);

    if (linked.length > 0 && !(await this.can(user, spaceId, 'edit_tests'))) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You cannot change the test cases that use this precondition',
      });
    }

    // Read first: the ticket link is cleared once the ticket goes.
    const row = (await this.load(
      user.organizationId,
      spaceId,
      preconditionId,
      'id, key, title, task_id',
    )) as unknown as {
      id: string;
      key: string;
      title: string;
      task_id: string | null;
    };

    // The ticket delete checks the task delete right; the database archives the record with it.
    if (row.task_id && this.events) {
      await this.events.emitAsync(TEST_RECORD_DELETED_EVENT, {
        organizationId: user.organizationId,
        taskId: row.task_id,
        userId: user.userId,
      } satisfies TestRecordDeletedEvent);
    }

    let unlinked: PreconditionCasesChange | null = null;

    if (linked.length > 0) {
      try {
        unlinked = await this.applyLinks(user, spaceId, preconditionId, {
          p_remove_all: true,
          p_delete: true,
        });
      } catch (error) {
        // Already removed by someone else after it was read above.
        if (!(error instanceof NotFoundException)) throw error;
      }
    } else {
      // No rows deleted means the same: it existed when read above.
      const { error } = await this.client
        .from(TABLE)
        .delete()
        .eq('id', preconditionId)
        .eq('space_id', spaceId)
        .eq('organization_id', user.organizationId);

      if (error?.code === '23503') {
        throw new ConflictException({
          code: 'IN_USE',
          message: 'The precondition is still in use and cannot be deleted',
        });
      }

      if (error) throw tmDbError(this.logger, 'delete precondition', error);
    }

    void this.auditLogs.logActionForRequest(
      user,
      'test_precondition',
      preconditionId,
      'delete',
      {
        space_id: spaceId,
        key: row.key,
        title: row.title,
        ...(row.task_id ? { task_id: row.task_id } : {}),
        ...(unlinked ? { unlinked: auditIds(unlinked.removed) } : {}),
      },
    );
  }

  /** Archives or restores the selected preconditions through setArchived(), so each keeps its own audit entry. */
  async bulkArchive(
    user: RequestUser,
    spaceId: string,
    dto: BulkArchiveTestPreconditionsDto,
  ): Promise<TestRecordBulkArchiveResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const archived = dto.action === 'archive';

    return bulkSetArchived({
      client: this.client,
      logger: this.logger,
      table: TABLE,
      organizationId: user.organizationId,
      spaceId,
      ids: dto.precondition_ids,
      archived,
      setArchived: (id) => this.setArchived(user, spaceId, id, archived),
    });
  }

  /**
   * Deletes the selected preconditions one at a time through remove(). Ones that test cases use are skipped with
   * their test count unless unlink_tests is set, so the screen can ask before taking them off those tests.
   */
  async bulkRemove(
    user: RequestUser,
    spaceId: string,
    dto: BulkDeleteTestPreconditionsDto,
  ): Promise<TestPreconditionBulkDeleteResult> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // Only this space's preconditions get a key; the ticket key is shown when there is a ticket.
    const { data, error } = await this.client
      .from(TABLE)
      .select('id, key, task:tasks!test_preconditions_task_id_fkey(key)')
      .in('id', dto.precondition_ids)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId);

    if (error) {
      throw tmDbError(this.logger, 'load preconditions to delete', error);
    }

    const keys = new Map(
      (
        (data ?? []) as unknown as {
          id: string;
          key: string;
          task: { key: string } | null;
        }[]
      ).map((row) => [row.id, row.task?.key ?? row.key]),
    );
    const result: TestPreconditionBulkDeleteResult = {
      changed: false,
      deleted: [],
      skipped: [],
    };
    const skip = (
      preconditionId: string,
      reason: TestPreconditionBulkDeleteResult['skipped'][number]['reason'],
      tests?: number,
    ) =>
      result.skipped.push({
        precondition_id: preconditionId,
        key: keys.get(preconditionId) ?? '',
        reason: keys.has(preconditionId) ? reason : 'not_found',
        ...(tests !== undefined && { tests }),
      });

    for (const [index, preconditionId] of dto.precondition_ids.entries()) {
      if (!keys.has(preconditionId)) {
        skip(preconditionId, 'not_found');
        continue;
      }

      try {
        await this.remove(
          user,
          spaceId,
          preconditionId,
          dto.unlink_tests === true,
        );
        result.deleted.push({
          precondition_id: preconditionId,
          key: keys.get(preconditionId) ?? '',
        });
      } catch (caught) {
        // Without the right to delete tickets or change tests every remaining one would fail the same way.
        if (caught instanceof ForbiddenException) {
          dto.precondition_ids.slice(index).forEach((id) => skip(id, 'failed'));
          break;
        }

        if (caught instanceof NotFoundException) {
          skip(preconditionId, 'not_found');
          continue;
        }

        const response =
          caught instanceof HttpException ? caught.getResponse() : undefined;
        const body =
          typeof response === 'object'
            ? (response as { code?: string; data?: { tests?: number } })
            : undefined;

        if (body?.code === 'IN_USE') {
          skip(preconditionId, 'in_use', body.data?.tests);
          continue;
        }

        this.logger.warn(
          `Bulk delete of precondition ${preconditionId} failed: ${(caught as Error).message}`,
        );
        skip(preconditionId, 'failed');
      }
    }

    result.changed = result.deleted.length > 0;

    return result;
  }

  /** The test cases that use a precondition, archived ones included (they can still be taken off). */
  async listCases(
    organizationId: string,
    spaceId: string,
    preconditionId: string,
    query: PreconditionCasesQueryDto,
  ): Promise<PreconditionCasesPage> {
    await this.access.assertAvailable(organizationId, spaceId);
    await this.load(organizationId, spaceId, preconditionId, 'id');

    const search = query.q ? containsPattern(query.q) : null;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;

    const rows = (columns: string, head = false) => {
      let builder = this.client
        .from('test_cases')
        .select(columns, { count: 'exact', head })
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .contains('precondition_ids', [preconditionId]);

      if (search) {
        builder = builder.or(ticketSearchFilter(search), {
          referencedTable: 'task',
        });
      }
      if (query.readiness?.length)
        builder = builder.in('readiness', query.readiness);
      if (query.testType) builder = builder.eq('test_type', query.testType);

      return builder;
    };

    const [field, direction] = (query.sort ?? '').split(':');
    const column = CASE_SORT_COLUMNS.get(field) ?? 'created_at';
    const from = (page - 1) * pageSize;
    const { data, error, count, status } = await rows(CASE_COLUMNS)
      .order(column, { ascending: direction !== 'desc' })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error?.code === 'PGRST103' || status === 416) {
      const { count: all, error: countError } = await rows(
        `id, ${ticketEmbed('test_cases', 'key')}`,
        true,
      );

      if (countError)
        throw tmDbError(this.logger, 'list precondition cases', countError);

      return { items: [], total: all ?? 0, page, pageSize };
    }

    if (error) throw tmDbError(this.logger, 'list precondition cases', error);

    const items = (
      (data ?? []) as unknown as (Omit<
        PreconditionCase,
        'key' | 'task_key' | 'title'
      > & {
        task: { key: string; summary: string };
      })[]
    ).map(({ task, ...row }) => ({
      ...row,
      key: task.key,
      task_key: task.key,
      title: ticketName(task.summary),
    }));

    return { items, total: count ?? 0, page, pageSize };
  }

  /** Ids of every test case that uses the precondition, so a picker can mark them. */
  async caseIds(
    organizationId: string,
    spaceId: string,
    preconditionId: string,
  ): Promise<string[]> {
    await this.access.assertAvailable(organizationId, spaceId);
    await this.load(organizationId, spaceId, preconditionId, 'id');

    return this.linkedCaseIds(organizationId, spaceId, preconditionId);
  }

  /** Adds the precondition to test cases and takes it off others, in one database call. */
  async changeCases(
    user: RequestUser,
    spaceId: string,
    preconditionId: string,
    dto: ChangePreconditionCasesDto,
  ): Promise<PreconditionCasesChange> {
    const add = dto.add ?? [];
    const remove = dto.remove ?? [];

    if (add.length === 0 && remove.length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Provide test cases to add or remove',
      });
    }

    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const result = await this.applyLinks(user, spaceId, preconditionId, {
      p_add: add,
      p_remove: remove,
    });

    if (result.added.length > 0 || result.removed.length > 0) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_precondition',
        preconditionId,
        'update',
        {
          space_id: spaceId,
          cases_added: auditIds(result.added),
          cases_removed: auditIds(result.removed),
        },
      );
    }

    return result;
  }

  /** Replaces the preconditions a test case needs; each must be active and of the case's test type. */
  async setCasePreconditions(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    dto: SetCasePreconditionsDto,
  ): Promise<TestPrecondition[]> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const testCase = await this.loadCase(user.organizationId, spaceId, caseId);

    if (testCase.is_archived) throw caseArchivedError();

    const ids = dto.precondition_ids;
    let linked: TestPrecondition[] = [];

    if (ids.length > 0) {
      const { data, error } = await this.client
        .from(TABLE)
        .select(COLUMNS)
        .eq('space_id', spaceId)
        .eq('organization_id', user.organizationId)
        .in('id', ids);

      if (error) throw tmDbError(this.logger, 'load preconditions', error);

      const found = new Map(
        ((data ?? []) as unknown as TestPrecondition[]).map((row) => [
          row.id,
          withTicket(row),
        ]),
      );

      if (found.size !== ids.length) throw notFound();

      linked = ids.map((id) => found.get(id) as TestPrecondition);

      // Preconditions already linked may stay after being archived; new ones must be active.
      const kept = new Set(testCase.precondition_ids);

      if (linked.some((row) => row.is_archived && !kept.has(row.id))) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'An archived precondition cannot be added',
          field: 'precondition_ids',
        });
      }

      // As in Xray, a test only uses preconditions of its own test type.
      // Ones linked before a type change may stay, like archived ones.
      if (
        linked.some(
          (row) => row.test_type !== testCase.test_type && !kept.has(row.id),
        )
      ) {
        throw new BadRequestException({
          code: 'TYPE_MISMATCH',
          message:
            'Each precondition must have the same test type as the test case',
          field: 'precondition_ids',
        });
      }
    }

    const { data: saved, error: saveError } = await this.client
      .from('test_cases')
      .update({ precondition_ids: ids, updated_by: user.userId })
      .eq('id', caseId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .eq('is_archived', false)
      .select('id')
      .maybeSingle();

    if (saveError) {
      throw tmDbError(this.logger, 'save case preconditions', saveError);
    }

    if (!saved) throw caseArchivedError();

    // Linked preconditions are part of the case's history; a failed entry never undoes the save.
    await this.recordPreconditionHistory(user, spaceId, testCase, ids, linked);

    void this.auditLogs.logActionForRequest(
      user,
      'test_case',
      caseId,
      'update',
      { space_id: spaceId, changes: { precondition_ids: ids } },
    );

    return linked;
  }

  private async recordPreconditionHistory(
    user: RequestUser,
    spaceId: string,
    testCase: LinkedCase,
    ids: string[],
    linked: TestPrecondition[],
  ): Promise<void> {
    const before = testCase.precondition_ids ?? [];

    // Only the order changed, so there is nothing to record.
    if (
      before.length === ids.length &&
      before.every((id) => ids.includes(id))
    ) {
      return;
    }

    try {
      const keys = new Map(linked.map((row) => [row.id, row.key]));
      const removed = before.filter((id) => !keys.has(id));

      if (removed.length > 0) {
        const { data, error } = await this.client
          .from(TABLE)
          .select('id, key')
          .eq('space_id', spaceId)
          .eq('organization_id', user.organizationId)
          .in('id', removed);

        if (error) throw error;

        for (const row of (data ?? []) as { id: string; key: string }[]) {
          keys.set(row.id, row.key);
        }
      }

      // A precondition deleted meanwhile has no key left, so it is left out.
      const label = (list: string[]) =>
        list
          .map((id) => keys.get(id))
          .filter(Boolean)
          .join(', ') || null;
      const from = label(before);
      const to = label(ids);

      if (from === to) return;

      const { error } = await this.client.from('test_case_history').insert({
        organization_id: user.organizationId,
        space_id: spaceId,
        case_id: testCase.id,
        revision: testCase.revision,
        change_kind: 'updated',
        changes: { precondition_ids: { from, to } },
        changed_by: user.userId,
      });

      if (error) throw error;
    } catch (error) {
      this.logger.warn(
        `Precondition history of case ${testCase.id} was not saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Ids of the test cases that use the precondition; with otherThanType, only those of another test type.
  private async linkedCaseIds(
    organizationId: string,
    spaceId: string,
    preconditionId: string,
    otherThanType?: string,
  ): Promise<string[]> {
    const ids: string[] = [];

    for (let from = 0; ; from += READ_PAGE) {
      let builder = this.client
        .from('test_cases')
        .select('id')
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .contains('precondition_ids', [preconditionId]);

      if (otherThanType !== undefined)
        builder = builder.neq('test_type', otherThanType);

      const { data, error } = await builder
        .order('id', { ascending: true })
        .range(from, from + READ_PAGE - 1);

      if (error) throw tmDbError(this.logger, 'read precondition cases', error);

      const page = (data ?? []) as { id: string }[];

      ids.push(...page.map((row) => row.id));

      if (page.length < READ_PAGE) return ids;
    }
  }

  // One database call, so the links and any type change or delete are saved together.
  private async applyLinks(
    user: RequestUser,
    spaceId: string,
    preconditionId: string,
    args: LinkArgs,
  ): Promise<PreconditionCasesChange> {
    const { data, error } = (await this.client.rpc('tm_precondition_cases', {
      p_organization_id: user.organizationId,
      p_space_id: spaceId,
      p_actor_id: user.userId,
      p_precondition_id: preconditionId,
      p_add: [],
      p_remove: [],
      p_remove_all: false,
      p_delete: false,
      p_test_type: null,
      ...args,
    })) as { data: PreconditionCasesChange | null; error: TmRpcError | null };

    if (error) {
      throw tmRpcError(this.logger, 'change precondition test cases', error);
    }

    return data ?? { added: [], removed: [], skipped: [], deleted: false };
  }

  // One read for the whole page; each test case adds 1 to every precondition of the page it uses.
  private async withTestsCount(
    organizationId: string,
    spaceId: string,
    items: TestPrecondition[],
  ): Promise<TestPrecondition[]> {
    if (items.length === 0) return items;

    const counts = new Map(items.map((item) => [item.id, 0]));
    const ids = [...counts.keys()];

    for (let from = 0; ; from += READ_PAGE) {
      const { data, error } = await this.client
        .from('test_cases')
        .select('precondition_ids')
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId)
        .overlaps('precondition_ids', ids)
        .order('id', { ascending: true })
        .range(from, from + READ_PAGE - 1);

      if (error)
        throw tmDbError(this.logger, 'count precondition tests', error);

      const page = (data ?? []) as { precondition_ids: string[] }[];

      for (const row of page) {
        for (const id of row.precondition_ids) {
          const current = counts.get(id);

          if (current !== undefined) counts.set(id, current + 1);
        }
      }

      if (page.length < READ_PAGE) break;
    }

    return items.map((item) => ({
      ...item,
      tests_count: counts.get(item.id) ?? 0,
    }));
  }

  private async can(
    user: RequestUser,
    spaceId: string,
    permission: string,
  ): Promise<boolean> {
    if (!this.permissions) return false;

    return this.permissions.hasSpacePermission(
      user.userId,
      user.organizationId,
      spaceId,
      permission,
    );
  }

  private async loadCase(
    organizationId: string,
    spaceId: string,
    caseId: string,
  ): Promise<LinkedCase> {
    const { data, error } = await this.client
      .from('test_cases')
      .select('id, test_type, is_archived, precondition_ids, revision')
      .eq('id', caseId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle<LinkedCase>();

    if (error) throw tmDbError(this.logger, 'load test case', error);
    if (!data) throw notFound();

    return data;
  }

  private async load(
    organizationId: string,
    spaceId: string,
    preconditionId: string,
    columns = COLUMNS,
  ): Promise<TestPrecondition> {
    const { data, error } = await this.client
      .from(TABLE)
      .select(columns)
      .eq('id', preconditionId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load precondition', error);
    if (!data) throw notFound();

    return withTicket(data as unknown as TestPrecondition);
  }

  private async idsByTicketKey(
    organizationId: string,
    spaceId: string,
    search: string,
  ): Promise<string[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('id, task:tasks!test_preconditions_task_id_fkey!inner(key)')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .or(`key.ilike.${search}`, { referencedTable: 'task' })
      .limit(TICKET_SEARCH_LIMIT);

    if (error) {
      throw tmDbError(this.logger, 'search precondition tickets', error);
    }

    return ((data ?? []) as unknown as { id: string }[]).map((row) => row.id);
  }
}
