import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TaskPickerItem } from '../../tasks/task-picker/task-picker.service';
import { TasksService } from '../../tasks/tasks.service';
import { ticketDateToPlanDay } from '../../tasks/test-ticket-events';
import { TestManagementAccessService } from '../access/test-management-access.service';
import {
  otherSpaceTicket,
  TaskVisibilityService,
} from '../common/task-visibility.service';
import { chunk, type UserNameRow } from '../common/tester-eligibility.service';
import {
  compareTicketKeys,
  ticketEmbed,
  ticketName,
} from '../common/ticket-keys';
import type {
  LinkedItemsQueryDto,
  LinkedItemsSortField,
} from '../dto/linked-items-query.dto';
import type { RequirementTicketSearchQueryDto } from '../dto/requirement-ticket-search.dto';
import type { TestCaseReadiness } from '../dto/test-case.dto';
import type {
  CaseRequirementsLinkResult,
  LinkRequirementsDto,
} from '../dto/test-coverage.dto';
import {
  TASK_LINK_KINDS,
  TEST_REQUIREMENT_LINK_LIMITS,
  type CaseLinkedTask,
  type LinkTaskItemsDto,
  type TaskItemSkipReason,
  type TaskItemsLinkResult,
  type TaskLinkKind,
  type TaskLinkType,
  type TaskLinkedItem,
} from '../dto/test-requirement-link.dto';
import { userRef } from '../executions/test-executions.service';
import { notFound, tmDbError } from '../test-management-errors';

const LINKS = 'test_ticket_links';

interface KindConfig {
  table: string;
  links: string;
  column: string;
  fields: string;
  auditEntity: string;
}

// All kinds share one link table; the column tells which item a row belongs to.
const KINDS: Record<TaskLinkKind, KindConfig> = {
  cases: {
    table: 'test_cases',
    links: LINKS,
    column: 'case_id',
    fields: `readiness, is_archived, ${ticketEmbed('test_cases')}`,
    auditEntity: 'test_case',
  },
  sets: {
    table: 'test_sets',
    links: LINKS,
    column: 'set_id',
    fields: `is_archived, ${ticketEmbed('test_sets')}`,
    auditEntity: 'test_set',
  },
  plans: {
    table: 'test_plans',
    links: LINKS,
    column: 'plan_id',
    fields: `is_archived, ${ticketEmbed('test_plans', 'key, summary, start_date, due_date')}`,
    auditEntity: 'test_plan',
  },
};

function linkedItemColumns(kind: KindConfig): string {
  const short = kind.column.replace('_id', '');

  return (
    `id, ${kind.fields}, links:${kind.links}!${kind.links}_${short}_fkey!inner(created_at, ` +
    `creator:users!${kind.links}_created_by_fkey(id, first_name, last_name, email, avatar_url))`
  );
}

interface LinkedItemRow {
  id: string;
  readiness?: TestCaseReadiness;
  is_archived: boolean;
  task: {
    key: string;
    summary: string;
    start_date?: string | null;
    due_date?: string | null;
  };
  links: {
    created_at: string;
    creator: (UserNameRow & { id: string; avatar_url: string | null }) | null;
  }[];
}

type KindLinkedItem = TaskLinkedItem & { kind: TaskLinkKind };

interface TaskFilterQuery {
  in(column: string, values: string[]): TaskFilterQuery;
}

const linkedItemStatus = (item: TaskLinkedItem): string =>
  item.is_archived ? 'archived' : (item.readiness ?? 'active');

const LINKED_ITEM_COMPARE: Record<
  LinkedItemsSortField,
  (a: KindLinkedItem, b: KindLinkedItem) => number
> = {
  key: (a, b) => compareTicketKeys(a.key, b.key),
  type: (a, b) =>
    TASK_LINK_KINDS.indexOf(a.kind) - TASK_LINK_KINDS.indexOf(b.kind),
  status: (a, b) => linkedItemStatus(a).localeCompare(linkedItemStatus(b)),
  linked_at: (a, b) =>
    (Date.parse(a.linked_at) || 0) - (Date.parse(b.linked_at) || 0),
};

