import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import type { GitProvider } from '../../git-integrations/git-integrations.types';
import {
  AUTOMATION_LIMITS,
  AUTOMATION_PRESETS,
  type AutomationPreset,
} from '../automation/automation-inputs';
import { toUniqueList } from './test-case.dto';
import { CreateTestManagementApiKeyDto } from './test-management-api-key.dto';
import { TestSetPageQueryDto } from './test-set.dto';

// The same list as the test_automation_runs status CHECK.
export const AUTOMATION_RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'UPLOADING',
  'DONE',
  'CANCELLED',
  'ERROR',
  'REQUESTED',
] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export const AUTOMATION_KINDS = ['docker', 'ci_job'] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

// Lists and run lists show CI jobs unless asked for runner settings too.
export const AUTOMATION_KIND_FILTERS = ['ci_job', 'docker', 'all'] as const;
export type AutomationKindFilter = (typeof AUTOMATION_KIND_FILTERS)[number];

// Longer than a new file may be named, because existing files keep their names.
const AUTOMATION_FILE_NAME_MAX = 4096;

/** Fields a setting can be created or changed with; the kind decides which ones are needed. */
class TestAutomationConfigFieldsDto {
  @ApiPropertyOptional({ enum: AUTOMATION_PRESETS })
  @IsOptional()
  @IsIn(AUTOMATION_PRESETS)
  preset?: AutomationPreset;

  @ApiPropertyOptional({ description: 'A key of the server image allowlist' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  image_key?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'The checked image a setting with image_key "own-image" uses',
  })
  @IsOptional()
  @IsUUID()
  user_image_id?: string | null;

  @ApiPropertyOptional({ enum: ['git', 'zip'] })
  @IsOptional()
  @IsIn(['git', 'zip'])
  source?: 'git' | 'zip';

  @ApiPropertyOptional({ maxLength: AUTOMATION_LIMITS.repoUrl })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(AUTOMATION_LIMITS.repoUrl)
  repo_url?: string;

  @ApiPropertyOptional({ maxLength: AUTOMATION_LIMITS.repoRef })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(AUTOMATION_LIMITS.repoRef)
  repo_ref?: string;

  @ApiPropertyOptional({ maxLength: AUTOMATION_LIMITS.workDir })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(AUTOMATION_LIMITS.workDir)
  work_dir?: string;

  @ApiPropertyOptional({ maxLength: AUTOMATION_LIMITS.command })
  @IsOptional()
  @IsString()
  @MaxLength(AUTOMATION_LIMITS.command)
  command?: string;

