/**
 * @fileoverview Core boards service — board + columns + swimlanes + card-fields
 * + quick-filters CRUD, card move with optimistic locking, card reorder.
 * @module src/boards/boards.service
 * @author Prince Jadiya
 */

import {
  Injectable,
  Logger,
  Optional,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { fetchAllRows } from '../common/utils/fetch-all-rows';
import { toLegacyStatusText } from '../tasks/legacy-status.util';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { SavedFiltersService } from '../saved-filters/saved-filters.service';
import { PermissionsService } from '../permissions/permissions.service';
import {
  createLinkViewCheck,
  fetchLinkedTaskIds,
  fetchTaskKeys,
} from '../tasks/task-links.util';
import { WorkflowEngineService } from '../workflow-engine/workflow-engine.service';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import type { TaskStatusChangedSnapshot } from '../automations/automation-event-outbox.service';
import { WorkflowAssignmentsService } from '../workflow-assignments/workflow-assignments.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { EntitlementsService } from '../licensing/entitlements.service';
import { GIT_DEV_SELECT } from '../git-integrations/git-dev-filter.util';
import type { CreateBoardDto } from './dto/create-board.dto';
import type { UpdateBoardDto } from './dto/update-board.dto';
import type { CreateColumnDto } from './dto/create-column.dto';
import type { UpdateColumnDto } from './dto/update-column.dto';
import type { MoveCardDto } from './dto/move-card.dto';
import type { ReorderCardsDto } from './dto/reorder-cards.dto';

export interface Board {
  id: string;
  organization_id: string;
  space_id: string;
  name: string;
  description: string | null;
  board_type: string;
  filter_id: string | null;
  settings: Record<string, unknown>;
  sort_order: number;
  is_archived: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardColumn {
  id: string;
  board_id: string;
  name: string;
  sort_order: number;
  min_wip: number;
  max_wip: number;
  color: string | null;
  is_backlog: boolean;
  is_kanban_backlog: boolean;
  is_done: boolean;
  version: number;
}

export interface BoardSwimlane {
  id: string;
  board_id: string;
  name: string;
  query: string | null;
  sort_order: number;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardCardField {
  id: string;
  board_id: string;
  custom_field_id: string;
  position: number;
  width: string | null;
  color: string | null;
}

export interface BoardQuickFilter {
  id: string;
  board_id: string;
  name: string;
  query: string | null;
  description: string | null;
  sort_order: number;
  is_enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BoardViewData {
  board: Board;
  columns: BoardColumn[];
  swimlanes: BoardSwimlane[];
  card_fields: BoardCardField[];
  quick_filters: BoardQuickFilter[];
  active_sprint: Record<string, unknown> | null;
}

export type BoardPermissionLevel = 'view' | 'edit' | 'admin';

export interface BoardListResult {
  data: Board[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Row shape returned by the board-view ranking reads (see getBoardView). */
interface BoardRankingRow {
  task_id: string;
  column_id: string;
  swimlane_id: string | null;
  position: number;
  version: number;
}

@Injectable()
export class BoardsService {
  private readonly logger = new Logger(BoardsService.name);
  private static readonly BOARDS_TABLE = 'boards';
  private static readonly COLUMNS_TABLE = 'board_columns';
  private static readonly COLUMN_STATUSES_TABLE = 'board_column_statuses';
  private static readonly RANKINGS_TABLE = 'board_issue_ranking';
  private static readonly SWIMLANES_TABLE = 'board_swimlanes';
  private static readonly CARD_FIELDS_TABLE = 'board_card_fields';
  private static readonly QUICK_FILTERS_TABLE = 'board_quick_filters';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogsService: AuditLogsService,
    private readonly savedFiltersService: SavedFiltersService,
    private readonly permissionsService: PermissionsService,
    // Optional so unit tests can construct BoardsService without the engine.
    // In the app both are provided via BoardsModule's imports.
    @Optional() private readonly engine?: WorkflowEngineService,
    @Optional() private readonly assignments?: WorkflowAssignmentsService,

    // Optional for the same reason as the two above. Only used on the RPC fallback path:
    // a drag that goes through `executeTransition` already emits the event itself.
    @Optional() private readonly outboxService?: AutomationEventOutboxService,
    // Optional like the above; absent = not entitled (no Git fields on cards).
    @Optional() private readonly entitlementsService?: EntitlementsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  private permissionRank(level: BoardPermissionLevel): number {
    return level === 'admin' ? 3 : level === 'edit' ? 2 : 1;
  }

  private requiredSpacePermission(level: BoardPermissionLevel | 'create') {
    if (level === 'create') return 'create_boards';
    if (level === 'view') return 'view_boards';
    if (level === 'edit') return 'edit_boards';
    return 'delete_boards';
  }

  private async hasSpaceBoardsPermission(
    spaceId: string,
    organizationId: string,
    userId: string,
    level: BoardPermissionLevel | 'create',
  ): Promise<boolean> {
    const permissionKey = this.requiredSpacePermission(level);
    const resolved = await this.permissionsService.getUserSpacePermissions(
      userId,
      organizationId,
      spaceId,
    );

    return resolved.permissions[permissionKey] === true;
  }

  private async assertSpaceBoardsPermission(
    spaceId: string,
    organizationId: string,
    userId: string,
    level: BoardPermissionLevel | 'create',
  ): Promise<void> {
    const { data: space, error } = await this.client
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!space) throw new NotFoundException('Space not found');

    if (
      await this.hasSpaceBoardsPermission(
        spaceId,
        organizationId,
        userId,
        level,
      )
    ) {
      return;
    }

    throw new ForbiddenException('Permission denied');
  }

  private async assertBoardAccess(
    boardId: string,
    organizationId: string,
    userId: string,
    level: BoardPermissionLevel,
  ): Promise<Board> {
    const board = await this.getBoardOnly(boardId, organizationId);

    if (
      await this.hasSpaceBoardsPermission(
        board.space_id,
        organizationId,
        userId,
        level,
      )
    ) {
      return board;
    }

    const { data: permission, error } = await this.client
      .from('board_permissions')
      .select('permission_level')
      .eq('board_id', boardId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    const permissionLevel = (
      permission as { permission_level?: BoardPermissionLevel } | null
    )?.permission_level;

    if (
      permissionLevel &&
      this.permissionRank(permissionLevel) >= this.permissionRank(level)
    ) {
      return board;
    }

    throw new ForbiddenException(
      `You do not have ${level} permission on this board`,
    );
  }

  private async logAction(
    organizationId: string,
    userId: string,
    entityType: string,
    entityId: string,
    action: 'create' | 'update' | 'delete' | 'archive' | 'restore',
    changes?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogsService.logAction(
        organizationId,
        userId,
        entityType,
        entityId,
        action,
        changes,
      );
    } catch {
      // Audit logging is best-effort and must not break board mutations.
    }
  }

  private async getColumnCardCount(
    boardId: string,
    columnId: string,
  ): Promise<number> {
    const { count, error } = await this.client
      .from(BoardsService.RANKINGS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('board_id', boardId)
      .eq('column_id', columnId);

    if (error) throw new BadRequestException(error.message);
    return count ?? 0;
  }

  /**
   * Legacy-compatible add-only saved-filter sync. This is deliberately
   * defensive because board rendering must not fail when a saved filter has an
   * invalid query, a deleted field, or a nested filter problem.
   */
  private async syncFilterTasks(board: Board, userId: string): Promise<number> {
    if (!board.filter_id || board.is_archived) return 0;

    try {
      const filterResult = await this.savedFiltersService.executeFilter(
        board.filter_id,
        board.organization_id,
        userId,
        { page: 1, pageSize: 10000 },
      );

      const filterTasks = filterResult.data.data.filter(
        (item) => item.entity_type === 'task',
      );
      if (filterTasks.length === 0) return 0;

      const { data: existing, error: existingError } = await this.client
        .from(BoardsService.RANKINGS_TABLE)
        .select('task_id')
        .eq('board_id', board.id);

      if (existingError) {
        throw new BadRequestException(existingError.message);
      }

      const existingTaskIds = new Set(
        ((existing ?? []) as Record<string, unknown>[]).map(
          (row) => row['task_id'] as string,
        ),
      );
      const candidateTaskIds = filterTasks
        .map((item) => item.id)
        .filter((id) => !existingTaskIds.has(id));

      if (candidateTaskIds.length === 0) return 0;

      const { data: taskRows, error: taskError } = await this.client
        .from('tasks')
        .select('id, organization_id, status_id, status')
        .eq('organization_id', board.organization_id)
        .in('id', candidateTaskIds);

      if (taskError) throw new BadRequestException(taskError.message);

      const validTaskRows = (taskRows ?? []) as Record<string, unknown>[];
      if (validTaskRows.length === 0) return 0;

      const { data: statusMappings, error: mappingError } = await this.client
        .from(BoardsService.COLUMN_STATUSES_TABLE)
        .select('status_id, column_id')
        .eq('board_id', board.id)
        .order('sort_order', { ascending: true });

      if (mappingError) throw new BadRequestException(mappingError.message);

      const statusToColumn = new Map<string, string>();
      for (const mapping of (statusMappings ?? []) as Record<
        string,
        unknown
      >[]) {
        const statusId = mapping['status_id'] as string;
        if (!statusToColumn.has(statusId)) {
          statusToColumn.set(statusId, mapping['column_id'] as string);
        }
      }

      const hasMissingStatusId = validTaskRows.some(
        (task) => !task['status_id'] && task['status'],
      );
      const statusKeyToId = new Map<string, string>();

      if (hasMissingStatusId && statusToColumn.size > 0) {
        const { data: statuses } = await this.client
          .from('task_statuses')
          .select('id, key')
          .in('id', [...statusToColumn.keys()]);

        for (const status of (statuses ?? []) as Record<string, unknown>[]) {
          statusKeyToId.set(status['key'] as string, status['id'] as string);
        }
      }

      const { data: columns, error: columnsError } = await this.client
        .from(BoardsService.COLUMNS_TABLE)
        .select('id')
        .eq('board_id', board.id)
        .order('sort_order', { ascending: true });

      if (columnsError) throw new BadRequestException(columnsError.message);
      const fallbackColumnId = (
        (columns ?? [])[0] as Record<string, unknown> | undefined
      )?.['id'] as string | undefined;

      if (!fallbackColumnId) return 0;

      const perBatchCounts = new Map<string, number>();
      const rankings = validTaskRows.map((task) => {
        let columnId =
          typeof task['status_id'] === 'string'
            ? statusToColumn.get(task['status_id'])
            : undefined;

        if (!columnId && task['status'] && statusKeyToId.size > 0) {
          const resolvedStatusId = statusKeyToId.get(task['status'] as string);
          if (resolvedStatusId) columnId = statusToColumn.get(resolvedStatusId);
        }

        columnId = columnId ?? fallbackColumnId;
        const batchIndex = perBatchCounts.get(columnId) ?? 0;
        perBatchCounts.set(columnId, batchIndex + 1);

        return {
          board_id: board.id,
          task_id: task['id'] as string,
          column_id: columnId,
          position: (batchIndex + 1) * 1000,
          sprint_id: null,
          version: 0,
        };
      });

      const offsets = new Map<string, number>();
      for (const ranking of rankings) {
        if (!offsets.has(ranking.column_id)) {
          offsets.set(
            ranking.column_id,
            await this.getColumnCardCount(board.id, ranking.column_id),
          );
        }
        ranking.position += (offsets.get(ranking.column_id) ?? 0) * 1000;
      }

      const { data: inserted, error: insertError } = await this.client
        .from(BoardsService.RANKINGS_TABLE)
        .upsert(rankings, {
          onConflict: 'board_id,task_id',
          ignoreDuplicates: true,
        })
        .select('id');

      if (insertError) throw new BadRequestException(insertError.message);
      return (inserted ?? []).length;
    } catch (error) {
      console.error('[BoardsService.syncFilterTasks] skipped filter sync', {
        boardId: board.id,
        filterId: board.filter_id,
        error: error as unknown,
      });

      return 0;
    }
  }

  private async syncCardColumnsByStatus(board: Board): Promise<number> {
    if (board.is_archived) return 0;

    try {
      const { data: rankings, error: rankingsError } = await this.client
        .from(BoardsService.RANKINGS_TABLE)
        .select('id, task_id, column_id')
        .eq('board_id', board.id);

      if (rankingsError) throw new BadRequestException(rankingsError.message);
      if (!rankings?.length) return 0;

      const taskIds = (rankings as Record<string, unknown>[]).map(
        (row) => row['task_id'] as string,
      );

      const { data: tasks, error: tasksError } = await this.client
        .from('tasks')
        .select('id, status_id')
        .eq('organization_id', board.organization_id)
        .in('id', taskIds);

      if (tasksError) throw new BadRequestException(tasksError.message);

      const taskStatusMap = new Map(
        ((tasks ?? []) as Record<string, unknown>[]).map((task) => [
          task['id'] as string,
          (task['status_id'] as string | null) ?? null,
        ]),
      );

      const { data: mappings, error: mappingsError } = await this.client
        .from(BoardsService.COLUMN_STATUSES_TABLE)
        .select('status_id, column_id')
        .eq('board_id', board.id)
        .order('sort_order', { ascending: true });

      if (mappingsError) throw new BadRequestException(mappingsError.message);
      if (!mappings?.length) return 0;

      const statusToColumn = new Map<string, string>();
      const columnStatusSet = new Map<string, Set<string>>();

      for (const mapping of mappings as Record<string, unknown>[]) {
        const statusId = mapping['status_id'] as string;
        const columnId = mapping['column_id'] as string;

        if (!statusToColumn.has(statusId))
          statusToColumn.set(statusId, columnId);
        if (!columnStatusSet.has(columnId))
          columnStatusSet.set(columnId, new Set());
        columnStatusSet.get(columnId)!.add(statusId);
      }

      const moves: { rankingId: string; targetColumnId: string }[] = [];
      for (const ranking of rankings as Record<string, unknown>[]) {
        const currentColumnId = ranking['column_id'] as string;
        const statusId = taskStatusMap.get(ranking['task_id'] as string);
        if (!statusId) continue;
        if (columnStatusSet.get(currentColumnId)?.has(statusId)) continue;

        const targetColumnId = statusToColumn.get(statusId);
        if (!targetColumnId) continue;
        moves.push({
          rankingId: ranking['id'] as string,
          targetColumnId,
        });
      }

      if (moves.length === 0) return 0;

      const targetColumnIds = [
        ...new Set(moves.map((move) => move.targetColumnId)),
      ];
      const columnCardCounts = new Map<string, number>();
      for (const columnId of targetColumnIds) {
        columnCardCounts.set(
          columnId,
          await this.getColumnCardCount(board.id, columnId),
        );
      }

      let moved = 0;
      const perColumnOffset = new Map<string, number>();
      for (const move of moves) {
        const offset = perColumnOffset.get(move.targetColumnId) ?? 0;
        const position =
          ((columnCardCounts.get(move.targetColumnId) ?? 0) + offset + 1) *
          1000;

        perColumnOffset.set(move.targetColumnId, offset + 1);

        const { error } = await this.client
          .from(BoardsService.RANKINGS_TABLE)
          .update({ column_id: move.targetColumnId, position })
          .eq('id', move.rankingId);

        if (!error) moved += 1;
      }

      return moved;
    } catch (err: unknown) {
      console.error(
        '[BoardsService.syncCardColumnsByStatus] skipped status sync',
        {
          boardId: board.id,
          error: err,
        },
      );

      return 0;
    }
  }

  // ------------------------------------------------------------------
  // Board CRUD
  // ------------------------------------------------------------------

  /**
   * Keys of the tasks each board task is linked to, either direction (XE-T532):
   * feeds the client-side "Linked to" quick-filter / swimlane rule. On-board keys
   * come from the board's own rows; off-board keys take one lookup, filtered by
   * the relationships panel's view check (only the spaces involved, cached per
   * space; org-level tasks follow org `can_view_tasks`).
   */
  private async resolveLinkedTaskKeys(
    organizationId: string,
    userId: string,
    taskRows: Record<string, unknown>[],
  ): Promise<Map<string, string[]>> {
    const keyById = new Map(
      taskRows.map((t) => [t['id'] as string, t['key'] as string | null]),
    );
    const linkedById = await fetchLinkedTaskIds(this.client, organizationId, [
      ...keyById.keys(),
    ]);

    const offBoard = new Set<string>();
    for (const linked of linkedById.values()) {
      for (const linkedId of linked) {
        if (!keyById.has(linkedId)) offBoard.add(linkedId);
      }
    }

    if (offBoard.size > 0) {
      const canView = createLinkViewCheck(
        this.permissionsService,
        organizationId,
        userId,
      );
      const offBoardKeys = await fetchTaskKeys(
        this.client,
        organizationId,
        [...offBoard],
        (spaceId) => canView(spaceId, 'view_tasks'),
      );
      for (const [linkedId, key] of offBoardKeys) keyById.set(linkedId, key);
    }

    const result = new Map<string, string[]>();
    for (const [taskId, linked] of linkedById) {
      result.set(
        taskId,
        [...linked]
          .map((linkedId) => keyById.get(linkedId))
          .filter((key): key is string => Boolean(key)),
      );
    }
    return result;
  }

  async getById(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<BoardViewData> {
    const board = await this.assertBoardAccess(
      id,
      organizationId,
      userId,
      'view',
    );

    await this.syncFilterTasks(board, userId);
    await this.syncCardColumnsByStatus(board);

    // Phase 1: fetch all structural data in parallel
    const [
      columnsResult,
      swimlanesResult,
      cardFieldsResult,
      quickFiltersResult,
      rankingsResult,
      columnStatusesResult,
      columnStatesResult,
      quickFilterStatesResult,
      activeSprintResult,
    ] = await Promise.all([
      this.client
        .from(BoardsService.COLUMNS_TABLE)
        .select('*')
        .eq('board_id', id)
        .order('sort_order', { ascending: true }),
      this.client
        .from(BoardsService.SWIMLANES_TABLE)
        .select('*')
        .eq('board_id', id)
        .order('sort_order', { ascending: true }),
      this.client
        .from(BoardsService.CARD_FIELDS_TABLE)
        .select('*')
        .eq('board_id', id)
        .order('position', { ascending: true }),
      this.client
        .from(BoardsService.QUICK_FILTERS_TABLE)
        .select('*')
        .eq('board_id', id)
        .order('sort_order', { ascending: true }),
      // Task rankings — positions of tasks on this board
      // Paged. This was a single unbounded select, which PostgREST caps at 1000
      // rows — so a board with more than 1000 cards rendered exactly 1000 and
      // silently lost the rest, with no error and no UI signal. Wrapped to resolve
      // in the same { data, error } shape so the destructuring below is unchanged.
      fetchAllRows<BoardRankingRow>(
        (from, to) =>
          this.client
            .from(BoardsService.RANKINGS_TABLE)
            .select('task_id, column_id, swimlane_id, position, version')
            .eq('board_id', id)
            .is('sprint_id', null)
            .order('position', { ascending: true })
            .order('task_id', { ascending: true })
            .range(from, to) as never,
      ).then((r) => ({
        data: r.rows,
        error: null as { message: string } | null,
      })),
      // Column status mappings
      this.client
        .from(BoardsService.COLUMN_STATUSES_TABLE)
        .select(
          'id, board_id, column_id, status_id, sort_order, status:task_statuses(id, name, color, icon)',
        )
        .eq('board_id', id)
        .order('sort_order', { ascending: true }),
      this.client
        .from('board_column_user_state')
        .select('column_id, is_collapsed')
        .eq('board_id', id)
        .eq('user_id', userId),
      this.client
        .from('board_quick_filter_user_state')
        .select('quick_filter_id, is_active')
        .eq('board_id', id)
        .eq('user_id', userId),
      board.board_type === 'scrum'
        ? this.client
            .from('sprints')
            .select('*')
            .eq('board_id', id)
            .eq('organization_id', organizationId)
            .eq('status', 'active')
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (columnsResult.error)
      throw new BadRequestException(columnsResult.error.message);
    if (swimlanesResult.error)
      throw new BadRequestException(swimlanesResult.error.message);
    if (cardFieldsResult.error)
      throw new BadRequestException(cardFieldsResult.error.message);
    if (quickFiltersResult.error)
      throw new BadRequestException(quickFiltersResult.error.message);
    if (rankingsResult.error)
      throw new BadRequestException(rankingsResult.error.message);
    if (columnStatesResult.error)
      throw new BadRequestException(columnStatesResult.error.message);
    if (quickFilterStatesResult.error)
      throw new BadRequestException(quickFilterStatesResult.error.message);
    if (activeSprintResult.error)
      throw new BadRequestException(activeSprintResult.error.message);

    let rankings = rankingsResult.data ?? [];

    if (board.board_type === 'scrum') {
      if (!activeSprintResult.data) {
        rankings = [];
      } else {
        // Paged for the same reason as the kanban path above.
        const sprintRankings = await fetchAllRows<BoardRankingRow>(
          (from, to) =>
            this.client
              .from(BoardsService.RANKINGS_TABLE)
              .select('task_id, column_id, swimlane_id, position, version')
              .eq('board_id', id)
              .eq('sprint_id', (activeSprintResult.data as { id: string }).id)
              .order('position', { ascending: true })
              .order('task_id', { ascending: true })
              .range(from, to) as never,
        );

        rankings = sprintRankings.rows;
      }
    }
    // `rankings` is now typed (BoardRankingRow[]), so the old cast-and-index
    // dance is unnecessary — and would no longer typecheck.
    const taskIds = [...new Set(rankings.map((r) => r.task_id))];

    // Phase 2: batch-fetch task details when there are tasks on the board
    let taskRows: Record<string, unknown>[] = [];
    if (taskIds.length > 0) {
      // Ticket 10: the card's Git badge (PR counts + build state), only with the licence.
      const gitDev = (
        await this.entitlementsService?.getEffectiveEntitlements(organizationId)
      )?.has('feature_external_integrations');
      const tasksResult = await this.client
        .from('tasks')
        .select(
          `id, key, summary, space_id, status_id, priority_id, assigned_to, task_type_id,
           due_date, start_date, labels, custom_field_values, created_at, updated_at,
           assignee:users!tasks_assigned_to_fkey(id, first_name, last_name, avatar_url),
           status_config:task_statuses!tasks_status_id_fkey(id, name, key, color, icon),
           priority_config:task_priorities!tasks_priority_id_fkey(id, name, key, color, icon)` +
            (gitDev ? `, ${GIT_DEV_SELECT}` : ''),
        )
        .eq('organization_id', organizationId)
        .in('id', taskIds);
      // Cast: a non-literal select string defeats supabase-js's row typing.
      if (!tasksResult.error)
        taskRows = (tasksResult.data ?? []) as unknown as Record<
          string,
          unknown
        >[];
    }

    let taskTypeLevels: Record<string, unknown>[] = [];
    if (board.space_id) {
      const { data: hierarchyConfig } = await this.client
        .from('task_hierarchy_configurations')
        .select('config')
        .eq('organization_id', organizationId)
        .eq('space_id', board.space_id)
        .maybeSingle();

      const config = hierarchyConfig?.config as
        | { levels?: Record<string, unknown>[] }
        | undefined;
      taskTypeLevels = Array.isArray(config?.levels) ? config.levels : [];
    }

    const subtaskCountMap = new Map<string, number>();
    const linkedItemCountMap = new Map<string, number>();
    let linkedTaskKeysMap = new Map<string, string[]>();

    if (taskIds.length > 0) {
      const [{ data: subtasks }, { data: linkedItems }, linkedKeys] =
        await Promise.all([
          this.client
            .from('tasks')
            .select('parent_task_id')
            .eq('organization_id', organizationId)
            .in('parent_task_id', taskIds),
          this.client
            .from('asset_item_links')
            .select('source_id')
            .eq('organization_id', organizationId)
            .eq('source_type', 'task')
            .in('source_id', taskIds),
          this.resolveLinkedTaskKeys(organizationId, userId, taskRows),
        ]);
      linkedTaskKeysMap = linkedKeys;

      for (const subtask of (subtasks ?? []) as Record<string, unknown>[]) {
        const parentId = subtask['parent_task_id'] as string | null;
        if (!parentId) continue;
        subtaskCountMap.set(parentId, (subtaskCountMap.get(parentId) ?? 0) + 1);
      }

      for (const link of (linkedItems ?? []) as Record<string, unknown>[]) {
        const taskId = link['source_id'] as string | null;
        if (!taskId) continue;
        linkedItemCountMap.set(
          taskId,
          (linkedItemCountMap.get(taskId) ?? 0) + 1,
        );
      }
    }

    const rawCardFields = (cardFieldsResult.data ?? []) as Record<
      string,
      unknown
    >[];
    const customFieldIds = rawCardFields
      .map((field) => field['custom_field_id'] as string | undefined)
      .filter((id): id is string => Boolean(id) && !id?.startsWith('__'));

    const customFieldMap = new Map<string, Record<string, unknown>>();
    if (customFieldIds.length > 0) {
      const { data: customFields } = await this.client
        .from('custom_fields')
        .select('id, name, field_type, field_key')
        .in('id', customFieldIds);

      for (const field of (customFields ?? []) as Record<string, unknown>[]) {
        customFieldMap.set(field['id'] as string, field);
      }
    }

    // Build lookup maps
    const taskById = new Map(taskRows.map((t) => [t['id'] as string, t]));

    // Group rankings by column (preserves position order from DB)
    const tasksByColumn = new Map<string, Record<string, unknown>[]>();
    for (const ranking of rankings) {
      const task = taskById.get(ranking.task_id);
      if (!task) continue;
      if (!tasksByColumn.has(ranking.column_id)) {
        tasksByColumn.set(ranking.column_id, []);
      }
      tasksByColumn.get(ranking.column_id)!.push({
        ...task,
        position: ranking.position,
        version: ranking.version,
        task_type:
          taskTypeLevels.find(
            (level) => level['id'] === task['task_type_id'],
          ) ?? null,
        subtask_count: subtaskCountMap.get(task['id'] as string) ?? 0,
        linked_item_count: linkedItemCountMap.get(task['id'] as string) ?? 0,
        linked_task_keys: linkedTaskKeysMap.get(task['id'] as string) ?? [],
      });
    }

    // Group column statuses by column_id
    const statusesByColumn = new Map<string, Record<string, unknown>[]>();
    for (const cs of columnStatusesResult.data ?? []) {
      if (!statusesByColumn.has(cs.column_id)) {
        statusesByColumn.set(cs.column_id, []);
      }
      statusesByColumn.get(cs.column_id)!.push(cs);
    }

    const collapseMap = new Map(
      ((columnStatesResult.data ?? []) as Record<string, unknown>[]).map(
        (state) => [
          state['column_id'] as string,
          (state['is_collapsed'] as boolean) ?? false,
        ],
      ),
    );

    const quickFilterStateMap = new Map(
      ((quickFilterStatesResult.data ?? []) as Record<string, unknown>[]).map(
        (state) => [
          state['quick_filter_id'] as string,
          (state['is_active'] as boolean) ?? false,
        ],
      ),
    );

    // Build columns enriched with tasks and statuses
    const columnsWithTasks = (
      (columnsResult.data ?? []) as Record<string, unknown>[]
    ).map((col) => ({
      ...col,
      tasks: tasksByColumn.get(col['id'] as string) ?? [],
      task_count: tasksByColumn.get(col['id'] as string)?.length ?? 0,
      statuses: statusesByColumn.get(col['id'] as string) ?? [],
      is_collapsed: collapseMap.get(col['id'] as string) ?? false,
    }));

    return {
      board,
      columns: columnsWithTasks as unknown as BoardColumn[],
      swimlanes: (swimlanesResult.data ?? []) as BoardSwimlane[],
      card_fields: rawCardFields.map((field) => ({
        ...field,
        custom_field:
          customFieldMap.get(field['custom_field_id'] as string) ?? null,
      })) as unknown as BoardCardField[],
      quick_filters: (
        (quickFiltersResult.data ?? []) as Record<string, unknown>[]
      ).map((filter) => ({
        ...filter,
        is_active: quickFilterStateMap.get(filter['id'] as string) ?? false,
      })) as unknown as BoardQuickFilter[],
      active_sprint: (activeSprintResult.data ?? null) as Record<
        string,
        unknown
      > | null,
    };
  }

  /** Lightweight lookup (no joins) used internally for org ownership checks. */
  private async getBoardOnly(
    id: string,
    organizationId: string,
  ): Promise<Board> {
    const r = await this.client
      .from(BoardsService.BOARDS_TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Board not found');
    return r.data as Board;
  }

  async getAll(
    organizationId: string,
    userId: string,
    spaceId: string,
    filters?: {
      board_type?: string;
      is_archived?: string;
      search?: string;
    },
    page = 1,
    pageSize = 20,
  ): Promise<BoardListResult> {
    if (!spaceId) throw new BadRequestException('space_id is required');

    await this.assertSpaceBoardsPermission(
      spaceId,
      organizationId,
      userId,
      'view',
    );

    let countQuery = this.client
      .from(BoardsService.BOARDS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);

    let query = this.client
      .from(BoardsService.BOARDS_TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);

    if (filters?.board_type) query = query.eq('board_type', filters.board_type);
    if (filters?.is_archived !== undefined) {
      query = query.eq('is_archived', filters.is_archived === 'true');
      countQuery = countQuery.eq('is_archived', filters.is_archived === 'true');
    }
    if (filters?.search) {
      const safe = filters.search.replace(/[,.()"'\\]/g, '');
      if (safe.length > 0) {
        query = query.ilike('name', `%${safe}%`);
        countQuery = countQuery.ilike('name', `%${safe}%`);
      }
    }
    if (filters?.board_type) {
      countQuery = countQuery.eq('board_type', filters.board_type);
    }

    const { count, error: countError } = await countQuery;
    if (countError) throw new BadRequestException(countError.message);

    const safePage = Math.max(Number(page) || 1, 1);
    const safePageSize = Math.min(Math.max(Number(pageSize) || 20, 1), 100);
    const from = (safePage - 1) * safePageSize;
    const to = from + safePageSize - 1;

    const r = await query
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })
      .range(from, to);
    if (r.error) throw new BadRequestException(r.error.message);
    const total = count ?? 0;
    return {
      data: (r.data ?? []) as Board[],
      total,
      page: safePage,
      pageSize: safePageSize,
      hasMore: total > safePage * safePageSize,
    };
  }

  async create(
    organizationId: string,
    userId: string,
    dto: CreateBoardDto,
  ): Promise<{ data: Board; success: true }> {
    await this.assertSpaceBoardsPermission(
      dto.space_id,
      organizationId,
      userId,
      'create',
    );

    if (dto.filter_id) {
      const { data: filter, error: filterError } = await this.client
        .from('saved_filters')
        .select('id')
        .eq('id', dto.filter_id)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (filterError) throw new BadRequestException(filterError.message);
      if (!filter) throw new NotFoundException('Filter not found');
    }

    const row = {
      organization_id: organizationId,
      space_id: dto.space_id,
      name: dto.name,
      description: dto.description ?? null,
      board_type: dto.board_type ?? 'kanban',
      filter_id: dto.filter_id ?? null,
      default_swimlane_name: dto.default_swimlane_name ?? 'Everything else',
      settings: dto.settings ?? {},
      sort_order: 0,
      is_archived: false,
      created_by: userId,
    };
    const r = await this.client
      .from(BoardsService.BOARDS_TABLE)
      .insert(row)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const board = r.data as Board;

    if (dto.auto_create_columns) {
      // `status_keys` is what makes a column able to hold anything: board cards
      // are derived ENTIRELY from board_column_statuses (see the status->column
      // map in getBoardCards). Columns alone are inert — a board created with
      // auto_create_columns but no mappings renders four permanently empty
      // columns, and the UI's only affordance ("Add New Item") creates a fresh
      // task that is equally unmappable, so the board can never show anything.
      // These are the built-in status keys; any a space has not defined are
      // skipped, and custom statuses stay unmapped for an admin to place.
      const defaultColumns = [
        { name: 'Backlog', sort_order: 0, is_backlog: true, status_keys: [] },
        { name: 'To Do', sort_order: 1, status_keys: ['todo', 'open'] },
        {
          name: 'In Progress',
          sort_order: 2,
          status_keys: ['in_progress', 'review', 'in_review', 'blocked'],
        },
        {
          name: 'Done',
          sort_order: 3,
          is_done: true,
          status_keys: ['done', 'closed'],
        },
      ];

      const cols = await this.client
        .from(BoardsService.COLUMNS_TABLE)
        .insert(
          defaultColumns.map(({ status_keys: _ignored, ...col }) => ({
            board_id: board.id,
            ...col,
            min_wip: 0,
            max_wip: 0,
            color: null,
            is_backlog: col.is_backlog ?? false,
            is_kanban_backlog: false,
            is_done: col.is_done ?? false,
          })),
        )
        .select('id, name');
      if (cols.error) throw new BadRequestException(cols.error.message);

      await this.mapDefaultColumnStatuses(
        board.id,
        organizationId,
        dto.space_id ?? null,
        (cols.data ?? []) as Array<{ id: string; name: string }>,
        defaultColumns,
      );
    }

    const swimlane = await this.client
      .from(BoardsService.SWIMLANES_TABLE)
      .insert({
        board_id: board.id,
        name: dto.default_swimlane_name ?? 'Everything else',
        is_default: true,
        sort_order: 0,
      });
    if (swimlane.error) throw new BadRequestException(swimlane.error.message);

    await this.client.from('board_permissions').insert({
      board_id: board.id,
      user_id: userId,
      permission_level: 'admin',
    });

    await this.logAction(organizationId, userId, 'board', board.id, 'create', {
      space_id: board.space_id,
      board_type: board.board_type,
      auto_create_columns: dto.auto_create_columns ?? false,
    });

    return { data: board, success: true };
  }

  /**
   * Attach the built-in statuses to freshly auto-created board columns.
   *
   * Statuses are resolved per (org, space): a space may override a built-in key
   * with its own row, and the space-specific row wins over the org-level one of
   * the same key. Keys the installation does not define are silently skipped —
   * a board with three of the four columns populated is still usable, whereas
   * failing the whole board creation over a missing optional status is not.
   */
  private async mapDefaultColumnStatuses(
    boardId: string,
    organizationId: string,
    spaceId: string | null,
    columns: Array<{ id: string; name: string }>,
    defaults: Array<{ name: string; status_keys?: string[] }>,
  ): Promise<void> {
    if (columns.length === 0) return;

    let query = this.client
      .from('task_statuses')
      .select('id, key, space_id')
      .eq('organization_id', organizationId);

    query = spaceId
      ? query.or(`space_id.eq.${spaceId},space_id.is.null`)
      : query.is('space_id', null);

    const { data: statusRows, error } = await query;

    if (error) {
      // Non-fatal: the board and its columns already exist. Losing the mapping
      // leaves an admin one settings screen away from a working board, which is
      // strictly better than rolling back a board the user asked for.
      this.logger.warn(
        `Board ${boardId}: could not load task_statuses to map default columns: ${error.message}`,
      );
      return;
    }

    const statusIdByKey = new Map<string, string>();
    for (const row of (statusRows ?? []) as Array<{
      id: string;
      key: string;
      space_id: string | null;
    }>) {
      // Space-specific rows overwrite the org-level row for the same key.
      if (row.space_id || !statusIdByKey.has(row.key)) {
        statusIdByKey.set(row.key, row.id);
      }
    }
    if (statusIdByKey.size === 0) return;

    const keysByColumnName = new Map(
      defaults.map((d) => [d.name, d.status_keys ?? []]),
    );

    const mappings = columns.flatMap((col) =>
      (keysByColumnName.get(col.name) ?? [])
        .map((key) => statusIdByKey.get(key))
        .filter((statusId): statusId is string => Boolean(statusId))
        .map((statusId, index) => ({
          board_id: boardId,
          column_id: col.id,
          status_id: statusId,
          sort_order: index,
        })),
    );
    if (mappings.length === 0) return;

    const inserted = await this.client
      .from(BoardsService.COLUMN_STATUSES_TABLE)
      .insert(mappings);

    if (inserted.error) {
      this.logger.warn(
        `Board ${boardId}: could not map default column statuses: ${inserted.error.message}`,
      );
    }
  }

  async update(
    id: string,
    organizationId: string,
    userId: string,
    dto: UpdateBoardDto,
  ): Promise<{ data: Board; success: true }> {
    await this.assertBoardAccess(id, organizationId, userId, 'admin');

    const patch: Record<string, unknown> = {};
    for (const key of [
      'name',
      'description',
      'board_type',
      'default_swimlane_name',
      'filter_id',
      'settings',
      'is_archived',
      'sort_order',
    ] as const) {
      if (dto[key] !== undefined) patch[key] = dto[key];
    }

    if (Object.keys(patch).length === 0) {
      const existing = await this.getBoardOnly(id, organizationId);
      return { data: existing, success: true };
    }

    if (patch['filter_id']) {
      const { data: filter, error: filterError } = await this.client
        .from('saved_filters')
        .select('id')
        .eq('id', patch['filter_id'] as string)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (filterError) throw new BadRequestException(filterError.message);
      if (!filter) throw new NotFoundException('Filter not found');
    }

    const r = await this.client
      .from(BoardsService.BOARDS_TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const board = r.data as Board;
    await this.logAction(organizationId, userId, 'board', id, 'update', patch);
    return { data: board, success: true };
  }

  async delete(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const board = await this.assertBoardAccess(
      id,
      organizationId,
      userId,
      'admin',
    );

    if (!board.is_archived) {
      throw new BadRequestException(
        'Board must be archived before it can be deleted',
      );
    }

    // Delete all related data in order
    for (const table of [
      'board_quick_filter_user_state',
      'board_column_user_state',
      'board_permissions',
      'sprints',
      BoardsService.RANKINGS_TABLE,
      BoardsService.COLUMN_STATUSES_TABLE,
      BoardsService.COLUMNS_TABLE,
      BoardsService.SWIMLANES_TABLE,
      BoardsService.CARD_FIELDS_TABLE,
      BoardsService.QUICK_FILTERS_TABLE,
    ]) {
      const r = await this.client.from(table).delete().eq('board_id', id);
      if (r.error) throw new BadRequestException(r.error.message);
    }

    const r = await this.client
      .from(BoardsService.BOARDS_TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);
    if (r.error) throw new BadRequestException(r.error.message);
    await this.logAction(organizationId, userId, 'board', id, 'delete', {
      space_id: board.space_id,
    });
  }

  async archiveBoard(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Board; success: true }> {
    await this.assertBoardAccess(id, organizationId, userId, 'admin');

    const r = await this.client
      .from(BoardsService.BOARDS_TABLE)
      .update({ is_archived: true })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (r.error) throw new BadRequestException(r.error.message);
    const board = r.data as Board;
    await this.logAction(organizationId, userId, 'board', id, 'archive');
    return { data: board, success: true };
  }

  async unarchiveBoard(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: Board; success: true }> {
    await this.assertBoardAccess(id, organizationId, userId, 'admin');

    const r = await this.client
      .from(BoardsService.BOARDS_TABLE)
      .update({ is_archived: false })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (r.error) throw new BadRequestException(r.error.message);
    const board = r.data as Board;
    await this.logAction(organizationId, userId, 'board', id, 'restore');
    return { data: board, success: true };
  }

  // ------------------------------------------------------------------
  // Columns
  // ------------------------------------------------------------------

  async createColumn(
    boardId: string,
    organizationId: string,
    userId: string,
    dto: CreateColumnDto,
  ): Promise<{ data: BoardColumn; success: true }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');

    let sortOrder = dto.sort_order;
    if (sortOrder === undefined) {
      const { data: maxRow } = await this.client
        .from(BoardsService.COLUMNS_TABLE)
        .select('sort_order')
        .eq('board_id', boardId)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();

      sortOrder =
        ((maxRow as { sort_order?: number } | null)?.sort_order ?? -1) + 1;
    }

    const row = {
      board_id: boardId,
      name: dto.name,
      sort_order: sortOrder,
      min_wip: dto.min_wip ?? 0,
      max_wip: dto.max_wip ?? 0,
      color: dto.color ?? null,
      is_backlog: dto.is_backlog ?? false,
      is_kanban_backlog: dto.is_kanban_backlog ?? false,
      is_done: dto.is_done ?? false,
    };
    const r = await this.client
      .from(BoardsService.COLUMNS_TABLE)
      .insert(row)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const column = r.data as BoardColumn;
    await this.logAction(
      organizationId,
      userId,
      'board_column',
      column.id,
      'create',
      {
        board_id: boardId,
        name: column.name,
      },
    );
    return { data: column, success: true };
  }

  async updateColumn(
    boardId: string,
    columnId: string,
    organizationId: string,
    userId: string,
    dto: UpdateColumnDto,
  ): Promise<{ data: BoardColumn; success: true }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');

    const existing = await this.client
      .from(BoardsService.COLUMNS_TABLE)
      .select('*')
      .eq('id', columnId)
      .eq('board_id', boardId)
      .maybeSingle();
    if (!existing.data) throw new NotFoundException('Column not found');

    const patch: Record<string, unknown> = {};
    for (const key of [
      'name',
      'sort_order',
      'min_wip',
      'max_wip',
      'color',
      'is_backlog',
      'is_kanban_backlog',
      'is_done',
    ] as const) {
      if (dto[key] !== undefined) patch[key] = dto[key];
    }

    const current = existing.data as BoardColumn;
    const effectiveMin =
      (patch['min_wip'] as number | undefined) ?? current.min_wip ?? 0;
    const effectiveMax =
      (patch['max_wip'] as number | undefined) ?? current.max_wip ?? 0;

    if (effectiveMax > 0 && effectiveMin > 0 && effectiveMax < effectiveMin) {
      throw new BadRequestException(
        'Max WIP limit must be greater than or equal to min WIP limit',
      );
    }

    if (Object.keys(patch).length === 0) {
      return { data: current, success: true };
    }

    const r = await this.client
      .from(BoardsService.COLUMNS_TABLE)
      .update(patch)
      .eq('id', columnId)
      .eq('board_id', boardId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const column = r.data as BoardColumn;
    await this.logAction(
      organizationId,
      userId,
      'board_column',
      columnId,
      'update',
      {
        board_id: boardId,
        ...patch,
      },
    );
    return { data: column, success: true };
  }

  async deleteColumn(
    boardId: string,
    columnId: string,
    organizationId: string,
    userId: string,
    targetColumnId?: string,
  ): Promise<void> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');

    const count = await this.client
      .from(BoardsService.RANKINGS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('board_id', boardId)
      .eq('column_id', columnId);
    if (count.error) throw new BadRequestException(count.error.message);
    const hasCards = (count.count ?? 0) > 0;

    if (hasCards && !targetColumnId) {
      throw new BadRequestException(
        'Column has cards; provide target_column_id to move them',
      );
    }

    if (hasCards && targetColumnId) {
      const moved = await this.client
        .from(BoardsService.RANKINGS_TABLE)
        .update({ column_id: targetColumnId })
        .eq('board_id', boardId)
        .eq('column_id', columnId);
      if (moved.error) throw new BadRequestException(moved.error.message);
    }

    const r1 = await this.client
      .from(BoardsService.COLUMN_STATUSES_TABLE)
      .delete()
      .eq('column_id', columnId);
    if (r1.error) throw new BadRequestException(r1.error.message);

    const r2 = await this.client
      .from(BoardsService.COLUMNS_TABLE)
      .delete()
      .eq('id', columnId)
      .eq('board_id', boardId);
    if (r2.error) throw new BadRequestException(r2.error.message);
    await this.logAction(
      organizationId,
      userId,
      'board_column',
      columnId,
      'delete',
      {
        board_id: boardId,
        target_column_id: targetColumnId ?? null,
      },
    );
  }

  async reorderColumns(
    boardId: string,
    organizationId: string,
    userId: string,
    items: { id: string; sort_order: number }[],
  ): Promise<void> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');

    for (const item of items) {
      const r = await this.client
        .from(BoardsService.COLUMNS_TABLE)
        .update({ sort_order: item.sort_order })
        .eq('id', item.id)
        .eq('board_id', boardId);

      if (r.error) throw new BadRequestException(r.error.message);
    }
    await this.logAction(
      organizationId,
      userId,
      'board_column',
      boardId,
      'update',
      {
        scope: 'reorder',
        columns: items,
      },
    );
  }

  // ------------------------------------------------------------------
  // Status mappings
  // ------------------------------------------------------------------

  async mapStatusToColumn(
    boardId: string,
    organizationId: string,
    userId: string,
    dto: { column_id: string; status_id: string; sort_order?: number },
  ): Promise<Record<string, unknown>> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');

    const r = await this.client
      .from(BoardsService.COLUMN_STATUSES_TABLE)
      .insert({
        board_id: boardId,
        column_id: dto.column_id,
        status_id: dto.status_id,
        sort_order: dto.sort_order ?? 0,
      })
      .select()
      .single();

    if (r.error) throw new BadRequestException(r.error.message);
    await this.logAction(
      organizationId,
      userId,
      'board_status_mapping',
      (r.data as Record<string, unknown>)['id'] as string,
      'create',
      {
        board_id: boardId,
        column_id: dto.column_id,
        status_id: dto.status_id,
      },
    );
    return r.data as Record<string, unknown>;
  }

  async unmapStatus(
    boardId: string,
    organizationId: string,
    userId: string,
    mappingId: string,
  ): Promise<void> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');

    const r = await this.client
      .from(BoardsService.COLUMN_STATUSES_TABLE)
      .delete()
      .eq('id', mappingId)
      .eq('board_id', boardId);

    if (r.error) throw new BadRequestException(r.error.message);
    await this.logAction(
      organizationId,
      userId,
      'board_status_mapping',
      mappingId,
      'delete',
      {
        board_id: boardId,
      },
    );
  }

  async getUnmappedStatuses(
    boardId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown>[]> {
    const board = await this.assertBoardAccess(
      boardId,
      organizationId,
      userId,
      'admin',
    );

    // Get all statuses for the space
    const { data: allStatuses, error: statusError } = await this.client
      .from('task_statuses')
      .select('id, name, color, icon')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .or(`space_id.is.null,space_id.eq.${board.space_id}`)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });

    if (statusError) throw new BadRequestException(statusError.message);

    // Get already-mapped status IDs for this board
    const { data: mapped, error: mappedError } = await this.client
      .from(BoardsService.COLUMN_STATUSES_TABLE)
      .select('status_id')
      .eq('board_id', boardId);

    if (mappedError) throw new BadRequestException(mappedError.message);

    const mappedIds = new Set(
      ((mapped ?? []) as Record<string, unknown>[]).map(
        (m) => m['status_id'] as string,
      ),
    );

    return ((allStatuses ?? []) as Record<string, unknown>[]).filter(
      (s) => !mappedIds.has(s['id'] as string),
    );
  }

  // ------------------------------------------------------------------
  // User state — column collapse
  // ------------------------------------------------------------------

  async toggleColumnCollapse(
    boardId: string,
    columnId: string,
    userId: string,
    organizationId: string,
  ): Promise<{ is_collapsed: boolean }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'view');

    // Upsert into board_column_user_state
    const { data: existing } = await this.client
      .from('board_column_user_state')
      .select('id, is_collapsed')
      .eq('board_id', boardId)
      .eq('column_id', columnId)
      .eq('user_id', userId)
      .maybeSingle();

    const newState = !(existing as Record<string, unknown> | null)?.[
      'is_collapsed'
    ];

    if (existing) {
      await this.client
        .from('board_column_user_state')
        .update({ is_collapsed: newState })
        .eq('id', (existing as Record<string, unknown>)['id'] as string);
    } else {
      await this.client.from('board_column_user_state').insert({
        board_id: boardId,
        column_id: columnId,
        user_id: userId,
        is_collapsed: newState,
      });
    }

    return { is_collapsed: newState };
  }

  async setQuickFilterActive(
    boardId: string,
    filterId: string,
    userId: string,
    organizationId: string,
    isActive: boolean,
  ): Promise<{ success: true }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'view');

    const { data: filter, error: filterError } = await this.client
      .from(BoardsService.QUICK_FILTERS_TABLE)
      .select('id')
      .eq('id', filterId)
      .eq('board_id', boardId)
      .maybeSingle();

    if (filterError) throw new BadRequestException(filterError.message);
    if (!filter) throw new NotFoundException('Quick filter not found');

    const { error } = await this.client
      .from('board_quick_filter_user_state')
      .upsert(
        {
          board_id: boardId,
          quick_filter_id: filterId,
          user_id: userId,
          is_active: isActive,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'quick_filter_id,user_id' },
      );

    if (error) throw new BadRequestException(error.message);

    return { success: true };
  }

  // ------------------------------------------------------------------
  // Swimlanes
  // ------------------------------------------------------------------

  async getSwimlanes(
    boardId: string,
    organizationId: string,
    userId: string,
  ): Promise<BoardSwimlane[]> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'view');
    const r = await this.client
      .from(BoardsService.SWIMLANES_TABLE)
      .select('*')
      .eq('board_id', boardId)
      .order('sort_order', { ascending: true });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as BoardSwimlane[];
  }

  async createSwimlane(
    boardId: string,
    organizationId: string,
    userId: string,
    dto: {
      name: string;
      query?: string;
      // Declared because the insert below already writes it; it was previously reachable only
      // through an inline cast, so callers could not pass it without lying to the compiler.
      description?: string | null;
      sort_order?: number;
      is_default?: boolean;
    },
  ): Promise<{ data: BoardSwimlane; success: true }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');

    let sortOrder = dto.sort_order;
    if (sortOrder === undefined) {
      const { data: maxRow } = await this.client
        .from(BoardsService.SWIMLANES_TABLE)
        .select('sort_order')
        .eq('board_id', boardId)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();

      sortOrder =
        ((maxRow as { sort_order?: number } | null)?.sort_order ?? -1) + 1;
    }

    const r = await this.client
      .from(BoardsService.SWIMLANES_TABLE)
      .insert({
        board_id: boardId,
        name: dto.name,
        query: dto.query ?? null,
        description: dto.description ?? null,
        sort_order: sortOrder,
        is_default: dto.is_default ?? false,
      })
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const swimlane = r.data as BoardSwimlane;
    await this.logAction(
      organizationId,
      userId,
      'board_swimlane',
      swimlane.id,
      'create',
      {
        board_id: boardId,
        name: swimlane.name,
      },
    );
    return { data: swimlane, success: true };
  }

  async updateSwimlane(
    boardId: string,
    swimlaneId: string,
    organizationId: string,
    userId: string,
    dto: {
      name?: string;
      query?: string;
      sort_order?: number;
      is_default?: boolean;
    },
  ): Promise<{ data: BoardSwimlane; success: true }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.query !== undefined) patch['query'] = dto.query;
    if ((dto as { description?: string | null }).description !== undefined) {
      patch['description'] = (
        dto as { description?: string | null }
      ).description;
    }
    if (dto.sort_order !== undefined) patch['sort_order'] = dto.sort_order;
    if (dto.is_default !== undefined) patch['is_default'] = dto.is_default;

    if (Object.keys(patch).length === 0) {
      const existing = await this.client
        .from(BoardsService.SWIMLANES_TABLE)
        .select('*')
        .eq('id', swimlaneId)
        .eq('board_id', boardId)
        .maybeSingle();
      if (existing.error) throw new BadRequestException(existing.error.message);
      if (!existing.data) throw new NotFoundException('Swimlane not found');
      return { data: existing.data as BoardSwimlane, success: true };
    }

    const r = await this.client
      .from(BoardsService.SWIMLANES_TABLE)
      .update(patch)
      .eq('id', swimlaneId)
      .eq('board_id', boardId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Swimlane not found');
    const swimlane = r.data as BoardSwimlane;
    await this.logAction(
      organizationId,
      userId,
      'board_swimlane',
      swimlaneId,
      'update',
      {
        board_id: boardId,
        ...patch,
      },
    );
    return { data: swimlane, success: true };
  }

  async deleteSwimlane(
    boardId: string,
    swimlaneId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');
    const existing = await this.client
      .from(BoardsService.SWIMLANES_TABLE)
      .select('is_default')
      .eq('id', swimlaneId)
      .eq('board_id', boardId)
      .maybeSingle();
    if (!existing.data) throw new NotFoundException('Swimlane not found');
    if ((existing.data as { is_default: boolean }).is_default) {
      throw new BadRequestException('Cannot delete the default swimlane');
    }
    const r = await this.client
      .from(BoardsService.SWIMLANES_TABLE)
      .delete()
      .eq('id', swimlaneId)
      .eq('board_id', boardId);
    if (r.error) throw new BadRequestException(r.error.message);
    await this.logAction(
      organizationId,
      userId,
      'board_swimlane',
      swimlaneId,
      'delete',
      {
        board_id: boardId,
      },
    );
  }

  async reorderSwimlanes(
    boardId: string,
    organizationId: string,
    userId: string,
    items: { id: string; sort_order: number }[],
  ): Promise<void> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');
    for (const item of items) {
      const r = await this.client
        .from(BoardsService.SWIMLANES_TABLE)
        .update({ sort_order: item.sort_order })
        .eq('id', item.id)
        .eq('board_id', boardId);
      if (r.error) throw new BadRequestException(r.error.message);
    }
    await this.logAction(
      organizationId,
      userId,
      'board_swimlane',
      boardId,
      'update',
      {
        scope: 'reorder',
        swimlanes: items,
      },
    );
  }

  // ------------------------------------------------------------------
  // Card Fields
  // ------------------------------------------------------------------

  async getCardFields(
    boardId: string,
    organizationId: string,
    userId: string,
  ): Promise<BoardCardField[]> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'view');
    const r = await this.client
      .from(BoardsService.CARD_FIELDS_TABLE)
      .select('*')
      .eq('board_id', boardId)
      .order('position', { ascending: true });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as BoardCardField[];
  }

  async setCardFields(
    boardId: string,
    organizationId: string,
    userId: string,
    fields: {
      custom_field_id: string;
      position: number;
      width?: string;
      color?: string;
    }[],
  ): Promise<{ data: BoardCardField[]; success: true }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');

    // Atomic replace: delete existing then insert new
    const del = await this.client
      .from(BoardsService.CARD_FIELDS_TABLE)
      .delete()
      .eq('board_id', boardId);
    if (del.error) throw new BadRequestException(del.error.message);

    if (fields.length === 0) {
      await this.logAction(
        organizationId,
        userId,
        'board_card_field',
        boardId,
        'update',
        {
          scope: 'replace',
          count: 0,
        },
      );
      return { data: [], success: true };
    }

    const rows = fields.map((f) => ({
      board_id: boardId,
      custom_field_id: f.custom_field_id,
      position: f.position,
      width: f.width ?? null,
      color: f.color ?? null,
    }));
    const r = await this.client
      .from(BoardsService.CARD_FIELDS_TABLE)
      .insert(rows)
      .select();
    if (r.error) throw new BadRequestException(r.error.message);
    const data = (r.data ?? []) as BoardCardField[];
    await this.logAction(
      organizationId,
      userId,
      'board_card_field',
      boardId,
      'update',
      {
        scope: 'replace',
        count: data.length,
      },
    );
    return { data, success: true };
  }

  // ------------------------------------------------------------------
  // Quick Filters
  // ------------------------------------------------------------------

  async getQuickFilters(
    boardId: string,
    organizationId: string,
    userId: string,
  ): Promise<BoardQuickFilter[]> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'view');
    const r = await this.client
      .from(BoardsService.QUICK_FILTERS_TABLE)
      .select('*')
      .eq('board_id', boardId)
      .order('sort_order', { ascending: true });
    if (r.error) throw new BadRequestException(r.error.message);
    return (r.data ?? []) as BoardQuickFilter[];
  }

  async createQuickFilter(
    boardId: string,
    organizationId: string,
    userId: string,
    dto: {
      name: string;
      query?: string;
      description?: string;
      sort_order?: number;
      is_enabled?: boolean;
    },
  ): Promise<{ data: BoardQuickFilter; success: true }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');
    let sortOrder = dto.sort_order;
    if (sortOrder === undefined) {
      const { data: maxRow } = await this.client
        .from(BoardsService.QUICK_FILTERS_TABLE)
        .select('sort_order')
        .eq('board_id', boardId)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle();

      sortOrder =
        ((maxRow as { sort_order?: number } | null)?.sort_order ?? -1) + 1;
    }

    const r = await this.client
      .from(BoardsService.QUICK_FILTERS_TABLE)
      .insert({
        board_id: boardId,
        name: dto.name,
        query: dto.query ?? null,
        description: dto.description ?? null,
        sort_order: sortOrder,
        is_enabled: dto.is_enabled ?? true,
        created_by: userId,
      })
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    const filter = r.data as BoardQuickFilter;
    await this.logAction(
      organizationId,
      userId,
      'board_quick_filter',
      filter.id,
      'create',
      {
        board_id: boardId,
        name: filter.name,
      },
    );
    return { data: filter, success: true };
  }

  async updateQuickFilter(
    boardId: string,
    filterId: string,
    organizationId: string,
    userId: string,
    dto: {
      name?: string;
      query?: string;
      description?: string;
      sort_order?: number;
      is_enabled?: boolean;
    },
  ): Promise<{ data: BoardQuickFilter; success: true }> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch['name'] = dto.name;
    if (dto.query !== undefined) patch['query'] = dto.query;
    if (dto.description !== undefined) patch['description'] = dto.description;
    if (dto.sort_order !== undefined) patch['sort_order'] = dto.sort_order;
    if (dto.is_enabled !== undefined) patch['is_enabled'] = dto.is_enabled;

    if (Object.keys(patch).length === 0) {
      const existing = await this.client
        .from(BoardsService.QUICK_FILTERS_TABLE)
        .select('*')
        .eq('id', filterId)
        .eq('board_id', boardId)
        .maybeSingle();
      if (existing.error) throw new BadRequestException(existing.error.message);
      if (!existing.data) throw new NotFoundException('Quick filter not found');
      return { data: existing.data as BoardQuickFilter, success: true };
    }

    patch['updated_at'] = new Date().toISOString();

    const r = await this.client
      .from(BoardsService.QUICK_FILTERS_TABLE)
      .update(patch)
      .eq('id', filterId)
      .eq('board_id', boardId)
      .select()
      .single();
    if (r.error) throw new BadRequestException(r.error.message);
    if (!r.data) throw new NotFoundException('Quick filter not found');
    const filter = r.data as BoardQuickFilter;
    await this.logAction(
      organizationId,
      userId,
      'board_quick_filter',
      filterId,
      'update',
      {
        board_id: boardId,
        ...patch,
      },
    );
    return { data: filter, success: true };
  }

  async deleteQuickFilter(
    boardId: string,
    filterId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');
    const r = await this.client
      .from(BoardsService.QUICK_FILTERS_TABLE)
      .delete()
      .eq('id', filterId)
      .eq('board_id', boardId);
    if (r.error) throw new BadRequestException(r.error.message);
    await this.logAction(
      organizationId,
      userId,
      'board_quick_filter',
      filterId,
      'delete',
      {
        board_id: boardId,
      },
    );
  }

  async reorderQuickFilters(
    boardId: string,
    organizationId: string,
    userId: string,
    items: { id: string; sort_order: number }[],
  ): Promise<void> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'admin');
    for (const item of items) {
      const r = await this.client
        .from(BoardsService.QUICK_FILTERS_TABLE)
        .update({ sort_order: item.sort_order })
        .eq('id', item.id)
        .eq('board_id', boardId);
      if (r.error) throw new BadRequestException(r.error.message);
    }
    await this.logAction(
      organizationId,
      userId,
      'board_quick_filter',
      boardId,
      'update',
      {
        scope: 'reorder',
        filters: items,
      },
    );
  }

  // ------------------------------------------------------------------
  // Card operations
  // ------------------------------------------------------------------

  async moveCard(
    boardId: string,
    organizationId: string,
    userId: string,
    dto: MoveCardDto,
  ): Promise<{ data: unknown; success: true }> {
    const board = await this.assertBoardAccess(
      boardId,
      organizationId,
      userId,
      'edit',
    );

    if (dto.expected_version === undefined || dto.expected_version === null) {
      throw new BadRequestException('expected_version is required');
    }

    const { data: task, error: taskError } = await this.client
      .from('tasks')
      .select(
        'id, key, summary, space_id, status, status_id, priority, assigned_to, task_type_id',
      )
      .eq('id', dto.task_id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (taskError) throw new BadRequestException(taskError.message);
    if (!task) throw new NotFoundException('Task not found');
    if ((task as Record<string, unknown>)['space_id'] !== board.space_id) {
      throw new BadRequestException('Task does not belong to this board space');
    }

    const { data: targetColumn, error: targetColumnError } = await this.client
      .from(BoardsService.COLUMNS_TABLE)
      .select('id, max_wip')
      .eq('id', dto.target_column_id)
      .eq('board_id', boardId)
      .maybeSingle();

    if (targetColumnError)
      throw new BadRequestException(targetColumnError.message);
    if (!targetColumn) throw new NotFoundException('Target column not found');

    const settings = board.settings ?? {};
    const shouldEnforceWip =
      settings['enforce_wip_limits'] === true &&
      dto.source_column_id !== dto.target_column_id;
    const targetMaxWip = Number(
      (targetColumn as Record<string, unknown>)['max_wip'] ?? 0,
    );
    if (shouldEnforceWip && targetMaxWip > 0) {
      const currentCount = await this.getColumnCardCount(
        boardId,
        dto.target_column_id,
      );
      if (currentCount >= targetMaxWip) {
        throw new BadRequestException(
          `Column WIP limit reached (${targetMaxWip}). Cannot move more cards to this column.`,
        );
      }
    }

    // Workflow engine routing: when the task's type has an active workflow
    // assignment and this cross-column move changes the task's status, run the
    // status change through the engine (conditions/validators/post-functions +
    // `workflow.transition.executed` audit + task.version bump) BEFORE the move.
    // The move_board_card RPC below then sets the SAME status idempotently and
    // handles positioning. Non-workflow boards skip this block entirely, so the
    // legacy behaviour is unchanged.
    // Set when the workflow engine handles the status change, because it emits
    // app.task.status_changed itself. The RPC fallback below emits only when it did not.
    let transitionEmitted = false;

    if (
      this.engine &&
      this.assignments &&
      dto.source_column_id !== dto.target_column_id
    ) {
      const taskRow = task as Record<string, unknown>;
      const assignment = await this.assignments.findActiveAssignmentForType(
        organizationId,
        (taskRow['space_id'] as string) ?? '',
        (taskRow['task_type_id'] as string) ?? '*',
      );

      if (assignment) {
        // Resolve the target column's first mapped status — the SAME rule the
        // move_board_card RPC uses — so the engine and the RPC agree on the
        // destination status (avoids a double-write to a different status).
        const { data: mapping } = await this.client
          .from(BoardsService.COLUMN_STATUSES_TABLE)
          .select('status_id')
          .eq('board_id', boardId)
          .eq('column_id', dto.target_column_id)
          .order('sort_order', { ascending: true })
          .limit(1)
          .maybeSingle();

        const targetStatusId =
          (mapping as { status_id?: string } | null)?.status_id ?? null;

        // Only route through the engine when the move actually changes status.
        if (targetStatusId && targetStatusId !== taskRow['status_id']) {
          const engineUser = {
            userId,
            organizationId,
            authUserId: userId,
            email: '',
          } as unknown as RequestUser;

          const resolution = await this.engine.resolveTransitionByStatusChange(
            dto.task_id,
            targetStatusId,
            engineUser,
          );

          if ('error' in resolution) {
            if (resolution.error === 'multiple_paths') {
              throw new ConflictException(
                'Multiple workflow transitions reach this column — open the task to choose one.',
              );
            }

            throw new UnprocessableEntityException(
              'No workflow transition allows moving this task to that column.',
            );
          }

          // Runs rules, changes status, writes the transition audit row, and
          // bumps tasks.version. Throws 422 (validator) / 409 (concurrency) /
          // 403 (condition) — propagated so the card snaps back without moving.
          await this.engine.executeTransition({
            taskId: dto.task_id,
            transitionId: resolution.transition.id,
            user: engineUser,
          });

          // executeTransition emits app.task.status_changed itself. Record that so the
          // fallback below does not emit a second event for the same move.
          transitionEmitted = true;
        }
      }
    }

    const updated = await this.client.rpc('move_board_card', {
      p_board_id: boardId,
      p_task_id: dto.task_id,
      p_source_column_id: dto.source_column_id,
      p_target_column_id: dto.target_column_id,
      p_new_position: dto.new_position,
      p_expected_version: dto.expected_version,
      p_user_id: userId,
      p_organization_id: organizationId,
    });

    if (updated.error) {
      const message = updated.error.message ?? 'Failed to move card';
      if (message.includes('Board state changed')) {
        throw new ConflictException('Board state changed — refresh and retry');
      }
      if (
        message.includes('Card not found') ||
        message.includes('Target column not found') ||
        message.includes('Task not found')
      ) {
        throw new NotFoundException(message);
      }
      throw new BadRequestException(message);
    }
    if (!updated.data) {
      throw new ConflictException('Board state changed — refresh and retry');
    }

    // Boards with no workflow assignment let move_board_card write status_id directly, and that
    // RPC writes no outbox row — so a drag used to change status with no automation firing at
    // all. Re-read rather than trusting the target column's mapping, so a same-column reorder
    // (status unchanged) correctly emits nothing.
    if (!transitionEmitted && this.outboxService) {
      const before = task as unknown as TaskStatusChangedSnapshot;

      const { data: afterRow } = await this.client
        .from('tasks')
        .select(
          'id, key, summary, status, status_id, priority, assigned_to, space_id',
        )
        .eq('id', dto.task_id)
        .eq('organization_id', organizationId)
        .maybeSingle();

      const after = afterRow as TaskStatusChangedSnapshot | null;

      if (after && after.status_id !== before.status_id) {
        this.outboxService.emitTaskStatusChanged(
          organizationId,
          { status: before.status, status_id: before.status_id },
          after,
          userId,
        );
      }
    }

    await this.logAction(
      organizationId,
      userId,
      'board_card',
      dto.task_id,
      'update',
      {
        board_id: boardId,
        source_column_id: dto.source_column_id,
        target_column_id: dto.target_column_id,
        new_position: dto.new_position,
      },
    );
    return { data: updated.data, success: true };
  }

  async reorderCards(
    boardId: string,
    organizationId: string,
    userId: string,
    dto: ReorderCardsDto,
  ): Promise<void> {
    await this.assertBoardAccess(boardId, organizationId, userId, 'edit');

    // Previously one sequential UPDATE per card. Every DB call here is a PostgREST
    // HTTP round trip, so dragging a card in a 500-card column cost 500 sequential
    // requests — seconds of latency for what the user experiences as one drag, and
    // it scales with column size, so only large boards feel it.
    //
    // Now two requests regardless of column size: read the affected rows, then one
    // bulk upsert.
    //
    // Whole rows are read and written back with ONLY `position` changed, rather
    // than upserting a minimal {id, position} payload. That is deliberate — it
    // makes the write lossless by construction and independent of how PostgREST
    // treats columns omitted from an upsert payload (`swimlane_id` and `sprint_id`
    // are nullable with no default, so a minimal payload risks nulling them).
    //
    // Reading first also PRESERVES THE OLD SEMANTICS: a task_id with no ranking row
    // for this board/column was silently skipped by the loop, and is still skipped
    // here because it simply won't come back from the select. A blind upsert would
    // have inserted it instead — a behaviour change.
    if (dto.task_ids.length > 0) {
      const existing = await this.client
        .from(BoardsService.RANKINGS_TABLE)
        .select('*')
        .eq('board_id', boardId)
        .eq('column_id', dto.column_id)
        .in('task_id', dto.task_ids);

      if (existing.error) throw new BadRequestException(existing.error.message);

      const positionByTaskId = new Map(
        dto.task_ids.map((taskId, index) => [taskId, index]),
      );

      const rows = (
        (existing.data ?? []) as unknown as Array<Record<string, unknown>>
      ).map((row) => ({
        ...row,
        position: positionByTaskId.get(row['task_id'] as string) ?? 0,
      }));

      if (rows.length > 0) {
        const upserted = await this.client
          .from(BoardsService.RANKINGS_TABLE)
          .upsert(rows, { onConflict: 'id' });

        if (upserted.error) {
          throw new BadRequestException(upserted.error.message);
        }
      }
    }
    await this.logAction(
      organizationId,
      userId,
      'board_card',
      boardId,
      'update',
      {
        scope: 'reorder',
        column_id: dto.column_id,
        task_ids: dto.task_ids,
      },
    );
  }

  async addCard(
    boardId: string,
    organizationId: string,
    userId: string,
    dto: {
      task_id: string;
      column_id: string;
      position: number;
      sprint_id?: string | null;
    },
  ): Promise<{ data: Record<string, unknown>; success: true }> {
    const board = await this.assertBoardAccess(
      boardId,
      organizationId,
      userId,
      'edit',
    );

    if (!dto.task_id || !dto.column_id) {
      throw new BadRequestException('task_id and column_id are required');
    }

    const { data: column, error: columnError } = await this.client
      .from(BoardsService.COLUMNS_TABLE)
      .select('id')
      .eq('id', dto.column_id)
      .eq('board_id', boardId)
      .maybeSingle();

    if (columnError) throw new BadRequestException(columnError.message);
    if (!column) throw new NotFoundException('Column not found');

    const { data: task, error: taskError } = await this.client
      .from('tasks')
      .select('id, space_id, status_id')
      .eq('id', dto.task_id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (taskError) throw new BadRequestException(taskError.message);
    if (!task) throw new NotFoundException('Task not found');
    if ((task as Record<string, unknown>)['space_id'] !== board.space_id) {
      throw new BadRequestException('Task does not belong to this board space');
    }

    if (dto.sprint_id) {
      const { data: sprint, error: sprintError } = await this.client
        .from('sprints')
        .select('id, status')
        .eq('id', dto.sprint_id)
        .eq('board_id', boardId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (sprintError) throw new BadRequestException(sprintError.message);
      if (!sprint) throw new NotFoundException('Sprint not found');
      if ((sprint as Record<string, unknown>)['status'] === 'completed') {
        throw new BadRequestException('Cannot add cards to a completed sprint');
      }
    }

    // Duplicate check — reject if task is already on this board
    const { data: existing } = await this.client
      .from(BoardsService.RANKINGS_TABLE)
      .select('id')
      .eq('board_id', boardId)
      .eq('task_id', dto.task_id)
      .maybeSingle();

    if (existing)
      throw new BadRequestException('Task is already on this board');

    const insertResult = (await this.client
      .from(BoardsService.RANKINGS_TABLE)
      .insert({
        board_id: boardId,
        task_id: dto.task_id,
        column_id: dto.column_id,
        position: dto.position ?? 1000,
        sprint_id: dto.sprint_id ?? null,
        version: 0,
      })
      .select()
      .single()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };

    if (insertResult.error || !insertResult.data)
      throw new BadRequestException(
        insertResult.error?.message ?? 'Failed to add card',
      );

    // Auto-apply the column's first mapped status to the task (matches RM App behaviour)
    const { data: colStatuses, error: colStatusesError } = await this.client
      .from(BoardsService.COLUMN_STATUSES_TABLE)
      .select(
        'status_id, status:task_statuses(id, key, is_completed, status_categories(key))',
      )
      .eq('board_id', boardId)
      .eq('column_id', dto.column_id)
      .order('sort_order', { ascending: true })
      .limit(1);

    if (colStatusesError)
      throw new BadRequestException(colStatusesError.message);

    // Only write when the status would actually CHANGE. Re-stamping the status a task already has
    // is not free: it bumps `updated_at` (both explicitly below and via the `tasks_updated_at`
    // trigger), which destroys an imported task's real last-modified date — a migration places a
    // card in the column that already matches the task's status, so every migrated task was being
    // touched for no reason. It also saves a write per card on ordinary board use.
    const currentStatusId = (task as Record<string, unknown>)['status_id'] as
      | string
      | null
      | undefined;
    const targetStatusId = colStatuses?.length
      ? (colStatuses[0] as { status_id?: string }).status_id
      : undefined;

    if (colStatuses?.length && targetStatusId !== currentStatusId) {
      type StatusMeta = {
        key?: string | null;
        is_completed?: boolean | null;
        status_categories?: { key?: string } | { key?: string }[] | null;
      };
      const mapped = colStatuses[0] as {
        status_id?: string;
        status?: StatusMeta | StatusMeta[];
      };
      const statusMeta = Array.isArray(mapped.status)
        ? mapped.status[0]
        : mapped.status;
      const statusKey = statusMeta?.key ?? null;
      const isCompleted =
        statusMeta?.is_completed === true ||
        statusKey === 'done' ||
        statusKey === 'closed';
      const statusPayload: Record<string, unknown> = {
        status_id: mapped.status_id,
        updated_at: new Date().toISOString(),
        completed_at: isCompleted ? new Date().toISOString() : null,
      };

      if (statusKey) {
        // `task_statuses.key` is unconstrained, but the legacy `tasks.status` column is NOT NULL
        // with CHECK (open|in_progress|review|done|closed|blocked). Writing the raw key straight
        // through raises 23514 — which is exactly what happened here: dropping a card into a column
        // whose status was custom (e.g. a migrated `to_do`) inserted the ranking row and THEN threw,
        // leaving the card placed but the request failed. `status_id` above carries the real status;
        // this column is the legacy bucket beside it. INERT for the six built-in keys.
        const cat = Array.isArray(statusMeta?.status_categories)
          ? statusMeta?.status_categories[0]
          : statusMeta?.status_categories;

        statusPayload.status = toLegacyStatusText(
          statusKey,
          statusMeta?.is_completed ?? undefined,
          cat?.key ?? null,
        );
      }

      const statusUpdate = await this.client
        .from('tasks')
        .update(statusPayload)
        .eq('id', dto.task_id)
        .eq('organization_id', organizationId);

      if (statusUpdate.error) {
        throw new BadRequestException(statusUpdate.error.message);
      }
    }

    await this.logAction(
      organizationId,
      userId,
      'board_card',
      dto.task_id,
      'create',
      {
        board_id: boardId,
        column_id: dto.column_id,
        sprint_id: dto.sprint_id ?? null,
      },
    );

    return { data: insertResult.data, success: true };
  }

  async refreshBoard(
    boardId: string,
    organizationId: string,
    userId: string,
  ): Promise<{ data: { added: number; removed: 0 } }> {
    const board = await this.assertBoardAccess(
      boardId,
      organizationId,
      userId,
      'edit',
    );

    const added = await this.syncFilterTasks(board, userId);
    await this.syncCardColumnsByStatus(board);
    await this.logAction(organizationId, userId, 'board', boardId, 'update', {
      scope: 'refresh',
      added,
      removed: 0,
    });
    return { data: { added, removed: 0 } };
  }
}
