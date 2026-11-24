/**
 * @fileoverview NestJS module for kanban/scrum boards.
 * @module src/boards/boards.module
 * @author Prince Jadiya
 */

import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { SavedFiltersModule } from '../saved-filters/saved-filters.module';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';
import { WorkflowAssignmentsModule } from '../workflow-assignments/workflow-assignments.module';
import { AutomationsModule } from '../automations/automations.module';
import { LicensingModule } from '../licensing/licensing.module';
import { BoardsService } from './boards.service';
import { BoardsController } from './boards.controller';

@Module({
  imports: [
    PermissionsModule,
    UsersModule,
    AuditLogsModule,
    SavedFiltersModule,
    WorkflowEngineModule,
    WorkflowAssignmentsModule,
    // For the automation outbox: a board drag on a task with no workflow assignment writes
    // status through the move_board_card RPC, which emits nothing on its own.
    AutomationsModule,
    LicensingModule,
  ],
  controllers: [BoardsController],
  providers: [BoardsService],
  exports: [BoardsService],
})
export class BoardsModule {}
