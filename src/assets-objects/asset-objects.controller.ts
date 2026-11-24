import { UPLOAD_LIMITS } from '../common/upload-limits';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { contentDispositionAttachment } from '../common/content-disposition';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AssetObjectsService } from './asset-objects.service';
import type { AssetObjectSortField } from './asset-objects.service';
import { AssetObjectsImportService } from './asset-objects-import.service';
import { AssetObjectsExportService } from './asset-objects-export.service';
import { CreateAssetObjectDto } from './dto/create-asset-object.dto';
import { UpdateAssetObjectDto } from './dto/update-asset-object.dto';
import type {
  ColumnMapping,
  DuplicateMode,
} from './dto/import-asset-objects.dto';
import { DUPLICATE_MODES } from './dto/import-asset-objects.dto';
import {
  ATTRIBUTE_FIELD_PREFIX,
  parseFilterParam,
} from './filtering/asset-filter-fields';

@RequireFeature('module_assets')
@ApiTags('asset-objects')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/assets/schemas/:schemaId/objects')
export class AssetObjectsController {
  constructor(
    private readonly service: AssetObjectsService,
    private readonly importService: AssetObjectsImportService,
    private readonly exportService: AssetObjectsExportService,
  ) {}

  @Get()
  @RequireSpacePermission('view_assets')
  @ApiOperation({
    summary: 'List asset objects in a schema (optionally filtered by type)',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiQuery({
    name: 'objectTypeId',
    required: false,
    description: 'Filter by object type UUID',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Results per page (default: 50)',
  })
  @ApiQuery({
    name: 'sortField',
    required: false,
    description:
      'Sort column: object_key | name | created_at | updated_at, or attr_<field_key> ' +
      'for a sortable schema attribute (default: created_at)',
  })
  @ApiQuery({
    name: 'sortDirection',
    required: false,
    description: 'Sort direction: asc | desc (default: desc)',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description:
      'Filter by name or object_key (case-insensitive substring match)',
  })
  @ApiQuery({
    name: 'filter',
    required: false,
    description:
      'JSON-encoded condition group: {"combinator":"and"|"or","rules":[{"field","operator","value"}]}. ' +
      'Fields are base columns (name, object_key, description, object_type_id, created_at, updated_at) ' +
      'or schema attributes prefixed attr_<field_key>. Flat only — nested groups are rejected.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of objects with total count',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  async list(
    @Param('spaceId') spaceId: string,
    @Param('schemaId') schemaId: string,
    @Query('objectTypeId') objectTypeId: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Query('sortField') sortField: string | undefined,
    @Query('sortDirection') sortDirection: string | undefined,
    @Query('search') search: string | undefined,
    @Query('filter') filter: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    const validSortFields = [
      'object_key',
      'name',
      'created_at',
      'updated_at',
    ] as const;
    // `attr_<field_key>` is passed through and resolved against the schema by
    // the service, which falls back to the default when it is not sortable.
    const resolvedField: AssetObjectSortField =
      validSortFields.includes(sortField as any) ||
      sortField?.startsWith(ATTRIBUTE_FIELD_PREFIX)
        ? (sortField as AssetObjectSortField)
        : 'created_at';
    const resolvedDirection = sortDirection === 'asc' ? 'asc' : 'desc';

    // Parsed and structurally validated here so a malformed filter fails with
    // 400 before any query is built. Returns null for absent/empty, which the
    // service treats as "no filter" rather than "match nothing".
    const resolvedFilter = parseFilterParam(filter);

    return this.service.list(
      schemaId,
      objectTypeId,
      spaceId,
      user.organizationId,
      user.userId,
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 50,
      resolvedField,
      resolvedDirection,
      search,
      resolvedFilter,
    );
  }

  @Post('import/preview')
  @RequireSpacePermission('manage_assets')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: UPLOAD_LIMITS.SMALL_IMAGE },
    }),
  )
  async previewImport(@UploadedFile() file: Express.Multer.File) {
    return this.importService.preview(file);
  }

