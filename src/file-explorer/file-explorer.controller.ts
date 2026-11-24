/**
 * @fileoverview Space-scoped File Explorer controller.
 * All routes are nested under `spaces/:spaceId/file-explorer` and require
 * the caller to be a space member (@UseGuards(SpacePermissionsGuard)).
 * Node-centric routes that must also work for non-members via shares are
 * on FileExplorerNodeController instead.
 * @module src/file-explorer/file-explorer.controller
 */

import { UPLOAD_LIMITS } from '../common/upload-limits';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
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
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { FileExplorerService } from './file-explorer.service';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UploadFileDto } from './dto/upload-file.dto';
import { InitUploadDto } from './dto/init-upload.dto';
import { ListNodesQueryDto } from './dto/list-nodes-query.dto';
import { CreateLabelDto } from './dto/create-label.dto';
import { UpdateNodeDto } from './dto/update-node.dto';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';

@RequireFeature('module_file_explorer')
@ApiTags('File Explorer')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/file-explorer')
export class FileExplorerController {
  constructor(private readonly service: FileExplorerService) {}

  /**
   * List nodes in a space by view.
   * Views: all (default) | trash. Use parent_id to navigate into a folder.
   * Search is space-wide and ignores parent_id.
   */
  @Get('nodes')
  @RequireSpacePermission('view_file_explorer')
  async list(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Query() query: ListNodesQueryDto,
  ) {
    return this.service.listForSpace(user, spaceId, query.view ?? 'all', query);
  }

  /**
   * Get breadcrumb chain for a node (ancestors from root to the node).
   * Returns an ordered array: root-most ancestor first.
   */
  @Get('nodes/:id/breadcrumbs')
  @RequireSpacePermission('view_file_explorer')
  async breadcrumbs(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.breadcrumbs(user, id, spaceId);
  }

  /**
   * Return a short-TTL inline-view URL for a file in this space.
   * Unsupported MIME types return `{ url: null }` so the UI can show a fallback.
   */
  @Get('files/:id/preview-url')
  @RequireSpacePermission('view_file_explorer')
  async previewUrl(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ url: string | null }> {
    return this.service.getPreviewInfo(user, id, spaceId);
  }

  /**
   * Rename a node or update its description from the space-scoped explorer.
   * The service also validates the node belongs to the requested space.
   */
  @Patch('nodes/:id')
  @RequireSpacePermission('create_file_explorer')
  async rename(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNodeDto,
  ) {
    return this.service.rename(user, id, dto, spaceId);
  }

  /**
   * Soft-delete a node from this space and move its subtree to the bin.
   * The service also validates the node belongs to the requested space.
   */
  @Delete('nodes/:id')
  @RequireSpacePermission('delete_file_explorer')
  async softDelete(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.softDelete(user, id, spaceId);
  }

  /**
   * Create a folder at the root or inside an existing folder.
   * Returns 409 if a file or folder with the same name already exists in the target location.
   */
  @Post('folders')
  @RequireSpacePermission('create_file_explorer')
  async createFolder(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.service.createFolder(user, spaceId, dto);
  }

  /**
   * Upload a new file (creates the node + version 1), PROXIED through this process.
   *
   * Multer buffers the whole request in memory, so this path is capped at the ordinary attachment
   * tier. Anything larger must use `files/upload-init` below, which streams browser → storage.
   * Returns 409 if a file with the same name already exists — upload as a version instead.
   */
  @Post('files')
  @RequireSpacePermission('create_file_explorer')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: UPLOAD_LIMITS.ATTACHMENT } }),
  )
  async uploadFile(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: UploadFileDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Missing file');

    return this.service.uploadNewFile(user, spaceId, dto, file);
  }

  /**
   * Begin a DIRECT upload — the path for large files.
   *
   * Reserves the node and a pending version, then returns a signed URL the client PUTs the bytes
   * to. Nothing passes through this process, which is what allows multi-gigabyte files. The client
   * must call `POST /file-explorer/files/:id/upload-complete` afterwards; an upload that is never
   * completed is reaped by the sweeper after 24 h.
   */
  @Post('files/upload-init')
  @RequireSpacePermission('create_file_explorer')
  @ApiOperation({ summary: 'Start a direct-to-storage upload' })
  @ApiResponse({ status: 201, description: 'Signed upload URL issued' })
  @ApiResponse({
    status: 409,
    description: 'A file with this name already exists',
  })
  @ApiResponse({ status: 413, description: 'Storage quota exceeded' })
  async initUpload(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: InitUploadDto,
  ) {
    return this.service.initDirectUpload(user, spaceId, dto);
  }

  /** List labels defined for this space. */
  @Get('labels')
  @RequireSpacePermission('view_file_explorer')
  async listLabels(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.service.listLabels(spaceId, user.organizationId);
  }

  /** Real Supabase storage usage (used bytes + per-space quota) for the sidebar meter. */
  @Get('storage')
  @RequireSpacePermission('view_file_explorer')
  storageUsage(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.service.getStorageUsage(user, spaceId);
  }

  /** Create a label for this space. Returns 409 if the name already exists. */
  @Post('labels')
  @RequireSpacePermission('edit_file_explorer')
  createLabel(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: CreateLabelDto,
  ) {
    return this.service.createLabel(user, spaceId, dto);
  }

  /** List unsent reminders the current user has set for nodes in this space. */
  @Get('reminders')
  @RequireSpacePermission('view_file_explorer')
  listReminders(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.service.listReminders(
      user.userId,
      user.organizationId,
      spaceId,
    );
  }
}
