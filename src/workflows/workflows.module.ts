/**
 * @fileoverview NestJS module for workflows.
 * @module src/workflows/workflows.module
 * @author Rajbha Manek
 */
import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { UsersModule } from '../users/users.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { WorkflowHealthModule } from '../workflow-health/workflow-health.module';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';
import { WorkflowsService } from './workflows.service';
import { WorkflowsImportExportService } from './workflows-import-export.service';
import { WorkflowsController } from './workflows.controller';

@Module({
  imports: [
    PermissionsModule,
    UsersModule,
    AuditLogsModule,
    WorkflowHealthModule,
    // For HandlerRegistryService (findReferences) used by import/export.
    WorkflowEngineModule,
  ],
  controllers: [WorkflowsController],
  providers: [WorkflowsService, WorkflowsImportExportService],
  exports: [WorkflowsService],
})
export class WorkflowsModule {}
