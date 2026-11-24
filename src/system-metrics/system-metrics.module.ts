/**
 * @fileoverview System Metrics feature module — host CPU/RAM/disk for Tenant Config's
 * "System Overview" tab. Imported unconditionally (both SaaS and on-prem builds), gated
 * only by RolesGuard + @RequireRoles('owner', 'admin') on the controller.
 * @module src/system-metrics/system-metrics.module
 */
import { Module } from '@nestjs/common';
import { SystemMetricsController } from './system-metrics.controller';
import { SystemMetricsService } from './system-metrics.service';

@Module({
  controllers: [SystemMetricsController],
  providers: [SystemMetricsService],
})
export class SystemMetricsModule {}
