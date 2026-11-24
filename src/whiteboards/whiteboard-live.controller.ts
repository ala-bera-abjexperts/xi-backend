import {
  Body,
  Controller,
  Get,
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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { PermissionsService } from '../permissions/permissions.service';
import {
  StartPrivateModeDto,
  TimerCommandDto,
} from './dto/whiteboard-live.dto';
import { WhiteboardLiveService } from './whiteboard-live.service';

/** Per user and minute. */
const TOKEN_THROTTLE = { default: { limit: 30, ttl: 60_000 } };
const COMMAND_THROTTLE = { default: { limit: 30, ttl: 60_000 } };
const PRIVATE_MODE_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/**
 * The board's live rail features: the live channel token (presence + cursors), the shared
 * timer and private mode. Same guards and param names as WhiteboardsController
 * (never `:id`, see there). Rights (docs/whiteboard-rail-features-plan.md §9):
 *   - token, timer: anyone who can VIEW the board (Confluence: "anyone on the whiteboard")
 *   - private mode: editors only (it changes how everyone's edits are recorded)
 * Writes are refused on an archived board; reads keep working.
 */
@RequireFeature('module_whiteboards')
@ApiTags('whiteboards')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/whiteboards/:whiteboardId')
export class WhiteboardLiveController {
  constructor(
    private readonly live: WhiteboardLiveService,
    private readonly permissions: PermissionsService,
  ) {}

  // ── Live channel ──────────────────────────────────────────────────────────

  @Post('live/token')
  @HttpCode(HttpStatus.OK)
  @Throttle(TOKEN_THROTTLE)
  @RequireSpacePermission('view_whiteboards')
  @ApiOperation({
    summary:
      "Token for the board's private live channels (presence, cursors, scene)",
  })
  async token(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.live.resolveBoard(
      user,
      spaceId,
      whiteboardId,
      'can_view',
      false,
    );

    // Same rules as a scene save (edit_whiteboards, Share can_edit, not archived). A failed check
    // only means a read-only scene channel, never a failed token.
    const canEditScene = await this.permissions
      .hasSpacePermission(
        user.userId,
        user.organizationId,
        spaceId,
        'edit_whiteboards',
      )
      .then((allowed) =>
        allowed
          ? this.live
              .resolveBoard(user, spaceId, whiteboardId, 'can_edit', true)
              .then(() => true)
          : false,
      )
      .catch(() => false);

    return this.live.mintToken(user, whiteboardId, canEditScene);
  }

  // ── Timer ─────────────────────────────────────────────────────────────────

  @Get('timer')
  @RequireSpacePermission('view_whiteboards')
  @ApiOperation({ summary: "The board's shared timer (with the server time)" })
  async getTimer(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.live.resolveBoard(
      user,
      spaceId,
      whiteboardId,
      'can_view',
      false,
    );

    return this.live.getTimer(spaceId, user.organizationId, whiteboardId);
  }

  @Post('timer')
  @HttpCode(HttpStatus.OK)
  @Throttle(COMMAND_THROTTLE)
  @RequireSpacePermission('view_whiteboards')
  @ApiOperation({
    summary: 'Start, set the time of, pause, resume, stop or +1 min the timer',
  })
  @ApiResponse({ status: 409, description: 'Whiteboard is archived' })
  async commandTimer(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @Body() dto: TimerCommandDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.live.resolveBoard(user, spaceId, whiteboardId, 'can_view', true);

    return this.live.commandTimer(
      user,
      spaceId,
      whiteboardId,
      dto.action,
      dto.duration_ms,
    );
  }

  // ── Private mode ──────────────────────────────────────────────────────────

  @Get('private-mode')
  @RequireSpacePermission('view_whiteboards')
  @ApiOperation({ summary: 'Whether private mode is on for the board' })
  async getPrivateMode(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.live.resolveBoard(
      user,
      spaceId,
      whiteboardId,
      'can_view',
      false,
    );

    return this.live.getPrivateMode(spaceId, user.organizationId, whiteboardId);
  }

  @Post('private-mode/start')
  @HttpCode(HttpStatus.OK)
  @Throttle(PRIVATE_MODE_THROTTLE)
  @RequireSpacePermission('edit_whiteboards')
  @ApiOperation({ summary: 'Start private mode for everyone on the board' })
  async startPrivateMode(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @Body() dto: StartPrivateModeDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.live.resolveBoard(user, spaceId, whiteboardId, 'can_edit', true);

    return this.live.startPrivateMode(
      user,
      spaceId,
      whiteboardId,
      dto.keep_anonymous,
    );
  }

  @Post('private-mode/end')
  @HttpCode(HttpStatus.OK)
  @Throttle(PRIVATE_MODE_THROTTLE)
  @RequireSpacePermission('edit_whiteboards')
  @ApiOperation({ summary: 'End private mode for everyone on the board' })
  async endPrivateMode(
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('whiteboardId', ParseUUIDPipe) whiteboardId: string,
    @CurrentUser() user: RequestUser,
  ) {
    // Ending is allowed on an archived board too: it only turns a mode off.
    await this.live.resolveBoard(
      user,
      spaceId,
      whiteboardId,
      'can_edit',
      false,
    );

    return this.live.endPrivateMode(user, spaceId, whiteboardId);
  }
}
