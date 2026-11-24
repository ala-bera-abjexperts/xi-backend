import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateIf,
  type ValidationArguments,
} from 'class-validator';

import { stripIllegalXml } from '../../backup/engine/writers/xml.writer';
import { cleanText, type TestCaseReadiness } from './test-case.dto';
import type { RunDefect } from './test-defect.dto';
import {
  BULK_ARCHIVE_ACTIONS,
  BULK_ARCHIVE_LIMIT,
  TestSetPageQueryDto,
  type BulkArchiveAction,
  type TestSetPage,
} from './test-set.dto';
import type { ResultIteration } from './test-transfer.dto';

// Limits mirror the execution table CHECKs and the tm_* execution functions; the database re-checks each one.
export const TEST_EXECUTION_LIMITS = {
  name: 255,
  description: 10000,
  environment: 100,
  runs: 1000,
  assignPerCall: 500,
  actualResult: 10000,
  stepComment: 4000,
  attemptComment: 10000,
  actualMinutes: 10080,
  reason: 1000,
  search: 200,
} as const;

export const RUN_STATUSES = [
  'TODO',
  'EXECUTING',
  'PASS',
  'FAIL',
  'BLOCKED',
  'ABORTED',
  'NOT_APPLICABLE',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_STATUSES = [
  'TODO',
  'PASS',
  'FAIL',
  'BLOCKED',
  'NOT_APPLICABLE',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const EXECUTION_SOURCES = ['manual', 'run_now', 'junit'] as const;
export type ExecutionSource = (typeof EXECUTION_SOURCES)[number];

// The list filter splits manual executions into plan and ad hoc ones.
export const EXECUTION_SOURCE_FILTERS = [
  'plan',
  'ad_hoc',
  'run_now',
  'junit',
] as const;
export type ExecutionSourceFilter = (typeof EXECUTION_SOURCE_FILTERS)[number];

export const EXECUTION_FROM = ['plan', 'set', 'cases'] as const;
export type ExecutionFrom = (typeof EXECUTION_FROM)[number];

export const STATUS_MODES = ['override', 'abort', 'manual'] as const;
export type StatusMode = (typeof STATUS_MODES)[number];

export const ATTEMPT_KINDS = ['reset', 'merge'] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export const TEST_EXECUTION_SORT_FIELDS = [
  'key',
  'name',
  'source',
  'runs',
  'created_at',
  'updated_at',
] as const;

export const TEST_RUN_SORT_FIELDS = [
  'key',
  'title',
  'status',
  'assignee',
  'updated',
  'duration',
] as const;

// Control characters are dropped before trimming, so names and searches never carry them.
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? stripIllegalXml(value).trim() : value;

// An empty text clears the field, so a resend with '' or null is the same no-op.
const emptyToNull = ({ value }: { value: unknown }) =>
  value === '' ? null : value;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

// Duplicate ids are counted once (EC-105).
const toUniqueArray = ({ value }: { value: unknown }) =>
  Array.isArray(value) ? [...new Set(value)] : value;

// Accepts ?r=a, ?r=a&r=b and ?r=a,b alike.
const toUniqueList = ({ value }: { value: unknown }) => {
  if (value === undefined) return value;

  const parts = (Array.isArray(value) ? value : [value]).flatMap(
    (item: unknown) =>
      typeof item === 'string' ? item.split(',').map((p) => p.trim()) : [item],
  );

  return [...new Set(parts)];
};

/** A field of another source is refused instead of being ignored. */
function OnlyFrom(from: ExecutionFrom) {
  return ValidateBy({
    name: 'onlyFrom',
    validator: {
      validate: (_value: unknown, args?: ValidationArguments) =>
        (args?.object as { from?: unknown } | undefined)?.from === from,
      defaultMessage: (args?: ValidationArguments) =>
        `${args?.property ?? 'value'} is only allowed when from is ${from}`,
    },
  });
}

/** The key must be sent; null is a valid value. */
function IsPresent() {
  return ValidateBy({
    name: 'isPresent',
    validator: {
      validate: (value: unknown) => value !== undefined,
      defaultMessage: (args?: ValidationArguments) =>
        `${args?.property ?? 'value'} is required (use null for none)`,
    },
  });
}

export class CreateTestExecutionDto {
  @ApiProperty({
    format: 'uuid',
    description: 'New per create dialog; a resend returns the same execution',
  })
  @IsUUID('all')
  request_id: string;

  @ApiPropertyOptional({
    enum: EXECUTION_FROM,
    description: 'Leave out to create an execution without tests',
  })
  @IsOptional()
  @IsIn(EXECUTION_FROM)
  from?: ExecutionFrom;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only for from plan' })
  @ValidateIf(
    (dto: CreateTestExecutionDto) =>
      dto.from === 'plan' || dto.plan_id !== undefined,
  )
  @OnlyFrom('plan')
  @IsUUID('all')
  plan_id?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only for from set' })
  @ValidateIf(
    (dto: CreateTestExecutionDto) =>
      dto.from === 'set' || dto.set_id !== undefined,
  )
  @OnlyFrom('set')
  @IsUUID('all')
  set_id?: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: TEST_EXECUTION_LIMITS.runs,
    description: 'Only for from cases; duplicates are counted once',
  })
  @ValidateIf(
    (dto: CreateTestExecutionDto) =>
      dto.from === 'cases' || dto.case_ids !== undefined,
  )
  @OnlyFrom('cases')
  @Transform(toUniqueArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TEST_EXECUTION_LIMITS.runs)
  @IsUUID('all', { each: true })
  case_ids?: string[];

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: TEST_EXECUTION_LIMITS.name,
    description: 'Defaults to the plan or set name',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, TEST_EXECUTION_LIMITS.name)
  name?: string;

  @ApiPropertyOptional({
    maxLength: TEST_EXECUTION_LIMITS.description,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_EXECUTION_LIMITS.description)
  description?: string | null;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: TEST_EXECUTION_LIMITS.environment,
    nullable: true,
    description: 'Free text, trimmed; blank is refused',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, TEST_EXECUTION_LIMITS.environment)
  environment?: string | null;

  @ApiPropertyOptional({ format: 'uuid', description: 'Folder to file it in' })
  @IsOptional()
  @IsUUID('all')
  folder_id?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Existing test execution ticket to link instead of creating a new one',
  })
  @IsOptional()
  @IsUUID('all')
  task_id?: string;
}

