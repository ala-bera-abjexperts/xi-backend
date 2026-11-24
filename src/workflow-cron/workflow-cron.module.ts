/**
 * @fileoverview NestJS module wiring the in-process cron dispatcher that
 * delivers the runtime for `cron` workflow triggers.
 *
 * `ScheduleModule.forRoot()` is imported so the service's `@Cron` decorator
 * registers (Nest dedupes the root registration in `app.module.ts`).
 * `WorkflowEngineModule` exports `WorkflowEngineService`, so the dispatcher
 * injects it directly — cron → engine has no cycle (the engine never imports
 * this module), so no forwardRef or DI token is needed. `SupabaseModule` is
 * `@Global`, so `SupabaseAdminService` is injectable without importing it.
 *
 * @module src/workflow-cron/workflow-cron.module
 * @author Rajbha Manek
 */

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';
import { WorkflowCronService } from './workflow-cron.service';

@Module({
  imports: [ScheduleModule.forRoot(), WorkflowEngineModule],
  providers: [WorkflowCronService],
})
export class WorkflowCronModule {}
