/**
 * @fileoverview Org-scoped GDPR REST controller.
 * All routes are under `/gdpr`.
 * @module src/gdpr/gdpr.controller
 */

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { GdprService } from './gdpr.service';
import { UpdateSpreadsheetDto } from './dto/update-spreadsheet.dto';
import { AddColumnDto } from './dto/add-column.dto';
import { RenameColumnDto } from './dto/rename-column.dto';
import { ReorderColumnsDto } from './dto/reorder-columns.dto';
import { CreateRecordDto } from './dto/create-record.dto';
import { UpdateRecordDto } from './dto/update-record.dto';
import { ListRecordsQueryDto } from './dto/list-records-query.dto';
import { BulkUpdateCellsDto } from './dto/bulk-update-cells.dto';
import { ReorderRecordsDto } from './dto/reorder-records.dto';
import { ToggleArchiveDto } from './dto/toggle-archive.dto';
import { CreateGdprCommentDto } from './dto/create-gdpr-comment.dto';
import { UpdateGdprCommentDto } from './dto/update-gdpr-comment.dto';

@RequireFeature('module_gdpr')
@ApiTags('GDPR')
@ApiBearerAuth()
@Controller('gdpr')
export class GdprController {
  constructor(private readonly service: GdprService) {}

  // ========================================================================
  // Spreadsheet
  // ========================================================================

  @Get('spreadsheet')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_gdpr')
  @ApiOperation({ summary: 'Get or auto-create the GDPR spreadsheet' })
  @ApiResponse({ status: 200 })
  getSpreadsheet(@CurrentUser() user: RequestUser) {
    return this.service.getOrCreateSpreadsheet(
      user.organizationId,
      user.userId,
    );
  }

  @Get('spreadsheet-with-records')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_gdpr')
  @ApiOperation({ summary: 'Get GDPR spreadsheet with all matching records' })
  getSpreadsheetWithRecords(
    @CurrentUser() user: RequestUser,
    @Query() query: ListRecordsQueryDto,
  ) {
    return this.service.getSpreadsheetWithRecords(
      user.organizationId,
      user.userId,
      query,
    );
  }

  @Put('spreadsheet')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_gdpr')
  @ApiOperation({ summary: 'Update GDPR spreadsheet metadata' })
  updateSpreadsheet(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateSpreadsheetDto,
  ) {
    return this.service.updateSpreadsheet(
      user.organizationId,
      user.userId,
      dto,
    );
  }

  // ========================================================================
  // Columns — static path /columns/reorder MUST precede /:columnId
  // ========================================================================

  @Post('spreadsheet/columns')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_gdpr')
  @ApiOperation({ summary: 'Add a column to the spreadsheet' })
  addColumn(@CurrentUser() user: RequestUser, @Body() dto: AddColumnDto) {
    return this.service.addColumn(user.organizationId, user.userId, dto);
  }

  @Post('spreadsheet/columns/reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_gdpr')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder spreadsheet columns' })
  reorderColumns(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReorderColumnsDto,
  ) {
    return this.service.reorderColumns(user.organizationId, user.userId, dto);
  }

  @Patch('spreadsheet/columns/:columnId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_gdpr')
  @ApiOperation({ summary: 'Rename a spreadsheet column' })
  @ApiParam({ name: 'columnId' })
  renameColumn(
    @CurrentUser() user: RequestUser,
    @Param('columnId') columnId: string,
    @Body() dto: RenameColumnDto,
  ) {
    return this.service.renameColumn(
      user.organizationId,
      columnId,
      user.userId,
      dto,
    );
  }

  @Delete('spreadsheet/columns/:columnId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_gdpr')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a spreadsheet column' })
  @ApiParam({ name: 'columnId' })
  removeColumn(
    @CurrentUser() user: RequestUser,
    @Param('columnId') columnId: string,
  ) {
    return this.service.removeColumn(
      user.organizationId,
      columnId,
      user.userId,
    );
  }

  // ========================================================================
  // Records — static sub-paths MUST precede /:id
  // ========================================================================

  @Get('export')
  @ImpersonationBlocked()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_export_data_gdpr')
  @ApiOperation({ summary: 'Export GDPR records to CSV' })
  @ApiResponse({ status: 200, description: 'CSV file download' })
  async exportToCsv(@CurrentUser() user: RequestUser, @Res() res: Response) {
    const { csvContent, filename } = await this.service.exportToCsv(
      user.organizationId,
      user.userId,
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);
  }

  @Get('records')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_gdpr')
  @ApiOperation({ summary: 'List GDPR records with filters and pagination' })
  listRecords(
    @CurrentUser() user: RequestUser,
    @Query() query: ListRecordsQueryDto,
  ) {
    return this.service.listRecords(user.organizationId, query);
  }

  @Post('records')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_gdpr')
  @ApiOperation({ summary: 'Create a GDPR record' })
  createRecord(@CurrentUser() user: RequestUser, @Body() dto: CreateRecordDto) {
    return this.service.createRecord(user.organizationId, user.userId, dto);
  }

