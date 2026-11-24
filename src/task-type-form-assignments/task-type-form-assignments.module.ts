/**
 * @fileoverview NestJS module for task-type form assignments.
 * @module src/task-type-form-assignments/task-type-form-assignments.module
 */
import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { TaskTypeFormAssignmentsService } from './task-type-form-assignments.service';
import { TaskTypeFormAssignmentsController } from './task-type-form-assignments.controller';

@Module({
  imports: [PermissionsModule],
  controllers: [TaskTypeFormAssignmentsController],
  providers: [TaskTypeFormAssignmentsService],
  exports: [TaskTypeFormAssignmentsService],
})
export class TaskTypeFormAssignmentsModule {}