/** Partial update; null clears the description or the environment. The name can never be null. */
export class UpdateTestExecutionDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: TEST_EXECUTION_LIMITS.name })
  @ValidateIf((dto: UpdateTestExecutionDto) => dto.name !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, TEST_EXECUTION_LIMITS.name)
  name?: string;

  @ApiPropertyOptional({
    maxLength: TEST_EXECUTION_LIMITS.description,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_EXECUTION_LIMITS.description)
  description?: string | null;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: TEST_EXECUTION_LIMITS.environment,
    nullable: true,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, TEST_EXECUTION_LIMITS.environment)
  environment?: string | null;
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Folder; null removes it from its folder',
  })
  @IsOptional()
  @IsUUID()
  folder_id?: string | null;
}

/** Run now runs one case for the caller; any other field (assignee included) is refused. */
export class RunNowDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  request_id: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: TEST_EXECUTION_LIMITS.environment,
    nullable: true,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, TEST_EXECUTION_LIMITS.environment)
  environment?: string | null;
}

export class ListTestExecutionsQueryDto extends TestSetPageQueryDto {
  @ApiPropertyOptional({
    description:
      'true lists archived executions only; default lists active ones',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({
    maxLength: TEST_EXECUTION_LIMITS.search,
    description: 'Matches the key or name, ignoring case',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TEST_EXECUTION_LIMITS.search)
  q?: string;

  @ApiPropertyOptional({
    example: 'created_at:desc',
    default: 'key:desc',
    description: `${TEST_EXECUTION_SORT_FIELDS.join('|')}, optionally with :asc or :desc`,
  })
  @IsOptional()
  @IsString()
  @Matches(
    new RegExp(`^(${TEST_EXECUTION_SORT_FIELDS.join('|')})(:(asc|desc))?$`),
    { message: 'sort must be a known field with an optional :asc or :desc' },
  )
  sort?: string;

  @ApiPropertyOptional({ description: 'Only executions of this test plan' })
  @IsOptional()
  @IsUUID('all')
  planId?: string;

  @ApiPropertyOptional({
    description: 'Only executions directly in this folder',
  })
  @IsOptional()
  @IsUUID('all')
  folderId?: string;

  @ApiPropertyOptional({ description: 'Only the execution of this ticket' })
  @IsOptional()
  @IsUUID('all')
  taskId?: string;

  @ApiPropertyOptional({
    description: 'true lists only executions that have a ticket',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  ticketed?: boolean;

  @ApiPropertyOptional({ enum: EXECUTION_SOURCE_FILTERS })
  @IsOptional()
  @IsIn(EXECUTION_SOURCE_FILTERS)
  source?: ExecutionSourceFilter;

  @ApiPropertyOptional({
    maxLength: TEST_EXECUTION_LIMITS.environment,
    description: 'Only executions of this environment',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, TEST_EXECUTION_LIMITS.environment)
  environment?: string;

  @ApiPropertyOptional({ description: 'Only executions this user created' })
  @IsOptional()
  @IsUUID('all')
  createdBy?: string;
}

export class ExecutionTicketsQueryDto {
  @ApiPropertyOptional({
    maxLength: TEST_EXECUTION_LIMITS.search,
    description: 'Matches the ticket key or summary, ignoring case',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TEST_EXECUTION_LIMITS.search)
  q?: string;
}

export class ListTestRunsQueryDto extends TestSetPageQueryDto {
  @ApiPropertyOptional({
    enum: RUN_STATUSES,
    isArray: true,
    description: 'Status of the current attempt; repeat or comma-separate',
  })
  @IsOptional()
  @Transform(toUniqueList)
  @IsArray()
  @ArrayMaxSize(RUN_STATUSES.length)
  @IsIn(RUN_STATUSES, { each: true })
  status?: RunStatus[];

  @ApiPropertyOptional({
    description: 'me, unassigned or a user id',
  })
  @IsOptional()
  @IsString()
  @Matches(
    /^(me|unassigned|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    { message: 'assignee must be me, unassigned or a user id' },
  )
  assignee?: string;

  @ApiPropertyOptional({
    maxLength: TEST_EXECUTION_LIMITS.search,
    description: 'Matches the case key or title, ignoring case',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TEST_EXECUTION_LIMITS.search)
  q?: string;

  @ApiPropertyOptional({
    example: 'status:asc',
    default: 'key:asc',
    description: `${TEST_RUN_SORT_FIELDS.join('|')}, optionally with :asc or :desc`,
  })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(`^(${TEST_RUN_SORT_FIELDS.join('|')})(:(asc|desc))?$`), {
    message: 'sort must be a known field with an optional :asc or :desc',
  })
  sort?: string;

  @ApiPropertyOptional({
    enum: ['steps'],
    description: 'steps adds step counts of the current attempt to each run',
  })
  @IsOptional()
  @IsIn(['steps'])
  include?: 'steps';
}

export const RUN_EVIDENCE_SORTS = [
  'newest',
  'oldest',
  'name',
  'name:desc',
] as const;

export type RunEvidenceSort = (typeof RUN_EVIDENCE_SORTS)[number];

export class RunEvidenceQueryDto extends TestSetPageQueryDto {
  @ApiPropertyOptional({
    maxLength: TEST_EXECUTION_LIMITS.search,
    description: 'Matches the file name, ignoring case',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TEST_EXECUTION_LIMITS.search)
  q?: string;

  @ApiPropertyOptional({
    enum: RUN_STATUSES,
    isArray: true,
    description:
      'Status of the attempt the file belongs to; repeat or comma-separate',
  })
  @IsOptional()
  @Transform(toUniqueList)
  @IsArray()
  @ArrayMaxSize(RUN_STATUSES.length)
  @IsIn(RUN_STATUSES, { each: true })
  status?: RunStatus[];

  @ApiPropertyOptional({ enum: RUN_EVIDENCE_SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(RUN_EVIDENCE_SORTS)
  sort?: RunEvidenceSort;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only files of this execution; used by the test case list',
  })
  @IsOptional()
  @IsUUID('all')
  executionId?: string;
}

/** The property is required; null unassigns the runs. */
export class AssignRunsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: TEST_EXECUTION_LIMITS.assignPerCall,
    description: 'Duplicates are counted once',
  })
  @Transform(toUniqueArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TEST_EXECUTION_LIMITS.assignPerCall)
  @IsUUID('all', { each: true })
  run_ids: string[];

  @ApiProperty({ format: 'uuid', nullable: true })
  @IsPresent()
  @ValidateIf((dto: AssignRunsDto) => dto.assignee_id !== null)
  @IsUUID('all')
  assignee_id: string | null;
}

/** Runs that already hold results are skipped, not removed. */
export class RemoveRunsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: TEST_EXECUTION_LIMITS.assignPerCall,
    description: 'Duplicates are counted once',
  })
  @Transform(toUniqueArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TEST_EXECUTION_LIMITS.assignPerCall)
  @IsUUID('all', { each: true })
  run_ids: string[];
}

/** Cases already in the execution, archived or deprecated are skipped, not added. */
export class AddRunsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: TEST_EXECUTION_LIMITS.runs,
    description: 'Duplicates are counted once',
  })
  @Transform(toUniqueArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TEST_EXECUTION_LIMITS.runs)
  @IsUUID('all', { each: true })
  case_ids: string[];
}

