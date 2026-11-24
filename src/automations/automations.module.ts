import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LicensingModule } from '../licensing/licensing.module';
import { ActionRegistryService } from './actions/action-registry.service';
import { AutomationCatalogService } from './automation-catalog.service';
import { AutomationTriggerCatalogService } from './automation-trigger-catalog.service';
import { AutomationsService } from './automations.service';
import { AutomationVersionsService } from './automation-versions.service';
import { AutomationRunsService } from './automation-runs.service';
import { AutomationConnectionsService } from './automation-connections.service';
import { AutomationScheduleService } from './automation-schedule.service';
import { AutomationMailboxPollerService } from './automation-mailbox-poller.service';
import { AutomationEventOutboxService } from './automation-event-outbox.service';
import { AutomationEventSubscriptionService } from './automation-event-subscription.service';
import { AutomationsController } from './automations.controller';
import { AutomationVersionsController } from './automation-versions.controller';
import { AutomationRunsController } from './automation-runs.controller';
import { AutomationConnectionsController } from './automation-connections.controller';
import { AutomationScheduleController } from './automation-schedule.controller';
import { AutomationWebhookController } from './automation-webhook.controller';
import { AutomationWebhookService } from './automation-webhook.service';
import { AutomationTickController } from './automation-tick.controller';
import { AutomationTickService } from './automation-tick.service';
import { AutomationWorkerController } from './automation-worker.controller';
import { AutomationWorkerService } from './automation-worker.service';
import { AutomationOAuthCallbackController } from './automation-oauth-callback.controller';
import { AutomationAnalyticsController } from './automation-analytics.controller';
import { AutomationQueueService } from './utils/queue';
import { AutomationCronService } from './automation-cron.service';
import { AutomationTemplatesService } from './automation-templates.service';

@Module({
  imports: [
    PermissionsModule,
    AuditLogsModule,
    NotificationsModule,
    // Supplies EntitlementsService for the warn-only automation-limit check.
    LicensingModule,
  ],
  controllers: [
    AutomationTickController, // internal cron tick — CRON_SECRET bearer auth, no Swagger
    AutomationWorkerController, // internal cron worker — CRON_SECRET bearer auth, no Swagger
    AutomationWebhookController, // public — no auth guard, separate prefix
    AutomationOAuthCallbackController, // public — OAuth callbacks from Google/Slack
    AutomationConnectionsController, // must be before AutomationsController — prevents /automations/:id swallowing /automations/connections
    AutomationsController,
    AutomationVersionsController,
    AutomationRunsController,
    AutomationScheduleController,
    AutomationAnalyticsController,
  ],
  providers: [
    ActionRegistryService,
    AutomationCatalogService,
    AutomationTriggerCatalogService,
    AutomationsService,
    AutomationVersionsService,
    AutomationRunsService,
    AutomationConnectionsService,
    AutomationScheduleService,
    AutomationMailboxPollerService,
    AutomationEventOutboxService,
    AutomationEventSubscriptionService,
    AutomationWebhookService,
    AutomationTickService,
    AutomationWorkerService,
    AutomationQueueService,
    AutomationCronService,
    AutomationTemplatesService,
  ],
  exports: [
    AutomationsService,
    AutomationVersionsService,
    AutomationScheduleService,
    // Exported for the inbound-email module's poll loop.
    AutomationMailboxPollerService,
    AutomationConnectionsService,
    AutomationEventOutboxService,
    AutomationEventSubscriptionService,
    AutomationCronService,
    ActionRegistryService,
  ],
})
export class AutomationsModule {}
