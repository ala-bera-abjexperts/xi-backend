/**
 * @fileoverview NestJS module for workflow-transitions.
 * @module src/workflow-transitions/workflow-transitions.module
 * @author Rajbha Manek
 */

import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { SupabaseModule } from '../supabase/supabase.module';
import { UsersModule } from '../users/users.module';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';
import { WorkflowTransitionsController } from './workflow-transitions.controller';
import { WorkflowTransitionsService } from './workflow-transitions.service';

@Module({
  imports: [
    WorkflowEngineModule,
    SupabaseModule,
    AuditLogsModule,
    PermissionsModule,
    UsersModule,
  ],
  controllers: [WorkflowTransitionsController],
  providers: [WorkflowTransitionsService],
  exports: [WorkflowTransitionsService],
})
export class WorkflowTransitionsModule {}