export class AddableCasesQueryDto extends TestSetPageQueryDto {
  @ApiPropertyOptional({
    maxLength: TEST_EXECUTION_LIMITS.search,
    description: 'Matches the key or title, ignoring case',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TEST_EXECUTION_LIMITS.search)
  q?: string;
}

/**
 * The full result of one step. Statuses accept every run status so a run-only one
 * reaches the database and is refused there as INVALID_REFERENCE (EC-99).
 */
export class SetPreconditionResultDto {
  @ApiProperty({ enum: RUN_STATUSES })
  @IsIn(RUN_STATUSES)
  status: RunStatus;

  @ApiProperty({
    enum: RUN_STATUSES,
    description: 'Status the caller last read; TODO when never recorded',
  })
  @IsIn(RUN_STATUSES)
  expected_status: RunStatus;
}

export interface PreconditionResults {
  attempt_id: string;
  results: Record<
    string,
    { status: StepStatus; executed_by: string; executed_at: string }
  >;
}

export interface PreconditionResultSaved {
  changed: boolean;
  status: StepStatus;
}

export class SetStepResultDto {
  @ApiProperty({ enum: RUN_STATUSES })
  @IsIn(RUN_STATUSES)
  status: RunStatus;

  @ApiProperty({
    enum: RUN_STATUSES,
    description: 'Step status the caller last read; TODO when never recorded',
  })
  @IsIn(RUN_STATUSES)
  expected_status: RunStatus;

