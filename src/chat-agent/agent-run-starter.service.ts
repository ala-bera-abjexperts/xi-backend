/**
 * @fileoverview Starts a Robert run for a message that asked for him (plan 2b). Called by the
 * chat send path (through ChatMessagesService.setAfterSend) and by "Re-run".
 *
 * Every gate failure is stored by agent_start_run as a refused run (`p_refusal`) with no chat
 * message, so a resend finds the same row and never collides. The start is idempotent per
 * request and run number: a resend gets the run that is already there.
 * @module src/chat-agent/agent-run-starter.service
 */

import { Injectable } from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { ChatConversationRow } from '../chat/chat-access.service';
import type { AgentRunRef } from '../chat/chat-messages.service';
import { ChatRealtimeService } from '../chat/chat-realtime.service';
import { AgentGatesService } from './agent-gates.service';
import { AgentRunViewService } from './agent-run-view.service';
import { AgentRunWorkerService } from './agent-run-worker.service';
import { AgentRunsRepository } from './agent-runs.repository';
import { AgentSettingsService } from './agent-settings.service';

@Injectable()
export class AgentRunStarterService {
  constructor(
    private readonly gates: AgentGatesService,
    private readonly runs: AgentRunsRepository,
    private readonly settings: AgentSettingsService,
    private readonly realtime: ChatRealtimeService,
    private readonly views: AgentRunViewService,
    private readonly worker: AgentRunWorkerService,
  ) {}

  /**
   * @param conversation where the request was written
   * @param triggerMessageId the request (a `user` message by `user`)
   */
  async start(
    user: RequestUser,
    conversation: ChatConversationRow,
    triggerMessageId: string,
    options: { timezone?: string | null; rerunOf?: string | null } = {},
  ): Promise<AgentRunRef> {
    const refusal = await this.gates.refusal(user, conversation);
    const started = await this.runs.startRun({
      organizationId: user.organizationId,
      triggerMessageId,
      invokerId: user.userId,
      timezone: options.timezone ?? null,
      rerunOf: options.rerunOf ?? null,
      refusal,
    });

    if (started.alert100) {
      void this.settings.notifyBudgetAlert(user.organizationId, 100);
    }

    // A resend changed nothing, so nobody needs to hear of it again.
    if (started.created) {
      if (started.agent_message_id) {
        // The database adds Robert's message but does not announce it.
        void this.realtime.messageCreated(conversation, {
          messageId: started.agent_message_id,
          seq: Number(started.seq),
          threadRootId: started.thread_root_id,
        });
      }
      void this.views.announce(started.run_id);
    }

    if (started.lease_token) {
      this.worker.runLeased(started.run_id, started.lease_token);
    }

    return { id: started.run_id, messageId: started.agent_message_id };
  }
}
