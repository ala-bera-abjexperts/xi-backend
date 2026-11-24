import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Res,
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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { assertImageMime } from '../common/upload-mime';
import { WhiteboardNameDto } from './dto/whiteboard-name.dto';
import { SaveWhiteboardSceneDto } from './dto/save-whiteboard-scene.dto';
import { WhiteboardLiveService } from './whiteboard-live.service';
import { WhiteboardsService } from './whiteboards.service';
import { WHITEBOARD_MAX_FILE_BYTES } from './whiteboards.constants';

/** Autosave, image uploads and image loads come in bursts well above the global 100/min. */
const BURST_THROTTLE = { default: { limit: 300, ttl: 60_000 } };

/**
 * Params are `:spaceId` + `:whiteboardId`, never `:id`: SpacePermissionsGuard falls back to
 * `params.id` as the space id, which would authorise against the wrong object.
 *
 * Deliberately NO FormBuilderSpaceOrgInterceptor: interceptors run after guards, so the guard
 * would grant an admin of the caller's active org, and the interceptor would then re-point
 * the request at another org the caller is only a member of. Without it, a space outside the
 * active org is refused by WhiteboardsService.assertAvailable.
 */
@RequireFeature('module_whiteboards')
@ApiTags('whiteboards')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/whiteboards')
export class WhiteboardsController {
  constructor(
    private readonly service: WhiteboardsService,
    private readonly live: WhiteboardLiveService,
  ) {}

  @Get()
  @RequireSpacePermission('view_whiteboards')
  @ApiOperation({ summary: 'List whiteboards in a space (archived included)' })
  async list(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.list(spaceId, user.organizationId, user.userId);
  }

  @Post()
  @RequireSpacePermission('create_whiteboards')
  @ApiOperation({ summary: 'Create an empty whiteboard' })
  @ApiResponse({ status: 201, description: 'Whiteboard created' })
  async create(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: WhiteboardNameDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.create(spaceId, user, dto.name);
  }