  @ApiProperty({
    maxLength: TEST_EXECUTION_LIMITS.actualResult,
    nullable: true,
    description: 'Always sent; null or empty clears it',
  })
  @IsPresent()
  @Transform(emptyToNull)
  @ValidateIf((dto: SetStepResultDto) => dto.actual_result !== null)
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_EXECUTION_LIMITS.actualResult)
  actual_result: string | null;

  @ApiProperty({
    maxLength: TEST_EXECUTION_LIMITS.stepComment,
    nullable: true,
    description: 'Always sent; null or empty clears it',
  })
  @IsPresent()
  @Transform(emptyToNull)
  @ValidateIf((dto: SetStepResultDto) => dto.comment !== null)
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_EXECUTION_LIMITS.stepComment)
  comment: string | null;

  @ApiPropertyOptional({
    maxLength: TEST_EXECUTION_LIMITS.actualResult,
    nullable: true,
    description:
      'Actual result the caller last read; when sent, a different stored one is refused',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_EXECUTION_LIMITS.actualResult)
  expected_actual_result?: string | null;

  @ApiPropertyOptional({
    maxLength: TEST_EXECUTION_LIMITS.stepComment,
    nullable: true,
    description:
      'Comment the caller last read; when sent, a different stored one is refused',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_EXECUTION_LIMITS.stepComment)
  expected_comment?: string | null;
}

/** Attempt comment and actual time; only the keys sent are changed. */
export class UpdateAttemptDto {
  @ApiPropertyOptional({
    maxLength: TEST_EXECUTION_LIMITS.attemptComment,
    nullable: true,
  })
  @IsOptional()
  @Transform(emptyToNull)
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_EXECUTION_LIMITS.attemptComment)
  comment?: string | null;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: TEST_EXECUTION_LIMITS.actualMinutes,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(TEST_EXECUTION_LIMITS.actualMinutes)
  actual_minutes?: number | null;
}