  @Post('records/bulk-update')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_gdpr')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk update cells across multiple records (max 100)',
  })
  bulkUpdateCells(
    @CurrentUser() user: RequestUser,
    @Body() dto: BulkUpdateCellsDto,
  ) {
    return this.service.bulkUpdateCells(user.organizationId, user.userId, dto);
  }

  @Post('records/reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_gdpr')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reorder GDPR records' })
  reorderRecords(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReorderRecordsDto,
  ) {
    return this.service.reorderRecords(user.organizationId, user.userId, dto);
  }

  @Get('records/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_gdpr')
  @ApiOperation({ summary: 'Get a single GDPR record' })
  @ApiParam({ name: 'id' })
  getRecord(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getRecord(id, user.organizationId);
  }

  @Put('records/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_gdpr')
  @ApiOperation({ summary: 'Update a GDPR record (optimistic locking)' })
  @ApiParam({ name: 'id' })
  updateRecord(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRecordDto,
  ) {
    return this.service.updateRecord(id, user.organizationId, user.userId, dto);
  }

  @Delete('records/:id')
  @ImpersonationBlocked()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_gdpr')
  @ApiOperation({ summary: 'Delete a GDPR record (cascades storage)' })
  @ApiParam({ name: 'id' })
  deleteRecord(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service
      .deleteRecord(id, user.organizationId, user.userId)
      .then(() => ({ success: true, message: 'Record deleted' }));
  }

  @Patch('records/:id/archive')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_gdpr')
  @ApiOperation({ summary: 'Toggle archive state of a GDPR record' })
  @ApiParam({ name: 'id' })
  toggleArchive(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ToggleArchiveDto,
  ) {
    return this.service.toggleArchive(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  // ========================================================================
  // Comments
  // ========================================================================

  @Get('records/:id/comments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_gdpr')
  @ApiOperation({ summary: 'Get comments for a GDPR record' })
  @ApiParam({ name: 'id' })
  getComments(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getComments(id, user.organizationId);
  }

  @Get('records/:id/comments/count')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_gdpr')
  @ApiOperation({ summary: 'Get comment count for a GDPR record' })
  @ApiParam({ name: 'id' })
  getCommentCount(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getCommentCount(id, user.organizationId);
  }

  @Post('records/:id/comments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_add_comments_gdpr')
  @ApiOperation({ summary: 'Add a comment to a GDPR record' })
  @ApiParam({ name: 'id' })
  createComment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateGdprCommentDto,
  ) {
    return this.service.createComment(
      id,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Put('records/:id/comments/:cid')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_add_comments_gdpr')
  @ApiOperation({ summary: 'Update a GDPR record comment (author only)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'cid' })
  updateComment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cid', ParseUUIDPipe) cid: string,
    @Body() dto: UpdateGdprCommentDto,
  ) {
    return this.service.updateComment(
      id,
      cid,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete('records/:id/comments/:cid')
  @ImpersonationBlocked()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_comments_gdpr')
  @ApiOperation({ summary: 'Delete a GDPR record comment (author only)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'cid' })
  deleteComment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cid', ParseUUIDPipe) cid: string,
  ) {
    return this.service
      .deleteComment(id, cid, user.organizationId, user.userId)
      .then(() => ({ success: true, message: 'Comment deleted' }));
  }

  // ========================================================================
  // Attachments
  // ========================================================================

  @Get('records/:id/attachments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_gdpr')
  @ApiOperation({ summary: 'List attachments for a GDPR record' })
  @ApiParam({ name: 'id' })
  getAttachments(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service
      .getAttachments(id, user.organizationId)
      .then((attachments) => ({
        data: attachments,
        count: attachments.length,
      }));
  }

  @Post('records/:id/attachments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_add_attachments_gdpr')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload an attachment to a GDPR record (max 50 MB)',
  })
  @ApiParam({ name: 'id' })
  uploadAttachment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.service
      .uploadAttachment(id, user.organizationId, user.userId, file)
      .then((attachment) => ({ data: attachment, success: true }));
  }

  @Get('records/:id/attachments/:aid')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_gdpr')
  @ApiOperation({ summary: 'Get a signed URL for a GDPR attachment (60 s)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'aid' })
  getAttachmentSignedUrl(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aid', ParseUUIDPipe) aid: string,
  ) {
    return this.service
      .getAttachmentSignedUrl(id, aid, user.organizationId)
      .then((result) => ({
        data: { url: result.url },
        expiresIn: result.expiresIn,
      }));
  }

  @Delete('records/:id/attachments/:aid')
  @ImpersonationBlocked()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_attachments_gdpr')
  @ApiOperation({ summary: 'Delete a GDPR attachment' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'aid' })
  deleteAttachment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('aid', ParseUUIDPipe) aid: string,
  ) {
    return this.service
      .deleteAttachment(id, aid, user.organizationId, user.userId)
      .then(() => ({ success: true, message: 'Attachment deleted' }));
  }

  // ========================================================================
  // History
  // ========================================================================

  @Get('records/:id/history')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_gdpr')
  @ApiOperation({ summary: 'Get audit history for a GDPR record' })
  @ApiParam({ name: 'id' })
  getHistory(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getHistory(id, user.organizationId);
  }
}
