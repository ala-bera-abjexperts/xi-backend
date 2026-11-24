import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { SiteTemplatesController } from './site-templates.controller';
import { SiteTemplatesService } from './site-templates.service';

@Module({
  imports: [PermissionsModule, AuditLogsModule],
  controllers: [SiteTemplatesController],
  providers: [SiteTemplatesService],
  exports: [SiteTemplatesService],
})
export class SiteTemplatesModule {}
