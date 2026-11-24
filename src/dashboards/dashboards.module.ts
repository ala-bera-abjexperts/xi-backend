/**
 * @fileoverview NestJS module for the dashboards feature — CRUD, widgets,
 * permissions, widget data, and analytics.
 * @module src/dashboards/dashboards.module
 */

import { SlaReportController } from '../sla/sla-report.controller';
import { SlaModule } from '../sla/sla.module';
import { SlaReportService } from '../sla/sla-report.service';
import { Module } from '@nestjs/common';
import { DashboardsController } from './dashboards.controller';
import { DashboardsService } from './dashboards.service';
import { SavedFiltersModule } from '../saved-filters/saved-filters.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { HeatmapModule } from '../heatmap/heatmap.module';
import { ResourcePlanningModule } from '../resource-planning/resource-planning.module';
import { LicensingModule } from '../licensing/licensing.module';
import { SprintsModule } from '../sprints/sprints.module';

@Module({
  imports: [
    SlaModule,
    SavedFiltersModule,
    PermissionsModule,
    HeatmapModule,
    ResourcePlanningModule,
    LicensingModule,
    SprintsModule,
  ],
  controllers: [DashboardsController, SlaReportController],
  providers: [DashboardsService, SlaReportService],
  exports: [DashboardsService],
})
export class DashboardsModule {}
