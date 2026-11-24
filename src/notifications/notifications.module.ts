/**
 * @fileoverview NestJS module for the notifications feature.
 * Provides user notification listing, read-state management, and space invitation actions.
 * @module src/notifications/notifications.module
 */

import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsBroadcastService } from './notifications-broadcast.service';
import { NotificationEmailService } from './notification-email.service';

/**
 * Feature module for user notification management.
 *
 * Exported so other modules (e.g., InvitationsModule, SpacesModule, TasksModule)
 * can inject NotificationsService and NotificationsBroadcastService.
 *
 * @example
 * // Import in AppModule:
 * @Module({ imports: [NotificationsModule] })
 * export class AppModule {}
 */
@Module({
  imports: [AuditLogsModule, MailModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsBroadcastService,
    NotificationEmailService,
  ],
  exports: [
    NotificationsService,
    NotificationsBroadcastService,
    NotificationEmailService,
  ],
})
export class NotificationsModule {}
