import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
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
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import { SaveTaskSidebarPreferencesDto } from './dto/save-task-sidebar-preferences.dto';
import { TaskSidebarPreferencesService } from './task-sidebar-preferences.service';

@ApiTags('Task Sidebar Preferences')
@ApiBearerAuth()
@Controller('spaces/:spaceId/task-sidebar-preferences')
export class TaskSidebarPreferencesController {
  constructor(private readonly service: TaskSidebarPreferencesService) {}

  @Get()
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_tasks')
  @ApiOperation({ summary: 'Get effective task-detail sidebar preferences' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiResponse({
    status: 200,
    description: 'Task sidebar preferences returned',
  })
  getPreferences(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
  ) {
    return this.service.getPreferences(
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  @Put('me')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_tasks')
  @ApiOperation({
    summary: 'Save current user task-detail sidebar preferences',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  saveMe(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
    @Body() dto: SaveTaskSidebarPreferencesDto,
  ) {
    return this.service.saveUserPreferences(
      spaceId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete('me')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_tasks')
  @ApiOperation({
    summary: 'Reset current user task-detail sidebar preferences',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  resetMe(@CurrentUser() user: RequestUser, @Param('spaceId') spaceId: string) {
    return this.service.resetUserPreferences(
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  @Put('default')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({
    summary: 'Save default task-detail sidebar preferences for the space',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  saveDefault(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
    @Body() dto: SaveTaskSidebarPreferencesDto,
  ) {
    return this.service.saveDefaultPreferences(
      spaceId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete('default')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('edit_space_settings')
  @ApiOperation({
    summary: 'Reset default task-detail sidebar preferences for the space',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  resetDefault(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
  ) {
    return this.service.resetDefaultPreferences(
      spaceId,
      user.organizationId,
      user.userId,
    );
  }
}
