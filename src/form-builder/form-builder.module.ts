import { Module } from '@nestjs/common';

import { PermissionsModule } from '../permissions/permissions.module';
import { StripePaymentsModule } from '../stripe/stripe.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MailModule } from '../mail/mail.module';
import { TasksModule } from '../tasks/tasks.module';
import { TaskHierarchyConfigModule } from '../task-hierarchy-config/task-hierarchy-config.module';
import { AssetsObjectsModule } from '../assets-objects/assets-objects.module';
import { AutomationsModule } from '../automations/automations.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { FormBuilderController } from './form-builder.controller';
import { FormBuilderFieldsController } from './form-builder-fields.controller';
import { FormBuilderSubmissionsController } from './form-builder-submissions.controller';
import { FormBuilderPaymentsController } from './form-builder-payments.controller';
import { FormBuilderPaymentConfigController } from './form-builder-payment-config.controller';
import { FormBuilderUploadsController } from './form-builder-uploads.controller';
import { FormBuilderAssignmentsController } from './form-builder-assignments.controller';
import { FormBuilderApprovalsController } from './form-builder-approvals.controller';
import { FormBuilderMyApprovalsController } from './form-builder-my-approvals.controller';
import { FormBuilderMyAssignmentsController } from './form-builder-my-assignments.controller';
import { FormBuilderAnalyticsController } from './form-builder-analytics.controller';
import { FormBuilderWebhooksController } from './form-builder-webhooks.controller';
import { FormBuilderIntegrationsController } from './form-builder-integrations.controller';
import { FormBuilderTaskFieldRolesController } from './form-builder-task-field-roles.controller';
import { FormBuilderTaskSubmissionsController } from './form-builder-task-submissions.controller';
import { FormBuilderVersionsController } from './form-builder-versions.controller';
import { FormBuilderService } from './form-builder.service';
import { FormBuilderFieldsService } from './form-builder-fields.service';
import { FormBuilderSubmissionsService } from './form-builder-submissions.service';
import { FormBuilderPaymentsService } from './form-builder-payments.service';
import { FormBuilderPaymentConfigService } from './form-builder-payment-config.service';
import { RecaptchaVerifierService } from './public/recaptcha-verifier.service';
import { FormBuilderUploadsService } from './form-builder-uploads.service';
import { FormBuilderAssignmentsService } from './form-builder-assignments.service';
import { FormBuilderApprovalsService } from './form-builder-approvals.service';
import { FormBuilderAnalyticsService } from './form-builder-analytics.service';
import { FormBuilderWebhooksService } from './form-builder-webhooks.service';
import { FormBuilderWebhookDispatcherService } from './form-builder-webhook-dispatcher.service';
import { FormBuilderIntegrationsService } from './form-builder-integrations.service';
import { FormBuilderIntegrationDispatcherService } from './form-builder-integration-dispatcher.service';
import { FormBuilderSubmissionEventsService } from './form-builder-submission-events.service';
import { FormBuilderTaskFieldRolesService } from './form-builder-task-field-roles.service';
import { FormBuilderTaskCreatorService } from './form-builder-task-creator.service';
import { FormBuilderVersionsService } from './form-builder-versions.service';
import { FormBuilderSpaceOrgInterceptor } from './interceptors/space-org.interceptor';

@Module({
  // SupabaseModule is @Global() — no import needed. StripePaymentsModule exports
  // StripeService for the payments flow. NotificationsModule + MailModule provide the
  // in-app broadcast + email transport for assignment nudges.
  imports: [
    PermissionsModule,
    StripePaymentsModule,
    NotificationsModule,
    MailModule,
    TasksModule,

    // Provides TaskHierarchyConfigService so a respondent's Task Type answer is checked against the
    // active types. TaskHierarchyConfigModule does not import FormBuilderModule, so no cycle.
    TaskHierarchyConfigModule,
    AssetsObjectsModule,

    // Provides AutomationEventOutboxService so a form submission can publish an `app.form.submitted`
    // automation event. AutomationsModule does not import FormBuilderModule, so no cycle.
    AutomationsModule,

    // Provides AuditLogsService so approval decisions are recorded to the audit log
    // (entity_type='form_approval'). AuditLogsModule only imports PermissionsModule, so no cycle.
    AuditLogsModule,
  ],
  controllers: [
    FormBuilderController,
    FormBuilderFieldsController,
    FormBuilderSubmissionsController,
    FormBuilderPaymentsController,
    FormBuilderPaymentConfigController,
    FormBuilderUploadsController,
    FormBuilderAssignmentsController,
    FormBuilderApprovalsController,
    FormBuilderMyApprovalsController,
    FormBuilderMyAssignmentsController,
    FormBuilderAnalyticsController,
    FormBuilderWebhooksController,
    FormBuilderIntegrationsController,
    FormBuilderTaskFieldRolesController,
    FormBuilderTaskSubmissionsController,
    FormBuilderVersionsController,
  ],
  providers: [
    FormBuilderService,
    FormBuilderFieldsService,
    FormBuilderSubmissionsService,
    FormBuilderPaymentsService,
    FormBuilderPaymentConfigService,

    // Stateless (one fetch, no DB), so the public module keeping its own instance is harmless.
    RecaptchaVerifierService,
    FormBuilderUploadsService,
    FormBuilderAssignmentsService,
    FormBuilderApprovalsService,
    FormBuilderAnalyticsService,
    FormBuilderWebhooksService,
    FormBuilderWebhookDispatcherService,
    FormBuilderIntegrationsService,
    FormBuilderIntegrationDispatcherService,
    FormBuilderSubmissionEventsService,
    FormBuilderTaskFieldRolesService,
    FormBuilderTaskCreatorService,
    FormBuilderVersionsService,
    FormBuilderSpaceOrgInterceptor,
  ],
  exports: [
    FormBuilderService,
    FormBuilderFieldsService,
    FormBuilderSubmissionsService,

    // Exported so the Site Studio public-form path can run the same post-submission pipeline
    // (task creation / webhooks / notifications) an authenticated submission does.
    FormBuilderSubmissionEventsService,

    // Exported so the Site Studio public-form path can check assignee access and mark an
    // assignee's assignment completed when they submit via a published funnel.
    FormBuilderAssignmentsService,

    // Exported so the public form path can (a) decide whether a `products` field may be served
    // publicly — it may only when the space has a working gateway — and (b) run anonymous checkout
    // through the same money code an in-app payment uses.
    FormBuilderPaymentConfigService,
    FormBuilderPaymentsService,

    // Exported so the public form path can accept file_upload/audio answers through the SAME
    // storage-write code an authenticated submission uses, rather than a second implementation.
    FormBuilderUploadsService,
  ],
})
export class FormBuilderModule {}
