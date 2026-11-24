/**
 * @fileoverview Module for audit log management.
 * Exports AuditLogsService so other modules (tasks, processes, wiki) can
 * call logAction() to create entries as a side-effect of their mutations.
 * @module src/audit-logs/audit-logs.module
 */

import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsService } from './audit-logs.service';

@Module({
  imports: [PermissionsModule],
  controllers: [AuditLogsController],
  providers: [AuditLogsService],
  exports: [AuditLogsService],
})
export class AuditLogsModule {}
