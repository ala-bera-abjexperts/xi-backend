import { chmod, lstat, mkdir, readdir, realpath, writeFile } from 'fs/promises';
import { lookup as dnsLookup } from 'dns/promises';
import { join } from 'path';

import { HttpException, Injectable, Logger } from '@nestjs/common';

import { AttachmentsService } from '../attachments/attachments.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { isBlockedAddress } from '../common/security/ssrf-guard';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../test-management/access/test-management-access.service';
import {
  availableRunnerImages,
  cleanProjectPath,
  HOST_PATTERN,
  isBuiltInRunnerImage,
  specFilesIn,
  type AutomationPreset,
  type RunnerImage,
  type RunPreset,
} from '../test-management/automation/automation-inputs';
import {
  AUTOMATION_BUCKET,
  readSecretMap,
} from '../test-management/automation/test-automation-configs.service';
import { OWN_IMAGE_KEY } from '../test-management/automation/custom-images/shared/inputs/custom-image-inputs';
import type {
  GitRepositoryMatch,
  TestAutomationGitService,
} from '../test-management/automation/test-automation-git.service';
import type {
  JunitCommitResult,
  JunitStatus,
} from '../test-management/dto/test-transfer.dto';
import { TestExecutionsService } from '../test-management/executions/test-executions.service';
import { TestPlanTestsService } from '../test-management/plans/test-plan-tests.service';
import { TestRunsService } from '../test-management/runs/test-runs.service';
import { CucumberResultsService } from '../test-management/transfer/cucumber-results/cucumber-results.service';
import {
  parseResultFile,
  parseXml,
} from '../test-management/transfer/cucumber-results/junit.parser';
import {
  collectResults,
  matches,
  readRegularFile,
  snapshotResults,
  type CollectedResult,
  type ResultProblem,
} from './collect-results';
import {
  customImageForRun,
  customImageRuntime,
} from './custom-images/run/custom-image-run';
import {
  BUILT_IN_PROXY_IMAGE,
  DockerCommandError,
  DockerDriver,
  type DockerResult,
  PROXY_PORT,
  type RunTestsOptions,
  networkName,
  proxyConfig,
  proxyFilter,
} from './docker-driver';
import {
  detectFramework,
  PACKAGE_JSON_BYTES,
  type DetectedFramework,
} from './detect-framework';
import { LIVE_LOG_BYTES, LiveLog, MarkerWatch } from './live-log';
import { capLog, lastLines, maskSecrets, maskXmlSecrets } from './mask-log';
import {
  GIT_AUTO_HOSTS,
  MAVEN_AUTO_RESULT_PATHS,
  presetRun,
  RUNNER_PRESETS,
  TESTS_START_LINE,
  TESTS_START_MARKER,
  type PresetRun,
} from './presets';
import {
  folderBytes,
  readMaxDiskMb,
  removeFolder,
  runnerWorkDir,
} from './runner.sweep';
import { readRunningPerOrg } from './runner.loop';
import { safeUnzip, UnzipError } from './safe-unzip';

export const LEASE_SECONDS = 60;
export const HEARTBEAT_MS = 15_000;

// How often the output of running tests is saved for the logs screen.
export const LIVE_LOG_MS = 1_000;
const GIVE_UP_MS = 60_000;
const SAVE_ATTEMPTS = 3;
const SAVE_RETRY_MS = 1_000;

// The run's end is saved after these, so neither can hold the slot for long.
const CLEANUP_LIMIT_MS = 60_000;
const STOP_GRACE_MS = 5_000;
const STORAGE_LIMIT_MS = 15 * 60_000;

const DISK_CHECK_MS = 15_000;
const MAX_LISTED_TESTS = 500;
const MAX_TEST_NAME_LENGTH = 200;

// The same cap the results upload keeps on the names it reports.
const DROPPED_NAMES = 50;

// The attachment limit; a longer trace is left out and the run says so.
const MAX_TRACE_BYTES = 25 * 1024 * 1024;
const MAX_ERROR_LENGTH = 2000;
const DOCKER_START_FAILED = 125;
const GIT_TOKEN = 'GIT_TOKEN';
const DEFAULT_GIT_IMAGE =
  'alpine/git@sha256:e8ceedc73bd80992ae8d58a7d24c58b8322146c354f1d2e81a97db4452068ec0';
const DEFAULT_PROXY_IMAGE = BUILT_IN_PROXY_IMAGE;
const VERSION_MISMATCH =
  /Executable doesn't exist at|Please run the following command to download new browsers/;
const IMAGE_NOT_FOUND = /Unable to find image|No such image|pull access denied/;

// Detection reads only names; a huge clone stops being listed here.
const DETECT_ENTRIES = 5000;

// A test's own local servers stay off the proxy once Node's fetch uses it.
const LOCAL_NO_PROXY = 'localhost,127.0.0.1,::1';

// Tests read the address of the app they test from these, so their hosts are opened for the run.
const APP_URL_VARIABLES = ['BASE_URL', 'API_URL'];

const UNSUPPORTED_NAMES: Record<'pytest' | 'gradle', string> = {
  pytest: 'Python',
  gradle: 'Gradle',
};

interface RunSnapshot {
  name: string;
  preset: AutomationPreset;
  image_key: string;
  source: 'git' | 'zip';
  repo_url: string | null;
  repo_ref: string | null;
  work_dir: string | null;
  command: string | null;
  result_paths: string[];
  env: Record<string, string>;
  allowed_hosts: string[];
  create_unmatched: boolean;
  timeout_minutes: number;
  trace_mode: 'off' | 'on_failure';
  // Absent from runs queued before these existed.
  install_command?: string | null;
  spec_files?: string[];
  // Only for a setting that uses the user's own image.
  user_image_id?: string | null;
  run_ref?: string | null;
  platform?: string | null;
}

/** What a lease function answers. */
interface LeaseAnswer {
  data: LeasedRun[] | null;
  error: { message: string; code?: string } | null;
}

/** A run as the lease function hands it over. */
export interface LeasedRun {
  id: string;
  organization_id: string;
  space_id: string;
  config_id: string | null;
  target: 'plan' | 'execution';
  plan_id: string | null;
  execution_id: string | null;
  started_by: string | null;
  run_zip_path: string | null;
  config_snapshot: RunSnapshot;
  // What the API saved when the run was queued.
  result_summary?: Record<string, unknown> | null;
}

type RunStage =
  | 'preparing'
  | 'installing'
  | 'running'
  | 'saving'
  | 'cleaning_up';

type Finish = {
  status: 'DONE' | 'ERROR' | 'CANCELLED';
  outcome?: 'passed' | 'failed_tests';
  errorCode?: string;
  errorMessage?: string;
  exitCode?: number;
};

