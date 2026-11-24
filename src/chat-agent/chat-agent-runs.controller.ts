/**
 * @fileoverview Robert's runs and proposals (XE-T353 1.13 and 1.14, contract section 4.1):
 * `/chat/agent/runs/...` and `/chat/agent/actions/...`.
 *  - resolve reads, so it needs the chat licence and `can_use_chat` only and keeps working
 *    when the AI licence lapses or Robert is switched off;
 *  - everything else changes a run (cancel, rerun, edit, Confirm, Retry, Cancel a proposal,
 *    feedback): also the AI licence and `can_use_robert`, closed during impersonation, and
 *    for the invoker only (404 for everyone else, admins and other tenants included).
 * chat-agent-controllers.spec.ts holds every route of this module to these rules.
 * @module src/chat-agent/chat-agent-runs.controller
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ChatAccessService } from '../chat/chat-access.service';
import type { AgentRunRef } from '../chat/chat-messages.service';
import { RequireChatPermission } from '../chat/chat-permission.guard';
import { AgentActionExecutorService } from './agent-action-executor.service';
import { AgentRunStarterService } from './agent-run-starter.service';
import {
  type AgentRunView,
  AgentRunViewService,
} from './agent-run-view.service';
import { AgentRunWorkerService } from './agent-run-worker.service';
import { AgentUndoService } from './agent-undo.service';
import { AgentRunsRepository } from './agent-runs.repository';
import {
  AgentFeedbackDto,
  ConfirmAgentActionsDto,
  PatchAgentActionsDto,
  ResolveAgentRunsDto,
  RetryAgentActionDto,
  UndoAgentActionsDto,
} from './dto/agent.dto';

@RequireFeature('module_chat')
@RequireChatPermission('can_use_chat')
@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat/agent')
export class ChatAgentRunsController {
  constructor(
    private readonly views: AgentRunViewService,
    private readonly runs: AgentRunsRepository,
    private readonly worker: AgentRunWorkerService,
    private readonly starter: AgentRunStarterService,
    private readonly access: ChatAccessService,
    private readonly executor: AgentActionExecutorService,
    private readonly undoService: AgentUndoService,
  ) {}

  /** POST /chat/agent/runs/resolve */
  @Post('runs/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'My view of Robert runs, by run or request id; unknown or unreadable ids are left out',
  })
  async resolve(
    @CurrentUser() user: RequestUser,
    @Body() dto: ResolveAgentRunsDto,
  ): Promise<{ runs: AgentRunView[] }> {
    return { runs: await this.views.resolve(user, dto) };
  }

  /** POST /chat/agent/runs/:id/cancel */
  @Post('runs/:id/cancel')
  @RequireFeature('module_chat', 'feature_ai_assist')
  @RequireChatPermission('can_use_robert')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop my Robert run' })
  async cancel(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentRunView> {
    // Invoker only: the function answers everyone else 404.
    await this.runs.cancelRun(user.organizationId, id, user.userId);
    // In flight here: ends now. Elsewhere: the next heartbeat or the reaper ends it.
    this.worker.abort(id);
    void this.views.announce(id);

    return this.views.viewOne(user, id);
  }

  /** POST /chat/agent/runs/:id/rerun */
  @Post('runs/:id/rerun')
  @RequireFeature('module_chat', 'feature_ai_assist')
  @RequireChatPermission('can_use_robert')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run my request to Robert again (after an edit)' })
  async rerun(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ agentRun: AgentRunRef }> {
    const run = await this.views.getOwnRun(user, id);
    const { conversation } = await this.access.getReadable(
      user,
      run.conversation_id,
    );

    return {
      agentRun: await this.starter.start(
        user,
        conversation,
        run.trigger_message_id,
        { rerunOf: run.id, timezone: run.timezone },
      ),
    };
  }

  /** PATCH /chat/agent/runs/:id/actions */
  @Patch('runs/:id/actions')
  @RequireFeature('module_chat', 'feature_ai_assist')
  @RequireChatPermission('can_use_robert')
  @ImpersonationBlocked()
  @ApiOperation({
    summary:
      'Edit fields of my proposals; a stale version answers 409 with the fresh run in data.run',
  })
  patchActions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchAgentActionsDto,
  ): Promise<AgentRunView> {
    return this.executor.patch(user, id, dto.changes);
  }

  /** POST /chat/agent/runs/:id/confirm */
  @Post('runs/:id/confirm')
  @RequireFeature('module_chat', 'feature_ai_assist')
  @RequireChatPermission('can_use_robert')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Create the proposed tasks; 409 with the fresh run in data.run when something changed',
  })
  confirm(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmAgentActionsDto,
  ): Promise<AgentRunView> {
    return this.executor.confirm(user, id, dto.actions);
  }

  /** POST /chat/agent/runs/:id/undo: one card and its children, or without actions the whole batch. */
  @Post('runs/:id/undo')
  @RequireFeature('module_chat', 'feature_ai_assist')
  @RequireChatPermission('can_use_robert')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Undo what Robert made, within 10 minutes; 409 with the fresh run in data.run when it can no longer be done',
  })
  undo(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UndoAgentActionsDto,
  ): Promise<AgentRunView> {
    return this.undoService.undo(user, id, dto.actions);
  }

  /** GET /chat/agent/actions/:id/options: picker search for a parent task or page (invoker only). */
  @Get('actions/:id/options')
  @ApiOperation({ summary: 'Search the parent task or page of one of my proposals' })
  actionOptions(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('field') field: string,
    @Query('q') q?: string,
  ): Promise<{ value: string; label: string; hint?: string }[]> {
    if (field !== 'parent' && field !== 'parentPage')
      throw new BadRequestException('Unknown field');
    return this.executor.options(user, id, field, (q ?? '').slice(0, 100));
  }

  /** POST /chat/agent/actions/:id/cancel */
  @Post('actions/:id/cancel')
  @RequireFeature('module_chat', 'feature_ai_assist')
  @RequireChatPermission('can_use_robert')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel one of my proposals' })
  cancelAction(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentRunView> {
    return this.executor.cancel(user, id);
  }

  /** POST /chat/agent/actions/:id/retry */
  @Post('actions/:id/retry')
  @RequireFeature('module_chat', 'feature_ai_assist')
  @RequireChatPermission('can_use_robert')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check a failed proposal again and create it' })
  retryAction(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RetryAgentActionDto,
  ): Promise<AgentRunView> {
    return this.executor.retry(user, id, dto.version);
  }

  /** POST /chat/agent/runs/:id/feedback */
  @Post('runs/:id/feedback')
  @RequireFeature('module_chat', 'feature_ai_assist')
  @RequireChatPermission('can_use_robert')
  @ImpersonationBlocked()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Thumbs up or down on my finished run' })
  async feedback(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AgentFeedbackDto,
  ): Promise<void> {
    await this.executor.feedback(user, id, dto.rating);
  }
}
