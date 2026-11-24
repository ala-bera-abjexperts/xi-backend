import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { SubmitController } from './submit.controller';
import { SubmitService } from './submit.service';

@Module({
  imports: [PermissionsModule, AuditLogsModule],
  controllers: [SubmitController],
  providers: [SubmitService],
})
export class SubmitModule {}
