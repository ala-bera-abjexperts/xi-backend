/**
 * @fileoverview On-prem Server configuration module. Imported by AppModule ONLY when
 * IS_ON_PREMISE is truthy, so its routes do not exist in the SaaS build. Reuses the
 * updater sidecar client and OnPremGuard from OnPremUpdatesModule.
 * @module src/on-prem-config/on-prem-config.module
 */
import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { OnPremUpdatesModule } from '../on-prem-updates/on-prem-updates.module';
import { OnPremConfigController } from './on-prem-config.controller';
import { OnPremConfigService } from './on-prem-config.service';

@Module({
  imports: [AuditLogsModule, OnPremUpdatesModule],
  controllers: [OnPremConfigController],
  providers: [OnPremConfigService],
})
export class OnPremConfigModule {}
