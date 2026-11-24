/**
 * @fileoverview GDPR module — org-scoped and space-scoped GDPR controllers
 * and services for spreadsheet, records, columns, comments, attachments,
 * history, and CSV export.
 * @module src/gdpr/gdpr.module
 */

import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AutomationsModule } from '../automations/automations.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { GdprController } from './gdpr.controller';
import { GdprService } from './gdpr.service';

@Module({
  imports: [PermissionsModule, UsersModule, AuditLogsModule, AutomationsModule],
  controllers: [GdprController],
  providers: [GdprService],
  exports: [GdprService],
})
export class GdprModule {}
