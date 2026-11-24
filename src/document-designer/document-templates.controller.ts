import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  BulkDocumentTemplateIdsDto,
  BulkUpdateDocumentTemplatesDto,
} from './dto/bulk-document-templates.dto';
import { CreateDocumentTemplateDto } from './dto/create-document-template.dto';
import { DuplicateDocumentTemplateDto } from './dto/duplicate-document-template.dto';
import { PreviewDocumentDto } from './dto/preview-document.dto';
import { ResolveImagesDto } from './dto/resolve-images.dto';
import { UpdateDocumentTemplateDto } from './dto/update-document-template.dto';
import { DocumentTemplatesService } from './document-templates.service';
import { DOCUMENT_SOURCE_ENTITIES } from './source-entities';

@RequireFeature('module_document_designer')
@ApiTags('Document Templates')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('document-templates')
export class DocumentTemplatesController {
  constructor(private readonly service: DocumentTemplatesService) {}

  // NOTE: static paths ('bindable-fields', 'preview') MUST be declared before
  // the ':id' routes — Nest matches routes in declaration order per method.

  @Get()
  @RequirePermissions('can_view_document_templates')
  @ApiOperation({ summary: 'List document templates' })
  @ApiQuery({ name: 'search', required: false, example: 'Status Report' })
  @ApiQuery({
    name: 'source_entity',
    required: false,
    enum: DOCUMENT_SOURCE_ENTITIES,
  })
  @ApiQuery({
    name: 'include_archived',
    required: false,
    type: Boolean,
    example: false,
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Template list with pagination metadata.',
  })
  @ApiResponse({
    status: 403,
    description:
      'Document Designer module disabled or insufficient permissions.',
  })
  list(
    @CurrentUser() user: RequestUser,
    @Query('search') search?: string,
    @Query('source_entity') sourceEntity?: string,
    @Query('include_archived', new ParseBoolPipe({ optional: true }))
    includeArchived?: boolean,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize?: number,
  ) {
    return this.service.list(user.organizationId, {
      search,
      source_entity: sourceEntity,
      include_archived: includeArchived,
      page,
      pageSize,
    });
  }

  @Get('bindable-fields')
  @RequirePermissions('can_view_document_templates')
  @ApiOperation({
    summary: 'List bindable fields and relation types for the designer',
  })
  @ApiQuery({
    name: 'source_entity',
    required: true,
    enum: DOCUMENT_SOURCE_ENTITIES,
  })
  @ApiQuery({
    name: 'space_ids',
    required: false,
    description: 'Comma-separated space UUIDs to scope space custom fields.',
  })
  @ApiResponse({
    status: 200,
    description: 'Bindable field catalog ({ fields, relationTypes }).',
  })
  @ApiResponse({ status: 400, description: 'Invalid source_entity.' })
  getBindableFields(
    @CurrentUser() user: RequestUser,
    @Query('source_entity') sourceEntity: string,
    @Query('space_ids') spaceIds?: string,
  ) {
    const parsedSpaceIds = spaceIds
      ? spaceIds
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : undefined;

    return this.service.getBindableFields(
      user.organizationId,
      sourceEntity,
      parsedSpaceIds,
    );
  }

  @Get('starter-templates')
  @RequirePermissions('can_view_document_templates')
  @ApiOperation({ summary: 'List the built-in starter template catalog' })
  getStarterTemplates() {
    return this.service.getStarterTemplates();
  }

