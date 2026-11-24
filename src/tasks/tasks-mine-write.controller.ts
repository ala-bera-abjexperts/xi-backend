/**
 * @fileoverview MCP-facing REST controller for space-safe task WRITES under
 * `/tasks/mine` — create, update (optimistic-locked), and comment. These back
 * the MCP `task.create` / `task.update` / `task.comment` tools. Unlike the
 * org-level `/tasks` routes, these enforce space membership + the relevant
 * space-level task permission, and collapse every denial to a uniform 404
 * (anti-probing). They carry the global auth chain only (no @RequirePermissions
 * / no space guard) so app-auth and the MCP service token behave identically;
 * all safety lives in TasksMineWriteService.
 * @module src/tasks/tasks-mine-write.controller
 * @author Prince Jadiya
 */

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { TasksMineWriteService } from './tasks-mine-write.service';
import { MineCreateTaskDto } from './dto/mine-create-task.dto';
import { MineUpdateTaskDto } from './dto/mine-update-task.dto';
import { MineAddCommentDto } from './dto/mine-add-comment.dto';

@ApiTags('Tasks')
@ApiBearerAuth()
@Controller('tasks/mine')
export class TasksMineWriteController {
  constructor(private readonly service: TasksMineWriteService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a task in a space the caller can write to',
    description:
      'Creates a task in the target space only when the authenticated caller ' +
      'is an org admin/owner or an active member of that space holding the ' +
      'space-level create_tasks permission. Non-member, nonexistent, and ' +
      'cross-org all return an identical 404 (anti-probing). Backs the MCP ' +
      'task.create tool.',
  })
  @ApiResponse({ status: 201, description: 'Task created' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Space not found or not writable' })
  async createMyTask(
    @CurrentUser() user: RequestUser,
    @Body() dto: MineCreateTaskDto,
  ) {
    return this.service.createTask(user, dto);
  }

  @Patch(':taskIdOrKey')
  @ApiOperation({
    summary: 'Update a task the caller can edit (optimistic-locked)',
    description:
      'Updates whitelisted fields of a task only when the caller holds the ' +
      'space-level edit_tasks permission in the task’s space. Requires ' +
      'expectedVersion; a stale value returns 409 with the current version. ' +
      'Non-member, nonexistent, and cross-org all return an identical 404 ' +
      '(anti-probing). Backs the MCP task.update tool.',
  })
  @ApiParam({ name: 'taskIdOrKey', description: 'Task UUID or key' })
  @ApiResponse({ status: 200, description: 'Task updated' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Task not found or not writable' })
  @ApiResponse({ status: 409, description: 'Optimistic version conflict' })
  async updateMyTask(
    @CurrentUser() user: RequestUser,
    @Param('taskIdOrKey') taskIdOrKey: string,
    @Body() dto: MineUpdateTaskDto,
  ) {
    return this.service.updateTask(user, taskIdOrKey, dto);
  }

  @Post(':taskIdOrKey/comments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Comment on a task the caller can comment on',
    description:
      'Adds a comment only when the caller holds the space-level ' +
      'add_comments_tasks permission in the task’s space. Non-member, ' +
      'nonexistent, and cross-org all return an identical 404 (anti-probing). ' +
      'Backs the MCP task.comment tool.',
  })
  @ApiParam({ name: 'taskIdOrKey', description: 'Task UUID or key' })
  @ApiResponse({ status: 201, description: 'Comment created' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Task not found or not writable' })
  async addMyTaskComment(
    @CurrentUser() user: RequestUser,
    @Param('taskIdOrKey') taskIdOrKey: string,
    @Body() dto: MineAddCommentDto,
  ) {
    return this.service.addComment(user, taskIdOrKey, dto.content);
  }
}
