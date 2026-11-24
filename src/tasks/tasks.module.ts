/**
 * @fileoverview NestJS module for the tasks feature — core CRUD,
 * comments, relationships, hierarchy, and history.
 * @module src/tasks/tasks.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { AgentOriginModule } from '../chat-agent/agent-origin.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { WikiModule } from '../wiki/wiki.module';
import { TaskHierarchyConfigModule } from '../task-hierarchy-config/task-hierarchy-config.module';
import { WorkflowAssignmentsModule } from '../workflow-assignments/workflow-assignments.module';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';
import { AutomationsModule } from '../automations/automations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WatchersModule } from '../watchers/watchers.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { TasksService } from './tasks.service';
import { TaskAttachmentsService } from './tasks-attachments.service';
import { TaskRemindersService } from './task-reminders.service';
import { TaskWikiGenerationService } from './task-wiki-generation.service';
import { TasksMineWriteService } from './tasks-mine-write.service';
import { TasksCreateWithAttachmentsService } from './tasks-create-with-attachments.service';
import { TasksController } from './tasks.controller';
import { TasksMineWriteController } from './tasks-mine-write.controller';
import { OrganizationModulesModule } from '../organization-modules/organization-modules.module';
import { LicensingModule } from '../licensing/licensing.module';
import { TaskPickerController } from './task-picker/task-picker.controller';
import { TaskPickerService } from './task-picker/task-picker.service';
import { IssueGroupsController } from './issue-groups/issue-groups.controller';
import { IssueGroupsService } from './issue-groups/issue-groups.service';
import { TestManagementAccessModule } from '../test-management/access/test-management-access.module';

@Module({
  imports: [
    AgentOriginModule,
    PermissionsModule,
    UsersModule,
    AuditLogsModule,
    WikiModule,
    TaskHierarchyConfigModule,
    WorkflowAssignmentsModule,
    WorkflowEngineModule,
    AutomationsModule,
    NotificationsModule,
    WatchersModule,
    // For the single-request create that stores files before the task row exists.
    // AttachmentsModule imports neither this module nor anything leading back to it, so no cycle.
    AttachmentsModule,
    // Tasks-module on/off per tenant and space for the task picker. Imports none of ours back.
    OrganizationModulesModule,
    // Git computed fields on GET /tasks only with feature_external_integrations. Imports none of ours.
    LicensingModule,
    // Test Management availability for test tickets. Imports none of ours back.
    TestManagementAccessModule,
  ],
  // TaskPickerController first: its literal `picker` segment must win over `/tasks/:id`.
  controllers: [
    TaskPickerController,
    IssueGroupsController,
    TasksController,
    TasksMineWriteController,
  ],
  providers: [
    TaskPickerService,
    IssueGroupsService,
    TasksService,
    TasksCreateWithAttachmentsService,
    TaskAttachmentsService,
    TaskRemindersService,
    TaskWikiGenerationService,
    TasksMineWriteService,
  ],
  exports: [
    TasksService,
    TaskPickerService,
    TasksCreateWithAttachmentsService,
    TaskAttachmentsService,
    TaskRemindersService,
    TaskWikiGenerationService,
    TasksMineWriteService,
  ],
})
export class TasksModule {}
