/**
 * @fileoverview NestJS module for workflow assignments.
 * @module src/workflow-assignments/workflow-assignments.module
 * @author Rajbha Manek
 */
import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { WorkflowAssignmentsService } from './workflow-assignments.service';
import { WorkflowAssignmentsController } from './workflow-assignments.controller';

@Module({
  imports: [PermissionsModule, UsersModule, AuditLogsModule],
  controllers: [WorkflowAssignmentsController],
  providers: [WorkflowAssignmentsService],
  exports: [WorkflowAssignmentsService],
})
export class WorkflowAssignmentsModule {}
