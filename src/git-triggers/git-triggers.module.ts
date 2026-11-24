/**
 * @fileoverview NestJS module for the `git_branch_created` workflow trigger
 * webhook. Wires the public {@link GitTriggersController} and its
 * {@link GitTriggersService}. The engine runtime is consumed via the
 * {@link WORKFLOW_ENGINE_SERVICE} DI token (`@Optional()` in the service);
 * `WorkflowEngineModule` is imported via `forwardRef` to resolve the circular
 * dependency at runtime. This module MUST be registered in `app.module.ts`.
 * @module src/git-triggers/git-triggers.module
 * @author Ala Bera
 */

import { forwardRef, Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';
import { GitTriggersController } from './git-triggers.controller';
import { GitTriggersService } from './git-triggers.service';

@Module({
  imports: [SupabaseModule, forwardRef(() => WorkflowEngineModule)],
  controllers: [GitTriggersController],
  providers: [GitTriggersService],
  exports: [GitTriggersService],
})
export class GitTriggersModule {}
