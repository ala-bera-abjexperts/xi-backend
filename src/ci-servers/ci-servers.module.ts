/**
 * @fileoverview Org-level Jenkins servers. `SupabaseAdminService` comes from the global SupabaseModule.
 * @module src/ci-servers/ci-servers.module
 */

import { Module } from '@nestjs/common';

import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { CiServersController } from './ci-servers.controller';
import { CiServersService } from './ci-servers.service';

@Module({
  imports: [AuditLogsModule],
  controllers: [CiServersController],
  providers: [CiServersService],
  exports: [CiServersService],
})
export class CiServersModule {}
