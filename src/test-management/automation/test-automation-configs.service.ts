import { randomUUID } from 'crypto';

import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  CiServersService,
  type ICiServerDto,
  type ICiServerRow,
} from '../../ci-servers/ci-servers.service';
import { isJobUrlOf, type IJenkinsJob } from '../../ci-servers/jenkins-api';
import { GithubApiError } from '../../git-integrations/github/github-app.client';
import {
  packSecretForStorage,
  unpackStoredSecret,
} from '../../lib/crypto/encryption';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { TestManagementAccessService } from '../access/test-management-access.service';
import { ticketEmbed } from '../common/ticket-keys';
import type {
  AutomationKind,
  AutomationKindFilter,
  CreateTestAutomationConfigDto,
  CreateTestAutomationWorkflowFileDto,
  DeleteTestAutomationFilesDto,
  SaveTestAutomationFileDto,
  TestAutomationConfig,
  TestAutomationFileContent,
  TestAutomationFiles,
  TestAutomationFilesChange,
  TestAutomationFileVersionDto,
  TestAutomationGitRepository,
  TestAutomationImages,
  UpdateTestAutomationConfigDto,
  UpdateTestAutomationWorkflowFileDto,
} from '../dto/test-automation.dto';
import {
  detectFramework,
  type FrameworkDetection,
} from '../../test-automation-runner/detect-framework';
import { notFound, tmDbError } from '../test-management-errors';
import {
  AUTO_IMAGE_KEY,
  AUTO_RESULT_PATH,
  AUTOMATION_LIMITS,
  availableRunnerImages,
  checkCiInputs,
  checkCiUrl,
  checkEnv,
  checkFilePath,
  checkHeaders,
  checkHosts,
  checkRelativePath,
  checkRepoRef,
  checkRepoUrl,
  checkWorkflowContent,
  checkWorkflowFile,
  CI_IN_PROGRESS_FILTER,
  cleanProjectPath,
  hasAuthorization,
  invalid,
  runnerEnabled,
  runnerRuntime,
  safeUrl,
} from './automation-inputs';
import { CustomImageApprovalService } from './custom-images/approval/service/custom-image-approval.service';
import { isOwnImageKey } from './custom-images/shared/inputs/custom-image-inputs';
import {
  customImageLink,
  TestAutomationCustomImagesService,
} from './test-automation-custom-images.service';
import {
  dispatchAddress,
  GitlabConnectionError,
  repositoryKey,
  TestAutomationGitService,
  type ConnectedMatch,
  type GitlabMatch,
} from './test-automation-git.service';
import {
  createWorkflowFile,
  GithubActionsError,
  listWorkflowFiles,
  readWorkflowFile,
  updateWorkflowFile,
} from './test-automation-github.client';
import { gitlabPipelineAddress } from './test-automation-gitlab.client';
import { jenkinsJobName } from './test-automation-jenkins.client';
import { checkZip, type ZipProblem } from './zip-check';
import {
  collidesWith,
  listZipFiles,
  readZipFile,
  rebuildZip,
  ZipFileError,
} from './zip-files';

// Test code zips live in the private attachments bucket, like test evidence.
export const AUTOMATION_BUCKET = 'attachments';

// A runner run in one of these still uses its setting and its zip.
export const RUNNER_GOING_STATES = ['QUEUED', 'RUNNING', 'UPLOADING'];

// Encrypted text must stay under the 20,000-character CHECK; JSON this long encrypts to about 16,500.
const MAX_SECRET_JSON = 12_000;

const FORGOTTEN_ZIP_AGE_MS = 60 * 60 * 1000;

const CONFIG_COLUMNS =
  'id, name, kind, preset, image_key, source, repo_url, repo_ref, work_dir, zip_path, command, install_command, result_paths, env, ' +
  'secrets_enc, allowed_hosts, create_unmatched, timeout_minutes, trace_mode, ci_url, ci_method, ci_headers_enc, ' +
  'ci_body_template, archived_at, created_at, updated_at';

const DOCKER_FIELDS = [
  'preset',
  'image_key',
  'user_image_id',
  'source',
  'repo_url',
  'repo_ref',
  'work_dir',
  'command',
  'install_command',
  'result_paths',
  'env',
  'secrets',
  'clear_secrets',
  'allowed_hosts',
  'create_unmatched',
  'timeout_minutes',
  'trace_mode',
] as const;

const CI_FIELDS = [
  'ci_url',
  'ci_method',
  'ci_headers',
  'clear_ci_headers',
  'ci_body_template',
  'ci_repository_id',
  'ci_workflow',
  'ci_ref',
  'ci_inputs',
  'ci_server_id',
  'ci_jenkins_job',
] as const;

const HAND_TYPED_CI_FIELDS = [
  'ci_url',
  'ci_method',
  'ci_headers',
  'clear_ci_headers',
  'ci_body_template',
] as const;

const GIT_TOKEN = 'GIT_TOKEN';
const NOT_CONNECTED =
  'Pick a repository connected in Tenant Configuration under Integrations';
const USES_CONNECTION =
  'This repository uses the GitHub connection, so no credential is stored for it';
const USES_GITLAB_CONNECTION =
  'This project uses the GitLab connection, so no credential is stored for it';
const USES_JENKINS_CONNECTION =
  'This job uses the Jenkins server connected in Integrations, so its address and login come from there';
const JENKINS_NOT_CONNECTED =
  'Pick a Jenkins server connected in Tenant Configuration under Integrations';
const GITLAB_CI_FILE = '.gitlab-ci.yml';
const GITLAB_NO_WORKFLOW =
  'GitLab uses .gitlab-ci.yml in the repository, so no workflow file is picked';
const GITLAB_REPICK =
  'This trigger request cannot be moved automatically; pick the GitLab project again in the job';

const ZIP_MESSAGES: Record<ZipProblem | 'EMPTY', string> = {
  NOT_A_ZIP: 'The file is not a valid zip',
  TOO_MANY_ENTRIES: `The zip has more than ${AUTOMATION_LIMITS.zipEntries} entries`,
  TOO_LARGE_UNPACKED: 'The zip unpacks to more than 300 MB',
  UNSAFE_PATH: 'The zip contains a path outside the project folder',
  SYMLINK: 'The zip contains a symbolic link',
  EMPTY: 'The zip has no files',
};

/** True only when the zip can be read and holds no files; one that can't be listed is left to checkZip. */
async function holdsNoFiles(buffer: Buffer): Promise<boolean> {
  try {
    return (await listZipFiles(buffer)).files.length === 0;
  } catch {
    return false;
  }
}

// GitHub said no to a commit, as opposed to not being reachable.
const GITHUB_WRITE_REFUSALS = new Set([403, 404, 409, 422]);

function githubStatus(error: unknown): number | null {
  return error instanceof GithubActionsError || error instanceof GithubApiError
    ? error.status
    : null;
}

