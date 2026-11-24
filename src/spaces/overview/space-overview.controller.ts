/**
 * @fileoverview Controller for the space overview (visible modules + latest updates).
 * @module src/spaces/overview/space-overview.controller
 */

import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequireSpacePermission } from '../../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../../auth/guards/space-permissions.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { SpaceOverviewService } from './space-overview.service';
import type {
  OverviewStorageRecord,
  OverviewUpdate,
  SpaceOverview,
} from './space-overview.types';

@ApiTags('Spaces')
@ApiBearerAuth()
@Controller('spaces')
export class SpaceOverviewController {
  constructor(private readonly overviewService: SpaceOverviewService) {}

  /**
   * Returns the modules the caller can open and the latest records across them.
   *
   * @param {RequestUser} user - The authenticated user
   * @param {string} id - Space UUID
   * @returns {Promise<SpaceOverview>} Visible modules and up to 10 latest updates
   */
  @Get(':id/overview')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_space')
  @ApiOperation({
    summary: 'Get space overview',
    description:
      'Returns the modules visible to the caller and the 10 most recently updated records across them.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Space overview returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Space not found' })
  async getOverview(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SpaceOverview> {
    return this.overviewService.getOverview(user, id);
  }

  @Get(':id/overview/updates')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_space')
  @ApiOperation({
    summary: 'Get latest updates of one module in a space',
    description:
      'Returns the 10 most recently updated records of the given module, with the same visibility rules as the overview.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Latest updates returned' })
  @ApiResponse({ status: 400, description: 'Unknown module' })
  async getModuleUpdates(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('module') module?: string,
  ): Promise<OverviewUpdate[]> {
    if (!module || !this.overviewService.isUpdateModule(module)) {
      throw new BadRequestException('Unknown module');
    }

    return this.overviewService.getModuleUpdates(user, id, module);
  }

  @Get(':id/overview/storage/:module')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_space')
  @ApiOperation({
    summary:
      'Get the records of one module that hold the most attachment storage',
    description:
      'Returns up to 50 records with attachments, largest first, with the same visibility rules as the overview.',
  })
  @ApiParam({ name: 'id', description: 'Space UUID' })
  @ApiParam({ name: 'module', description: 'Module type' })
  @ApiResponse({ status: 200, description: 'Storage records returned' })
  @ApiResponse({ status: 400, description: 'Unknown module' })
  async getStorageRecords(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('module') module: string,
  ): Promise<OverviewStorageRecord[]> {
    if (!this.overviewService.isStorageModule(module)) {
      throw new BadRequestException('Unknown module');
    }

    return this.overviewService.getStorageRecords(user, id, module);
  }
}