  @Get(':whiteboardId')
  @RequireSpacePermission('view_whiteboards')
  @ApiOperation({ summary: 'Get a whiteboard with its scene and image ids' })
  @ApiResponse({ status: 404, description: 'Whiteboard not found' })
  async getOne(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      'can_view',
    );
    return this.service.getOne(spaceId, user.organizationId, whiteboardId);
  }

  @Get(':whiteboardId/access')
  @RequireSpacePermission('view_whiteboards')
  @ApiOperation({
    summary: "The caller's Share state on a whiteboard (restricted, own caps)",
  })
  async getShareState(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getShareState(
      spaceId,
      user.organizationId,
      user.userId,
      whiteboardId,
    );
  }

  @Patch(':whiteboardId')
  @RequireSpacePermission('edit_whiteboards')
  @ApiOperation({ summary: 'Rename a whiteboard' })
  @ApiResponse({ status: 409, description: 'Whiteboard is archived' })
  async rename(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @Body() dto: WhiteboardNameDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      'can_edit',
    );
    return this.service.rename(spaceId, user, whiteboardId, dto.name);
  }

  @Put(':whiteboardId/scene')
  @Throttle(BURST_THROTTLE)
  @RequireSpacePermission('edit_whiteboards')
  @ApiOperation({
    summary: 'Autosave the scene (optimistic lock on base_revision)',
  })
  @ApiResponse({
    status: 409,
    description: 'WHITEBOARD_REVISION_CONFLICT or WHITEBOARD_ARCHIVED',
  })
  @ApiResponse({ status: 413, description: 'WHITEBOARD_TOO_LARGE' })
  async saveScene(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @Body() dto: SaveWhiteboardSceneDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      'can_edit',
    );
    const saved = await this.service.saveScene(
      spaceId,
      user,
      whiteboardId,
      dto,
    );

    void this.live.broadcast(whiteboardId, 'scene_changed', {
      revision: saved.revision,
    });

    return saved;
  }

  @Get(':whiteboardId/versions')
  @RequireSpacePermission('view_whiteboards')
  @ApiOperation({
    summary: 'Version history of a whiteboard (newest first, no scenes)',
  })
  async listVersions(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      'can_view',
    );
    return this.service.listVersions(
      spaceId,
      user.organizationId,
      whiteboardId,
    );
  }

  @Get(':whiteboardId/versions/:version')
  @RequireSpacePermission('view_whiteboards')
  @ApiOperation({ summary: 'One version of a whiteboard, with its scene' })
  async getVersion(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      'can_view',
    );
    return this.service.getVersion(
      spaceId,
      user.organizationId,
      whiteboardId,
      version,
    );
  }

  @Post(':whiteboardId/versions/:version/restore')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_whiteboards')
  @ApiOperation({
    summary: 'Restore a version of the scene and name as a new revision',
  })
  @ApiResponse({
    status: 409,
    description: 'WHITEBOARD_ARCHIVED, or still racing autosaves',
  })
  async restoreVersion(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @Param('version', ParseIntPipe) version: number,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      'can_edit',
    );
    const restored = await this.service.restoreVersion(
      spaceId,
      user,
      whiteboardId,
      version,
    );

    void this.live.broadcast(whiteboardId, 'scene_changed', {
      revision: restored.revision,
    });

    return restored;
  }

  @Post(':whiteboardId/archive')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_whiteboards')
  @ApiOperation({ summary: 'Archive a whiteboard (read-only until restored)' })
  async archive(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      'can_edit',
    );
    return this.service.setArchived(spaceId, user, whiteboardId, true);
  }

  @Post(':whiteboardId/restore')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('edit_whiteboards')
  @ApiOperation({ summary: 'Restore an archived whiteboard' })
  async restore(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      'can_edit',
    );
    return this.service.setArchived(spaceId, user, whiteboardId, false);
  }

  @Delete(':whiteboardId')
  @RequireSpacePermission('delete_whiteboards')
  @ApiOperation({ summary: 'Permanently delete a whiteboard and its images' })
  async remove(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      'can_delete',
    );
    return this.service.remove(spaceId, user, whiteboardId);
  }

  @Post(':whiteboardId/files')
  @Throttle(BURST_THROTTLE)
  @RequireSpacePermission('edit_whiteboards')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: WHITEBOARD_MAX_FILE_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'Excalidraw FileId' },
        file: { type: 'string', format: 'binary' },
      },
      required: ['fileId', 'file'],
    },
  })
  @ApiOperation({ summary: 'Store an image embedded in the whiteboard' })
  async uploadFile(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @Body('fileId') fileId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: RequestUser,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (file.size > WHITEBOARD_MAX_FILE_BYTES) {
      throw new BadRequestException('Image is larger than 4 MB');
    }
    assertImageMime(file.mimetype, { allowSvg: true });
    await this.service.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      'can_edit',
    );

    return this.service.uploadFile(spaceId, user, whiteboardId, fileId, file);
  }

  /**
   * Raw bytes, always as an attachment of type application/octet-stream with nosniff, so a
   * stored SVG can never render as a document on our origin. The client knows each file's
   * real type from GET :whiteboardId (`files[].mime_type`). `@Res()` without passthrough is
   * the only way past the global ResponseInterceptor (see backup-archives.controller.ts).
   */
  @Get(':whiteboardId/files/:fileId')
  @Throttle(BURST_THROTTLE)
  @RequireSpacePermission('view_whiteboards')
  @ApiOperation({ summary: 'Download an embedded image' })
  async downloadFile(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @Param('fileId') fileId: string,
    @CurrentUser() user: RequestUser,
    @Res() res: Response,
  ) {
    await this.service.assertBoardAccess(
      spaceId,
      user.userId,
      whiteboardId,
      'can_view',
    );
    const file = await this.service.getFile(
      spaceId,
      user.organizationId,
      whiteboardId,
      fileId,
    );

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Content-addressed (fileId is a hash of the bytes), so it never changes.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(file.buffer);
  }
}
