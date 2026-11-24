/**
 * @fileoverview NestJS module that registers the {@link SpacesService} and
 * {@link SpacesController} for space management, membership, and icon operations.
 * @module src/spaces/spaces.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { SpacesService } from './spaces.service';
import { SpaceMemberRulesService } from './space-member-rules.service';
import { SpaceCategoriesService } from './space-categories.service';
import { SpacesController } from './spaces.controller';
import { AutomationsModule } from '../automations/automations.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { MailModule } from '../mail/mail.module';
import { TasksModule } from '../tasks/tasks.module';
import { SpaceTemplatesModule } from '../space-templates/space-templates.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LicensingModule } from '../licensing/licensing.module';
import { FileExplorerModule } from '../file-explorer/file-explorer.module';
import { TestManagementModule } from '../test-management/test-management.module';
import { CreateSpaceFromTemplateAction } from './automation/create-space-from-template.action';
import { SpaceStorageCleanupProcessor } from './space-storage-cleanup.processor';

/**
 * Module that provides space management, membership, and icon endpoints.
 *
 * Imports:
 * - `PermissionsModule` -- provides {@link PermissionsService} for permission guard resolution
 * - `UsersModule` -- provides {@link UsersService} for user lookups
 *
 * @example
 * // Import in AppModule:
 * @Module({ imports: [SpacesModule] })
 * export class AppModule {}
 */
@Module({
  imports: [
    AutomationsModule,
    PermissionsModule,
    UsersModule,
    AuditLogsModule,
    MailModule,
    TasksModule,
    SpaceTemplatesModule,
    NotificationsModule,
    FileExplorerModule,
    // Supplies EntitlementsService so the MCP-facing space payloads can drop
    // modules the tenant is not licensed for.
    LicensingModule,
    // Adds or deactivates the test task types when Test Management is switched.
    TestManagementModule,
  ],
  controllers: [SpacesController],
  // CreateSpaceFromTemplateAction is a provider only — it self-registers with
  // ActionRegistryService on init.
  providers: [
    SpacesService,
    SpaceCategoriesService,
    SpaceMemberRulesService,
    CreateSpaceFromTemplateAction,
    SpaceStorageCleanupProcessor,
  ],
  exports: [SpacesService, SpaceCategoriesService, SpaceMemberRulesService],
})
export class SpacesModule {}
