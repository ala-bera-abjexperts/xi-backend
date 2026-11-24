/**
 * @fileoverview REST controller for `/task-hierarchy-config`. Mirrors the
 * single-endpoint-with-actions design of the old Next.js route so the
 * frontend doesn't need adapter changes.
 * @module src/task-hierarchy-config/task-hierarchy-config.controller
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PermissionsService } from '../permissions/permissions.service';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TaskHierarchyConfigService } from './task-hierarchy-config.service';
import {
  saveTaskHierarchyConfigSchema,
  resetTaskHierarchyConfigSchema,
  addTaskTypeSchema,
  updateTaskTypeSchema,
  removeTaskTypeSchema,
  reorderTaskTypesSchema,
  type SaveTaskHierarchyConfigInput,
  type ValidateTaskHierarchyConfigInput,
  type ResetTaskHierarchyConfigInput,
  type AddTaskTypeInput,
  type UpdateTaskTypeInput,
  type RemoveTaskTypeInput,
  type ReorderTaskTypesInput,
} from './models/task-hierarchy-config.model';

/**
 * Shape of the `POST /task-hierarchy-config` dispatched body.
 * `action` selects the sub-operation; the remaining fields depend on
 * which action was selected.
 */
type PostActionBody =
  | ({ action: 'validate' } & ValidateTaskHierarchyConfigInput)
  | ({ action: 'reset' } & ResetTaskHierarchyConfigInput)
  | ({ action: 'add_task_type' } & AddTaskTypeInput)
  | ({ action: 'update_task_type' } & UpdateTaskTypeInput)
  | ({ action: 'remove_task_type' } & RemoveTaskTypeInput)
  | ({ action: 'reorder' } & ReorderTaskTypesInput);

@ApiTags('Task Hierarchy Config')
@ApiBearerAuth()
@Controller('task-hierarchy-config')
export class TaskHierarchyConfigController {
  constructor(
    private readonly service: TaskHierarchyConfigService,
    private readonly permissionsService: PermissionsService,
  ) {}

