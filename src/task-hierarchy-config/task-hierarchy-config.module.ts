/**
 * @fileoverview NestJS module for the task hierarchy config feature.
 * @module src/task-hierarchy-config/task-hierarchy-config.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { OrganizationModulesModule } from '../organization-modules/organization-modules.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { TaskHierarchyConfigService } from './task-hierarchy-config.service';
import { TaskHierarchyConfigController } from './task-hierarchy-config.controller';

@Module({
  imports: [PermissionsModule, UsersModule, OrganizationModulesModule],
  controllers: [TaskHierarchyConfigController],
  providers: [TaskHierarchyConfigService],
  exports: [TaskHierarchyConfigService],
})
export class TaskHierarchyConfigModule {}
