import { randomUUID } from 'crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { mavenTestNames } from '../../test-automation-runner/presets';
import { TestManagementAccessService } from '../access/test-management-access.service';
import { TesterEligibilityService } from '../common/tester-eligibility.service';
import { ticketEmbed, ticketName } from '../common/ticket-keys';
import type {
  ListTestAutomationRunsQueryDto,
  ListTestAutomationSpecFilesQueryDto,
  StartTestAutomationRunDto,
  TestAutomationCiJobLog,
  TestAutomationRun,
  TestAutomationSpecFiles,
  TestAutomationTargetQueryDto,
  TestAutomationTestCounts,
} from '../dto/test-automation.dto';
import { TEST_EXECUTION_LIMITS } from '../dto/test-execution.dto';
import type { TestPlanPage } from '../dto/test-plan.dto';
import type {
  JunitCommitResult,
  TransferIssue,
} from '../dto/test-transfer.dto';
import { TestExecutionsService } from '../executions/test-executions.service';
import { fetchPage } from '../plans/test-plans.service';
import { TestRunsService } from '../runs/test-runs.service';
import { notFound, tmDbError } from '../test-management-errors';
import {
  AUTO_IMAGE_KEY,
  availableRunnerImages,
  checkHosts,
  checkRepoUrl,
  checkSpecFiles,
  cleanProjectPath,
  invalid,
  isCiRunInProgress,
  readQueuePerOrg,
  readQueuePerSpace,
  runnerEnabled,
  specFilesIn,
} from './automation-inputs';
import { CustomImageApprovalService } from './custom-images/approval/service/custom-image-approval.service';
import { isOwnImageKey } from './custom-images/shared/inputs/custom-image-inputs';
import {
  imageNotRunnable,
  TestAutomationCustomImagesService,
  type CustomImageRow,
} from './test-automation-custom-images.service';
import { TestAutomationCiWatcherService } from './test-automation-ci-watcher.service';
import {
  RUN_COLUMNS,
  TestAutomationCiService,
  toRun,
  type RunRow,
} from './test-automation-ci.service';
import {
  AUTOMATION_BUCKET,
  RUNNER_GOING_STATES,
  TestAutomationConfigsService,
  type TestAutomationConfigRow,
} from './test-automation-configs.service';
import type { GithubJob } from './test-automation-github.client';
import {
  startForbidden,
  TestAutomationRunnerService,
} from './test-automation-runner.service';

const RUN_WITH_ZIP_COLUMNS = `${RUN_COLUMNS}, run_zip_path`;

type RunWithZip = RunRow & { run_zip_path?: string | null };

const RUN_LIST_COLUMNS =
  `${RUN_COLUMNS}, ` +
  'execution:test_executions!test_automation_runs_execution_fkey(task:tasks!test_executions_task_id_fkey(key)), ' +
  'plan:test_plans!test_automation_runs_plan_fkey(task:tasks!test_plans_task_id_fkey(key))';

type RunListRow = RunRow & {
  execution?: { task: { key: string } | null } | null;
  plan?: { task: { key: string } | null } | null;
};

const RUN_SORT_COLUMNS = new Map<string, string[]>([
  ['started', ['created_at']],
  ['setting', ['config_snapshot->>name']],
  ['status', ['status']],
]);

// The same caps and words the CI watcher writes, so a run closed by its upload reads like one it followed.
const MAX_LISTED_TESTS = 500;
const MAX_TEST_NAME_LENGTH = 200;
const UPLOAD_STATUS: Record<string, 'passed' | 'failed'> = {
  PASS: 'passed',
  FAIL: 'failed',
  BLOCKED: 'failed',
};

interface CloseRow {
  id: string;
  status: string;
  target: 'plan' | 'execution';
  plan_id: string | null;
  execution_id: string | null;
  result_summary: Record<string, unknown> | null;
}

interface TallyRow {
  id: string;
  current_attempt_no: number;
  case: { task: { summary: string } } | null;
  attempts: { attempt_no: number; status: string }[] | null;
}

const runWarning = (code: string, message: string): TransferIssue => ({
  row: 0,
  code,
  message,
});

/** What a run works from: later edits of the setting do not change it. Secrets are read when the run starts. */
function configSnapshot(config: TestAutomationConfigRow) {
  return {
    name: config.name,
    preset: config.preset,
    image_key: config.image_key,
    source: config.source,
    repo_url: config.repo_url,
    repo_ref: config.repo_ref,
    work_dir: config.work_dir,
    command: config.command,
    install_command: config.install_command,
    result_paths: config.result_paths,
    env: config.env,
    allowed_hosts: config.allowed_hosts,
    create_unmatched: config.create_unmatched,
    timeout_minutes: config.timeout_minutes,
    trace_mode: config.trace_mode,
  };
}

/** Lists can be read often, so the long parts wait until one run is opened. */
function listedSummary(summary: Record<string, unknown>) {
  const listed = { ...summary };

  delete listed.tests;
  delete listed.saved_log;

  return listed;
}

/** The same request id with other files or another test case is another start, so it must not answer with the first one. */
function assertSameStart(
  run: TestAutomationRun,
  specFiles: string[] | undefined,
  caseId: string | undefined,
): void {
  const before = (run.result_summary?.spec_files as string[] | undefined) ?? [];

  // A case run with no chosen files took them from its link, which may have changed since.
  const sameFiles =
    (caseId && !specFiles) ||
    JSON.stringify(before) === JSON.stringify(specFiles ?? []);

  if (
    !sameFiles ||
    (run.result_summary?.case_id ?? null) !== (caseId ?? null)
  ) {
    throw new ConflictException({
      code: 'REQUEST_ID_REUSED',
      message: 'This request id was already used for another start',
    });
  }
}

