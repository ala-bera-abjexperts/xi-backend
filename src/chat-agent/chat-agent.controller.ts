/**
 * @fileoverview REST endpoints of Robert, the AI assistant in chat (XE-T353):
 * `/chat/agent/...` for everyone who uses chat.
 *  - Reading routes need the chat licence and `can_use_chat` only, so Robert's old
 *    cards and notices stay readable when the AI licence lapses or he is switched off.
 *  - Routes that start or change something also need the AI licence and
 *    `can_use_robert`, and are closed during impersonation.
 * chat-agent-controllers.spec.ts holds every route of this module to these rules.
 * @module src/chat-agent/chat-agent.controller
 */

import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { RequireChatPermission } from '../chat/chat-permission.guard';
import { ChatRealtimeService } from '../chat/chat-realtime.service';
import { AgentGatesService } from './agent-gates.service';
import { AgentRunsRepository } from './agent-runs.repository';

@RequireFeature('module_chat')
@RequireChatPermission('can_use_chat')
@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat/agent')
export class ChatAgentController {
  constructor(
    private readonly gates: AgentGatesService,
    private readonly runs: AgentRunsRepository,
    private readonly realtime: ChatRealtimeService,
  ) {}

  /** GET /chat/agent/status */
  @Get('status')
  @ApiOperation({
    summary:
      'Whether Robert is usable by me: licence, permission, switch and provider in one answer',
  })
  getStatus(@CurrentUser() user: RequestUser) {
    return this.gates.status(user);
  }

  /** POST /chat/agent/dm */
  @Post('dm')
  @RequireFeature('module_chat', 'feature_ai_assist')
  @RequireChatPermission('can_use_robert')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Open (or create) my private conversation with Robert',
  })
  async openDm(
    @CurrentUser() user: RequestUser,
  ): Promise<{ conversationId: string }> {
    const conversationId = await this.runs.getOrCreateAgentDm(
      user.organizationId,
      user.userId,
    );

    void this.realtime.inboxChanged(conversationId, user.organizationId);

    return { conversationId };
  }
}
