import { createHash, randomUUID } from 'crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { CiServersService } from '../../ci-servers/ci-servers.service';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import { ticketEmbed } from '../common/ticket-keys';
import type {
  TestAutomationRun,
  TriggerTestAutomationCaseDto,
  TriggerTestAutomationDto,
} from '../dto/test-automation.dto';
import type { CreateTestExecutionDto } from '../dto/test-execution.dto';
import { TestExecutionsService } from '../executions/test-executions.service';
import { notFound, tmDbError } from '../test-management-errors';
import {
  AUTOMATED_TEST_KINDS,
  AUTOMATION_LIMITS,
  checkCiUrl,
  hasAuthorization,
  MAX_TEST_KEYS,
  renderTemplate,
  safeUrl,
} from './automation-inputs';
import { safeHttpsRequest, type CiRequestResult } from './safe-https-request';
import {
  readSecretMap,
  TestAutomationConfigsService,
} from './test-automation-configs.service';
import {
  GITLAB_RECONNECT,
  GitlabConnectionError,
  TestAutomationGitService,
} from './test-automation-git.service';
import { githubHeaders } from './test-automation-github.client';
import {
  decoded,
  gitlabPipelineAddress,
  gitlabProject,
  gitlabStart,
  hasPrivateToken,
  tokenSecrets,
  type GitlabCi,
} from './test-automation-gitlab.client';
import {
  jenkinsJobName,
  jenkinsStart,
  type JenkinsCi,
} from './test-automation-jenkins.client';

export const RUN_COLUMNS =
  'id, organization_id, space_id, config_id, kind, target, plan_id, execution_id, started_by, status, outcome, ' +
  'error_code, error_message, created_at, started_at, finished_at, cancel_requested_at, result_summary, ' +
  'config_name:config_snapshot->>name, run_no';

export interface RunRow extends TestAutomationRun {
  organization_id: string;
  space_id: string;
  started_by: string | null;
}

export interface TargetRow {
  id: string;
  key: string;
  is_archived: boolean;
}

export function toRun(row: RunRow): TestAutomationRun {
  return {
    id: row.id,
    config_id: row.config_id,
    config_name: row.config_name,
    run_no: row.run_no ?? null,
    kind: row.kind,
    target: row.target,
    plan_id: row.plan_id,
    execution_id: row.execution_id,
    status: row.status,
    outcome: row.outcome,
    error_code: row.error_code,
    error_message: row.error_message,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    cancel_requested_at: row.cancel_requested_at,
    result_summary: row.result_summary,
  };
}

/** Hides every secret value that a CI tool might echo back in its answer. */
function mask(text: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length >= 4)
    .reduce((out, secret) => out.split(secret).join('***'), text);
}

/** Query values of a CI URL; a token there must be hidden if the CI tool echoes it. */
function urlQueryValues(raw: string): string[] {
  try {
    return [...new URL(raw).searchParams.values()];
  } catch {
    return [];
  }
}

// A CI tool may echo only the token of "Bearer <token>", so the bare part is hidden too.
function headerSecrets(headers: Record<string, string>): string[] {
  return Object.values(headers).flatMap((value) => {
    const credential = /^\S+\s+(\S{8,})$/.exec(value.trim())?.[1];

    return credential ? [value, credential] : [value];
  });
}

const isFormBody = (headers: Record<string, string>): boolean =>
  Object.entries(headers).some(
    ([name, value]) =>
      name.toLowerCase() === 'content-type' &&
      /^application\/x-www-form-urlencoded\s*(;.*)?$/i.test(value.trim()),
  );

// A tool may echo a form value as sent or decoded, so both forms are hidden.
function formSecrets(template: string): string[] {
  return template
    .split('&')
    .flatMap((pair) => [
      pair.slice(pair.indexOf('=') + 1),
      ...new URLSearchParams(pair).values(),
    ]);
}