/** Links between test cases, test sets or test plans and a ticket of the same space, managed from the ticket. */
@Injectable()
export class TestRequirementLinksService {
  private readonly logger = new Logger(TestRequirementLinksService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly visibility: TaskVisibilityService,
    private readonly auditLogs: AuditLogsService,
    private readonly tasks: TasksService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async list(
    user: RequestUser,
    spaceId: string,
    taskId: string,
    kind: TaskLinkKind,
    linkType: TaskLinkType = 'requirement',
  ): Promise<{ items: TaskLinkedItem[]; truncated?: boolean }> {
    const config = KINDS[kind];

    await this.access.assertAvailable(user.organizationId, spaceId);
    await this.assertTask(user, spaceId, taskId);

    const { data, error } = await this.client
      .from(config.table)
      .select(linkedItemColumns(config))
      .eq('links.task_id', taskId)
      .eq('links.link_type', linkType)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(0, TEST_REQUIREMENT_LINK_LIMITS.itemsPerTask - 1);

    if (error) throw tmDbError(this.logger, `list linked test ${kind}`, error);

    const rows = (data ?? []) as unknown as LinkedItemRow[];

    return {
      // A full page may hide more links, so the caller is told the list is cut.
      ...(rows.length >= TEST_REQUIREMENT_LINK_LIMITS.itemsPerTask && {
        truncated: true,
      }),
      items: rows.map((row) => {
        const link = row.links[0];

        return {
          item_id: row.id,
          link_type: linkType,
          key: row.task.key,
          name: ticketName(row.task.summary),
          is_archived: row.is_archived,
          readiness: row.readiness ?? null,
          start_date: ticketDateToPlanDay(row.task.start_date),
          end_date: ticketDateToPlanDay(row.task.due_date),
          linked_at: link?.created_at ?? '',
          linked_by: userRef(link?.creator ?? null),
        };
      }),
    };
  }

  /** Cases, then sets, then plans linked to a ticket; sorted only when sortBy is given. */
  async listLinkedItems(
    user: RequestUser,
    spaceId: string,
    taskId: string,
    query: LinkedItemsQueryDto,
  ): Promise<{ items: KindLinkedItem[]; truncated?: boolean }> {
    const lists = await Promise.all(
      TASK_LINK_KINDS.map((kind) =>
        this.list(user, spaceId, taskId, kind, query.link_type),
      ),
    );
    const items: KindLinkedItem[] = lists.flatMap((list, index) =>
      list.items.map((item) => ({ ...item, kind: TASK_LINK_KINDS[index] })),
    );

    if (query.sortBy) {
      const compare = LINKED_ITEM_COMPARE[query.sortBy];
      const dir = query.sortDir === 'desc' ? -1 : 1;

      items.sort((a, b) => compare(a, b) * dir);
    }

    return {
      ...(lists.some((list) => list.truncated) && { truncated: true }),
      items,
    };
  }

  /** Tickets linked to a case; ones the caller cannot see are listed as restricted. */
  async listCaseTasks(
    user: RequestUser,
    spaceId: string,
    caseId: string,
  ): Promise<{ items: CaseLinkedTask[] }> {
    const organizationId = user.organizationId;

    await this.access.assertAvailable(organizationId, spaceId);

    const { data: found, error: caseError } = await this.client
      .from('test_cases')
      .select('id')
      .eq('id', caseId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (caseError) throw tmDbError(this.logger, 'load test case', caseError);
    if (!found) throw notFound();

    const { data, error } = await this.client
      .from(LINKS)
      .select('task_id, created_at')
      .eq('case_id', caseId)
      .eq('link_type', 'requirement')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true })
      .range(0, TEST_REQUIREMENT_LINK_LIMITS.tasksPerCase - 1);

    if (error) throw tmDbError(this.logger, 'list linked tickets', error);

    const rows = (data ?? []) as { task_id: string; created_at: string }[];

    if (rows.length === 0) return { items: [] };

    const visible = await this.visibility.visibleTasks(
      user,
      rows.map((row) => row.task_id),
    );

    return {
      items: rows.map((row): CaseLinkedTask => {
        const item = visible.get(row.task_id);

        if (!item) {
          return {
            task_id: row.task_id,
            restricted: true,
            linked_at: row.created_at,
          };
        }

        return {
          task_id: row.task_id,
          restricted: false,
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
          linked_at: row.created_at,
        };
      }),
    };
  }

