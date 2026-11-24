/**
 * @fileoverview Node-centric File Explorer controller.
 * Routes that must work for non-space-members (e.g., shared-node access) live here.
 * Authentication is via the global SupabaseAuthGuard only — NO SpacePermissionsGuard.
 * Access is resolved per-request via FileExplorerAccessService.
 * @module src/file-explorer/file-explorer-node.controller
 */

import { contentDispositionAttachment } from '../common/content-disposition';
import { UPLOAD_LIMITS } from '../common/upload-limits';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
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
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { FileExplorerService } from './file-explorer.service';
import { FileExplorerArchiveService } from './file-explorer-archive.service';
import { UpdateNodeDto } from './dto/update-node.dto';
import { CreateReminderDto } from './dto/create-reminder.dto';
import { CreateShareDto } from './dto/create-share.dto';
import { UpdateShareDto } from './dto/update-share.dto';
import { ListNodesQueryDto } from './dto/list-nodes-query.dto';
import { MoveNodeDto } from './dto/move-node.dto';
import { CompleteUploadDto, InitVersionUploadDto } from './dto/init-upload.dto';
import { CopyNodeDto } from './dto/copy-node.dto';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';

@RequireFeature('module_file_explorer')
@ApiTags('File Explorer (node)')
@ApiBearerAuth()
@Controller('file-explorer')
export class FileExplorerNodeController {
  constructor(
    private readonly service: FileExplorerService,
    private readonly archive: FileExplorerArchiveService,
  ) {}

  /**
   * Get a single node by ID.
   * Returns 404 (not 403) when the user has no access — to avoid leaking node existence.
   */
  @Get('nodes/:id')
  async getNode(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getNode(user, id);
  }

  /**
   * Download a file.
   * Returns a 302 redirect to a short-TTL (<= 60 s) signed URL.
   * The signed URL includes Content-Disposition: attachment so SVG/HTML is never rendered inline.
   * @Res() bypasses the global ResponseInterceptor — this MUST stay.
   */
  @Get('files/:id/download')
  async download(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('v') v: string | undefined,
    @Res() res: Response,
  ) {
    const versionNumber = v ? Number(v) : undefined;
    const download = await this.service.getDownloadInfo(
      user,
      id,
      versionNumber,
    );

    res.setHeader('Cache-Control', 'no-store, private');

    if (download.type === 'file') {
      res.redirect(HttpStatus.FOUND, download.signedUrl);

      return;
    }

    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Archive-File-Count', String(download.entries.length));
    res.setHeader('X-Archive-Total-Bytes', String(download.totalBytes));
    res.setHeader(
      'Content-Disposition',
      contentDispositionAttachment(download.fileName),
    );

    await this.archive.streamZip(download.entries, res);
  }

  /**
   * Returns a short-TTL inline signed URL for in-browser preview.
   * Only returns a URL for MIME types safe to render inline (no SVG/HTML).
   * Returns { url: null } for unsupported types — caller shows fallback UI.
   */
  @Get('files/:id/preview-url')
  async previewUrl(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ url: string | null }> {
    return this.service.getPreviewInfo(user, id);
  }