// Literal values typed into the request text, such as a trigger token; values filled in from {…} are not secret.
function bodySecrets(
  template: string | null | undefined,
  headers: Record<string, string> = {},
): string[] {
  if (!template) return [];

  if (isFormBody(headers)) {
    return formSecrets(template).filter(
      (value) => value.length >= 8 && !/\{\w+\}/.test(value),
    );
  }

  const values: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (node.length >= 8 && !/\{\w+\}/.test(node)) values.push(node);
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  };

  try {
    walk(JSON.parse(template));
  } catch {
    return [];
  }

  return values;
}

type CiOutcome = { error_code: string; error_message: string };

interface ConnectionAccess {
  token?: string;
  fullName?: string;
  headers?: Record<string, string>;
  failure?: CiOutcome;
  provider?: 'gitlab' | 'jenkins';
  serverId?: string;
  secrets?: string[];
}

const JENKINS_FIX =
  'Jenkins refused the saved user name or API token. An admin must fix the Jenkins server in Tenant Configuration → Integrations.';

/** Jenkins' refusals of a start signed in by a connected server; null for any other answer. */
function jenkinsRefusal(result: CiRequestResult): CiOutcome | null {
  if (result.status === 403 && /crumb/i.test(result.body)) {
    return {
      error_code: 'CI_ACCESS_DENIED',
      error_message:
        'Jenkins asked for a crumb. A request signed in with an API token needs none; check that the Jenkins server in Tenant Configuration → Integrations uses an API token, not a password.',
    };
  }

  return result.status === 401 || result.status === 403
    ? { error_code: 'CI_ACCESS_UNAVAILABLE', error_message: JENKINS_FIX }
    : null;
}

/** GitLab's refusals of a start through its connection, named so the fix is clear; null for any other answer. */
function gitlabRefusal(result: CiRequestResult): CiOutcome | null {
  if (result.status === 400 && /variable/i.test(result.body)) {
    return {
      error_code: 'CI_VARIABLES_REFUSED',
      error_message:
        'GitLab refused the pipeline variables. Allow pipeline variables in the project under Settings → CI/CD, or remove the inputs of this job.',
    };
  }

  if (
    result.status === 400 &&
    /\b(?:ref|reference|branch)\b/i.test(result.body)
  ) {
    return {
      error_code: 'CI_REF_NOT_FOUND',
      error_message: 'GitLab does not know the branch or tag of this job',
    };
  }

  if (result.status === 401) {
    return {
      error_code: 'GIT_CONNECTION_UNAVAILABLE',
      error_message: GITLAB_RECONNECT,
    };
  }

  if (result.status === 403) {
    return {
      error_code: 'CI_ACCESS_DENIED',
      error_message:
        'GitLab refused to start the pipeline. The GitLab user who connected the project needs at least the Developer role in it.',
    };
  }

  return null;
}

/** GitHub's answer when asked for run details; older servers answer with nothing. */
function startedRun(
  answer: string,
): { run_id: number; html_url: string } | null {
  try {
    const parsed = JSON.parse(answer) as {
      workflow_run_id?: unknown;
      html_url?: unknown;
    };

    return Number.isSafeInteger(parsed.workflow_run_id) &&
      typeof parsed.html_url === 'string' &&
      parsed.html_url.startsWith('https://')
      ? {
          run_id: parsed.workflow_run_id as number,
          html_url: parsed.html_url,
        }
      : null;
  } catch {
    return null;
  }
}

/** Keeps which CI tool refused a start, so the advice names GitLab or Jenkins instead of GitHub. */
function failedToolSummary(ciUrl: string): Record<string, unknown> {
  const gitlab = gitlabProject(ciUrl);

  if (gitlab) {
    return {
      ci: {
        provider: 'gitlab',
        state: 'untracked',
        full_name: decoded(gitlab.project) ?? gitlab.project,
      },
    };
  }

  const job = jenkinsJobName(ciUrl);

  return job
    ? { ci: { provider: 'jenkins', state: 'untracked', full_name: job } }
    : {};
}