/** Ends a run at the step that found the problem. */
class RunStop extends Error {
  constructor(
    readonly status: 'ERROR' | 'CANCELLED',
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

const failed = (code: string, message: string) =>
  new RunStop('ERROR', code, message);
const cancelled = (code: string | undefined, message: string) =>
  new RunStop('CANCELLED', code, message);
const diskLimit = () =>
  failed('DISK_LIMIT', 'The run wrote more files than this runner allows');
const imageMissing = () =>
  failed('IMAGE_MISSING', 'A test image is not built on the runner machine');
const proxyImageMissing = () =>
  failed(
    'IMAGE_MISSING',
    'The network proxy image is not built on the runner machine',
  );
const PROXY_START_STEP = 'start the proxy';

const LISTED_STATUS: Record<JunitStatus, 'passed' | 'failed' | 'skipped'> = {
  PASS: 'passed',
  FAIL: 'failed',
  BLOCKED: 'failed',
  SKIPPED: 'skipped',
};

/** What one run has gathered so far; the heartbeat and the steps share it. */
interface RunContext {
  run: LeasedRun;
  workerId: string;
  user: RequestUser;
  secrets: string[];
  log: string[];
  summary: Record<string, unknown>;
  executionId: string | null;
  cancelRequested: boolean;
  timedOut: boolean;
  leaseLost: boolean;
  diskFull: boolean;
  measuring: boolean;
  // Set when the final save starts; a heartbeat still on its way must not act on what it sees.
  closing: boolean;
  folder: string | null;
  // The latest masked output; every progress write carries it, or the screen would blank.
  liveText: string | null;
  // One at a time, so an older write can't land after a newer one.
  summaryWrites: Promise<void>;
  abort: AbortController;
  giveUp?: NodeJS.Timeout;
  // The setting's preset, or the detected one once an auto run knows it.
  preset: RunPreset;
}

/** Runs one leased run from start to finish. It always cleans up after itself and never retries by itself. */
@Injectable()
export class RunnerService {
  private readonly logger = new Logger(RunnerService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly permissions: PermissionsService,
    private readonly results: CucumberResultsService,
    private readonly attachments: AttachmentsService,
    private readonly docker: DockerDriver,
    private readonly executions: TestExecutionsService,
    private readonly runs: TestRunsService,
    private readonly planTests: TestPlanTestsService,
    private readonly git?: TestAutomationGitService,
  ) {}

  // Set once the database answers that the fair pick is not applied yet.
  private fairPickMissing = false;

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Takes the next waiting run in fair order, if any. Answers whether there was one. */
  async processNext(workerId: string): Promise<boolean> {
    const { data, error } = await this.lease(workerId);

    if (error) {
      this.logger.error('Failed to take a waiting run', error);

      return false;
    }

    const run = data?.[0];

    if (!run) return false;

    await this.execute(run, workerId);

    return true;
  }

  /** Fair pick when the database has it; the old one-per-organisation pick until it is applied. */
  private async lease(workerId: string): Promise<LeaseAnswer> {
    if (!this.fairPickMissing) {
      const fair = (await this.client.rpc('tm_lease_automation_run_fair', {
        p_worker_id: workerId,
        p_lease_seconds: LEASE_SECONDS,
        p_max_per_org: readRunningPerOrg(),
      })) as LeaseAnswer;
      const code = fair.error?.code;

      if (
        code !== 'PGRST202' &&
        code !== '42883' &&
        !/does not exist/i.test(fair.error?.message ?? '')
      ) {
        return fair;
      }

      this.fairPickMissing = true;
      this.logger.warn(
        'Fair pick is not in the database yet; using one run per organisation until it is applied',
      );
    }

    return (await this.client.rpc('tm_lease_automation_run', {
      p_worker_id: workerId,
      p_lease_seconds: LEASE_SECONDS,
    })) as LeaseAnswer;
  }

  async execute(run: LeasedRun, workerId: string): Promise<void> {
    const context: RunContext = {
      run,
      workerId,
      user: {
        userId: run.started_by ?? '',
        organizationId: run.organization_id,
        authUserId: '',
        email: '',
        memberships: [],
      } as unknown as RequestUser,
      secrets: [],
      log: [],
      summary: { ...run.result_summary },
      executionId: run.execution_id,
      cancelRequested: false,
      timedOut: false,
      leaseLost: false,
      diskFull: false,
      measuring: false,
      closing: false,
      folder: null,
      liveText: null,
      summaryWrites: Promise.resolve(),
      abort: new AbortController(),
      preset: run.config_snapshot.preset,
    };
    const heartbeat = setInterval(() => void this.beat(context), HEARTBEAT_MS);
    const timeout = setTimeout(() => {
      context.timedOut = true;
      void this.stopContainers(run.id);
      this.giveUpSoon(context);
    }, run.config_snapshot.timeout_minutes * 60_000);
    let finish: Finish;

    try {
      finish = await this.perform(context);
    } catch (error) {
      finish = this.finishFromError(context, error);
    } finally {
      clearTimeout(timeout);
      clearTimeout(context.giveUp);
    }

    // The heartbeat keeps going until the save, so the slow steps don't lose the lease and the save still finds its row.
    try {
      try {
        await this.attachOutput(context, finish);
      } catch (error) {
        this.logger.warn(
          `Output of run ${run.id} was not kept: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await this.cleanUpInTime(context);
      }

      await this.save(context, finish);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(context.giveUp);
    }
  }

  /** The final save replaces the live text, because the whole log is kept as a file by then. */
  private async runTestsWithLiveLog(
    context: RunContext,
    options: RunTestsOptions,
  ): Promise<DockerResult> {
    const live = new LiveLog(TESTS_START_LINE);
    const testsStart = new MarkerWatch(TESTS_START_MARKER);
    const timer = setInterval(
      () => void this.publishLiveLog(context, live),
      LIVE_LOG_MS,
    );

    try {
      return await this.docker.runTests({
        ...options,
        onOutput: (chunk) => {
          live.add(chunk);

          if (testsStart.add(chunk)) void this.setStage(context, 'running');
        },
      });
    } finally {
      clearInterval(timer);
      await this.publishLiveLog(context, live);
      await context.summaryWrites;
    }
  }

  /** Showing the output must never be able to stop a run. */
  private async publishLiveLog(
    context: RunContext,
    live: LiveLog,
  ): Promise<void> {
    const text = live.take(context.secrets);

    if (text === null) return;

    context.liveText = text;
    await this.writeSummary(context);
  }

  private setStage(context: RunContext, stage: RunStage): Promise<void> {
    context.summary.stage = stage;

    return this.writeSummary(context);
  }

  private writeSummary(context: RunContext): Promise<void> {
    context.summaryWrites = context.summaryWrites.then(() =>
      this.sendSummary(context),
    );

    return context.summaryWrites;
  }

  /** Built when it is sent, so it holds the latest. Conditional, so it can't touch a run that was already saved. */
  private async sendSummary(context: RunContext): Promise<void> {
    try {
      const { error } = await this.client
        .from('test_automation_runs')
        .update({ result_summary: progressSummary(context) })
        .eq('id', context.run.id)
        .eq('worker_id', context.workerId)
        .in('status', ['RUNNING', 'UPLOADING']);

      if (error) throw new Error(error.message);
    } catch (error) {
      this.logger.warn(
        `Progress of run ${context.run.id} was not saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async perform(context: RunContext): Promise<Finish> {
    const disk = setInterval(() => void this.checkDisk(context), DISK_CHECK_MS);
    let tests: { code: number; files: CollectedResult[] };

    try {
      tests = await untilStopped(this.runTests(context), context.abort.signal);
    } finally {
      clearInterval(disk);
    }

    // Results are being recorded from here, so a stop doesn't abandon this step; it has its own limit.
    await withinLimit(
      this.upload(context, tests.files, tests.code),
      STORAGE_LIMIT_MS,
      () =>
        failed('IMPORT_FAILED', 'Saving the results took longer than allowed'),
    );

    // The limit can pass during the upload; what was recorded stays recorded.
    if (context.timedOut) {
      throw failed('TIMEOUT', 'The run took longer than its time limit');
    }

    return {
      status: 'DONE',
      outcome: tests.code === 0 ? 'passed' : 'failed_tests',
      exitCode: tests.code,
    };
  }

  /** Measured on its own timer, so a huge folder can't delay the heartbeat. */
  private async checkDisk(context: RunContext): Promise<void> {
    if (context.measuring || !context.folder) return;

    context.measuring = true;

    try {
      const limit = readMaxDiskMb() * 1024 * 1024;

      if ((await folderBytes(context.folder, limit)) > limit) {
        context.diskFull = true;
        this.giveUpSoon(context);
        await this.stopContainers(context.run.id);
      }
    } finally {
      context.measuring = false;
    }
  }

  private async runTests(
    context: RunContext,
  ): Promise<{ code: number; files: CollectedResult[] }> {
    const { run } = context;
    const snapshot = run.config_snapshot;

    await this.setStage(context, 'preparing');
    await this.assertAllowed(context);

    const secrets = await this.readSecrets(run);
    const { [GIT_TOKEN]: gitToken, ...testSecrets } = secrets;
    // What the test container gets; a secret wins over a variable of the same name.
    const testEnv = { ...snapshot.env, ...testSecrets };

    context.secrets = Object.values(secrets);

    // A user's own image is checked again before each run instead of coming from the server's images.
    const own =
      snapshot.preset !== 'auto' && snapshot.image_key === OWN_IMAGE_KEY
        ? await customImageForRun(this.client, run, context.abort.signal)
        : null;

    if (own && 'code' in own) throw failed(own.code, own.message);

    // An auto run knows its framework and image only once its code is here.
    let chosen =
      snapshot.preset === 'auto'
        ? null
        : this.choose(
            snapshot,
            snapshot.preset,
            snapshot.image_key,
            own?.image,
          );
    const folder = await this.prepareFolder(context);

    // Docker errors can name this folder, and the machine's paths stay private.
    context.secrets.push(folder);

    // A zip needs no network to arrive, so an auto zip run opens the network for its detected framework only.
    const detectFirst = !chosen && snapshot.source === 'zip';

    if (detectFirst) {
      await this.fetchCode(
        context,
        join(folder, 'project'),
        join(folder, 'env'),
        gitToken,
      );
      this.assertStillWanted(context);

      chosen = await this.chooseDetected(context, join(folder, 'project'));
    }

    const appHostsOpen = await this.startNetwork(
      context,
      folder,
      chosen?.preset ?? { hosts: GIT_AUTO_HOSTS },
      testEnv,
    );
    this.assertStillWanted(context);

    if (!detectFirst) {
      await this.fetchCode(
        context,
        join(folder, 'project'),
        join(folder, 'env'),
        gitToken,
      );
      this.assertStillWanted(context);
    }

    chosen ??= await this.chooseDetected(context, join(folder, 'project'));

    const { image, preset } = chosen;

    if (preset.reporter) {
      await this.addReporter(join(folder, 'project'), preset.reporter);
    }

    const resultPaths = preset.resultPaths ?? snapshot.result_paths;
    const before = await snapshotResults(
      join(folder, 'project'),
      snapshot.work_dir,
      resultPaths,
    );

    await this.setStage(
      context,
      RUNNER_PRESETS[context.preset].install || snapshot.install_command?.trim()
        ? 'installing'
        : 'running',
    );

    const result = await this.runTestsWithLiveLog(context, {
      runId: run.id,
      image: image.image,
      runFolder: join(folder, 'project'),
      envFolder: join(folder, 'env'),
      signal: context.abort.signal,
      workDir: snapshot.work_dir,
      command: preset.command,
      env: {
        ...testEnv,
        // Node's fetch ignores the proxy variables without it.
        ...(appHostsOpen
          ? { NODE_USE_ENV_PROXY: '1', NO_PROXY: LOCAL_NO_PROXY }
          : {}),
        ...preset.env,
        ...this.jvmProxyOptions(run.id, snapshot.env, preset),
      },
      ...(preset.args ? { args: preset.args } : {}),
      ...(own ? { userImage: true, runtime: customImageRuntime() } : {}),
    });

    context.log.push(result.output.split(TESTS_START_LINE).join(''));
    context.summary.exit_code = result.code;

    this.assertStillWanted(context);

    if (result.code === DOCKER_START_FAILED) {
      if (
        isBuiltInRunnerImage(image.image) &&
        IMAGE_NOT_FOUND.test(result.output)
      ) {
        throw imageMissing();
      }

      throw failed('START_FAILED', 'The test container could not be started');
    }

    if (VERSION_MISMATCH.test(result.output)) {
      this.addWarning(context, 'BROWSER_VERSION_MISMATCH');
    }

    const { files, problems } = await collectResults(
      join(folder, 'project'),
      snapshot.work_dir,
      resultPaths,
      run.id,
      before,
    );

    this.noteProblems(context, problems);

    if (files.length === 0) {
      throw failed(
        'RESULTS_MISSING',
        'The tests finished but wrote no result file',
      );
    }

    await this.moveToUploading(context);
    await this.assertAllowed(context);

    return { code: result.code, files };
  }

  /** The allowed image and the command of one preset. */
  private choose(
    snapshot: RunSnapshot,
    preset: RunPreset,
    imageKey: string,
    own?: RunnerImage,
  ): { image: RunnerImage; preset: PresetRun } {
    const image =
      own ?? availableRunnerImages().find(({ key }) => key === imageKey);

    if (!image) {
      throw failed(
        'IMAGE_NOT_ALLOWED',
        'The runner image of this setting is no longer allowed',
      );
    }

    return {
      image,
      preset: presetRun(
        preset,
        snapshot.command,
        snapshot.result_paths,
        snapshot.trace_mode === 'on_failure',
        true,
        {
          installCommand: snapshot.install_command,
          specFiles: snapshot.spec_files,
          workDir: snapshot.work_dir,
        },
      ),
    };
  }

  /** The detected framework's image and command; Maven results are read from where Surefire writes them. */
  private async chooseDetected(
    context: RunContext,
    projectFolder: string,
  ): Promise<{ image: RunnerImage; preset: PresetRun }> {
    const detected = await this.detect(context, projectFolder);
    const chosen = this.choose(
      context.run.config_snapshot,
      detected.preset,
      detected.image_key,
    );

    context.preset = detected.preset;

    return detected.preset === 'maven'
      ? {
          ...chosen,
          preset: { ...chosen.preset, resultPaths: MAVEN_AUTO_RESULT_PATHS },
        }
      : chosen;
  }

  /** Finds the framework in the fetched code; chosen files must be test files of that framework. */
  private async detect(
    context: RunContext,
    projectFolder: string,
  ): Promise<DetectedFramework> {
    const snapshot = context.run.config_snapshot;
    const folder = cleanProjectPath(snapshot.work_dir ?? '');
    const packagePath = folder ? `${folder}/package.json` : 'package.json';
    const names = await projectFileNames(projectFolder, folder);
    const pkg = names.includes(packagePath)
      ? await readRegularFile(
          join(projectFolder, packagePath),
          PACKAGE_JSON_BYTES,
        )
      : null;
    const pkgText = Buffer.isBuffer(pkg) ? pkg.toString('utf8') : null;
    const detected = detectFramework(
      names,
      (path) => (path === packagePath ? pkgText : null),
      snapshot.work_dir,
    );

    if (!detected) {
      throw failed(
        'FRAMEWORK_NOT_DETECTED',
        `No Playwright, Cypress, Jest, Vitest, Mocha, Node.js test runner or JUnit (Maven) project was found in ${folder || 'the project folder'}. If the project is in a subfolder, set that folder as the tests folder`,
      );
    }

    if ('unsupported' in detected) {
      throw failed(
        'FRAMEWORK_NOT_SUPPORTED',
        `${UNSUPPORTED_NAMES[detected.unsupported]} projects are not supported yet`,
      );
    }

    const chosenFiles = snapshot.spec_files ?? [];
    const fitting = specFilesIn(chosenFiles, detected.preset, null);
    const unknown = chosenFiles.filter((file) => !fitting.includes(file));

    if (unknown.length > 0) {
      throw failed(
        'SPEC_NOT_FOUND',
        `Not test files of the detected framework: ${unknown.join(', ')}`,
      );
    }

    context.summary.detected_framework = detected;
    context.log.push(
      `Detected framework: ${detected.preset} (${detected.reason})`,
    );

    return detected;
  }

  /** Rights, licence and the target are checked again: all of them may have changed while the run waited. */
  private async assertAllowed(context: RunContext): Promise<void> {
    const { run, user } = context;

    try {
      await this.access.assertAvailable(run.organization_id, run.space_id, {
        write: true,
      });
    } catch {
      throw cancelled(
        'MODULE_DISABLED',
        'Test Management is no longer available in this space',
      );
    }

    if (!run.started_by) {
      throw cancelled('PERMISSION_LOST', 'The person who started the run left');
    }

    const rights = [
      'execute_tests',
      'manage_test_runs',
      ...(run.config_snapshot.create_unmatched ? ['create_tests'] : []),
    ];

    for (const right of rights) {
      const allowed = await this.permissions.hasSpacePermission(
        user.userId,
        run.organization_id,
        run.space_id,
        right,
      );

      if (!allowed) {
        throw cancelled(
          'PERMISSION_LOST',
          'The person who started the run no longer has the rights for it',
        );
      }
    }

    await this.assertTargetActive(context);
  }

  private async assertTargetActive(context: RunContext): Promise<void> {
    const { run } = context;
    const isPlan = run.target === 'plan';
    const id = isPlan ? run.plan_id : run.execution_id;

    if (!id) throw this.targetGone(run);

    const { data, error } = await this.client
      .from(isPlan ? 'test_plans' : 'test_executions')
      .select('id, is_archived')
      .eq('id', id)
      .eq('organization_id', run.organization_id)
      .eq('space_id', run.space_id)
      .maybeSingle();

    if (error) {
      throw failed('RUNNER_FAILED', 'The test target could not be read');
    }

    const target = data as { is_archived: boolean } | null;

    if (!target || target.is_archived) throw this.targetGone(run);
  }

  private targetGone(run: LeasedRun): RunStop {
    return failed(
      'EXECUTION_GONE',
      `The test ${run.target} was deleted or archived`,
    );
  }

  /** Secrets are read now, not when queued, so a replaced secret is used and they never sit in the queue. */
  private async readSecrets(run: LeasedRun): Promise<Record<string, string>> {
    if (!run.config_id) {
      throw failed('CONFIG_GONE', 'The automation setting was deleted');
    }

    const { data, error } = await this.client
      .from('test_automation_configs')
      .select('secrets_enc, archived_at')
      .eq('id', run.config_id)
      .eq('organization_id', run.organization_id)
      .eq('space_id', run.space_id)
      .maybeSingle();

    if (error) {
      throw failed('RUNNER_FAILED', 'The automation setting could not be read');
    }

    const config = data as {
      secrets_enc: string | null;
      archived_at: string | null;
    } | null;

    if (!config) {
      throw failed('CONFIG_GONE', 'The automation setting was deleted');
    }

    if (config.archived_at) {
      throw cancelled('CONFIG_ARCHIVED', 'The automation setting was archived');
    }

    return readSecretMap(config.secrets_enc);
  }

  private async prepareFolder(context: RunContext): Promise<string> {
    const base = runnerWorkDir();

    await mkdir(base, { recursive: true });

    const folder = join(await realpath(base), context.run.id);

    context.folder = folder;

    await mkdir(join(folder, 'project'), { recursive: true });
    await mkdir(join(folder, 'proxy'), { recursive: true });
    // The tests run as another user, which must be able to write its results here.
    await chmod(join(folder, 'project'), 0o777);

    return folder;
  }

  /** Answers whether an App or API URL host was added to the allowed ones. */
  private async startNetwork(
    context: RunContext,
    folder: string,
    preset: Pick<PresetRun, 'hosts'>,
    testEnv: Record<string, string>,
  ): Promise<boolean> {
    const { run } = context;
    const snapshot = run.config_snapshot;
    const repoHost =
      snapshot.source === 'git' && snapshot.repo_url
        ? new URL(snapshot.repo_url).host
        : null;
    const publicHosts = [
      ...snapshot.allowed_hosts,
      ...preset.hosts,
      ...(repoHost ? [repoHost] : []),
    ];
    const privateHosts = this.privateHosts();
    const publicPins = await this.pinPublicHosts(publicHosts);
    const app = await this.appUrlHosts(
      context,
      testEnv,
      publicHosts,
      privateHosts,
    );
    const pins = [
      ...publicPins,
      ...app.pins,
      ...privateHosts.map((host) => ({
        host: hostOf(host),
        address: 'host-gateway',
      })),
    ];
    const allHosts = [...publicHosts, ...app.hosts, ...privateHosts];

    await writeFile(
      join(folder, 'proxy', 'tinyproxy.conf'),
      proxyConfig(allHosts.flatMap(portOf)),
      { mode: 0o644 },
    );
    await writeFile(join(folder, 'proxy', 'filter'), proxyFilter(allHosts), {
      mode: 0o644,
    });

    await this.docker.createNetwork(run.id);
    await this.docker.startProxy({
      runId: run.id,
      image: process.env.TM_RUNNER_PROXY_IMAGE ?? DEFAULT_PROXY_IMAGE,
      configFolder: join(folder, 'proxy'),
      hosts: pins,
      signal: context.abort.signal,
    });

    return app.hosts.length > 0;
  }

  /**
   * The hosts of the App and API URLs, pinned apart from the others: one that isn't public warns instead of ending
   * the run, and the proxy keeps refusing it. Local and development-only hosts are never pinned.
   */
  private async appUrlHosts(
    context: RunContext,
    env: Record<string, string>,
    publicHosts: string[],
    privateHosts: string[],
  ): Promise<{ hosts: string[]; pins: { host: string; address: string }[] }> {
    const wanted = new Map<string, string[]>();

    for (const variable of APP_URL_VARIABLES) {
      const value = env[variable];

      if (!value) continue;

      const url = parseUrl(value);

      if (url && /^(.+\.)?localhost$/.test(url.hostname)) continue;

      const host =
        url && (url.protocol === 'http:' || url.protocol === 'https:')
          ? `${url.hostname}${url.port ? `:${url.port}` : ''}`
          : '';

      if (!HOST_PATTERN.test(host)) {
        context.log.push(
          `${variable} is not an http or https address with a host name, so the tests can't reach it`,
        );
        continue;
      }

      // Already open in development through the machine itself.
      if (privateHosts.some((own) => hostOf(own) === hostOf(host))) {
        if (!privateHosts.includes(host)) {
          context.log.push(
            `${variable} host ${host} uses a port TM_RUNNER_PRIVATE_HOSTS doesn't list`,
          );
        }

        continue;
      }

      wanted.set(host, [...(wanted.get(host) ?? []), variable]);
    }

    const pinned = new Set(publicHosts.map(hostOf));
    const names = [...new Set([...wanted.keys()].map(hostOf))].filter(
      (name) => !pinned.has(name),
    );
    const pins = await Promise.all(
      names.map((name) =>
        this.pinPublicHosts([name]).then(
          ([pin]) => pin,
          () => null,
        ),
      ),
    );
    const blocked = new Set(names.filter((_, index) => !pins[index]));
    const hosts: string[] = [];

    for (const [host, variables] of wanted) {
      if (blocked.has(hostOf(host))) {
        context.log.push(
          `${variables.join(' and ')} host ${hostOf(host)} isn't a public address, so the tests can't reach it`,
        );
        continue;
      }

      if (!publicHosts.includes(host)) hosts.push(host);
    }

    if (blocked.size > 0) this.addWarning(context, 'APP_URL_BLOCKED');

    return { hosts, pins: pins.filter((pin) => pin !== null) };
  }

  /** Development only: a production worker never opens the machine's own services to tests. */
  private privateHosts(): string[] {
    const hosts = (process.env.TM_RUNNER_PRIVATE_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);

    if (process.env.NODE_ENV !== 'production') return hosts;

    if (hosts.length > 0) {
      this.logger.warn('TM_RUNNER_PRIVATE_HOSTS is ignored in production');
    }

    return [];
  }

  /** Each public host is resolved here and pinned, so an answer that changes later cannot reach an internal address. */
  private async pinPublicHosts(
    hosts: string[],
  ): Promise<{ host: string; address: string }[]> {
    const names = [...new Set(hosts.map(hostOf))];

    return Promise.all(
      names.map(async (host) => {
        const addresses = await dnsLookup(host, { all: true }).catch(() => []);

        if (
          addresses.length === 0 ||
          addresses.some(({ address }) => isBlockedAddress(address))
        ) {
          throw failed(
            'BLOCKED_HOST',
            `${host} could not be resolved to a public address`,
          );
        }

        // The default Docker network has no IPv6 route, so IPv6 pins cannot connect.
        const pinned =
          addresses.find(({ family }) => family === 4) ?? addresses[0];

        return { host, address: pinned.address };
      }),
    );
  }

  /** A project's own file of that name stays: 'wx' neither replaces it nor follows a link it may be. */
  private async addReporter(
    projectFolder: string,
    reporter: { file: string; source: string },
  ): Promise<void> {
    try {
      await writeFile(join(projectFolder, reporter.file), reporter.source, {
        flag: 'wx',
        mode: 0o644,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  /**
   * The token of the repository's connection, asked for right before the clone and never saved.
   * Null keeps today's clone: not a connected repository, or a public one that needs no token.
   */
  private async connectionAccess(
    context: RunContext,
    repoUrl: string,
  ): Promise<{ token: string; repoUrl: string } | null> {
    if (!this.git) return null;

    const { run } = context;
    let match: GitRepositoryMatch;

    try {
      match = await this.git.findRepository(run.organization_id, repoUrl);
    } catch (error) {
      this.logger.warn(
        `Could not read the repository of run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }

    if (match.state === 'none') return null;

    if (match.state === 'unavailable') {
      if (!match.repository.is_private) return null;

      throw failed(
        'GIT_CONNECTION_UNAVAILABLE',
        'This private repository is no longer available through the GitHub connection',
      );
    }

    try {
      const token = await this.git.tokenFor(match);

      context.secrets.push(token);

      return { token, repoUrl: match.repository.web_url ?? repoUrl };
    } catch (error) {
      this.logger.warn(
        `Could not get a GitHub token for run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
      );

      if (!match.repository.is_private) return null;

      throw failed(
        'GIT_TOKEN_FAILED',
        'GitHub did not give access to this private repository',
      );
    }
  }

  private async fetchCode(
    context: RunContext,
    projectFolder: string,
    envFolder: string,
    gitToken: string | undefined,
  ): Promise<void> {
    const { run } = context;
    const snapshot = run.config_snapshot;

    if (snapshot.source === 'git') {
      if (!snapshot.repo_url) {
        throw failed('CLONE_FAILED', 'The setting has no repository address');
      }

      // A setting's own token wins, so one that already works never changes under it.
      const connection = gitToken
        ? null
        : await this.connectionAccess(context, snapshot.repo_url);
      const token = gitToken || connection?.token;

      const cloned = await this.docker.cloneRepo({
        runId: run.id,
        image: process.env.TM_RUNNER_GIT_IMAGE ?? DEFAULT_GIT_IMAGE,
        runFolder: projectFolder,
        envFolder,
        signal: context.abort.signal,
        repoUrl: connection?.repoUrl ?? snapshot.repo_url,
        repoRef: snapshot.repo_ref,
        ...(token ? { token } : {}),
      });

      context.log.push(cloned.output);
      this.assertStillWanted(context);

      if (cloned.code !== 0) {
        throw failed('CLONE_FAILED', 'The repository could not be cloned');
      }

      return;
    }

    if (!run.run_zip_path) {
      throw failed('ZIP_MISSING', 'The test project of this run is missing');
    }

    const { data, error } = await this.client.storage
      .from(AUTOMATION_BUCKET)
      .download(run.run_zip_path);

    if (error || !data) {
      throw failed('ZIP_MISSING', 'The test project of this run is missing');
    }

    // A hung download may have been given up on by now; its files must not land in a cleaned folder.
    this.assertStillWanted(context);

    try {
      await safeUnzip(Buffer.from(await data.arrayBuffer()), projectFolder);
    } catch (reason) {
      if (reason instanceof UnzipError) {
        throw failed('ZIP_REJECTED', reason.message);
      }

      throw reason;
    }
  }

  /** Java tools ignore the proxy variables, so they get the proxy as JVM options after the setting's own. */
  private jvmProxyOptions(
    runId: string,
    settingEnv: Record<string, string>,
    preset: PresetRun,
  ): Record<string, string> {
    if (!preset.jvmOptionsEnv) return {};

    const host = `${networkName(runId)}-proxy`;
    const proxy = [
      `-Dhttp.proxyHost=${host}`,
      `-Dhttp.proxyPort=${PROXY_PORT}`,
      `-Dhttps.proxyHost=${host}`,
      `-Dhttps.proxyPort=${PROXY_PORT}`,
    ].join(' ');
    const own = settingEnv[preset.jvmOptionsEnv];

    return {
      [preset.jvmOptionsEnv]: own ? `${own} ${proxy}` : proxy,
      // Maven reads this in its settings file, from docker/tm-runner-junit.
      XISUITE_PROXY_HOST: host,
    };
  }

  /** A cancel only counts while the run is RUNNING, so results of a cancelled run are never recorded. */
  private async moveToUploading(context: RunContext): Promise<void> {
    const { run, workerId } = context;

    context.summary.stage = 'saving';

    const { data, error } = await this.client
      .from('test_automation_runs')
      .update({ status: 'UPLOADING', result_summary: progressSummary(context) })
      .eq('id', run.id)
      .eq('worker_id', workerId)
      .eq('status', 'RUNNING')
      .is('cancel_requested_at', null)
      .select('id')
      .maybeSingle();

    if (error) {
      throw failed('RUNNER_FAILED', 'The run could not be updated');
    }

    if (!data) {
      context.cancelRequested = true;

      throw cancelled(undefined, 'The run was cancelled');
    }
  }

  private async upload(
    context: RunContext,
    files: CollectedResult[],
    exitCode: number,
  ): Promise<void> {
    const snapshot = context.run.config_snapshot;
    const uploaded: string[] = [];
    const counts = {
      applied: 0,
      created: 0,
      dropped: { count: 0, names: [] as string[] },
    };
    const warnings: unknown[] = [];
    const nothingToApply: string[] = [];
    // Before any upload, so one file that can't be masked leaves nothing half stored.
    const masked = files.map((file) => ({
      file,
      buffer: this.maskedResult(context, file),
    }));

    const tested = this.noteTests(
      context,
      masked.map(({ buffer }) => buffer),
    );

    for (const { file, buffer } of masked) {
      try {
        const multerFile = {
          originalname: file.name,
          buffer,
          size: buffer.length,
          mimetype: 'application/xml',
        } as Express.Multer.File;
        const result = await this.uploadOne(context, multerFile);

        this.addCounts(counts, warnings, result);
        uploaded.push(file.path);
      } catch (error) {
        const code = importCode(error);

        // This run's bytes are unique, so "already applied" can only be its own earlier try.
        if (code === 'IMPORT_ALREADY_APPLIED') {
          uploaded.push(file.path);
          continue;
        }

        // One file of only skipped tests must not cost the results in the next one.
        if (code === 'NOTHING_TO_APPLY') {
          nothingToApply.push(file.path);
          continue;
        }

        context.summary.import = {
          uploaded,
          nothing_to_apply: nothingToApply,
          ...counts,
          warnings,
        };

        throw this.uploadStop(uploaded, code, error);
      }
    }

    if (uploaded.length === 0 && nothingToApply.length > 0) {
      context.summary.import = {
        uploaded,
        nothing_to_apply: nothingToApply,
        ...counts,
        warnings,
      };
      await this.removeEmptyPlanExecution(context);

      // Skipped tests are never recorded, so a clean run of only skipped tests did not fail.
      if (
        exitCode === 0 &&
        tested.total > 0 &&
        tested.skipped === tested.total
      ) {
        this.addWarning(context, 'ALL_SKIPPED');

        return;
      }

      throw failed('NOTHING_TO_APPLY', 'No result file had a result to record');
    }

    context.summary.import = {
      uploaded,
      nothing_to_apply: nothingToApply,
      ...counts,
      warnings,
      create_unmatched: snapshot.create_unmatched,
    };
  }

  /** Read from the masked files only, because anyone who can see tests can read these. A file that can't be read is left to the import to report. */
  private noteTests(
    context: RunContext,
    buffers: Buffer[],
  ): { total: number; skipped: number } {
    const counts = { total: 0, passed: 0, failed: 0, skipped: 0 };
    const tests: { name: string; status: string }[] = [];

    for (const buffer of buffers) {
      try {
        const { items } = parseResultFile(buffer, { keepEvidence: false });

        for (const item of items) {
          const status = LISTED_STATUS[item.status];

          counts.total += 1;
          counts[status] += 1;

          if (tests.length < MAX_LISTED_TESTS) {
            tests.push({ name: listedTestName(item.name), status });
          }
        }
      } catch (error) {
        this.logger.warn(
          `A result file of run ${context.run.id} could not be counted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    context.summary.counts = counts;
    context.summary.tests = tests;

    return counts;
  }

  /** A plan run's execution exists only for its results; a target the user chose is never removed. */
  private async removeEmptyPlanExecution(context: RunContext): Promise<void> {
    const { run, user, executionId } = context;

    if (run.target !== 'plan' || !executionId) return;

    try {
      await this.executions.remove(user, run.space_id, executionId, false);
      context.executionId = null;
    } catch (error) {
      this.logger.warn(
        `Execution ${executionId} of a run with no results was kept: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A secret that collides with the XML itself breaks the file; it is refused, never stored unmasked. */
  private maskedResult(context: RunContext, file: CollectedResult): Buffer {
    const text = file.buffer.toString('utf8');
    const masked = maskXmlSecrets(text, context.secrets);

    if (masked === text) return file.buffer;

    try {
      parseXml(masked);
    } catch {
      throw failed(
        'RESULT_NOT_MASKABLE',
        `A secret could not be hidden in ${file.name}`,
      );
    }

    return Buffer.from(masked, 'utf8');
  }

  private async uploadOne(
    context: RunContext,
    file: Express.Multer.File,
  ): Promise<JunitCommitResult> {
    const { run, user } = context;
    const snapshot = run.config_snapshot;
    const executionId =
      context.executionId ?? (await this.startPlanExecution(context));
    const caseId = run.result_summary?.case_id;
    const onlyCaseId = typeof caseId === 'string' ? caseId : null;
    const result = await this.results.commit(
      user,
      run.space_id,
      executionId,
      file,
      { create_unmatched: snapshot.create_unmatched && !onlyCaseId },
      // A plan run's results may name tests outside the plan, so those are added too.
      {
        addInSpace: run.target === 'plan',
        noRerun: true,
        ...(onlyCaseId ? { only_case_id: onlyCaseId } : {}),
      },
    );

    await this.addCreatedToPlan(context, result);

    return result;
  }

  /** The plan's tests are there before the first result, so they match by title and untested ones stay TODO. */
  private async startPlanExecution(context: RunContext): Promise<string> {
    const { run, user } = context;
    const planId = run.plan_id as string;
    const date = new Date().toISOString().slice(0, 10);

    // The run id as the request id: a retry finds this execution again.
    const created = await this.executions.createImport(user, run.space_id, {
      request_id: run.id,
      name: `Automation ${run.config_snapshot.name} ${date}`.slice(0, 255),
      description: null,
      plan_id: planId,
      environment: null,
    });

    context.executionId = created.execution_id;
    await this.linkExecution(context, created.execution_id);

    const caseIds = await this.planTests.testIds(
      run.organization_id,
      run.space_id,
      planId,
    );

    if (caseIds.length > 0) {
      await this.runs.addRuns(
        user,
        run.space_id,
        created.execution_id,
        caseIds,
      );
    }

    return created.execution_id;
  }

  /** Tests already in the space join the plan when their run is added; new ones are created outside that path. */
  private async addCreatedToPlan(
    context: RunContext,
    result: JunitCommitResult,
  ): Promise<void> {
    const { run, user } = context;
    const caseIds = (result.created_cases ?? []).map((item) => item.case_id);

    if (!run.plan_id || caseIds.length === 0) return;

    try {
      await this.planTests.add(user, run.space_id, run.plan_id, {
        source: 'cases',
        case_ids: caseIds,
      });
    } catch (error) {
      result.warnings = [
        ...(result.warnings ?? []),
        {
          row: 0,
          code: 'PLAN_NOT_UPDATED',
          message: `The results are recorded, but new tests were not added to the plan: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  }

  /** A plan run gets its execution only now; a failed link is logged because the results are already recorded. */
  private async linkExecution(
    context: RunContext,
    executionId: string,
  ): Promise<void> {
    const { error } = await this.client
      .from('test_automation_runs')
      .update({ execution_id: executionId })
      .eq('id', context.run.id)
      .eq('worker_id', context.workerId);

    if (error) {
      this.logger.warn(
        `Failed to link run ${context.run.id} to its execution: ${error.message}`,
      );
    }
  }

  private addCounts(
    counts: {
      applied: number;
      created: number;
      dropped: { count: number; names: string[] };
    },
    warnings: unknown[],
    result: JunitCommitResult,
  ): void {
    counts.applied += result.applied.length;
    counts.created += result.created_cases?.length ?? 0;
    warnings.push(...(result.warnings ?? []));

    if (result.dropped) {
      counts.dropped.count += result.dropped.count;
      counts.dropped.names = [
        ...counts.dropped.names,
        ...result.dropped.names,
      ].slice(0, DROPPED_NAMES);
    }
  }

  private uploadStop(
    uploaded: string[],
    code: string,
    error: unknown,
  ): RunStop {
    const message = error instanceof Error ? error.message : 'Unknown problem';

    if (uploaded.length > 0) {
      return failed(
        'PARTIAL_UPLOAD',
        `${uploaded.length} result file(s) were recorded before this one failed: ${message}`,
      );
    }

    if (code === 'FORBIDDEN') return cancelled('PERMISSION_LOST', message);

    if (code === 'NOT_FOUND') {
      return failed('EXECUTION_GONE', 'The test target was deleted');
    }

    return failed(code, message);
  }

  /** The log always goes with the execution; a failed upload never changes how the run ended. */
  private async attachOutput(
    context: RunContext,
    finish: Finish,
  ): Promise<void> {
    if (context.leaseLost || context.log.length === 0) return;

    const { run } = context;
    const log = capLog(maskSecrets(context.log.join('\n'), context.secrets));
    const canAttach = Boolean(context.executionId && run.started_by);
    const attached =
      canAttach &&
      (await this.attach(
        context,
        `automation-${run.id}-log.txt`,
        Buffer.from(log, 'utf8'),
        'text/plain',
        'LOG_NOT_SAVED',
      ));

    // Without the file, this is the only place the output survives.
    if (!attached) context.summary.saved_log = capLog(log, LIVE_LOG_BYTES);
    if (!canAttach) return;

    const failedRun =
      finish.status === 'ERROR' || finish.outcome === 'failed_tests';

    if (failedRun) await this.attachTrace(context);
  }

  private async attachTrace(context: RunContext): Promise<void> {
    const { run } = context;
    const snapshot = run.config_snapshot;

    // An auto run that stopped before detection has no framework, so no trace.
    if (
      snapshot.trace_mode !== 'on_failure' ||
      !context.folder ||
      context.preset === 'auto'
    ) {
      return;
    }

    const { tracePath } = presetRun(
      context.preset,
      snapshot.command,
      snapshot.result_paths,
      true,
    );

    if (!tracePath) return;

    const segments = [snapshot.work_dir ?? '', tracePath]
      .join('/')
      .split('/')
      .filter(Boolean);
    const [first] = await matches(join(context.folder, 'project'), segments);

    if (!first) return;

    const trace = await readRegularFile(first, MAX_TRACE_BYTES);

    if (!Buffer.isBuffer(trace)) {
      this.addWarning(context, 'TRACE_NOT_SAVED');

      return;
    }

    await this.attach(
      context,
      `automation-${run.id}-trace.zip`,
      trace,
      'application/zip',
      'TRACE_NOT_SAVED',
    );
  }

  private async attach(
    context: RunContext,
    name: string,
    buffer: Buffer,
    mimetype: string,
    warning: string,
  ): Promise<boolean> {
    try {
      await withinLimit(
        this.attachments.upload({
          user: context.user,
          entityType: 'test_execution',
          entityId: context.executionId as string,
          file: {
            originalname: name,
            buffer,
            size: buffer.length,
            mimetype,
          } as Express.Multer.File,
        }),
        STORAGE_LIMIT_MS,
        () => new Error('The upload took too long'),
      );

      return true;
    } catch (error) {
      this.logger.warn(
        `Failed to attach ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.addWarning(context, warning);

      return false;
    }
  }

  /** Conditional on this worker, so a run the reaper already closed is not reopened. */
  private async save(context: RunContext, finish: Finish): Promise<void> {
    context.closing = true;

    if (context.leaseLost) return;

    const { run, workerId } = context;
    const message = finish.errorMessage
      ? withoutNul(
          maskSecrets(finish.errorMessage, context.secrets).slice(
            0,
            MAX_ERROR_LENGTH,
          ),
        )
      : null;

    // A stage only means something while the run is going.
    delete context.summary.stage;

    // The results are recorded by now, so a database blip must not make this run look interrupted.
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt += 1) {
      const { error } = await this.client
        .from('test_automation_runs')
        .update({
          status: finish.status,
          outcome: finish.outcome ?? null,
          error_code: finish.errorCode ?? null,
          error_message: message,
          exit_code:
            finish.exitCode ??
            (context.summary.exit_code as number | undefined) ??
            null,
          result_summary: summaryWithoutNul(context.summary),
          finished_at: new Date().toISOString(),
          lease_until: null,
          run_zip_path: null,
        })
        .eq('id', run.id)
        .eq('worker_id', workerId)
        .in('status', ['RUNNING', 'UPLOADING']);

      if (!error) return;

      this.logger.error(
        `Failed to save the end of run ${run.id} (try ${attempt})`,
        error,
      );

      if (attempt < SAVE_ATTEMPTS) {
        await new Promise((done) => setTimeout(done, SAVE_RETRY_MS));
      }
    }
  }

  /** Runs on every ending, and a hung step can't lose the result; the sweep removes what stays behind. */
  private async cleanUpInTime(context: RunContext): Promise<void> {
    void this.setStage(context, 'cleaning_up');

    try {
      await withinLimit(this.cleanUp(context), CLEANUP_LIMIT_MS, () => {
        return new Error('The time limit passed');
      });
    } catch (error) {
      this.logger.warn(
        `Clean-up of run ${context.run.id} did not finish: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    context.summary.cleanup ??= 'failed';
  }

  /** One failed step must not stop the others. The zip starts first and beside the rest, because the sweep doesn't remove it. */
  private async cleanUp(context: RunContext): Promise<void> {
    await Promise.all([
      this.removeRunZip(context.run),
      this.removeContainersAndFolder(context),
    ]);
  }

  private async removeRunZip(run: LeasedRun): Promise<void> {
    if (!run.run_zip_path) return;

    try {
      const { error } = await this.client.storage
        .from(AUTOMATION_BUCKET)
        .remove([run.run_zip_path]);

      if (error) throw new Error(error.message);
    } catch {
      this.logger.warn(`Failed to remove the zip of ${run.id}`);
    }
  }

  private async removeContainersAndFolder(context: RunContext): Promise<void> {
    const { run } = context;
    let removed = true;

    await this.docker.remove(run.id).catch((error: unknown) => {
      removed = false;
      this.logger.warn(`Failed to remove the containers of ${run.id}`, error);
    });

    if (context.folder) {
      await removeFolder(context.folder).catch((error: unknown) => {
        removed = false;
        this.logger.warn(`Failed to remove the folder of ${run.id}`, error);
      });
    }

    context.summary.cleanup = removed ? 'removed' : 'failed';
  }

  private finishFromError(context: RunContext, error: unknown): Finish {
    // A stop or timeout kills the container, which can look like some other failure later on.
    if (context.cancelRequested) {
      return { status: 'CANCELLED' };
    }

    if (context.timedOut) {
      return {
        status: 'ERROR',
        errorCode: 'TIMEOUT',
        errorMessage: this.withLogEnd(
          context,
          failed('TIMEOUT', 'The run took longer than its time limit'),
        ),
      };
    }

    if (context.diskFull) {
      return {
        status: 'ERROR',
        errorCode: 'DISK_LIMIT',
        errorMessage: this.withLogEnd(context, diskLimit()),
      };
    }

    if (error instanceof RunStop) {
      return {
        status: error.status,
        ...(error.code ? { errorCode: error.code } : {}),
        errorMessage: this.withLogEnd(context, error),
      };
    }

    if (error instanceof DockerCommandError) {
      context.log.push(error.output);

      if (IMAGE_NOT_FOUND.test(error.output)) {
        return {
          status: 'ERROR',
          errorCode: 'IMAGE_MISSING',
          errorMessage: this.withLogEnd(
            context,
            error.step === PROXY_START_STEP
              ? proxyImageMissing()
              : imageMissing(),
          ),
        };
      }

      return {
        status: 'ERROR',
        errorCode: 'START_FAILED',
        errorMessage: this.withLogEnd(
          context,
          failed('START_FAILED', error.message),
        ),
      };
    }

    this.logger.error(`Run ${context.run.id} stopped unexpectedly`, error);

    return {
      status: 'ERROR',
      errorCode: 'RUNNER_FAILED',
      errorMessage: 'The runner stopped because of an unexpected problem',
    };
  }

  /** A failed run explains itself with the very end of its output. Masked first, so a cut cannot split a secret. */
  private withLogEnd(context: RunContext, stop: RunStop): string {
    if (stop.status !== 'ERROR' || context.log.length === 0) {
      return stop.message;
    }

    const output = lastLines(
      maskSecrets(context.log.join('\n'), context.secrets),
    );
    const room = MAX_ERROR_LENGTH - stop.message.length - 1;

    return room > 0 ? `${stop.message}\n${output.slice(-room)}` : stop.message;
  }

  private assertStillWanted(context: RunContext): void {
    if (context.cancelRequested) {
      throw cancelled(undefined, 'The run was cancelled');
    }

    if (context.timedOut) {
      throw failed('TIMEOUT', 'The run took longer than its time limit');
    }

    if (context.diskFull) throw diskLimit();

    if (context.leaseLost) {
      throw failed('INTERRUPTED', 'The run lost its lease');
    }
  }

  /** Keeps the lease and notices a cancel; a run that is no longer ours is stopped. */
  private async beat(context: RunContext): Promise<void> {
    const { run, workerId } = context;
    const now = Date.now();

    // A container that started after the limit is stopped on the next beat. Not waited for: a hung Docker must not cost the lease.
    if (context.timedOut) void this.stopContainers(run.id);

    const { data, error } = await this.client
      .from('test_automation_runs')
      .update({
        lease_until: new Date(now + LEASE_SECONDS * 1000).toISOString(),
        heartbeat_at: new Date(now).toISOString(),
      })
      .eq('id', run.id)
      .eq('worker_id', workerId)
      .in('status', ['RUNNING', 'UPLOADING'])
      .select('status, cancel_requested_at')
      .maybeSingle();

    if (error) {
      this.logger.warn(`Heartbeat of run ${run.id} failed: ${error.message}`);

      return;
    }

    if (context.closing) return;

    const row = data as {
      status: string;
      cancel_requested_at: string | null;
    } | null;

    if (!row) {
      context.leaseLost = true;
      this.giveUpSoon(context);
      await this.stopContainers(run.id);

      return;
    }

    if (row.cancel_requested_at && row.status === 'RUNNING') {
      context.cancelRequested = true;
      this.giveUpSoon(context);
      await this.stopContainers(run.id);
    }
  }

  /** A Docker command that ignores the stop, such as a hung image pull, must not hold the run's slot for ever. */
  private giveUpSoon(context: RunContext): void {
    if (context.closing) return;

    context.giveUp ??= setTimeout(() => context.abort.abort(), GIVE_UP_MS);
  }

  private async stopContainers(runId: string): Promise<void> {
    await this.docker.stop(runId).catch((error: unknown) => {
      this.logger.warn(`Failed to stop the containers of ${runId}`, error);
    });
  }

  private noteProblems(context: RunContext, problems: ResultProblem[]): void {
    if (problems.length > 0) context.summary.file_problems = problems;

    if (problems.some(({ code }) => code === 'TOO_MANY_FILES')) {
      this.addWarning(context, 'TOO_MANY_FILES');
    }
  }

  private addWarning(context: RunContext, code: string): void {
    const warnings = (context.summary.warnings ?? []) as string[];

    context.summary.warnings = [...warnings, code];
  }
}

// A cut can leave half a surrogate pair, which Postgres refuses as much as a NUL byte.
function withoutNul(text: string): string {
  return text.replace(/\0|\p{Cs}/gu, '');
}

function progressSummary(context: RunContext): unknown {
  return summaryWithoutNul({
    ...context.summary,
    ...(context.liveText === null ? {} : { live_log: context.liveText }),
  });
}

function listedTestName(name: string): string {
  return Array.from(name.replace(/\p{Cc}/gu, ''))
    .slice(0, MAX_TEST_NAME_LENGTH)
    .join('');
}

/** Settles with the work, or rejects at the limit; the work is left to end by itself. */
async function withinLimit<T>(
  work: Promise<T>,
  ms: number,
  late: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(late()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A stop normally ends the work by itself. A short wait keeps its output; after that, a call that ignores the stop is left behind. */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let grace: NodeJS.Timeout | undefined;
    const onAbort = () => {
      grace = setTimeout(
        () => reject(new Error('A step ignored the stop')),
        STOP_GRACE_MS,
      );
    };

    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(resolve, reject).finally(() => {
      clearTimeout(grace);
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/** Postgres can't store a NUL byte in text or JSON, and test output can hold one. */
function summaryWithoutNul(summary: Record<string, unknown>): unknown {
  return JSON.parse(
    JSON.stringify(summary, (_, value: unknown) =>
      typeof value === 'string' ? withoutNul(value) : value,
    ),
  );
}

/** File names under the tests folder, from the project root. Links are never followed, and packages and dot-folders are skipped. */
async function projectFileNames(
  projectFolder: string,
  folder: string,
): Promise<string[]> {
  let start = projectFolder;

  // Each part of the tests folder must be a real folder, or a link in a clone could lead outside the project.
  for (const part of folder ? folder.split('/') : []) {
    start = join(start, part);

    if (!(await lstat(start).catch(() => null))?.isDirectory()) return [];
  }

  const prefix = folder ? `${folder}/` : '';
  const names: string[] = [];
  const queue = [''];
  let seen = 0;

  while (queue.length > 0 && seen < DETECT_ENTRIES) {
    const relative = queue.shift() ?? '';
    // Entry types come from lstat, so a link is neither a folder nor a file here.
    const entries = await readdir(join(start, relative), {
      withFileTypes: true,
    }).catch(() => []);

    for (const entry of entries) {
      seen += 1;

      if (seen > DETECT_ENTRIES) break;

      const name = relative ? `${relative}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          queue.push(name);
        }
      } else if (entry.isFile()) {
        names.push(`${prefix}${name}`);
      }
    }
  }

  return names;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hostOf(host: string): string {
  return host.split(':')[0];
}

function portOf(host: string): number[] {
  const port = Number(host.split(':')[1]);

  return Number.isInteger(port) && port > 0 ? [port] : [];
}

/** The import's own code when it has one that fits a run's error code. */
function importCode(error: unknown): string {
  if (!(error instanceof HttpException)) return 'IMPORT_FAILED';

  const response = error.getResponse();
  const code =
    typeof response === 'object' ? (response as { code?: unknown }).code : null;

  if (typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code)) return code;
  if (error.getStatus() === 403) return 'FORBIDDEN';
  if (error.getStatus() === 404) return 'NOT_FOUND';

  return 'IMPORT_FAILED';
}
