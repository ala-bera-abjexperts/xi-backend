/**
 * @fileoverview The whiteboard Details panel API (owner, dates, labels, stats; label and owner
 * writes). Board-scoped routes so they follow the board's rights (Whiteboards keys + Share ACL)
 * and work with the Wiki module off. Registered in WikiModule (see WhiteboardDetailsService).
 *
 * Every route is `:whiteboardId/<segment>`, so none can be taken for WhiteboardsController's
 * `GET :whiteboardId`.
 * @module src/wiki/whiteboard-details.controller
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { CreateWikiLabelDto } from './dto/create-wiki-label.dto';
import { SetPageLabelsDto } from './dto/set-page-labels.dto';
import { TransferWhiteboardOwnerDto } from './dto/transfer-whiteboard-owner.dto';
import { WhiteboardDetailsService } from './whiteboard-details.service';

@RequireFeature('module_whiteboards')
@ApiTags('whiteboards')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/whiteboards')
export class WhiteboardDetailsController {
  constructor(private readonly service: WhiteboardDetailsService) {}

  @Get(':whiteboardId/details')
  @RequireSpacePermission('view_whiteboards')
  @ApiOperation({ summary: 'Owner, dates, labels and stats of a whiteboard' })
  async getDetails(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.getDetails(spaceId, user, whiteboardId);
  }

  @Get(':whiteboardId/label-options')
  @RequireSpacePermission('view_whiteboards')
  @ApiOperation({ summary: "The space's labels (shared with wiki pages)" })
  async listLabels(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.listLabels(spaceId, user);
  }

  @Put(':whiteboardId/labels')
  @RequireSpacePermission('edit_whiteboards')
  @ApiOperation({ summary: "Replace a whiteboard's labels" })
  @ApiResponse({ status: 409, description: 'WHITEBOARD_ARCHIVED' })
  async setLabels(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @Body() dto: SetPageLabelsDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.setLabels(spaceId, user, whiteboardId, dto.label_ids);
  }

  @Post(':whiteboardId/label-options')
  @RequireSpacePermission('edit_whiteboards')
  @ApiOperation({
    summary: 'Create a space label (or return the one with that name)',
  })
  async createLabel(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @Body() dto: CreateWikiLabelDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.createLabel(
      spaceId,
      user,
      whiteboardId,
      dto.name,
      dto.color,
    );
  }

  @Post(':whiteboardId/owner')
  @HttpCode(HttpStatus.OK)
  @RequireSpacePermission('view_whiteboards')
  @ApiOperation({ summary: 'Transfer a whiteboard to another space member' })
  @ApiResponse({ status: 403, description: 'Not the owner or an admin' })
  async transferOwner(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @Body() dto: TransferWhiteboardOwnerDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.transferOwner(spaceId, user, whiteboardId, dto.user_id);
  }
}
