/**
 * @fileoverview Administration of Robert (XE-T353, ADM-03): `/chat/agent/settings`
 * and `/chat/agent/usage`. Every route names its own permission (`can_manage_robert`
 * here); none needs `can_use_chat` or the AI licence, so the settings stay reachable
 * when the AI licence lapses. Changes are closed during impersonation.
 * @module src/chat-agent/chat-agent-admin.controller
 */

import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { RequireChatPermission } from '../chat/chat-permission.guard';
import { AgentSettingsService } from './agent-settings.service';
import { AgentUsageQueryDto, UpdateAgentSettingsDto } from './dto/agent.dto';

@RequireFeature('module_chat')
@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat/agent')
export class ChatAgentAdminController {
  constructor(private readonly settings: AgentSettingsService) {}

  /** GET /chat/agent/settings */
  @Get('settings')
  @RequireChatPermission('can_manage_robert')
  @ApiOperation({
    summary:
      "Robert's switches and token caps, with this month's usage against the cap",
  })
  getSettings(@CurrentUser() user: RequestUser) {
    return this.settings.get(user);
  }

  /** PUT /chat/agent/settings */
  @Put('settings')
  @RequireChatPermission('can_manage_robert')
  @ImpersonationBlocked()
  @ApiOperation({
    summary:
      "Change Robert's switches and token caps (null removes a cap; a cap below one run's reservation is refused)",
  })
  updateSettings(
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateAgentSettingsDto,
  ) {
    return this.settings.update(user, dto);
  }

  /** GET /chat/agent/usage */
  @Get('usage')
  @RequireChatPermission('can_manage_robert')
  @ApiOperation({
    summary: 'AI token usage of a period by day, user, model and feature',
  })
  getUsage(
    @CurrentUser() user: RequestUser,
    @Query() query: AgentUsageQueryDto,
  ) {
    return this.settings.usage(user, query);
  }
}
