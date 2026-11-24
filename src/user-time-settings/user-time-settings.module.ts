import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { UserTimeSettingsController } from './user-time-settings.controller';
import { UserTimeSettingsService } from './user-time-settings.service';

@Module({
  imports: [AuditLogsModule],
  controllers: [UserTimeSettingsController],
  providers: [UserTimeSettingsService],
  exports: [UserTimeSettingsService],
})
export class UserTimeSettingsModule {}
