/**
 * @fileoverview REST endpoints for chat conversations: inbox, DMs, groups, space
 * channels and group membership (XE-T353). Licensed by `module_chat` and gated by
 * `can_use_chat`; access is resolved per request by ChatAccessService (unreadable =
 * 404). Every handler that changes something is closed during impersonation.
 * @module src/chat/chat-conversations.controller
 */

import {
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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ChatConversationsService } from './chat-conversations.service';
import { RequireChatPermission } from './chat-permission.guard';
import {
  AddMembersDto,
  CreateDmDto,
  CreateGroupDto,
  SetMemberRoleDto,
  UpdateConversationDto,
  UpdateMyConversationStateDto,
} from './dto/chat.dto';

@RequireFeature('module_chat')
@RequireChatPermission('can_use_chat')
@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatConversationsController {
  constructor(private readonly conversations: ChatConversationsService) {}

  /** GET /chat/conversations */
  @Get('conversations')
  @ApiOperation({
    summary: 'Inbox: my conversations with unread counts and previews',
  })
  listInbox(@CurrentUser() user: RequestUser) {
    return this.conversations.listInbox(user);
  }

  /** POST /chat/dms */
  @Post('dms')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Open (or create) the direct message with a colleague',
  })
  openDm(@CurrentUser() user: RequestUser, @Body() dto: CreateDmDto) {
    return this.conversations.openDm(user, dto.userId);
  }

  /** POST /chat/groups */
  @Post('groups')
  @ImpersonationBlocked()
  @RequireChatPermission('can_create_chat_groups')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a group chat (you become its owner)' })
  createGroup(@CurrentUser() user: RequestUser, @Body() dto: CreateGroupDto) {
    return this.conversations.createGroup(user, dto);
  }

  /** GET /chat/spaces/:spaceId/channel */
  @Get('spaces/:spaceId/channel')
  @ApiOperation({ summary: 'The channel of a space (created on first use)' })
  @ApiParam({ name: 'spaceId' })
  getSpaceChannel(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.conversations.getSpaceChannel(user, spaceId);
  }

  /** GET /chat/conversations/:id */
  @Get('conversations/:id')
  @ApiOperation({ summary: 'Conversation details, my state and members' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 404, description: 'Unknown or not readable' })
  getConversation(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.conversations.getConversation(user, id);
  }

  /** PATCH /chat/conversations/:id */
  @Patch('conversations/:id')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Rename a group or change its description (owners)',
  })
  @ApiParam({ name: 'id' })
  updateConversation(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConversationDto,
  ) {
    return this.conversations.updateConversation(user, id, dto);
  }

  /** PATCH /chat/conversations/:id/me */
  @Patch('conversations/:id/me')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'My notification level, mute and inbox pin' })
  @ApiParam({ name: 'id' })
  updateMyState(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMyConversationStateDto,
  ) {
    return this.conversations.updateMyState(user, id, dto);
  }

  /** POST /chat/conversations/:id/members */
  @Post('conversations/:id/members')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add people to a group' })
  @ApiParam({ name: 'id' })
  addMembers(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddMembersDto,
  ) {
    return this.conversations.addMembers(user, id, dto);
  }

  /** DELETE /chat/conversations/:id/members/:userId */
  @Delete('conversations/:id/members/:userId')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove someone from a group (owners)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'userId' })
  async removeMember(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.conversations.removeMember(user, id, userId);
  }

  /** PATCH /chat/conversations/:id/members/:userId */
  @Patch('conversations/:id/members/:userId')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Promote or demote a group member (owners)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'userId' })
  async setMemberRole(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetMemberRoleDto,
  ): Promise<void> {
    await this.conversations.setMemberRole(user, id, userId, dto.role);
  }

  /** POST /chat/conversations/:id/leave */
  @Post('conversations/:id/leave')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Leave a group' })
  @ApiParam({ name: 'id' })
  async leave(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.conversations.leave(user, id);
  }
}