/** override and manual need a status; abort always sets ABORTED. */
export class SetAttemptStatusDto {
  @ApiProperty({ enum: STATUS_MODES })
  @IsIn(STATUS_MODES)
  status_mode: StatusMode;

  @ApiPropertyOptional({
    enum: RUN_STATUSES,
    description: 'Required for override and manual',
  })
  @ValidateIf(
    (dto: SetAttemptStatusDto) =>
      dto.status_mode !== 'abort' || dto.status !== undefined,
  )
  @IsIn(RUN_STATUSES)
  status?: RunStatus;

  @ApiPropertyOptional({
    enum: RUN_STATUSES,
    description: 'Attempt status the caller last read',
  })
  @IsOptional()
  @IsIn(RUN_STATUSES)
  expected_status?: RunStatus;

  @ApiPropertyOptional({
    maxLength: TEST_EXECUTION_LIMITS.reason,
    description: 'Kept in the audit log only',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TEST_EXECUTION_LIMITS.reason)
  reason?: string;
}

export class NewAttemptDto {
  @ApiProperty({ enum: ATTEMPT_KINDS })
  @IsIn(ATTEMPT_KINDS)
  mode: AttemptKind;

  @ApiProperty({
    minimum: 1,
    description: 'Attempt number the caller last read',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expected_attempt_no: number;
}

export type TestExecutionPage<T> = TestSetPage<T>;

// A test execution ticket that has no execution yet.
export interface ExecutionTicket {
  task_id: string;
  key: string;
  summary: string;
  created_at: string;
}

export interface UserRef {
  id: string;

  // Null once the user is deleted.
  name: string | null;
  avatar_url: string | null;
}

export interface TestExecution {
  id: string;
  key: string;
  key_number: number;
  folder_id: string | null;
  name: string;
  description: string | null;
  plan: {
    id: string;
    key: string;
    name: string;
    task_key: string | null;
  } | null;
  environment: string | null;
  source: ExecutionSource;
  is_archived: boolean;
  archived_at: string | null;
  created_by: UserRef | null;
  created_at: string;
  updated_at: string;
  run_count: number;

  // Times the runs were run, re-runs included.
  attempt_count: number;

  // True once any run has a result; delete is then refused.
  has_results: boolean;

  // Linked ticket; null when the space maps no execution type or the ticket was removed.
  task_id: string | null;
  task_key: string | null;
}

export type TestExecutionListItem = TestExecution;

/** Detail adds the current-attempt status of every run, counted per status. */
export interface TestExecutionDetail extends TestExecution {
  status_counts: Record<RunStatus, number>;
}

export interface ExecutionSkip {
  case_id: string;
  key: string;
  reason: 'archived' | 'deprecated';
}

export interface ExecutionWarning {
  case_id: string;
  key: string;
  reason: 'tester_ineligible' | 'draft';
}

export interface TestExecutionCreated {
  replayed: boolean;
  execution_id: string;
  key: string;
  run_count: number;
  skipped: ExecutionSkip[];
  warnings: ExecutionWarning[];

  // Set when the execution was saved but its ticket could not be made.
  ticket_warning: 'ticket_not_created' | null;
}

export interface RunNowCreated {
  replayed: boolean;
  execution_id: string;
  key: string;
  run_id: string;
  ticket_warning: 'ticket_not_created' | null;
}

export interface TestExecutionDeleteCounts {
  runs: number;
  attempts: number;
  step_results: number;
  evidence_files: number;
}

export interface TestExecutionDeleted {
  dry_run: boolean;
  counts: TestExecutionDeleteCounts;
  ticket_key: string | null;
}

export const BULK_DELETE_EXECUTION_LIMIT = 100;

/** Test executions to delete together; each is checked as a single delete would be. */
export class BulkDeleteTestExecutionsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: BULK_DELETE_EXECUTION_LIMIT,
  })
  @Transform(toUniqueArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_DELETE_EXECUTION_LIMIT)
  @IsUUID('all', { each: true })
  execution_ids: string[];
}

