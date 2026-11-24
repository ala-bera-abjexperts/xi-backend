import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { SiteTemplatesModule } from '../templates/site-templates.module';
import { FunnelsController } from './funnels.controller';
import { FunnelsService } from './funnels.service';

@Module({
  imports: [PermissionsModule, AuditLogsModule, SiteTemplatesModule],
  controllers: [FunnelsController],
  providers: [FunnelsService],
  exports: [FunnelsService],
})
export class FunnelsModule {}
