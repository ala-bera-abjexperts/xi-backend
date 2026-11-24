/** @fileoverview NestJS module wiring the workflow_outbox service, processor, and per-type dispatchers. @module src/workflow-outbox/workflow-outbox.module @author Rajbha Manek */

import { forwardRef, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';

import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';
import { FireEventDispatcher } from './dispatchers/fire-event.dispatcher';
import { FireWebhookDispatcher } from './dispatchers/fire-webhook.dispatcher';
import { SendNotificationDispatcher } from './dispatchers/send-notification.dispatcher';
import { WorkflowOutboxProcessor } from './workflow-outbox.processor';
import { WorkflowOutboxService } from './workflow-outbox.service';

/**
 * Wires the outbox subsystem.
 *
 * The schedule and event-emitter modules are imported here so the processor
 * can register its `@Cron` decorator and the fire_event dispatcher has a live
 * `EventEmitter2`. `forRoot()` on both is also registered in `app.module.ts`
 * by the orchestrator phase — Nest deduplicates these so importing here is
 * safe and keeps the module self-contained for tests.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    MailModule,
    NotificationsModule,
    PermissionsModule,
    // Engine module forward-refs us back, so we need a matching forwardRef
    // here to break the cycle at module-resolution time.
    forwardRef(() => WorkflowEngineModule),
  ],
  providers: [
    WorkflowOutboxService,
    WorkflowOutboxProcessor,
    SendNotificationDispatcher,
    FireWebhookDispatcher,
    FireEventDispatcher,
  ],
  exports: [WorkflowOutboxService],
})
export class WorkflowOutboxModule {}
