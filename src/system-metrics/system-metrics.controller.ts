/**
 * @fileoverview Host CPU/RAM/disk for the Tenant Config "System Overview" tab. Owner/admin
 * only (RolesGuard + @RequireRoles), same as PlatformStatsController. Not on-prem-gated —
 * shown in both SaaS and on-prem, by explicit product decision: every tenant admin can see
 * this server's own resource usage.
 * @module src/system-metrics/system-metrics.controller
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireRoles } from '../auth/decorators/require-roles.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SystemMetricsService } from './system-metrics.service';
import type { ISystemMetrics } from './interfaces/system-metrics.interface';

@ApiTags('System Metrics')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@RequireRoles('owner', 'admin')
@ImpersonationBlocked()
@Controller('system-metrics')
export class SystemMetricsController {
  constructor(private readonly service: SystemMetricsService) {}

  @Get()
  @ApiOperation({
    summary: 'Current host CPU / RAM / disk usage for this server instance',
  })
  getMetrics(): Promise<ISystemMetrics> {
    return this.service.getMetrics();
  }
}