  async link(
    user: RequestUser,
    spaceId: string,
    taskId: string,
    kind: TaskLinkKind,
    dto: LinkTaskItemsDto,
  ): Promise<TaskItemsLinkResult> {
    const organizationId = user.organizationId;
    const config = KINDS[kind];
    const linkType = dto.link_type ?? 'requirement';

    await this.access.assertAvailable(organizationId, spaceId, {
      write: true,
    });
    await this.assertTask(user, spaceId, taskId);

    const archivedById = await this.loadItems(
      config,
      organizationId,
      spaceId,
      dto.item_ids,
    );
    const candidates = dto.item_ids.filter(
      (id) => archivedById.get(id) === false,
    );
    const linked = await this.linkedItemIds(
      config,
      organizationId,
      spaceId,
      taskId,
      linkType,
      candidates,
    );
    const fresh = candidates.filter((id) => !linked.has(id));

    if (kind === 'cases' && linkType === 'requirement') {
      await this.assertCaseLimit(organizationId, spaceId, fresh);
    }

    let inserted = new Set<string>();

    if (fresh.length > 0) {
      // A parallel call may save the same link first; the unique key makes that row a no-op.
      const { data, error } = await this.client
        .from(config.links)
        .upsert(
          fresh.map((itemId) => ({
            organization_id: organizationId,
            space_id: spaceId,
            link_type: linkType,
            [config.column]: itemId,
            task_id: taskId,
            created_by: user.userId,
          })),
          {
            onConflict: `${config.column},task_id,link_type`,
            ignoreDuplicates: true,
          },
        )
        .select(config.column);

      // P0002: ticket of another organization (trigger); 23503: ticket or item deleted meanwhile.
      if (error?.code === 'P0002' || error?.code === '23503') throw notFound();
      if (error) throw tmDbError(this.logger, `link test ${kind}`, error);

      inserted = new Set(
        ((data ?? []) as unknown as Record<string, string>[]).map(
          (row) => row[config.column],
        ),
      );
    }

    if (inserted.size > 0) {
      for (const itemId of inserted) {
        void this.auditLogs.logActionForRequest(
          user,
          config.auditEntity,
          itemId,
          'update',
          {
            space_id: spaceId,
            action: 'link_task',
            task_id: taskId,
            ...(linkType === 'defect' && { link_type: linkType }),
          },
        );
      }
    }

    return {
      added: inserted.size,
      skipped: dto.item_ids.flatMap((id) => {
        const reason: TaskItemSkipReason | null = !archivedById.has(id)
          ? 'not_found'
          : archivedById.get(id)
            ? 'archived'
            : !inserted.has(id)
              ? 'already_linked'
              : null;

        return reason ? [{ item_id: id, reason }] : [];
      }),
    };
  }

