import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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
import { AssetObjectTypeAttributesService } from './asset-object-type-attributes.service';
import { CreateAssetObjectTypeAttributeDto } from './dto/create-asset-object-type-attribute.dto';
import { UpdateAssetObjectTypeAttributeDto } from './dto/update-asset-object-type-attribute.dto';

@RequireFeature('module_assets')
@ApiTags('asset-object-type-attributes')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller(
  'spaces/:spaceId/assets/schemas/:schemaId/object-types/:objectTypeId/attributes',
)
export class AssetObjectTypeAttributesController {
  constructor(private readonly service: AssetObjectTypeAttributesService) {}

  @Get()
  @RequireSpacePermission('view_assets')
  @ApiOperation({
    summary: 'List all attribute definitions for an object type',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiParam({ name: 'objectTypeId', description: 'Object type UUID' })
  @ApiResponse({ status: 200, description: 'Attribute definitions returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  async list(
    @Param('spaceId') spaceId: string,
    @Param('objectTypeId') objectTypeId: string,
    @CurrentUser() user: RequestUser,
  ) {
    const attrs = await this.service.list(
      objectTypeId,
      spaceId,
      user.organizationId,
    );

    return attrs;
  }

  @Post()
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary: 'Create an attribute definition on an object type',
    description:
      'field_key is immutable after creation — choose carefully. Use data_type="object_reference" to link to another type.',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiParam({ name: 'objectTypeId', description: 'Object type UUID' })
  @ApiResponse({ status: 201, description: 'Attribute definition created' })
  @ApiResponse({
    status: 400,
    description: 'Validation error or duplicate field_key on this type',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Object type not found' })
  async create(
    @Param('spaceId') spaceId: string,
    @Param('objectTypeId') objectTypeId: string,
    @Body() dto: CreateAssetObjectTypeAttributeDto,
    @CurrentUser() user: RequestUser,
  ) {
    const merged = { ...dto, object_type_id: objectTypeId };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const attr = await this.service.create(
      merged,
      spaceId,
      user.organizationId,
      user.userId,
    );

    return attr;
  }

  @Patch(':id')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary: 'Update an attribute definition',
    description: 'field_key is immutable and cannot be changed after creation.',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiParam({ name: 'objectTypeId', description: 'Object type UUID' })
  @ApiParam({ name: 'id', description: 'Attribute definition UUID' })
  @ApiResponse({ status: 200, description: 'Attribute definition updated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Attribute definition not found' })
  async update(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAssetObjectTypeAttributeDto,
    @CurrentUser() user: RequestUser,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const attr = await this.service.update(
      id,
      dto,
      spaceId,
      user.organizationId,
      user.userId,
    );

    return attr;
  }

  @Delete(':id')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({ summary: 'Delete an attribute definition' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiParam({ name: 'objectTypeId', description: 'Object type UUID' })
  @ApiParam({ name: 'id', description: 'Attribute definition UUID' })
  @ApiResponse({ status: 200, description: 'Attribute definition deleted' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Attribute definition not found' })
  async delete(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.delete(id, spaceId, user.organizationId);
  }
}