  @Post('import')
  @RequireSpacePermission('manage_assets')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: UPLOAD_LIMITS.SMALL_IMAGE },
    }),
  )
  async importObjects(
    @Param('spaceId') spaceId: string,
    @Param('schemaId') schemaId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('objectTypeId') objectTypeId: string,
    @Body('mapping') mappingJson: string,
    @Body('duplicateMode') duplicateMode: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    let mappings: ColumnMapping[];

    try {
      mappings = JSON.parse(mappingJson) as ColumnMapping[];
    } catch {
      return {
        imported: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        errors: [{ row: 0, field: 'mapping', message: 'Invalid mapping JSON' }],
      };
    }

    // Absent means 'skip'. Defaulting to 'create' looked like safe back-compat but meant any
    // caller that omits the field — a browser on an older bundle included — silently created
    // the duplicates this feature exists to prevent. Opting IN to duplicates is the safe side.
    const mode = (DUPLICATE_MODES as readonly string[]).includes(
      duplicateMode ?? '',
    )
      ? (duplicateMode as DuplicateMode)
      : 'skip';

    return this.importService.importObjects(
      file,
      schemaId,
      spaceId,
      user.organizationId,
      user.userId,
      objectTypeId,
      mappings,
      mode,
    );
  }

  @Post('import/dry-run')
  @RequireSpacePermission('manage_assets')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: UPLOAD_LIMITS.SMALL_IMAGE },
    }),
  )
  @ApiOperation({
    summary: 'Count what an import would do, without writing anything',
  })
  async dryRunImport(
    @Param('spaceId') spaceId: string,
    @Param('schemaId') schemaId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('objectTypeId') objectTypeId: string,
    @Body('mapping') mappingJson: string,
    @Body('duplicateMode') duplicateMode: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    let mappings: ColumnMapping[];

    try {
      mappings = JSON.parse(mappingJson) as ColumnMapping[];
    } catch {
      throw new BadRequestException('Invalid mapping JSON');
    }

    // Same default as the real import: an omitted mode must never mean 'create'.
    const mode = (DUPLICATE_MODES as readonly string[]).includes(
      duplicateMode ?? '',
    )
      ? (duplicateMode as DuplicateMode)
      : 'skip';

    return this.importService.dryRun(
      file,
      objectTypeId,
      schemaId,
      spaceId,
      user.organizationId,
      user.userId,
      mappings,
      mode,
    );
  }

  @Get('stats')
  @RequireSpacePermission('view_assets')
  @ApiOperation({
    summary: 'Get aggregate stats for a schema (total + updated in 24h)',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiResponse({ status: 200, description: 'Schema stats returned' })
  async getStats(
    @Param('spaceId') spaceId: string,
    @Param('schemaId') schemaId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{ total: number; updatedLast24h: number }> {
    return this.service.getSchemaStats(schemaId, spaceId, user.organizationId);
  }

  // MUST stay above @Get(':id'): declared after it, Nest matches 'export' as an object id.
  @Get('export')
  @RequireSpacePermission('view_assets')
  @ApiOperation({
    summary: 'Export the objects of one object type as csv, xls or xlsx',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiQuery({ name: 'format', required: true, description: 'csv | xls | xlsx' })
  @ApiQuery({
    name: 'objectTypeId',
    required: true,
    description: 'Object type UUID — decides the exported columns',
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({
    name: 'filter',
    required: false,
    description: 'Same JSON-encoded condition group as the list endpoint',
  })
  @ApiQuery({ name: 'sortField', required: false })
  @ApiQuery({ name: 'sortDirection', required: false })
  @ApiResponse({ status: 200, description: 'File download' })
  @ApiResponse({
    status: 400,
    description: 'Unknown format, or the selection cannot be read in full',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  async exportObjects(
    @Param('spaceId') spaceId: string,
    @Param('schemaId') schemaId: string,
    @Query('format') format: string,
    @Query('objectTypeId') objectTypeId: string,
    @Query('search') search: string | undefined,
    @Query('filter') filter: string | undefined,
    @Query('sortField') sortField: string | undefined,
    @Query('sortDirection') sortDirection: string | undefined,
    @CurrentUser() user: RequestUser,
    // @Res() without passthrough skips the global ResponseInterceptor, so the
    // binary body is sent as-is instead of being wrapped in the JSON envelope.
    @Res() res: Response,
  ) {
    const validSortFields = [
      'object_key',
      'name',
      'created_at',
      'updated_at',
    ] as const;
    const resolvedField = (validSortFields as readonly string[]).includes(
      sortField ?? '',
    )
      ? (sortField as (typeof validSortFields)[number])
      : 'created_at';
    const resolvedDirection = sortDirection === 'asc' ? 'asc' : 'desc';

    const { buffer, fileName, contentType } =
      await this.exportService.exportObjects(
        schemaId,
        objectTypeId,
        spaceId,
        user.organizationId,
        user.userId,
        format,
        resolvedField,
        resolvedDirection,
        search,
        parseFilterParam(filter),
      );

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      contentDispositionAttachment(fileName),
    );

    return res.send(buffer);
  }

  // MUST stay above @Get(':id'): declared after it, Nest matches 'search' as an object id.
  @Get('search')
  @RequireSpacePermission('view_assets')
  @ApiOperation({
    summary: 'Search objects across the viewable object types of a schema',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiQuery({
    name: 'search',
    required: false,
    description:
      'Case-insensitive match on name, object key or attribute values',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: '1-50, default 25',
  })
  @ApiQuery({
    name: 'objectTypeId',
    required: false,
    description: 'Limit the search to one object type UUID',
  })
  @ApiResponse({
    status: 200,
    description: 'Matching objects with total count',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  async searchObjects(
    @Param('spaceId') spaceId: string,
    @Param('schemaId') schemaId: string,
    @Query('search') search: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Query('objectTypeId') objectTypeId: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    const parsedPage = Math.max(1, parseInt(page ?? '', 10) || 1);

    const parsedPageSize = Math.min(
      50,
      Math.max(1, parseInt(pageSize ?? '', 10) || 25),
    );

    return this.service.searchSchemaObjects(
      schemaId,
      spaceId,
      user.organizationId,
      user.userId,
      search,
      parsedPage,
      parsedPageSize,
      objectTypeId,
    );
  }

  @Get(':id')
  @RequireSpacePermission('view_assets')
  @ApiOperation({ summary: 'Get a single asset object by ID' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiResponse({ status: 200, description: 'Asset object returned' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing view_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Asset object not found' })
  async getOne(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    const obj = await this.service.getOne(
      id,
      spaceId,
      user.organizationId,
      user.userId,
    );

    return obj;
  }

  @Post()
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary: 'Create a new asset object instance',
    description:
      'A unique object_key (e.g. CMDB-42) is auto-assigned by a DB trigger.',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiResponse({
    status: 201,
    description: 'Asset object created; object_key auto-assigned',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error or object type not in this schema',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  async create(
    @Param('spaceId') spaceId: string,
    @Param('schemaId') schemaId: string,
    @Body() dto: CreateAssetObjectDto,
    @CurrentUser() user: RequestUser,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const obj = await this.service.create(
      dto,
      schemaId,
      spaceId,
      user.organizationId,
      user.userId,
    );

    return obj;
  }

  // NOTE: /image must be declared before /:id PATCH so NestJS matches the static segment first
  @Post(':id/image')
  @RequireSpacePermission('edit_assets')
  @ApiOperation({
    summary: 'Upload or replace the image for an asset object (max 5 MB)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
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
    description: 'Image uploaded; object returned with image_path set',
  })
  @ApiResponse({
    status: 400,
    description: 'Missing file, invalid type, or file too large',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing edit_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Asset object not found' })
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

  @Delete(':id/image')
  @RequireSpacePermission('edit_assets')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove the custom image from an asset object' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiResponse({
    status: 200,
    description: 'Image removed; object returned with image_path null',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing edit_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Asset object not found' })
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

  @Patch(':id')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({
    summary: 'Update an asset object (optimistic lock via version)',
  })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiResponse({ status: 200, description: 'Asset object updated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Asset object not found' })
  @ApiResponse({
    status: 409,
    description: 'Version conflict — object was updated by another request',
  })
  async update(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAssetObjectDto,
    @CurrentUser() user: RequestUser,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const obj = await this.service.update(
      id,
      dto,
      spaceId,
      user.organizationId,
      user.userId,
    );

    return obj;
  }

  @Delete(':id')
  @RequireSpacePermission('manage_assets')
  @ApiOperation({ summary: 'Delete an asset object permanently' })
  @ApiParam({ name: 'spaceId', description: 'Space UUID' })
  @ApiParam({ name: 'schemaId', description: 'Schema UUID' })
  @ApiParam({ name: 'id', description: 'Object UUID' })
  @ApiResponse({ status: 200, description: 'Asset object deleted' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Missing manage_assets permission or module disabled',
  })
  @ApiResponse({ status: 404, description: 'Asset object not found' })
  async delete(
    @Param('spaceId') spaceId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.delete(id, spaceId, user.organizationId, user.userId);
  }
}
