/**
 * @fileoverview REST controller for `/spaces/:spaceId/task-type-form-assignments`.
 * @module src/task-type-form-assignments/task-type-form-assignments.controller
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { TaskTypeFormAssignmentsService } from './task-type-form-assignments.service';
import { UpsertTaskTypeFormAssignmentDto } from './dto/upsert-task-type-form-assignment.dto';

@ApiTags('Task Type Form Assignments')
@ApiBearerAuth()
@Controller('spaces/:spaceId/task-type-form-assignments')
export class TaskTypeFormAssignmentsController {
  constructor(private readonly service: TaskTypeFormAssignmentsService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_hierarchy')
  @ApiOperation({ summary: 'List all form assignments in a space' })
  @ApiResponse({ status: 200, description: 'Assignments returned' })
  async list(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    const data = await this.service.listForSpace(spaceId, user.organizationId);

    return { data, count: data.length };
  }

  // `by-type` prefix keeps the slug segment from ever colliding with an :id route.
  @Get('by-type/:taskTypeLevelId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_hierarchy')
  @ApiOperation({
    summary: "Forms for one task type, including the '*' catch-all",
  })
  @ApiParam({ name: 'taskTypeLevelId' })
  @ApiResponse({ status: 200, description: 'Assignments returned' })
  async listForTaskType(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('taskTypeLevelId') taskTypeLevelId: string,
  ) {
    const data = await this.service.listForTaskType(
      spaceId,
      taskTypeLevelId,
      user.organizationId,
    );

    return { data, count: data.length };
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_edit_hierarchy', 'can_manage_hierarchy'], {
    any: true,
  })
  @ApiOperation({ summary: 'Attach a form to a task type (idempotent)' })
  @ApiResponse({ status: 201, description: 'Assignment created or updated' })
  async upsert(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: UpsertTaskTypeFormAssignmentDto,
  ) {
    return {
      data: await this.service.upsert(
        spaceId,
        user.organizationId,
        dto,
        user.userId,
      ),
      success: true,
    };
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions(['can_edit_hierarchy', 'can_manage_hierarchy'], {
    any: true,
  })
  @ApiOperation({ summary: 'Detach a form from a task type' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Assignment deleted' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.remove(id, spaceId, user.organizationId);

    return { success: true, message: 'Form assignment deleted' };
  }
}
