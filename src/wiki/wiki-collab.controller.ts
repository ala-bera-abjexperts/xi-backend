/**
 * @fileoverview REST controller for wiki realtime-collaboration endpoints:
 * channel token minting, snapshot read/write, and session heartbeats.
 * All routes require the `edit_wiki_pages` space permission plus page-level
 * `can_edit` (collaboration IS editing).
 * @module src/wiki/wiki-collab.controller
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { WikiCollabService } from './wiki-collab.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import {
  CollabHeartbeatDto,
  SaveCollabSnapshotDto,
} from './dto/collab-snapshot.dto';

@RequireFeature('module_wiki')
@ApiTags('Wiki Collaboration')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/wiki/:pageId/collab')
export class WikiCollabController {
  constructor(
    private readonly collabService: WikiCollabService,
    private readonly permissionsService: WikiPermissionsService,
  ) {}

  private async assertEdit(
    user: RequestUser,
    pageId: string,
    spaceId: string,
  ): Promise<void> {
    await this.permissionsService.assertPageAccess(
      pageId,
      user.userId,
      spaceId,
      'can_edit',
    );
  }

  /** POST /spaces/:spaceId/wiki/:pageId/collab/token */
  @Post('token')
  @RequireSpacePermission('edit_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mint a Realtime JWT for the page collab channel' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: '{ token, expiresAt, topic }' })
  async mintToken(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ) {
    await this.assertEdit(user, pageId, spaceId);

    return this.collabService.mintToken(user, pageId);
  }

  /** GET /spaces/:spaceId/wiki/:pageId/collab/snapshot */
  @Get('snapshot')
  @RequireSpacePermission('edit_wiki_pages')
  @ApiOperation({ summary: 'Read the current collab snapshot state' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Snapshot state (nulls when none)' })
  async getSnapshot(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ) {
    await this.assertEdit(user, pageId, spaceId);

    return this.collabService.getSnapshot(user, pageId, spaceId);
  }

  /** POST /spaces/:spaceId/wiki/:pageId/collab/snapshot */
  @Post('snapshot')
  @RequireSpacePermission('edit_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Persist a collab snapshot (CAS on seq + session; supports seed, ' +
      'stale-session takeover, and endSession)',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: '{ seq, updatedAt }' })
  @ApiResponse({
    status: 409,
    description: 'SEED_CONFLICT | SESSION_CONFLICT | SEQ_CONFLICT',
  })
  async saveSnapshot(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Body() dto: SaveCollabSnapshotDto,
    @Headers('x-wiki-schema') wikiSchema?: string,
  ) {
    await this.assertEdit(user, pageId, spaceId);

    return this.collabService.saveSnapshot(user, pageId, spaceId, dto, {
      header: wikiSchema,
    });
  }

  /** POST /spaces/:spaceId/wiki/:pageId/collab/heartbeat */
  @Post('heartbeat')
  @RequireSpacePermission('edit_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Keep the collab session alive' })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: '{ alive }' })
  async heartbeat(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Body() dto: CollabHeartbeatDto,
  ) {
    await this.assertEdit(user, pageId, spaceId);

    return this.collabService.heartbeat(user, pageId, spaceId, dto.sessionId);
  }
}
