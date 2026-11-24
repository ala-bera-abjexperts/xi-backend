/**
 * @fileoverview The AI audit log (XE-T353 1.14, SEC-05): `/chat/agent/audit` and its export.
 * Both need `can_view_ai_audit` and the chat licence only, so the log stays readable when the
 * AI licence lapses. The export is itself audited and closed during impersonation.
 * chat-agent-controllers.spec.ts holds every route of this module to these rules.
 * @module src/chat-agent/chat-agent-audit.controller
 */

import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { RequireChatPermission } from '../chat/chat-permission.guard';
import { contentDispositionAttachment } from '../common/content-disposition';
import {
  type AgentAuditEventView,
  AgentAuditService,
} from './agent-audit.service';
import { AgentAuditExportDto, AgentAuditQueryDto } from './dto/agent.dto';

@RequireFeature('module_chat')
@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat/agent')
export class ChatAgentAuditController {
  constructor(private readonly audit: AgentAuditService) {}

  /** GET /chat/agent/audit */
  @Get('audit')
  @RequireChatPermission('can_view_ai_audit')
  @ApiOperation({
    summary: "Robert's audit log, newest first, paged by cursor (≤ 100 rows)",
  })
  list(
    @CurrentUser() user: RequestUser,
    @Query() query: AgentAuditQueryDto,
  ): Promise<{ events: AgentAuditEventView[]; nextCursor: string | null }> {
    return this.audit.list(user, query);
  }

  /** GET /chat/agent/audit/export */
  @Get('audit/export')
  @RequireChatPermission('can_view_ai_audit')
  @ImpersonationBlocked()
  @ApiOperation({
    summary:
      "Download Robert's audit log as CSV or JSON (at most 50,000 rows; X-Export-Capped says when cut)",
  })
  async export(
    @CurrentUser() user: RequestUser,
    @Query() query: AgentAuditExportDto,
    @Res() res: Response,
  ): Promise<void> {
    const { body, capped } = await this.audit.export(user, query);
    const date = new Date().toISOString().slice(0, 10);

    res.set({
      'Content-Type':
        query.format === 'csv'
          ? 'text/csv; charset=utf-8'
          : 'application/json; charset=utf-8',
      'Content-Disposition': contentDispositionAttachment(
        `robert-audit-${date}.${query.format}`,
      ),
      'X-Export-Capped': String(capped),
    });
    res.send(body);
  }
}
