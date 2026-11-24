import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { fetchAllRows } from '../common/utils/fetch-all-rows';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { CreateSprintDto } from './dto/create-sprint.dto';
import type { UpdateSprintDto } from './dto/update-sprint.dto';
import type { StartSprintDto } from './dto/start-sprint.dto';
import { CompleteSprintAction } from './dto/complete-sprint.dto';
import type { CompleteSprintDto } from './dto/complete-sprint.dto';
import type { ReorderBacklogDto } from './dto/reorder-backlog.dto';
import type { MoveTasksDto } from './dto/move-tasks.dto';

const TASK_DETAIL_SELECT = `
  *,
  task:tasks!board_issue_ranking_task_id_fkey (
    id, key, summary, status_id, priority_id, assigned_to, task_type_id,
    due_date, labels, custom_field_values, created_at,
    assignee:users!tasks_assigned_to_fkey (id, first_name, last_name, avatar_url),
    status_config:task_statuses!tasks_status_id_fkey (id, name, color, icon),
    priority_config:task_priorities!tasks_priority_id_fkey (id, name, color, icon)
  )
`.trim();

@Injectable()
export class SprintsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
    private readonly permissionsService: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private async logAction(
    organizationId: string,
    userId: string,
    entityId: string,
    action: 'create' | 'update' | 'delete',
    changes: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogsService.logAction(
        organizationId,
        userId,
        'sprint',
        entityId,
        action,
        changes,
      );
    } catch {
      // Audit logging is best-effort and must not break sprint mutations.
    }
  }

  private permissionRank(level: 'view' | 'edit' | 'admin'): number {
    return level === 'admin' ? 3 : level === 'edit' ? 2 : 1;
  }

  private requiredSpacePermission(level: 'view' | 'edit' | 'admin') {
    if (level === 'view') return 'view_boards';
    if (level === 'edit') return 'edit_boards';
    return 'delete_boards';
  }

  private async verifyBoard(
    boardId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const { data, error } = await this.client
      .from('boards')
      .select('id, board_type, space_id')
      .eq('id', boardId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Board not found');
    return data as Record<string, unknown>;
  }

  private async assertBoardAccess(
    boardId: string,
    organizationId: string,
    userId: string,
    level: 'view' | 'edit' | 'admin',
  ): Promise<Record<string, unknown>> {
    const board = await this.verifyBoard(boardId, organizationId);
    const spaceId = board['space_id'] as string;
    const required = this.requiredSpacePermission(level);

    const resolved = await this.permissionsService.getUserSpacePermissions(
      userId,
      organizationId,
      spaceId,
    );

    if (resolved.permissions[required] === true) return board;

    const { data: permission, error } = await this.client
      .from('board_permissions')
      .select('permission_level')
      .eq('board_id', boardId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    const boardLevel = (
      permission as { permission_level?: 'view' | 'edit' | 'admin' } | null
    )?.permission_level;

    if (
      boardLevel &&
      this.permissionRank(boardLevel) >= this.permissionRank(level)
    ) {
      return board;
    }

    throw new ForbiddenException(
      `You do not have ${level} permission on this board`,
    );
  }

  private requireScrum(board: Record<string, unknown>): void {
    if (board['board_type'] !== 'scrum') {
      throw new BadRequestException('This operation requires a Scrum board');
    }
  }

  async getSprints(
    boardId: string,
    organizationId: string,
    userId: string,
    includeCompleted: boolean,
  ): Promise<{ data: Record<string, unknown>[] }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'view');

    let query = this.client
      .from('sprints')
      .select('*')
      .eq('board_id', boardId)
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true });

    if (!includeCompleted) {
      query = query.neq('status', 'completed');
    }

    const { data, error } = await query;
    if (error) throw new BadRequestException(error.message);
    return { data: (data ?? []) as Record<string, unknown>[] };
  }

  async createSprint(
    boardId: string,
    organizationId: string,
    userId: string,
    dto: CreateSprintDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const board = await this.assertBoardAccess(
      boardId,
      organizationId,
      userId,
      'admin',
    );
    this.requireScrum(board);

    const { data: maxRow } = await this.client
      .from('sprints')
      .select('sort_order')
      .eq('board_id', boardId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle();

    const sortOrder =
      maxRow != null
        ? ((maxRow as Record<string, unknown>)['sort_order'] as number) + 1
        : 0;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('sprints')
      .insert({
        board_id: boardId,
        organization_id: organizationId,
        name: dto.name,
        goal: dto.goal ?? null,
        start_date: dto.start_date ?? null,
        end_date: dto.end_date ?? null,
        sort_order: sortOrder,
        created_by: userId,
      })
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to create sprint',
      );
    await this.logAction(
      organizationId,
      userId,
      (data as Record<string, unknown>)['id'] as string,
      'create',
      {
        board_id: boardId,
        name: dto.name,
      },
    );
    return { data: data as Record<string, unknown>, success: true };
  }

  async getSprintById(
    boardId: string,
    sprintId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Record<string, unknown> }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'view');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('sprints')
      .select('*')
      .eq('id', sprintId)
      .eq('board_id', boardId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Sprint not found');
    return { data: data as Record<string, unknown> };
  }

  async updateSprint(
    sprintId: string,
    boardId: string,
    organizationId: string,
    userId: string,
    dto: UpdateSprintDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');
    await this.getSprintById(boardId, sprintId, organizationId, userId);

    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.goal !== undefined) patch['goal'] = dto.goal;
    if (dto.sort_order !== undefined) patch['sort_order'] = dto.sort_order;

    if (Object.keys(patch).length === 0) {
      const existing = await this.getSprintById(
        boardId,
        sprintId,
        organizationId,
        userId,
      );
      return { data: existing.data, success: true };
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('sprints')
      .update(patch)
      .eq('id', sprintId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        error?.message ?? 'Failed to update sprint',
      );
    await this.logAction(organizationId, userId, sprintId, 'update', {
      board_id: boardId,
      ...patch,
    });
    return { data: data as Record<string, unknown>, success: true };
  }

  async deleteSprint(
    sprintId: string,
    boardId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ success: true; message: string }> {
    const { data: sprint } = await this.getSprintById(
      boardId,
      sprintId,
      organizationId,
      userId,
    );
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');

    const status = sprint['status'] as string;
    if (status === 'active') {
      throw new BadRequestException('Cannot delete an active sprint');
    }
    if (status === 'completed') {
      throw new BadRequestException('Cannot delete a completed sprint');
    }

    const { error } = await this.client
      .from('sprints')
      .delete()
      .eq('id', sprintId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
    await this.logAction(organizationId, userId, sprintId, 'delete', {
      board_id: boardId,
      status,
    });
    return { success: true, message: 'Sprint deleted' };
  }

  async startSprint(
    sprintId: string,
    boardId: string,
    organizationId: string,
    userId: string,
    dto: StartSprintDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const board = await this.assertBoardAccess(
      boardId,
      organizationId,
      userId,
      'admin',
    );
    this.requireScrum(board);

    const { data: sprint } = await this.getSprintById(
      boardId,
      sprintId,
      organizationId,
      userId,
    );

    if (sprint['status'] !== 'planning') {
      throw new BadRequestException('Only planning sprints can be started');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.client
      .from('sprints')
      .update({
        status: 'active',
        start_date: dto.start_date,
        end_date: dto.end_date,
      })
      .eq('id', sprintId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(error?.message ?? 'Failed to start sprint');
    await this.logAction(organizationId, userId, sprintId, 'update', {
      board_id: boardId,
      status: 'active',
      start_date: dto.start_date,
      end_date: dto.end_date,
    });
    return { data: data as Record<string, unknown>, success: true };
  }

  async completeSprint(
    sprintId: string,
    boardId: string,
    organizationId: string,
    userId: string,
    dto: CompleteSprintDto,
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const board = await this.assertBoardAccess(
      boardId,
      organizationId,
      userId,
      'admin',
    );
    this.requireScrum(board);

    const { data: sprint } = await this.getSprintById(
      boardId,
      sprintId,
      organizationId,
      userId,
    );

    if (sprint['status'] !== 'active') {
      throw new BadRequestException('Only active sprints can be completed');
    }

    if (
      dto.action === CompleteSprintAction.MOVE_TO_SPRINT &&
      !dto.target_sprint_id
    ) {
      throw new BadRequestException(
        'target_sprint_id is required when action is move_to_sprint',
      );
    }

    if (dto.target_sprint_id) {
      const { data: targetSprint, error: targetError } = await this.client
        .from('sprints')
        .select('id, board_id, status')
        .eq('id', dto.target_sprint_id)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (targetError) throw new BadRequestException(targetError.message);
      if (!targetSprint) throw new NotFoundException('Target sprint not found');
      if ((targetSprint as Record<string, unknown>)['board_id'] !== boardId) {
        throw new BadRequestException(
          'Target sprint does not belong to this board',
        );
      }
      if ((targetSprint as Record<string, unknown>)['status'] === 'completed') {
        throw new BadRequestException(
          'Cannot move tasks to a completed sprint',
        );
      }
    }

    // 1. Get done column IDs
    const { data: doneColumns, error: colError } = await this.client
      .from('board_columns')
      .select('id')
      .eq('board_id', boardId)
      .eq('is_done', true);

    if (colError) throw new BadRequestException(colError.message);
    const doneColumnIds = (
      (doneColumns ?? []) as Record<string, unknown>[]
    ).map((c) => c['id'] as string);

    // 2. Get completed task IDs (in done columns)
    let completedTaskIds: string[] = [];
    if (doneColumnIds.length > 0) {
      const { data: completedRows } = await this.client
        .from('board_issue_ranking')
        .select('task_id')
        .eq('sprint_id', sprintId)
        .in('column_id', doneColumnIds);

      completedTaskIds = (
        (completedRows ?? []) as Record<string, unknown>[]
      ).map((r) => r['task_id'] as string);
    }

    // 3. Get incomplete task IDs (not in done columns)
    let incompleteQuery = this.client
      .from('board_issue_ranking')
      .select('task_id')
      .eq('sprint_id', sprintId);

    if (doneColumnIds.length > 0) {
      incompleteQuery = incompleteQuery.not(
        'column_id',
        'in',
        `(${doneColumnIds.join(',')})`,
      );
    }

    const { data: incompleteRows } = await incompleteQuery;
    const incompleteTaskIds = (
      (incompleteRows ?? []) as Record<string, unknown>[]
    ).map((r) => r['task_id'] as string);

    // 4. Move incomplete tasks to target sprint or backlog
    if (incompleteTaskIds.length > 0) {
      const targetSprintId =
        dto.action === CompleteSprintAction.MOVE_TO_SPRINT
          ? dto.target_sprint_id
          : null;

      const { error: moveError } = await this.client
        .from('board_issue_ranking')
        .update({ sprint_id: targetSprintId })
        .eq('board_id', boardId)
        .in('task_id', incompleteTaskIds);

      if (moveError) throw new BadRequestException(moveError.message);
    }

    // 5. Mark sprint as completed
    const { error: completeError } = await this.client
      .from('sprints')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', sprintId)
      .eq('organization_id', organizationId);

    if (completeError) throw new BadRequestException(completeError.message);

    // 6. Log sprint completion
    await this.client
      .from('sprint_completion_log')
      .insert({
        sprint_id: sprintId,
        completed_by: userId,
        completed_count: completedTaskIds.length,
        incomplete_count: incompleteTaskIds.length,
        moved_to_sprint_id:
          dto.action === CompleteSprintAction.MOVE_TO_SPRINT
            ? (dto.target_sprint_id ?? null)
            : null,
        moved_to_backlog_count:
          dto.action === CompleteSprintAction.MOVE_TO_BACKLOG
            ? incompleteTaskIds.length
            : 0,
      })
      .select()
      .maybeSingle();

    const movedToBacklogCount =
      dto.action === CompleteSprintAction.MOVE_TO_BACKLOG
        ? incompleteTaskIds.length
        : 0;

    await this.logAction(organizationId, userId, sprintId, 'update', {
      board_id: boardId,
      status: 'completed',
      completed_count: completedTaskIds.length,
      incomplete_count: incompleteTaskIds.length,
      moved_to_sprint_id:
        dto.action === CompleteSprintAction.MOVE_TO_SPRINT
          ? (dto.target_sprint_id ?? null)
          : null,
      moved_to_backlog_count: movedToBacklogCount,
    });

    return {
      data: {
        sprint_id: sprintId,
        completed_count: completedTaskIds.length,
        incomplete_count: incompleteTaskIds.length,
        moved_to_sprint_id:
          dto.action === CompleteSprintAction.MOVE_TO_SPRINT
            ? (dto.target_sprint_id ?? null)
            : null,
        moved_to_backlog_count: movedToBacklogCount,
      },
      success: true,
    };
  }

  private flattenRankingRow(
    row: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const task = row['task'] as Record<string, unknown> | null;
    if (!task) return null;
    return {
      ...task,
      sprint_id: row['sprint_id'],
      backlog_position: row['backlog_position'],
      column_id: row['column_id'],
      position: row['position'],
      ranking_id: row['id'],
    };
  }

  async getBacklogView(
    boardId: string,
    organizationId: string,
    userId: string,
  ): Promise<{
    sprints: Record<string, unknown>[];
    backlog_tasks: Record<string, unknown>[];
  }> {
    const board = await this.assertBoardAccess(
      boardId,
      organizationId,
      userId,
      'view',
    );
    this.requireScrum(board);

    // Resolve task type levels from hierarchy config so each task gets its
    // type object (icon + color). Fetch ALL configs for the org (not just the
    // space-specific row) because many orgs store levels in a single org-default
    // row where space_id IS NULL — a space-filtered .maybeSingle() would miss it.
    let taskTypeLevels: Record<string, unknown>[] = [];
    const spaceId = board['space_id'] as string | null;
    if (spaceId) {
      const { data: configRows } = await this.client
        .from('task_hierarchy_configurations')
        .select('space_id, config')
        .eq('organization_id', organizationId);

      const allRows = (configRows ?? []) as Array<{
        space_id: string | null;
        config: { levels?: Record<string, unknown>[] } | null;
      }>;

      // Space-specific config takes precedence; fall back to org-default (space_id = null).
      const resolved =
        allRows.find((r) => r.space_id === spaceId) ??
        allRows.find((r) => r.space_id === null);

      const levels = resolved?.config?.levels;
      taskTypeLevels = Array.isArray(levels) ? levels : [];
    }

    // 1. Get all non-completed sprints
    const { data: sprintRows, error: sprintError } = await this.client
      .from('sprints')
      .select('*')
      .eq('board_id', boardId)
      .eq('organization_id', organizationId)
      .neq('status', 'completed')
      .order('sort_order', { ascending: true });

    if (sprintError) throw new BadRequestException(sprintError.message);
    const sprints = (sprintRows ?? []) as Record<string, unknown>[];

    // 2. Get tasks for ALL sprints in one paged read, then group in memory.
    //
    // Was one heavy joined query PER SPRINT (Promise.all over `sprints`), i.e. an
    // N+1 where each iteration is a full PostgREST round trip carrying the whole
    // TASK_DETAIL_SELECT join. It was also unbounded, so any sprint past 1000
    // ranking rows silently lost the remainder.
    //
    // Grouping in JS is safe here in a way the aggregation bugs elsewhere were
    // not: these rows are already fully fetched by fetchAllRows, so the grouping
    // is over a complete set rather than a truncated page.
    const sprintIds = sprints.map((sprint) => sprint['id'] as string);

    const { rows: allSprintTaskRows } = sprintIds.length
      ? await fetchAllRows<Record<string, unknown>>(
          (from, to) =>
            this.client
              .from('board_issue_ranking')
              .select(TASK_DETAIL_SELECT)
              .in('sprint_id', sprintIds)
              .order('backlog_position', { ascending: true })
              .order('task_id', { ascending: true })
              .range(from, to) as never,
        )
      : { rows: [] as Record<string, unknown>[] };

    const rowsBySprintId = new Map<string, Record<string, unknown>[]>();

    for (const row of allSprintTaskRows) {
      const sprintId = row['sprint_id'] as string | null;
      if (!sprintId) continue;

      const bucket = rowsBySprintId.get(sprintId);
      if (bucket) bucket.push(row);
      else rowsBySprintId.set(sprintId, [row]);
    }

    const sprintsWithTasks = sprints.map((sprint) => {
      const tasks = (rowsBySprintId.get(sprint['id'] as string) ?? [])
        .map((r) => this.flattenRankingRow(r))
        .filter((t): t is Record<string, unknown> => t !== null)
        .map((t) => ({
          ...t,
          task_type:
            taskTypeLevels.find((level) => level['id'] === t['task_type_id']) ??
            null,
        })) as Record<string, unknown>[];

      return {
        ...sprint,
        tasks,
        total_count: tasks.length,
        completed_count: 0,
      };
    });

    // 3. Get backlog tasks (no sprint assigned)
    // Paged for the same reason — an unbounded backlog silently stopped at 1000.
    const { rows: backlogRows } = await fetchAllRows<Record<string, unknown>>(
      (from, to) =>
        this.client
          .from('board_issue_ranking')
          .select(TASK_DETAIL_SELECT)
          .eq('board_id', boardId)
          .is('sprint_id', null)
          .order('backlog_position', { ascending: true })
          .order('task_id', { ascending: true })
          .range(from, to) as never,
    );

    const backlogTasks = (
      (backlogRows ?? []) as unknown as Record<string, unknown>[]
    )
      .map((r) => this.flattenRankingRow(r))
      .filter((t): t is Record<string, unknown> => t !== null)
      .map((t) => ({
        ...t,
        task_type:
          taskTypeLevels.find((level) => level['id'] === t['task_type_id']) ??
          null,
      })) as Record<string, unknown>[];

    return {
      sprints: sprintsWithTasks,
      backlog_tasks: backlogTasks,
    };
  }

  async reorderBacklog(
    boardId: string,
    organizationId: string,
    userId: string,
    dto: ReorderBacklogDto,
  ): Promise<{ success: true }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'edit');

    for (let i = 0; i < dto.task_ids.length; i++) {
      const { error } = await this.client
        .from('board_issue_ranking')
        .update({ backlog_position: (i + 1) * 1000 })
        .eq('board_id', boardId)
        .eq('task_id', dto.task_ids[i]);

      if (error) throw new BadRequestException(error.message);
    }

    await this.logAction(organizationId, userId, boardId, 'update', {
      scope: 'backlog_reorder',
      board_id: boardId,
      task_ids: dto.task_ids,
    });

    return { success: true };
  }

  async moveTasksToSprint(
    boardId: string,
    organizationId: string,
    userId: string,
    dto: MoveTasksDto,
  ): Promise<{ success: true }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'edit');

    if (dto.task_ids.length === 0) return { success: true };

    if (dto.target_sprint_id) {
      const { data: targetSprint, error: targetError } = await this.client
        .from('sprints')
        .select('id, board_id, status')
        .eq('id', dto.target_sprint_id)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (targetError) throw new BadRequestException(targetError.message);
      if (!targetSprint) throw new NotFoundException('Target sprint not found');
      if ((targetSprint as Record<string, unknown>)['board_id'] !== boardId) {
        throw new BadRequestException(
          'Target sprint does not belong to this board',
        );
      }
      if ((targetSprint as Record<string, unknown>)['status'] === 'completed') {
        throw new BadRequestException(
          'Cannot move tasks to a completed sprint',
        );
      }
    }

    const { error } = await this.client
      .from('board_issue_ranking')
      .update({ sprint_id: dto.target_sprint_id })
      .eq('board_id', boardId)
      .in('task_id', dto.task_ids);

    if (error) throw new BadRequestException(error.message);
    await this.logAction(organizationId, userId, boardId, 'update', {
      scope: 'move_tasks',
      board_id: boardId,
      task_ids: dto.task_ids,
      target_sprint_id: dto.target_sprint_id ?? null,
    });
    return { success: true };
  }
}