  /** Allowed for archived items too. */
  async unlink(
    user: RequestUser,
    spaceId: string,
    taskId: string,
    kind: TaskLinkKind,
    itemId: string,
    linkType: TaskLinkType = 'requirement',
  ): Promise<void> {
    const config = KINDS[kind];

    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });
    await this.assertTask(user, spaceId, taskId);

    const { data, error } = await this.client
      .from(config.links)
      .delete()
      .eq('task_id', taskId)
      .eq(config.column, itemId)
      .eq('link_type', linkType)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .select('id');

    if (error) throw tmDbError(this.logger, `unlink test ${kind}`, error);
    if (!data?.length) throw notFound();

    void this.auditLogs.logActionForRequest(
      user,
      config.auditEntity,
      itemId,
      'update',
      {
        space_id: spaceId,
        action: 'unlink_task',
        task_id: taskId,
        ...(linkType === 'defect' && { link_type: linkType }),
      },
    );
  }

  /** Links tickets to a test case as requirements; one invisible ticket refuses the whole request. */
  async linkCaseRequirements(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    dto: LinkRequirementsDto,
  ): Promise<CaseRequirementsLinkResult> {
    const organizationId = user.organizationId;

    await this.access.assertAvailable(organizationId, spaceId, {
      write: true,
    });

    const found = await this.loadCase(organizationId, spaceId, caseId);

    if (!found) throw notFound();

    if (found.is_archived) {
      throw new ConflictException({
        code: 'ARCHIVED',
        message: 'The test case is archived. Restore it first.',
      });
    }

    // Tickets of other organizations, hidden ones and missing ones all look the same.
    const visible = await this.visibility.visibleTasks(user, dto.task_ids);

    if (dto.task_ids.some((id) => !visible.has(id))) throw notFound();
    if (dto.task_ids.some((id) => visible.get(id)?.spaceId !== spaceId)) {
      throw otherSpaceTicket();
    }

    const allowed = await this.requirementLinkTypes(organizationId, spaceId);
    const blocked = dto.task_ids.filter(
      (id) => !allowed.includes(visible.get(id)?.type ?? ''),
    );

    if (allowed.length > 0 && blocked.length > 0) {
      throw new BadRequestException({
        code: 'TYPE_NOT_ALLOWED',
        message:
          'This ticket type cannot be linked as a requirement in this space',
        data: { keys: blocked.map((id) => visible.get(id)?.key ?? id) },
      });
    }

    const linked = await this.caseRequirementIds(
      organizationId,
      spaceId,
      caseId,
    );
    const fresh = dto.task_ids.filter((id) => !linked.has(id));
    const limit = TEST_REQUIREMENT_LINK_LIMITS.tasksPerCase;

    if (linked.size + fresh.length > limit) {
      throw new BadRequestException({
        code: 'LIMIT_EXCEEDED',
        message: `A test case can have at most ${limit} requirement tickets`,
        data: { limit, actual: linked.size + fresh.length },
      });
    }

    let inserted: string[] = [];

    if (fresh.length > 0) {
      // A parallel call may save the same link first; the unique key makes that row a no-op.
      const { data, error } = await this.client
        .from(LINKS)
        .upsert(
          fresh.map((taskId) => ({
            organization_id: organizationId,
            space_id: spaceId,
            link_type: 'requirement',
            case_id: caseId,
            task_id: taskId,
            created_by: user.userId,
          })),
          { onConflict: 'case_id,task_id,link_type', ignoreDuplicates: true },
        )
        .select('task_id');

      // P0002: ticket of another organization (trigger); 23503: ticket or case deleted meanwhile.
      if (error?.code === 'P0002' || error?.code === '23503') throw notFound();
      if (error) throw tmDbError(this.logger, 'link requirements', error);

      inserted = ((data ?? []) as { task_id: string }[]).map(
        (row) => row.task_id,
      );
    }

    const added = new Set(inserted);

    if (added.size > 0) {
      void this.auditLogs.logActionForRequest(
        user,
        'test_case',
        caseId,
        'update',
        { space_id: spaceId, action: 'link_requirements', task_ids: inserted },
      );
    }

    return {
      added: added.size,
      skipped: dto.task_ids
        .filter((id) => !added.has(id))
        .map((taskId) => ({ task_id: taskId, reason: 'already_linked' })),
    };
  }

  /** Allowed on archived cases and for tickets the caller can no longer see. */
  async unlinkCaseRequirement(
    user: RequestUser,
    spaceId: string,
    caseId: string,
    taskId: string,
  ): Promise<void> {
    const organizationId = user.organizationId;

    await this.access.assertAvailable(organizationId, spaceId, {
      write: true,
    });

    if (!(await this.loadCase(organizationId, spaceId, caseId))) {
      throw notFound();
    }

    const { data, error } = await this.client
      .from(LINKS)
      .delete()
      .eq('case_id', caseId)
      .eq('task_id', taskId)
      .eq('link_type', 'requirement')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .select('id');

    if (error) throw tmDbError(this.logger, 'unlink requirement', error);
    if (!data?.length) throw notFound();

    void this.auditLogs.logActionForRequest(
      user,
      'test_case',
      caseId,
      'update',
      { space_id: spaceId, action: 'unlink_requirement', task_id: taskId },
    );
  }

  /** Space tickets for the requirement picker, in the task list's order. */
  async searchRequirementTickets(
    user: RequestUser,
    spaceId: string,
    query: RequirementTicketSearchQueryDto,
  ): Promise<{
    items: TaskPickerItem[];
    page: number;
    hasMore: boolean;
    total: number;
  }> {
    const organizationId = user.organizationId;
    const page = query.page ?? 1;

    await this.access.assertAvailable(organizationId, spaceId);

    // Only the space's requirement types are offered; an empty list allows every type, test ones included.
    const allowed = await this.requirementLinkTypes(organizationId, spaceId);
    const allowedIds = allowed.filter((id) => /^[A-Za-z0-9_-]+$/.test(id));

    if (
      allowed.length > 0 &&
      (allowedIds.length === 0 ||
        (query.taskTypeId && !allowedIds.includes(query.taskTypeId)))
    ) {
      return { items: [], page, hasMore: false, total: 0 };
    }

    const res = await this.tasks.getAll(organizationId, {
      space_id: spaceId,
      search: query.search?.trim() || undefined,
      task_type_id: query.taskTypeId,
      status_ids: query.statusId,
      assigned_to: query.assignedTo === 'unassigned' ? null : query.assignedTo,
      page,
      pageSize: query.pageSize ?? 25,
      sortBy: query.sortBy ?? 'updated_at',
      sortDir: query.sortDir ?? 'desc',
      // The ids come from the settings row and are checked to be plain ids above.
      refine: allowedIds.length
        ? (q: TaskFilterQuery) => q.in('task_type_id', allowedIds)
        : undefined,
    });
    const ids = res.data.flatMap((row) =>
      typeof row.id === 'string' ? [row.id] : [],
    );
    const visible = await this.visibility.visibleTasks(user, ids);
    const items = ids
      .map((id) => visible.get(id))
      .filter((item): item is TaskPickerItem => item !== undefined);

    return { items, page: res.page, hasMore: res.hasMore, total: res.total };
  }

  /** Ticket types the space allows as requirements; empty allows every type. */
  private async requirementLinkTypes(
    organizationId: string,
    spaceId: string,
  ): Promise<string[]> {
    const { data, error } = await this.client
      .from('test_management_space_settings')
      .select('requirement_link_task_type_ids')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle<{ requirement_link_task_type_ids: string[] | null }>();

    // Column not migrated yet: keep allowing every type.
    if (error?.code === '42703') return [];
    if (error) throw tmDbError(this.logger, 'load settings', error);

    return data?.requirement_link_task_type_ids ?? [];
  }

  private async loadCase(
    organizationId: string,
    spaceId: string,
    caseId: string,
  ): Promise<{ id: string; is_archived: boolean } | null> {
    const { data, error } = await this.client
      .from('test_cases')
      .select('id, is_archived')
      .eq('id', caseId)
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load test case', error);

    return data as { id: string; is_archived: boolean } | null;
  }

  private async caseRequirementIds(
    organizationId: string,
    spaceId: string,
    caseId: string,
  ): Promise<Set<string>> {
    const { data, error } = await this.client
      .from(LINKS)
      .select('task_id')
      .eq('case_id', caseId)
      .eq('link_type', 'requirement')
      .eq('space_id', spaceId)
      .eq('organization_id', organizationId)
      .range(0, TEST_REQUIREMENT_LINK_LIMITS.tasksPerCase);

    if (error) throw tmDbError(this.logger, 'load requirement links', error);

    return new Set(
      ((data ?? []) as { task_id: string }[]).map((row) => row.task_id),
    );
  }

  /** The same limit as linking from the case, so no case holds more tickets than its list can show. */
  private async assertCaseLimit(
    organizationId: string,
    spaceId: string,
    caseIds: string[],
  ): Promise<void> {
    const limit = TEST_REQUIREMENT_LINK_LIMITS.tasksPerCase;

    for (const part of chunk(caseIds)) {
      const { data, error } = await this.client
        .from(LINKS)
        .select('case_id')
        .in('case_id', part)
        .eq('link_type', 'requirement')
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId);

      if (error) throw tmDbError(this.logger, 'count requirement links', error);

      const counts = new Map<string, number>();

      for (const row of (data ?? []) as { case_id: string }[]) {
        counts.set(row.case_id, (counts.get(row.case_id) ?? 0) + 1);
      }

      if ([...counts.values()].some((count) => count >= limit)) {
        throw new BadRequestException({
          code: 'LIMIT_EXCEEDED',
          message: `A test case can have at most ${limit} requirement tickets`,
          data: { limit },
        });
      }
    }
  }

  /** Missing, foreign-space and hidden tickets get the same 404. */
  private async assertTask(
    user: RequestUser,
    spaceId: string,
    taskId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('tasks')
      .select('id')
      .eq('id', taskId)
      .eq('space_id', spaceId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load ticket', error);
    if (!data) throw notFound();

    const visible = await this.visibility.visibleTasks(user, [taskId]);

    if (!visible.has(taskId)) throw notFound();
  }

  /** is_archived by id, for the items of this space only. */
  private async loadItems(
    config: KindConfig,
    organizationId: string,
    spaceId: string,
    ids: string[],
  ): Promise<Map<string, boolean>> {
    const found = new Map<string, boolean>();

    for (const part of chunk(ids)) {
      const { data, error } = await this.client
        .from(config.table)
        .select('id, is_archived')
        .in('id', part)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId);

      if (error) throw tmDbError(this.logger, `load ${config.table}`, error);

      for (const row of (data ?? []) as {
        id: string;
        is_archived: boolean;
      }[]) {
        found.set(row.id, row.is_archived);
      }
    }

    return found;
  }

  private async linkedItemIds(
    config: KindConfig,
    organizationId: string,
    spaceId: string,
    taskId: string,
    linkType: TaskLinkType,
    itemIds: string[],
  ): Promise<Set<string>> {
    const linked = new Set<string>();

    for (const part of chunk(itemIds)) {
      const { data, error } = await this.client
        .from(config.links)
        .select(config.column)
        .eq('task_id', taskId)
        .eq('link_type', linkType)
        .in(config.column, part)
        .eq('space_id', spaceId)
        .eq('organization_id', organizationId);

      if (error) throw tmDbError(this.logger, `load ${config.links}`, error);

      for (const row of (data ?? []) as unknown as Record<string, string>[]) {
        linked.add(row[config.column]);
      }
    }

    return linked;
  }
}
