import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { CiServersService } from '../../ci-servers/ci-servers.service';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import type { JunitCommitResult } from '../dto/test-transfer.dto';
import { TestExecutionsService } from '../executions/test-executions.service';
import { TestPlanTestsService } from '../plans/test-plan-tests.service';
import { TestRunsService } from '../runs/test-runs.service';
import {
  CucumberResultsService,
  FORMAT_LABELS,
} from '../transfer/cucumber-results/cucumber-results.service';
import { parseResultFile } from '../transfer/cucumber-results/junit.parser';
import {
  detectJsonFormat,
  detectXmlFormat,
  isJunitXml,
} from '../transfer/cucumber-results/result-format';
import { readZipEntries } from '../transfer/shared/zip-entries';
import {
  CI_GOING_STATES,
  hasAuthorization,
  invalid,
} from './automation-inputs';
import { RUN_COLUMNS, type RunRow } from './test-automation-ci.service';
import { readSecretMap } from './test-automation-configs.service';
import { TestAutomationGitService } from './test-automation-git.service';
import {
  cancelRun,
  downloadArtifact,
  getRun,
  GithubActionsError,
  listArtifacts,
  listRunJobs,
  readJobLog,
  runOrigin,
  type GithubAccess,
  type GithubJob,
  type GithubJobLog,
  type GithubRun,
  type GithubRunOrigin,
} from './test-automation-github.client';
import {
  cancelPipeline,
  downloadJobArtifacts,
  getPipeline,
  gitlabAccess,
  gitlabBearerAccess,
  gitlabPipelineAddress,
  hasPrivateToken,
  listPipelineJobs,
  readJobTrace,
  type CiToolAccess,
} from './test-automation-gitlab.client';
import {
  cancelQueueItem,
  jenkinsAccess,
  jenkinsBuildJob,
  jenkinsProgress,
  readConsole,
  stopBuild,
} from './test-automation-jenkins.client';

const BATCH = 50;
const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;

// Long enough for a slow import; after this a backend that restarted mid-way is taken over.
const CLAIM_EXPIRES_MS = 10 * 60 * 1000;

// Well past the 15 second limit on a CI request, so a run still being sent is never touched.
const UNSENT_AFTER_MS = 2 * 60 * 1000;
const CONNECTION_LOST =
  "The GitHub connection is unavailable, so this run can't be followed. It is checked again each minute for 24 hours.";
const MAX_ARTIFACTS = 10;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_ENTRIES = 5000;
const MAX_RESULT_FILES = 20;
const DROPPED_NAMES = 50;
const MAX_RESULT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_LEFT_OUT_SHOWN = 5;
const MAX_LISTED_TESTS = 500;
const MAX_TEST_NAME_LENGTH = 200;
const RESULT_RIGHTS = ['execute_tests', 'manage_test_runs'];

const LISTED_STATUS = {
  PASS: 'passed',
  FAIL: 'failed',
  BLOCKED: 'failed',
  SKIPPED: 'skipped',
} as const;

export type CiRunState =
  | 'untracked'
  | 'queued'
  | 'running'
  | 'importing'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'no_results'
  | 'results_failed'
  | 'lost';

interface CiSummary extends GithubRunOrigin {
  state: CiRunState;
  full_name: string;
  run_id: number;
  html_url: string;
  conclusion?: string | null;
  claimed_at?: string;
  message?: string;
}

interface ResultFile {
  name: string;
  buffer: Buffer;
}

interface FoundFiles {
  files: ResultFile[];
  leftOut: string[];
}

/** One zip of a run's saved files; null when there is none to read. */
interface ZipSource {
  name: string;
  read: () => Promise<Buffer | null>;
}

interface Recorded {
  state: CiRunState;
  message?: string;
  summary?: Record<string, unknown>;
}

// The state stays as it is: one large video artifact shouldn't turn a passing run red.
function withLeftOut(outcome: Recorded, leftOut: string[]): Recorded {
  if (leftOut.length === 0) return outcome;

  const shown = leftOut.slice(0, MAX_LEFT_OUT_SHOWN).join(', ');
  const more =
    leftOut.length > MAX_LEFT_OUT_SHOWN
      ? ` and ${leftOut.length - MAX_LEFT_OUT_SHOWN} more`
      : '';

  return {
    ...outcome,
    message: [outcome.message, `Left out: ${shown}${more}.`]
      .filter(Boolean)
      .join(' '),
  };
}

const ciOf = (row: RunRow): CiSummary | null => {
  const ci = row.result_summary?.ci as CiSummary | undefined;

  return ci && typeof ci.run_id === 'number' ? ci : null;
};

/** A GitLab pipeline or Jenkins build; a queued Jenkins build has no number yet. */
interface ToolCiSummary extends Omit<CiSummary, 'run_id' | 'html_url'> {
  provider: 'gitlab' | 'jenkins';
  run_id?: number;
  html_url?: string;
  project_id?: number;
  queue_url?: string;
}

// GitHub rows have no provider, so they never take the GitLab or Jenkins path.
const toolCiOf = (row: RunRow): ToolCiSummary | null => {
  const ci = row.result_summary?.ci as ToolCiSummary | undefined;

  return ci?.provider === 'gitlab' || ci?.provider === 'jenkins' ? ci : null;
};

