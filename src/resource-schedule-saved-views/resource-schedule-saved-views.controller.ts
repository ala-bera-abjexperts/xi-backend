/**
 * @fileoverview Controller for private-per-user saved views on the Resource Planning 2.0
 * schedule grid. No portfolio_id-equivalent sub-scope -- org+user scoped only.
 * @module src/resource-schedule-saved-views/resource-schedule-saved-views.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { CreateResourceScheduleSavedViewDto } from './dto/create-resource-schedule-saved-view.dto';
import { UpdateResourceScheduleSavedViewDto } from './dto/update-resource-schedule-saved-view.dto';
import { ResourceScheduleSavedViewsService } from './resource-schedule-saved-views.service';

@RequireFeature('module_resource_planning')
@ApiTags('Resource Schedule Saved Views')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('resource-schedule-saved-views')
export class ResourceScheduleSavedViewsController {
  constructor(private readonly service: ResourceScheduleSavedViewsService) {}

  @Get()
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({
    summary: 'List current user’s saved schedule views',
  })
  @ApiResponse({ status: 200, description: 'User saved-view list.' })
  list(@CurrentUser() user: RequestUser) {
    return this.service.list(user.organizationId, user.userId);
  }

  @Post()
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'Create a saved schedule view' })
  @ApiResponse({ status: 201, description: 'Saved view created.' })
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateResourceScheduleSavedViewDto,
  ) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  @Patch(':id')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'Update a saved schedule view (owner only)' })
  @ApiResponse({ status: 200, description: 'Saved view updated.' })
  @ApiResponse({ status: 404, description: 'Saved view not found.' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateResourceScheduleSavedViewDto,
  ) {
    return this.service.update(user.organizationId, user.userId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({ summary: 'Delete a saved schedule view (owner only)' })
  @ApiResponse({ status: 200, description: 'Saved view deleted.' })
  @ApiResponse({ status: 404, description: 'Saved view not found.' })
  delete(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.delete(user.organizationId, user.userId, id);
  }

  @Post(':id/set-default')
  @RequirePermissions('can_view_resource_planning')
  @ApiOperation({
    summary:
      'Mark this saved view as the default for the current user + organization',
  })
  @ApiResponse({ status: 200, description: 'Default updated.' })
  @ApiResponse({ status: 404, description: 'Saved view not found.' })
  setDefault(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.setDefault(user.organizationId, user.userId, id);
  }
}