/** Test executions to archive or restore together. */
export class BulkArchiveTestExecutionsDto {
  @ApiProperty({ enum: BULK_ARCHIVE_ACTIONS })
  @IsIn(BULK_ARCHIVE_ACTIONS)
  action: BulkArchiveAction;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: BULK_ARCHIVE_LIMIT,
  })
  @Transform(toUniqueArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_ARCHIVE_LIMIT)
  @IsUUID('all', { each: true })
  execution_ids: string[];
}

export interface TestExecutionBulkDeleteResult {
  changed: boolean;
  deleted: { execution_id: string; key: string }[];
  skipped: {
    execution_id: string;
    key: string;
    reason: 'has_results' | 'not_found' | 'failed';
  }[];
}

export interface ExecutionTesterSummary {
  // Null for unassigned runs, including runs of a deleted user.
  user_id: string | null;
  name: string | null;
  total: number;
  final: number;
}

export interface ExecutionSummary {
  execution_id: string;

  // First start of a current attempt; the end only once every run has a final status.
  started_at: string | null;
  finished_at: string | null;
  total_runs: number;
  status_counts: Record<RunStatus, number>;

  // Share of runs with a final status, 0..1.
  final_ratio: number;

  // PASS / (total - NOT_APPLICABLE); null when that is zero.
  success_rate: number | null;
  by_tester: ExecutionTesterSummary[];

  // Minutes of the current attempts: typed (recorded), or else start to finish (measured).
  actual_minutes: { total: number; recorded: number; measured: number };
}

export interface TestRunListItem {
  id: string;
  case_id: string;
  case_key: string;

  // Ticket key of the test case; null when it has none.
  case_task_key: string | null;
  case_title: string;
  case_readiness: TestCaseReadiness;
  assignee: UserRef | null;

  // False once the assignee can no longer run tests in this space.
  assignee_eligible: boolean;
  current_attempt_no: number;
  status: RunStatus;
  status_overridden: boolean;
  status_changed_at: string;

  // Timing of the current attempt; typed minutes when the tester entered them.
  started_at: string | null;
  finished_at: string | null;
  actual_minutes: number | null;

  // Only with include=steps.
  step_total?: number;
  step_counts?: Record<StepStatus, number>;
  steps?: { position: number; action: string; status: StepStatus }[];
}

export interface MyRun extends TestRunListItem {
  execution: {
    id: string;
    key: string;
    name: string;
    environment: string | null;
  };
}

