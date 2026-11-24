import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { SpaceOverridesController } from './space-overrides.controller';
import { SpaceOverridesService } from './space-overrides.service';

@Module({
  imports: [PermissionsModule, AuditLogsModule],
  controllers: [SpaceOverridesController],
  providers: [SpaceOverridesService],
  exports: [SpaceOverridesService],
})
export class SpaceOverridesModule {}