  @ApiPropertyOptional({
    maxLength: AUTOMATION_LIMITS.command,
    description: 'Runs before the tests; blank keeps the default of the preset',
  })
  @IsOptional()
  @IsString()
  @MaxLength(AUTOMATION_LIMITS.command)
  install_command?: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: AUTOMATION_LIMITS.resultPaths,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AUTOMATION_LIMITS.resultPaths)
  @IsString({ each: true })
  result_paths?: string[];

  @ApiPropertyOptional({ description: 'Plain variables, name → value' })
  @IsOptional()
  @IsObject()
  env?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Secret variables, name → value; replaces all saved secrets and is never returned',
  })
  @IsOptional()
  @IsObject()
  secrets?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Remove all saved secrets' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  clear_secrets?: boolean;

  @ApiPropertyOptional({ type: [String], maxItems: AUTOMATION_LIMITS.hosts })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AUTOMATION_LIMITS.hosts)
  @IsString({ each: true })
  allowed_hosts?: string[];

  @ApiPropertyOptional({
    description: 'Create test cases for results that match none',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  create_unmatched?: boolean;

  @ApiPropertyOptional({ minimum: 5, maximum: 120, default: 30 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(120)
  timeout_minutes?: number;

  @ApiPropertyOptional({ enum: ['off', 'on_failure'] })
  @IsOptional()
  @IsIn(['off', 'on_failure'])
  trace_mode?: 'off' | 'on_failure';
  @ApiPropertyOptional({ maxLength: AUTOMATION_LIMITS.ciUrl })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(AUTOMATION_LIMITS.ciUrl)
  ci_url?: string;

  @ApiPropertyOptional({ enum: ['POST', 'PUT'] })
  @IsOptional()
  @IsIn(['POST', 'PUT'])
  ci_method?: 'POST' | 'PUT';

  @ApiPropertyOptional({
    description:
      'Request headers, name → value; replaces all saved headers and is never returned',
  })
  @IsOptional()
  @IsObject()
  ci_headers?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Remove all saved headers' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  clear_ci_headers?: boolean;

  @ApiPropertyOptional({
    maxLength: AUTOMATION_LIMITS.ciBody,
    description:
      'Request body; {executionKey}, {executionId}, {planKey}, {planId}, {spaceKey}, {spaceId}, {runId} and {baseUrl} are filled in',
  })
  @IsOptional()
  @IsString()
  @MaxLength(AUTOMATION_LIMITS.ciBody)
  ci_body_template?: string;

  @ApiPropertyOptional({
    description:
      'A GitHub or GitLab repository connected in Tenant Configuration; the job starts its workflow or pipeline with the connection',
  })
  @IsOptional()
  @IsUUID()
  ci_repository_id?: string;

  @ApiPropertyOptional({ description: 'Workflow file name, such as tests.yml' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  ci_workflow?: string;

  @ApiPropertyOptional({ description: 'Branch or tag the workflow runs on' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  ci_ref?: string;

  @ApiPropertyOptional({
    description:
      'Values the workflow receives, name → value; {runId} and the other placeholders are filled in',
  })
  @IsOptional()
  @IsObject()
  ci_inputs?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'Remove the stored headers, so the job uses the connection',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  use_connection?: boolean;

  @ApiPropertyOptional({
    description:
      'A Jenkins server connected in Tenant Configuration; its saved user starts the job',
  })
  @IsOptional()
  @IsUUID()
  ci_server_id?: string;

  @ApiPropertyOptional({
    maxLength: AUTOMATION_LIMITS.ciUrl,
    description: 'Address of the Jenkins job on that server',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(AUTOMATION_LIMITS.ciUrl)
  ci_jenkins_job?: string;
}

export class CreateTestAutomationConfigDto extends TestAutomationConfigFieldsDto {
  @ApiProperty({ minLength: 1, maxLength: AUTOMATION_LIMITS.name })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @Length(1, AUTOMATION_LIMITS.name)
  name: string;

  @ApiPropertyOptional({ enum: AUTOMATION_KINDS, default: 'ci_job' })
  @IsOptional()
  @IsIn(AUTOMATION_KINDS)
  kind?: AutomationKind;
}

export class UpdateTestAutomationConfigDto extends TestAutomationConfigFieldsDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: AUTOMATION_LIMITS.name })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @Length(1, AUTOMATION_LIMITS.name)
  name?: string;
}

export class ListTestAutomationConfigsQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({ enum: AUTOMATION_KIND_FILTERS, default: 'ci_job' })
  @IsOptional()
  @IsIn(AUTOMATION_KIND_FILTERS)
  kind?: AutomationKindFilter;
}

export class CreateTestAutomationWorkflowFileDto {
  @ApiProperty({ description: 'File name in .github/workflows' })
  @Transform(trim)
  @IsString()
  file_name!: string;

  @ApiProperty({ description: 'The whole file; must use workflow_dispatch' })
  @IsString()
  content!: string;
}

export class UpdateTestAutomationWorkflowFileDto {
  @ApiProperty({ description: 'The whole file; must use workflow_dispatch' })
  @IsString()
  content!: string;

  @ApiProperty({ description: 'The version of the file that was read' })
  @Matches(/^[0-9a-f]{40}([0-9a-f]{24})?$/)
  sha!: string;
}

export class TestAutomationTargetQueryDto {
  @ApiProperty({ enum: ['plan', 'execution'] })
  @IsIn(['plan', 'execution'])
  target: 'plan' | 'execution';

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  target_id: string;
}

export class TriggerTestAutomationDto {
  @ApiProperty({ enum: ['plan', 'execution'] })
  @IsIn(['plan', 'execution'])
  target: 'plan' | 'execution';

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  target_id: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'The same id again returns the first start instead of a second one',
  })
  @IsUUID('all')
  request_id: string;
}

export class TriggerTestAutomationCaseDto {
  @ApiProperty({
    format: 'uuid',
    description: 'The automated test case to run',
  })
  @IsUUID('all')
  case_id: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'The same id again returns the first start instead of a second one',
  })
  @IsUUID('all')
  request_id: string;
}

export class TestAutomationFilePathQueryDto {
  @ApiProperty({ description: 'A file inside the zip, matched exactly' })
  @IsString()
  @Length(1, AUTOMATION_FILE_NAME_MAX)
  path: string;
}

/** Every change names the zip version it read; none means the setting had no zip. */
export class TestAutomationFileVersionDto {
  @ApiProperty({ description: 'A file inside the zip' })
  @IsString()
  @Length(1, AUTOMATION_FILE_NAME_MAX)
  path: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all')
  version?: string | null;
}

export class DeleteTestAutomationFilesDto {
  @ApiProperty({
    type: [String],
    description: 'Files inside the zip, matched exactly',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Length(1, AUTOMATION_FILE_NAME_MAX, { each: true })
  paths: string[];

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all')
  version?: string | null;
}

export class SaveTestAutomationFileDto extends TestAutomationFileVersionDto {
  @ApiProperty({ description: 'The whole file as text' })
  @IsString()
  content: string;
}

export class StartTestAutomationRunDto extends OmitType(
  TriggerTestAutomationDto,
  ['target_id'] as const,
) {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Needed unless the run starts from a test case',
  })
  @IsOptional()
  @IsUUID('all')
  target_id?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Run for this test case in its own execution; only its result is recorded',
  })
  @IsOptional()
  @IsUUID('all')
  case_id?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  config_id: string;

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: AUTOMATION_LIMITS.specFiles,
    description:
      'Run only these test files, relative to the tests folder; leave out to run all',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(AUTOMATION_LIMITS.specFiles)
  @IsString({ each: true })
  spec_files?: string[];
}