  /**
   * List all active versions of a file, newest first.
   */
  @Get('files/:id/versions')
  async listVersions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getVersions(user, id);
  }

  /**
   * Upload a new version of an existing file.
   * Version numbers are allocated race-safely (retry-on-23505).
   */
  @Post('files/:id/versions')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: UPLOAD_LIMITS.ATTACHMENT } }),
  )
  async uploadVersion(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @Query('comment') comment?: string,
  ) {
    if (!file) throw new BadRequestException('Missing file');

    return this.service.uploadVersion(user, id, file, comment);
  }

  /**
   * Begin a DIRECT upload of a new version — the path for large files.
   * Complete it with `POST files/:id/upload-complete`.
   */
  @Post('files/:id/versions/upload-init')
  @ApiOperation({ summary: 'Start a direct-to-storage version upload' })
  @ApiResponse({ status: 201, description: 'Signed upload URL issued' })
  @ApiResponse({ status: 413, description: 'Storage quota exceeded' })
  async initVersionUpload(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InitVersionUploadDto,
  ) {
    return this.service.initDirectVersionUpload(user, id, dto);
  }

  /**
   * Confirm a direct upload: verifies the bytes actually landed in storage, re-checks quota against
   * the REAL object size, then activates the version and points the node at it.
   *
   * Idempotent — re-confirming an already-active version returns the node rather than erroring, so
   * a client that retries on a dropped response does not get a spurious failure.
   */
  @Post('files/:id/upload-complete')
  @ApiOperation({ summary: 'Confirm a direct-to-storage upload' })
  @ApiResponse({ status: 201, description: 'Version activated' })
  @ApiResponse({
    status: 400,
    description: 'No uploaded file found for this upload',
  })
  @ApiResponse({ status: 413, description: 'Storage quota exceeded' })
  async completeUpload(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ) {
    return this.service.completeDirectUpload(user, id, dto.version_id);
  }

  /**
   * Rename a node or update its description.
   * Returns 409 if the new name conflicts with a sibling.
   */
  @Patch('nodes/:id')
  async rename(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNodeDto,
  ) {
    return this.service.rename(user, id, dto);
  }

  // ── Stars ────────────────────────────────────────────────────────────────

  /** Star a node for the current user. Idempotent. */
  @Post('nodes/:id/star')
  async starNode(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.starNode(user, id);
  }

  /** Unstar a node. Safe to call when not starred. */
  @Delete('nodes/:id/star')
  async unstarNode(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.unstarNode(user, id);
  }

  // ── Labels ───────────────────────────────────────────────────────────────

  /** Assign an existing space label to a node. Idempotent. */
  @Post('nodes/:id/labels')
  async assignLabel(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('label_id') labelId: string,
  ) {
    await this.service.assignLabel(user, id, labelId);
  }

  /** Remove a label from a node. */
  @Delete('nodes/:id/labels/:labelId')
  async unassignLabel(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
  ) {
    await this.service.unassignLabel(user, id, labelId);
  }

  // ── Reminders ─────────────────────────────────────────────────────────────

  /** List the current user's pending reminders for a specific node. */
  @Get('nodes/:id/reminders')
  async listNodeReminders(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.listNodeReminders(user, id);
  }

  /** Create a reminder for a node. remind_at must be in the future. */
  @Post('nodes/:id/reminders')
  async createReminder(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateReminderDto,
  ) {
    return this.service.createReminder(user, id, dto);
  }

  /** Delete a reminder. Only the owner can delete their own reminder. */
  @Delete('reminders/:id')
  async deleteReminder(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.deleteReminder(user, id);
  }

  // ── Children (for browsing into a shared folder as non-member) ──────────

  /**
   * List direct children of a folder. Works for non-space-members if they hold
   * a share on this folder (or an ancestor). Authorized by FileExplorerAccessService.
   */
  @Get('nodes/:id/children')
  async listChildren(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListNodesQueryDto,
  ) {
    return this.service.listChildren(user, id, query);
  }

  // ── Shared views (cross-space) ────────────────────────────────────────────

  /** Nodes shared directly with the current user (active, unexpired, not deleted). */
  @Get('shared-with-me')
  sharedWithMe(
    @CurrentUser() user: RequestUser,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.service.sharedWithMe(user, spaceId);
  }

  /** Nodes the current user has shared with others (active shares). */
  @Get('shared-from-me')
  sharedFromMe(
    @CurrentUser() user: RequestUser,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.service.sharedFromMe(user, spaceId);
  }

  // ── Share CRUD (only space members with share_file_explorer can manage shares) ──

  /** List all shares for a node. */
  @Get('nodes/:id/shares')
  listShares(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.listShares(user, id);
  }

  /**
   * Create a user or link share for a node.
   * User shares: same-org users only; self-share rejected.
   * Link shares: one per node (DB unique constraint); returns/replaces existing.
   */
  @Post('nodes/:id/shares')
  createShare(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateShareDto,
  ) {
    return this.service.createShare(user, id, dto);
  }

  /** Update share permissions, expiry, or active status. */
  @Patch('shares/:id')
  updateShare(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateShareDto,
  ) {
    return this.service.updateShare(user, id, dto);
  }

  /** Revoke (soft-deactivate) a share. Access blocked on next request. */
  @Delete('shares/:id')
  revokeShare(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.revokeShare(user, id);
  }

  // ── Delete / Restore / Permanent Delete ─────────────────────────────────

  /**
   * Soft-delete a node and its entire subtree.
   * All affected nodes share a delete_op_id so they can be restored as a batch.
   */
  @Delete('nodes/:id')
  async softDelete(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.softDelete(user, id);
  }

  /**
   * Restore a soft-deleted node (and its batch).
   * If the original parent is also trashed, the root node is re-parented to space root.
   */
  @Post('nodes/:id/restore')
  async restoreNode(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.restoreNode(user, id);
  }

  /**
   * Permanently delete a node. Clears all associated storage bytes first,
   * then hard-deletes the DB row (CASCADE removes descendants + related rows).
   * This action is irreversible.
   */
  @Delete('nodes/:id/permanent')
  async permanentDelete(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.permanentDelete(user, id);
  }

  // ── Move / Copy / Restore Version ─────────────────────────────────────────

  /**
   * Move a node to a different folder (or to the space root).
   * Requires delete permission on the source and create permission on the destination.
   * Returns 400 if moving into self or a descendant; 409 on name collision at destination.
   */
  @Post('nodes/:id/move')
  async move(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveNodeDto,
  ) {
    return this.service.moveNode(user, id, dto);
  }

  /**
   * Copy a node and its entire subtree to a destination folder.
   * Requires view permission on the source and create permission on the destination.
   * Storage bytes are duplicated independently for each file version.
   */
  @Post('nodes/:id/copy')
  async copy(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CopyNodeDto,
  ) {
    return this.service.copyNode(user, id, dto);
  }

  /**
   * Restore an older version of a file as the current version.
   * No new bytes are uploaded; current_version_id is simply repointed.
   * Requires create permission (same as uploading a new version).
   */
  @Post('files/:id/versions/:versionId/restore')
  async restoreVersion(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    return this.service.restoreVersion(user, id, versionId);
  }
}