const TOOL_ACCESS_LOST =
  "The setting's saved access details can't read this run, so it can't be followed. It is checked again each minute for 24 hours.";

/** A file the results service can read; screenshots and logs are left out. */
function isResultFile(buffer: Buffer): boolean {
  try {
    parseResultFile(buffer, { keepEvidence: false });

    return true;
  } catch {
    return false;
  }
}

function importCode(error: unknown): string {
  if (!(error instanceof HttpException)) return 'IMPORT_FAILED';

  const response = error.getResponse();

  return typeof response === 'object' &&
    'code' in response &&
    typeof response.code === 'string'
    ? response.code
    : 'IMPORT_FAILED';
}

/**
 * Follows workflows started through the GitHub connection, asking GitHub rather than waiting to be
 * called, so it needs no public address. A CI run's status stays REQUESTED by database rule; its
 * progress lives in result_summary.ci.
 */
@Injectable()
export class TestAutomationCiWatcherService {
  private readonly logger = new Logger(TestAutomationCiWatcherService.name);
  private busy = false;

  // Where the last check stopped, so a long list can't keep newer runs waiting.
  private cursor: string | null = null;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly git: TestAutomationGitService,
    private readonly access: TestManagementAccessService,
    private readonly permissions: PermissionsService,
    private readonly results: CucumberResultsService,
    private readonly executions: TestExecutionsService,
    private readonly runs: TestRunsService,
    private readonly planTests: TestPlanTestsService,
    @Optional() private readonly ciServers?: CiServersService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'tm-automation-ci-watcher' })
  async watch(): Promise<void> {
    if (this.busy) return;

    this.busy = true;

    try {
      await this.closeUnsent();

      let query = this.client
        .from('test_automation_runs')
        .select(RUN_COLUMNS)
        .eq('kind', 'ci_job')
        .eq('status', 'REQUESTED')
        .in('result_summary->ci->>state', CI_GOING_STATES);

      if (this.cursor) query = query.gt('created_at', this.cursor);

      const { data, error } = await query
        .order('created_at', { ascending: true })
        .limit(BATCH);

      if (error) throw new Error(error.message);

      const rows = (data ?? []) as unknown as RunRow[];

      this.cursor = rows.length === BATCH ? rows[BATCH - 1].created_at : null;

      for (const row of rows) {
        try {
          await this.follow(row);
        } catch (failure) {
          // The next tick tries again; one run must not stop the others.
          this.logger.warn(
            `Could not follow CI run ${row.id}: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error('Failed to follow CI runs', error);
    } finally {
      this.busy = false;
    }
  }

  /** A run saved but never confirmed as sent would otherwise read "Sent to CI" for ever. */
  private async closeUnsent(): Promise<void> {
    const { error } = await this.client
      .from('test_automation_runs')
      .update({
        status: 'ERROR',
        error_code: 'CI_INTERRUPTED',
        error_message:
          'This run was never confirmed as sent to the CI tool. Run it again.',
        result_summary: {},
      })
      .eq('kind', 'ci_job')
      .eq('status', 'REQUESTED')
      .eq('result_summary->>send_pending', 'true')
      .lt('created_at', new Date(Date.now() - UNSENT_AFTER_MS).toISOString());

    if (error) throw new Error(error.message);
  }

  private async follow(row: RunRow): Promise<void> {
    const tool = toolCiOf(row);

    if (tool) return this.followTool(row, tool);

    const ci = ciOf(row);

    if (!ci) return;

    const claimedRecently =
      ci.state === 'importing' &&
      ci.claimed_at &&
      Date.now() - Date.parse(ci.claimed_at) < CLAIM_EXPIRES_MS;

    if (claimedRecently) return;

    if (Date.now() - Date.parse(row.created_at) > GIVE_UP_AFTER_MS) {
      await this.save(row, ci, {
        state: 'lost',
        message:
          ci.message === CONNECTION_LOST
            ? 'The GitHub connection stayed unavailable for 24 hours, so the result of this run was never read'
            : 'GitHub gave no final result within 24 hours',
      });

      return;
    }

    const match = await this.git.findRepositoryByName(
      row.organization_id,
      ci.full_name,
    );

    // A suspended connection may come back, so this waits until the limit above.
    if (match.state !== 'connected') {
      if (ci.message !== CONNECTION_LOST && ci.state !== 'importing') {
        await this.save(row, ci, { state: ci.state, message: CONNECTION_LOST });
      }

      return;
    }

    const access = await this.git.actionsAccess(match);
    let remote: GithubRun;

    try {
      remote = await getRun(access, ci.run_id);
    } catch (error) {
      if (error instanceof GithubActionsError && error.status === 404) {
        await this.save(row, ci, {
          state: 'lost',
          message: 'GitHub no longer knows this run',
        });

        return;
      }

      throw error;
    }

    // The commit, branch and attempt, kept so the run can show where it came from.
    const origin = runOrigin(remote);
    const originChanged = (
      Object.keys(origin) as (keyof GithubRunOrigin)[]
    ).some((name) => ci[name] !== origin[name]);
    const followed: CiSummary = { ...ci, ...origin };

    if (remote.status !== 'completed') {
      const state: CiRunState =
        remote.status === 'in_progress' ? 'running' : 'queued';

      // Saving also clears the note of a connection that has come back.
      if (ci.state !== state || ci.message || originChanged) {
        await this.save(row, followed, { state });
      }

      return;
    }

    if (remote.conclusion === 'cancelled') {
      await this.save(
        row,
        { ...followed, conclusion: remote.conclusion },
        {
          state: 'cancelled',
        },
      );

      return;
    }

    const claimed = await this.claim(row, followed, remote.conclusion);

    if (!claimed) return;

    const recorded = await this.record(
      claimed,
      access,
      followed,
      remote.conclusion,
    );

    await this.save(
      claimed,
      { ...followed, conclusion: remote.conclusion },
      recorded,
    );
  }

  /** Only one backend instance gets past this for a run, so results are never recorded twice. */
  private async claim(
    row: RunRow,
    ci: CiSummary | ToolCiSummary,
    conclusion: string | null,
  ): Promise<RunRow | null> {
    let query = this.client
      .from('test_automation_runs')
      .update({
        result_summary: {
          ...row.result_summary,
          ci: {
            ...ci,
            state: 'importing',
            conclusion,
            claimed_at: new Date().toISOString(),
          },
        },
      })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id)
      .eq('status', 'REQUESTED')
      .eq('result_summary->ci->>state', ci.state);

    if (ci.claimed_at) {
      query = query.eq('result_summary->ci->>claimed_at', ci.claimed_at);
    }

    const { data, error } = await query.select(RUN_COLUMNS).maybeSingle();

    if (error) throw new Error(error.message);

    return data as unknown as RunRow | null;
  }

  private async save(
    row: RunRow,
    ci: CiSummary | ToolCiSummary,
    outcome: Recorded,
  ): Promise<void> {
    const kept: Partial<CiSummary | ToolCiSummary> = { ...ci };

    delete kept.claimed_at;
    delete kept.message;

    const settled = !['queued', 'running'].includes(outcome.state);
    const { error } = await this.client
      .from('test_automation_runs')
      .update({
        result_summary: {
          ...row.result_summary,
          ...outcome.summary,
          ci: {
            ...kept,
            state: outcome.state,
            ...(outcome.message && { message: outcome.message }),
          },
        },
        ...(settled && { finished_at: new Date().toISOString() }),
      })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id);

    if (error) throw new Error(error.message);
  }

  /** The same rights a Docker run needs, read now because they can change while the workflow runs. */
  private async allowed(row: RunRow): Promise<boolean> {
    if (!row.started_by) return false;

    await this.access.assertAvailable(row.organization_id, row.space_id, {
      write: true,
    });

    for (const right of RESULT_RIGHTS) {
      const has = await this.permissions.hasSpacePermission(
        row.started_by,
        row.organization_id,
        row.space_id,
        right,
      );

      if (!has) return false;
    }

    return true;
  }

  private record(
    row: RunRow,
    access: GithubAccess,
    ci: CiSummary,
    conclusion: string | null,
  ): Promise<Recorded> {
    return this.recordFrom(
      row,
      () => this.resultFiles(access, ci.run_id),
      conclusion,
    );
  }

  private async recordFrom(
    row: RunRow,
    read: () => Promise<FoundFiles>,
    conclusion: string | null,
    source: 'workflow' | 'pipeline' = 'workflow',
  ): Promise<Recorded> {
    let allowed = false;

    try {
      allowed = await this.allowed(row);
    } catch (error) {
      // A fault on our side is tried again; only a real refusal may throw the results away.
      if (!(error instanceof HttpException) || error.getStatus() >= 500) {
        throw error;
      }

      allowed = false;
    }

    if (!allowed) {
      return {
        state: 'results_failed',
        message:
          'Results were not recorded, because the person who started the run no longer has the rights for it',
      };
    }

    if (!row.execution_id && !row.plan_id) {
      return {
        state: 'results_failed',
        message: 'The plan or execution of this run no longer exists',
      };
    }

    try {
      const { files, leftOut } = await read();

      if (files.length > 0) {
        return withLeftOut(await this.commit(row, files, conclusion), leftOut);
      }

      // With files left out the workflow did save something, so asking for an upload step would mislead.
      const unreadable = leftOut.length > 0;
      const hint =
        source === 'workflow'
          ? 'an upload-artifact step saves it'
          : 'its job keeps it as an artifact';

      return withLeftOut(
        conclusion === 'success'
          ? {
              state: 'no_results',
              message: unreadable
                ? `The ${source} saved no result file that could be read.`
                : `The ${source} saved no result file. Check that its tests write a JUnit or Cucumber file and that ${hint}.`,
            }
          : {
              state: 'failed',
              message: `The ${source} ended as ${conclusion ?? 'unknown'} and saved no ${unreadable ? 'readable ' : ''}result file`,
            },
        leftOut,
      );
    } catch (error) {
      // Anything else, such as GitHub being down, is tried again once the claim expires.
      if (error instanceof GithubActionsError && error.permanent) {
        return {
          state: 'results_failed',
          message: `The results could not be read: ${error.message}`,
        };
      }

      throw error;
    }
  }

  /** Any file in the artifacts that reads as a results format; screenshots and logs are left out. */
  private async resultFiles(
    access: GithubAccess,
    runId: number,
  ): Promise<FoundFiles> {
    const listed = await listArtifacts(access, runId);
    const usable = listed.filter(
      (artifact) =>
        !artifact.expired && artifact.size_in_bytes <= MAX_ARTIFACT_BYTES,
    );
    const artifacts = usable.slice(0, MAX_ARTIFACTS);
    const leftOut = [
      ...listed
        .filter((artifact) => !usable.includes(artifact))
        .map((artifact) => `${artifact.name} (expired or over the size limit)`),
      ...usable
        .slice(MAX_ARTIFACTS)
        .map(
          (artifact) => `${artifact.name} (past the first ${MAX_ARTIFACTS})`,
        ),
    ];

    return this.readZips(
      artifacts.map((artifact) => ({
        name: artifact.name,
        read: () => downloadArtifact(access, artifact.id, MAX_ARTIFACT_BYTES),
      })),
      leftOut,
    );
  }

  private async readZips(
    zips: ZipSource[],
    leftOut: string[],
  ): Promise<FoundFiles> {
    const files: ResultFile[] = [];

    for (const zip of zips) {
      const buffer = await zip.read();

      if (!buffer) continue;

      try {
        const { entries } = await readZipEntries(buffer, {
          maxEntries: MAX_ARTIFACT_ENTRIES,
          maxBytes: MAX_ARTIFACT_BYTES,
          accept: (name) => /\.(xml|json)$/i.test(name),
        });

        for (const entry of entries) {
          const name = entry.name.split('/').pop() ?? entry.name;

          if (entry.data.length > MAX_RESULT_FILE_BYTES) {
            leftOut.push(`${name} (over the file size limit)`);
            continue;
          }

          if (isResultFile(entry.data)) {
            if (files.length === MAX_RESULT_FILES) {
              leftOut.push(`result files past the first ${MAX_RESULT_FILES}`);

              return { files, leftOut };
            }

            files.push({ name, buffer: entry.data });
          } else {
            // Other XML and JSON, such as pom.xml, is simply not a report.
            const format = isJunitXml(entry.data)
              ? 'junit'
              : (detectXmlFormat(entry.data) ??
                (detectJsonFormat(entry.data) === 'xray' ? 'xray' : null));

            if (format) {
              leftOut.push(
                `${name} (a ${FORMAT_LABELS[format]} report that could not be read)`,
              );
            }
          }
        }
      } catch (error) {
        // An artifact that can't be unpacked is left out.
        this.logger.warn(
          `Artifact ${zip.name} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
        leftOut.push(`${zip.name} (could not be unpacked)`);
      }
    }

    return { files, leftOut };
  }

  private tally(files: ResultFile[]): Record<string, unknown> {
    const counts = { total: 0, passed: 0, failed: 0, skipped: 0 };
    const tests: { name: string; status: string }[] = [];

    for (const { buffer } of files) {
      try {
        const { items } = parseResultFile(buffer, { keepEvidence: false });

        for (const item of items) {
          const status = LISTED_STATUS[item.status];

          counts.total += 1;
          counts[status] += 1;

          if (tests.length < MAX_LISTED_TESTS) {
            tests.push({
              name: Array.from(item.name.replace(/\p{Cc}/gu, ''))
                .slice(0, MAX_TEST_NAME_LENGTH)
                .join(''),
              status,
            });
          }
        }
      } catch (error) {
        this.logger.warn(
          `A CI result file could not be counted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { counts, tests };
  }

  /** A plan run's execution is made here, as on the runner; the run's id makes a retry find it again. */
  private async executionFor(row: RunRow, user: RequestUser): Promise<string> {
    if (row.execution_id) return row.execution_id;

    const planId = row.plan_id as string;
    const name = row.config_name ?? 'CI';
    const created = await this.executions.createImport(user, row.space_id, {
      request_id: row.id,
      name: `Automation ${name} ${new Date().toISOString().slice(0, 10)}`.slice(
        0,
        255,
      ),
      description: null,
      plan_id: planId,
      environment: null,
    });

    await this.client
      .from('test_automation_runs')
      .update({ execution_id: created.execution_id })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id);

    const caseIds = await this.planTests.testIds(
      row.organization_id,
      row.space_id,
      planId,
    );

    if (caseIds.length > 0) {
      await this.runs.addRuns(
        user,
        row.space_id,
        created.execution_id,
        caseIds,
      );
    }

    return created.execution_id;
  }

  private async commit(
    row: RunRow,
    files: ResultFile[],
    conclusion: string | null,
  ): Promise<Recorded> {
    const user = {
      userId: row.started_by ?? '',
      organizationId: row.organization_id,
      authUserId: '',
      email: '',
      memberships: [],
    } as unknown as RequestUser;
    const tally = this.tally(files);
    const counts = {
      applied: 0,
      created: 0,
      dropped: { count: 0, names: [] as string[] },
    };
    const uploaded: string[] = [];
    const nothingToApply: string[] = [];
    const alreadyRecorded: string[] = [];
    const notKept: string[] = [];
    const warnings: unknown[] = [];
    let nothingReason: string | null = null;
    const summary = () => ({
      ...tally,
      import: {
        uploaded,
        nothing_to_apply: nothingToApply,
        ...counts,
        warnings,
        create_unmatched: false,
      },
    });
    let executionId: string | null = null;

    for (const file of files) {
      // Marked with this run, so a re-run's identical report is recorded. JSON can't carry the mark.
      const xml =
        isJunitXml(file.buffer) || detectXmlFormat(file.buffer) !== null;
      const buffer = xml
        ? Buffer.concat([
            file.buffer,
            Buffer.from(`\n<!-- xisuite-automation-run ${row.id} -->\n`),
          ])
        : file.buffer;

      try {
        executionId ??= await this.executionFor(row, user);

        const result: JunitCommitResult = await this.results.commit(
          user,
          row.space_id,
          executionId,
          {
            originalname: file.name,
            buffer,
            size: buffer.length,
            mimetype: 'application/xml',
          } as Express.Multer.File,
          { create_unmatched: false },
          { addInSpace: row.target === 'plan', noRerun: true },
        );

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

        uploaded.push(file.name);

        if (!result.file_saved) notKept.push(file.name);
      } catch (error) {
        const code = importCode(error);

        // A retry after a restart finds files it already recorded.
        if (code === 'IMPORT_ALREADY_APPLIED') {
          (xml ? uploaded : alreadyRecorded).push(file.name);
          continue;
        }

        if (code === 'NOTHING_TO_APPLY') {
          nothingToApply.push(file.name);
          nothingReason ??= error instanceof Error ? error.message : null;
          continue;
        }

        return {
          state: 'results_failed',
          message: `${uploaded.length} of ${files.length} result files were recorded: ${error instanceof Error ? error.message : 'Unknown problem'}`,
          summary: summary(),
        };
      }
    }

    const alreadyNote =
      alreadyRecorded.length > 0
        ? `Already recorded, so nothing new was added: ${alreadyRecorded.join(', ')}.`
        : null;

    if (uploaded.length === 0) {
      await this.removeEmptyPlanExecution(row, user, executionId);

      const nothingNote =
        nothingToApply.length > 0
          ? `No result file had a result to record: ${nothingReason}. Tests that aren't in Test Management yet are not created from CI runs. Add them first, or give them a test key or automation key.`
          : null;

      return {
        state: 'no_results',
        message: [nothingNote, alreadyNote].filter(Boolean).join(' '),
        summary: summary(),
      };
    }

    const failedTests = (tally.counts as { failed: number }).failed;
    const notKeptNote =
      notKept.length > 0
        ? `Results were recorded, but these report files could not be kept: ${notKept.join(', ')}.`
        : null;
    const message = [alreadyNote, notKeptNote].filter(Boolean).join(' ');

    return {
      state:
        conclusion === 'success' && failedTests === 0 ? 'passed' : 'failed',
      ...(message && { message }),
      summary: summary(),
    };
  }

  /** A plan run's execution exists only for its results; one the user chose is never removed. */
  private async removeEmptyPlanExecution(
    row: RunRow,
    user: RequestUser,
    executionId: string | null,
  ): Promise<void> {
    if (row.target !== 'plan' || !executionId) return;

    try {
      await this.executions.remove(user, row.space_id, executionId, false);
    } catch (error) {
      this.logger.warn(
        `Execution ${executionId} of a CI run with no results was kept: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Whether Stop can reach this run: started through the connection and not finished. */
  isCancellable(row: RunRow): boolean {
    const tool = toolCiOf(row);

    if (tool) {
      return (
        row.status === 'REQUESTED' &&
        (tool.state === 'queued' || tool.state === 'running')
      );
    }

    const ci = ciOf(row);

    return (
      row.status === 'REQUESTED' &&
      Boolean(ci) &&
      (ci?.state === 'queued' || ci?.state === 'running')
    );
  }

  /** Read from GitHub each time and never stored. GitHub's 401 and 403 are not passed on, so nobody is signed out. */
  async jobs(row: RunRow): Promise<GithubJob[]> {
    const tool = toolCiOf(row);

    if (tool) return this.toolJobs(row, tool);

    const ci = ciOf(row);

    if (!ci) return [];

    const match = await this.git.findRepositoryByName(
      row.organization_id,
      ci.full_name,
    );

    if (match.state !== 'connected') {
      throw new ConflictException({
        code: 'GIT_CONNECTION_UNAVAILABLE',
        message:
          'This repository is no longer available through the GitHub connection',
      });
    }

    try {
      return await listRunJobs(await this.git.actionsAccess(match), ci.run_id);
    } catch (error) {
      if (error instanceof GithubActionsError && error.status === 404) {
        throw new NotFoundException({
          code: 'CI_RUN_GONE',
          message: 'GitHub no longer has this run',
        });
      }

      this.logger.warn(
        `Could not read the jobs of run ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new ServiceUnavailableException({
        code: 'GITHUB_UNAVAILABLE',
        message: 'GitHub could not be reached. Try again.',
      });
    }
  }

  /** The end of one job's log, read from GitHub each time; only a job of this run can be read. */
  async jobLog(row: RunRow, jobId: string): Promise<GithubJobLog> {
    if (!/^\d{1,20}$/.test(jobId)) {
      throw invalid('jobId', 'Use the id of a job of this run');
    }

    const tool = toolCiOf(row);

    if (tool) return this.toolJobLog(row, tool, jobId);

    const ci = ciOf(row);

    if (!ci) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'This run has no workflow to read a log from',
      });
    }

    const match = await this.git.findRepositoryByName(
      row.organization_id,
      ci.full_name,
    );

    if (match.state !== 'connected') {
      throw new ConflictException({
        code: 'GIT_CONNECTION_UNAVAILABLE',
        message:
          'This repository is no longer available through the GitHub connection',
      });
    }

    let access: GithubAccess;
    let jobs: GithubJob[];

    try {
      access = await this.git.actionsAccess(match);
      jobs = await listRunJobs(access, ci.run_id);
    } catch (error) {
      if (error instanceof GithubActionsError && error.status === 404) {
        throw new NotFoundException({
          code: 'CI_RUN_GONE',
          message: 'GitHub no longer has this run',
        });
      }

      throw this.githubUnavailable(row, error);
    }

    // The id goes into GitHub's address, so only a job GitHub lists for this run is asked for.
    if (!jobs.some((job) => job.id === jobId)) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'This job is not part of the run',
      });
    }

    try {
      return await readJobLog(access, jobId);
    } catch (error) {
      if (
        error instanceof GithubActionsError &&
        (error.status === 404 || error.status === 410)
      ) {
        throw new NotFoundException({
          code: 'CI_LOG_NOT_AVAILABLE',
          message: 'This log is not available yet, or it has expired',
        });
      }

      throw this.githubUnavailable(row, error);
    }
  }

  // GitHub's 401 and 403 are not passed on, so nobody is signed out.
  private githubUnavailable(
    row: RunRow,
    error: unknown,
  ): ServiceUnavailableException {
    this.logger.warn(
      `Could not read a job log of run ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
    );

    return new ServiceUnavailableException({
      code: 'GITHUB_UNAVAILABLE',
      message: 'GitHub could not be reached. Try again.',
    });
  }

  /** Asks GitHub to stop the run; the next check sees it end. */
  async cancel(row: RunRow): Promise<RunRow> {
    const tool = toolCiOf(row);

    if (tool) return this.toolCancel(row, tool);

    const ci = ciOf(row);
    const match = ci
      ? await this.git.findRepositoryByName(row.organization_id, ci.full_name)
      : null;

    if (!ci || match?.state !== 'connected') {
      throw new ConflictException({
        code: 'GIT_CONNECTION_UNAVAILABLE',
        message:
          'This repository is no longer available through the GitHub connection',
      });
    }

    try {
      await cancelRun(await this.git.actionsAccess(match), ci.run_id);
    } catch (error) {
      if (error instanceof GithubActionsError && error.status === 403) {
        throw new ConflictException({
          code: 'GIT_ACTIONS_DENIED',
          message:
            'GitHub refused to stop the workflow. The GitHub App needs the Actions permission set to read and write.',
        });
      }

      throw new ConflictException({
        code: 'GIT_TOKEN_FAILED',
        message: 'GitHub could not stop the workflow right now',
      });
    }

    const { data, error } = await this.client
      .from('test_automation_runs')
      .update({ cancel_requested_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id)
      .select(RUN_COLUMNS)
      .single();

    if (error) throw new Error(error.message);

    return data as unknown as RunRow;
  }

  /** Jenkins keeps only the state, as its pipelines upload the results themselves; a finished GitLab pipeline is imported. */
  private async followTool(row: RunRow, ci: ToolCiSummary): Promise<void> {
    const label = ci.provider === 'gitlab' ? 'GitLab' : 'Jenkins';

    if (
      ci.state === 'importing' &&
      ci.claimed_at &&
      Date.now() - Date.parse(ci.claimed_at) < CLAIM_EXPIRES_MS
    ) {
      return;
    }

    if (Date.now() - Date.parse(row.created_at) > GIVE_UP_AFTER_MS) {
      await this.saveTool(row, ci, {
        state: 'lost',
        message:
          ci.message === TOOL_ACCESS_LOST
            ? "The setting's saved access details stayed unusable for 24 hours, so the end of this run was never read"
            : `${label} gave no final result within 24 hours`,
      });

      return;
    }

    const access = await this.toolAccess(row, ci);

    if (!access) {
      if (ci.message !== TOOL_ACCESS_LOST) {
        await this.saveTool(row, ci, {
          state: ci.state,
          message: TOOL_ACCESS_LOST,
        });
      }

      return;
    }

    let next: ToolCiSummary;

    try {
      next = await this.toolNow(access, ci);
    } catch (error) {
      if (
        error instanceof GithubActionsError &&
        (error.status === 404 || error.permanent)
      ) {
        await this.saveTool(row, ci, {
          state: 'lost',
          message:
            error.status === 404
              ? `${label} no longer knows this run`
              : error.message,
        });

        return;
      }

      throw error;
    }

    if (
      ci.provider === 'gitlab' &&
      (next.state === 'passed' || next.state === 'failed')
    ) {
      return this.importTool(row, ci, next, access);
    }

    const changed = (Object.keys(next) as (keyof ToolCiSummary)[]).some(
      (name) => next[name] !== ci[name],
    );

    // Saving also clears the note of access that has come back.
    if (changed || ci.message)
      await this.saveTool(row, next, { state: next.state });
  }

  /** A finished GitLab pipeline's results are read from its job artifacts, through the same claim as a GitHub run. */
  private async importTool(
    row: RunRow,
    read: ToolCiSummary,
    next: ToolCiSummary,
    access: CiToolAccess,
  ): Promise<void> {
    const conclusion = next.state === 'passed' ? 'success' : 'failed';

    // The claim must match the state stored, not the one GitLab reports now.
    const claimed = await this.claim(
      row,
      { ...next, state: read.state },
      conclusion,
    );

    if (!claimed) return;

    const recorded = await this.recordFrom(
      claimed,
      () => this.gitlabResultFiles(access, next),
      conclusion,
      'pipeline',
    );

    await this.save(claimed, { ...next, conclusion }, recorded);
  }

  /** The artifacts of the jobs that ran; a job that kept none is passed over. */
  private async gitlabResultFiles(
    access: CiToolAccess,
    ci: ToolCiSummary,
  ): Promise<FoundFiles> {
    if (!ci.project_id || !ci.run_id) return { files: [], leftOut: [] };

    const projectId = ci.project_id;
    const ran = (await listPipelineJobs(access, projectId, ci.run_id)).filter(
      (job) => job.conclusion === 'success' || job.conclusion === 'failure',
    );
    const leftOut = ran
      .slice(MAX_ARTIFACTS)
      .map((job) => `${job.name} (past the first ${MAX_ARTIFACTS} jobs)`);

    return this.readZips(
      ran.slice(0, MAX_ARTIFACTS).map((job) => ({
        name: job.name,
        read: async () => {
          try {
            return await downloadJobArtifacts(
              access,
              projectId,
              job.id,
              MAX_ARTIFACT_BYTES,
            );
          } catch (error) {
            // GitLab gives no size up front, so one large artifact is left out instead of failing the import.
            if (!(error instanceof GithubActionsError && error.permanent)) {
              throw error;
            }

            leftOut.push(`${job.name} (${error.message})`);

            return null;
          }
        },
      })),
      leftOut,
    );
  }

  /** Saves only if the state is still the one read, so a run closed meanwhile, such as by an upload, is kept. */
  private async saveTool(
    row: RunRow,
    ci: ToolCiSummary,
    outcome: Recorded,
  ): Promise<void> {
    const read = toolCiOf(row);
    const kept: Partial<ToolCiSummary> = { ...ci };

    delete kept.claimed_at;
    delete kept.message;

    const settled = !['queued', 'running'].includes(outcome.state);
    const { error } = await this.client
      .from('test_automation_runs')
      .update({
        result_summary: {
          ...row.result_summary,
          ci: {
            ...kept,
            state: outcome.state,
            ...(outcome.message && { message: outcome.message }),
          },
        },
        ...(settled && { finished_at: new Date().toISOString() }),
      })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id)
      .eq('status', 'REQUESTED')
      .eq('result_summary->ci->>state', read?.state ?? ci.state);

    if (error) throw new Error(error.message);
  }

  private async toolNow(
    access: CiToolAccess,
    ci: ToolCiSummary,
  ): Promise<ToolCiSummary> {
    if (ci.provider === 'jenkins') {
      return { ...ci, ...(await jenkinsProgress(access, ci)) };
    }

    if (!ci.project_id || !ci.run_id) return ci;

    return {
      ...ci,
      ...(await getPipeline(access, ci.project_id, ci.run_id)),
    };
  }

  /** Read now from the setting, so a token changed or removed since the start is respected. */
  private async toolAccess(
    row: RunRow,
    ci: ToolCiSummary,
  ): Promise<CiToolAccess | null> {
    if (!row.config_id) return null;

    const { data, error } = await this.client
      .from('test_automation_configs')
      .select('ci_url, ci_headers_enc')
      .eq('id', row.config_id)
      .eq('organization_id', row.organization_id)
      .eq('space_id', row.space_id)
      .maybeSingle();

    if (error) throw new Error(error.message);

    const config = data as {
      ci_url: string | null;
      ci_headers_enc: string | null;
    } | null;

    if (!config?.ci_url) return null;

    const stored = readSecretMap(config.ci_headers_enc);

    return ci.provider === 'jenkins'
      ? (jenkinsAccess(config.ci_url, stored, ci.queue_url ?? ci.html_url) ??
          this.jenkinsConnectionAccess(
            row.organization_id,
            config.ci_url,
            stored,
            ci.queue_url ?? ci.html_url,
          ))
      : (gitlabAccess(config.ci_url, stored, ci.html_url) ??
          this.gitlabConnectionAccess(
            row.organization_id,
            config.ci_url,
            stored,
            ci.html_url,
          ));
  }

  /** The login of the Jenkins server connected in Integrations, read per call; any failure reads as no access. */
  private async jenkinsConnectionAccess(
    organizationId: string,
    ciUrl: string,
    stored: Record<string, string>,
    runUrl: string | undefined,
  ): Promise<CiToolAccess | null> {
    if (!this.ciServers || hasAuthorization(stored)) return null;

    try {
      const server = await this.ciServers.findForJobUrl(organizationId, ciUrl);

      return server
        ? jenkinsAccess(
            ciUrl,
            { authorization: this.ciServers.authorizationFor(server) },
            runUrl,
          )
        : null;
    } catch (error) {
      this.logger.warn(
        `Could not read Jenkins through its connected server: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  /** A fresh token of the GitLab account connected in Integrations, per call; any failure reads as no access. */
  private async gitlabConnectionAccess(
    organizationId: string,
    ciUrl: string,
    stored: Record<string, string>,
    runUrl: string | undefined,
  ): Promise<CiToolAccess | null> {
    const address = gitlabPipelineAddress(ciUrl);

    if (
      !address ||
      !runUrl ||
      hasPrivateToken(stored) ||
      hasAuthorization(stored)
    ) {
      return null;
    }

    try {
      if (new URL(runUrl).origin !== new URL(address.base).origin) return null;

      const match = await this.git.gitlabCiConnection(organizationId, ciUrl);

      if (!match || match === 'unavailable') return null;

      return gitlabBearerAccess(
        address.base,
        await this.git.gitlabToken(organizationId, match.connection),
      );
    } catch (error) {
      this.logger.warn(
        `Could not read GitLab through its connection: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  private async requiredToolAccess(
    row: RunRow,
    ci: ToolCiSummary,
  ): Promise<CiToolAccess> {
    const access = await this.toolAccess(row, ci);

    if (!access) {
      throw new ConflictException({
        code: 'CI_ACCESS_UNAVAILABLE',
        message: "The setting's saved access details can't read this run",
      });
    }

    return access;
  }

  private toolJobList(
    access: CiToolAccess,
    ci: ToolCiSummary,
  ): Promise<GithubJob[]> {
    if (ci.provider === 'jenkins') {
      return ci.run_id && ci.html_url
        ? jenkinsBuildJob(access, ci.full_name, ci.run_id, ci.html_url).then(
            (job) => [job],
          )
        : Promise.resolve([]);
    }

    return ci.project_id && ci.run_id
      ? listPipelineJobs(access, ci.project_id, ci.run_id)
      : Promise.resolve([]);
  }

  // The tool's 401 and 403 are not passed on, so nobody is signed out.
  private toolReadFailure(
    row: RunRow,
    access: CiToolAccess,
    error: unknown,
  ): HttpException {
    if (error instanceof GithubActionsError && error.status === 404) {
      return new NotFoundException({
        code: 'CI_RUN_GONE',
        message: `${access.label} no longer has this run`,
      });
    }

    this.logger.warn(
      `Could not read CI run ${row.id} from ${access.label}: ${error instanceof Error ? error.message : String(error)}`,
    );

    // A rejected token isn't an outage, so the screen asks for a working one instead of a retry.
    if (
      error instanceof GithubActionsError &&
      (error.status === 401 || error.status === 403)
    ) {
      return new ConflictException({
        code: 'CI_ACCESS_UNAVAILABLE',
        message: `${access.label} refused the saved access details`,
      });
    }

    return new ServiceUnavailableException({
      code: 'CI_TOOL_UNAVAILABLE',
      message: `${access.label} could not be reached. Try again.`,
    });
  }

  private async toolJobs(row: RunRow, ci: ToolCiSummary): Promise<GithubJob[]> {
    if (!ci.run_id) return [];

    const access = await this.requiredToolAccess(row, ci);

    try {
      return await this.toolJobList(access, ci);
    } catch (error) {
      throw this.toolReadFailure(row, access, error);
    }
  }

  private async toolJobLog(
    row: RunRow,
    ci: ToolCiSummary,
    jobId: string,
  ): Promise<GithubJobLog> {
    if (!ci.run_id) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'This run has no job to read a log from yet',
      });
    }

    const access = await this.requiredToolAccess(row, ci);
    let jobs: GithubJob[];

    try {
      jobs = await this.toolJobList(access, ci);
    } catch (error) {
      throw this.toolReadFailure(row, access, error);
    }

    // The id goes into the tool's address, so only a job listed for this run is asked for.
    if (!jobs.some((job) => job.id === jobId)) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'This job is not part of the run',
      });
    }

    try {
      return ci.provider === 'jenkins'
        ? await readConsole(access, ci.html_url as string)
        : await readJobTrace(access, ci.project_id as number, jobId);
    } catch (error) {
      if (
        error instanceof GithubActionsError &&
        (error.status === 404 || error.status === 410)
      ) {
        throw new NotFoundException({
          code: 'CI_LOG_NOT_AVAILABLE',
          message: 'This log is not available yet, or it has expired',
        });
      }

      throw this.toolReadFailure(row, access, error);
    }
  }

  private async toolCancel(row: RunRow, ci: ToolCiSummary): Promise<RunRow> {
    const access = await this.requiredToolAccess(row, ci);

    try {
      if (ci.provider === 'jenkins') {
        // Still in the queue, the build has no number to stop yet.
        if (ci.run_id && ci.html_url) await stopBuild(access, ci.html_url);
        else if (ci.queue_url) await cancelQueueItem(access, ci.queue_url);
      } else if (ci.project_id && ci.run_id) {
        await cancelPipeline(access, ci.project_id, ci.run_id);
      }
    } catch (error) {
      if (
        error instanceof GithubActionsError &&
        (error.status === 401 || error.status === 403)
      ) {
        throw new ConflictException({
          code: 'CI_CANCEL_DENIED',
          message: `${access.label} refused to stop the run. The saved access details need the right to cancel it.`,
        });
      }

      throw new ConflictException({
        code: 'CI_CANCEL_FAILED',
        message: `${access.label} could not stop the run right now`,
      });
    }

    const { data, error } = await this.client
      .from('test_automation_runs')
      .update({ cancel_requested_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id)
      .select(RUN_COLUMNS)
      .single();

    if (error) throw new Error(error.message);

    return data as unknown as RunRow;
  }
}
