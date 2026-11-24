import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AssetObjectTaskLinksService } from './asset-object-task-links.service';
import { CreateAssetObjectTaskLinkDto } from './dto/create-asset-object-task-link.dto';
import { LinkAssetToTaskDto } from './dto/link-asset-to-task.dto';

@RequireFeature('module_assets')
@ApiTags('asset-object-task-links')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/assets')
export class AssetObjectTaskLinksController {
  constructor(private readonly service: AssetObjectTaskLinksService) {}

  @Get('objects/:id/task-links')
  @RequireSpacePermission('view_assets')
  @ApiOperation({ summary: 'List tasks linked to an asset object' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Asset object UUID' })
  @ApiResponse({ status: 200, description: 'List of task links returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing view_assets permission' })
  @ApiResponse({ status: 404, description: 'Object not found' })
  async list(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listForObject(spaceId, user.organizationId, id);
  }

  @Post('objects/:id/task-links')
  @RequireSpacePermission('edit_assets')
  @HttpCode(201)
  @ApiOperation({ summary: 'Link a task to an asset object' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Asset object UUID' })
  @ApiResponse({ status: 201, description: 'Task link created' })
  @ApiResponse({
    status: 400,
    description: 'Task in different space or validation error',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing edit_assets permission' })
  @ApiResponse({ status: 404, description: 'Object or task not found' })
  @ApiResponse({
    status: 409,
    description: 'Task already linked to this object',
  })
  async create(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Body() dto: CreateAssetObjectTaskLinkDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.create(
      spaceId,
      user.organizationId,
      user.userId,
      id,
      dto,
    );
  }

  @Delete('objects/:id/task-links/:linkId')
  @RequireSpacePermission('edit_assets')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a task link from an asset object' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Asset object UUID' })
  @ApiParam({ name: 'linkId', description: 'Task link UUID' })
  @ApiResponse({ status: 204, description: 'Task link removed' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing edit_assets permission' })
  @ApiResponse({ status: 404, description: 'Task link not found' })
  async delete(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Param('linkId') linkId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.delete(
      spaceId,
      user.organizationId,
      user.userId,
      id,
      linkId,
    );
  }

  @Get('tasks/:taskId/links')
  @RequireSpacePermission('view_assets')
  @ApiOperation({ summary: 'List assets linked to a task' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'taskId', description: 'Task UUID' })
  @ApiResponse({ status: 200, description: 'List of asset links returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing view_assets permission' })
  async listForTask(
    @Param('spaceId') spaceId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listForTask(spaceId, user.organizationId, taskId);
  }

  @Post('tasks/:taskId/links')
  @RequireSpacePermission('edit_assets')
  @HttpCode(201)
  @ApiOperation({ summary: 'Link an asset object to a task' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'taskId', description: 'Task UUID' })
  @ApiResponse({ status: 201, description: 'Asset link created' })
  @ApiResponse({
    status: 400,
    description: 'Task in different space or validation error',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing edit_assets permission' })
  @ApiResponse({ status: 404, description: 'Object or task not found' })
  @ApiResponse({
    status: 409,
    description: 'Asset already linked to this task',
  })
  async createForTask(
    @Param('spaceId') spaceId: string,
    @Param('taskId') taskId: string,
    @Body() dto: LinkAssetToTaskDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.create(
      spaceId,
      user.organizationId,
      user.userId,
      dto.object_id,
      {
        task_id: taskId,
        relation_type_id: dto.relation_type_id,
      },
    );
  }

  @Delete('tasks/:taskId/links/:linkId')
  @RequireSpacePermission('edit_assets')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove an asset link from a task' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'taskId', description: 'Task UUID' })
  @ApiParam({ name: 'linkId', description: 'Asset link UUID' })
  @ApiResponse({ status: 204, description: 'Asset link removed' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing edit_assets permission' })
  @ApiResponse({ status: 404, description: 'Asset link not found' })
  async deleteForTask(
    @Param('spaceId') spaceId: string,
    @Param('taskId') taskId: string,
    @Param('linkId') linkId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.deleteForTask(
      spaceId,
      user.organizationId,
      user.userId,
      taskId,
      linkId,
    );
  }
}
