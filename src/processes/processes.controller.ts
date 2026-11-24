/**
 * @fileoverview REST controller for `/processes` — ISMS business processes.
 * @module src/processes/processes.controller
 * @author Prince Jadiya
 */

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
  Optional,
} from '@nestjs/common';
import { AgentOriginService } from '../chat-agent/agent-origin.service';
import { FileInterceptor } from '@nestjs/platform-express';
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
import { ProcessesService } from './processes.service';
import { ProcessAttachmentsService } from './processes-attachments.service';
import { CreateProcessDto } from './dto/create-process.dto';
import { UpdateProcessDto } from './dto/update-process.dto';
import { PatchProcessDto } from './dto/patch-process.dto';
import { CreateProcessRelationshipDto } from './dto/create-process-relationship.dto';
import { UpsertDiagramDto } from './dto/upsert-diagram.dto';
import { CreateProcessCommentDto } from './dto/create-process-comment.dto';
import { UpdateProcessCommentDto } from './dto/update-process-comment.dto';

@RequireFeature('module_processes')
@ApiTags('Processes')
@ApiBearerAuth()
@Controller('processes')
export class ProcessesController {
  constructor(
    private readonly service: ProcessesService,
    private readonly attachmentsService: ProcessAttachmentsService,
    @Optional() private readonly origins?: AgentOriginService,
  ) {}

  /** The detail screen asks for the "Drafted by Robert" label in the same request. Lists never do. */
  private async withOrigin<T extends object>(user: RequestUser, process: T, wanted?: string): Promise<T> {
    if (wanted !== 'true' || !this.origins) return process;
    const origin = await this.origins.forObject(user, 'process', process);
    return origin ? { ...process, robert_origin: origin } : process;
  }

