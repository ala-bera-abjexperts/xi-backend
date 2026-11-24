/**
 * @fileoverview NestJS module for risk calculations and cache management.
 * @module src/calculations/calculations.module
 */

import { Module } from '@nestjs/common';
import { AutomationsModule } from '../automations/automations.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { CalculationsController } from './calculations.controller';
import { CalculationsService } from './calculations.service';

@Module({
  imports: [AutomationsModule, PermissionsModule],
  controllers: [CalculationsController],
  providers: [CalculationsService],
  exports: [CalculationsService],
})
export class CalculationsModule {}