  // 3 path segments ('starter-templates', ':key', 'use') deliberately — a
  // 2-segment 'from-starter/:key' shape could collide with ':id/duplicate'.
  @Post('starter-templates/:key/use')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_document_templates')
  @ApiOperation({
    summary: 'Create a document template from a starter catalog entry',
  })
  @ApiParam({ name: 'key', example: 'task-report' })
  @ApiBody({ type: DuplicateDocumentTemplateDto, required: false })
  @ApiResponse({
    status: 201,
    description: 'Template created from the starter entry.',
  })
  @ApiResponse({ status: 404, description: 'Unknown starter template key.' })
  useStarterTemplate(
    @CurrentUser() user: RequestUser,
    @Param('key') key: string,
    @Body() dto: DuplicateDocumentTemplateDto,
  ) {
    return this.service.createFromStarter(
      user.organizationId,
      user.userId,
      key,
      dto ?? {},
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_document_templates')
  @ApiOperation({ summary: 'Create a document template' })
  @ApiBody({ type: CreateDocumentTemplateDto })
  @ApiResponse({ status: 201, description: 'Template created.' })
  @ApiResponse({
    status: 400,
    description: 'Invalid payload or template definition.',
  })
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateDocumentTemplateDto,
  ) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_view_document_templates')
  @ApiOperation({ summary: 'Render an ad-hoc definition preview' })
  @ApiBody({ type: PreviewDocumentDto })
  @ApiResponse({
    status: 200,
    description: 'Rendered preview ({ html, itemCount, warnings }).',
  })
  @ApiResponse({ status: 400, description: 'Invalid definition or scope.' })
  preview(@CurrentUser() user: RequestUser, @Body() dto: PreviewDocumentDto) {
    return this.service.preview(user.organizationId, user.userId, dto);
  }

  @Post('bulk-update')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_document_templates')
  @ApiOperation({ summary: 'Archive or restore several document templates' })
  @ApiBody({ type: BulkUpdateDocumentTemplatesDto })
  @ApiResponse({
    status: 200,
    description: 'Updated ids and ids that failed ({ succeeded, failed }).',
  })
  bulkUpdate(
    @CurrentUser() user: RequestUser,
    @Body() dto: BulkUpdateDocumentTemplatesDto,
  ) {
    return this.service.bulkUpdate(user.organizationId, user.userId, dto.ids, {
      is_archived: dto.is_archived,
    });
  }

  @Post('bulk-delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_manage_document_templates')
  @ApiOperation({ summary: 'Delete several document templates' })
  @ApiBody({ type: BulkDocumentTemplateIdsDto })
  @ApiResponse({
    status: 200,
    description: 'Deleted ids and ids that failed ({ succeeded, failed }).',
  })
  bulkDelete(
    @CurrentUser() user: RequestUser,
    @Body() dto: BulkDocumentTemplateIdsDto,
  ) {
    return this.service.bulkDelete(user.organizationId, user.userId, dto.ids);
  }

  @Get(':id')
  @RequirePermissions('can_view_document_templates')
  @ApiOperation({ summary: 'Get a document template by ID' })
  @ApiParam({ name: 'id', example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211' })
  @ApiResponse({ status: 200, description: 'Template row.' })
  @ApiResponse({ status: 404, description: 'Template not found.' })
  getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getById(user.organizationId, id);
  }

  @Post(':id/images/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_view_document_templates')
  @ApiOperation({
    summary: 'Sign a batch of storage-kind image sources for canvas display',
  })
  @ApiParam({ name: 'id', example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211' })
  @ApiBody({ type: ResolveImagesDto })
  @ApiResponse({
    status: 200,
    description:
      'Signed URLs keyed by "bucket/path" (empty string if unresolved).',
  })
  @ApiResponse({ status: 404, description: 'Template not found.' })
  resolveImages(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveImagesDto,
  ) {
    return this.service.resolveElementImages(
      user.organizationId,
      id,
      dto.images,
    );
  }

  @Patch(':id')
  @RequirePermissions('can_manage_document_templates')
  @ApiOperation({ summary: 'Update a document template' })
  @ApiParam({ name: 'id', example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211' })
  @ApiBody({ type: UpdateDocumentTemplateDto })
  @ApiResponse({ status: 200, description: 'Updated template row.' })
  @ApiResponse({
    status: 400,
    description: 'Invalid payload or template definition.',
  })
  @ApiResponse({ status: 404, description: 'Template not found.' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocumentTemplateDto,
  ) {
    return this.service.update(user.organizationId, user.userId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('can_manage_document_templates')
  @ApiOperation({ summary: 'Delete a document template' })
  @ApiParam({ name: 'id', example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211' })
  @ApiResponse({ status: 200, description: 'Template deleted.' })
  @ApiResponse({ status: 404, description: 'Template not found.' })
  remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.delete(user.organizationId, user.userId, id);
  }

  @Post(':id/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_document_templates')
  @ApiOperation({ summary: 'Duplicate a document template' })
  @ApiParam({ name: 'id', example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211' })
  @ApiBody({ type: DuplicateDocumentTemplateDto, required: false })
  @ApiResponse({ status: 201, description: 'Duplicated template row.' })
  @ApiResponse({ status: 404, description: 'Template not found.' })
  duplicate(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DuplicateDocumentTemplateDto,
  ) {
    return this.service.duplicate(
      user.organizationId,
      user.userId,
      id,
      dto ?? {},
    );
  }

  @Post(':id/images')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_document_templates')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  @ApiOperation({
    summary:
      'Upload an image for an image element (max 5 MB, JPEG/PNG/GIF/WEBP)',
  })
  @ApiParam({ name: 'id', example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Image uploaded — bucket + path returned.',
  })
  @ApiResponse({
    status: 400,
    description: 'No file, too large, or invalid MIME type.',
  })
  @ApiResponse({ status: 404, description: 'Template not found.' })
  async uploadImage(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');

    return this.service.uploadElementImage(user.organizationId, id, file);
  }

  @Post(':id/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_view_document_templates')
  @ApiOperation({
    summary: "Render a preview of a stored template's definition",
  })
  @ApiParam({ name: 'id', example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211' })
  @ApiBody({ type: PreviewDocumentDto, required: false })
  @ApiResponse({
    status: 200,
    description: 'Rendered preview ({ html, itemCount, warnings }).',
  })
  @ApiResponse({ status: 404, description: 'Template not found.' })
  previewById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PreviewDocumentDto,
  ) {
    return this.service.previewById(
      user.organizationId,
      user.userId,
      id,
      dto ?? {},
    );
  }
}
