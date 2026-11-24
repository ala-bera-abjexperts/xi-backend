/**
 * @fileoverview NestJS module for the File Explorer feature — space-scoped Drive-like file store
 * with folders, versioning, sharing, labels, reminders, and trash.
 * @module src/file-explorer/file-explorer.module
 */

import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { StorageConfigModule } from '../storage-config/storage-config.module';
import { FileExplorerController } from './file-explorer.controller';
import { FileExplorerNodeController } from './file-explorer-node.controller';
import { FileExplorerPublicController } from './file-explorer-public.controller';
import { FileExplorerUsageController } from './file-explorer-usage.controller';
import { FileExplorerService } from './file-explorer.service';
import { FileExplorerAccessService } from './file-explorer-access.service';
import { FileExplorerStorageService } from './file-explorer-storage.service';
import { FileExplorerArchiveService } from './file-explorer-archive.service';
import { FileExplorerRepository } from './file-explorer.repository';
import { FileExplorerRemindersCron } from './file-explorer-reminders.cron';
import { FileExplorerSweeperCron } from './file-explorer-sweeper.cron';

@Module({
  imports: [
    AuditLogsModule,
    MailModule,
    NotificationsModule,
    PermissionsModule,
    StorageConfigModule,
  ],
  controllers: [
    FileExplorerController,
    FileExplorerNodeController,
    FileExplorerPublicController,
    FileExplorerUsageController,
  ],
  providers: [
    FileExplorerService,
    FileExplorerAccessService,
    FileExplorerStorageService,
    FileExplorerArchiveService,
    FileExplorerRepository,
    FileExplorerRemindersCron,
    FileExplorerSweeperCron,
  ],
  // Export StorageService so SpacesModule can call removeSpaceStorage() on space deletion.
  // Export the Repository so PublicSiteStudioModule can resolve a label-backed file
  // list without a RequestUser (its callers are anonymous visitors).
  exports: [
    FileExplorerService,
    FileExplorerAccessService,
    FileExplorerStorageService,
    FileExplorerRepository,
  ],
})
export class FileExplorerModule {}
