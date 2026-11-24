/**
 * @fileoverview NestJS module for risk configuration management.
 * @module src/risk-configuration/risk-configuration.module
 */

import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { RiskConfigurationController } from './risk-configuration.controller';
import { RiskConfigurationService } from './risk-configuration.service';

@Module({
  imports: [PermissionsModule, AuditLogsModule],
  controllers: [RiskConfigurationController],
  providers: [RiskConfigurationService],
  exports: [RiskConfigurationService],
})
export class RiskConfigurationModule {}