/** A stored setting, encrypted columns included; never returned as it is. */
export interface TestAutomationConfigRow {
  id: string;
  name: string;
  kind: AutomationKind;
  preset: TestAutomationConfig['preset'];
  image_key: string | null;
  source: 'git' | 'zip' | null;
  repo_url: string | null;
  repo_ref: string | null;
  work_dir: string | null;
  zip_path: string | null;
  command: string | null;
  install_command?: string | null;
  result_paths: string[];
  env: Record<string, string>;
  secrets_enc: string | null;
  allowed_hosts: string[];
  create_unmatched: boolean;
  timeout_minutes: number;
  trace_mode: 'off' | 'on_failure';
  ci_url: string | null;
  ci_method: 'POST' | 'PUT' | null;
  ci_headers_enc: string | null;
  ci_body_template: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

type ConfigWrite = Partial<
  Omit<
    TestAutomationConfigRow,
    'id' | 'created_at' | 'updated_at' | 'archived_at'
  >
> & { user_image_id?: string | null };

/** Reads a name → value map that packSecretForStorage stored; a broken value counts as empty. */
export function readSecretMap(stored: string | null): Record<string, string> {
  const plain = unpackStoredSecret(stored);

  if (!plain) return {};

  try {
    const parsed: unknown = JSON.parse(plain);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};

    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function packSecretMap(
  field: string,
  map: Record<string, string>,
): string | null {
  if (Object.keys(map).length === 0) return null;

  const json = JSON.stringify(map);

  if (json.length > MAX_SECRET_JSON)
    throw invalid(field, 'The values are too long in total');

  return packSecretForStorage(json);
}

/** Asks GitHub for the started run's id; a body that isn't a JSON object stays as it was. */
function withRunDetails(template: string | null): string | null {
  if (!template) return template;

  try {
    const body: unknown = JSON.parse(template);

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return template;
    }

    return JSON.stringify({ ...body, return_run_details: true });
  } catch {
    return template;
  }
}

/** A job this app built for the connection; a hand-typed job keeps showing its address and headers. */
function ciConnected(
  row: TestAutomationConfigRow,
): TestAutomationConfig['ci_connected'] | null {
  const address =
    row.kind !== 'docker' && row.ci_url && !row.ci_headers_enc
      ? dispatchAddress(row.ci_url)
      : null;

  if (!address || !row.ci_body_template) return null;

  try {
    const body = JSON.parse(row.ci_body_template) as {
      ref?: unknown;
      inputs?: unknown;
      return_run_details?: unknown;
    };

    if (body.return_run_details !== true || typeof body.ref !== 'string') {
      return null;
    }

    return {
      full_name: address.fullName,
      workflow: address.workflow,
      ref: body.ref,
      inputs: (body.inputs ?? {}) as Record<string, string>,
    };
  } catch {
    return null;
  }
}

/** `<api>/projects/<id>/trigger/pipeline` becomes the project's plain pipeline address; anything else is null. */
function gitlabPipelineOfTrigger(ciUrl: string): string | null {
  try {
    const url = new URL(ciUrl);
    const plain = `${url.origin}${url.pathname.replace(/\/trigger\/pipeline$/, '/pipeline')}`;

    return url.pathname.endsWith('/trigger/pipeline') &&
      gitlabPipelineAddress(plain)
      ? plain
      : null;
  } catch {
    return null;
  }
}

/** A trigger body `{token, ref, variables: {…}}` as a pipeline body without the trigger token; null if unreadable. */
function gitlabBodyOfTrigger(template: string | null): string | null {
  try {
    const body = JSON.parse(template ?? '') as {
      ref?: unknown;
      variables?: unknown;
    };
    const variables =
      body.variables && typeof body.variables === 'object'
        ? Object.entries(body.variables as Record<string, unknown>)
        : [];

    if (
      typeof body.ref !== 'string' ||
      !body.ref ||
      Array.isArray(body.variables)
    )
      return null;
    if (variables.some(([, value]) => typeof value !== 'string')) return null;

    return JSON.stringify({
      ref: body.ref,
      variables: variables.map(([key, value]) => ({ key, value })),
    });
  } catch {
    return null;
  }
}

/** Ref and inputs of a pipeline start this app built for the GitLab connection; null for any other job. */
function gitlabBody(
  row: TestAutomationConfigRow,
): { ref: string; inputs: Record<string, string> } | null {
  if (
    row.kind === 'docker' ||
    !row.ci_url ||
    row.ci_headers_enc ||
    !row.ci_body_template ||
    !gitlabPipelineAddress(row.ci_url)
  ) {
    return null;
  }

  try {
    const body = JSON.parse(row.ci_body_template) as {
      ref?: unknown;
      variables?: unknown;
    };

    if (typeof body.ref !== 'string') return null;

    const inputs: Record<string, string> = {};

    for (const variable of Array.isArray(body.variables)
      ? (body.variables as { key?: unknown; value?: unknown }[])
      : []) {
      if (
        typeof variable?.key === 'string' &&
        typeof variable.value === 'string'
      ) {
        inputs[variable.key] = variable.value;
      }
    }

    return { ref: body.ref, inputs };
  } catch {
    return null;
  }
}

/** `<job>/build` or `<job>/buildWithParameters` with no query; the job address, or null. */
function jenkinsJobOf(ciUrl: string): string | null {
  return (
    /^(https:\/\/[^?#]+\/job\/[^/?#]+)\/(?:build|buildWithParameters)$/.exec(
      ciUrl,
    )?.[1] ?? null
  );
}

// Placeholders stay as typed so renderTemplate still fills them in; only the literal text is encoded.
const formPart = (value: string): string =>
  value
    .split(/(\{\w+\})/)
    .map((part, index) => (index % 2 ? part : encodeURIComponent(part)))
    .join('');

// The values a Test Management Jenkinsfile reads; filled in when the run starts.
const JENKINS_RUN_VALUES = {
  XISUITE_SPACE_ID: '{spaceId}',
  XISUITE_PLAN_ID: '{planId}',
  XISUITE_EXECUTION_ID: '{executionId}',
  XISUITE_RUN_ID: '{runId}',
  XISUITE_TEST_KEYS: '{testKeys}',
};

// Jenkins lists a job with a trailing slash; the host may differ in case.
const sameJob = (listed: string, job: string): boolean => {
  try {
    const url = new URL(listed);

    return `${url.origin}${url.pathname}`.replace(/\/+$/, '') === job;
  } catch {
    return false;
  }
};

/** CI tools often take a token in the URL or body, and commands and variables can hold one too, so only people who can edit the setting see them in full. */
export function toConfig(
  row: TestAutomationConfigRow,
  canEdit: boolean,
): TestAutomationConfig {
  const connected = canEdit ? ciConnected(row) : null;

  return {
    ...(connected && { ci_connected: connected }),
    id: row.id,
    name: row.name,
    kind: row.kind,
    preset: row.preset ?? null,
    image_key: row.image_key ?? null,
    source: row.source ?? null,
    repo_url: row.repo_url ?? null,
    repo_ref: row.repo_ref ?? null,
    work_dir: row.work_dir ?? null,
    has_zip: Boolean(row.zip_path),
    command: canEdit ? (row.command ?? null) : null,
    install_command: canEdit ? (row.install_command ?? null) : null,
    result_paths: row.result_paths ?? [],
    env: canEdit ? (row.env ?? {}) : null,
    has_secrets: Boolean(row.secrets_enc),
    secret_names: Object.keys(readSecretMap(row.secrets_enc ?? null)).sort(),
    allowed_hosts: row.allowed_hosts ?? [],
    create_unmatched: row.create_unmatched ?? false,
    timeout_minutes: row.timeout_minutes,
    trace_mode: row.trace_mode,
    ci_url: canEdit || !row.ci_url ? row.ci_url : safeUrl(row.ci_url),
    ci_method: row.ci_method,
    ci_header_names: Object.keys(readSecretMap(row.ci_headers_enc)).sort(),
    ci_body_template: canEdit ? row.ci_body_template : null,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function archivedConflict(): ConflictException {
  return new ConflictException({
    code: 'ARCHIVED',
    message: 'The automation setting is archived',
  });
}

function filesChanged(): ConflictException {
  return new ConflictException({
    code: 'FILES_CHANGED',
    message: 'The files were changed by someone else, load them again',
  });
}

function zipRejected(problem: ZipProblem | 'EMPTY'): BadRequestException {
  return new BadRequestException({
    code: 'ZIP_REJECTED',
    field: 'file',
    reason: problem,
    message: ZIP_MESSAGES[problem],
    data: { field: 'file', reason: problem },
  });
}

/** Saving "auto" before the database allows it breaks only this check. */
function autoNotAvailable(error: {
  code?: string;
  message: string;
}): BadRequestException | null {
  return error.code === '23514' &&
    error.message.includes('test_automation_configs_preset_check')
    ? new BadRequestException({
        code: 'AUTO_NOT_AVAILABLE',
        message: 'Apply the Test Management runner update first',
      })
    : null;
}

/** Only the zip's UUID, so a client can't learn or send a storage path. */
function zipVersion(path: string | null): string | null {
  return path ? (path.split('/').pop() ?? '').replace(/\.zip$/, '') : null;
}

/** Automation settings of a space: a CI job to start, or tests the runner runs in a container. */
@Injectable()
export class TestAutomationConfigsService {
  private readonly logger = new Logger(TestAutomationConfigsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly access: TestManagementAccessService,
    private readonly auditLogs: AuditLogsService,
    private readonly permissions: PermissionsService,
    private readonly git: TestAutomationGitService,
    @Optional() private readonly ciServers?: CiServersService,
    @Optional()
    private readonly customImages?: TestAutomationCustomImagesService,
    @Optional()
    private readonly imageApprovals?: CustomImageApprovalService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** A newly linked custom image may not be one this space rejected. */
  private async checkImageForSpace(
    organizationId: string,
    spaceId: string,
    imageId: string | null | undefined,
  ): Promise<void> {
    if (!imageId || !this.imageApprovals) return;

    await this.imageApprovals.assertNotRejectedHere(
      organizationId,
      spaceId,
      imageId,
    );
  }

  /** After a save: a space that asks for approval asks about the custom image this setting uses; never fails the save. Adder null: whoever first linked it. */
  private askImageApproval(
    user: RequestUser,
    spaceId: string,
    row: TestAutomationConfigRow,
    imageId: string | null | undefined,
    adderId: string | null,
  ): void {
    const approvals = this.imageApprovals;

    if (!approvals || row.archived_at || !isOwnImageKey(row.image_key)) {
      return;
    }

    const job = (async () => {
      const linked =
        imageId ??
        (await this.customImages?.linkedImageId(user.organizationId, row.id));

      if (linked) {
        await approvals.ensureRequest(
          user.organizationId,
          spaceId,
          linked,
          adderId,
        );
      }
    })();

    void job.catch((error: unknown) =>
      this.logger.warn(
        `Image approval request for setting ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  private canEdit(user: RequestUser, spaceId: string): Promise<boolean> {
    return this.permissions.hasSpacePermission(
      user.userId,
      user.organizationId,
      spaceId,
      'edit_space_settings',
    );
  }

  /** toConfig, plus the project of a job started through the GitLab connection, which only a lookup can name. */
  private async present(
    organizationId: string,
    row: TestAutomationConfigRow,
    canEdit: boolean,
  ): Promise<TestAutomationConfig> {
    const config = toConfig(row, canEdit);
    const jenkins =
      canEdit && !config.ci_connected
        ? await this.jenkinsConnected(organizationId, row)
        : null;

    if (jenkins) return { ...config, ci_connected: jenkins };

    const body = canEdit && !config.ci_connected ? gitlabBody(row) : null;
    const match = body
      ? await this.gitlabConnection(organizationId, row.ci_url ?? '')
      : null;

    if (!body || !match) return config;

    return {
      ...config,
      ci_connected: {
        provider: 'gitlab',
        full_name: match.repository.full_name,
        workflow: GITLAB_CI_FILE,
        ref: body.ref,
        inputs: body.inputs,
      },
    };
  }

  /** The server, job and inputs of a job this app built for a connected Jenkins server; null for any other job. */
  private async jenkinsConnected(
    organizationId: string,
    row: TestAutomationConfigRow,
  ): Promise<TestAutomationConfig['ci_connected'] | null> {
    const job =
      row.kind !== 'docker' && row.ci_url && !row.ci_headers_enc
        ? jenkinsJobOf(row.ci_url)
        : null;

    if (!job || /^\s*[[{]/.test(row.ci_body_template ?? '')) return null;

    const server = await this.jenkinsServer(organizationId, row.ci_url ?? '');

    return server
      ? {
          provider: 'jenkins',
          server_id: server.id,
          full_name: server.name,
          job_url: job,
          inputs: Object.fromEntries(
            new URLSearchParams(row.ci_body_template ?? ''),
          ),
        }
      : null;
  }

  /** The connected Jenkins server of a saved address; a failed lookup keeps today's answer. */
  private async jenkinsServer(
    organizationId: string,
    ciUrl: string,
  ): Promise<ICiServerRow | null> {
    if (!this.ciServers || !jenkinsJobName(ciUrl)) return null;

    try {
      return await this.ciServers.findForJobUrl(organizationId, ciUrl);
    } catch (error) {
      this.logger.warn(
        `Jenkins server of a CI address could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  /** The connected GitLab project of a saved address; a failed lookup keeps today's answer. */
  private async gitlabConnection(
    organizationId: string,
    ciUrl: string,
  ): Promise<GitlabMatch | null> {
    if (!gitlabPipelineAddress(ciUrl)) return null;

    try {
      const match = await this.git.gitlabCiConnection(organizationId, ciUrl);

      return match === 'unavailable' ? null : match;
    } catch (error) {
      this.logger.warn(
        `GitLab connection of a CI address could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  /** A connected GitLab project picked from the list; a failed lookup keeps today's answer. */
  private async gitlabRepository(
    organizationId: string,
    repositoryId: string,
  ): Promise<GitlabMatch | null> {
    try {
      return await this.git.gitlabRepositoryById(organizationId, repositoryId);
    } catch (error) {
      this.logger.warn(
        `GitLab repository ${repositoryId} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  async list(
    user: RequestUser,
    spaceId: string,
    archived = false,
    kind: AutomationKindFilter = 'ci_job',
  ): Promise<TestAutomationConfig[]> {
    await this.access.assertAvailable(user.organizationId, spaceId);

    let query = this.client
      .from('test_automation_configs')
      .select(CONFIG_COLUMNS)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId);

    if (kind !== 'all') query = query.eq('kind', kind);

    query = archived
      ? query.not('archived_at', 'is', null)
      : query.is('archived_at', null);

    const { data, error } = await query.order('name', { ascending: true });

    if (error) throw tmDbError(this.logger, 'list automation settings', error);

    const canEdit = await this.canEdit(user, spaceId);

    return Promise.all(
      ((data ?? []) as unknown as TestAutomationConfigRow[]).map((row) =>
        this.present(user.organizationId, row, canEdit),
      ),
    );
  }

  async get(
    user: RequestUser,
    spaceId: string,
    configId: string,
  ): Promise<TestAutomationConfig> {
    await this.access.assertAvailable(user.organizationId, spaceId);

    return this.present(
      user.organizationId,
      await this.findRow(user.organizationId, spaceId, configId),
      await this.canEdit(user, spaceId),
    );
  }

  /** The stored row of one setting in the space, or 404; callers that need secrets read them from here. */
  async findRow(
    organizationId: string,
    spaceId: string,
    configId: string,
  ): Promise<TestAutomationConfigRow> {
    const { data, error } = await this.client
      .from('test_automation_configs')
      .select(CONFIG_COLUMNS)
      .eq('id', configId)
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load automation setting', error);
    if (!data) throw notFound();

    return data as unknown as TestAutomationConfigRow;
  }

  /** Repositories an admin enabled in Tenant Configuration; none without the licence. */
  async gitRepositories(
    user: RequestUser,
    spaceId: string,
  ): Promise<TestAutomationGitRepository[]> {
    await this.access.assertAvailable(user.organizationId, spaceId);

    return this.git.connectedRepositories(user.organizationId);
  }

  /** Jenkins servers an admin connected in Tenant Configuration, without their logins. */
  async ciServerList(
    user: RequestUser,
    spaceId: string,
  ): Promise<ICiServerDto[]> {
    await this.access.assertAvailable(user.organizationId, spaceId);

    return this.ciServers ? this.ciServers.listForOrg(user.organizationId) : [];
  }

  /** Jobs and folders of a connected Jenkins server, to pick from. */
  async ciServerJobs(
    user: RequestUser,
    spaceId: string,
    serverId: string,
  ): Promise<IJenkinsJob[]> {
    await this.access.assertAvailable(user.organizationId, spaceId);

    if (!this.ciServers) throw notFound();

    return this.ciServers.listJobs(user.organizationId, serverId);
  }

  /** The picked GitHub or GitLab repository, usable through its connection; another organization's id finds nothing. */
  private async pickedRepository(
    user: RequestUser,
    spaceId: string,
    repositoryId: string,
    write: boolean,
  ): Promise<{ github: ConnectedMatch } | { gitlab: GitlabMatch }> {
    await this.access.assertAvailable(user.organizationId, spaceId, { write });

    const match = await this.git.findRepositoryById(
      user.organizationId,
      repositoryId,
    );

    if (match.state === 'connected') return { github: match };

    const gitlab = await this.gitlabRepository(
      user.organizationId,
      repositoryId,
    );

    if (gitlab) return { gitlab };

    throw invalid('ci_repository_id', NOT_CONNECTED);
  }

  /** The picked repository, usable through the connection; another organization's id finds nothing. */
  private async connectedRepository(
    user: RequestUser,
    spaceId: string,
    repositoryId: string,
    write: boolean,
  ) {
    const picked = await this.pickedRepository(
      user,
      spaceId,
      repositoryId,
      write,
    );

    if ('gitlab' in picked) {
      throw new BadRequestException({
        code: 'NOT_GITHUB',
        message:
          'GitLab uses .gitlab-ci.yml in the repository, so it has no workflow files to pick or edit here',
        data: { field: 'ci_repository_id' },
      });
    }

    return { git: this.git, match: picked.github };
  }

  // GitHub's own 401 and 403 are never passed on: the app reads those as the person's session or rights.
  private async onGithub<T>(
    operation: string,
    work: () => Promise<T>,
    writing = false,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpException) throw error;

      const status = githubStatus(error);

      this.logger.warn(`${operation} failed: ${status ?? 'none'}`);

      if (writing && status !== null && GITHUB_WRITE_REFUSALS.has(status)) {
        throw new ConflictException({
          code: 'GITHUB_WRITE_REFUSED',
          message:
            "GitHub refused the file. Check the App's Contents and Workflows permissions and any rule protecting the default branch.",
        });
      }

      throw new ServiceUnavailableException({
        code: 'GITHUB_UNAVAILABLE',
        message: 'GitHub could not be reached. Try again.',
      });
    }
  }

  /** Workflow files on the repository's default branch, to pick from. */
  async repositoryWorkflowFiles(
    user: RequestUser,
    spaceId: string,
    repositoryId: string,
  ): Promise<string[]> {
    const { git, match } = await this.connectedRepository(
      user,
      spaceId,
      repositoryId,
      false,
    );

    return this.onGithub('list workflow files', async () =>
      listWorkflowFiles(await git.actionsAccess(match)),
    );
  }

  /** Branches of the repository, to pick from. */
  async repositoryBranches(
    user: RequestUser,
    spaceId: string,
    repositoryId: string,
  ): Promise<string[]> {
    const picked = await this.pickedRepository(
      user,
      spaceId,
      repositoryId,
      false,
    );

    if ('gitlab' in picked) return this.gitlabBranches(picked.gitlab);

    return this.onGithub('list branches', () =>
      this.git.branchNames(picked.github),
    );
  }

  // GitLab's own 401 and 403 are never passed on, as with GitHub.
  private async gitlabBranches(match: GitlabMatch): Promise<string[]> {
    if (!match.app.apiUrl.startsWith('https://')) {
      throw invalid('ci_repository_id', 'GitLab server must use https');
    }

    try {
      return await this.git.gitlabBranchNames(match);
    } catch (error) {
      if (
        error instanceof GitlabConnectionError ||
        (error instanceof GithubActionsError && error.status === 401)
      ) {
        throw new ConflictException({
          code: 'GIT_CONNECTION_UNAVAILABLE',
          message:
            error instanceof GitlabConnectionError
              ? error.message
              : 'GitLab refused the connection. Reconnect GitLab in Tenant Configuration under Integrations',
        });
      }

      this.logger.warn(
        `list GitLab branches failed: ${githubStatus(error) ?? 'none'}`,
      );

      throw new ServiceUnavailableException({
        code: 'GITLAB_UNAVAILABLE',
        message: 'GitLab could not be reached. Try again.',
      });
    }
  }

  /** One workflow file to edit; its sha lets a save refuse a file someone has changed since. */
  async repositoryWorkflowFile(
    user: RequestUser,
    spaceId: string,
    repositoryId: string,
    fileName: string,
  ): Promise<{ id: string; name: string; content: string; sha: string }> {
    const { git, match } = await this.connectedRepository(
      user,
      spaceId,
      repositoryId,
      false,
    );
    const file = checkWorkflowFile(fileName);

    const found = await this.onGithub('read workflow file', async () =>
      readWorkflowFile(await git.actionsAccess(match), file),
    );

    if (!found) {
      throw new NotFoundException({
        code: 'WORKFLOW_FILE_NOT_FOUND',
        message: 'This file no longer exists in the repository',
      });
    }

    if (found === 'unreadable') {
      throw new ConflictException({
        code: 'WORKFLOW_FILE_UNREADABLE',
        message:
          'This file is over 64 KB or is not text, so it cannot be edited here',
      });
    }

    return { id: repositoryId, name: file, ...found };
  }

  /** Commits a new workflow file straight away. */
  async createRepositoryWorkflowFile(
    user: RequestUser,
    spaceId: string,
    repositoryId: string,
    dto: CreateTestAutomationWorkflowFileDto,
  ): Promise<{ id: string; name: string }> {
    const { git, match } = await this.connectedRepository(
      user,
      spaceId,
      repositoryId,
      true,
    );
    const file = checkWorkflowFile(dto.file_name);
    const content = checkWorkflowContent(dto.content);

    const result = await this.onGithub(
      'create workflow file',
      async () =>
        createWorkflowFile(await git.actionsAccess(match), file, content),
      true,
    );

    if (result === 'exists') {
      throw new ConflictException({
        code: 'WORKFLOW_FILE_EXISTS',
        message: 'A file with this name already exists in the repository',
        data: { field: 'ci_workflow' },
      });
    }

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_workflow_file',
      repositoryId,
      'create',
      {
        file_name: file,
        repository: match.repository.full_name,
        space_id: spaceId,
      },
    );

    return { id: repositoryId, name: file };
  }

  /** Commits a change straight away. */
  async updateRepositoryWorkflowFile(
    user: RequestUser,
    spaceId: string,
    repositoryId: string,
    fileName: string,
    dto: UpdateTestAutomationWorkflowFileDto,
  ): Promise<{ id: string; name: string }> {
    const { git, match } = await this.connectedRepository(
      user,
      spaceId,
      repositoryId,
      true,
    );
    const file = checkWorkflowFile(fileName);
    const content = checkWorkflowContent(dto.content);

    const result = await this.onGithub(
      'update workflow file',
      async () =>
        updateWorkflowFile(
          await git.actionsAccess(match),
          file,
          content,
          dto.sha,
        ),
      true,
    );

    if (result === 'changed') {
      throw new ConflictException({
        code: 'WORKFLOW_FILE_CHANGED',
        message: 'This file was changed in the repository after you opened it',
      });
    }

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_workflow_file',
      repositoryId,
      'update',
      {
        file_name: file,
        repository: match.repository.full_name,
        space_id: spaceId,
      },
    );

    return { id: repositoryId, name: file };
  }

  images(): TestAutomationImages {
    return {
      runner_enabled: runnerEnabled(),
      images: availableRunnerImages().map(({ key, image }) => ({
        key,
        ...runnerRuntime(image),
      })),
    };
  }

  async create(
    user: RequestUser,
    spaceId: string,
    dto: CreateTestAutomationConfigDto,
  ): Promise<TestAutomationConfig> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const { kind = 'ci_job', ...fields } = dto;
    const write = await this.prepareFor(
      kind,
      fields,
      null,
      user.organizationId,
    );

    await this.checkImageForSpace(
      user.organizationId,
      spaceId,
      write.user_image_id,
    );

    const { data, error } = await this.client
      .from('test_automation_configs')
      .insert({
        ...write,
        organization_id: user.organizationId,
        space_id: spaceId,
        name: dto.name,
        kind,
        created_by: user.userId,
        updated_by: user.userId,
      })
      .select(CONFIG_COLUMNS)
      .single();

    if (error)
      throw (
        autoNotAvailable(error) ??
        tmDbError(this.logger, 'create automation setting', error)
      );

    const row = data as unknown as TestAutomationConfigRow;

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_config',
      row.id,
      'create',
      { name: row.name, kind: row.kind, space_id: spaceId },
    );

    this.askImageApproval(user, spaceId, row, write.user_image_id, user.userId);

    return this.present(user.organizationId, row, true);
  }

  async update(
    user: RequestUser,
    spaceId: string,
    configId: string,
    dto: UpdateTestAutomationConfigDto,
  ): Promise<TestAutomationConfig> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    // The kind decides the columns and the runs, so a setting never changes it.
    if ('kind' in dto)
      throw invalid('kind', 'The kind of a setting never changes');

    const current = await this.findRow(user.organizationId, spaceId, configId);

    if (current.archived_at) throw archivedConflict();

    const write = await this.prepareFor(
      current.kind === 'docker' ? 'docker' : 'ci_job',
      dto,
      current,
      user.organizationId,
    );

    await this.checkImageForSpace(
      user.organizationId,
      spaceId,
      write.user_image_id,
    );

    const { data, error } = await this.client
      .from('test_automation_configs')
      .update({
        ...write,
        ...(dto.name !== undefined && { name: dto.name }),
        updated_by: user.userId,
      })
      .eq('id', configId)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .is('archived_at', null)
      .select(CONFIG_COLUMNS)
      .maybeSingle();

    if (error)
      throw (
        autoNotAvailable(error) ??
        tmDbError(this.logger, 'update automation setting', error)
      );

    // Archived by someone else between the read and the write.
    if (!data) throw archivedConflict();

    if (current.kind === 'docker') {
      // The setting moved from a zip to git, so its old file is no longer used.
      if (write.zip_path === null && current.zip_path) {
        await this.removeZip(current.zip_path);
      }

      void this.auditLogs.logActionForRequest(
        user,
        'test_automation_config',
        configId,
        'update',
        {
          fields: Object.keys(dto).filter((key) => key !== 'secrets'),
          secrets_changed:
            dto.secrets !== undefined ||
            dto.clear_secrets === true ||
            dto.use_connection === true,
        },
      );

      // An edit by someone else doesn't make them the one who added the image.
      this.askImageApproval(
        user,
        spaceId,
        data as unknown as TestAutomationConfigRow,
        write.user_image_id,
        null,
      );

      return toConfig(data as unknown as TestAutomationConfigRow, true);
    }

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_config',
      configId,
      'update',
      {
        fields: Object.keys(dto).filter((key) => key !== 'ci_headers'),
        ci_headers_changed:
          dto.ci_headers !== undefined ||
          dto.clear_ci_headers === true ||
          dto.ci_repository_id !== undefined ||
          dto.ci_server_id !== undefined ||
          dto.use_connection === true,
      },
    );

    return this.present(
      user.organizationId,
      data as unknown as TestAutomationConfigRow,
      true,
    );
  }

  async archive(
    user: RequestUser,
    spaceId: string,
    configId: string,
  ): Promise<TestAutomationConfig> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const current = await this.findRow(user.organizationId, spaceId, configId);

    if (current.archived_at) return toConfig(current, true);

    const now = new Date().toISOString();
    const { data, error } = await this.client
      .from('test_automation_configs')
      .update({
        archived_at: now,
        updated_by: user.userId,
      })
      .eq('id', configId)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .is('archived_at', null)
      .select(CONFIG_COLUMNS)
      .maybeSingle();

    if (error)
      throw tmDbError(this.logger, 'archive automation setting', error);
    if (!data)
      return toConfig(
        await this.findRow(user.organizationId, spaceId, configId),
        true,
      );

    if (current.kind === 'docker') {
      await this.stopRuns(user.organizationId, spaceId, configId, now);
    }

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_config',
      configId,
      'archive',
      { name: current.name },
    );

    return toConfig(data as unknown as TestAutomationConfigRow, true);
  }

