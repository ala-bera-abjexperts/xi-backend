/**
 * @fileoverview NestJS module for the process/risk hierarchy config feature.
 * @module src/hierarchy-config/hierarchy-config.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { HierarchyConfigService } from './hierarchy-config.service';
import { HierarchyConfigController } from './hierarchy-config.controller';

@Module({
  imports: [PermissionsModule, UsersModule],
  controllers: [HierarchyConfigController],
  providers: [HierarchyConfigService],
  exports: [HierarchyConfigService],
})
export class HierarchyConfigModule {}
