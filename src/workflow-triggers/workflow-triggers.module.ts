/**
 * @fileoverview NestJS module for inbound workflow trigger webhooks.
 *
 * Wires the public {@link WorkflowTriggersController} and its
 * {@link WorkflowTriggersService}. The engine runtime is consumed via the
 * {@link WORKFLOW_ENGINE_SERVICE} DI token (see workflow-engine.contract.ts)
 * with `@Optional()` injection — so the module boots cleanly even before
 * Phase B's engine service lands.
 *
 * `WorkflowEngineModule` is imported via `forwardRef` so that when Phase B
 * starts importing trigger types from this module (e.g. an event-bus listener)
 * the circular-dep is resolved at runtime rather than at module-graph build.
 *
 * NOTE: this module is intentionally NOT registered in `app.module.ts`. The
 * orchestrator registers `WorkflowTriggersModule` in a later phase.
 *
 * @module src/workflow-triggers/workflow-triggers.module
 * @author Rajbha Manek
 */

import { forwardRef, Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';
import { WorkflowTriggersController } from './workflow-triggers.controller';
import { WorkflowTriggersService } from './workflow-triggers.service';

@Module({
  imports: [SupabaseModule, forwardRef(() => WorkflowEngineModule)],
  controllers: [WorkflowTriggersController],
  providers: [WorkflowTriggersService],
  exports: [WorkflowTriggersService],
})
export class WorkflowTriggersModule {}
