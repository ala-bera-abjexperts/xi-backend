/**
 * @fileoverview Module wiring for Super-Admin impersonation. SupabaseModule
 * is @Global() so we do not need to import it here; AuditLogsModule is
 * imported because we depend on AuditLogsService (it is exported there).
 * SuperAdminGuard is provided locally — it has no module-level deps beyond
 * Reflector, which Nest provides globally.
 *
 * @module src/impersonation/impersonation.module
 */

import { Module } from '@nestjs/common';

import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { SuperAdminGuard } from '../auth/guards/super-admin.guard';
import { ImpersonationController } from './impersonation.controller';
import { ImpersonationService } from './impersonation.service';

@Module({
  imports: [AuditLogsModule],
  controllers: [ImpersonationController],
  providers: [ImpersonationService, SuperAdminGuard],
  exports: [ImpersonationService],
})
export class ImpersonationModule {}
