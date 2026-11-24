/**
 * @fileoverview REST endpoints for chat notification settings (XE-T353 CHAT-16): do
 * not disturb, working hours, the email fallback, and the "outside working hours"
 * hint for senders. Licensed by `module_chat` and gated by `can_use_chat`.
 * @module src/chat/chat-notifications.controller
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ChatNotificationsService } from './chat-notifications.service';
import { RequireChatPermission } from './chat-permission.guard';
import { ChatAvailabilityDto, UpdateChatSettingsDto } from './dto/chat.dto';

@RequireFeature('module_chat')
@RequireChatPermission('can_use_chat')
@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatNotificationsController {
  constructor(private readonly notifications: ChatNotificationsService) {}

  /** GET /chat/settings */
  @Get('settings')
  @ApiOperation({
    summary:
      'My do not disturb, working hours and email fallback, with the pause state for now',
  })
  getSettings(@CurrentUser() user: RequestUser) {
    return this.notifications.getSettings(user);
  }

  /** PATCH /chat/settings */
  @Patch('settings')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Change my chat notification settings (null clears a value)',
  })
  updateSettings(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateChatSettingsDto,
  ) {
    return this.notifications.updateSettings(user, dto);
  }

  /** POST /chat/users/availability (reads only, so it stays open while impersonating) */
  @Post('users/availability')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Whether colleagues are outside their working hours now, and their local time',
  })
  availability(
    @CurrentUser() user: RequestUser,
    @Body() dto: ChatAvailabilityDto,
  ) {
    return this.notifications.availability(user, dto.userIds);
  }
}
