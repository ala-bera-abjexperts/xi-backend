/**
 * @fileoverview Space-scoped compatibility routes for legacy Next.js list APIs.
 * @module src/lists/lists-spaces-compat.controller
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
import type { Response } from 'express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { contentDispositionAttachment } from '../common/content-disposition';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ListsService } from './lists.service';

type AnyBody = Record<string, unknown>;

@RequireFeature('module_lists')
@ApiTags('Lists')
@ApiBearerAuth()
@Controller('spaces/:spaceId/lists')
export class ListsSpacesCompatController {
  constructor(private readonly service: ListsService) {}

  @Get('schemas')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  async listSchemas(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
    @Query('is_archived') isArchived?: string,
    @Query('search') search?: string,
  ) {
    const data = await this.service.getSchemas(user.organizationId, spaceId, {
      is_archived: isArchived,
      search,
    });
    return { data, count: data.length };
  }

  @Post('schemas')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_lists')
  async createSchema(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
    @Body() body: AnyBody,
  ) {
    const dto = this.cleanBody(body);
    const data = await this.service.createSchema(
      user.organizationId,
      user.userId,
      { ...dto, space_id: spaceId } as never,
    );
    return { data, success: true };
  }

  @Get('key/:key')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  getSchemaByKey(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('key') key: string,
  ) {
    return this.service.getSchemaByKey(key, user.organizationId);
  }

  @Get('schemas/:schemaId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  getSchemaById(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('schemaId') schemaId: string,
  ) {
    return this.service.getSchemaById(schemaId, user.organizationId);
  }

  @Put('schemas/:schemaId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async updateSchema(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('schemaId') schemaId: string,
    @Body() body: AnyBody,
  ) {
    const data = await this.service.updateSchema(
      schemaId,
      user.organizationId,
      user.userId,
      this.cleanBody(body) as never,
    );
    return { data, success: true };
  }

  @Delete('schemas/:schemaId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_lists')
  async removeSchema(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('schemaId') schemaId: string,
  ) {
    await this.service.deleteSchema(schemaId, user.organizationId);
    return { success: true, message: 'Schema deleted' };
  }

  @Post('schemas/:schemaId/restore')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async restoreSchema(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('schemaId') schemaId: string,
  ) {
    const data = await this.service.restoreSchema(
      schemaId,
      user.organizationId,
      user.userId,
    );
    return { data, success: true };
  }

  @Get('schemas/:schemaId/export')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  async exportSchema(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('schemaId') schemaId: string,
    @Query('format') format: string = 'csv',
    @Res() res: Response,
  ) {
    const schema = await this.service.getSchemaById(
      schemaId,
      user.organizationId,
    );
    const date = new Date().toISOString().split('T')[0];

    if (format === 'xlsx') {
      const buffer = await this.service.exportToXlsx(
        schemaId,
        user.organizationId,
      );
      const fileName = `${schema.name || 'list'}_export_${date}.xlsx`;

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      // RFC 5987 dual form: a raw non-Latin-1 list name (Chinese, Polish ł…) made setHeader
      // throw ERR_INVALID_CHAR → 500, and umlauts arrived as mojibake.
      res.setHeader(
        'Content-Disposition',
        contentDispositionAttachment(fileName),
      );
      return res.send(buffer);
    }

    const csv = await this.service.exportToCSV(schemaId, user.organizationId);
    const fileName = `${schema.name || 'list'}_export_${date}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      contentDispositionAttachment(fileName),
    );
    return res.send(csv);
  }

  @Post('schemas/:schemaId/import/preview')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: UPLOAD_LIMITS.IMPORT } }),
  )
  @ApiConsumes('multipart/form-data')
  async previewImport(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
    @Param('schemaId') schemaId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Import file is required');
    }

    const data = await this.service.previewImportFile(
      schemaId,
      user.organizationId,
      file,
      { spaceId },
    );

    return { data, success: true };
  }

  @Post('schemas/:schemaId/import')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_lists')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: UPLOAD_LIMITS.IMPORT } }),
  )
  @ApiConsumes('multipart/form-data')
  async importItems(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
    @Param('schemaId') schemaId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Import file is required');
    }

    const data = await this.service.importItemsFromFile(
      user.organizationId,
      user.userId,
      schemaId,
      file,
      { spaceId },
    );

    return { data, success: true };
  }

  @Post('import')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_lists')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: UPLOAD_LIMITS.IMPORT } }),
  )
  @ApiConsumes('multipart/form-data')
  async importSchema(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
    @Body() body: { name?: string } = {},
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Import file is required');
    }

    const data = await this.service.importSchemaFromFile(
      user.organizationId,
      user.userId,
      spaceId,
      file,
      { name: body.name },
    );

    return { data, success: true };
  }

  @Post('schemas/:schemaId/columns')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async addColumn(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('schemaId') schemaId: string,
    @Body() body: AnyBody,
  ) {
    const data = await this.service.addColumn(
      schemaId,
      user.organizationId,
      user.userId,
      this.cleanBody(body) as never,
    );
    return { data, success: true };
  }

  @Put('schemas/:schemaId/columns')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async reorderColumns(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('schemaId') schemaId: string,
    @Body() body: { column_order?: { columnId: string; order: number }[] },
  ) {
    const data = await this.service.reorderColumns(
      schemaId,
      user.organizationId,
      body.column_order ?? [],
      user.userId,
    );
    return { data, success: true };
  }

  @Put('schemas/:schemaId/columns/:columnId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async renameColumn(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('schemaId') schemaId: string,
    @Param('columnId') columnId: string,
    @Body() body: { new_label?: string; label?: string },
  ) {
    const label = body.new_label ?? body.label;
    if (!label) throw new BadRequestException('New label is required');
    const data = await this.service.renameColumn(
      schemaId,
      user.organizationId,
      columnId,
      label,
      user.userId,
    );
    return { data, success: true };
  }

  @Delete('schemas/:schemaId/columns/:columnId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async removeColumn(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('schemaId') schemaId: string,
    @Param('columnId') columnId: string,
  ) {
    const data = await this.service.removeColumn(
      schemaId,
      user.organizationId,
      columnId,
      user.userId,
    );
    return { data, success: true };
  }

  @Get('schemas/:schemaId/custom-fields')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  getCustomFields(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('schemaId') schemaId: string,
  ) {
    return this.service.getCustomFields(schemaId, user.organizationId);
  }

  @Post('schemas/:schemaId/custom-fields')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  assignCustomField(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('schemaId') schemaId: string,
    @Body() body: AnyBody,
  ) {
    return this.service.assignCustomField(
      schemaId,
      user.organizationId,
      user.userId,
      this.cleanBody(body) as never,
    );
  }

  @Put('schemas/:schemaId/custom-fields/reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async reorderCustomFields(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('schemaId') schemaId: string,
    @Body() body: AnyBody,
  ) {
    await this.service.reorderCustomFields(schemaId, user.organizationId, {
      field_orders: (body.field_orders ?? []) as never,
    });
    return { success: true };
  }

  @Put('schemas/:schemaId/custom-fields/sync')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  syncCustomFields(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('schemaId') schemaId: string,
    @Body() body: AnyBody,
  ) {
    return this.service.syncCustomFields(
      schemaId,
      user.organizationId,
      user.userId,
      this.cleanBody(body) as never,
    );
  }

  @Patch('schemas/:schemaId/custom-fields/:assignmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  updateCustomFieldAssignment(
    @CurrentUser() user: RequestUser,
    @Param('assignmentId') assignmentId: string,
    @Body() body: AnyBody,
  ) {
    return this.service.updateCustomFieldAssignment(
      assignmentId,
      user.userId,
      this.cleanBody(body) as never,
      user.organizationId,
    );
  }

  @Delete('schemas/:schemaId/custom-fields/:assignmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async removeCustomField(
    @CurrentUser() user: RequestUser,
    @Param('assignmentId') assignmentId: string,
  ) {
    await this.service.removeCustomField(assignmentId, user.organizationId);
    return { success: true };
  }

  @Get('items')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  async listItems(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Query('schemaId') schemaId?: string,
    @Query('page') page?: string,
    @Query('page_size') pageSize?: string,
    @Query('search') search?: string,
    @Query('is_archived') isArchived?: string,
    @Query('sort_column') sortColumn?: string,
    @Query('sort_direction') sortDirection?: 'asc' | 'desc',
    @Query('column_filters') columnFilters?: string,
  ) {
    if (!schemaId) throw new BadRequestException('Schema ID is required');
    const parsedPage = this.parseIntOrUndefined(page) ?? 1;
    const parsedPageSize = this.parseIntOrUndefined(pageSize) ?? 25;
    const parsedColumnFilters = this.parseColumnFilters(columnFilters);
    const result = await this.service.getItems(user.organizationId, schemaId, {
      page: parsedPage,
      page_size: parsedPageSize,
      search,
      is_archived: isArchived,
      sort_column: sortColumn,
      sort_direction: sortDirection ?? 'asc',
      column_filters: parsedColumnFilters,
    });
    return {
      data: result.data,
      total: result.total,
      page: parsedPage,
      page_size: parsedPageSize,
    };
  }

  @Post('items')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_lists')
  async createItem(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') spaceId: string,
    @Body() body: AnyBody,
  ) {
    const dto = this.cleanBody(body);
    const data = await this.service.createItem(
      user.organizationId,
      user.userId,
      { ...dto, space_id: spaceId } as never,
    );
    return { data, success: true };
  }

  @Put('items/reorder')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async reorderItems(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Body()
    body: {
      schemaId?: string;
      schema_id?: string;
      orders?: { item_id: string; row_order: number }[];
    },
  ) {
    const schemaId = body.schemaId ?? body.schema_id;
    if (!schemaId) throw new BadRequestException('Schema ID required');
    if (!body.orders?.length) {
      throw new BadRequestException('Orders array is required');
    }
    await this.service.reorderRows(
      schemaId,
      user.organizationId,
      user.userId,
      body.orders,
    );
    return { success: true };
  }

  @Put('items/bulk')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async bulkUpdateItems(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Body()
    body: {
      updates?: {
        item_id: string;
        column_id: string;
        value: unknown;
        version: number;
      }[];
    },
  ) {
    if (!body.updates?.length) {
      throw new BadRequestException('Updates array is required');
    }
    const data = await this.service.bulkUpdateCells(
      user.organizationId,
      user.userId,
      body.updates,
    );
    return { data, success: true };
  }

  @Delete('items/bulk')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_lists')
  async bulkDeleteItems(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Body() body: { ids?: string[] },
  ) {
    if (!body.ids?.length) {
      throw new BadRequestException('Item IDs array is required');
    }
    await this.service.bulkDeleteItems(
      body.ids,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: `${body.ids.length} items deleted` };
  }

  @Patch('items/bulk')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async bulkArchiveItems(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Body() body: { ids?: string[] },
  ) {
    if (!body.ids?.length) {
      throw new BadRequestException('Item IDs array is required');
    }
    await this.service.bulkArchiveItems(
      body.ids,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: `${body.ids.length} items archived` };
  }

  @Get('items/:itemId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  getItemById(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.service.getItemById(itemId, user.organizationId);
  }

  @Put('items/:itemId')
  @Patch('items/:itemId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async updateItem(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('itemId') itemId: string,
    @Body() body: AnyBody,
  ) {
    const data = await this.service.updateItem(
      itemId,
      user.organizationId,
      user.userId,
      this.cleanBody(body) as never,
    );
    return { data, success: true };
  }

  @Delete('items/:itemId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_lists')
  async removeItem(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('itemId') itemId: string,
  ) {
    await this.service.deleteItem(itemId, user.organizationId, user.userId);
    return { success: true, message: 'Item deleted' };
  }

  @Get('items/:itemId/history')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  async getItemHistory(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('itemId') itemId: string,
  ) {
    const data = await this.service.getItemHistory(itemId, user.organizationId);
    return { data, count: data.length };
  }

  @Get('items/:itemId/custom-fields')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  async getItemCustomFieldValues(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('itemId') itemId: string,
  ) {
    const result = await this.service.getItemCustomFieldValues(
      itemId,
      user.organizationId,
    );
    return { ...result, success: true };
  }

  @Put('items/:itemId/custom-fields')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async updateItemCustomFieldValues(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('itemId') itemId: string,
    @Body()
    body: { customFieldValues?: Record<string, unknown>; version?: number },
  ) {
    if (body.customFieldValues === undefined) {
      throw new BadRequestException('customFieldValues is required');
    }
    if (body.version === undefined) {
      throw new BadRequestException('version is required');
    }
    const data = await this.service.updateItemCustomFieldValues(
      itemId,
      user.organizationId,
      user.userId,
      body.customFieldValues,
      body.version,
    );
    return { data, success: true };
  }

  @Get('items/:itemId/comments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  async getComments(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('itemId') itemId: string,
  ) {
    const data = await this.service.getComments(itemId, user.organizationId);
    return { data, count: data.length };
  }

  @Post('items/:itemId/comments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_add_comments_lists')
  async createComment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('itemId') itemId: string,
    @Body() body: { content?: string },
  ) {
    const data = await this.service.createComment(
      itemId,
      user.organizationId,
      user.userId,
      body.content ?? '',
    );
    return { data, success: true };
  }

  @Put('items/:itemId/comments/:commentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_add_comments_lists')
  async updateComment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('commentId') commentId: string,
    @Body() body: { content?: string },
  ) {
    const data = await this.service.updateComment(
      commentId,
      user.organizationId,
      user.userId,
      body.content ?? '',
    );
    return { data, success: true };
  }

  @Delete('items/:itemId/comments/:commentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_comments_lists')
  async deleteComment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('commentId') commentId: string,
  ) {
    await this.service.deleteComment(
      commentId,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Comment deleted' };
  }

  @Get('items/:itemId/attachments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  async getAttachments(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('itemId') itemId: string,
  ) {
    const data = await this.service.getAttachments(itemId, user.organizationId);
    return { data, count: data.length };
  }

  @Post('items/:itemId/attachments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  async uploadAttachment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('itemId') itemId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { schemaId?: string; schema_id?: string },
  ) {
    if (!file) throw new BadRequestException('File is required');
    const schemaId = body.schemaId ?? body.schema_id;
    if (!schemaId) throw new BadRequestException('Schema ID required');
    const data = await this.service.uploadAttachment(
      itemId,
      user.organizationId,
      schemaId,
      file,
      user.userId,
    );
    return { data, success: true };
  }

  @Get('items/:itemId/attachments/:attachmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  async getAttachmentDownloadUrl(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    const url = await this.service.getAttachmentDownloadUrl(
      attachmentId,
      user.organizationId,
    );
    return { data: { url } };
  }

  @Delete('items/:itemId/attachments/:attachmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_lists')
  async deleteAttachment(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    await this.service.deleteAttachment(
      attachmentId,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Attachment deleted' };
  }

  @Get('items/:itemId/links')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_lists')
  async getLinks(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('itemId') itemId: string,
  ) {
    const data = await this.service.getLinks(itemId, user.organizationId);
    return { data, count: data.length };
  }

  @Post('items/:itemId/links')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async createLink(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('itemId') itemId: string,
    @Body() body: AnyBody,
  ) {
    const data = await this.service.createLink(
      itemId,
      user.organizationId,
      user.userId,
      this.cleanBody(body) as never,
    );
    return { data, success: true };
  }

  @Delete('items/:itemId/links/:linkId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_lists')
  async deleteLink(
    @CurrentUser() user: RequestUser,
    @Param('spaceId') _spaceId: string,
    @Param('linkId') linkId: string,
  ) {
    await this.service.deleteLink(linkId, user.organizationId);
    return { success: true, message: 'Link deleted' };
  }

  private cleanBody<T extends AnyBody>(body: T): AnyBody {
    const rest = { ...(body ?? ({} as T)) };
    delete rest['organizationId'];
    delete rest['organization_id'];
    delete rest['orgId'];
    delete rest['user_id'];
    delete rest['userId'];
    return rest;
  }

  private parseIntOrUndefined(value?: string): number | undefined {
    if (value === undefined || value === '') return undefined;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
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
