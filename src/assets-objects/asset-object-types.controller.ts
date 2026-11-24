import { UPLOAD_LIMITS } from '../common/upload-limits';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiBearerAuth,
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
import type { Request } from 'express';
import { readAccessTokenCookie } from '../auth/cookies.util';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { AssetObjectTypesService } from './asset-object-types.service';
import { normalizeAssetSort } from './asset-sort.util';
import { CreateAssetObjectTypeDto } from './dto/create-asset-object-type.dto';
import { UpdateAssetObjectTypeDto } from './dto/update-asset-object-type.dto';
import { MoveObjectTypeDto } from './dto/move-object-type.dto';
import { SetAssetObjectTypePermissionsDto } from './dto/asset-object-type-permissions.dto';

@RequireFeature('module_assets')
@ApiTags('asset-object-types')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/assets')
export class AssetObjectTypesController {
  constructor(private readonly service: AssetObjectTypesService) {}

  @Get('schemas/:schemaId/object-types')
  @RequireSpacePermission('view_assets')
  @ApiOperation({
    summary: 'Get the full nested object-type tree for a schema',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiResponse({ status: 200, description: 'Nested type tree returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  async getTree(
    @Param('spaceId') spaceId: string,
    @Param('schemaId') schemaId: string,
    @CurrentUser() user: RequestUser,
    @Query('sortField') sortField?: string,
    @Query('sortDirection') sortDirection?: string,
  ) {
    const tree = await this.service.getTree(
      schemaId,
      spaceId,
      user.organizationId,
      user.userId,
      normalizeAssetSort(sortField, sortDirection),
    );

    return tree;
  }

  @Post('schemas/:schemaId/object-types')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary:
      'Create an object type inside a schema (optionally under a parent)',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiResponse({ status: 201, description: 'Object type created' })
  @ApiResponse({
    status: 400,
    description: 'Validation error or schema_id mismatch',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  async create(
    @Param('spaceId') spaceId: string,
    @Param('schemaId') schemaId: string,
    @Body() dto: CreateAssetObjectTypeDto,
    @CurrentUser() user: RequestUser,
  ) {
    // Merge schemaId from URL into the DTO (body schema_id must match or be absent)
    if (dto.schema_id && dto.schema_id !== schemaId) {
      throw new Error('schema_id in body does not match the URL parameter');
    }

    const merged = { ...dto, schema_id: schemaId };
    const type = await this.service.create(
      merged,
      spaceId,
      user.organizationId,
      user.userId,
    );

    return type;
  }

  // NOTE: /permissions, /my-permission, and /rest-config must be declared before /:id GET so NestJS
  // matches static segments first and doesn't treat them as :id param values.

  @Get('object-types/:id/my-permission')
  @RequireSpacePermission('view_assets')
  @ApiOperation({
    summary:
      "Get the calling user's effective CRUD permissions for an object type",
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object type UUID' })
  @ApiResponse({ status: 200, description: 'Effective permissions returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Missing view_assets permission' })
  async getMyPermission(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{
    can_view: boolean;
    can_create: boolean;
    can_edit: boolean;
    can_delete: boolean;
  }> {
    return this.service.getMyPermission(
      id,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }

  @Get('object-types/:id/permissions')
  @RequireSpacePermission('view_assets')
  @ApiOperation({ summary: 'Get group permission entries for an object type' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object type UUID' })
  @ApiResponse({ status: 200, description: 'Permission entries returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Object type not found' })
  async getPermissions(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    const data = await this.service.getPermissions(
      id,
      spaceId,
      user.organizationId,
    );

    return { data };
  }

  @Put('object-types/:id/permissions')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary:
      'Set group permissions for an object type (replaces group_permissions list)',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object type UUID' })
  @ApiResponse({
    status: 200,
    description: 'Permissions saved; enriched list returned',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid group IDs or validation error',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Object type not found' })
  async savePermissions(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Body() dto: SetAssetObjectTypePermissionsDto,
    @CurrentUser() user: RequestUser,
  ) {
    const data = await this.service.savePermissions(
      id,
      spaceId,
      user.organizationId,
      dto,
      user.userId,
    );

    return { data };
  }

  // Hands the caller their own login token for the REST config copy buttons; never cached, never during impersonation
  @Get('rest-config/token')
  @RequireSpacePermission('view_assets')
  @ImpersonationBlocked()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get the current session token for REST API examples',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiResponse({
    status: 200,
    description: 'Current access token (expires with the session)',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets, module disabled or impersonating',
  })
  getRestConfigToken(@Req() req: Request) {
    // Same precedence as SupabaseAuthGuard: Bearer header first, then the access_token cookie
    const [type, headerToken] = req.headers.authorization?.split(' ') ?? [];
    const token =
      type === 'Bearer' && headerToken
        ? headerToken
        : readAccessTokenCookie(
            req.cookies as Record<string, string | undefined>,
          );

    return { token: token ?? null };
  }

  // NOTE: /rest-config must be declared before /:id GET so NestJS matches the static
  // segment first and doesn't treat "rest-config" as an :id param
  @Get('object-types/:id/rest-config')
  @RequireSpacePermission('view_assets')
  @ApiOperation({
    summary: 'Get REST API config and cURL examples for an object type',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object type UUID' })
  @ApiResponse({
    status: 200,
    description: 'REST config with cURL templates returned',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Object type not found' })
  async getRestConfig(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    const config = await this.service.getRestConfig(
      id,
      spaceId,
      user.organizationId,
    );

    return config;
  }

  @Get('object-types/:id')
  @RequireSpacePermission('view_assets')
  @ApiOperation({ summary: 'Get a single object type by ID' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object type UUID' })
  @ApiResponse({ status: 200, description: 'Object type returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Object type not found' })
  async getOne(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    const type = await this.service.getOne(id, spaceId, user.organizationId);

    return type;
  }

  // NOTE: /move must be declared before /:id PATCH so NestJS matches the static
  // segment first and doesn't treat "move" as an :id param
  @Patch('object-types/:id/move')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary:
      'Move an object type to a new parent (cycle-safe BFS detection, max depth 10)',
    description:
      'Recomputes parent_ids and depth for the entire subtree. Omit new_parent_id to move to root.',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object type UUID to move' })
  @ApiResponse({
    status: 200,
    description: 'Object type moved; subtree parent_ids/depth updated',
  })
  @ApiResponse({
    status: 400,
    description: 'Would create circular reference or exceed max depth 10',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Object type not found' })
  @ApiResponse({
    status: 409,
    description: 'Version conflict — type was updated by another request',
  })
  async move(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Body() dto: MoveObjectTypeDto,
    @CurrentUser() user: RequestUser,
  ) {
    const type = await this.service.move(
      id,
      dto,
      spaceId,
      user.organizationId,
      user.userId,
    );

    return type;
  }

  @Patch('object-types/:id')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary: 'Update an object type metadata (optimistic lock via version)',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object type UUID' })
  @ApiResponse({ status: 200, description: 'Object type updated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Object type not found' })
  @ApiResponse({
    status: 409,
    description: 'Version conflict — type was updated by another request',
  })
  async update(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAssetObjectTypeDto,
    @CurrentUser() user: RequestUser,
  ) {
    const type = await this.service.update(
      id,
      dto,
      spaceId,
      user.organizationId,
      user.userId,
    );

    return type;
  }

  @Delete('object-types/:id')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary: 'Delete an object type (rejected if it has child types)',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object type UUID' })
  @ApiResponse({ status: 200, description: 'Object type deleted' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Object type not found' })
  @ApiResponse({
    status: 409,
    description: 'Object type still has child types — delete leaf nodes first',
  })
  async delete(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.delete(id, spaceId, user.organizationId, user.userId);
  }

  // NOTE: /image endpoints are placed after /:id DELETE so the static segment matches first

  @Post('object-types/:id/image')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary: 'Upload or replace the image for an object type (max 5 MB)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object type UUID' })
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
    description: 'Image uploaded; type returned with image_path set',
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
  @ApiResponse({ status: 404, description: 'Object type not found' })
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
    return this.service.uploadImage(
      id,
      spaceId,
      user.organizationId,
      user.userId,
      file,
    );
  }

  @Delete('object-types/:id/image')
  @RequireSpacePermission('manage_assets')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove the custom image from an object type' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'id', description: 'Object type UUID' })
  @ApiResponse({
    status: 200,
    description: 'Image removed; type returned with image_path null',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Object type not found' })
  async deleteImage(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.deleteImage(
      id,
      spaceId,
      user.organizationId,
      user.userId,
    );
  }
}