/** The same start request always names the same execution, so a resend never creates a second one. */
function caseRequestId(requestId: string, caseId: string): string {
  const hex = createHash('sha256')
    .update(`ci-case:${requestId}:${caseId}`)
    .digest('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** Starts a build in the customer's CI tool, as Xray's "Triggering Remote Jobs"; results come back by import. */
@Injectable()
export class TestAutomationCiService {
  private readonly logger = new Logger(TestAutomationCiService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly permissions: PermissionsService,
    private readonly configs: TestAutomationConfigsService,
    private readonly auditLogs: AuditLogsService,
    @Optional() private readonly git?: TestAutomationGitService,
    @Optional() private readonly executions?: TestExecutionsService,
    @Optional() private readonly ciServers?: CiServersService,
  ) {}

  /** Only a job with no saved Authorization uses the connection, so a saved login never changes under it. */
  private async connectionAccess(
    organizationId: string,
    ciUrl: string,
    stored: Record<string, string>,
  ): Promise<ConnectionAccess | null> {
    if (hasAuthorization(stored)) return null;

    const jenkins = await this.jenkinsConnection(organizationId, ciUrl, stored);

    if (jenkins) return jenkins;
    if (!this.git) return null;

    if (gitlabPipelineAddress(ciUrl) && !hasPrivateToken(stored)) {
      const gitlab = await this.gitlabConnection(
        this.git,
        organizationId,
        ciUrl,
      );

      if (gitlab) return gitlab;
    }

    try {
      const connection = await this.git.ciConnection(organizationId, ciUrl);

      if (!connection) return null;

      if (connection.state === 'unavailable') {
        return {
          failure: {
            error_code: 'GIT_CONNECTION_UNAVAILABLE',
            error_message:
              'This repository is no longer available through the GitHub connection',
          },
        };
      }

      const token = await this.git.tokenFor(connection.match);

      return {
        token,
        fullName: connection.match.repository.full_name,
        headers: githubHeaders(token),
      };
    } catch (error) {
      this.logger.warn(
        `Could not get a GitHub token: ${error instanceof Error ? error.message : String(error)}`,
      );

      return {
        failure: {
          error_code: 'GIT_TOKEN_FAILED',
          error_message: 'GitHub did not give access to this repository',
        },
      };
    }
  }

  /** A job on a Jenkins server connected in Integrations starts as that server's saved user; null leaves the address alone. */
  private async jenkinsConnection(
    organizationId: string,
    ciUrl: string,
    stored: Record<string, string>,
  ): Promise<ConnectionAccess | null> {
    if (!this.ciServers || !jenkinsJobName(ciUrl)) return null;

    try {
      const server = await this.ciServers.findForJobUrl(organizationId, ciUrl);

      if (!server) return null;

      const authorization = this.ciServers.authorizationFor(server);
      const login = Buffer.from(authorization.slice(6), 'base64').toString(
        'utf8',
      );
      const typed = Object.keys(stored).some(
        (name) => name.toLowerCase() === 'content-type',
      );

      return {
        provider: 'jenkins',
        serverId: server.id,
        // Jenkins reads build parameters only from a form body.
        headers: typed
          ? { authorization }
          : {
              authorization,
              'content-type': 'application/x-www-form-urlencoded',
            },
        secrets: [
          ...tokenSecrets(authorization),
          login,
          login.slice(login.indexOf(':') + 1),
        ],
      };
    } catch (error) {
      this.logger.warn(
        `Could not read the Jenkins server of a CI job: ${error instanceof Error ? error.message : String(error)}`,
      );

      return {
        failure: {
          error_code: 'CI_ACCESS_UNAVAILABLE',
          error_message: JENKINS_FIX,
        },
      };
    }
  }

  /** A start the server's login was refused for; the admin sees the server needs attention. */
  private async markJenkins(
    organizationId: string,
    serverId: string,
  ): Promise<void> {
    try {
      await this.ciServers?.markNeedsAttention(
        organizationId,
        serverId,
        'Jenkins refused the user name or API token when a CI job started',
      );
    } catch (error) {
      this.logger.warn(
        `Could not mark Jenkins server ${serverId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A pipeline of a project connected in Integrations starts with that account's token; null leaves the address alone. */
  private async gitlabConnection(
    git: TestAutomationGitService,
    organizationId: string,
    ciUrl: string,
  ): Promise<ConnectionAccess | null> {
    try {
      const match = await git.gitlabCiConnection(organizationId, ciUrl);

      if (!match) return null;

      if (match === 'unavailable') {
        return {
          failure: {
            error_code: 'GIT_CONNECTION_UNAVAILABLE',
            error_message:
              'This project is no longer available through the GitLab connection',
          },
        };
      }

      const token = await git.gitlabToken(organizationId, match.connection);

      return {
        token,
        provider: 'gitlab',
        headers: { authorization: `Bearer ${token}` },
      };
    } catch (error) {
      if (error instanceof GitlabConnectionError) {
        return {
          failure: {
            error_code: 'GIT_CONNECTION_UNAVAILABLE',
            error_message: error.message,
          },
        };
      }

      this.logger.warn(
        `Could not get a GitLab token: ${error instanceof Error ? error.message : String(error)}`,
      );

      return {
        failure: {
          error_code: 'GIT_TOKEN_FAILED',
          error_message: 'GitLab did not give access to this project',
        },
      };
    }
  }

  /** The started run's id from GitHub's answer, kept so the run can be followed. */
  private async recordStarted(
    organizationId: string,
    runId: string,
    fullName: string,
    answer: string,
  ): Promise<RunRow | null> {
    const started = startedRun(answer);
    const { data, error } = await this.client
      .from('test_automation_runs')
      .update({
        result_summary: {
          ci: started
            ? { state: 'queued', full_name: fullName, ...started }
            : { state: 'untracked', full_name: fullName },
        },
      })
      .eq('id', runId)
      .eq('organization_id', organizationId)
      .select(RUN_COLUMNS)
      .single();

    if (error) {
      this.logger.error(`Failed to record the started run ${runId}`, error);

      return null;
    }

    return data as unknown as RunRow;
  }

  private async recordTracked(
    organizationId: string,
    runId: string,
    ci: GitlabCi | JenkinsCi,
  ): Promise<RunRow | null> {
    const { data, error } = await this.client
      .from('test_automation_runs')
      .update({ result_summary: { ci } })
      .eq('id', runId)
      .eq('organization_id', organizationId)
      .select(RUN_COLUMNS)
      .single();

    if (error) {
      this.logger.error(`Failed to record the started run ${runId}`, error);

      return null;
    }

    return data as unknown as RunRow;
  }

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async trigger(
    user: RequestUser,
    spaceId: string,
    configId: string,
    dto: TriggerTestAutomationDto,
  ): Promise<TestAutomationRun> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // The route needs execute_tests; starting automation also needs the right to manage runs.
    const canManage = await this.permissions.hasSpacePermission(
      user.userId,
      user.organizationId,
      spaceId,
      'manage_test_runs',
    );

    if (!canManage) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Starting automation needs the right to manage test runs',
      });
    }

    const replay = await this.findByRequest(
      user,
      spaceId,
      configId,
      dto.request_id,
    );

    if (replay) return replay;

    const config = await this.configs.findRow(
      user.organizationId,
      spaceId,
      configId,
    );

    if (config.archived_at) {
      throw new ConflictException({
        code: 'ARCHIVED',
        message: 'The automation setting is archived',
      });
    }

    if (config.kind !== 'ci_job') {
      throw new BadRequestException({
        code: 'NOT_A_CI_JOB',
        message: 'This setting runs tests on the runner, not in a CI tool',
      });
    }

    if (!config.ci_url) {
      throw new BadRequestException({
        code: 'NOT_A_CI_JOB',
        message: 'This setting has no CI address',
      });
    }

    const target = await this.findTarget(user.organizationId, spaceId, dto);
    const spaceKey = await this.spaceKey(user.organizationId, spaceId);
    const testKeys = config.ci_body_template?.includes('{testKeys}')
      ? await this.testKeys(user.organizationId, spaceId, dto)
      : '';
    const runId = randomUUID();
    const now = new Date().toISOString();

    // Recorded before the call, so a second click with the same request id can never start a second build.
    const { data: inserted, error: insertError } = await this.client
      .from('test_automation_runs')
      .insert({
        id: runId,
        organization_id: user.organizationId,
        space_id: spaceId,
        config_id: configId,
        kind: 'ci_job',
        target: dto.target,
        plan_id: dto.target === 'plan' ? target.id : null,
        execution_id: dto.target === 'execution' ? target.id : null,
        config_snapshot: {
          name: config.name,
          ci_method: config.ci_method,
          ci_url: safeUrl(config.ci_url),
        },
        request_id: dto.request_id,
        started_by: user.userId,
        status: 'REQUESTED',
        started_at: now,
        finished_at: now,
        // Cleared once the CI tool has answered; a marker left behind means the request never finished.
        result_summary: { send_pending: true },
      })
      .select(RUN_COLUMNS)
      .single();

    if (insertError?.code === '23505') {
      const raced = await this.findByRequest(
        user,
        spaceId,
        configId,
        dto.request_id,
      );

      if (raced) return raced;
    }

    if (insertError || !inserted) {
      throw tmDbError(
        this.logger,
        'record automation start',
        insertError ?? { message: 'no row' },
      );
    }

    const stored = readSecretMap(config.ci_headers_enc);
    const connection = await this.connectionAccess(
      user.organizationId,
      config.ci_url,
      stored,
    );
    const headers = { ...stored, ...connection?.headers };
    const fill = (keys: string) =>
      config.ci_body_template
        ? renderTemplate(config.ci_body_template, {
            executionKey: dto.target === 'execution' ? target.key : '',
            executionId: dto.target === 'execution' ? target.id : '',
            planKey: dto.target === 'plan' ? target.key : '',
            planId: dto.target === 'plan' ? target.id : '',
            spaceKey,
            spaceId,
            runId,
            baseUrl: process.env.PUBLIC_API_URL ?? process.env.APP_URL ?? '',
            testKeys: keys,
          })
        : null;
    const full = fill(testKeys);

    // Kept within the size a setting's request may have; an empty list means every test.
    const body =
      full && testKeys && full.length > AUTOMATION_LIMITS.ciBody
        ? fill('')
        : full;

    if (
      body !== null &&
      !Object.keys(headers).some(
        (name) => name.toLowerCase() === 'content-type',
      )
    ) {
      headers['content-type'] = 'application/json';
    }

    const result: CiRequestResult = connection?.failure
      ? { body: '' }
      : await this.call(
          config.ci_url,
          config.ci_method ?? 'POST',
          headers,
          body,
        );
    const outcome =
      connection?.failure ??
      this.connectionOutcome(result, connection) ??
      this.outcome(result, [
        ...headerSecrets(headers),
        ...bodySecrets(config.ci_body_template, stored),
        ...urlQueryValues(config.ci_url),
        // Header values carry a prefix, and a reply could echo the bare token.
        ...(connection?.token ? [connection.token] : []),
        ...(connection?.secrets ?? []),
      ]);
    let run = inserted as unknown as RunRow;

    if (
      outcome?.error_code === 'CI_ACCESS_UNAVAILABLE' &&
      connection?.serverId
    ) {
      await this.markJenkins(user.organizationId, connection.serverId);
    }

    if (!outcome && connection?.fullName) {
      run =
        (await this.recordStarted(
          user.organizationId,
          runId,
          connection.fullName,
          result.body,
        )) ?? run;
    }

    // GitLab and Jenkins starts are followed with the setting's own saved token, or the GitLab connection.
    if (!outcome && !connection?.fullName) {
      const tracked =
        gitlabStart(
          config.ci_url,
          stored,
          result.body,
          connection?.provider === 'gitlab',
        ) ??
        jenkinsStart(
          config.ci_url,
          stored,
          result.location,
          connection?.provider === 'jenkins',
        );

      if (tracked) {
        run =
          (await this.recordTracked(user.organizationId, runId, tracked)) ??
          run;
      }
    }

    // The CI tool took the job, but no workflow is followed, so only the marker has to go.
    if (!outcome && run.result_summary?.send_pending) {
      const { data: sent, error } = await this.client
        .from('test_automation_runs')
        .update({ result_summary: {} })
        .eq('id', runId)
        .eq('organization_id', user.organizationId)
        // A job's upload may have closed the run meanwhile; that must not be undone.
        .eq('result_summary->>send_pending', 'true')
        .select(RUN_COLUMNS)
        .maybeSingle();

      if (error) {
        this.logger.error(`Failed to record that run ${runId} was sent`, error);
      } else if (sent) {
        run = sent as unknown as RunRow;
      }
    }

    if (outcome) {
      const { data: failed, error } = await this.client
        .from('test_automation_runs')
        .update({
          status: 'ERROR',
          ...outcome,
          result_summary: failedToolSummary(config.ci_url),
        })
        .eq('id', runId)
        .eq('organization_id', user.organizationId)
        .eq('result_summary->>send_pending', 'true')
        .select(RUN_COLUMNS)
        .maybeSingle();

      if (error) {
        this.logger.error(
          `Failed to record the CI answer of run ${runId}`,
          error,
        );
      } else if (failed) {
        run = failed as unknown as RunRow;
      }
    }

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_run',
      runId,
      'create',
      {
        config_id: configId,
        target: dto.target,
        target_id: target.id,
        status: run.status,
        error_code: run.error_code,
      },
    );

    return toRun(run);
  }

  /** The address is checked again right before the call; DNS may have changed since the setting was saved. */
  private async call(
    url: string,
    method: 'POST' | 'PUT',
    headers: Record<string, string>,
    body: string | null,
  ): Promise<CiRequestResult> {
    try {
      await checkCiUrl(url);
    } catch {
      return { body: '', failure: 'CI_BLOCKED_HOST' };
    }

    return safeHttpsRequest(url, method, headers, body);
  }

  /** A refusal that isn't a rate limit means the App lacks the permission; the wizard can't say so, this does. */
  private connectionOutcome(
    result: CiRequestResult,
    connection: ConnectionAccess | null,
  ): CiOutcome | null {
    if (connection?.provider === 'gitlab') return gitlabRefusal(result);
    if (connection?.provider === 'jenkins') return jenkinsRefusal(result);

    if (
      !connection?.token ||
      result.status !== 403 ||
      /rate limit/i.test(result.body)
    ) {
      return null;
    }

    return {
      error_code: 'GIT_ACTIONS_DENIED',
      error_message:
        'GitHub refused to start the workflow. The GitHub App needs the Actions permission set to read and write.',
    };
  }

  private outcome(
    result: CiRequestResult,
    secrets: string[],
  ): CiOutcome | null {
    if (result.failure === 'CI_BLOCKED_HOST') {
      return {
        error_code: 'CI_BLOCKED_HOST',
        error_message: 'The CI address is not a public host',
      };
    }

    if (result.failure === 'CI_TIMEOUT') {
      return {
        error_code: 'CI_TIMEOUT',
        error_message: 'The CI tool did not answer within 15 seconds',
      };
    }

    if (result.failure || result.status === undefined) {
      return {
        error_code: 'CI_UNREACHABLE',
        error_message: 'The CI tool could not be reached',
      };
    }

    if (result.status >= 200 && result.status < 300) return null;

    const answer = mask(result.body, secrets)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);

    return {
      error_code: `CI_REJECTED_${result.status}`,
      error_message: `The CI tool answered ${result.status}${answer ? `: ${answer}` : ''}`,
    };
  }

  /**
   * Starts a CI job for one automated test case, in a new execution that holds only that test.
   * The execution is taken back when the start fails before its run is saved.
   */
  async triggerCase(
    user: RequestUser,
    spaceId: string,
    configId: string,
    dto: TriggerTestAutomationCaseDto,
  ): Promise<TestAutomationRun> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const canManage = await this.permissions.hasSpacePermission(
      user.userId,
      user.organizationId,
      spaceId,
      'manage_test_runs',
    );

    if (!canManage) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Starting automation needs the right to manage test runs',
      });
    }

    const replay = await this.findByRequest(
      user,
      spaceId,
      configId,
      dto.request_id,
    );

    if (replay) return replay;

    const config = await this.configs.findRow(
      user.organizationId,
      spaceId,
      configId,
    );

    if (config.archived_at) {
      throw new ConflictException({
        code: 'ARCHIVED',
        message: 'The automation setting is archived',
      });
    }

    if (config.kind !== 'ci_job') {
      throw new BadRequestException({
        code: 'NOT_A_CI_JOB',
        message: 'This setting runs tests on the runner, not in a CI tool',
      });
    }

    if (!config.ci_url) {
      throw new BadRequestException({
        code: 'NOT_A_CI_JOB',
        message: 'This setting has no CI address',
      });
    }

    const caseKey = await this.automatedCaseKey(
      user.organizationId,
      spaceId,
      dto.case_id,
    );

    // The new execution gets a ticket, which needs this right.
    const canCreateTasks = await this.permissions.checkPermission(
      user.userId,
      user.organizationId,
      'can_create_tasks',
    );

    if (!canCreateTasks) {
      throw new ForbiddenException({
        code: 'TICKET_CREATE_FORBIDDEN',
        message: 'You need permission to create tasks to add this test record.',
      });
    }

    if (!this.executions) throw new Error('Test executions are not available');

    const input: CreateTestExecutionDto = {
      request_id: caseRequestId(dto.request_id, dto.case_id),
      from: 'cases',
      case_ids: [dto.case_id],
      name: `CI · ${caseKey} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    };
    const { execution_id: executionId } = await this.executions.create(
      user,
      spaceId,
      input,
    );

    try {
      return await this.trigger(user, spaceId, configId, {
        target: 'execution',
        target_id: executionId,
        request_id: dto.request_id,
      });
    } catch (error) {
      await this.removeUnstarted(user, spaceId, executionId, dto.request_id);

      throw error;
    }
  }

  /** The key of a case a CI tool can run: in this space, not archived or deprecated, of an automated type. */
  private async automatedCaseKey(
    organizationId: string,
    spaceId: string,
    caseId: string,
  ): Promise<string> {
    const { data, error } = await this.client
      .from('test_cases')
      .select(
        `id, is_archived, readiness, test_type, ${ticketEmbed('test_cases', 'key')}`,
      )
      .eq('id', caseId)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load test case', error);
    if (!data) throw notFound();

    const row = data as unknown as {
      is_archived: boolean;
      readiness: string;
      test_type: string;
      task: { key: string };
    };

    if (row.is_archived) {
      throw new ConflictException({
        code: 'ARCHIVED',
        message: 'The test case is archived',
      });
    }

    if (row.readiness === 'deprecated') {
      throw new ConflictException({
        code: 'CASE_DEPRECATED',
        message: 'The test case is deprecated',
      });
    }

    const { data: settings, error: settingsError } = await this.client
      .from('test_management_space_settings')
      .select('test_types')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .maybeSingle<{ test_types: { id: string; kind: string }[] | null }>();

    if (settingsError) {
      throw tmDbError(this.logger, 'load test types', settingsError);
    }

    const automated = (settings?.test_types ?? []).some(
      (type) =>
        type.id === row.test_type && AUTOMATED_TEST_KINDS.includes(type.kind),
    );

    if (!automated) {
      throw new BadRequestException({
        code: 'CASE_NOT_AUTOMATED',
        message:
          'This test case has a manual test type, so a CI tool has nothing to run',
      });
    }

    return row.task.key;
  }

  /** Only when no run was saved; a run saved as failed keeps its execution. */
  private async removeUnstarted(
    user: RequestUser,
    spaceId: string,
    executionId: string,
    requestId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('test_automation_runs')
      .select('id')
      .eq('request_id', requestId)
      .eq('organization_id', user.organizationId)
      .maybeSingle();

    if (error || data) return;

    try {
      await this.executions?.removeFailedImport(user, spaceId, executionId);
    } catch (failure) {
      this.logger.warn(
        `Execution ${executionId} of a CI start that failed was kept: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
  }

  /** Keys of the tests a run is for, filling {testKeys}; empty when there are too many to list. */
  private async testKeys(
    organizationId: string,
    spaceId: string,
    dto: TriggerTestAutomationDto,
  ): Promise<string> {
    const table = dto.target === 'plan' ? 'test_plan_tests' : 'test_runs';
    const { data, error } = await this.client
      .from(table)
      .select(
        `test_case:test_cases!${table}_case_fkey!inner(${ticketEmbed('test_cases', 'key')})`,
      )
      .eq(dto.target === 'plan' ? 'plan_id' : 'execution_id', dto.target_id)
      .eq('test_case.organization_id', organizationId)
      .eq('test_case.space_id', spaceId)
      .eq('test_case.is_archived', false)
      .limit(MAX_TEST_KEYS + 1);

    if (error) throw tmDbError(this.logger, 'load test keys', error);

    const rows = (data ?? []) as unknown as {
      test_case: { task: { key: string } };
    }[];

    if (rows.length > MAX_TEST_KEYS) return '';

    return [...new Set(rows.map((row) => row.test_case.task.key))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .join(',');
  }

  /** The run an earlier click with this request id started; another person's or setting's id is refused. */
  async findByRequest(
    user: RequestUser,
    spaceId: string,
    configId: string,
    requestId: string,
  ): Promise<TestAutomationRun | null> {
    const { data, error } = await this.client
      .from('test_automation_runs')
      .select(RUN_COLUMNS)
      .eq('request_id', requestId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load automation start', error);
    if (!data) return null;

    const row = data as unknown as RunRow;

    if (
      row.organization_id !== user.organizationId ||
      row.space_id !== spaceId ||
      row.config_id !== configId ||
      row.started_by !== user.userId
    ) {
      throw new ConflictException({
        code: 'REQUEST_ID_REUSED',
        message: 'This request id was already used for another start',
      });
    }

    return toRun(row);
  }

  async findTarget(
    organizationId: string,
    spaceId: string,
    dto: TriggerTestAutomationDto,
  ): Promise<TargetRow> {
    const table = dto.target === 'plan' ? 'test_plans' : 'test_executions';
    const { data, error } = await this.client
      .from(table)
      .select(`id, is_archived, ${ticketEmbed(table, 'key')}`)
      .eq('id', dto.target_id)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, `load ${dto.target}`, error);
    if (!data) throw notFound();

    const row = data as unknown as {
      id: string;
      is_archived: boolean;
      task: { key: string };
    };

    if (row.is_archived) {
      throw new ConflictException({
        code: 'ARCHIVED',
        message: `The test ${dto.target} is archived`,
      });
    }

    return { id: row.id, key: row.task.key, is_archived: row.is_archived };
  }

  private async spaceKey(
    organizationId: string,
    spaceId: string,
  ): Promise<string> {
    const { data, error } = await this.client
      .from('spaces')
      .select('key')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load space', error);

    return (data as { key?: string } | null)?.key ?? '';
  }
}