function notCancellable(): ConflictException {
  return new ConflictException({
    code: 'RUN_NOT_CANCELLABLE',
    message: 'The run is already saving its results or has finished',
  });
}

/** Starts of automation in a space: CI jobs, and runs of tests on the runner, which this service only queues. */
@Injectable()
export class TestAutomationRunsService {
  private readonly logger = new Logger(TestAutomationRunsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly permissions: PermissionsService,
    private readonly auditLogs: AuditLogsService,
    private readonly ciWatcher: TestAutomationCiWatcherService,
    @Optional() private readonly configs?: TestAutomationConfigsService,
    @Optional() private readonly ci?: TestAutomationCiService,
    @Optional() private readonly eligibility?: TesterEligibilityService,
    @Optional() private readonly executions?: TestExecutionsService,
    @Optional() private readonly testRuns?: TestRunsService,
    @Optional() private readonly runner?: TestAutomationRunnerService,
    @Optional()
    private readonly customImages?: TestAutomationCustomImagesService,
    @Optional()
    private readonly imageApprovals?: CustomImageApprovalService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // Runner starts need these; the module always provides them.
  private use<T>(service: T | undefined): T {
    if (!service) {
      throw new ServiceUnavailableException({
        code: 'RUNNER_DISABLED',
        message: 'The test runner is not available on this server',
      });
    }

    return service;
  }

  async start(
    user: RequestUser,
    spaceId: string,
    dto: StartTestAutomationRunDto,
  ): Promise<TestAutomationRun> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // The route needs execute_tests; starting automation also needs the right to manage runs.
    await this.assertRight(
      user,
      spaceId,
      'manage_test_runs',
      'Starting automation needs the right to manage test runs',
    );

    if (!dto.target_id && !dto.case_id) {
      throw invalid('target_id', 'Choose what to run: a target or a test case');
    }

    if (dto.case_id && dto.target !== 'execution') {
      throw invalid('case_id', 'A run from a test case goes to an execution');
    }

    const chosenFiles = dto.spec_files
      ? checkSpecFiles(dto.spec_files)
      : undefined;
    const replay = await this.use(this.ci).findByRequest(
      user,
      spaceId,
      dto.config_id,
      dto.request_id,
    );

    if (replay) {
      assertSameStart(replay, chosenFiles, dto.case_id);

      return replay;
    }

    // Run now assigns the run to the person, so a person who can't be assigned can't start a case run.
    if (dto.case_id) {
      await this.use(this.eligibility).assertEligible(
        user.organizationId,
        spaceId,
        user.userId,
      );
    }

    if (!runnerEnabled()) {
      throw new ServiceUnavailableException({
        code: 'RUNNER_DISABLED',
        message: 'The test runner is not switched on for this server',
      });
    }

    // A run queued while no runner is on would only wait, so it is refused until the runner is started.
    let runnerState = this.runner ? await this.runner.acceptsRuns() : 'online';

    // Off: start it as the Start button does; where the app may not start it the run is still refused.
    if (runnerState === 'offline' && this.runner) {
      const started = await this.runner.autoStart(user, spaceId);

      if (started === 'forbidden') throw startForbidden();
      if (started === 'started') runnerState = 'starting';
    }

    if (!['online', 'busy', 'starting'].includes(runnerState)) {
      throw new ConflictException({
        code: 'RUNNER_OFF',
        message: 'The test runner is off. Start it, then run the tests again.',
      });
    }

    const config = await this.use(this.configs).findRow(
      user.organizationId,
      spaceId,
      dto.config_id,
    );

    const ownImage = await this.assertRunnable(user, spaceId, config);

    if (chosenFiles) this.assertFitsFramework(config, chosenFiles);

    const target = dto.target_id
      ? await this.use(this.ci).findTarget(user.organizationId, spaceId, {
          ...dto,
          target_id: dto.target_id,
        })
      : null;

    await this.assertQueueRoom(user.organizationId, spaceId);
    await this.assertNotGoing(
      user.organizationId,
      spaceId,
      config.id,
      dto,
      target?.id ?? null,
    );

    const testCase = dto.case_id
      ? await this.runnableCase(user.organizationId, spaceId, dto.case_id)
      : null;

    // Restart names the old execution: it has to be one this case really ran in with this setting.
    if (
      dto.case_id &&
      target &&
      !(await this.caseExecutionId(
        user.organizationId,
        spaceId,
        config.id,
        dto.case_id,
        target.id,
      ))
    ) {
      throw invalid(
        'case_id',
        'This test execution does not belong to this test case',
      );
    }

    const linkedFiles =
      !chosenFiles && testCase?.automation_spec_path
        ? checkSpecFiles([testCase.automation_spec_path])
        : undefined;

    if (linkedFiles) this.assertFitsFramework(config, linkedFiles);

    const specFiles = chosenFiles ?? linkedFiles;
    const runId = randomUUID();
    const runZipPath = await this.copyZip(user, spaceId, config, runId);

    // Checked on the run's own copy, because that is what it will run.
    if (specFiles && runZipPath) {
      await this.assertSpecFilesInZip(config, runZipPath, specFiles);
    }

    // Last, so a refused start leaves no execution or ticket behind.
    let caseExecution: { id: string; created: boolean } | null = null;

    if (dto.case_id) {
      try {
        caseExecution = await this.caseExecution(
          user,
          spaceId,
          config.id,
          dto.case_id,
          dto.request_id,
          target?.id ?? null,
        );
      } catch (error) {
        if (runZipPath) await this.removeZip(runZipPath);

        throw error;
      }
    }

    const targetId = caseExecution?.id ?? target?.id;
    const summary = {
      ...(specFiles ? { spec_files: specFiles } : {}),
      ...(dto.case_id ? { case_id: dto.case_id } : {}),
    };

    const { data, error } = await this.client
      .from('test_automation_runs')
      .insert({
        id: runId,
        organization_id: user.organizationId,
        space_id: spaceId,
        config_id: config.id,
        kind: 'docker',
        target: dto.target,
        plan_id: dto.target === 'plan' ? targetId : null,
        execution_id: dto.target === 'execution' ? targetId : null,
        config_snapshot: {
          ...configSnapshot(config),
          ...(ownImage
            ? {
                user_image_id: ownImage.id,
                run_ref: ownImage.run_ref,
                platform: ownImage.platform,
              }
            : {}),
          ...(specFiles ? { spec_files: specFiles } : {}),
        },
        ...(Object.keys(summary).length > 0 ? { result_summary: summary } : {}),
        request_id: dto.request_id,
        started_by: user.userId,
        status: 'QUEUED',
        run_zip_path: runZipPath,
      })
      .select(RUN_COLUMNS)
      .single();

    if (error || !data) {
      // Nothing points at the copy without its row.
      if (runZipPath) await this.removeZip(runZipPath);

      if (error?.code === '23505') {
        const raced = await this.use(this.ci).findByRequest(
          user,
          spaceId,
          dto.config_id,
          dto.request_id,
        );

        if (raced) {
          assertSameStart(raced, chosenFiles, dto.case_id);

          return raced;
        }
      }

      if (caseExecution?.created) {
        await this.removeNewExecution(user, spaceId, caseExecution.id);
      }

      throw tmDbError(
        this.logger,
        'queue automation run',
        error ?? { message: 'no row' },
      );
    }

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_run',
      runId,
      'create',
      {
        config_id: config.id,
        target: dto.target,
        target_id: targetId,
        status: 'QUEUED',
        ...(dto.case_id ? { case_id: dto.case_id } : {}),
      },
    );

