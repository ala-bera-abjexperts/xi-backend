/**
 * @fileoverview NestJS module for configurable task priorities.
 * @module src/task-priorities/task-priorities.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { TaskPrioritiesService } from './task-priorities.service';
import { TaskPrioritiesController } from './task-priorities.controller';

@Module({
  imports: [PermissionsModule, UsersModule, AuditLogsModule],
  controllers: [TaskPrioritiesController],
  providers: [TaskPrioritiesService],
  exports: [TaskPrioritiesService],
})
export class TaskPrioritiesModule {}