/** A plan or execution is optional; with one, the answer also says which files its test cases link to. */
export class ListTestAutomationSpecFilesQueryDto extends PartialType(
  TestAutomationTargetQueryDto,
) {}

export class ListTestAutomationRunsQueryDto extends TestSetPageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  executionId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  planId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  configId?: string;

  @ApiPropertyOptional({
    example: 'started:desc',
    description: 'started, setting or status, with an optional :asc or :desc',
  })
  @IsOptional()
  @IsString()
  @Matches(/^(started|setting|status)(:(asc|desc))?$/, {
    message: 'sort must be a known field with an optional :asc or :desc',
  })
  sort?: string;

  @ApiPropertyOptional({ enum: AUTOMATION_KIND_FILTERS, default: 'ci_job' })
  @IsOptional()
  @IsIn(AUTOMATION_KIND_FILTERS)
  kind?: AutomationKindFilter;

  @ApiPropertyOptional({
    example: 'me',
    description: 'Only runs started by this person: "me" or a user id',
  })
  @IsOptional()
  @IsString()
  @Matches(
    /^(me|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    { message: 'startedBy must be "me" or a user id' },
  )
  startedBy?: string;

  @ApiPropertyOptional({
    enum: AUTOMATION_RUN_STATUSES,
    isArray: true,
    description: 'One value, repeated values or a comma-separated list',
  })
  @IsOptional()
  @Transform(toUniqueList)
  @IsArray()
  @ArrayMaxSize(AUTOMATION_RUN_STATUSES.length)
  @IsIn(AUTOMATION_RUN_STATUSES, { each: true })
  status?: AutomationRunStatus[];
}

