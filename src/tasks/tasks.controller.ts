/**
 * @fileoverview REST controller for `/tasks` — full CRUD + comments +
 * attachments + relationships + hierarchy navigation + history.
 * @module src/tasks/tasks.controller
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Optional,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  WorkflowEngineService,
  type IAvailableTransition,
} from '../workflow-engine/workflow-engine.service';
import { ExecuteTransitionDto } from '../workflow-engine/dto/execute-transition.dto';
import {
  DEV_FILTERS,
  isDevFilter,
} from '../git-integrations/git-dev-filter.util';
import { TasksService } from './tasks.service';
import { TaskAttachmentsService } from './tasks-attachments.service';
import { TaskRemindersService } from './task-reminders.service';
import { TaskWikiGenerationService } from './task-wiki-generation.service';
import { TasksCreateWithAttachmentsService } from './tasks-create-with-attachments.service';
import { PermissionsService } from '../permissions/permissions.service';
import { UPLOAD_LIMITS } from '../common/upload-limits';
import { CreateTaskDto } from './dto/create-task.dto';
import { CreateTaskWithAttachmentsDto } from './dto/create-task-with-attachments.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { PatchTaskDto } from './dto/patch-task.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { parseTieSortsQuery, sortTaskComments } from './task-comment-sort';
import {
  TASK_COMMENT_SORTS,
  type TaskCommentSort,
} from '../users/dto/save-task-comment-preferences.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';
import { CreateRelationshipDto } from './dto/create-relationship.dto';
import { CreateTaskReminderDto } from './dto/create-task-reminder.dto';
import { UpdateTaskReminderDto } from './dto/update-task-reminder.dto';
import { GenerateWikiDto } from './dto/generate-wiki.dto';
import { WatchersService } from '../watchers/watchers.service';
import { EntitlementsService } from '../licensing/entitlements.service';
import { AgentOriginService } from '../chat-agent/agent-origin.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly service: TasksService,
    private readonly attachmentsService: TaskAttachmentsService,
    private readonly remindersService: TaskRemindersService,
    private readonly wikiGenerationService: TaskWikiGenerationService,
    private readonly permissionsService: PermissionsService,
    private readonly engine: WorkflowEngineService,
    private readonly watchersService: WatchersService,
    private readonly createWithAttachmentsService: TasksCreateWithAttachmentsService,
    // Optional like elsewhere: absent = not entitled (no git computed fields).
    @Optional() private readonly entitlements?: EntitlementsService,
    @Optional() private readonly origins?: AgentOriginService,
  ) {}

  /** The detail screen asks for the "Drafted by Robert" label in the same request. Lists never do. */
  private async withOrigin<T extends object>(user: RequestUser, task: T, wanted?: string): Promise<T> {
    if (wanted !== 'true' || !this.origins) return task;
    // 1.22.1: and one line per plan Robert added it to.
    const [origin, links] = await Promise.all([
      this.origins.forObject(user, 'task', task),
      this.origins.addedToPlans(user, task),
    ]);
    return {
      ...task,
      ...(origin && { robert_origin: origin }),
      ...(links.length && { robert_plan_links: links }),
    };
  }

  // ---- Static subpaths first -------------------------------------------

  @Get('by-key/:key')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({ summary: 'Get a task by its key (e.g. HR-T42)' })
  @ApiParam({ name: 'key' })
  @ApiResponse({ status: 200, description: 'Task returned' })
  async getByKey(
    @CurrentUser() user: RequestUser,
    @Param('key') key: string,
    @Query('withOrigin') withOrigin?: string,
  ) {
    return this.withOrigin(user, await this.service.getByKeyForViewer(user, key), withOrigin);
  }

  @Get('tree')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({
    summary: 'Get task tree for a process (nested ITaskTreeNode[])',
  })
  @ApiQuery({ name: 'processId', required: true })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiQuery({ name: 'rootTaskId', required: false })
  @ApiResponse({ status: 200, description: 'Task tree returned' })
  async getTree(
    @CurrentUser() user: RequestUser,
    @Query('processId', ParseUUIDPipe) processId: string,
    @Query('spaceId', new ParseUUIDPipe({ optional: true }))
    spaceId?: string,
    @Query('rootTaskId', new ParseUUIDPipe({ optional: true }))
    rootTaskId?: string,
  ) {
    const tree = await this.service.getTree(
      user.organizationId,
      processId,
      spaceId,
      rootTaskId,
    );
    return { data: tree, count: tree.length };
  }

  // ---- Core CRUD -------------------------------------------------------

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({ summary: 'List tasks with filters and pagination' })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiQuery({ name: 'processId', required: false })
  @ApiQuery({ name: 'parentTaskId', required: false })
  @ApiQuery({ name: 'taskTypeId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiQuery({ name: 'assignedTo', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'isOverdue', required: false })
  @ApiQuery({ name: 'dueBefore', required: false })
  @ApiQuery({ name: 'dueAfter', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    description:
      'Column to sort the whole list by (key, summary, status, priority, due_date, created_at, updated_at, cf_<field_key>); default is the manual order',
  })
  @ApiQuery({ name: 'sortDir', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'development', required: false, enum: DEV_FILTERS })
  @ApiResponse({ status: 200, description: 'Paginated tasks returned' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('spaceId') spaceId?: string,
    @Query('processId') processId?: string,
    @Query('process_id') processIdSnake?: string,
    @Query('parentTaskId') parentTaskId?: string,
    @Query('parent_task_id') parentTaskIdSnake?: string,
    @Query('taskTypeId') taskTypeId?: string,
    @Query('task_type_id') taskTypeIdSnake?: string,
    @Query('status') status?: string,
    @Query('statuses') statuses?: string,
    @Query('status_id') statusId?: string,
    @Query('status_ids') statusIds?: string,
    @Query('priority') priority?: string,
    @Query('priorities') priorities?: string,
    @Query('priority_id') priorityId?: string,
    @Query('priority_ids') priorityIds?: string,
    @Query('ids') ids?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('assigned_to') assignedToSnake?: string,
    @Query('reporter') reporter?: string,
    @Query('search') search?: string,
    @Query('isOverdue') isOverdue?: string,
    @Query('is_overdue') isOverdueSnake?: string,
    @Query('dueBefore') dueBefore?: string,
    @Query('due_before') dueBeforeSnake?: string,
    @Query('dueAfter') dueAfter?: string,
    @Query('due_after') dueAfterSnake?: string,
    @Query('created_after') createdAfter?: string,
    @Query('created_before') createdBefore?: string,
    @Query('withRelations') withRelations?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('page_size') pageSizeSnake?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: string,
    @Query('development') development?: string,
  ) {
    const resolvedPageSize = pageSize ?? pageSizeSnake;

    if (development !== undefined && !isDevFilter(development)) {
      throw new BadRequestException(
        `development must be one of: ${DEV_FILTERS.join(', ')}`,
      );
    }

    // Ticket 10 fields cost a lookup per row: only for organizations with the Git integration licence.
    const withDevelopment = Boolean(
      (
        await this.entitlements?.getEffectiveEntitlements(user.organizationId)
      )?.has('feature_external_integrations'),
    );

    if (development !== undefined && !withDevelopment) {
      throw new ForbiddenException({
        code: 'FEATURE_NOT_ENTITLED',
        message: 'The development filter needs the Git integration',
        required_features: ['feature_external_integrations'],
      });
    }

    return this.service.getAll(user.organizationId, {
      space_id: spaceId,
      process_id: processId ?? processIdSnake,
      parent_task_id: parentTaskId ?? parentTaskIdSnake,
      task_type_id: taskTypeId ?? taskTypeIdSnake,
      status,
      statuses,
      status_id: statusId,
      status_ids: statusIds,
      priority,
      priorities,
      priority_id: priorityId,
      priority_ids: priorityIds,
      ids,
      assigned_to: assignedTo ?? assignedToSnake,
      reporter,
      search,
      is_overdue: isOverdue ?? isOverdueSnake,
      due_before: dueBefore ?? dueBeforeSnake,
      due_after: dueAfter ?? dueAfterSnake,
      created_after: createdAfter,
      created_before: createdBefore,
      withRelations: withRelations === 'true',
      page: page ? parseInt(page, 10) : undefined,
      pageSize: resolvedPageSize ? parseInt(resolvedPageSize, 10) : undefined,
      sortBy,
      sortDir,
      development,
      withDevelopment,
    });
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_tasks')
  @ApiOperation({ summary: 'Create a task' })
  @ApiResponse({ status: 201, description: 'Task created' })
  async create(@CurrentUser() user: RequestUser, @Body() dto: CreateTaskDto) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  @Post('with-attachments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_tasks')
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      limits: { fileSize: UPLOAD_LIMITS.ATTACHMENT },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Create a task with file attachments in one request',
  })
  @ApiResponse({ status: 201, description: 'Task created' })
  async createWithAttachments(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateTaskWithAttachmentsDto,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.createWithAttachmentsService.createWithAttachments(
      user,
      dto,
      files ?? [],
    );
  }

  // MCP-facing member-space reads.
  //
  // These two endpoints back the MCP `task.search` / `task.get` tools. They
  // carry the global auth guard only (no @RequirePermissions, no space guard)
  // so app-auth and S2S behave identically; member-space safety is enforced
  // entirely in the service (resolveAccessibleTaskSpaceIds + uniform 404).
  // Declared before `@Get(':id')` so the literal `mine` segment wins routing
  // and is not captured as an `:id` param (which carries a permission guard).

  @Get('mine/search')
  @ApiOperation({
    summary: 'Search tasks the current user can access',
    description:
      'Returns tasks the authenticated caller can read in their active ' +
      'organization (member spaces with view_tasks, org admin/owner, or ' +
      'org-level tasks with org can_view_tasks). Never cross-org, never a ' +
      'non-member space. Result is never null. Backs the MCP task.search tool.',
  })
  @ApiQuery({ name: 'query', required: false })
  @ApiQuery({ name: 'spaceIdOrKey', required: false })
  @ApiQuery({ name: 'statuses', required: false })
  @ApiQuery({ name: 'priorities', required: false })
  @ApiQuery({ name: 'assignedTo', required: false })
  @ApiQuery({ name: 'dueBefore', required: false })
  @ApiQuery({ name: 'dueAfter', required: false })
  @ApiQuery({ name: 'sortBy', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description:
      'Page mode (1-based): offset pages with an exact total; cursor is ignored',
  })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({
    name: 'withDetails',
    required: false,
    description:
      "'true' adds status/priority config, task type, process and version",
  })
  @ApiQuery({
    name: 'overdue',
    required: false,
    description: "'true': due before now and not done/closed",
  })
  @ApiResponse({ status: 200, description: 'Accessible tasks returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async searchMyTasks(
    @CurrentUser() user: RequestUser,
    @Query('query') query?: string,
    @Query('spaceIdOrKey') spaceIdOrKey?: string,
    @Query('statuses') statuses?: string,
    @Query('priorities') priorities?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('dueBefore') dueBefore?: string,
    @Query('dueAfter') dueAfter?: string,
    @Query('sortBy') sortBy?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('withDetails') withDetails?: string,
    @Query('overdue') overdue?: string,
  ) {
    return this.service.searchMyTasks(user, {
      query: query || undefined,
      spaceIdOrKey: spaceIdOrKey || undefined,
      statuses: statuses
        ? statuses
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      priorities: priorities
        ? priorities
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      assignedTo: assignedTo || undefined,
      dueBefore: dueBefore || undefined,
      dueAfter: dueAfter || undefined,
      sortBy: sortBy || undefined,
      limit: this.parseFiniteInt(limit),
      cursor: cursor || undefined,
      // Only set when sent, so the MCP/chat calls keep the exact options object they always had.
      ...(page !== undefined && {
        page: this.parseFiniteInt(page),
        pageSize: this.parseFiniteInt(pageSize),
      }),
      ...(withDetails === 'true' && { withDetails: true }),
      ...(overdue === 'true' && { overdue: true }),
    });
  }

  // Parses a query-string integer, returning `undefined` for absent or
  // non-numeric values. parseInt yields `NaN` for non-numeric input, which a
  // downstream `?? DEFAULT` does not catch; passing `undefined` lets the service
  // apply its default/clamp cleanly (no `NaN` reaches PostgREST).
  private parseFiniteInt(value?: string): number | undefined {
    if (value === undefined) return undefined;
    const parsed = parseInt(value, 10);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  @Get('mine/:taskIdOrKey')
  @ApiOperation({
    summary: 'Get one accessible task by UUID or key',
    description:
      'Resolves a task by UUID or key and returns it only when the caller can ' +
      'access its space (or org-level tasks with org can_view_tasks). ' +
      'Non-member, nonexistent, and cross-org all return an identical 404 ' +
      '(anti-probing). Backs the MCP task.get tool.',
  })
  @ApiParam({ name: 'taskIdOrKey', description: 'Task UUID or key' })
  @ApiQuery({ name: 'includeComments', required: false, type: Boolean })
  @ApiQuery({ name: 'commentLimit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Accessible task returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Task not found or not accessible' })
  async getMyTask(
    @CurrentUser() user: RequestUser,
    @Param('taskIdOrKey') taskIdOrKey: string,
    @Query('includeComments') includeComments?: string,
    @Query('commentLimit') commentLimit?: string,
  ) {
    return this.service.getMyTask(user, taskIdOrKey, {
      includeComments: includeComments === 'true',
      commentLimit: this.parseFiniteInt(commentLimit),
    });
  }

  @Get(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({ summary: 'Get a task by ID' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'withRelations', required: false })
  @ApiResponse({ status: 200, description: 'Task returned' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('withRelations') withRelations?: string,
    @Query('withOrigin') withOrigin?: string,
  ) {
    if (!UUID_RE.test(id)) {
      return this.withOrigin(user, await this.service.getByKeyForViewer(user, id), withOrigin);
    }

    if (withRelations === 'true') {
      return this.withOrigin(
        user,
        await this.service.getById(id, user.organizationId, {
          withRelations: true,
        }),
        withOrigin,
      );
    }
    return this.withOrigin(user, await this.service.getById(id, user.organizationId), withOrigin);
  }

  @Get(':id/watch')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({ summary: 'Get the current user task-watch state' })
  async getWatchState(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.getMyTask(user, id);
    return this.watchersService.getTaskWatchState(
      user.organizationId,
      user.userId,
      id,
    );
  }

  @Put(':id/watch')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({ summary: 'Watch a task as the current user' })
  async watch(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.getMyTask(user, id);
    return this.watchersService.setTaskWatch(
      user.organizationId,
      user.userId,
      id,
      true,
    );
  }

  @Delete(':id/watch')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({ summary: 'Stop watching a task as the current user' })
  async unwatch(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.getMyTask(user, id);
    return this.watchersService.setTaskWatch(
      user.organizationId,
      user.userId,
      id,
      false,
    );
  }

  @Get(':id/mute')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({
    summary: 'Get whether the current user muted notifications for a task',
  })
  async getMuteState(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.getMyTask(user, id);
    return this.watchersService.getTaskMuteState(
      user.organizationId,
      user.userId,
      id,
    );
  }

  @Put(':id/mute')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({
    summary: 'Mute notifications for a task as the current user',
    description:
      'Silences watcher notifications (updates, comments, attachments) and development notifications ' +
      '(pull requests, builds) for this task. Mentions and assignments still arrive.',
  })
  async mute(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.getMyTask(user, id);
    return this.watchersService.setTaskMute(
      user.organizationId,
      user.userId,
      id,
      true,
    );
  }

  @Delete(':id/mute')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({
    summary: 'Unmute notifications for a task as the current user',
  })
  async unmute(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.getMyTask(user, id);
    return this.watchersService.setTaskMute(
      user.organizationId,
      user.userId,
      id,
      false,
    );
  }

  // ---- Workflow engine endpoints (Prompt 6 — Phase J) ------------------

  @Get(':id/available-transitions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({
    summary:
      "List transitions available from the task's current status (engine-gated by conditions)",
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({
    status: 200,
    description: 'Available transitions for the calling user',
  })
  async availableTransitions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ data: IAvailableTransition[]; workflow_assigned: boolean }> {
    const result = await this.engine.getAvailableTransitions(id, user);

    return {
      data: result.transitions,
      workflow_assigned: result.workflow_assigned,
    };
  }

  @Post(':id/transitions/:transitionId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_tasks')
  @ApiOperation({ summary: 'Execute a specific transition on this task' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'transitionId' })
  @ApiResponse({
    status: 200,
    description: 'Transition executed; returns updated task',
  })
  @ApiResponse({ status: 409, description: 'Optimistic concurrency mismatch' })
  @ApiResponse({ status: 422, description: 'Validator failed or no path' })
  async executeTransition(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('transitionId', ParseUUIDPipe) transitionId: string,
    @Body() dto: ExecuteTransitionDto,
  ): Promise<{ data: unknown; success: true }> {
    const task = await this.engine.executeTransition({
      taskId: id,
      transitionId,
      screenInput: dto.screen_input,
      user,
      executionId: dto.execution_id,
      expectedVersion: dto.expected_version,
    });

    return { data: task, success: true };
  }

  // ---- Bulk operations --------------------------------------------------

  @Post('bulk-update')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_tasks')
  @ApiOperation({
    summary: 'Bulk update tasks (status, priority, assignee, due date)',
  })
  @ApiResponse({ status: 200, description: 'Tasks updated' })
  async bulkUpdateTasks(
    @CurrentUser() user: RequestUser,
    @Body()
    body: {
      ids: string[];
      status_id?: string;
      priority_id?: string;
      assigned_to?: string | null;
      due_date?: string | null;
    },
  ) {
    return this.service.bulkUpdateTasks(
      user.organizationId,
      user.userId,
      body.ids,
      {
        status_id: body.status_id,
        priority_id: body.priority_id,
        assigned_to: body.assigned_to,
        due_date: body.due_date,
      },
    );
  }

  @Post('bulk-delete')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_tasks')
  @ApiOperation({ summary: 'Bulk delete tasks' })
  @ApiResponse({ status: 200, description: 'Tasks deleted' })
  async bulkDeleteTasks(
    @CurrentUser() user: RequestUser,
    @Body() body: { ids: string[] },
  ) {
    const result = await this.service.bulkDeleteTasks(
      user.organizationId,
      user.userId,
      body.ids,
    );

    return { success: true, ...result };
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_tasks')
  @ApiOperation({ summary: 'Update a task' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Task updated' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.service.update(id, user.organizationId, user.userId, dto);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_edit_tasks', 'can_assign_tasks'], { any: true })
  @ApiOperation({ summary: 'Quick actions: update_status, assign' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Action applied' })
  async patch(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchTaskDto,
  ) {
    await this.assertPatchActionPermission(user, id, dto);

    switch (dto.action) {
      case 'update_status':
        return this.service.update(id, user.organizationId, user.userId, {
          status: dto.status,
          status_id: dto.status_id,
        });
      case 'assign':
        return this.service.update(id, user.organizationId, user.userId, {
          assigned_to: dto.assigned_to,
        });
      case 'partial_update': {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { action: _a, ...fields } = dto;
        return this.service.update(
          id,
          user.organizationId,
          user.userId,
          fields,
        );
      }
      case undefined: {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { action: _a, ...fields } = dto;
        return this.service.update(
          id,
          user.organizationId,
          user.userId,
          fields,
        );
      }
      default:
        throw new BadRequestException(`Unknown action: ${dto.action}`);
    }
  }

  private async assertPatchActionPermission(
    user: RequestUser,
    taskId: string,
    dto: PatchTaskDto,
  ): Promise<void> {
    const dtoObj: { action?: string; assigned_to?: unknown } = {
      action: typeof dto.action === 'string' ? dto.action : undefined,
      assigned_to: Object.prototype.hasOwnProperty.call(dto, 'assigned_to')
        ? (dto as Record<string, unknown>)['assigned_to']
        : undefined,
    };
    const keys: string[] = Object.keys(dto as Record<string, unknown>).filter(
      (key) => key !== 'action' && key !== 'organizationId',
    );
    const isAssignmentOnly: boolean =
      dtoObj.action === 'assign' ||
      (dtoObj.action === undefined &&
        keys.length === 1 &&
        dtoObj.assigned_to !== undefined);
    const required = isAssignmentOnly ? 'can_assign_tasks' : 'can_edit_tasks';

    if (
      await this.permissionsService.checkPermission(
        user.userId,
        user.organizationId,
        required,
      )
    ) {
      return;
    }

    const task = await this.service.getById(taskId, user.organizationId);
    if (task.space_id) {
      const spacePermissions =
        await this.permissionsService.getUserSpacePermissions(
          user.userId,
          user.organizationId,
          task.space_id,
        );
      const spaceKey = required.startsWith('can_')
        ? required.slice(4)
        : required;

      if (spacePermissions.isMember && spacePermissions.permissions[spaceKey]) {
        return;
      }
    }

    throw new ForbiddenException('Insufficient permissions');
  }

  private async assertCanCommentForOthers(
    user: RequestUser,
    taskId: string,
    authorId: string,
  ): Promise<void> {
    const task = await this.service.getById(taskId, user.organizationId);

    await this.service.assertCommentAuthorInOrganization(
      authorId,
      user.organizationId,
    );

    if (task.space_id) {
      const authorAccess =
        await this.permissionsService.getUserSpacePermissions(
          authorId,
          user.organizationId,
          task.space_id,
        );
      if (!authorAccess.isMember) {
        throw new BadRequestException(
          'The selected author must be a member of this space',
        );
      }
    }
  }

  // Returns the authors for an "All users" post: every active member of the task's space.
  private async resolveAllMemberAuthors(
    user: RequestUser,
    taskId: string,
  ): Promise<string[]> {
    const task = await this.service.getById(taskId, user.organizationId);

    if (!task.space_id) {
      throw new BadRequestException(
        'Posting for all users is only available for tasks in a space',
      );
    }

    const authorIds = await this.service.listActiveSpaceMemberUserIds(
      task.space_id,
      user.organizationId,
    );

    if (authorIds.length === 0) {
      throw new BadRequestException('This space has no active members');
    }

    return authorIds;
  }

  @Post(':id/generate-wiki')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_view_tasks', 'can_create_wiki_pages'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Generate a wiki page from task data' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, description: 'Wiki page generated' })
  async generateWiki(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GenerateWikiDto,
  ): Promise<unknown> {
    return this.wikiGenerationService.generateFromTask(id, user, dto);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_tasks')
  @ApiOperation({
    summary: 'Delete a task (cascades comments, attachments, relations)',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Task deleted' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.delete(id, user.organizationId, user.userId);
    return { success: true, message: 'Task deleted' };
  }

  // ---- Comments ---------------------------------------------------------

  @Get(':id/comments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({ summary: 'List comments for a task' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'sort', required: false, enum: TASK_COMMENT_SORTS })
  @ApiQuery({
    name: 'then',
    required: false,
    description:
      'Ties for name/message sorts, in sequence, e.g. updated_desc,oldest',
  })
  @ApiResponse({ status: 200, description: 'Comments returned' })
  async listComments(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('sort') sort?: string,
    @Query('then') then?: string,
  ) {
    const tieSorts = parseTieSortsQuery(then);
    if (!tieSorts)
      throw new BadRequestException(
        'then must be comma-separated, from: oldest, newest, updated_desc, updated_asc (one created and one updated at most)',
      );
    if (sort !== undefined) {
      if (!TASK_COMMENT_SORTS.includes(sort as TaskCommentSort)) {
        throw new BadRequestException(
          `sort must be one of: ${TASK_COMMENT_SORTS.join(', ')}`,
        );
      }
      const sorted = await this.service.getComments(
        id,
        user.organizationId,
        sort as TaskCommentSort,
      );
      // Ties for name and message orders follow the user's picked sequence
      if (tieSorts.length) {
        const tied = sortTaskComments(
          sorted as Record<string, never>[],
          sort as TaskCommentSort,
          tieSorts,
        );
        return {
          data: tied,
          count: tied.length,
          permissions: await this.service.getCommentPermissions(
            id,
            user.organizationId,
            user.userId,
          ),
        };
      }
      return {
        data: sorted,
        count: sorted.length,
        permissions: await this.service.getCommentPermissions(
          id,
          user.organizationId,
          user.userId,
        ),
      };
    }
    const comments = await this.service.getComments(id, user.organizationId);
    return {
      data: comments,
      count: comments.length,
      permissions: await this.service.getCommentPermissions(
        id,
        user.organizationId,
        user.userId,
      ),
    };
  }

  @Post(':id/comments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_add_comments_tasks')
  @ApiOperation({ summary: 'Add a comment to a task' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, description: 'Comment created' })
  async createComment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCommentDto,
  ) {
    if (dto.all_members) {
      if (dto.author_id) {
        throw new BadRequestException(
          'Use either author_id or all_members, not both',
        );
      }
      const authorIds = await this.resolveAllMemberAuthors(user, id);
      const created: unknown[] = [];

      // One comment per member, each through the normal create path
      for (const authorId of authorIds) {
        created.push(
          await this.service.createComment(
            id,
            user.organizationId,
            user.userId,
            dto.content,
            authorId === user.userId ? undefined : { author_id: authorId },
          ),
        );
      }
      return { data: created, count: created.length, success: true };
    }
    if (dto.author_id && dto.author_id !== user.userId) {
      await this.assertCanCommentForOthers(user, id, dto.author_id);
      const onBehalfComment = await this.service.createComment(
        id,
        user.organizationId,
        user.userId,
        dto.content,
        { author_id: dto.author_id },
      );
      return { data: onBehalfComment, success: true };
    }
    const comment = await this.service.createComment(
      id,
      user.organizationId,
      user.userId,
      dto.content,
    );
    return { data: comment, success: true };
  }

  // Authorized in TasksService.updateComment: own comments need can_add_comments_tasks, others'
  // need can_edit_others_comments_tasks, each resolved through the full space permissions (which
  // PermissionsGuard's space fallback does not read).
  @Put(':id/comments/:commentId')
  @ApiOperation({
    summary:
      'Update a comment (own: add-comments right; others: edit-others-comments right)',
  })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'commentId' })
  @ApiResponse({ status: 200, description: 'Comment updated' })
  async updateComment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: UpdateCommentDto,
  ) {
    const comment = await this.service.updateComment(
      id,
      commentId,
      user.organizationId,
      user.userId,
      dto.content,
    );
    return { data: comment, success: true };
  }

  // Authorized in TasksService.deleteComment: own comments need can_delete_comments_tasks,
  // others' need can_delete_others_comments_tasks.
  @Delete(':id/comments/:commentId')
  @ApiOperation({
    summary:
      'Delete a comment (own: delete-comments right; others: delete-others-comments right)',
  })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'commentId' })
  @ApiResponse({ status: 200, description: 'Comment deleted' })
  async deleteComment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    await this.service.deleteComment(
      id,
      commentId,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Comment deleted' };
  }

  // ---- Relationships ----------------------------------------------------

  @Get(':id/relationships')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({ summary: 'List relationships for a task' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Relationships returned' })
  async listRelationships(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const relationships = await this.service.getRelationships(
      id,
      user.organizationId,
      user.userId,
    );
    return { data: relationships, count: relationships.length };
  }

  @Post(':id/relationships')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_tasks')
  @ApiOperation({ summary: 'Create a relationship from this task' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, description: 'Relationship created' })
  async createRelationship(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRelationshipDto,
  ) {
    const relationship = await this.service.createRelationship(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
    return { data: relationship, success: true };
  }

  @Delete(':id/relationships/:relationshipId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_tasks')
  @ApiOperation({ summary: 'Delete a relationship' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'relationshipId' })
  @ApiResponse({ status: 200, description: 'Relationship deleted' })
  async deleteRelationship(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
  ) {
    await this.service.deleteRelationship(
      id,
      relationshipId,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Relationship deleted' };
  }

  // ---- Hierarchy --------------------------------------------------------

  @Get(':id/subtasks')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({ summary: 'List subtasks (direct children)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Subtasks returned' })
  async listSubtasks(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const subtasks = await this.service.getSubtasks(id, user.organizationId);
    return { data: subtasks, count: subtasks.length };
  }

  @Get(':id/parent-chain')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({ summary: 'Get the parent chain (breadcrumb) for a task' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Parent chain returned' })
  async getParentChain(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const chain = await this.service.getParentChain(id, user.organizationId);
    return { data: chain, count: chain.length };
  }

  // ---- History ----------------------------------------------------------

  @Get(':id/history')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({ summary: 'Get change history for a task' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'History entries returned' })
  async getHistory(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const history = await this.service.getHistory(id, user.organizationId);
    return { data: history, count: history.length };
  }

  // ── Attachments ────────────────────────────────────────────────────────

  @Get(':id/attachments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({ summary: 'List attachments for a task' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  async listAttachments(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.attachmentsService.getAttachments(id, user.organizationId);
  }

  @Post(':id/attachments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_add_attachments_tasks')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a file attachment for a task' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  async uploadAttachment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }
    return this.attachmentsService.uploadAttachment(
      id,
      user.organizationId,
      user.userId,
      file,
    );
  }

  @Get(':id/attachments/:attachmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({
    summary:
      'Return JSON { data: { url } } for the signed download URL of an attachment',
  })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  async getAttachmentDownloadUrl(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    // Return JSON so the hook (taskAttachmentService.getDownloadUrl) can read result.data.url
    return this.attachmentsService.getDownloadUrl(
      id,
      attachmentId,
      user.organizationId,
    );
  }

  @Delete(':id/attachments/:attachmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_attachments_tasks')
  @ApiOperation({ summary: 'Delete a task attachment' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  async deleteAttachment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    return this.attachmentsService.deleteAttachment(
      id,
      attachmentId,
      user.organizationId,
      user.userId,
    );
  }

  // ── Reminders ─────────────────────────────────────────────────────────────

  @Get(':id/reminders')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_tasks')
  @ApiOperation({ summary: 'List reminders for a task' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  async listReminders(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    // SECURITY (M): the reminder service scopes by task_id only — verify the task
    // is in the caller's org first (else cross-tenant reminder access).
    await this.service.getById(id, user.organizationId);
    return this.remindersService.getReminders(id);
  }

  @Post(':id/reminders')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_tasks')
  @ApiOperation({ summary: 'Create a reminder for a task' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  async createReminder(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTaskReminderDto,
  ) {
    await this.service.getById(id, user.organizationId);
    return this.remindersService.createReminder(id, user.userId, dto);
  }

  @Put(':id/reminders/:reminderId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_tasks')
  @ApiOperation({ summary: 'Update a task reminder' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiParam({ name: 'reminderId', description: 'Reminder UUID' })
  async updateReminder(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('reminderId', ParseUUIDPipe) reminderId: string,
    @Body() dto: UpdateTaskReminderDto,
  ) {
    await this.service.getById(id, user.organizationId);
    return this.remindersService.updateReminder(reminderId, id, dto);
  }

  @Delete(':id/reminders/:reminderId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_tasks')
  @ApiOperation({ summary: 'Delete a task reminder' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiParam({ name: 'reminderId', description: 'Reminder UUID' })
  async deleteReminder(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('reminderId', ParseUUIDPipe) reminderId: string,
  ) {
    await this.service.getById(id, user.organizationId);
    return this.remindersService.deleteReminder(reminderId, id);
  }
}
