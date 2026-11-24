/**
 * @fileoverview NestJS module for the workflow health linter.
 * @module src/workflow-health/workflow-health.module
 * @author Rajbha Manek
 */
import { Module } from '@nestjs/common';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';
import { WorkflowHealthService } from './workflow-health.service';

@Module({
  // WorkflowEngineModule exports HandlerRegistryService (for collectReferences).
  // SupabaseAdminService comes from the @Global SupabaseModule.
  imports: [WorkflowEngineModule],
  providers: [WorkflowHealthService],
  exports: [WorkflowHealthService],
})
export class WorkflowHealthModule {}