/** A setting as the API returns it; secrets and header values are never included. */
export interface TestAutomationConfig {
  id: string;
  name: string;
  kind: AutomationKind;
  preset: AutomationPreset | null;
  image_key: string | null;
  source: 'git' | 'zip' | null;
  repo_url: string | null;
  repo_ref: string | null;
  work_dir: string | null;
  has_zip: boolean;
  command: string | null;
  // Null, like command, for people who can't edit the setting.
  install_command: string | null;
  result_paths: string[];
  // Null for people who can't edit the setting.
  env: Record<string, string> | null;
  has_secrets: boolean;
  secret_names: string[];
  allowed_hosts: string[];
  create_unmatched: boolean;
  timeout_minutes: number;
  trace_mode: 'off' | 'on_failure';
  ci_url: string | null;
  ci_method: 'POST' | 'PUT' | null;
  ci_header_names: string[];
  ci_body_template: string | null;
  // Only on a job started through the connection, and only for people who can edit it.
  ci_connected?:
    | {
        // Only on a GitLab job; a GitHub job leaves it out.
        provider?: 'gitlab';
        full_name: string;
        workflow: string;
        ref: string;
        inputs: Record<string, string>;
      }
    | {
        provider: 'jenkins';
        server_id: string;
        full_name: string;
        job_url: string;
        inputs: Record<string, string>;
      };
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The files of a setting's zip; only settings editors see these. The version is the zip's UUID, never a storage path. */
export interface TestAutomationFiles {
  version: string | null;
  files: { path: string; size: number }[];
}

export type TestAutomationFileContent = {
  path: string;
  version: string | null;
} & (
  | { content: string; not_editable: null }
  | { content: null; not_editable: 'binary' | 'too_large' }
);

export interface TestAutomationFilesChange extends TestAutomationFiles {
  config: TestAutomationConfig;
  // After a delete: ticket keys of the test cases that still link to the file.
  linked_case_keys?: string[];
}

export interface TestAutomationImages {
  runner_enabled: boolean;
  images: { key: string; language?: string; version?: string }[];
}

/** Names only: run rights don't include reading the code. A Git setting has no list, so files stays empty. */
export interface TestAutomationSpecFiles {
  files: string[];
  // Files the target's test cases link to.
  linked: string[];
  // The setting has its own test command, which has to read XISUITE_SPEC_FILES itself.
  own_command: boolean;
  // The saved zip holds no files at all, so a run has nothing to test.
  empty?: boolean;
}

/** A repository enabled in Tenant Configuration; nothing about its connection or tokens. */
export interface TestAutomationGitRepository {
  id: string;
  provider: GitProvider;
  full_name: string;
  web_url: string;
  default_branch: string | null;
  is_private: boolean;
  account: string;
  /** GitLab only: the address that starts a pipeline with a trigger token. */
  trigger_url?: string;
}

/** A start of a CI job as the API returns it. */
export interface TestAutomationTestCounts {
  total: number;
  automated: number;
}

/** The end of a CI job's log, read from GitHub each time. */
export interface TestAutomationCiJobLog {
  text: string;
  truncated: boolean;
  bytes: number;
}

export interface TestAutomationRun {
  id: string;
  config_id: string | null;
  // From the run's snapshot, so it stays when the setting is renamed or deleted.
  config_name: string | null;
  // Fixed number of the run within its setting, shown as #N.
  run_no: number | null;
  kind: AutomationKind;
  target: 'plan' | 'execution';
  plan_id: string | null;
  execution_id: string | null;
  status: string;
  outcome?: 'passed' | 'failed_tests' | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested_at: string | null;
  result_summary: Record<string, unknown>;
  // Ticket key of the execution or plan; only the run list fills it.
  target_key?: string | null;
  // Who started the run; only the run list fills it.
  started_by?: string | null;
}

/** The expiry of the API key Send to CI creates; the same rules as a key made by hand. */
export class SendCiVariablesDto extends OmitType(
  CreateTestManagementApiKeyDto,
  ['name'] as const,
) {}

/** A key made on the API keys card for one connected repository or Jenkins server. */
export class SaveApiKeyInCiDto extends SendCiVariablesDto {
  @ApiProperty({ enum: ['github', 'gitlab', 'jenkins'] })
  @IsIn(['github', 'gitlab', 'jenkins'])
  provider!: 'github' | 'gitlab' | 'jenkins';

  @ApiProperty({
    description:
      'The connected repository id (GitHub, GitLab) or the Jenkins server id',
  })
  @IsUUID()
  target_id!: string;
}

export interface SendCiVariablesResult {
  provider: 'github' | 'gitlab' | 'jenkins';
  written: string[];
  skipped: { name: string; reason: string }[];
  api_key: {
    id: string;
    name: string;
    token_prefix: string;
    expires_at: string | null;
  };
  // GitHub only: shown once, for the user to paste as a repository secret.
  token?: string;
  manual_url?: string;
  previous: { revoked: number; kept: string[] };
}