// Outcome of copying an execution change into its test plan; the execution change stands either way.
export type PlanSyncStatus = 'ok' | 'skipped_archived' | 'failed';

export interface AssignRunsResult {
  assigned: number;

  // Already assigned to that user; nothing changed for these.
  unchanged: string[];

  // Present only when the execution belongs to a test plan.
  plan_sync?: PlanSyncStatus;

  // Test cases or tickets that could not follow the new assignee.
  case_sync_failed?: number;
}

export interface RemoveRunsResult {
  removed: number;

  // Runs with results; kept.
  skipped: string[];
}

export interface AddRunsResult {
  added: number;
  skipped: {
    case_id: string;
    key: string;
    reason: 'already_added' | 'archived' | 'deprecated';
  }[];

  // Present only when the execution belongs to a test plan and cases were added.
  plan_sync?: PlanSyncStatus;
}

export interface AddableCase {
  id: string;
  key: string;
  task_key: string | null;
  title: string;
  readiness: TestCaseReadiness;
}

export interface ClaimRunResult {
  run_id: string;
  assignee_id: string;

  // True when the caller already held the run (a retried claim).
  already_yours: boolean;

  // Present only when the execution belongs to a test plan.
  plan_sync?: PlanSyncStatus;
}

export interface SnapshotStep {
  id: string;
  position: number;
  action: string;
  data: string | null;
  expected_result: string | null;
}

export interface StepResult {
  status: StepStatus;
  actual_result: string | null;
  comment: string | null;
  executed_by: UserRef | null;
  executed_at: string;
}

export interface AttemptSummary {
  id: string;
  attempt_no: number;
  kind: 'initial' | AttemptKind;
  status: RunStatus;
  created_at: string;
}

export interface TestRunDetail {
  id: string;
  execution: {
    id: string;
    key: string;
    name: string;
    environment: string | null;
    is_archived: boolean;
    plan: { id: string; key: string; name: string } | null;
  };
  case: {
    id: string;
    key: string;
    task_key: string | null;
    revision: number;
    is_archived: boolean;
    test_type?: string | null;
    definition?: string | null;
    estimate_minutes?: number | null;
    task_id?: string | null;
  };
  assignee: UserRef | null;
  assignee_eligible: boolean;
  current_attempt: {
    id: string;
    attempt_no: number;
    kind: 'initial' | AttemptKind;
    case_revision: number;
    snapshot: {
      case_key: string;
      title: string;
      objective: string | null;
      preconditions: string | null;
      steps: SnapshotStep[];
      // Missing on runs started before these were saved.
      linked_preconditions?: {
        id: string;
        key: string;
        task_key: string | null;
        title: string;
        test_type: string;
        definition: string | null;
      }[];
    };
    status: RunStatus;
    status_overridden: boolean;
    status_changed_at: string;
    step_results: Record<string, StepResult>;
    comment: string | null;
    actual_minutes: number | null;
    started_at: string | null;
    finished_at: string | null;

    // Outline examples from an uploaded report.
    iterations: ResultIteration[];
  };
  attempts: AttemptSummary[];
  defects: RunDefect[];
}

export interface StepResultSaved {
  changed: boolean;
  step_status: StepStatus;
  attempt_status: RunStatus;
  status_overridden: boolean;
}

export interface AttemptUpdated {
  changed: boolean;
  status: RunStatus;
  status_overridden: boolean;
}

export interface AttemptStarted {
  attempt_id: string;
  attempt_no: number;
  status: RunStatus;
  carried_steps: number;
}

export interface RunEvidenceItem {
  id: string;
  file_name: string;
  file_size: number | null;
  mime_type: string | null;
  version_number: number;
  uploaded_at: string;
  uploader: UserRef | null;
  attempt_id: string;
  attempt_no: number;
  attempt_status: RunStatus;
  run_id: string;
  case_id: string;
  case_key: string;
  case_title: string;
  execution_id: string;
  execution_key: string;
}
