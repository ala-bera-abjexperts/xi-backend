import {
  Body,
  Controller,
  Delete,
  Get,
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
import { AssetObjectReferencesService } from './asset-object-references.service';
import { CreateAssetObjectReferenceDto } from './dto/create-asset-object-reference.dto';

@RequireFeature('module_assets')
@ApiTags('asset-object-references')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/assets')
export class AssetObjectReferencesController {
  constructor(private readonly service: AssetObjectReferencesService) {}

  @Get('objects/:id/references')
  @RequireSpacePermission('view_assets')
  @ApiOperation({
    summary: 'Get inbound and outbound references for an asset object',
    description:
      'Returns two arrays: outbound (this object points to others) and inbound (others point to this object). Each reference includes joined relation_type, source, and target object details.',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Source object UUID' })
  @ApiResponse({
    status: 200,
    description: 'Grouped inbound and outbound references returned',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Object not found' })
  async getGrouped(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    const result = await this.service.getGrouped(
      spaceId,
      user.organizationId,
      id,
    );

    return result;
  }

  @Post('objects/:id/references')
  @RequireSpacePermission('edit_assets')
  @ApiOperation({
    summary: 'Create a directed reference from this object to another',
    description:
      'Both objects must be in the same space. Self-references and duplicate references are rejected.',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Source object UUID' })
  @ApiResponse({ status: 201, description: 'Reference created' })
  @ApiResponse({
    status: 400,
    description: 'Self-reference, cross-space reference, or validation error',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing edit_assets permission or module disabled',
  })
  @ApiResponse({
    status: 404,
    description: 'Source or target object not found',
  })
  @ApiResponse({
    status: 409,
    description: 'Reference already exists between these objects',
  })
  async create(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Body() dto: CreateAssetObjectReferenceDto,
    @CurrentUser() user: RequestUser,
  ) {
    const ref = await this.service.create(
      spaceId,
      user.organizationId,
      user.userId,
      id,
      dto,
    );

    return ref;
  }

  @Delete('objects/:id/references/:referenceId')
  @RequireSpacePermission('edit_assets')
  @ApiOperation({ summary: 'Delete a reference between two objects' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID (source or target)' })
  @ApiParam({ name: 'referenceId', description: 'Reference UUID' })
  @ApiResponse({ status: 200, description: 'Reference deleted' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing edit_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Reference not found' })
  async delete(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Param('referenceId') referenceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.delete(
      spaceId,
      user.organizationId,
      user.userId,
      id,
      referenceId,
    );
  }
}
