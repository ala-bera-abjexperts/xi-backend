import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AutomationsModule } from '../automations/automations.module';
import { FileExplorerModule } from '../file-explorer/file-explorer.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { EntityFileLinksService } from './entity-file-links.service';
import { WikiModule } from '../wiki/wiki.module';
import { ChatModule } from '../chat/chat.module';
import { TestManagementAccessModule } from '../test-management/access/test-management-access.module';

@Module({
  imports: [
    AuditLogsModule,
    PermissionsModule,
    AutomationsModule,
    FileExplorerModule,
    NotificationsModule,
    // For the per-page wiki restriction check on attachment access. WikiModule does not import
    // AttachmentsModule, so this is not a cycle.
    WikiModule,
    // chat_message attachments (ChatAccessService + ChatRealtimeService). ChatModule does not
    // import AttachmentsModule, so this is not a cycle.
    ChatModule,
    // Test Management evidence access. TestManagementAccessModule does not import
    // AttachmentsModule, so this is not a cycle.
    TestManagementAccessModule,
  ],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, EntityFileLinksService],
  exports: [AttachmentsService, EntityFileLinksService],
})
export class AttachmentsModule {}
