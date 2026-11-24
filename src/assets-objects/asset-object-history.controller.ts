import { Controller, Get, Param, UseGuards } from '@nestjs/common';
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
import { AssetObjectHistoryService } from './asset-object-history.service';

@RequireFeature('module_assets')
@ApiTags('asset-object-history')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/assets')
export class AssetObjectHistoryController {
  constructor(private readonly service: AssetObjectHistoryService) {}

  @Get('objects/:id/history')
  @RequireSpacePermission('view_assets')
  @ApiOperation({
    summary: 'Get the change history for an asset object',
    description:
      'Returns a chronological list of change events (field updates, attachment uploads, reference changes). Each entry includes the actor user details and a diff of what changed. Returns an empty array for newly created objects.',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiResponse({
    status: 200,
    description: 'History entries returned (newest first)',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Object not found' })
  async getHistory(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    const history = await this.service.getHistory(
      id,
      spaceId,
      user.organizationId,
    );

    return history;
  }
}