  /**
   * GET — multi-variant lookup. Behavior is dispatched by query flags
   * (matching the old Next.js route):
   *   - `?spaceId=X` → full config for the space
   *   - `?spaceId=X&activeTypes=true` → active task types
   *   - `?spaceId=X&rootTypes=true` → root task types
   *   - `?spaceId=X&taskTypeId=Y` → a single task type
   *   - `?spaceId=X&validParentTypes=Y` → valid parents for type Y
   *   - `?spaceId=X&validChildTypes=Y` → valid children for type Y
   */
  @Get()
  @ApiOperation({
    summary:
      'Get the task hierarchy config OR a slice of it (types, root, parents, children)',
  })
  @ApiQuery({ name: 'spaceId', required: true })
  @ApiQuery({ name: 'activeTypes', required: false })
  @ApiQuery({ name: 'rootTypes', required: false })
  @ApiQuery({ name: 'taskTypeId', required: false })
  @ApiQuery({ name: 'validParentTypes', required: false })
  @ApiQuery({ name: 'validChildTypes', required: false })
  @ApiResponse({ status: 200, description: 'Config or slice returned' })
  async get(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe()) spaceId: string,
    @Query('activeTypes') activeTypes?: string,
    @Query('rootTypes') rootTypes?: string,
    @Query('taskTypeId') taskTypeId?: string,
    @Query('validParentTypes') validParentTypes?: string,
    @Query('validChildTypes') validChildTypes?: string,
  ) {
    if (!spaceId) {
      throw new BadRequestException('spaceId is required');
    }
    const org = user.organizationId;

    if (activeTypes === 'true') {
      const types = await this.service.getActiveTypes(org, spaceId);
      return { data: types, count: types.length };
    }
    if (rootTypes === 'true') {
      const types = await this.service.getRootTypes(org, spaceId);
      return { data: types, count: types.length };
    }
    if (validParentTypes) {
      const types = await this.service.getValidParentTypesFor(
        org,
        spaceId,
        validParentTypes,
      );
      return { data: types, count: types.length };
    }
    if (validChildTypes) {
      const types = await this.service.getValidChildTypesFor(
        org,
        spaceId,
        validChildTypes,
      );
      return { data: types, count: types.length };
    }
    if (taskTypeId) {
      const taskType = await this.service.getTypeById(org, spaceId, taskTypeId);
      return { data: taskType };
    }
    const config = await this.service.getConfig(org, spaceId);
    return { data: config };
  }

  /**
   * PUT — save (upsert) the full config for a space.
   */
  @Put()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_edit_hierarchy', 'can_manage_hierarchy'], {
    any: true,
  })
  @ApiOperation({ summary: 'Save (upsert) the task hierarchy config' })
  @ApiBody({ description: '`{ spaceId, config: ITaskHierarchyConfig }`' })
  @ApiResponse({ status: 200, description: 'Config saved' })
  async save(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(saveTaskHierarchyConfigSchema))
    body: SaveTaskHierarchyConfigInput,
  ) {
    await this.service.assertNoReservedTypeNames(
      user.organizationId,
      body.spaceId,
      body.config,
    );
    const record = await this.service.saveConfig(
      user.organizationId,
      body.spaceId,
      body.config,
      user.userId,
    );
    return { data: record, success: true };
  }

  /**
   * POST — dispatched sub-actions. Each branch validates its own body
   * with the matching Zod schema.
   */
  @Post()
  @ApiOperation({
    summary:
      'Dispatched action: validate | reset | add_task_type | update_task_type | remove_task_type | reorder',
  })
  @ApiBody({ description: 'Body shape depends on `action`' })
  @ApiResponse({ status: 200, description: 'Action result' })
  async dispatch(
    @CurrentUser() user: RequestUser,
    @Body() body: PostActionBody,
  ) {
    if (!body || typeof body !== 'object' || !('action' in body)) {
      throw new BadRequestException('`action` field is required');
    }

    const org = user.organizationId;
    const uid = user.userId;

    switch (body.action) {
      case 'validate': {
        const config = (body as { config?: unknown }).config;
        if (!config) {
          throw new BadRequestException(
            'Configuration data required for validation',
          );
        }
        return {
          data: this.service.validateConfig(
            config as ValidateTaskHierarchyConfigInput['config'],
          ),
        };
      }

      case 'reset': {
        await this.assertCanEditHierarchy(user, 'can_delete_task_types');
        const parsed = resetTaskHierarchyConfigSchema.safeParse(body);
        if (!parsed.success) {
          throw new BadRequestException({
            message: 'Validation failed',
            errors: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              message: i.message,
            })),
          });
        }
        const record = await this.service.resetToDefault(
          org,
          parsed.data.spaceId,
          uid,
        );
        return {
          data: record,
          success: true,
          message: 'Configuration reset to default',
        };
      }

      case 'add_task_type': {
        await this.assertCanEditHierarchy(user, 'can_create_task_types');
        const parsed = addTaskTypeSchema.safeParse(body);
        if (!parsed.success) {
          throw new BadRequestException({
            message: 'Validation failed',
            errors: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              message: i.message,
            })),
          });
        }
        const record = await this.service.addTaskType(
          org,
          parsed.data.spaceId,
          parsed.data.taskType,
          uid,
        );
        return { data: record, success: true };
      }

      case 'update_task_type': {
        await this.assertCanEditHierarchy(user, 'can_edit_task_types');
        const parsed = updateTaskTypeSchema.safeParse(body);
        if (!parsed.success) {
          throw new BadRequestException({
            message: 'Validation failed',
            errors: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              message: i.message,
            })),
          });
        }
        const record = await this.service.updateTaskType(
          org,
          parsed.data.spaceId,
          parsed.data.taskTypeId,
          parsed.data.updates,
          uid,
        );
        return { data: record, success: true };
      }

      case 'remove_task_type': {
        await this.assertCanEditHierarchy(user, 'can_delete_task_types');
        const parsed = removeTaskTypeSchema.safeParse(body);
        if (!parsed.success) {
          throw new BadRequestException({
            message: 'Validation failed',
            errors: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              message: i.message,
            })),
          });
        }
        const record = await this.service.removeTaskType(
          org,
          parsed.data.spaceId,
          parsed.data.taskTypeId,
          uid,
        );
        return { data: record, success: true };
      }

      case 'reorder': {
        await this.assertCanEditHierarchy(user, 'can_edit_task_types');
        const parsed = reorderTaskTypesSchema.safeParse(body);
        if (!parsed.success) {
          throw new BadRequestException({
            message: 'Validation failed',
            errors: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              message: i.message,
            })),
          });
        }
        const record = await this.service.reorder(
          org,
          parsed.data.spaceId,
          parsed.data.orderedIds,
          uid,
        );
        return { data: record, success: true };
      }

      default: {
        const _exhaustive: never = body;
        void _exhaustive;
        throw new BadRequestException(
          `Unknown action: ${(body as { action: string }).action}`,
        );
      }
    }
  }

  private async assertCanEditHierarchy(
    user: RequestUser,
    extraKey?: string,
  ): Promise<void> {
    const isAdmin = await this.permissionsService.isAdminOrOwner(
      user.userId,
      user.organizationId,
    );
    if (isAdmin) return;

    const allowed = await this.permissionsService.hasAnyPermission(
      user.userId,
      user.organizationId,
      // A task-type action follows its own key (or the manage umbrella), not Processes edit
      extraKey
        ? ['can_manage_hierarchy', extraKey]
        : ['can_edit_hierarchy', 'can_manage_hierarchy'],
    );
    if (!allowed) {
      throw new ForbiddenException('Insufficient permissions');
    }
  }
}
