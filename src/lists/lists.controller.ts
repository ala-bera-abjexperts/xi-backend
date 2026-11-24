/**
 * @fileoverview REST controller for `/lists` — schemas + items core CRUD.
 * @module src/lists/lists.controller
 * @author Prince Jadiya
 */

import { UPLOAD_LIMITS } from '../common/upload-limits';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import {
  BadRequestException,
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ListsService } from './lists.service';
import { CreateListSchemaDto } from './dto/create-list-schema.dto';
import { UpdateListSchemaDto } from './dto/update-list-schema.dto';
import { CreateListItemDto } from './dto/create-list-item.dto';
import { UpdateListItemDto } from './dto/update-list-item.dto';
import { ReorderListItemsDto } from './dto/reorder-list-items.dto';
import { AssignCustomFieldDto } from '../assets/dto/assign-custom-field.dto';
import { UpdateCustomFieldAssignmentDto } from '../assets/dto/update-custom-field-assignment.dto';
import { ReorderCustomFieldsDto } from '../assets/dto/reorder-custom-fields.dto';
import { SyncCustomFieldsDto } from '../assets/dto/sync-custom-fields.dto';

@RequireFeature('module_lists')
@ApiTags('Lists')
@ApiBearerAuth()
@Controller('lists')
export class ListsController {
  constructor(private readonly service: ListsService) {}

  // ---- Schemas ----------------------------------------------------------

