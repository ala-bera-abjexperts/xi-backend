/**
 * @fileoverview REST controller for `/task-priorities` — configurable
 * task priority CRUD with default management, reorder, and duplicate.
 * @module src/task-priorities/task-priorities.controller
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
import { TaskPrioritiesService } from './task-priorities.service';
import { CreateTaskPriorityDto } from './dto/create-task-priority.dto';
import { UpdateTaskPriorityDto } from './dto/update-task-priority.dto';
import { PatchTaskPriorityDto } from './dto/patch-task-priority.dto';

@ApiTags('Task Priorities')
@ApiBearerAuth()
@Controller('task-priorities')
export class TaskPrioritiesController {
  constructor(private readonly service: TaskPrioritiesService) {}

  @Get()
  @ApiOperation({
    summary: 'List task priorities for the org (optionally filtered by space)',
  })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiQuery({ name: 'is_active', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiResponse({ status: 200, description: 'Priorities returned' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe({ optional: true })) spaceId?: string,
    @Query('is_active') is_active?: string,
    @Query('search') search?: string,
  ) {
    const priorities = await this.service.getAll(user.organizationId, spaceId, {
      is_active,
      search,
    });
    return { data: priorities, count: priorities.length };
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_priorities')
  @ApiOperation({ summary: 'Create a task priority' })
  @ApiResponse({ status: 201, description: 'Priority created' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateTaskPriorityDto,
  ) {
    return {
      data: await this.service.create(user.organizationId, dto, user.userId),
      success: true,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a task priority by ID' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Priority returned' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return { data: await this.service.getById(id, user.organizationId) };
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_priorities')
  @ApiOperation({ summary: 'Update a task priority' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Priority updated' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskPriorityDto,
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
  @RequirePermissions('can_edit_priorities')
  @ApiOperation({
    summary: 'Patch action: toggle_active, set_default, reorder, duplicate',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Action applied' })
  async patch(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchTaskPriorityDto,
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
        return { success: true, message: 'Priorities reordered' };
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
  @RequirePermissions('can_delete_priorities')
  @ApiOperation({
    summary: 'Delete a task priority (blocked if in use by tasks)',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Priority deleted' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.delete(id, user.organizationId, user.userId);
    return { success: true, message: 'Priority deleted' };
  }
}
