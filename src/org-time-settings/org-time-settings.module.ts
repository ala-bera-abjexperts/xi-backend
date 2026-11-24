import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { OrgTimeSettingsController } from './org-time-settings.controller';
import { OrgTimeSettingsService } from './org-time-settings.service';

@Module({
  imports: [AuditLogsModule],
  controllers: [OrgTimeSettingsController],
  providers: [OrgTimeSettingsService],
  exports: [OrgTimeSettingsService],
})
export class OrgTimeSettingsModule {}
