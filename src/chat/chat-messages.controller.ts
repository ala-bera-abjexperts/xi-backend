/**
 * @fileoverview REST endpoints for chat messages: timeline, send / edit / delete,
 * edit history, read position, reactions, pins and search (XE-T353). Licensed by
 * `module_chat` and gated by `can_use_chat`; access is resolved per request by
 * ChatAccessService. Every handler that changes something, and the realtime token,
 * is closed during impersonation.
 * @module src/chat/chat-messages.controller
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
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ChatMessagesService } from './chat-messages.service';
import { RequireChatPermission } from './chat-permission.guard';
import { ChatRealtimeService } from './chat-realtime.service';
import { ChatRefsService } from './chat-refs.service';
import {
  ChatRealtimeTokenDto,
  EditMessageDto,
  ListMessagesQueryDto,
  MarkReadDto,
  ResolveChatRefsDto,
  SearchMessagesQueryDto,
  SendMessageDto,
} from './dto/chat.dto';

@RequireFeature('module_chat')
@RequireChatPermission('can_use_chat')
@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatMessagesController {
  constructor(
    private readonly messages: ChatMessagesService,
    private readonly realtime: ChatRealtimeService,
    private readonly refs: ChatRefsService,
  ) {}

  /** POST /chat/realtime/token */
  @Post('realtime/token')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Short-lived Realtime JWT for my inbox topic and the conversations I can read',
  })
  realtimeToken(
    @CurrentUser() user: RequestUser,
    @Body() dto: ChatRealtimeTokenDto,
  ) {
    return this.realtime.mintToken(user, dto.conversationIds ?? []);
  }

  /** POST /chat/refs/resolve */
  @Post('refs/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve task / wiki page refs into object cards I may see',
  })
  resolveRefs(
    @CurrentUser() user: RequestUser,
    @Body() dto: ResolveChatRefsDto,
  ) {
    return this.refs.resolve(user, dto.refs);
  }

  /** GET /chat/conversations/:id/messages */
  @Get('conversations/:id/messages')
  @ApiOperation({
    summary:
      'A page of the timeline (or of one thread), ordered by seq; aroundMessageId returns the window around one message',
  })
  @ApiParam({ name: 'id' })
  list(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.messages.list(user, id, query);
  }

  /** POST /chat/conversations/:id/messages */
  @Post('conversations/:id/messages')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Send a message (resending the same id is idempotent)',
  })
  @ApiParam({ name: 'id' })
  send(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.messages.send(user, id, dto);
  }

  /** POST /chat/conversations/:id/read */
  @Post('conversations/:id/read')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set my read position (markUnread moves it back)' })
  @ApiParam({ name: 'id' })
  markRead(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkReadDto,
  ) {
    return this.messages.markRead(user, id, dto);
  }

  /** GET /chat/search */
  @Get('search')
  @ApiOperation({
    summary:
      'Search messages, file names and object titles in the conversations I can read (q or at least one filter)',
  })
  search(
    @CurrentUser() user: RequestUser,
    @Query() query: SearchMessagesQueryDto,
  ) {
    return this.messages.search(user, query);
  }

  /** PATCH /chat/messages/:messageId */
  @Patch('messages/:messageId')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Edit my message (every version is kept)' })
  @ApiParam({ name: 'messageId' })
  edit(
    @CurrentUser() user: RequestUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: EditMessageDto,
  ) {
    return this.messages.edit(user, messageId, dto);
  }

  /** DELETE /chat/messages/:messageId */
  @Delete('messages/:messageId')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Delete a message (author, or can_delete_any_chat_message)',
  })
  @ApiParam({ name: 'messageId' })
  remove(
    @CurrentUser() user: RequestUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ) {
    return this.messages.remove(user, messageId);
  }

  /** GET /chat/messages/:messageId/versions */
  @Get('messages/:messageId/versions')
  @ApiOperation({ summary: 'Edit history of a message, oldest first' })
  @ApiParam({ name: 'messageId' })
  versions(
    @CurrentUser() user: RequestUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ) {
    return this.messages.versions(user, messageId);
  }

  /** PUT /chat/messages/:messageId/reactions/:emoji */
  @Put('messages/:messageId/reactions/:emoji')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Add my reaction' })
  @ApiParam({ name: 'messageId' })
  @ApiParam({ name: 'emoji' })
  addReaction(
    @CurrentUser() user: RequestUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Param('emoji') emoji: string,
  ) {
    return this.messages.addReaction(user, messageId, emoji);
  }

  /** DELETE /chat/messages/:messageId/reactions/:emoji */
  @Delete('messages/:messageId/reactions/:emoji')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Remove my reaction' })
  @ApiParam({ name: 'messageId' })
  @ApiParam({ name: 'emoji' })
  removeReaction(
    @CurrentUser() user: RequestUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Param('emoji') emoji: string,
  ) {
    return this.messages.removeReaction(user, messageId, emoji);
  }

  /** PUT /chat/messages/:messageId/pin */
  @Put('messages/:messageId/pin')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Pin a message for everyone in the conversation' })
  @ApiParam({ name: 'messageId' })
  pin(
    @CurrentUser() user: RequestUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ) {
    return this.messages.setPinned(user, messageId, true);
  }

  /** DELETE /chat/messages/:messageId/pin */
  @Delete('messages/:messageId/pin')
  @ImpersonationBlocked()
  @ApiOperation({ summary: 'Unpin a message' })
  @ApiParam({ name: 'messageId' })
  unpin(
    @CurrentUser() user: RequestUser,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ) {
    return this.messages.setPinned(user, messageId, false);
  }
}
