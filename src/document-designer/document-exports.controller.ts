/**
 * @fileoverview Export + history endpoints for the Document Designer. Single
 * controller with explicit full route paths (`@Controller()` — no prefix) so
 * both the template-scoped export action and the org-wide export history live
 * in one place.
 *
 * The download branch uses `@Res()` + res.send(buffer) (mirrors the
 * saved-filters CSV export), which bypasses the global ResponseInterceptor —
 * the store branch therefore mirrors the UniformResponse envelope manually so
 * frontend consumers see one consistent shape.
 * @module src/document-designer/document-exports.controller
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { contentDispositionAttachment } from '../common/content-disposition';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PermissionsService } from '../permissions/permissions.service';
import { ExportDocumentDto } from './dto/export-document.dto';
import {
  PushDocumentToWikiDto,
  UpdateWikiPushDto,
} from './dto/push-document-to-wiki.dto';
import { DocumentExportsService } from './document-exports.service';
import { DocumentWikiPushService } from './document-wiki-push.service';
import type { IDocumentExportScope } from './rendering/document-data-resolver.service';
import type {
  DocumentExportSource,
  DocumentExportStatus,
} from './template-definition/template-definition.types';

@RequireFeature('module_document_designer')
@ApiTags('Document Exports')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller()
export class DocumentExportsController {
  constructor(
    private readonly service: DocumentExportsService,
    private readonly permissionsService: PermissionsService,
    private readonly wikiPushService: DocumentWikiPushService,
  ) {}

  /**
   * History/download rows are restricted to the caller's own exports unless
   * they hold can_manage_document_templates — export files embed space-scoped
   * data, and plain org membership (the route permission) must not grant
   * access to documents other members generated from spaces the caller cannot
   * access. Returns `undefined` (no restriction) for managers, else the
   * caller's user id.
   */
  private async resolveRequesterRestriction(
    user: RequestUser,
  ): Promise<string | undefined> {
    const viewAll = await this.permissionsService.hasAllPermissions(
      user.userId,
      user.organizationId,
      ['can_manage_document_templates'],
    );

    return viewAll ? undefined : user.userId;
  }

  @Post('document-templates/:id/export')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_export_documents')
  @ApiOperation({ summary: 'Export a document template (pdf / docx / html)' })
  @ApiParam({ name: 'id', example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211' })
  @ApiBody({ type: ExportDocumentDto })
  @ApiResponse({
    status: 200,
    description:
      "delivery 'download' (default): the file as an attachment; delivery 'store': { record, download } JSON.",
  })
  @ApiResponse({ status: 400, description: 'Invalid scope or template.' })
  @ApiResponse({ status: 404, description: 'Template not found.' })
  @ApiResponse({ status: 413, description: 'Scope exceeds the item cap.' })
  @ApiResponse({ status: 429, description: 'Too many exports in flight.' })
  @ApiResponse({ status: 501, description: 'PDF rendering unavailable.' })
  async exportTemplate(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExportDocumentDto,
    @Res() res: Response,
  ) {
    const result = await this.service.export({
      organizationId: user.organizationId,
      userId: user.userId,
      templateId: id,
      format: dto.format,
      scope: dto.scope as IDocumentExportScope,
      delivery: dto.delivery,
      fileName: dto.fileName,
      source: 'manual',
    });

    if (dto.delivery === 'store') {
      // The record was just created for this caller — restricting to their
      // own requested_by always passes and skips a permission lookup.
      const download = await this.service.getDownloadInfo(
        user.organizationId,
        result.record.id,
        user.userId,
      );

      // @Res bypasses the ResponseInterceptor — mirror its envelope manually.
      res.status(HttpStatus.OK).json({
        statusCode: HttpStatus.OK,
        hasError: false,
        data: { record: result.record, download, warnings: result.warnings },
        message: 'success',
      });

      return;
    }

    // RFC 5987 dual form: the service's sanitizeFileName keeps non-ASCII, so a raw CJK template
    // name here made res.set throw ERR_INVALID_CHAR (500) and umlauts arrived as mojibake. The
    // helper also neutralises quote/CRLF injection.
    res.set({
      'Content-Type': result.mimeType,
      'Content-Disposition': contentDispositionAttachment(
        String(result.fileName ?? 'export'),
      ),
      'Content-Length': String(result.buffer?.length ?? 0),
    });
    res.send(result.buffer);
  }

  @Get('document-exports')
  @RequirePermissions('can_view_document_templates')
  @ApiOperation({ summary: 'List export history for the organization' })
  @ApiQuery({ name: 'template_id', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'running', 'completed', 'failed'],
  })
  @ApiQuery({ name: 'source', required: false, enum: ['manual', 'automation'] })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, example: 20 })
  @ApiResponse({ status: 200, description: 'Export rows ({ data, count }).' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('template_id') templateId?: string,
    @Query('status') status?: string,
    @Query('source') source?: string,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize?: number,
  ) {
    return this.service.list(user.organizationId, {
      template_id: templateId,
      status: status as DocumentExportStatus | undefined,
      source: source as DocumentExportSource | undefined,
      requested_by: await this.resolveRequesterRestriction(user),
      page,
      pageSize,
    });
  }

  @Get('document-exports/:id')
  @RequirePermissions('can_view_document_templates')
  @ApiOperation({ summary: 'Get one export history row' })
  @ApiParam({ name: 'id', example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211' })
  @ApiResponse({ status: 200, description: 'Export row.' })
  @ApiResponse({ status: 404, description: 'Export not found.' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getById(
      user.organizationId,
      id,
      await this.resolveRequesterRestriction(user),
    );
  }

  @Get('document-exports/:id/download')
  @RequirePermissions('can_export_documents')
  @ApiOperation({ summary: 'Get a short-lived signed download URL' })
  @ApiParam({ name: 'id', example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211' })
  @ApiResponse({
    status: 200,
    description: 'Signed URL info ({ signedUrl, fileName, mimeType }).',
  })
  @ApiResponse({ status: 404, description: 'Export or file not found.' })
  async download(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getDownloadInfo(
      user.organizationId,
      id,
      await this.resolveRequesterRestriction(user),
    );
  }

  // Wiki push — route param is :templateId (never :id), so
  // SpacePermissionsGuard's params.id fallback can't misread it as a space id.

  @Post('document-templates/:templateId/export-to-wiki')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('can_export_documents')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('create_wiki_pages')
  @ApiOperation({ summary: 'Push a document template into a new wiki page' })
  @ApiParam({ name: 'templateId' })
  @ApiBody({ type: PushDocumentToWikiDto })
  async pushToWiki(
    @CurrentUser() user: RequestUser,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() dto: PushDocumentToWikiDto,
  ) {
    return this.wikiPushService.pushToWiki({
      organizationId: user.organizationId,
      userId: user.userId,
      templateId,
      spaceId: dto.space_id,
      scope: dto.scope,
      parentId: dto.parent_id,
      title: dto.title,
    });
  }

  @Put('document-templates/:templateId/export-to-wiki/:pageId')
  @RequirePermissions('can_export_documents')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('edit_wiki_pages')
  @ApiOperation({
    summary: 'Re-push a document template onto an existing wiki page',
  })
  @ApiParam({ name: 'templateId' })
  @ApiParam({ name: 'pageId' })
  @ApiBody({ type: UpdateWikiPushDto })
  async updateWikiPush(
    @CurrentUser() user: RequestUser,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Body() dto: UpdateWikiPushDto,
  ) {
    return this.wikiPushService.updateWikiPush({
      organizationId: user.organizationId,
      userId: user.userId,
      templateId,
      pageId,
      spaceId: dto.space_id,
      scope: dto.scope,
      confirmed: dto.confirmed,
    });
  }

  @Get('document-templates/:templateId/wiki-pushes')
  @RequirePermissions('can_view_document_templates')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({
    summary: 'List prior wiki pushes for a template, scoped to one space',
  })
  @ApiParam({ name: 'templateId' })
  @ApiQuery({ name: 'spaceId', required: true })
  async listWikiPushes(
    @CurrentUser() user: RequestUser,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Query('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.wikiPushService.listWikiPushes(
      templateId,
      spaceId,
      user.organizationId,
    );
  }
}