    return toRun(data as unknown as RunRow);
  }

  /** Only a workflow started through the GitHub connection can be stopped; other CI tools are never called again. */
  async cancel(
    user: RequestUser,
    spaceId: string,
    runId: string,
  ): Promise<TestAutomationRun> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const run = await this.load(
      user.organizationId,
      spaceId,
      runId,
      RUN_WITH_ZIP_COLUMNS,
    );

    if (run.kind === 'docker') return this.cancelRunner(user, spaceId, run);

    if (!this.ciWatcher.isCancellable(run)) {
      throw new ConflictException({
        code: 'RUN_NOT_CANCELLABLE',
        message:
          'This run has finished, or its CI tool cannot be asked to stop',
      });
    }

    if (run.cancel_requested_at) return toRun(run);

    const asked = await this.ciWatcher.cancel(run);

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_run',
      runId,
      'update',
      { action: 'cancel', from: 'REQUESTED' },
    );

    return toRun(asked);
  }

  /** Removes the record only: results already in the execution, and the workflow in the CI tool, stay. */
  async remove(
    user: RequestUser,
    spaceId: string,
    runId: string,
  ): Promise<void> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const run = await this.load(
      user.organizationId,
      spaceId,
      runId,
      RUN_WITH_ZIP_COLUMNS,
    );
    const isDocker = run.kind === 'docker';

    if (
      isDocker
        ? RUNNER_GOING_STATES.includes(run.status)
        : isCiRunInProgress(run)
    ) {
      throw new ConflictException({
        code: 'RUN_IN_PROGRESS',
        message:
          'This run is still going. Stop it or wait for it to finish, then delete it.',
      });
    }

    const { data, error } = await this.client
      .from('test_automation_runs')
      .delete()
      .eq('id', runId)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .eq('kind', isDocker ? 'docker' : 'ci_job')
      .select('id')
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'delete automation run', error);
    if (!data) throw notFound();

    if (isDocker && run.run_zip_path) await this.removeZip(run.run_zip_path);

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_run',
      runId,
      'delete',
      {
        config_name: run.config_name,
        status: run.status,
        error_code: run.error_code,
      },
    );
  }

  async list(
    organizationId: string,
    spaceId: string,
    query: ListTestAutomationRunsQueryDto,
  ): Promise<TestPlanPage<TestAutomationRun>> {
    await this.access.assertAvailable(organizationId, spaceId);

    const runs = (columns: string, head = false) => {
      let builder = this.client
        .from('test_automation_runs')
        .select(columns, { count: 'exact', head })
        .eq('organization_id', organizationId)
        .eq('space_id', spaceId);

      if (query.kind !== 'all') {
        builder = builder.eq('kind', query.kind ?? 'ci_job');
      }

      if (query.executionId) {
        builder = builder.eq('execution_id', query.executionId);
      }

      if (query.planId) builder = builder.eq('plan_id', query.planId);
      if (query.configId) builder = builder.eq('config_id', query.configId);

      if (query.startedBy) {
        builder = builder.eq('started_by', query.startedBy);
      }

      if (query.status?.length) builder = builder.in('status', query.status);

      return builder;
    };

    const [field, direction] = (query.sort ?? '').split(':');
    const sortColumns = RUN_SORT_COLUMNS.get(field) ?? ['created_at'];

    // Newest first unless a known field asks otherwise.
    const ascending = direction === 'asc';

    const page = await fetchPage<RunListRow>(
      this.logger,
      'list automation runs',
      query,
      (from, to) => {
        let builder = runs(RUN_LIST_COLUMNS);

        for (const column of sortColumns) {
          builder = builder.order(column, { ascending });
        }

        // Ties follow the chosen direction by run number, runs without one last; start time keeps pages stable.
        return builder
          .order('run_no', { ascending, nullsFirst: false })
          .order('created_at', { ascending })
          .range(from, to);
      },
      () => runs('id', true),
    );

    return {
      ...page,
      items: page.items.map((row) => ({
        ...toRun(row),
        result_summary: listedSummary(row.result_summary),
        target_key: row.execution?.task?.key ?? row.plan?.task?.key ?? null,
        // Who started it, for the run history's "Started by" column.
        started_by: row.started_by,
      })),
    };
  }

  async get(
    organizationId: string,
    spaceId: string,
    runId: string,
  ): Promise<TestAutomationRun> {
    await this.access.assertAvailable(organizationId, spaceId);

    const row = (await this.load(
      organizationId,
      spaceId,
      runId,
      RUN_LIST_COLUMNS,
    )) as unknown as RunListRow;

    // The same key the list shows, so a run opened on its own still names its execution or plan.
    return {
      ...toRun(row),
      target_key: row.execution?.task?.key ?? row.plan?.task?.key ?? null,
    };
  }

  /** Jobs of the workflow a CI run started; none when the run has no workflow to follow. */
  async ciJobs(
    organizationId: string,
    spaceId: string,
    runId: string,
  ): Promise<GithubJob[]> {
    await this.access.assertAvailable(organizationId, spaceId);

    const run = await this.load(organizationId, spaceId, runId);

    return run.kind === 'docker' ? [] : this.ciWatcher.jobs(run);
  }

  async ciJobLog(
    organizationId: string,
    spaceId: string,
    runId: string,
    jobId: string,
  ): Promise<TestAutomationCiJobLog> {
    await this.access.assertAvailable(organizationId, spaceId);

    return this.ciWatcher.jobLog(
      await this.load(organizationId, spaceId, runId),
      jobId,
    );
  }

  /** Generic and Cucumber are the automated kinds; the same rule the test case list filters by. */
  async testCounts(
    organizationId: string,
    spaceId: string,
    query: TestAutomationTargetQueryDto,
  ): Promise<TestAutomationTestCounts> {
    await this.access.assertAvailable(organizationId, spaceId);

    const { data: settings, error: settingsError } = await this.client
      .from('test_management_space_settings')
      .select('test_types')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .maybeSingle<{ test_types: { id: string; kind: string }[] | null }>();

    if (settingsError) {
      throw tmDbError(this.logger, 'load test types', settingsError);
    }

    const automatedTypes = (settings?.test_types ?? [])
      .filter((type) => type.kind === 'unstructured' || type.kind === 'gherkin')
      .map((type) => type.id);

    const table = query.target === 'plan' ? 'test_plan_tests' : 'test_runs';
    const count = () =>
      this.client
        .from(table)
        .select(
          `case_id, test_case:test_cases!${table}_case_fkey!inner(test_type)`,
          { count: 'exact', head: true },
        )
        .eq(
          query.target === 'plan' ? 'plan_id' : 'execution_id',
          query.target_id,
        )
        .eq('test_case.organization_id', organizationId)
        .eq('test_case.space_id', spaceId)
        .eq('test_case.is_archived', false);

    const all = await count();

    if (all.error) throw tmDbError(this.logger, 'count tests', all.error);
    if (automatedTypes.length === 0) {
      return { total: all.count ?? 0, automated: 0 };
    }

    const automated = await count().in('test_case.test_type', automatedTypes);

    if (automated.error) {
      throw tmDbError(this.logger, 'count automated tests', automated.error);
    }

    return { total: all.count ?? 0, automated: automated.count ?? 0 };
  }

  /** A CI tool's answer can echo what was sent to it, so only people who can read the setting see it. */
  async forViewer(
    user: RequestUser,
    spaceId: string,
    runs: TestAutomationRun[],
  ): Promise<TestAutomationRun[]> {
    if (!runs.some((run) => run.kind !== 'docker' && run.error_message)) {
      return runs;
    }

    const canRead = await this.permissions.hasSpacePermission(
      user.userId,
      user.organizationId,
      spaceId,
      'edit_space_settings',
    );

    // The runner masks its own errors, so only a CI tool's answer is hidden.
    return canRead
      ? runs
      : runs.map((run) =>
          run.kind === 'docker' ? run : { ...run, error_message: null },
        );
  }

  /** Where a run's upload records; null when the run is not in this space. */
  async uploadTarget(
    user: RequestUser,
    spaceId: string,
    runId: string,
  ): Promise<{ executionId: string | null; planId: string | null } | null> {
    const { data, error } = await this.client
      .from('test_automation_runs')
      .select('execution_id, plan_id')
      .eq('id', runId)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .eq('kind', 'ci_job')
      .maybeSingle<{ execution_id: string | null; plan_id: string | null }>();

    if (error) throw tmDbError(this.logger, 'load automation run', error);

    return data
      ? { executionId: data.execution_id, planId: data.plan_id }
      : null;
  }

  /**
   * Marks a CI job that no workflow is followed for as finished, from the results its upload recorded. Only a
   * started job still waiting matches, in one conditional update; the upload itself never fails because of it.
   */
  async closeByUpload(
    user: RequestUser,
    spaceId: string,
    runId: string,
    executionId: string,
    result: Pick<JunitCommitResult, 'applied'>,
  ): Promise<{ closed: boolean; warning?: TransferIssue }> {
    const notClosable = {
      closed: false,
      warning: runWarning(
        'RUN_NOT_CLOSABLE',
        'The results are recorded, but this automation run is not one that waits for an upload, so it was left as it is',
      ),
    };

    try {
      const { data: run, error } = await this.client
        .from('test_automation_runs')
        .select('id, status, target, plan_id, execution_id, result_summary')
        .eq('id', runId)
        .eq('organization_id', user.organizationId)
        .eq('space_id', spaceId)
        .eq('kind', 'ci_job')
        .maybeSingle<CloseRow>();

      if (error) throw tmDbError(this.logger, 'load automation run', error);

      const summary = run?.result_summary ?? {};
      const ci = summary.ci as
        | { state?: string; run_id?: unknown }
        | null
        | undefined;

      // A followed GitHub run records its own results.
      if (
        !run ||
        run.status !== 'REQUESTED' ||
        summary.send_pending === true ||
        typeof ci?.run_id === 'number'
      ) {
        return notClosable;
      }

      if (ci && ci.state !== 'untracked') {
        return {
          closed: false,
          warning: runWarning(
            'RUN_ALREADY_CLOSED',
            'The results are recorded; this automation run was already finished',
          ),
        };
      }

      const gone = {
        closed: false,
        warning: runWarning(
          'RUN_TARGET_GONE',
          "The results are recorded, but the automation run's test execution or plan no longer exists",
        ),
      };

      if (run.execution_id === null) {
        if (run.target === 'execution' || run.plan_id === null) return gone;
        if (
          !(await this.executionInPlan(user, spaceId, executionId, run.plan_id))
        ) {
          return notClosable;
        }
      } else if (run.execution_id !== executionId) {
        return notClosable;
      }

      const tally = await this.uploadTally(user, spaceId, executionId, result);
      const state = tally.counts.failed > 0 ? 'failed' : 'passed';
      let update = this.client
        .from('test_automation_runs')
        .update({
          result_summary: {
            ...summary,
            ...tally,
            ci: { ...(ci ?? {}), state, closed_by: 'upload' },
          },
          finished_at: new Date().toISOString(),
          ...(run.execution_id === null ? { execution_id: executionId } : {}),
        })
        .eq('id', runId)
        .eq('organization_id', user.organizationId)
        .eq('space_id', spaceId)
        .eq('kind', 'ci_job')
        .eq('status', 'REQUESTED')
        .or(
          'result_summary->>send_pending.is.null,result_summary->>send_pending.neq.true',
        )
        .or(
          'result_summary->ci.is.null,result_summary->ci->>state.eq.untracked',
        )
        .is('result_summary->ci->run_id', null);

      update =
        run.execution_id === null
          ? update.is('execution_id', null)
          : update.eq('execution_id', executionId);

      const { data: closed, error: closeError } = await update
        .select('id')
        .maybeSingle();

      if (closeError) {
        throw tmDbError(this.logger, 'close automation run', closeError);
      }

      // Another upload of the same job got there first.
      if (!closed) {
        return {
          closed: false,
          warning: runWarning(
            'RUN_ALREADY_CLOSED',
            'The results are recorded; this automation run was already finished',
          ),
        };
      }

      const apiKeyId = user.appMetadata?.tm_api_key_id;

      void this.auditLogs.logActionForRequest(
        user,
        'test_automation_run',
        runId,
        'update',
        {
          action: 'close_by_upload',
          execution_id: executionId,
          state,
          ...(typeof apiKeyId === 'string' ? { tm_api_key_id: apiKeyId } : {}),
        },
      );

      return { closed: true };
    } catch (error) {
      this.logger.warn(
        `Automation run ${runId} was not closed by its upload: ${error instanceof Error ? error.message : String(error)}`,
      );

      return notClosable;
    }
  }

  private async executionInPlan(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    planId: string,
  ): Promise<boolean> {
    const { data, error } = await this.client
      .from('test_executions')
      .select('plan_id')
      .eq('id', executionId)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .maybeSingle<{ plan_id: string | null }>();

    if (error) throw tmDbError(this.logger, 'load test execution', error);

    return data?.plan_id === planId;
  }

  /** Counts and names as the watcher keeps them: this upload's results, or for a repaired upload the execution's. */
  private async uploadTally(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    result: Pick<JunitCommitResult, 'applied'>,
  ): Promise<{
    counts: { total: number; passed: number; failed: number; skipped: number };
    tests: { name: string; status: string }[];
  }> {
    const { data, error } = await this.client
      .from('test_runs')
      .select(
        'id, current_attempt_no, ' +
          `case:test_cases!test_runs_case_fkey(${ticketEmbed('test_cases', 'summary')}), ` +
          'attempts:test_run_attempts!test_run_attempts_run_fkey(attempt_no, status)',
      )
      .eq('execution_id', executionId)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .range(0, TEST_EXECUTION_LIMITS.runs - 1)
      .returns<TallyRow[]>();

    if (error) throw tmDbError(this.logger, 'count upload results', error);

    const applied = new Map(result.applied.map((a) => [a.run_id, a.status]));
    const counts = { total: 0, passed: 0, failed: 0, skipped: 0 };
    const tests: { name: string; status: string }[] = [];

    for (const row of data ?? []) {
      const status =
        result.applied.length > 0
          ? applied.get(row.id)
          : row.attempts?.find((a) => a.attempt_no === row.current_attempt_no)
              ?.status;

      if (!status || status === 'TODO') continue;

      const listed = UPLOAD_STATUS[status] ?? 'skipped';

      counts.total += 1;
      counts[listed] += 1;

      if (tests.length < MAX_LISTED_TESTS) {
        tests.push({
          name: Array.from(
            ticketName(row.case?.task.summary ?? '').replace(/\p{Cc}/gu, ''),
          )
            .slice(0, MAX_TEST_NAME_LENGTH)
            .join(''),
          status: listed,
        });
      }
    }

    return { counts, tests };
  }

  /** Names only, for people who can start runs. A Git setting has no list: its code isn't here until a run clones it. */
  async specFiles(
    user: RequestUser,
    spaceId: string,
    configId: string,
    query: ListTestAutomationSpecFilesQueryDto,
  ): Promise<TestAutomationSpecFiles> {
    await this.access.assertAvailable(user.organizationId, spaceId);

    // The route needs execute_tests; starting automation also needs the right to manage runs.
    await this.assertRight(
      user,
      spaceId,
      'manage_test_runs',
      'Starting automation needs the right to manage test runs',
    );

    const config = await this.use(this.configs).findRow(
      user.organizationId,
      spaceId,
      configId,
    );

    if (config.kind !== 'docker') {
      throw new BadRequestException({
        code: 'NOT_A_RUNNER_SETTING',
        message: 'This setting starts a CI job, not a run on the runner',
      });
    }

    const ownCommand = config.preset === 'custom' || Boolean(config.command);
    const linked =
      query.target && query.target_id
        ? await this.linkedSpecFiles(
            user.organizationId,
            spaceId,
            query.target,
            query.target_id,
          )
        : [];

    if (config.source !== 'zip') {
      return { files: [], linked, own_command: ownCommand };
    }

    if (config.preset === 'auto' && config.zip_path) {
      const detectedFiles = await this.autoSpecFiles(config, config.zip_path);

      return {
        files: detectedFiles,
        linked: linked.filter((file) => detectedFiles.includes(file)),
        own_command: ownCommand,
      };
    }

    const paths = config.zip_path
      ? await this.use(this.configs).zipFilePaths(config.zip_path)
      : [];
    const files = config.zip_path
      ? specFilesIn(paths, config.preset ?? 'custom', config.work_dir)
      : [];

    // A linked file that can't be listed could never be unticked again.
    return {
      files,
      linked: linked.filter((file) => files.includes(file)),
      own_command: ownCommand,
      // A zip saved before empty ones were refused has nothing to run.
      ...(config.zip_path && paths.length === 0 ? { empty: true } : {}),
    };
  }

  /** Waiting runs end at once; running ones are asked to stop. */
  private async cancelRunner(
    user: RequestUser,
    spaceId: string,
    first: RunWithZip,
  ): Promise<TestAutomationRun> {
    let run = first;

    if (run.status === 'QUEUED') {
      const cancelled = await this.cancelQueued(user, spaceId, run);

      if (cancelled) return cancelled;

      // The runner took it between the read and the write.
      run = await this.load(
        user.organizationId,
        spaceId,
        run.id,
        RUN_WITH_ZIP_COLUMNS,
      );
    }

    if (run.status === 'CANCELLED') return toRun(run);
    if (run.status !== 'RUNNING') throw notCancellable();
    if (run.cancel_requested_at) return toRun(run);

    // The result is decided by then, so there is nothing left to stop.
    if (run.result_summary?.stage === 'cleaning_up') throw notCancellable();

    const { data, error } = await this.client
      .from('test_automation_runs')
      .update({ cancel_requested_at: new Date().toISOString() })
      .eq('id', run.id)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .eq('status', 'RUNNING')
      .is('cancel_requested_at', null)
      .select(RUN_COLUMNS)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'cancel automation run', error);

    if (!data) {
      const latest = await this.load(user.organizationId, spaceId, run.id);

      if (latest.status === 'RUNNING' || latest.status === 'CANCELLED') {
        return toRun(latest);
      }

      throw notCancellable();
    }

    this.logCancel(user, run.id, 'RUNNING');

    return toRun(data as unknown as RunRow);
  }

  private async assertRight(
    user: RequestUser,
    spaceId: string,
    permission: string,
    message: string,
  ): Promise<void> {
    const allowed = await this.permissions.hasSpacePermission(
      user.userId,
      user.organizationId,
      spaceId,
      permission,
    );

    if (!allowed) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message });
    }
  }

  /** Everything saved earlier is checked again: a host, an image or a right may have changed since. */
  private async assertRunnable(
    user: RequestUser,
    spaceId: string,
    config: TestAutomationConfigRow,
  ): Promise<CustomImageRow | null> {
    if (config.archived_at) {
      throw new ConflictException({
        code: 'ARCHIVED',
        message: 'The automation setting is archived',
      });
    }

    if (config.kind !== 'docker') {
      throw new BadRequestException({
        code: 'NOT_A_RUNNER_SETTING',
        message: 'This setting starts a CI job, not a run on the runner',
      });
    }

    if (config.create_unmatched) {
      await this.assertRight(
        user,
        spaceId,
        'create_tests',
        'This setting creates test cases, which needs the right to create tests',
      );
    }

    if (config.source === 'zip' && !config.zip_path) {
      throw new BadRequestException({
        code: 'ZIP_MISSING',
        message: 'Upload the test project as a zip first',
      });
    }

    let ownImage: CustomImageRow | null = null;

    // A setting with the user's own image runs only that image, once it is approved.
    if (isOwnImageKey(config.image_key)) {
      if (!this.customImages) throw imageNotRunnable(null);

      ownImage = await this.customImages.runnableImage(
        user.organizationId,
        config.id,
      );

      // A space that asks for approval runs only images it approved.
      await this.imageApprovals?.assertApprovedHere(user, spaceId, ownImage.id);
    }

    // The image of an auto setting is chosen when the run starts.
    const autoImage =
      config.preset === 'auto' &&
      config.image_key === AUTO_IMAGE_KEY &&
      runnerEnabled();

    if (
      !autoImage &&
      !ownImage &&
      !availableRunnerImages().some((image) => image.key === config.image_key)
    ) {
      throw new BadRequestException({
        code: 'IMAGE_NOT_ALLOWED',
        message: 'The runner image of this setting is no longer allowed',
      });
    }

    if (config.source === 'git' && config.repo_url) {
      await checkRepoUrl(config.repo_url);
    }

    await checkHosts(config.allowed_hosts);

    return ownImage;
  }

  /** Refused here too, because a reused execution never reaches the database function that checks this. */
  private async runnableCase(
    organizationId: string,
    spaceId: string,
    caseId: string,
  ): Promise<{ automation_spec_path: string | null }> {
    const { data, error } = await this.client
      .from('test_cases')
      .select('is_archived, readiness, automation_spec_path')
      .eq('id', caseId)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .maybeSingle<{
        is_archived: boolean;
        readiness: string;
        automation_spec_path: string | null;
      }>();

    if (error) throw tmDbError(this.logger, 'load test case', error);
    if (!data) throw notFound({ case_id: caseId });

    if (data.is_archived) {
      throw new ConflictException({
        code: 'ARCHIVED',
        message: 'The test case is archived',
      });
    }

    if (data.readiness === 'deprecated') {
      throw invalid('case_id', 'A deprecated test case cannot be run');
    }

    return data;
  }

  /** The execution of an earlier run of this case and setting; an archived or deleted one doesn't count. */
  private async caseExecutionId(
    organizationId: string,
    spaceId: string,
    configId: string,
    caseId: string,
    executionId?: string,
  ): Promise<string | null> {
    let query = this.client
      .from('test_automation_runs')
      .select(
        'execution_id, execution:test_executions!test_automation_runs_execution_fkey!inner(id)',
      )
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('config_id', configId)
      .eq('target', 'execution')
      .eq('result_summary->>case_id', caseId)
      .eq('execution.is_archived', false);

    if (executionId) query = query.eq('execution_id', executionId);

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle<{ execution_id: string }>();

    if (error) throw tmDbError(this.logger, 'find case execution', error);

    return data?.execution_id ?? null;
  }

  /** One execution per case and setting, so a case's runs stay together; Run now makes the first one with its ticket. */
  private async caseExecution(
    user: RequestUser,
    spaceId: string,
    configId: string,
    caseId: string,
    requestId: string,
    restartedId: string | null,
  ): Promise<{ id: string; created: boolean }> {
    const reused =
      restartedId ??
      (await this.caseExecutionId(
        user.organizationId,
        spaceId,
        configId,
        caseId,
      ));

    if (!reused) {
      const made = await this.use(this.executions).runNow(
        user,
        spaceId,
        caseId,
        {
          request_id: requestId,
        },
      );

      return { id: made.execution_id, created: !made.replayed };
    }

    // Puts the case's run back if someone removed it; the database skips it when it is still there.
    await this.use(this.testRuns).addRuns(user, spaceId, reused, [caseId]);

    return { id: reused, created: false };
  }

  /** Only an execution this request made, and only while nothing else uses it; removing it refuses when it has results. */
  private async removeNewExecution(
    user: RequestUser,
    spaceId: string,
    executionId: string,
  ): Promise<void> {
    try {
      const { count, error } = await this.client
        .from('test_automation_runs')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', user.organizationId)
        .eq('space_id', spaceId)
        .eq('execution_id', executionId);

      if (error) throw new Error(error.message);
      if (count) return;

      await this.use(this.executions).remove(user, spaceId, executionId, false);
    } catch (error) {
      this.logger.warn(
        `Execution ${executionId} of a run that was not saved was kept: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Files that exist can still be useless to a framework, and Surefire only takes class names. */
  private assertFitsFramework(
    config: TestAutomationConfigRow,
    specFiles: string[],
  ): void {
    if (
      config.preset === 'maven' &&
      !config.command &&
      specFiles.some((file) => mavenTestNames([file]).length === 0)
    ) {
      throw invalid(
        'spec_files',
        'Select .java or .kt test classes for this setting',
      );
    }
  }

  /** The copy has no row yet, so nothing else would ever remove it. */
  private async assertSpecFilesInZip(
    config: TestAutomationConfigRow,
    path: string,
    specFiles: string[],
  ): Promise<void> {
    try {
      if (config.preset === 'auto') {
        const allowed = await this.autoSpecFiles(config, path);
        const unknown = specFiles.filter((file) => !allowed.includes(file));

        if (unknown.length > 0) {
          throw new BadRequestException({
            code: 'SPEC_NOT_FOUND',
            message: `Not test files of the detected framework: ${unknown.join(', ')}`,
          });
        }

        return;
      }

      const names = new Set(
        (await this.use(this.configs).zipFilePaths(path)).map(cleanProjectPath),
      );
      const folder = cleanProjectPath(config.work_dir ?? '');
      const missing = specFiles.filter(
        (file) => !names.has(folder ? `${folder}/${file}` : file),
      );

      if (missing.length > 0) {
        throw new BadRequestException({
          code: 'SPEC_NOT_FOUND',
          message: `Not in the test project: ${missing.join(', ')}`,
        });
      }
    } catch (error) {
      await this.removeZip(path);

      throw error;
    }
  }

  /** The test files of the framework a zip uses, or any Node.js test file while none is found. */
  private async autoSpecFiles(
    config: TestAutomationConfigRow,
    path: string,
  ): Promise<string[]> {
    const { files, detected } = await this.use(this.configs).zipFramework(
      path,
      config.work_dir,
    );

    return specFilesIn(
      files,
      detected && 'preset' in detected ? detected.preset : 'auto',
      config.work_dir,
    );
  }

  /** Files linked from the test cases of a plan or execution. */
  private async linkedSpecFiles(
    organizationId: string,
    spaceId: string,
    target: 'plan' | 'execution',
    targetId: string,
  ): Promise<string[]> {
    const table = target === 'plan' ? 'test_plan_tests' : 'test_runs';

    // Capped at 1000 rows by the API; page it if a target with more cases needs every link.
    const { data, error } = await this.client
      .from(table)
      .select(
        `test_case:test_cases!${table}_case_fkey!inner(automation_spec_path)`,
      )
      .eq(target === 'plan' ? 'plan_id' : 'execution_id', targetId)
      .eq('test_case.organization_id', organizationId)
      .eq('test_case.space_id', spaceId)
      .eq('test_case.is_archived', false)
      .not('test_case.automation_spec_path', 'is', null);

    if (error) throw tmDbError(this.logger, 'list linked test files', error);

    const rows = (data ?? []) as unknown as {
      test_case: { automation_spec_path: string | null };
    }[];

    return [
      ...new Set(
        rows.flatMap((row) => row.test_case.automation_spec_path ?? []),
      ),
    ].sort();
  }

  /** One run of a setting at a time per execution, plan or test case; a second would test the same thing twice. */
  private async assertNotGoing(
    organizationId: string,
    spaceId: string,
    configId: string,
    dto: StartTestAutomationRunDto,
    targetId: string | null,
  ): Promise<void> {
    let query = this.client
      .from('test_automation_runs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('config_id', configId)
      .eq('kind', 'docker')
      .in('status', RUNNER_GOING_STATES);

    if (dto.case_id) query = query.eq('result_summary->>case_id', dto.case_id);
    else
      query = query.eq(
        dto.target === 'plan' ? 'plan_id' : 'execution_id',
        targetId ?? '',
      );

    const { count, error } = await query;

    if (error) throw tmDbError(this.logger, 'check a going run', error);

    if ((count ?? 0) > 0) {
      throw new ConflictException({
        code: 'RUN_ALREADY_GOING',
        message:
          'This automation is already running here. Wait for it to finish or stop it.',
      });
    }
  }

  private async assertQueueRoom(
    organizationId: string,
    spaceId: string,
  ): Promise<void> {
    const perOrg = readQueuePerOrg();
    const perSpace = readQueuePerSpace();
    const { data, count, error } = await this.client
      .from('test_automation_runs')
      .select('space_id', { count: 'exact' })
      .eq('organization_id', organizationId)
      .eq('status', 'QUEUED')
      .limit(perOrg);

    if (error) throw tmDbError(this.logger, 'count waiting runs', error);

    if ((count ?? 0) >= perOrg) {
      throw new ConflictException({
        code: 'QUEUE_FULL',
        message: `At most ${perOrg} runs can wait at a time. Try again when some have finished.`,
      });
    }

    const inSpace = ((data ?? []) as { space_id: string }[]).filter(
      (row) => row.space_id === spaceId,
    ).length;

    if (inSpace >= perSpace) {
      throw new ConflictException({
        code: 'QUEUE_FULL',
        message: `At most ${perSpace} runs can wait in this space at a time. Try again when some have finished.`,
      });
    }
  }

  /** The run gets its own copy, so replacing the setting's zip does not change a waiting run. */
  private async copyZip(
    user: RequestUser,
    spaceId: string,
    config: TestAutomationConfigRow,
    runId: string,
  ): Promise<string | null> {
    if (config.source !== 'zip' || !config.zip_path) return null;

    const path = `automation/${user.organizationId}/${spaceId}/${config.id}/runs/${runId}.zip`;
    const { error } = await this.client.storage
      .from(AUTOMATION_BUCKET)
      .copy(config.zip_path, path);

    if (error) {
      this.logger.error(
        `Failed to copy the automation zip of ${config.id}`,
        error,
      );

      throw new ServiceUnavailableException({
        code: 'ZIP_COPY_FAILED',
        message: 'The test project could not be prepared, please try again',
      });
    }

    return path;
  }

  private async cancelQueued(
    user: RequestUser,
    spaceId: string,
    run: RunWithZip,
  ): Promise<TestAutomationRun | null> {
    const { data, error } = await this.client
      .from('test_automation_runs')
      .update({
        status: 'CANCELLED',
        finished_at: new Date().toISOString(),
        run_zip_path: null,
      })
      .eq('id', run.id)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .eq('status', 'QUEUED')
      .select(RUN_COLUMNS)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'cancel automation run', error);
    if (!data) return null;

    if (run.run_zip_path) await this.removeZip(run.run_zip_path);

    this.logCancel(user, run.id, 'QUEUED');

    return toRun(data as unknown as RunRow);
  }

  private logCancel(user: RequestUser, runId: string, from: string): void {
    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_run',
      runId,
      'update',
      { cancelled: true, from_status: from },
    );
  }

  private async load(
    organizationId: string,
    spaceId: string,
    runId: string,
    columns = RUN_COLUMNS,
  ): Promise<RunWithZip> {
    const { data, error } = await this.client
      .from('test_automation_runs')
      .select(columns)
      .eq('id', runId)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load automation run', error);
    if (!data) throw notFound();

    return data as unknown as RunWithZip;
  }

  private async removeZip(path: string): Promise<void> {
    const { error } = await this.client.storage
      .from(AUTOMATION_BUCKET)
      .remove([path]);

    if (error) {
      this.logger.warn(
        `Failed to remove automation zip ${path}: ${error.message}`,
      );
    }
  }
}
