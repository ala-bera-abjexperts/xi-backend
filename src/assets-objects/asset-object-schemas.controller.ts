import { UPLOAD_LIMITS } from '../common/upload-limits';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
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
import { AssetObjectSchemasService } from './asset-object-schemas.service';
import { normalizeAssetSort } from './asset-sort.util';
import { CreateAssetObjectSchemaDto } from './dto/create-asset-object-schema.dto';
import { UpdateAssetObjectSchemaDto } from './dto/update-asset-object-schema.dto';
import { ReorderObjectSchemasDto } from './dto/reorder-object-schemas.dto';

@RequireFeature('module_assets')
@ApiTags('asset-object-schemas')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/assets/schemas')
export class AssetObjectSchemasController {
  constructor(private readonly service: AssetObjectSchemasService) {}

  @Get()
  @RequireSpacePermission('view_assets')
  @ApiOperation({ summary: 'List all asset object schemas in a space' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'List of schemas returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  async list(
    @Param('spaceId') spaceId: string,
    @CurrentUser() user: RequestUser,
    @Query('sortField') sortField?: string,
    @Query('sortDirection') sortDirection?: string,
  ) {
    const schemas = await this.service.list(
      spaceId,
      user.organizationId,
      normalizeAssetSort(sortField, sortDirection),
    );

    return schemas;
  }

  // Declared ahead of the ':id' routes so "reorder" is not swallowed as a schema id.
  @Put('reorder')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({ summary: 'Apply a manual drag order to the schemas in a space' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Order applied' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  async reorder(
    @Param('spaceId') spaceId: string,
    @CurrentUser() user: RequestUser,
    @Body() dto: ReorderObjectSchemasDto,
  ) {
    return this.service.reorder(spaceId, user.organizationId, dto.items);
  }

  @Post()
  @RequireSpacePermission('manage_assets')
  @ApiOperation({ summary: 'Create a new asset object schema' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiResponse({ status: 201, description: 'Schema created successfully' })
  @ApiResponse({
    status: 400,
    description: 'Validation error (invalid name, object_key format, etc.)',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  async create(
    @Param('spaceId') spaceId: string,
    @Body() dto: CreateAssetObjectSchemaDto,
    @CurrentUser() user: RequestUser,
  ) {
    const schema = await this.service.create(
      dto,
      spaceId,
      user.organizationId,
      user.userId,
    );

    return schema;
  }

  @Get(':id')
  @RequireSpacePermission('view_assets')
  @ApiOperation({ summary: 'Get a single asset object schema by ID' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Schema UUID' })
  @ApiResponse({ status: 200, description: 'Schema returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Schema not found' })
  async getOne(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    const schema = await this.service.getOne(id, spaceId, user.organizationId);

    return schema;
  }

  // NOTE: /image must be declared before /:id PATCH so NestJS matches the static segment first
  @Post(':id/image')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary: 'Upload or replace the image for a schema (max 5 MB)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Schema UUID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Image file (max 5 MB, jpeg/png/gif/webp/svg)',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Image uploaded; schema returned with image_path set',
  })
  @ApiResponse({
    status: 400,
    description: 'Missing file, invalid type, or file too large',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Schema not found' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: UPLOAD_LIMITS.SMALL_IMAGE },
    }),
  )
  async uploadImage(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.uploadImage(id, spaceId, user.organizationId, file);
  }

  @Delete(':id/image')
  @RequireSpacePermission('manage_assets')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove the custom image from a schema' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Schema UUID' })
  @ApiResponse({
    status: 200,
    description: 'Image removed; schema returned with image_path null',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Schema not found' })
  async deleteImage(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.deleteImage(id, spaceId, user.organizationId);
  }

  @Patch(':id')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary: 'Update an asset object schema (optimistic lock via version)',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Schema UUID' })
  @ApiResponse({ status: 200, description: 'Schema updated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Schema not found' })
  @ApiResponse({
    status: 409,
    description: 'Version conflict — schema was updated by another request',
  })
  async update(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAssetObjectSchemaDto,
    @CurrentUser() user: RequestUser,
  ) {
    const schema = await this.service.update(
      id,
      dto,
      spaceId,
      user.organizationId,
      user.userId,
    );

    return schema;
  }

  @Patch(':id/archive')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary: 'Archive an asset object schema (no new objects can be added)',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Schema UUID' })
  @ApiResponse({ status: 200, description: 'Schema archived' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Schema not found' })
  async archive(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.archive(id, spaceId, user.organizationId, user.userId);
  }

  @Delete(':id')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary:
      'Delete an asset object schema (rejected if object types still exist)',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Schema UUID' })
  @ApiResponse({ status: 200, description: 'Schema deleted' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Schema not found' })
  @ApiResponse({
    status: 409,
    description: 'Schema still has object types — delete them first',
  })
  async delete(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.delete(id, spaceId, user.organizationId);
  }
}
