/**
 * @fileoverview Root module for the standalone workflow-cron worker process
 * (`pnpm dev:workflow-cron`). It boots ONLY the workflow-cron graph — not the
 * HTTP app — so the worker is small and starts fast.
 *
 * `WorkflowCronModule` transitively pulls `WorkflowEngineModule` (which needs
 * the `@Global` `SupabaseModule`, `EventEmitterModule.forRoot()`, and
 * `ScheduleModule.forRoot()` — all provided within that graph) plus, via a
 * forwardRef, `WorkflowOutboxModule`. The outbox module carries its own `@Cron`
 * drain, so booting this graph registers TWO scheduled jobs; the worker
 * entrypoint stops every job except the workflow-cron tick so this process runs
 * only the workflow cron (the main API keeps owning the outbox drain, which is
 * multi-process-safe via `FOR UPDATE SKIP LOCKED` regardless).
 *
 * `ConfigModule.forRoot` is re-declared here (mirroring `app.module.ts`) because
 * many services in the engine/outbox graph inject `ConfigService`; the worker is
 * not booted from `AppModule`, so it must load + validate env itself.
 *
 * @module src/workflow-cron/workflow-cron.worker.module
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import configuration from '../config/configuration';
import { validateEnv } from '../config/env.validation';
import { WorkflowCronModule } from './workflow-cron.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    WorkflowCronModule,
  ],
})
export class WorkflowCronWorkerModule {}
