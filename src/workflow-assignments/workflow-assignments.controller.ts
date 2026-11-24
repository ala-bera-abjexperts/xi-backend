/**
 * @fileoverview REST controller for `/workflow-assignments`.
 * @module src/workflow-assignments/workflow-assignments.controller
 * @author Rajbha Manek
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
// Note: DeleteWorkflowAssignmentDto is no longer used for @Body() since
// acknowledge_orphaned_tasks moved to a query param (H9 — DELETE bodies are
// stripped by many HTTP clients and proxies).
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
import { WorkflowAssignmentsService } from './workflow-assignments.service';
import { CreateWorkflowAssignmentDto } from './dto/create-workflow-assignment.dto';
import { UpdateWorkflowAssignmentDto } from './dto/update-workflow-assignment.dto';

@ApiTags('Workflow Assignments')
@ApiBearerAuth()
@Controller('workflow-assignments')
export class WorkflowAssignmentsController {
  constructor(private readonly service: WorkflowAssignmentsService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_workflows')
  @ApiOperation({ summary: 'List workflow assignments for a space' })
  @ApiQuery({ name: 'spaceId', required: true })
  @ApiResponse({ status: 200, description: 'Assignments returned' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe({ optional: false })) spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    const data = await this.service.getBySpace(user.organizationId, spaceId);

    return { data, count: data.length };
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_assign_workflows')
  @ApiOperation({ summary: 'Create a workflow assignment' })
  @ApiResponse({ status: 201, description: 'Assignment created' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateWorkflowAssignmentDto,
  ) {
    return {
      data: await this.service.create(user.organizationId, dto, user.userId),
      success: true,
    };
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_assign_workflows')
  @ApiOperation({
    summary:
      'Update a workflow assignment (409 if tasks exist without migration_map)',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Assignment updated' })
  @ApiResponse({
    status: 409,
    description:
      'Tasks exist on this assignment — migration_map required. ' +
      'Response body shape: { message, data: { affected_count, orphan_statuses, suggested_mappings } } ' +
      'where suggested_mappings maps each orphan status id to a best-effort target status id in the new workflow (null when no candidate exists).',
  })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkflowAssignmentDto,
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

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_assign_workflows')
  @ApiOperation({
    summary:
      'Delete a workflow assignment (409 if tasks exist without ?acknowledge_orphaned_tasks=true)',
  })
  @ApiParam({ name: 'id' })
  @ApiQuery({
    name: 'acknowledge_orphaned_tasks',
    required: false,
    description: 'Pass true to proceed when orphaned tasks exist',
  })
  @ApiResponse({ status: 200, description: 'Assignment deleted' })
  @ApiResponse({
    status: 409,
    description:
      'Tasks exist on this assignment — pass ?acknowledge_orphaned_tasks=true to force. ' +
      'Response body shape: { message, data: { affected_count, orphan_statuses, suggested_mappings } } ' +
      'where suggested_mappings is always an empty object on delete (no target workflow exists).',
  })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    // H9: acknowledge_orphaned_tasks moved from @Body() to @Query() — DELETE
    // bodies are silently stripped by many HTTP clients (browsers, proxies, ALBs).
    @Query('acknowledge_orphaned_tasks') acknowledgeParam?: string,
  ) {
    await this.service.delete(
      id,
      user.organizationId,
      { acknowledge_orphaned_tasks: acknowledgeParam === 'true' },
      user.userId,
    );
    return { success: true, message: 'Workflow assignment deleted' };
  }
}
