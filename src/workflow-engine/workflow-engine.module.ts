/**
 * @fileoverview Aggregates all rule handlers, exposes HandlerRegistryService,
 * and provides the runtime {@link WorkflowEngineService}. Also publishes the
 * service under the {@link WORKFLOW_ENGINE_SERVICE} DI token so the inbound
 * webhook trigger module (which forward-refs this module) can resolve the
 * engine through a Symbol token rather than a hard class import.
 * @module src/workflow-engine/workflow-engine.module
 * @author Rajbha Manek
 */

import { forwardRef, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AutomationsModule } from '../automations/automations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { WorkflowAssignmentsModule } from '../workflow-assignments/workflow-assignments.module';
import { WorkflowOutboxModule } from '../workflow-outbox/workflow-outbox.module';
import { WORKFLOW_ENGINE_SERVICE } from '../workflow-triggers/workflow-engine.contract';
import { WatchersModule } from '../watchers/watchers.module';
import { FieldCompareCondition } from './handlers/conditions/field-compare.condition';
import { FieldEqualsCondition } from './handlers/conditions/field-equals.condition';
import { GroupCondition } from './handlers/conditions/group.condition';
import { HasAttachmentsCondition } from './handlers/conditions/has-attachments.condition';
import { HasResolutionCondition } from './handlers/conditions/has-resolution.condition';
import { IsAssigneeCondition } from './handlers/conditions/is-assignee.condition';
import { IsReporterCondition } from './handlers/conditions/is-reporter.condition';
import { ParentStatusIsCondition } from './handlers/conditions/parent-status-is.condition';
import { StatusInCategoryCondition } from './handlers/conditions/status-in-category.condition';
import { UserInGroupCondition } from './handlers/conditions/user-in-group.condition';
import { UserInRoleCondition } from './handlers/conditions/user-in-role.condition';
import { HandlerRegistryService } from './handlers/handler-registry.service';
import { AnyHandler, WORKFLOW_HANDLERS } from './handlers/handler.types';
import { AddCommentPostFunction } from './handlers/post-functions/add-comment.post';
import { AssignToPostFunction } from './handlers/post-functions/assign-to.post';
import { ClearResolutionPostFunction } from './handlers/post-functions/clear-resolution.post';
import { LogEntryPostFunction } from './handlers/post-functions/log-entry.post';
import { SendInAppNotificationPostFunction } from './handlers/post-functions/send-inapp-notification.post';
import { SendNotificationPostFunction } from './handlers/post-functions/send-notification.post';
import { SetFieldValuePostFunction } from './handlers/post-functions/set-field-value.post';
import { SetResolutionPostFunction } from './handlers/post-functions/set-resolution.post';
import { TriggerWebhookPostFunction } from './handlers/post-functions/trigger-webhook.post';
import { UpdateLinkedTaskPostFunction } from './handlers/post-functions/update-linked-task.post';
import { ChildrenResolvedValidator } from './handlers/validators/children-resolved.validator';
import { FieldRangeValidator } from './handlers/validators/field-range.validator';
import { FieldRegexValidator } from './handlers/validators/field-regex.validator';
import { FieldRequiredValidator } from './handlers/validators/field-required.validator';
import { PermissionRequiredValidator } from './handlers/validators/permission-required.validator';
import { ResolutionRequiredValidator } from './handlers/validators/resolution-required.validator';
import { ScreenFieldsRequiredValidator } from './handlers/validators/screen-fields-required.validator';
import { CronTrigger } from './handlers/triggers/cron.trigger';
import { GitBranchCreatedTrigger } from './handlers/triggers/git-branch-created.trigger';
import { GitPrMergedTrigger } from './handlers/triggers/git-pr-merged.trigger';
import { GitDevelopmentEventTrigger } from './handlers/triggers/git-development-event.trigger';
import { InboundWebhookTrigger } from './handlers/triggers/inbound-webhook.trigger';
import { ParentTransitionedTrigger } from './handlers/triggers/parent-transitioned.trigger';
import { TemplatingService } from './templating/expand';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowTriggerRegistryService } from './workflow-trigger-registry.service';

// Handler classes added by T2-T5 — keep this array easy to extend by appending.
const HANDLER_CLASSES: Array<new (...args: never[]) => AnyHandler> = [
  // T2 — conditions
  UserInRoleCondition,
  UserInGroupCondition,
  IsAssigneeCondition,
  IsReporterCondition,
  FieldEqualsCondition,
  FieldCompareCondition,
  StatusInCategoryCondition,
  HasResolutionCondition,
  ParentStatusIsCondition,
  HasAttachmentsCondition,
  GroupCondition,
  // T3 — validators
  FieldRequiredValidator,
  FieldRegexValidator,
  FieldRangeValidator,
  ResolutionRequiredValidator,
  PermissionRequiredValidator,
  ChildrenResolvedValidator,
  ScreenFieldsRequiredValidator,
  // T4 — post-functions
  AssignToPostFunction,
  SetFieldValuePostFunction,
  SetResolutionPostFunction,
  ClearResolutionPostFunction,
  AddCommentPostFunction,
  LogEntryPostFunction,
  SendNotificationPostFunction,
  SendInAppNotificationPostFunction,
  TriggerWebhookPostFunction,
  UpdateLinkedTaskPostFunction,
  // T5 — triggers
  InboundWebhookTrigger,
  ParentTransitionedTrigger,
  CronTrigger,
  GitBranchCreatedTrigger,
  GitPrMergedTrigger,
  GitDevelopmentEventTrigger,
];

@Module({
  imports: [
    SupabaseModule,
    PermissionsModule,
    AuditLogsModule,
    AutomationsModule,
    // WorkflowOutboxModule imports WorkflowEngineModule for its own internal
    // wiring → forwardRef to break the cycle at module-resolution time.
    forwardRef(() => WorkflowOutboxModule),
    NotificationsModule,
    WorkflowAssignmentsModule,
    WatchersModule,
    EventEmitterModule,
  ],
  providers: [
    HandlerRegistryService,
    TemplatingService,
    WorkflowEngineService,
    WorkflowTriggerRegistryService,
    // Publish the engine under the Symbol token so the trigger module (which
    // injects with @Optional() / @Inject(WORKFLOW_ENGINE_SERVICE)) can wire to it.
    {
      provide: WORKFLOW_ENGINE_SERVICE,
      useExisting: WorkflowEngineService,
    },
    // One provider per handler — each constructible with `new`.
    ...HANDLER_CLASSES.map((Cls) => ({
      provide: Cls,
      useClass: Cls,
    })),
    {
      provide: WORKFLOW_HANDLERS,
      // Factory that takes all instances and gives the registry the array.
      useFactory: (...handlers: AnyHandler[]) => handlers,
      inject: HANDLER_CLASSES,
    },
  ],
  exports: [
    HandlerRegistryService,
    TemplatingService,
    WorkflowEngineService,
    WorkflowTriggerRegistryService,
    WORKFLOW_ENGINE_SERVICE,
  ],
})
export class WorkflowEngineModule {}