  @Get('schemas')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiOperation({ summary: 'List schemas' })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiQuery({ name: 'isArchived', required: false })
  @ApiQuery({ name: 'search', required: false })
  async listSchemas(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe({ optional: true })) spaceId?: string,
    @Query('isArchived') isArchived?: string,
    @Query('search') search?: string,
  ) {
    return this.service.getSchemas(user.organizationId, spaceId, {
      is_archived: isArchived,
      search,
    });
  }

  @Post('schemas')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_lists')
  @ApiOperation({ summary: 'Create a list schema' })
  async createSchema(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateListSchemaDto,
  ) {
    return this.service.createSchema(user.organizationId, user.userId, dto);
  }

  @Get('schemas/by-key/:key')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiParam({ name: 'key' })
  async getSchemaByKey(
    @CurrentUser() user: RequestUser,
    @Param('key') key: string,
  ) {
    return this.service.getSchemaByKey(key, user.organizationId);
  }

  @Get('schemas/:schemaId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiParam({ name: 'schemaId' })
  async getSchemaById(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
  ) {
    return this.service.getSchemaById(schemaId, user.organizationId);
  }

  @Put('schemas/:schemaId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'schemaId' })
  async updateSchema(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Body() dto: UpdateListSchemaDto,
  ) {
    return this.service.updateSchema(
      schemaId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete('schemas/:schemaId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_lists')
  @ApiParam({ name: 'schemaId' })
  async removeSchema(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
  ) {
    await this.service.deleteSchema(schemaId, user.organizationId);
    return { success: true, message: 'List schema deleted' };
  }

  @Post('schemas/:schemaId/restore')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'schemaId' })
  @ApiOperation({ summary: 'Restore an archived schema (set is_active=true)' })
  async restoreSchema(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
  ) {
    return this.service.restoreSchema(
      schemaId,
      user.organizationId,
      user.userId,
    );
  }

  @Delete('schemas/:schemaId/permanent')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_lists')
  @ApiParam({ name: 'schemaId' })
  @ApiOperation({ summary: 'Permanently delete a schema and all its items' })
  async permanentDeleteSchema(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
  ) {
    await this.service.permanentDeleteSchema(schemaId, user.organizationId);
    return { success: true, message: 'List schema permanently deleted' };
  }

  @Get('schemas/:schemaId/export')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiParam({ name: 'schemaId' })
  @ApiOperation({ summary: 'Export schema items to CSV' })
  async exportSchema(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
  ) {
    return this.service.exportToCSV(schemaId, user.organizationId);
  }

  @Post('schemas/:schemaId/import')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_lists')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: UPLOAD_LIMITS.IMPORT } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'schemaId' })
  @ApiOperation({ summary: 'Import CSV or Excel rows into a list schema' })
  async importItems(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Import file is required');
    }

    return this.service.importItemsFromFile(
      user.organizationId,
      user.userId,
      schemaId,
      file,
    );
  }

  @Post('import')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_lists')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: UPLOAD_LIMITS.IMPORT } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Create a list schema and rows from CSV or Excel' })
  async importSchema(
    @CurrentUser() user: RequestUser,
    @Body() body: { name?: string; spaceId?: string; space_id?: string } = {},
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Import file is required');
    }

    const spaceId = body.spaceId ?? body.space_id;

    if (!spaceId) {
      throw new BadRequestException('spaceId is required');
    }

    return this.service.importSchemaFromFile(
      user.organizationId,
      user.userId,
      spaceId,
      file,
      { name: body.name },
    );
  }

  // ---- Column Operations ------------------------------------------------

  @Post('schemas/:schemaId/columns')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'schemaId' })
  @ApiOperation({ summary: 'Add a column to a schema' })
  async addColumn(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Body() body: { column: Record<string, unknown> },
  ) {
    return this.service.addColumn(
      schemaId,
      user.organizationId,
      user.userId,
      body.column as any,
    );
  }

  @Put('schemas/:schemaId/columns/reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'schemaId' })
  @ApiOperation({ summary: 'Reorder columns in a schema' })
  async reorderColumns(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Body() body: { column_order: { columnId: string; order: number }[] },
  ) {
    return this.service.reorderColumns(
      schemaId,
      user.organizationId,
      body.column_order,
      user.userId,
    );
  }

  @Put('schemas/:schemaId/columns/:columnId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'schemaId' })
  @ApiParam({ name: 'columnId' })
  @ApiOperation({ summary: 'Rename a column' })
  async renameColumn(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Param('columnId') columnId: string,
    @Body() body: { label: string },
  ) {
    return this.service.renameColumn(
      schemaId,
      user.organizationId,
      columnId,
      body.label,
      user.userId,
    );
  }

  @Delete('schemas/:schemaId/columns/:columnId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'schemaId' })
  @ApiParam({ name: 'columnId' })
  @ApiOperation({ summary: 'Remove a column from a schema' })
  async removeColumn(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Param('columnId') columnId: string,
  ) {
    return this.service.removeColumn(
      schemaId,
      user.organizationId,
      columnId,
      user.userId,
    );
  }

  // ---- Custom Fields ----------------------------------------------------

  @Get('schemas/:schemaId/custom-fields')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiParam({ name: 'schemaId' })
  @ApiOperation({ summary: 'Get custom fields assigned to a schema' })
  async getCustomFields(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
  ) {
    return this.service.getCustomFields(schemaId, user.organizationId);
  }

  @Post('schemas/:schemaId/custom-fields')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'schemaId' })
  @ApiOperation({ summary: 'Assign a custom field to a schema' })
  async assignCustomField(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Body() dto: AssignCustomFieldDto,
  ) {
    return this.service.assignCustomField(
      schemaId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Put('schemas/:schemaId/custom-fields/reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'schemaId' })
  @ApiOperation({ summary: 'Reorder custom fields within a schema' })
  async reorderCustomFields(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Body() dto: ReorderCustomFieldsDto,
  ) {
    await this.service.reorderCustomFields(schemaId, user.organizationId, dto);
    return { success: true };
  }

  @Put('schemas/:schemaId/custom-fields/sync')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'schemaId' })
  @ApiOperation({ summary: 'Sync (replace all) custom fields for a schema' })
  async syncCustomFields(
    @CurrentUser() user: RequestUser,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Body() dto: SyncCustomFieldsDto,
  ) {
    return this.service.syncCustomFields(
      schemaId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Patch('schemas/:schemaId/custom-fields/:assignmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'schemaId' })
  @ApiParam({ name: 'assignmentId' })
  @ApiOperation({ summary: 'Update a custom field assignment' })
  async updateCustomFieldAssignment(
    @CurrentUser() user: RequestUser,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() dto: UpdateCustomFieldAssignmentDto,
  ) {
    return this.service.updateCustomFieldAssignment(
      assignmentId,
      user.userId,
      dto,
      user.organizationId,
    );
  }

  @Delete('schemas/:schemaId/custom-fields/:assignmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'schemaId' })
  @ApiParam({ name: 'assignmentId' })
  @ApiOperation({ summary: 'Remove a custom field from a schema' })
  async removeCustomField(
    @CurrentUser() user: RequestUser,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ) {
    await this.service.removeCustomField(assignmentId, user.organizationId);
    return { success: true };
  }

  // ---- Items ------------------------------------------------------------

  @Get('items')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiOperation({ summary: 'List items in a schema (paginated)' })
  @ApiQuery({ name: 'schemaId', required: true })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'isArchived', required: false })
  async listItems(
    @CurrentUser() user: RequestUser,
    @Query('schemaId', ParseUUIDPipe) schemaId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('isArchived') isArchived?: string,
    @Query('sortColumn') sortColumn?: string,
    @Query('sortDirection') sortDirection?: 'asc' | 'desc',
    @Query('column_filters') columnFilters?: string,
  ) {
    return this.service.getItems(user.organizationId, schemaId, {
      page: page ? parseInt(page, 10) : undefined,
      page_size: pageSize ? parseInt(pageSize, 10) : undefined,
      search,
      is_archived: isArchived,
      sort_column: sortColumn,
      sort_direction: sortDirection,
      column_filters: this.parseColumnFilters(columnFilters),
    });
  }

  @Post('items')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_lists')
  @ApiOperation({ summary: 'Create a list item' })
  async createItem(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateListItemDto,
  ) {
    return this.service.createItem(user.organizationId, user.userId, dto);
  }

  @Post('items/reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiOperation({ summary: 'Reorder items within a schema' })
  async reorderItems(
    @CurrentUser() user: RequestUser,
    @Body() dto: ReorderListItemsDto,
  ) {
    await this.service.reorderItems(user.organizationId, dto);
    return { success: true };
  }

  @Get('items/:itemId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiParam({ name: 'itemId' })
  async getItemById(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.getItemById(itemId, user.organizationId);
  }

  @Patch('items/:itemId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'itemId' })
  async updateItem(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateListItemDto,
  ) {
    return this.service.updateItem(
      itemId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete('items/:itemId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_lists')
  @ApiParam({ name: 'itemId' })
  async removeItem(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    await this.service.deleteItem(itemId, user.organizationId, user.userId);
    return { success: true, message: 'List item deleted' };
  }

  @Get('items/:itemId/history')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Get change history for a list item' })
  async getItemHistory(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.getItemHistory(itemId, user.organizationId);
  }

  @Post('items/bulk-delete')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_lists')
  @ApiOperation({ summary: 'Bulk delete list items' })
  async bulkDeleteItems(
    @CurrentUser() user: RequestUser,
    @Body() body: { ids: string[] },
  ) {
    await this.service.bulkDeleteItems(
      body.ids,
      user.organizationId,
      user.userId,
    );
    return { success: true };
  }

  @Post('items/bulk-archive')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiOperation({ summary: 'Bulk archive list items' })
  async bulkArchiveItems(
    @CurrentUser() user: RequestUser,
    @Body() body: { ids: string[] },
  ) {
    await this.service.bulkArchiveItems(
      body.ids,
      user.organizationId,
      user.userId,
    );
    return { success: true };
  }

  @Post('items/bulk-restore')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiOperation({ summary: 'Bulk restore archived list items' })
  async bulkRestoreItems(
    @CurrentUser() user: RequestUser,
    @Body() body: { ids: string[] },
  ) {
    await this.service.bulkRestoreItems(
      body.ids,
      user.organizationId,
      user.userId,
    );
    return { success: true };
  }

  @Post('items/bulk-update-cells')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiOperation({ summary: 'Bulk update individual cells across items' })
  async bulkUpdateCells(
    @CurrentUser() user: RequestUser,
    @Body()
    body: {
      updates: {
        item_id: string;
        column_id: string;
        value: unknown;
        version: number;
      }[];
    },
  ) {
    return this.service.bulkUpdateCells(
      user.organizationId,
      user.userId,
      body.updates,
    );
  }

  // ---- Item Custom Field Values -------------------------------------------

  @Get('items/:itemId/custom-fields')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Get custom field values for a list item' })
  async getItemCustomFieldValues(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.getItemCustomFieldValues(itemId, user.organizationId);
  }

  @Put('items/:itemId/custom-fields')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Update custom field values for a list item' })
  async updateItemCustomFieldValues(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body()
    body: { customFieldValues: Record<string, unknown>; version: number },
  ) {
    return this.service.updateItemCustomFieldValues(
      itemId,
      user.organizationId,
      user.userId,
      body.customFieldValues,
      body.version,
    );
  }

  // ---- Comments -----------------------------------------------------------

  @Get('items/:itemId/comments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Get comments for a list item' })
  async getComments(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    const data = await this.service.getComments(itemId, user.organizationId);
    return { data, count: data.length };
  }

  @Post('items/:itemId/comments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_add_comments_lists')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Create a comment on a list item' })
  async createComment(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: { content: string },
  ) {
    const data = await this.service.createComment(
      itemId,
      user.organizationId,
      user.userId,
      body.content,
    );
    return { data, success: true };
  }

  @Put('items/:itemId/comments/:commentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_add_comments_lists')
  @ApiParam({ name: 'itemId' })
  @ApiParam({ name: 'commentId' })
  @ApiOperation({ summary: 'Update a comment on a list item' })
  async updateComment(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) _itemId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() body: { content: string },
  ) {
    const data = await this.service.updateComment(
      commentId,
      user.organizationId,
      user.userId,
      body.content,
    );
    return { data, success: true };
  }

  @Delete('items/:itemId/comments/:commentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_comments_lists')
  @ApiParam({ name: 'itemId' })
  @ApiParam({ name: 'commentId' })
  @ApiOperation({ summary: 'Delete a comment from a list item' })
  async deleteComment(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) _itemId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    await this.service.deleteComment(
      commentId,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Comment deleted' };
  }

  // ---- Attachments --------------------------------------------------------

  @Get('items/:itemId/attachments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Get attachments for a list item' })
  async getAttachments(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    const data = await this.service.getAttachments(itemId, user.organizationId);
    return { data, count: data.length };
  }

  @Post('items/:itemId/attachments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_add_attachments_lists')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Upload an attachment for a list item' })
  async uploadAttachment(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { schemaId?: string },
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }
    const data = await this.service.uploadAttachment(
      itemId,
      user.organizationId,
      body.schemaId ?? '',
      file,
      user.userId,
    );
    return { data, success: true };
  }

  @Get('items/:itemId/attachments/:attachmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiParam({ name: 'itemId' })
  @ApiParam({ name: 'attachmentId' })
  @ApiOperation({ summary: 'Get download URL for an attachment' })
  async getAttachmentDownloadUrl(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) _itemId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    const url = await this.service.getAttachmentDownloadUrl(
      attachmentId,
      user.organizationId,
    );
    return { data: { url } };
  }

  @Delete('items/:itemId/attachments/:attachmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_attachments_lists')
  @ApiParam({ name: 'itemId' })
  @ApiParam({ name: 'attachmentId' })
  @ApiOperation({ summary: 'Delete an attachment from a list item' })
  async deleteAttachment(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) _itemId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    await this.service.deleteAttachment(
      attachmentId,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Attachment deleted' };
  }

  // ---- Links --------------------------------------------------------------

  @Get('items/:itemId/links')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Get links for a list item' })
  async getLinks(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    const data = await this.service.getLinks(itemId, user.organizationId);
    return { data, count: data.length };
  }

  @Post('items/:itemId/links')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Create a link for a list item' })
  async createLink(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body()
    body: { target_type: string; target_id: string; link_type?: string },
  ) {
    const data = await this.service.createLink(
      itemId,
      user.organizationId,
      user.userId,
      body,
    );
    return { data, success: true };
  }

  @Delete('items/:itemId/links/:linkId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'itemId' })
  @ApiParam({ name: 'linkId' })
  @ApiOperation({ summary: 'Delete a link from a list item' })
  async deleteLink(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) _itemId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ) {
    await this.service.deleteLink(linkId, user.organizationId);
    return { success: true, message: 'Link deleted' };
  }

  // ---- Relations ----------------------------------------------------------

  @Get('items/:itemId/relations')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Get relations for a list item' })
  async getRelations(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.getRelations(itemId, user.organizationId);
  }

  @Post('items/:itemId/relations')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'itemId' })
  @ApiOperation({ summary: 'Create a relation from a list item' })
  async createRelation(
    @CurrentUser() user: RequestUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: { target_item_id: string; relation_type_id: string },
  ) {
    return this.service.createRelation(
      itemId,
      body.target_item_id,
      body.relation_type_id,
      user.organizationId,
      user.userId,
    );
  }

  @Delete('items/relations/:relationId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @ApiParam({ name: 'relationId' })
  @ApiOperation({ summary: 'Delete a relation' })
  async deleteRelation(
    @CurrentUser() user: RequestUser,
    @Param('relationId', ParseUUIDPipe) relationId: string,
  ) {
    await this.service.deleteRelation(relationId, user.organizationId);
    return { success: true };
  }

  @Get('task-links/:taskId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  async getTaskLinkedItems(
    @CurrentUser() user: RequestUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    return this.service.getLinksForTaskGroupedBySchema(
      taskId,
      user.organizationId,
    );
  }

  @Get('display-config/:spaceId/:schemaId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  async getTaskListDisplayConfig(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
  ) {
    return this.service.getTaskListDisplayConfig(spaceId, schemaId);
  }

  @Put('display-config/:spaceId/:schemaId')
  @Patch('display-config/:spaceId/:schemaId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async updateTaskListDisplayConfig(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('schemaId', ParseUUIDPipe) schemaId: string,
    @Body() body: { visible_columns?: string[]; visibleColumns?: string[] },
  ) {
    return this.service.upsertTaskListDisplayConfig(
      spaceId,
      schemaId,
      body.visible_columns ?? body.visibleColumns ?? [],
    );
  }

  private parseColumnFilters(
    value?: string,
  ): Record<string, string> | undefined {
    if (!value) return undefined;

    try {
      const parsed = JSON.parse(value) as unknown;

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }
}
