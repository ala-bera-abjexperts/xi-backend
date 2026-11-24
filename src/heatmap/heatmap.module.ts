/**
 * @fileoverview NestJS module for heatmap configuration and data generation.
 * @module src/heatmap/heatmap.module
 */

import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import {
  HeatmapController,
  LegacyDashboardHeatmapController,
} from './heatmap.controller';
import { HeatmapService } from './heatmap.service';

@Module({
  imports: [PermissionsModule],
  controllers: [HeatmapController, LegacyDashboardHeatmapController],
  providers: [HeatmapService],
  exports: [HeatmapService],
})
export class HeatmapModule {}
