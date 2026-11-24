import 'reflect-metadata';
import { hostname } from 'os';

import { Logger, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';

import { AttachmentsService } from '../attachments/attachments.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../test-management/access/test-management-access.service';
import { runnerEnabled } from '../test-management/automation/automation-inputs';
import { TestAutomationGitService } from '../test-management/automation/test-automation-git.service';
import { CustomImageApprovalService } from '../test-management/automation/custom-images/approval/service/custom-image-approval.service';
import { userImageRegistries } from '../test-management/automation/custom-images/registry/custom-image-review';
import { imageUploadsEnabled } from '../test-management/automation/custom-images/shared/inputs/custom-image-inputs';
import { TestExecutionsService } from '../test-management/executions/test-executions.service';
import { TestPlanTestsService } from '../test-management/plans/test-plan-tests.service';
import { TestRunsService } from '../test-management/runs/test-runs.service';
import { CucumberResultsService } from '../test-management/transfer/cucumber-results/cucumber-results.service';
import { CustomImageDocker } from './custom-images/docker/custom-image-docker';
import { CustomImageReviewer } from './custom-images/review/reviewer/custom-image-reviewer';
import { DockerDriver } from './docker-driver';
import { readIdleStopMs, RunnerHeartbeat } from './runner.heartbeat';
import { POLL_MS, readSlots, RunnerLoop } from './runner.loop';
import { RunnerService } from './runner.service';
import { hasEnoughDisk, RunnerSweep } from './runner.sweep';
import { RunnerWorkerModule } from './runner.worker.module';

const SWEEP_MS = 60_000;

/** Loading Test Management brings other features' background jobs along; the API owns those, so they stop here. */
function stopOtherJobs(app: INestApplicationContext): void {
  const registry = app.get(SchedulerRegistry);

  for (const job of registry.getCronJobs().values()) void job.stop();
  for (const name of registry.getIntervals()) registry.deleteInterval(name);
  for (const name of registry.getTimeouts()) registry.deleteTimeout(name);
}

function buildRunner(
  app: INestApplicationContext,
  docker: DockerDriver,
): RunnerService {
  const get = { strict: false };

  return new RunnerService(
    app.get(SupabaseAdminService, get),
    app.get(TestManagementAccessService, get),
    app.get(PermissionsService, get),
    app.get(CucumberResultsService, get),
    app.get(AttachmentsService, get),
    docker,
    app.get(TestExecutionsService, get),
    app.get(TestRunsService, get),
    app.get(TestPlanTestsService, get),
    app.get(TestAutomationGitService, get),
  );
}

async function bootstrapWorker(): Promise<void> {
  const logger = new Logger('TestRunnerWorker');

  if (process.env.TM_RUNNER_WORKER !== '1' || !runnerEnabled()) {
    logger.error(
      'Start with TM_RUNNER_WORKER=1 and TM_RUNNER_ENABLED=1 (pnpm dev:tm-runner). Nothing was started.',
    );
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(RunnerWorkerModule, {
    logger: console,
  });

  stopOtherJobs(app);

  // Tests write as uid 1000, and another user could not remove their files afterwards.
  if (process.platform === 'linux' && process.getuid?.() !== 1000) {
    logger.warn(
      'The test runner should run as uid 1000, or it may not be able to remove the files of a run',
    );
  }

  const docker = new DockerDriver();
  const sweep = new RunnerSweep(
    docker,
    app.get(SupabaseAdminService, { strict: false }),
  );

  // A hung Docker must not hold up the start.
  void sweep.run();

  // Users' own images are checked only when the server allows registries for them.
  const reviewer =
    userImageRegistries().length > 0 || imageUploadsEnabled()
      ? new CustomImageReviewer(
          new CustomImageDocker(),
          app.get(SupabaseAdminService, { strict: false }),
          undefined,
          (image) =>
            app
              .get(CustomImageApprovalService, { strict: false })
              .notifyPending(image.organization_id, image.id),
          app.get(AuditLogsService, { strict: false }),
        )
      : null;

  const sweepTimer = setInterval(() => {
    void sweep.run();
    void reviewer?.cleanUp();
  }, SWEEP_MS);
  const slots = readSlots();
  const workerId = `${hostname().slice(0, 60)}-${process.pid}`;
  let ready = false;
  const checkReady = async (): Promise<boolean> => {
    ready = (await hasEnoughDisk()) && (await docker.isAvailable());

    return ready;
  };
  const loop = new RunnerLoop(
    buildRunner(app, docker),
    workerId,
    slots,
    POLL_MS,
    checkReady,
  );
  // One check at a time beside the run slots, so tests keep running while an image is checked.
  const reviewLoop = reviewer
    ? new RunnerLoop(
        reviewer,
        `${workerId}-review`,
        1,
        POLL_MS,
        async () => (await hasEnoughDisk()) && (await docker.isAvailable()),
      )
    : null;

  logger.log(`Test runner started with ${slots} slot(s)`);

  if (reviewLoop) logger.log('Image checks are on');

  let signals = 0;

  const shutdown = (signal: string): void => {
    signals += 1;

    // A second signal gives up on the running test; the reaper closes that run and the sweep removes its containers.
    if (signals > 1) process.exit(1);

    logger.log(
      `Received ${signal}: finishing the current run, then stopping. Send it again to stop now.`,
    );
    loop.stop();
    reviewLoop?.stop();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Shows this runner in the app; an admin stop or the idle time ends it like a first Ctrl+C.
  const heartbeat = new RunnerHeartbeat(
    app.get(SupabaseAdminService, { strict: false }),
    workerId,
    slots,
    () => ready,
    readIdleStopMs(),
    shutdown,
  );

  // The first report already says whether Docker and the disk can take a run.
  await checkReady();
  heartbeat.start();

  // Both loops finish what they hold before the worker exits.
  const reviewing = reviewLoop?.run();

  await loop.run();
  await reviewing;
  await heartbeat.stop();
  clearInterval(sweepTimer);
  await app.close();
  process.exit(0);
}

void bootstrapWorker();
