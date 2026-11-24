/**
 * @fileoverview Controller for the Resource Planning module.
 * All routes live under the global `api/v1` prefix with base path `resource-planning`.
 * @module src/resource-planning/resource-planning.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ResourcePlanningService } from './resource-planning.service';
import { UpsertCapacityDto } from './dto/upsert-capacity.dto';
import { BulkUpdateCapacityDto } from './dto/bulk-update-capacity.dto';
import { CreateTaskAllocationDto } from './dto/create-task-allocation.dto';
import { UpdateTaskAllocationDto } from './dto/update-task-allocation.dto';
import { CreatePlanAllocationDto } from './dto/create-plan-allocation.dto';
import { UpdatePlanAllocationDto } from './dto/update-plan-allocation.dto';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';

@RequireFeature('module_resource_planning')
@ApiTags('Resource Planning')
@ApiBearerAuth()
@Controller('resource-planning')
export class ResourcePlanningController {
  constructor(private readonly service: ResourcePlanningService) {}

  // ==========================================================================
  // Employee capacity
  // ==========================================================================

  /**
   * GET /resource-planning/capacity
   * Lists all employee capacity records for the organization.
   */
  @Get('capacity')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({
    summary: 'List employee capacity records for the organization',
  })
  async listCapacity(@CurrentUser() user: RequestUser) {
    const data = await this.service.listCapacity(user.organizationId);

    return { data, count: data.length };
  }

  /**
   * PUT /resource-planning/capacity/:userId
   * Upserts the capacity record for (organizationId, userId).
   */
  @Put('capacity/:userId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Upsert employee capacity for a specific user' })
  @ApiParam({ name: 'userId', description: 'Target user ID' })
  async upsertCapacity(
    @CurrentUser() user: RequestUser,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @Body() body: UpsertCapacityDto,
  ) {
    const data = await this.service.upsertCapacity(
      user.organizationId,
      user.userId,
      targetUserId,
      body,
    );

    return { data, success: true };
  }

  /**
   * POST /resource-planning/capacity/bulk
   * Updates or resets many capacity records; returns per-employee results.
   */
  @Post('capacity/bulk')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Bulk update or reset employee capacity' })
  async bulkUpdateCapacity(
    @CurrentUser() user: RequestUser,
    @Body() body: BulkUpdateCapacityDto,
  ) {
    const data = await this.service.bulkUpdateCapacity(
      user.organizationId,
      user.userId,
      body,
    );

    return { data, success: true };
  }

  // ==========================================================================
  // Task-level allocations
  // ==========================================================================

  /**
   * GET /resource-planning/tasks/:taskId/allocations
   * Lists resource allocations for a task.
   * Authorization: space membership (view) — same mechanism as time-entries.
   */
  @Get('tasks/:taskId/allocations')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'List resource allocations for a task' })
  @ApiParam({ name: 'taskId', description: 'Task ID' })
  async listTaskAllocations(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    const data = await this.service.listTaskAllocations(
      taskId,
      user.organizationId,
      user.userId,
    );

    return { data, count: data.length };
  }

  /**
   * POST /resource-planning/tasks/:taskId/allocations
   * Creates a new resource allocation for a task.
   * Authorization: space membership with write (edit_tasks) — same mechanism as time-entry creation.
   */
  @Post('tasks/:taskId/allocations')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Create a resource allocation for a task' })
  @ApiParam({ name: 'taskId', description: 'Task ID' })
  async createTaskAllocation(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: CreateTaskAllocationDto,
  ) {
    const data = await this.service.createTaskAllocation(
      taskId,
      user.organizationId,
      user.userId,
      body,
    );

    return { data, success: true };
  }

  /**
   * PATCH /resource-planning/task-allocations/:id
   * Updates a task resource allocation.
   * Authorization: space membership with write — same as time-entry write check.
   */
  @Patch('task-allocations/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Update a task resource allocation' })
  @ApiParam({ name: 'id', description: 'Task allocation ID' })
  async updateTaskAllocation(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTaskAllocationDto,
  ) {
    const data = await this.service.updateTaskAllocation(
      id,
      user.organizationId,
      user.userId,
      body,
    );

    return { data, success: true };
  }

  /**
   * DELETE /resource-planning/task-allocations/:id
   * Deletes a task resource allocation.
   * Authorization: space membership with write — same as time-entry write check.
   */
  @Delete('task-allocations/:id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Delete a task resource allocation' })
  @ApiParam({ name: 'id', description: 'Task allocation ID' })
  async deleteTaskAllocation(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.deleteTaskAllocation(
      id,
      user.organizationId,
      user.userId,
    );

    return { success: true };
  }

  /**
   * GET /resource-planning/tasks/:taskId/rollup
   * Returns own + cumulative resource rollup for a task.
   */
  @Get('tasks/:taskId/rollup')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({
    summary:
      'Get resource rollup for a task (own + cumulative via descendants)',
  })
  @ApiParam({ name: 'taskId', description: 'Task ID' })
  async getTaskRollup(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    const data = await this.service.getTaskRollup(
      taskId,
      user.organizationId,
      user.userId,
    );

    return { data };
  }

  // ==========================================================================
  // Plan-level allocations
  // ==========================================================================

  /**
   * GET /resource-planning/plans/:planId/allocations
   * Lists resource allocations for a plan.
   */
  @Get('plans/:planId/allocations')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'List resource allocations for a plan' })
  @ApiParam({ name: 'planId', description: 'Plan ID' })
  async listPlanAllocations(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    const data = await this.service.listPlanAllocations(
      planId,
      user.organizationId,
      user.userId,
    );

    return { data, count: data.length };
  }

  /**
   * POST /resource-planning/plans/:planId/allocations
   * Creates a new resource allocation for a plan.
   */
  @Post('plans/:planId/allocations')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Create a resource allocation for a plan' })
  @ApiParam({ name: 'planId', description: 'Plan ID' })
  async createPlanAllocation(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() body: CreatePlanAllocationDto,
  ) {
    const data = await this.service.createPlanAllocation(
      planId,
      user.organizationId,
      user.userId,
      body,
    );

    return { data, success: true };
  }

  /**
   * PATCH /resource-planning/plan-allocations/:id
   * Updates a plan resource allocation.
   */
  @Patch('plan-allocations/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Update a plan resource allocation' })
  @ApiParam({ name: 'id', description: 'Plan allocation ID' })
  async updatePlanAllocation(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePlanAllocationDto,
  ) {
    const data = await this.service.updatePlanAllocation(
      id,
      user.organizationId,
      user.userId,
      body,
    );

    return { data, success: true };
  }

  /**
   * DELETE /resource-planning/plan-allocations/:id
   * Deletes a plan resource allocation.
   */
  @Delete('plan-allocations/:id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_manage_resource_planning')
  @ApiOperation({ summary: 'Delete a plan resource allocation' })
  @ApiParam({ name: 'id', description: 'Plan allocation ID' })
  async deletePlanAllocation(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.deletePlanAllocation(
      id,
      user.organizationId,
      user.userId,
    );

    return { success: true };
  }

  /**
   * GET /resource-planning/plans/:planId/summary
   * Returns a plan-level resource summary: per-user planned hours/budget, capacity, utilization.
   */
  @Get('plans/:planId/summary')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'Get resource summary for a plan' })
  @ApiParam({ name: 'planId', description: 'Plan ID' })
  async getPlanSummary(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    const data = await this.service.getPlanSummary(
      planId,
      user.organizationId,
      user.userId,
    );

    return { data };
  }

  // ==========================================================================
  // Portfolio-level summary
  // ==========================================================================

  /**
   * GET /resource-planning/portfolios/:portfolioId/summary
   * Returns a portfolio-level resource summary rolled up across all accessible plans.
   */
  @Get('portfolios/:portfolioId/summary')
  // Unions with the class-level module_resource_planning key.
  @RequireFeature('module_portfolios')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_view_resource_planning', 'can_view_portfolios'])
  @ApiOperation({
    summary: 'Get resource summary for a portfolio (rolled up across plans)',
  })
  @ApiParam({ name: 'portfolioId', description: 'Portfolio ID' })
  async getPortfolioSummary(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
  ) {
    const data = await this.service.getPortfolioSummary(
      portfolioId,
      user.organizationId,
      user.userId,
    );

    return { data };
  }
}