  /** Refused with DUPLICATE_NAME when an active job has taken the name since it was archived. */
  async restore(
    user: RequestUser,
    spaceId: string,
    configId: string,
  ): Promise<TestAutomationConfig> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const current = await this.findRow(user.organizationId, spaceId, configId);

    if (!current.archived_at) return toConfig(current, true);

    const { data, error } = await this.client
      .from('test_automation_configs')
      .update({ archived_at: null, updated_by: user.userId })
      .eq('id', configId)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .not('archived_at', 'is', null)
      .select(CONFIG_COLUMNS)
      .maybeSingle();

    if (error) {
      throw tmDbError(this.logger, 'restore automation setting', error);
    }

    // Someone else restored it first.
    if (!data) {
      return toConfig(
        await this.findRow(user.organizationId, spaceId, configId),
        true,
      );
    }

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_config',
      configId,
      'restore',
      { name: current.name },
    );

    this.askImageApproval(
      user,
      spaceId,
      data as unknown as TestAutomationConfigRow,
      null,
      null,
    );

    return toConfig(data as unknown as TestAutomationConfigRow, true);
  }

  /** Past runs stay: the database clears their link and they keep the job's saved name. */
  async remove(
    user: RequestUser,
    spaceId: string,
    configId: string,
  ): Promise<void> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const current = await this.findRow(user.organizationId, spaceId, configId);
    const isDocker = current.kind === 'docker';
    const runs = this.client
      .from('test_automation_runs')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .eq('config_id', configId);
    const { count, error: runsError } = await (isDocker
      ? runs.in('status', RUNNER_GOING_STATES)
      : runs.eq('status', 'REQUESTED').or(CI_IN_PROGRESS_FILTER));

    if (runsError) {
      throw tmDbError(
        this.logger,
        'check runs of automation setting',
        runsError,
      );
    }

    if (count) {
      throw new ConflictException({
        code: 'RUNS_IN_PROGRESS',
        message:
          'A run of this job is still going. Stop it or wait for it to finish, then delete the job.',
      });
    }

    const { data, error } = await this.client
      .from('test_automation_configs')
      .delete()
      .eq('id', configId)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .eq('kind', isDocker ? 'docker' : 'ci_job')
      .select('id')
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'delete automation setting', error);
    if (!data) throw notFound();

    if (isDocker) {
      await this.removeSettingFiles(user, spaceId, configId, current.zip_path);
    }

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_config',
      configId,
      'delete',
      { name: current.name },
    );
  }

  async uploadZip(
    user: RequestUser,
    spaceId: string,
    configId: string,
    file: Express.Multer.File,
  ): Promise<TestAutomationConfig> {
    await this.access.assertAvailable(user.organizationId, spaceId, {
      write: true,
    });

    const current = await this.findRow(user.organizationId, spaceId, configId);

    if (current.archived_at) throw archivedConflict();
    if (current.kind !== 'docker' || current.source !== 'zip') {
      throw invalid(
        'source',
        'Choose "Upload a zip" as the test code source first',
      );
    }

    if (!file.originalname.toLowerCase().endsWith('.zip')) {
      throw invalid('file', 'Choose a .zip file');
    }

    if (file.size > AUTOMATION_LIMITS.zipBytes) {
      throw invalid('file', 'The zip may be at most 50 MB');
    }

    const problem = await checkZip(file.buffer);

    if (problem) {
      throw new BadRequestException({
        code: 'ZIP_REJECTED',
        field: 'file',
        reason: problem,
        message: ZIP_MESSAGES[problem],
        data: { field: 'file', reason: problem },
      });
    }

    // A zip with no files would only fail later, when a run finds nothing to test.
    if (await holdsNoFiles(file.buffer)) throw zipRejected('EMPTY');

    const path = `automation/${user.organizationId}/${spaceId}/${configId}/${randomUUID()}.zip`;
    const storage = this.client.storage.from(AUTOMATION_BUCKET);
    const { error: uploadError } = await storage.upload(path, file.buffer, {
      contentType: 'application/zip',
      upsert: false,
    });

    if (uploadError) {
      this.logger.error(
        `Failed to store automation zip for ${configId}`,
        uploadError,
      );

      throw new BadRequestException({
        code: 'UPLOAD_FAILED',
        message: 'The zip could not be stored, please try again',
      });
    }

    const saved = await this.saveZipPath(user, spaceId, current, path);

    if (current.zip_path) await this.removeZip(current.zip_path);

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_config',
      configId,
      'update',
      { zip_uploaded: true, size: file.size },
    );

    return toConfig(saved, true);
  }

  async listFiles(
    user: RequestUser,
    spaceId: string,
    configId: string,
  ): Promise<TestAutomationFiles> {
    const current = await this.zipSetting(user, spaceId, configId, false);

    if (!current.zip_path) return { version: null, files: [] };

    const source = await this.downloadZip(user, spaceId, current);
    const { files } = await this.zipFileRules(() => listZipFiles(source));

    return { version: zipVersion(current.zip_path), files };
  }

  async readFile(
    user: RequestUser,
    spaceId: string,
    configId: string,
    path: string,
  ): Promise<TestAutomationFileContent> {
    const current = await this.zipSetting(user, spaceId, configId, false);

    if (!current.zip_path) throw notFound();

    const source = await this.downloadZip(user, spaceId, current);
    const file = await this.zipFileRules(() => readZipFile(source, path));

    if (!file) throw notFound();

    return { path, version: zipVersion(current.zip_path), ...file };
  }

  async saveFile(
    user: RequestUser,
    spaceId: string,
    configId: string,
    dto: SaveTestAutomationFileDto,
  ): Promise<TestAutomationFilesChange> {
    const content = Buffer.from(dto.content, 'utf8');

    if (content.length > AUTOMATION_LIMITS.fileTextBytes) {
      throw invalid('content', 'A file edited here may be at most 1 MB');
    }

    // It could never be opened again, because a NUL byte makes a file binary.
    if (content.includes(0)) {
      throw invalid('content', 'Upload a binary file instead of editing it');
    }

    return this.changeFile(user, spaceId, configId, dto, content, 'saved');
  }

  uploadFile(
    user: RequestUser,
    spaceId: string,
    configId: string,
    dto: TestAutomationFileVersionDto,
    file: Express.Multer.File,
  ): Promise<TestAutomationFilesChange> {
    return this.changeFile(
      user,
      spaceId,
      configId,
      dto,
      file.buffer,
      'uploaded',
    );
  }

  async deleteFile(
    user: RequestUser,
    spaceId: string,
    configId: string,
    dto: TestAutomationFileVersionDto,
  ): Promise<TestAutomationFilesChange> {
    const change = await this.changeFile(
      user,
      spaceId,
      configId,
      dto,
      null,
      'deleted',
    );
    const keys = await this.casesLinkedTo(
      user.organizationId,
      spaceId,
      change.config.work_dir,
      dto.path,
    );

    return keys.length > 0 ? { ...change, linked_case_keys: keys } : change;
  }

  /** Removes several files in one new zip, or none when any of them is missing. */
  async deleteFiles(
    user: RequestUser,
    spaceId: string,
    configId: string,
    dto: DeleteTestAutomationFilesDto,
  ): Promise<TestAutomationFilesChange> {
    const paths = [...new Set(dto.paths)];
    const current = await this.zipSetting(user, spaceId, configId, true);

    if ((dto.version ?? null) !== zipVersion(current.zip_path)) {
      throw filesChanged();
    }

    const source = current.zip_path
      ? await this.downloadZip(user, spaceId, current)
      : null;
    const files = source
      ? (await this.zipFileRules(() => listZipFiles(source))).files
      : [];
    const missing = paths.filter(
      (path) => !files.some((file) => file.path === path),
    );

    if (missing.length > 0) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: `Not in the test project: ${missing.join(', ')}`,
        data: { paths: missing },
      });
    }

    const removesAll = files.every((file) => paths.includes(file.path));
    const rebuilt = removesAll
      ? null
      : await this.zipFileRules(() =>
          rebuildZip(source, paths[0], null, paths.slice(1)),
        );
    const next = rebuilt
      ? await this.storeRebuiltZip(user, spaceId, configId, rebuilt)
      : null;
    const saved = await this.saveZipPath(user, spaceId, current, next);

    if (current.zip_path) await this.removeZip(current.zip_path);

    await this.removeForgottenZips(user, spaceId, configId, next);

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_config',
      configId,
      'update',
      { file_action: 'deleted', paths },
    );

    const change: TestAutomationFilesChange = {
      config: toConfig(saved, true),
      version: zipVersion(saved.zip_path),
      files: rebuilt
        ? (await this.zipFileRules(() => listZipFiles(rebuilt))).files
        : [],
    };
    const keys = new Set<string>();

    for (const path of paths) {
      const linked = await this.casesLinkedTo(
        user.organizationId,
        spaceId,
        change.config.work_dir,
        path,
      );

      linked.forEach((key) => keys.add(key));
    }

    return keys.size > 0
      ? { ...change, linked_case_keys: [...keys].sort() }
      : change;
  }

  /** The file is already gone by now, so a failed read only costs the warning. */
  private async casesLinkedTo(
    organizationId: string,
    spaceId: string,
    workDir: string | null,
    path: string,
  ): Promise<string[]> {
    // Test cases hold the path a run uses, which starts at the tests folder.
    const folder = cleanProjectPath(workDir ?? '');
    const cleaned = cleanProjectPath(path);

    if (folder && !cleaned.startsWith(`${folder}/`)) return [];

    try {
      const { data, error } = await this.client
        .from('test_cases')
        .select(ticketEmbed('test_cases', 'key'))
        .eq('organization_id', organizationId)
        .eq('space_id', spaceId)
        .eq(
          'automation_spec_path',
          folder ? cleaned.slice(folder.length + 1) : cleaned,
        );

      if (error) throw new Error(error.message);

      return ((data ?? []) as unknown as { task: { key: string } }[])
        .map((row) => row.task.key)
        .sort();
    } catch (error) {
      this.logger.warn(
        `Test cases linked to a deleted file could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );

      return [];
    }
  }

  /** The setting whose zip the files live in, always through the row of this organization and space. */
  private async zipSetting(
    user: RequestUser,
    spaceId: string,
    configId: string,
    write: boolean,
  ): Promise<TestAutomationConfigRow> {
    await this.access.assertAvailable(user.organizationId, spaceId, { write });

    const current = await this.findRow(user.organizationId, spaceId, configId);

    if (write && current.archived_at) throw archivedConflict();
    if (current.kind !== 'docker' || current.source !== 'zip') {
      throw invalid(
        'source',
        'Choose "Upload a zip" as the test code source first',
      );
    }

    return current;
  }

  /** File names in a stored zip. The path always comes from a row, never from a client. */
  async zipFilePaths(path: string): Promise<string[]> {
    const { data, error } = await this.client.storage
      .from(AUTOMATION_BUCKET)
      .download(path);

    if (error || !data) {
      this.logger.error(`Failed to read the automation zip ${path}`, error);

      throw new ServiceUnavailableException({
        code: 'ZIP_COPY_FAILED',
        message: 'The test project could not be read, please try again',
      });
    }

    const source = Buffer.from(await data.arrayBuffer());
    const { files } = await this.zipFileRules(() => listZipFiles(source));

    return files.map((file) => file.path);
  }

  /** The framework an auto run of a stored zip would use, and its file names. The path always comes from a row. */
  async zipFramework(
    path: string,
    workDir: string | null,
  ): Promise<{ files: string[]; detected: FrameworkDetection }> {
    const { data, error } = await this.client.storage
      .from(AUTOMATION_BUCKET)
      .download(path);

    if (error || !data) {
      this.logger.error(`Failed to read the automation zip ${path}`, error);

      throw new ServiceUnavailableException({
        code: 'ZIP_COPY_FAILED',
        message: 'The test project could not be read, please try again',
      });
    }

    const source = Buffer.from(await data.arrayBuffer());
    const { files } = await this.zipFileRules(() => listZipFiles(source));
    const names = files.map((file) => file.path);
    const folder = cleanProjectPath(workDir ?? '');
    const wanted = folder ? `${folder}/package.json` : 'package.json';
    const stored = names.find((name) => cleanProjectPath(name) === wanted);
    // A package.json that can't be read counts as missing; config files still decide.
    const pkg = stored
      ? await readZipFile(source, stored).catch(() => null)
      : null;

    return {
      files: names,
      detected: detectFramework(
        names,
        (name) => (name === wanted ? (pkg?.content ?? null) : null),
        workDir,
      ),
    };
  }

  /** What an auto run of a zip setting would use, so it can be checked before a run. */
  async framework(
    user: RequestUser,
    spaceId: string,
    configId: string,
  ): Promise<NonNullable<FrameworkDetection> | { preset: null }> {
    await this.access.assertAvailable(user.organizationId, spaceId);

    const current = await this.findRow(user.organizationId, spaceId, configId);

    if (current.kind !== 'docker') {
      throw new BadRequestException({
        code: 'NOT_A_RUNNER_SETTING',
        message: 'This setting starts a CI job, not a run on the runner',
      });
    }

    if (current.source !== 'zip') {
      throw new BadRequestException({
        code: 'DETECTED_AT_RUN',
        message:
          'The framework of a Git setting is detected when the run starts',
      });
    }

    if (!current.zip_path) {
      throw new BadRequestException({
        code: 'ZIP_MISSING',
        message: 'Upload the test project as a zip first',
      });
    }

    const { detected } = await this.zipFramework(
      current.zip_path,
      current.work_dir,
    );

    return detected ?? { preset: null };
  }

  /** Always the path from the row, never a value a client sent. */
  private async downloadZip(
    user: RequestUser,
    spaceId: string,
    row: TestAutomationConfigRow,
  ): Promise<Buffer> {
    const { data, error } = await this.client.storage
      .from(AUTOMATION_BUCKET)
      .download(row.zip_path ?? '');

    if (data && !error) return Buffer.from(await data.arrayBuffer());

    // Someone else's change removes the old zip right after replacing it.
    const latest = await this.findRow(user.organizationId, spaceId, row.id);

    if (latest.zip_path !== row.zip_path) throw filesChanged();

    this.logger.error(`Failed to read the automation zip of ${row.id}`, error);

    throw new ServiceUnavailableException({
      code: 'ZIP_COPY_FAILED',
      message: 'The test project could not be read, please try again',
    });
  }

  /** Turns a refusal from the zip code into the answer the API gives. */
  private async zipFileRules<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof ZipFileError)) throw error;
      if (error.problem === 'TOO_LARGE') {
        throw invalid('file', 'The zip may be at most 50 MB');
      }

      if (error.problem === 'TOO_LARGE_UNPACKED') {
        throw zipRejected('TOO_LARGE_UNPACKED');
      }

      throw new BadRequestException({
        code: 'ZIP_NOT_EDITABLE',
        message:
          "This zip has encrypted or unsupported files, so it can't be changed here. Replace the whole zip",
      });
    }
  }

  /** Writes a new zip with one file changed, or clears the path when the last file goes. Runs keep their own copy. */
  private async changeFile(
    user: RequestUser,
    spaceId: string,
    configId: string,
    dto: TestAutomationFileVersionDto,
    content: Buffer | null,
    action: 'saved' | 'uploaded' | 'deleted',
  ): Promise<TestAutomationFilesChange> {
    const current = await this.zipSetting(user, spaceId, configId, true);

    if ((dto.version ?? null) !== zipVersion(current.zip_path)) {
      throw filesChanged();
    }

    const source = current.zip_path
      ? await this.downloadZip(user, spaceId, current)
      : null;
    const { names, files } = source
      ? await this.zipFileRules(() => listZipFiles(source))
      : { names: [], files: [] };
    const exists = files.some((file) => file.path === dto.path);

    if (!content && !exists) throw notFound();

    // Only a new name follows these rules, so an existing file with spaces can still be replaced and a delete can repair.
    if (content && !exists) {
      checkFilePath(dto.path);

      if (collidesWith(dto.path, names)) {
        throw invalid(
          'path',
          'This name clashes with another file or folder in the zip',
        );
      }
    }

    const isLastFile = !content && files.length === 1;
    const rebuilt = isLastFile
      ? null
      : await this.zipFileRules(() => rebuildZip(source, dto.path, content));
    const next = rebuilt
      ? await this.storeRebuiltZip(user, spaceId, configId, rebuilt)
      : null;
    const saved = await this.saveZipPath(user, spaceId, current, next);

    if (current.zip_path) await this.removeZip(current.zip_path);

    await this.removeForgottenZips(user, spaceId, configId, next);

    void this.auditLogs.logActionForRequest(
      user,
      'test_automation_config',
      configId,
      'update',
      { file_action: action, path: dto.path },
    );

    return {
      config: toConfig(saved, true),
      version: zipVersion(saved.zip_path),
      files: rebuilt
        ? (await this.zipFileRules(() => listZipFiles(rebuilt))).files
        : [],
    };
  }

  /** checkZip has no compressed-size limit, so rebuildZip stops at 50 MB itself. */
  private async storeRebuiltZip(
    user: RequestUser,
    spaceId: string,
    configId: string,
    buffer: Buffer,
  ): Promise<string> {
    const problem = await checkZip(buffer);

    if (problem) throw zipRejected(problem);

    const path = `automation/${user.organizationId}/${spaceId}/${configId}/${randomUUID()}.zip`;
    const { error } = await this.client.storage
      .from(AUTOMATION_BUCKET)
      .upload(path, buffer, { contentType: 'application/zip', upsert: false });

    if (error) {
      this.logger.error(
        `Failed to store automation zip for ${configId}`,
        error,
      );

      throw new BadRequestException({
        code: 'UPLOAD_FAILED',
        message: 'The zip could not be stored, please try again',
      });
    }

    return path;
  }

  /** Moves the setting to a new zip only while it still has the one that was read. A loser removes its own new file. */
  private async saveZipPath(
    user: RequestUser,
    spaceId: string,
    current: TestAutomationConfigRow,
    next: string | null,
  ): Promise<TestAutomationConfigRow> {
    const update = this.client
      .from('test_automation_configs')
      .update({ zip_path: next, updated_by: user.userId })
      .eq('id', current.id)
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .is('archived_at', null);

    // .eq with null matches nothing, so a first file needs .is.
    const { data, error } = await (
      current.zip_path
        ? update.eq('zip_path', current.zip_path)
        : update.is('zip_path', null)
    )
      .select(CONFIG_COLUMNS)
      .maybeSingle();

    if (data && !error) return data as unknown as TestAutomationConfigRow;

    // The new file is useless without its row, so it goes again.
    if (next) await this.removeZip(next);

    if (error) throw tmDbError(this.logger, 'save automation zip', error);

    const latest = await this.findRow(user.organizationId, spaceId, current.id);

    throw latest.archived_at ? archivedConflict() : filesChanged();
  }

  /**
   * Zips whose removal failed earlier, so they can't pile up. Only old ones, because a fresh one may be another
   * person's change about to be saved. Listing one level leaves the runs folder alone.
   */
  private async removeForgottenZips(
    user: RequestUser,
    spaceId: string,
    configId: string,
    keep: string | null,
  ): Promise<void> {
    const folder = `automation/${user.organizationId}/${spaceId}/${configId}`;
    const { data, error } = await this.client.storage
      .from(AUTOMATION_BUCKET)
      .list(folder, { limit: 1000 });

    if (error) {
      this.logger.warn(
        `Failed to list automation zips of ${configId}: ${error.message}`,
      );

      return;
    }

    const oldest = Date.now() - FORGOTTEN_ZIP_AGE_MS;

    for (const item of data ?? []) {
      const path = `${folder}/${item.name}`;

      // Folders have no id.
      if (
        item.id &&
        item.name.endsWith('.zip') &&
        path !== keep &&
        Date.parse(item.created_at ?? '') < oldest
      ) {
        await this.removeZip(path);
      }
    }
  }

  /** Waiting runs of an archived setting end at once; running ones are asked to stop. */
  private async stopRuns(
    organizationId: string,
    spaceId: string,
    configId: string,
    now: string,
  ): Promise<void> {
    const runs = this.client.from('test_automation_runs');
    const { data: cancelled, error: queuedError } = await runs
      .update({ status: 'CANCELLED', finished_at: now })
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('config_id', configId)
      .eq('status', 'QUEUED')
      .select('run_zip_path');

    if (queuedError) {
      this.logger.error(
        `Failed to cancel queued runs of ${configId}`,
        queuedError,
      );
    }

    // A cancelled run never starts, so its own copy of the zip is no longer used.
    for (const run of (cancelled ?? []) as { run_zip_path: string | null }[]) {
      if (run.run_zip_path) await this.removeZip(run.run_zip_path);
    }

    const { error: runningError } = await this.client
      .from('test_automation_runs')
      .update({ cancel_requested_at: now })
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId)
      .eq('config_id', configId)
      .eq('status', 'RUNNING')
      .is('cancel_requested_at', null);

    if (runningError) {
      this.logger.error(
        `Failed to stop running runs of ${configId}`,
        runningError,
      );
    }
  }

  private async removeZip(path: string): Promise<void> {
    const { error } = await this.client.storage
      .from(AUTOMATION_BUCKET)
      .remove([path]);

    if (error)
      this.logger.warn(
        `Failed to remove automation zip ${path}: ${error.message}`,
      );
  }

  /** After a delete nothing points at the setting's zips; run copies one level down stay with their runs. */
  private async removeSettingFiles(
    user: RequestUser,
    spaceId: string,
    configId: string,
    zipPath: string | null,
  ): Promise<void> {
    try {
      if (zipPath) await this.removeZip(zipPath);

      const folder = `automation/${user.organizationId}/${spaceId}/${configId}`;
      const { data, error } = await this.client.storage
        .from(AUTOMATION_BUCKET)
        .list(folder, { limit: 1000 });

      if (error) throw new Error(error.message);

      // Folders have no id.
      const paths = (data ?? [])
        .filter((item) => item.id)
        .map((item) => `${folder}/${item.name}`)
        .filter((path) => path !== zipPath);

      if (paths.length > 0) {
        const { error: removeError } = await this.client.storage
          .from(AUTOMATION_BUCKET)
          .remove(paths);

        if (removeError) throw new Error(removeError.message);
      }
    } catch (error) {
      this.logger.warn(
        `Files of the deleted automation setting ${configId} were kept: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Checks that the fields belong to the kind, then checks them against the setting as it will be. */
  private async prepareFor(
    kind: AutomationKind,
    dto: UpdateTestAutomationConfigDto,
    current: TestAutomationConfigRow | null,
    organizationId: string,
  ): Promise<ConfigWrite> {
    const foreign = kind === 'docker' ? CI_FIELDS : DOCKER_FIELDS;
    const misplaced = foreign.find((field) => dto[field] !== undefined);

    if (misplaced) {
      throw invalid(
        misplaced,
        kind === 'docker'
          ? 'This field is only used by a CI job'
          : 'This field is only used by a Docker run',
      );
    }

    return kind === 'docker'
      ? this.prepareDocker(dto, current, organizationId)
      : this.prepare(dto, current, organizationId);
  }

  /** A connected GitHub repository stores no token; any other public https address may be typed. */
  private async checkGitConnection(
    git: TestAutomationGitService,
    dto: UpdateTestAutomationConfigDto,
    repoUrl: string,
    organizationId: string,
  ): Promise<void> {
    const sendsToken = dto.secrets !== undefined && GIT_TOKEN in dto.secrets;

    if (!sendsToken) return;

    const key = repositoryKey(repoUrl);
    const listed = (await git.connectedRepositories(organizationId)).find(
      (repository) => repositoryKey(repository.web_url) === key,
    );

    if (sendsToken && listed?.provider === 'github') {
      throw invalid('secrets', USES_CONNECTION);
    }
  }

  /** Removes the stored token, once the repository really can use the connection. */
  private async withoutGitToken(
    git: TestAutomationGitService,
    current: TestAutomationConfigRow | null,
    repoUrl: string,
    organizationId: string,
  ): Promise<string | null> {
    const match = current
      ? await git.findRepository(organizationId, repoUrl)
      : null;

    if (match?.state !== 'connected') {
      throw invalid('use_connection', NOT_CONNECTED);
    }

    const kept = readSecretMap(current?.secrets_enc ?? null);

    delete kept[GIT_TOKEN];

    return packSecretMap('secrets', kept);
  }

  private async prepareDocker(
    dto: UpdateTestAutomationConfigDto,
    current: TestAutomationConfigRow | null,
    organizationId: string,
  ): Promise<ConfigWrite> {
    const preset = dto.preset ?? current?.preset ?? null;
    const auto = preset === 'auto';
    const imageKey = auto
      ? AUTO_IMAGE_KEY
      : (dto.image_key ?? current?.image_key ?? null);
    const source = dto.source ?? current?.source ?? null;

    if (!preset) throw invalid('preset', 'Choose a framework');
    if (!imageKey) throw invalid('image_key', 'Choose a runner image');
    if (!source)
      throw invalid('source', 'Choose where the test code comes from');

    // The auto image only exists for the auto preset, so leaving auto needs a real image.
    if (!auto && imageKey === AUTO_IMAGE_KEY) {
      throw invalid('image_key', 'Choose an image for this framework');
    }

    if (auto && (dto.command?.trim() || dto.install_command?.trim())) {
      throw invalid(
        dto.command?.trim() ? 'command' : 'install_command',
        "A setting that detects its framework runs the framework's own commands",
      );
    }

    const userImageId = await customImageLink(
      this.customImages,
      organizationId,
      { requested: dto.user_image_id, preset, imageKey, current },
    );

    if (
      !auto &&
      !isOwnImageKey(imageKey) &&
      (dto.image_key !== undefined || !current)
    ) {
      const images = availableRunnerImages();

      if (!images.some((image) => image.key === imageKey)) {
        throw invalid(
          'image_key',
          images.length === 0
            ? 'No runner images are set up on this server'
            : 'Choose one of the runner images of this server',
        );
      }
    }

    if (dto.secrets !== undefined && dto.clear_secrets) {
      throw invalid('secrets', 'Send new secrets or clear them, not both');
    }

    // Leaving the custom preset drops its command, because it would become an override with no result file.
    const leavingCustom = current?.preset === 'custom' && preset !== 'custom';
    const command =
      (dto.command ?? (leavingCustom ? '' : current?.command) ?? '').trim() ||
      null;

    if (preset === 'custom' && !command) {
      throw invalid('command', 'Enter the command that runs the tests');
    }

    const repoUrl =
      source === 'git' ? (dto.repo_url ?? current?.repo_url ?? '') : '';

    if (source === 'git' && !repoUrl) {
      throw invalid('repo_url', 'Enter the repository URL');
    }

    if (source === 'git') {
      await this.checkGitConnection(this.git, dto, repoUrl, organizationId);
    }

    const resultPaths = (
      auto
        ? [AUTO_RESULT_PATH]
        : (dto.result_paths ?? current?.result_paths ?? [])
    ).map((path) => checkRelativePath('result_paths', path.trim()));

    if (resultPaths.length === 0) {
      throw invalid('result_paths', 'Enter where the test results are written');
    }

    const workDir = (dto.work_dir ?? current?.work_dir ?? '').trim();
    const repoRef = (dto.repo_ref ?? current?.repo_ref ?? '').trim();

    const write: ConfigWrite = {
      preset,
      image_key: imageKey,
      source,
      command: auto ? null : command,
      result_paths: [...new Set(resultPaths)],
      work_dir: workDir ? checkRelativePath('work_dir', workDir) : null,
      repo_url:
        source === 'git'
          ? dto.repo_url !== undefined || !current
            ? await checkRepoUrl(repoUrl)
            : repoUrl
          : null,
      repo_ref:
        source === 'git' && repoRef ? checkRepoRef(repoRef, 'repo_ref') : null,
    };

    if (userImageId !== undefined) write.user_image_id = userImageId;
    if (source === 'git' && current?.zip_path) write.zip_path = null;
    if (dto.install_command !== undefined) {
      write.install_command = dto.install_command.trim() || null;
    }

    if (auto && current?.install_command) write.install_command = null;

    if (dto.env !== undefined) write.env = checkEnv('env', dto.env);
    if (dto.secrets !== undefined) {
      write.secrets_enc = packSecretMap(
        'secrets',
        checkEnv('secrets', dto.secrets),
      );
    }

    if (dto.clear_secrets) write.secrets_enc = null;
    if (dto.use_connection) {
      if (source !== 'git' || dto.secrets !== undefined || dto.clear_secrets) {
        throw invalid('use_connection', NOT_CONNECTED);
      }

      write.secrets_enc = await this.withoutGitToken(
        this.git,
        current,
        repoUrl,
        organizationId,
      );
    }

    // A name set both ways would be overwritten at run time, so it must be one or the other.
    const envNames = Object.keys(write.env ?? current?.env ?? {});
    const secretNames = Object.keys(
      readSecretMap(
        write.secrets_enc !== undefined
          ? write.secrets_enc
          : (current?.secrets_enc ?? null),
      ),
    );
    const both = envNames.find((name) => secretNames.includes(name));

    if (both)
      throw invalid('env', `${both} is also saved as a password or token`);

    if (dto.allowed_hosts !== undefined) {
      write.allowed_hosts = await checkHosts(dto.allowed_hosts);
    }

    if (dto.create_unmatched !== undefined)
      write.create_unmatched = dto.create_unmatched;
    if (dto.timeout_minutes !== undefined)
      write.timeout_minutes = dto.timeout_minutes;
    if (dto.trace_mode !== undefined) write.trace_mode = dto.trace_mode;

    return write;
  }

  private async prepareConnected(
    dto: UpdateTestAutomationConfigDto,
    organizationId: string,
  ): Promise<ConfigWrite> {
    const match = dto.ci_repository_id
      ? await this.git.findRepositoryById(organizationId, dto.ci_repository_id)
      : null;

    if (match?.state !== 'connected') {
      const gitlab = dto.ci_repository_id
        ? await this.gitlabRepository(organizationId, dto.ci_repository_id)
        : null;

      if (gitlab) return this.prepareGitlab(dto, gitlab);

      throw invalid('ci_repository_id', NOT_CONNECTED);
    }

    const typed = HAND_TYPED_CI_FIELDS.find(
      (field) => dto[field] !== undefined,
    );

    if (typed) throw invalid(typed, USES_CONNECTION);
    if (dto.use_connection) throw invalid('use_connection', NOT_CONNECTED);

    const workflow = checkWorkflowFile(dto.ci_workflow ?? '');
    const ref = checkRepoRef(
      dto.ci_ref || (match.repository.default_branch ?? ''),
    );
    const body = JSON.stringify({
      ref,
      inputs: checkCiInputs(dto.ci_inputs ?? {}),
      return_run_details: true,
    });

    if (body.length > AUTOMATION_LIMITS.ciBody) {
      throw invalid('ci_inputs', 'The inputs are too long in total');
    }

    return {
      ci_url: await checkCiUrl(await this.git.dispatchUrl(match, workflow)),
      ci_method: 'POST',
      ci_headers_enc: null,
      ci_body_template: body,
    };
  }

  /** A pipeline of the picked GitLab project on a branch; the inputs become pipeline variables. */
  private async prepareGitlab(
    dto: UpdateTestAutomationConfigDto,
    match: GitlabMatch,
  ): Promise<ConfigWrite> {
    const typed = HAND_TYPED_CI_FIELDS.find(
      (field) => dto[field] !== undefined,
    );

    if (typed) throw invalid(typed, USES_GITLAB_CONNECTION);
    if (dto.use_connection) throw invalid('use_connection', NOT_CONNECTED);
    // An empty value means nothing was picked.
    if (dto.ci_workflow) throw invalid('ci_workflow', GITLAB_NO_WORKFLOW);

    // The token goes in the request, so a plain http server is never used.
    if (!match.app.apiUrl.startsWith('https://')) {
      throw invalid('ci_repository_id', 'GitLab server must use https');
    }

    const ref = checkRepoRef(dto.ci_ref ?? '');
    const inputs = Object.entries(checkCiInputs(dto.ci_inputs ?? {}));
    // GitLab variable names allow only letters, digits and underscores.
    const badName = inputs.find(([key]) => !/^[A-Za-z0-9_]+$/.test(key));

    if (badName) {
      throw invalid(
        'ci_inputs',
        `GitLab variable names may use only letters, digits and _ (${badName[0]})`,
      );
    }

    const body = JSON.stringify({
      ref,
      variables: inputs.map(([key, value]) => ({ key, value })),
    });

    if (body.length > AUTOMATION_LIMITS.ciBody) {
      throw invalid('ci_inputs', 'The inputs are too long in total');
    }

    return {
      ci_url: await checkCiUrl(this.git.gitlabPipelineUrl(match)),
      ci_method: 'POST',
      ci_headers_enc: null,
      ci_body_template: body,
    };
  }

  /** A job of a Jenkins server connected in Integrations; the server's saved user signs each start in. */
  private async prepareJenkins(
    dto: UpdateTestAutomationConfigDto,
    organizationId: string,
  ): Promise<ConfigWrite> {
    const typed = HAND_TYPED_CI_FIELDS.find(
      (field) => dto[field] !== undefined,
    );

    if (typed) throw invalid(typed, USES_JENKINS_CONNECTION);
    if (dto.ci_repository_id !== undefined) {
      throw invalid(
        'ci_repository_id',
        'Pick a repository or a Jenkins server, not both',
      );
    }

    // Empty values mean nothing was picked.
    if (dto.ci_workflow) {
      throw invalid('ci_workflow', 'A Jenkins job has no workflow file');
    }

    if (dto.ci_ref) {
      throw invalid(
        'ci_ref',
        'A Jenkins job runs the branch set up in Jenkins',
      );
    }

    if (dto.use_connection) throw invalid('use_connection', NOT_CONNECTED);

    const servers =
      this.ciServers && dto.ci_server_id
        ? await this.ciServers.listForOrg(organizationId)
        : [];
    const server = servers.find((found) => found.id === dto.ci_server_id);

    if (!server) throw invalid('ci_server_id', JENKINS_NOT_CONNECTED);

    let picked: URL | null = null;

    try {
      picked = new URL(dto.ci_jenkins_job ?? '');
    } catch {
      // Refused below.
    }

    const job = picked
      ? `${picked.origin}${picked.pathname}`.replace(/\/+$/, '')
      : '';

    if (
      !picked ||
      picked.search ||
      picked.hash ||
      picked.username ||
      picked.password ||
      !/\/job\/[^/]+$/.test(job) ||
      !isJobUrlOf(server.base_url, job)
    ) {
      throw invalid('ci_jenkins_job', 'Pick a job of this Jenkins server');
    }

    const given = checkCiInputs(dto.ci_inputs ?? {});

    // Jenkins refuses /build for a job with parameters ("Nothing is submitted"), so the job itself decides.
    const takesParameters = await this.jenkinsTakesParameters(
      organizationId,
      server.id,
      job,
    );

    if (Object.keys(given).length && takesParameters === false) {
      throw invalid(
        'ci_inputs',
        'This Jenkins job takes no parameters; leave them empty',
      );
    }

    // A job with parameters also gets the run's own values, so its results reach this run; typed values win.
    const inputs = Object.entries(
      takesParameters ? { ...JENKINS_RUN_VALUES, ...given } : given,
    );
    const body = inputs.length
      ? inputs
          .map(([name, value]) => `${formPart(name)}=${formPart(value)}`)
          .join('&')
      : null;

    if (body && body.length > AUTOMATION_LIMITS.ciBody) {
      throw invalid('ci_inputs', 'The inputs are too long in total');
    }

    return {
      ci_url: await checkCiUrl(
        `${job}/${body ? 'buildWithParameters' : 'build'}`,
      ),
      ci_method: 'POST',
      ci_headers_enc: null,
      ci_body_template: body,
    };
  }

  /** Null when Jenkins can't be asked; the typed parameters decide then, as before. */
  private async jenkinsTakesParameters(
    organizationId: string,
    serverId: string,
    job: string,
  ): Promise<boolean | null> {
    try {
      const jobs = await this.ciServers?.listJobs(organizationId, serverId);
      const found = jobs?.find((item) => sameJob(item.url, job));

      return found ? found.has_parameters : null;
    } catch {
      return null;
    }
  }

  /** Removes the stored headers of a job whose address really is a connected repository's. */
  private async useConnection(
    dto: UpdateTestAutomationConfigDto,
    current: TestAutomationConfigRow | null,
    organizationId: string,
  ): Promise<ConfigWrite> {
    const typed = HAND_TYPED_CI_FIELDS.find(
      (field) => dto[field] !== undefined,
    );
    const connection =
      current?.ci_url && !typed
        ? await this.git.ciConnection(organizationId, current.ci_url)
        : null;

    if (connection?.state !== 'connected') {
      // GitLab takes the body as it is; return_run_details is GitHub's.
      const gitlab =
        current?.ci_url && !typed
          ? await this.gitlabConnection(organizationId, current.ci_url)
          : null;

      if (gitlab) return { ci_headers_enc: null };

      // A trigger-token job moves to the project's pipeline address, and its trigger token is dropped.
      const pipeline =
        current?.ci_url && !typed
          ? gitlabPipelineOfTrigger(current.ci_url)
          : null;
      const moved =
        pipeline && (await this.gitlabConnection(organizationId, pipeline));

      if (moved) {
        const body = gitlabBodyOfTrigger(current?.ci_body_template ?? null);

        if (!body) throw invalid('use_connection', GITLAB_REPICK);

        return {
          ci_url: await checkCiUrl(pipeline),
          ci_headers_enc: null,
          ci_body_template: body,
        };
      }

      // A typed Jenkins job keeps its address and body; the connected server's login replaces the saved one.
      if (
        current?.ci_url &&
        !typed &&
        (await this.jenkinsServer(organizationId, current.ci_url))
      ) {
        return { ci_headers_enc: null };
      }

      throw invalid('use_connection', NOT_CONNECTED);
    }

    return {
      ci_headers_enc: null,
      ci_body_template: withRunDetails(current?.ci_body_template ?? null),
    };
  }

  /** Checks the fields against the setting as it will be after the change. */
  private async prepare(
    dto: UpdateTestAutomationConfigDto,
    current: TestAutomationConfigRow | null,
    organizationId: string,
  ): Promise<ConfigWrite> {
    if (dto.ci_server_id !== undefined || dto.ci_jenkins_job !== undefined) {
      return this.prepareJenkins(dto, organizationId);
    }

    const connectedField =
      dto.ci_repository_id ?? dto.ci_workflow ?? dto.ci_ref ?? dto.ci_inputs;

    if (connectedField !== undefined) {
      return this.prepareConnected(dto, organizationId);
    }

    if (dto.use_connection) {
      return this.useConnection(dto, current, organizationId);
    }

    const url = dto.ci_url ?? current?.ci_url ?? '';

    if (!url) throw invalid('ci_url', 'Enter the URL that starts the build');
    if (dto.ci_headers !== undefined && dto.clear_ci_headers) {
      throw invalid('ci_headers', 'Send new headers or clear them, not both');
    }

    const write: ConfigWrite = {
      ci_url:
        dto.ci_url !== undefined || !current ? await checkCiUrl(url) : url,
      ci_method: dto.ci_method ?? current?.ci_method ?? 'POST',
    };

    // Saved headers can hold passwords, so they don't follow a job to another server unseen.
    if (
      dto.ci_url !== undefined &&
      current?.ci_url &&
      current.ci_headers_enc &&
      dto.ci_headers === undefined &&
      !dto.clear_ci_headers &&
      new URL(url).origin !== new URL(current.ci_url).origin
    ) {
      throw invalid(
        'ci_headers',
        'Enter the headers again, or clear them, for the new address',
      );
    }

    if (dto.ci_headers !== undefined) {
      const headers = checkHeaders(dto.ci_headers);

      if (hasAuthorization(headers)) {
        const connection = await this.git.ciConnection(organizationId, url);

        if (connection?.state === 'connected') {
          throw invalid('ci_headers', USES_CONNECTION);
        }

        if (await this.gitlabConnection(organizationId, url)) {
          throw invalid('ci_headers', USES_GITLAB_CONNECTION);
        }
      }

      write.ci_headers_enc = packSecretMap('ci_headers', headers);
    }

    if (dto.clear_ci_headers) write.ci_headers_enc = null;
    if (dto.ci_body_template !== undefined) {
      write.ci_body_template = dto.ci_body_template.trim() || null;
    }

    return write;
  }
}
