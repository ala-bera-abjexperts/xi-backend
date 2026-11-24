/**
 * @fileoverview Standalone entrypoint for the workflow-cron worker process
 * (`pnpm dev:workflow-cron`). Boots {@link WorkflowCronWorkerModule} as a
 * headless application context (no HTTP listener), then stops every scheduled
 * job except the workflow-cron tick so this process runs ONLY the workflow
 * cron. The `@nestjs/schedule` timer keeps the event loop alive; SIGINT/SIGTERM
 * trigger a clean `app.close()`.
 *
 * The npm script sets `WORKFLOW_CRON_WORKER=1`, which flips the tick from its
 * main-API no-op (see `WorkflowCronService.tick`) into the active runtime here.
 *
 * @module src/workflow-cron/workflow-cron.worker
 */

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';

import { WorkflowCronWorkerModule } from './workflow-cron.worker.module';
import { WORKFLOW_CRON_JOB_NAME } from './workflow-cron.service';

async function bootstrapWorker(): Promise<void> {
  const logger = new Logger('WorkflowCronWorker');

  if (process.env.WORKFLOW_CRON_WORKER !== '1') {
    logger.warn(
      'WORKFLOW_CRON_WORKER is not "1" — the tick will no-op. Start via `pnpm dev:workflow-cron`.',
    );
  }

  const app = await NestFactory.createApplicationContext(
    WorkflowCronWorkerModule,
    { logger: console },
  );

  // Booting the workflow-cron graph also registers the outbox `@Cron` drain
  // (engine → outbox forwardRef). Stop every scheduled job except the
  // workflow-cron tick so this process runs ONLY the workflow cron; the main
  // API keeps owning the outbox drain (which is multi-process-safe anyway).
  const registry = app.get(SchedulerRegistry);
  let stopped = 0;

  for (const [name, job] of registry.getCronJobs()) {
    if (name !== WORKFLOW_CRON_JOB_NAME) {
      // `.stop()` is async in this `cron` version; fire-and-forget is fine —
      // the timer is cleared and any sub-ms outbox tick is SKIP-LOCKED-safe.
      void job.stop();
      stopped++;
    }
  }

  // Defensive: neutralize any interval/timeout riders too (none expected in
  // this graph today, but a future transitive dep could add one).
  for (const name of registry.getIntervals()) {
    registry.deleteInterval(name);
  }

  for (const name of registry.getTimeouts()) {
    registry.deleteTimeout(name);
  }

  logger.log(
    `workflow-cron worker started — running "${WORKFLOW_CRON_JOB_NAME}" only (stopped ${stopped} other scheduled job(s))`,
  );

  let closing = false;

  const shutdown = (signal: string): void => {
    if (closing) {
      return;
    }

    closing = true;
    logger.log(`received ${signal} — closing workflow-cron worker`);
    void app
      .close()
      .catch((e: unknown) =>
        logger.error(`error during shutdown: ${(e as Error).message}`),
      )
      .finally(() => process.exit(0));
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

void bootstrapWorker();
