/**
 * @fileoverview Robert, the AI assistant in chat (XE-T353): provider gates, tenant
 * settings and budgets, and the wrappers over the agent_* database functions.
 * Database layer: risk-management-app/supabase/migrations/2026101413*_chat_agent_*.
 * Imported by AppModule ONLY. ChatModule must never import it: tasks import
 * attachments, which import chat, so that would close a cycle. The chat send path
 * reaches Robert through the slot this module fills (ChatMessagesService.setAfterSend).
 * This module may import TasksModule, WikiModule and the task configuration modules (1.14,
 * 1.15): none of them imports it back.
 * @module src/chat-agent/chat-agent.module
 */

import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { AgentUndoRulesService } from './agent-undo-rules.service';
import { AgentUndoService } from './agent-undo.service';
import { AiAutomationModule } from '../ai-automation/ai-automation.module';
import { ChatMessagesService } from '../chat/chat-messages.service';
import { ChatModule } from '../chat/chat.module';
import { LicensingModule } from '../licensing/licensing.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { OrganizationModulesModule } from '../organization-modules/organization-modules.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { HierarchyConfigModule } from '../hierarchy-config/hierarchy-config.module';
import { TaskHierarchyConfigModule } from '../task-hierarchy-config/task-hierarchy-config.module';
import { TaskPrioritiesModule } from '../task-priorities/task-priorities.module';
import { TaskStatusesModule } from '../task-statuses/task-statuses.module';
import { TasksModule } from '../tasks/tasks.module';
import { WikiModule } from '../wiki/wiki.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { AgentFilesService } from './agent-files.service';
import { WorkflowAssignmentsModule } from '../workflow-assignments/workflow-assignments.module';
import { AgentActionExecutorService } from './agent-action-executor.service';
import { AgentAuditService } from './agent-audit.service';
import { AgentContextService } from './agent-context.service';
import { AgentGatesService } from './agent-gates.service';
import { AgentPlansService } from './agent-plans.service';
import { PlansModule } from '../plans/plans.module';
import { AgentGovernanceService } from './agent-governance.service';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ProcessesModule } from '../processes/processes.module';
import { SpacesModule } from '../spaces/spaces.module';
import { AgentReferencesService } from './agent-references.service';
import { AgentResolverService } from './agent-resolver.service';
import { AgentRunStarterService } from './agent-run-starter.service';
import { AgentRunViewService } from './agent-run-view.service';
import { AgentRunWorkerService } from './agent-run-worker.service';
import { AgentRunsRepository } from './agent-runs.repository';
import { AgentSettingsService } from './agent-settings.service';
import { ChatAgentAdminController } from './chat-agent-admin.controller';
import { ChatAgentAuditController } from './chat-agent-audit.controller';
import { ChatAgentRunsController } from './chat-agent-runs.controller';
import { ChatAgentController } from './chat-agent.controller';

@Module({
  imports: [
    // 1.18: files are read as the invoker, through the same download check a person gets.
    AttachmentsModule,
    // The chat services Robert builds on (messages, access, object cards, realtime).
    ChatModule,
    // TenantAiService: the one way to call the tenant's AI provider.
    AiAutomationModule,
    // EntitlementsService for the AI licence gate.
    LicensingModule,
    // PermissionsService, also for ChatPermissionGuard on the controllers.
    PermissionsModule,
    // Bell entries and the email of the budget alerts.
    NotificationsModule,
    MailModule,
    // 1.14: proposals are resolved against the task configuration and created through
    // TasksMineWriteService, as the invoker.
    TasksModule,
    TaskHierarchyConfigModule,
    // 1.20: where a process stands in the organization's process hierarchy.
    HierarchyConfigModule,
    WorkflowAssignmentsModule,
    TaskStatusesModule,
    TaskPrioritiesModule,
    CustomFieldsModule,
    OrganizationModulesModule,
    // 1.15: wiki pages are created through WikiMineWriteService, as the invoker; referenced pages
    // are read through WikiMineService.
    WikiModule,
    // 1.20: spaces, members and processes, only ever through AgentGovernanceService.
    SpacesModule,
    ProcessesModule,
    AuditLogsModule,
    // 1.22: project plans and their items, through PlansService as the person who confirms.
    PlansModule,
  ],
  controllers: [
    ChatAgentController,
    ChatAgentAdminController,
    ChatAgentRunsController,
    ChatAgentAuditController,
  ],
  providers: [
    AgentGatesService,
    AgentGovernanceService,
    AgentPlansService,
    AgentRunsRepository,
    AgentSettingsService,
    AgentContextService,
    AgentRunViewService,
    AgentRunWorkerService,
    AgentRunStarterService,
    AgentResolverService,
    AgentReferencesService,
    AgentFilesService,
    AgentActionExecutorService,
    AgentAuditService,
    AgentUndoRulesService,
    AgentUndoService,
  ],
})
export class ChatAgentModule implements OnModuleInit {
  private readonly logger = new Logger(ChatAgentModule.name);

  constructor(
    private readonly messages: ChatMessagesService,
    private readonly starter: AgentRunStarterService,
  ) {}

  /** Lets a sent message that asks for Robert start his run. */
  onModuleInit(): void {
    this.messages.setAfterSend(({ user, conversation, messageId, timezone }) =>
      this.starter
        .start(user, conversation, messageId, { timezone })
        .catch((err: unknown) => {
          // The send itself succeeded; the client finds no run and offers Retry.
          this.logger.error(
            `Robert run for message ${messageId} did not start: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }),
    );
  }
}