  @Get('by-key/:key')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  @ApiOperation({ summary: 'Get a process by its key (e.g. HR-P42)' })
  @ApiParam({ name: 'key' })
  async getByKey(
    @CurrentUser() user: RequestUser,
    @Param('key') key: string,
    @Query('withOrigin') withOrigin?: string,
  ) {
    return this.withOrigin(user, await this.service.getByKey(key, user.organizationId), withOrigin);
  }

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  @ApiOperation({ summary: 'List processes with filters + pagination' })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'requestType', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'pageSize', required: false })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe({ optional: true })) spaceId?: string,
    @Query('status') status?: string,
    @Query('requestType') requestType?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.getAll(user.organizationId, spaceId, {
      status,
      request_type: requestType,
      search,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_processes')
  @ApiOperation({ summary: 'Create a process' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateProcessDto,
  ) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  @Get(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  @ApiParam({ name: 'id' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getById(id, user.organizationId);
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_processes')
  @ApiParam({ name: 'id' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProcessDto,
  ) {
    return this.service.update(id, user.organizationId, user.userId, dto);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_processes')
  @ApiOperation({ summary: 'Quick actions: reorder, partial_update' })
  @ApiParam({ name: 'id' })
  async patch(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchProcessDto,
  ) {
    switch (dto.action) {
      case 'reorder':
        if (!dto.items || dto.items.length === 0) {
          throw new BadRequestException('items array is required for reorder');
        }
        await this.service.reorder(dto.items, user.organizationId);
        return { success: true };
      case 'partial_update': {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { action: _a, items: _items, ...fields } = dto;
        return this.service.update(
          id,
          user.organizationId,
          user.userId,
          fields,
        );
      }
      default:
        throw new BadRequestException(`Unknown action: ${dto.action}`);
    }
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_processes')
  @ApiParam({ name: 'id' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.delete(id, user.organizationId, user.userId);
    return { success: true, message: 'Process deleted' };
  }

  @Get(':id/history')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  @ApiOperation({ summary: 'Get change history for a process' })
  @ApiParam({ name: 'id' })
  async getHistory(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getHistory(id, user.organizationId);
  }

  // ---- Relationships ----------------------------------------------------

  @Get(':id/relationships')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  @ApiParam({ name: 'id' })
  async listRelationships(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getRelationships(id, user.organizationId);
  }

  @Post(':id/relationships')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_processes')
  @ApiOperation({
    summary: 'Add a parent-child relationship (the :id is the child)',
  })
  @ApiParam({ name: 'id' })
  async createRelationship(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProcessRelationshipDto,
  ) {
    return this.service.createRelationship(id, user.organizationId, dto);
  }

  @Delete(':id/relationships/:relationshipId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_processes')
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'relationshipId' })
  async deleteRelationship(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('relationshipId', ParseUUIDPipe) relationshipId: string,
  ) {
    await this.service.deleteRelationship(
      id,
      relationshipId,
      user.organizationId,
    );
    return { success: true, message: 'Relationship deleted' };
  }

  // ── Diagram ────────────────────────────────────────────────────────────

  /**
   * GET /processes/:id/diagram
   * Returns the saved draw.io diagram for a process (or null).
   * Response: { data: ProcessDiagram | null }
   */
  @Get(':id/diagram')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  @ApiOperation({ summary: 'Get process diagram' })
  @ApiParam({ name: 'id', description: 'Process UUID' })
  async getDiagram(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getDiagram(id, user.organizationId);
  }

  /**
   * PUT /processes/:id/diagram
   * Upserts the draw.io diagram for a process.
   * Body: { xml: string, previewSvg?: string }
   * Response: { data: ProcessDiagram, success: true }
   */
  @Put(':id/diagram')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_processes')
  @ApiOperation({ summary: 'Upsert process diagram (create or update)' })
  @ApiParam({ name: 'id', description: 'Process UUID' })
  async upsertDiagram(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertDiagramDto,
  ) {
    return this.service.upsertDiagram(
      id,
      user.organizationId,
      user.userId,
      dto.xml,
      dto.previewSvg,
    );
  }

  // ── Attachments ────────────────────────────────────────────────────────

  /**
   * GET /processes/:id/attachments
   * List all attachments for a process (newest first).
   * Response: { data: IProcessAttachment[], count: number }
   */
  @Get(':id/attachments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  @ApiOperation({ summary: 'List attachments for a process' })
  @ApiParam({ name: 'id', description: 'Process UUID' })
  async listAttachments(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.attachmentsService.getAttachments(id, user.organizationId);
  }

  /**
   * POST /processes/:id/attachments
   * Upload a file attachment (multipart/form-data, field name: "file").
   * Max size: 50 MB. Allowed types: jpeg, png, gif, pdf, doc, docx, xls, xlsx, txt, csv.
   * Response: { data: IProcessAttachment, success: true } (201)
   */
  @Post(':id/attachments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_processes')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a file attachment for a process' })
  @ApiParam({ name: 'id', description: 'Process UUID' })
  async uploadAttachment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }
    return this.attachmentsService.uploadAttachment(
      id,
      user.organizationId,
      user.userId,
      file,
    );
  }

  /**
   * GET /processes/:id/attachments/:attachmentId
   * Get a signed download URL for a specific attachment (1-hour expiry).
   * Response: { data: { url: string } }
   */
  @Get(':id/attachments/:attachmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  @ApiOperation({ summary: 'Get signed download URL for an attachment' })
  @ApiParam({ name: 'id', description: 'Process UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  async getAttachmentDownloadUrl(
    @CurrentUser() user: RequestUser,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    return this.attachmentsService.getDownloadUrl(
      attachmentId,
      user.organizationId,
    );
  }

  /**
   * DELETE /processes/:id/attachments/:attachmentId
   * Deletes the file from storage and removes the DB record.
   * Response: { success: true, message: 'Attachment deleted' }
   */
  @Delete(':id/attachments/:attachmentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_processes')
  @ApiOperation({ summary: 'Delete a process attachment' })
  @ApiParam({ name: 'id', description: 'Process UUID' })
  @ApiParam({ name: 'attachmentId', description: 'Attachment UUID' })
  async deleteAttachment(
    @CurrentUser() user: RequestUser,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    return this.attachmentsService.deleteAttachment(
      attachmentId,
      user.organizationId,
      user.userId,
    );
  }

  // ---- Comments ---------------------------------------------------------

  @Get(':id/comments')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_processes')
  @ApiOperation({ summary: 'List comments for a process (with user details)' })
  @ApiParam({ name: 'id', description: 'Process UUID' })
  listComments(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getComments(id, user.organizationId);
  }

  @Post(':id/comments')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_add_comments_processes')
  @ApiOperation({ summary: 'Add a comment to a process' })
  @ApiParam({ name: 'id', description: 'Process UUID' })
  createComment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProcessCommentDto,
  ) {
    return this.service.createComment(
      id,
      user.organizationId,
      user.userId,
      dto.content,
    );
  }

  @Put(':id/comments/:commentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_add_comments_processes')
  @ApiOperation({ summary: 'Update a process comment (author only)' })
  @ApiParam({ name: 'id', description: 'Process UUID' })
  @ApiParam({ name: 'commentId', description: 'Comment UUID' })
  updateComment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: UpdateProcessCommentDto,
  ) {
    return this.service.updateComment(
      id,
      commentId,
      user.organizationId,
      user.userId,
      dto.content,
    );
  }

  @Delete(':id/comments/:commentId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_comments_processes')
  @ApiOperation({ summary: 'Delete a process comment (author only)' })
  @ApiParam({ name: 'id', description: 'Process UUID' })
  @ApiParam({ name: 'commentId', description: 'Comment UUID' })
  async deleteComment(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    await this.service.deleteComment(
      id,
      commentId,
      user.organizationId,
      user.userId,
    );
    return { success: true, message: 'Comment deleted' };
  }
}
