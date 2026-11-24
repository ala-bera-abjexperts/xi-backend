/**
 * @fileoverview NestJS module for configurable task statuses.
 * @module src/task-statuses/task-statuses.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { TaskStatusesService } from './task-statuses.service';
import { TaskStatusesController } from './task-statuses.controller';

@Module({
  imports: [PermissionsModule, UsersModule, AuditLogsModule],
  controllers: [TaskStatusesController],
  providers: [TaskStatusesService],
  exports: [TaskStatusesService],
})
export class TaskStatusesModule {}
