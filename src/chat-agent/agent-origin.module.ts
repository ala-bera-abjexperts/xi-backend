/**
 * @fileoverview The label on what Robert drafted, for the task, wiki and process routes. A module of
 * its own: ChatAgentModule imports those, so they can't import it.
 * @module src/chat-agent/agent-origin.module
 */
import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { AgentOriginService } from './agent-origin.service';

@Module({
  imports: [PermissionsModule],
  providers: [AgentOriginService],
  exports: [AgentOriginService],
})
export class AgentOriginModule {}
