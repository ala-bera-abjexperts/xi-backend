/**
 * @fileoverview REST controller for `/task-statuses` — configurable task
 * status CRUD with transition management, default handling, reorder, and
 * duplicate.
 * @module src/task-statuses/task-statuses.controller
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
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
import { TaskStatusesService } from './task-statuses.service';
import { CreateTaskStatusDto } from './dto/create-task-status.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { PatchTaskStatusDto } from './dto/patch-task-status.dto';

@ApiTags('Task Statuses')
@ApiBearerAuth()
@Controller('task-statuses')
export class TaskStatusesController {
  constructor(private readonly service: TaskStatusesService) {}

  // ---- Main CRUD -------------------------------------------------------

  @Get()
  @ApiOperation({
    summary: 'List task statuses for the org (optionally filtered by space)',
  })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiQuery({ name: 'is_active', required: false })
  @ApiQuery({ name: 'is_completed', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'with_transitions', required: false })
  @ApiResponse({ status: 200, description: 'Statuses returned' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe({ optional: true }))
    spaceId?: string,
    @Query('is_active') is_active?: string,
    @Query('is_completed') is_completed?: string,
    @Query('search') search?: string,
    @Query('with_transitions') withTransitions?: string,
  ) {
    const statuses = await this.service.getAll(user.organizationId, spaceId, {
      is_active,
      is_completed,
      search,
    });

    if (withTransitions === 'true') {
      const data = await Promise.all(
        statuses.map(async (status) => ({
          ...status,
          allowed_transitions: await this.service.getTransitions(
            status.id,
            user.organizationId,
          ),
        })),
      );

      return { data, count: data.length };
    }

    return { data: statuses, count: statuses.length };
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_statuses')
  @ApiOperation({ summary: 'Create a task status' })
  @ApiResponse({ status: 201, description: 'Status created' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateTaskStatusDto,
  ) {
    return {
      data: await this.service.create(user.organizationId, dto, user.userId),
      success: true,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a task status by ID' })
  @ApiParam({ name: 'id' })
  @ApiQuery({
    name: 'with_transitions',
    required: false,
    description: 'Embed allowed transition IDs',
  })
  @ApiResponse({ status: 200, description: 'Status returned' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('with_transitions') withTransitions?: string,
  ) {
    if (withTransitions === 'true') {
      return {
        data: await this.service.getByIdWithTransitions(
          id,
          user.organizationId,
        ),
      };
    }
    return { data: await this.service.getById(id, user.organizationId) };
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_statuses')
  @ApiOperation({ summary: 'Update a task status' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Status updated' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskStatusDto,
  ) {
    return {
      data: await this.service.update(
        id,
        user.organizationId,
        dto,
        user.userId,
      ),
      success: true,
    };
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_statuses')
  @ApiOperation({
    summary: 'Patch action: toggle_active, set_default, reorder, duplicate',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Action applied' })
  async patch(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchTaskStatusDto,
  ) {
    if (!dto.action) {
      return {
        data: await this.service.update(
          id,
          user.organizationId,
          dto,
          user.userId,
        ),
        success: true,
      };
    }

    switch (dto.action) {
      case 'toggle_active':
        if (dto.is_active === undefined) {
          throw new BadRequestException(
            'is_active is required for toggle_active',
          );
        }
        return {
          data: await this.service.toggleActive(
            id,
            dto.is_active,
            user.organizationId,
            user.userId,
          ),
          success: true,
        };
      case 'set_default':
        return {
          data: await this.service.setDefault(
            id,
            user.organizationId,
            user.userId,
          ),
          success: true,
        };
      case 'reorder':
        if (!dto.items || dto.items.length === 0) {
          throw new BadRequestException('items array is required for reorder');
        }
        await this.service.reorder(dto.items, user.organizationId, user.userId);
        return { success: true, message: 'Statuses reordered' };
      case 'duplicate':
        if (!dto.new_name) {
          throw new BadRequestException('new_name is required for duplicate');
        }
        return {
          data: await this.service.duplicate(
            id,
            user.organizationId,
            dto.new_name,
            user.userId,
          ),
          success: true,
        };
      default:
        throw new BadRequestException(`Unknown action: ${dto.action}`);
    }
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_statuses')
  @ApiOperation({
    summary: 'Delete a task status (blocked if in use by tasks)',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Status deleted' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.delete(id, user.organizationId, user.userId);
    return { success: true, message: 'Status deleted' };
  }

  // ---- Transitions ------------------------------------------------------

  @Get(':id/transitions')
  @ApiOperation({
    summary: 'List allowed transition target IDs for a status',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Transition IDs returned' })
  async getTransitions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const transitions = await this.service.getTransitions(
      id,
      user.organizationId,
    );
    return { data: { status_id: id, allowed_transitions: transitions } };
  }

  @Put(':id/transitions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_statuses')
  @ApiOperation({ summary: 'Bulk-replace transition targets for a status' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Transitions replaced' })
  async setTransitions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { transition_to_ids: string[] },
  ) {
    if (!Array.isArray(body.transition_to_ids)) {
      throw new BadRequestException('transition_to_ids must be an array');
    }
    await this.service.setTransitions(
      id,
      body.transition_to_ids,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Transitions updated' };
  }

  @Post(':id/transitions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_statuses')
  @ApiOperation({ summary: 'Add a single transition target' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, description: 'Transition added' })
  async addTransition(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { to_status_id: string },
  ) {
    if (!body.to_status_id) {
      throw new BadRequestException('to_status_id is required');
    }
    await this.service.addTransition(
      id,
      body.to_status_id,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Transition added' };
  }

  @Delete(':id/transitions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_statuses')
  @ApiOperation({ summary: 'Remove a single transition target' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Transition removed' })
  async removeTransition(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { to_status_id: string },
  ) {
    if (!body.to_status_id) {
      throw new BadRequestException('to_status_id is required');
    }
    await this.service.removeTransition(
      id,
      body.to_status_id,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Transition removed' };
  }
}
