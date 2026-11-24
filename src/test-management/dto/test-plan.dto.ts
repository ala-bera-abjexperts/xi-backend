import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateBy,
  ValidateIf,
  type ValidationArguments,
} from 'class-validator';

import {
  TEST_CASE_READINESS,
  TEST_TYPE_MAX,
  toUniqueList,
  type TestCaseReadiness,
  type TestRecordUser,
} from './test-case.dto';
import {
  BULK_ARCHIVE_ACTIONS,
  BULK_ARCHIVE_LIMIT,
  cleanRichText,
  TestSetPageQueryDto,
  type BulkArchiveAction,
  type TestSetPage,
} from './test-set.dto';

// Limits mirror the test_plans CHECKs and tm_add_plan_tests; the database re-checks every one.
export const TEST_PLAN_LIMITS = {
  name: 255,
  description: 10000,
  tests: 1000,
  idsPerCall: 500,
  search: 200,
} as const;

export const TEST_PLAN_SORT_FIELDS = [
  'key',
  'name',
  'start_date',
  'end_date',
  'updated_at',
] as const;

export const TEST_PLAN_TEST_SORT_FIELDS = [
  'key',
  'title',
  'readiness',
  'test_type',
] as const;

export const PLAN_TEST_SOURCES = ['cases', 'set', 'folder'] as const;
export type PlanTestSource = (typeof PLAN_TEST_SOURCES)[number];

export const FINAL_STATUSES = [
  'PASS',
  'FAIL',
  'BLOCKED',
  'ABORTED',
  'NOT_APPLICABLE',
] as const;
export type FinalStatus = (typeof FINAL_STATUSES)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

/** YYYY-MM-DD that is a real calendar day (no 2026-02-30); a date-time is refused. */
function IsDateOnly() {
  return ValidateBy({
    name: 'isDateOnly',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        // Postgres has no year 0.
        !value.startsWith('0000') &&
        !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
        new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
      defaultMessage: (args?: ValidationArguments) =>
        `${args?.property ?? 'value'} must be a date as YYYY-MM-DD`,
    },
  });
}

/** Only checked when both dates are in the body; a one-date change is checked by the database. */
function NotBeforeStartDate() {
  return ValidateBy({
    name: 'notBeforeStartDate',
    validator: {
      validate: (value: unknown, args?: ValidationArguments) => {
        const start = (args?.object as { start_date?: unknown } | undefined)
          ?.start_date;

        // Same-format date strings compare correctly as text.
        return (
          typeof value !== 'string' ||
          typeof start !== 'string' ||
          value >= start
        );
      },
      defaultMessage: () => 'end_date must not be before start_date',
    },
  });
}

/** A field of another source is refused instead of being ignored. */
function OnlyForSource(source: PlanTestSource) {
  return ValidateBy({
    name: 'onlyForSource',
    validator: {
      validate: (_value: unknown, args?: ValidationArguments) =>
        (args?.object as { source?: unknown } | undefined)?.source === source,
      defaultMessage: (args?: ValidationArguments) =>
        `${args?.property ?? 'value'} is only allowed when source is ${source}`,
    },
  });
}

export class CreateTestPlanDto {
  @ApiProperty({ minLength: 1, maxLength: TEST_PLAN_LIMITS.name })
  @Transform(trim)
  @IsString()
  @Length(1, TEST_PLAN_LIMITS.name)
  name: string;

  @ApiPropertyOptional({
    maxLength: TEST_PLAN_LIMITS.description,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanRichText)
  @IsString()
  @MaxLength(TEST_PLAN_LIMITS.description)
  description?: string | null;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @IsDateOnly()
  start_date?: string | null;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @IsDateOnly()
  @NotBeforeStartDate()
  end_date?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  folder_id?: string | null;
}

/** Partial update; null clears the description or a date, or takes the plan out of its folder. The name can never be null. */
export class UpdateTestPlanDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: TEST_PLAN_LIMITS.name })
  @ValidateIf((dto: UpdateTestPlanDto) => dto.name !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, TEST_PLAN_LIMITS.name)
  name?: string;

  @ApiPropertyOptional({
    maxLength: TEST_PLAN_LIMITS.description,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanRichText)
  @IsString()
  @MaxLength(TEST_PLAN_LIMITS.description)
  description?: string | null;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @IsDateOnly()
  start_date?: string | null;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @IsDateOnly()
  @NotBeforeStartDate()
  end_date?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  folder_id?: string | null;
}

export class ListTestPlansQueryDto extends TestSetPageQueryDto {
  @ApiPropertyOptional({
    description: 'true lists archived plans only; default lists active ones',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({
    maxLength: TEST_PLAN_LIMITS.search,
    description: 'Matches the key or name, ignoring case',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TEST_PLAN_LIMITS.search)
  q?: string;

  @ApiPropertyOptional({
    example: 'end_date:desc',
    default: 'key:asc',
    description: `${TEST_PLAN_SORT_FIELDS.join('|')}, optionally with :asc or :desc`,
  })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(`^(${TEST_PLAN_SORT_FIELDS.join('|')})(:(asc|desc))?$`), {
    message: 'sort must be a known field with an optional :asc or :desc',
  })
  sort?: string;

  @ApiPropertyOptional({ description: 'Only the plan of this ticket' })
  @IsOptional()
  @IsUUID('all')
  taskId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only plans directly in this folder',
  })
  @IsOptional()
  @IsUUID()
  folderId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Only plans where this user is the planned tester of at least one test',
  })
  @IsOptional()
  @IsUUID('all')
  testerId?: string;

  @ApiPropertyOptional({
    maxLength: TEST_TYPE_MAX,
    description: 'Only plans with at least one test of this test type id',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, TEST_TYPE_MAX)
  testType?: string;
}

export class TestPlanPageQueryDto extends TestSetPageQueryDto {}

export class TestPlanTestsQueryDto extends TestPlanPageQueryDto {
  @ApiPropertyOptional({
    maxLength: TEST_PLAN_LIMITS.search,
    description: 'Matches the case key or title, ignoring case',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TEST_PLAN_LIMITS.search)
  q?: string;

  @ApiPropertyOptional({
    enum: TEST_CASE_READINESS,
    isArray: true,
    description: 'One value, repeated values or a comma-separated list',
  })
  @IsOptional()
  @Transform(toUniqueList)
  @IsArray()
  @ArrayMaxSize(TEST_CASE_READINESS.length)
  @IsIn(TEST_CASE_READINESS, { each: true })
  readiness?: TestCaseReadiness[];

  @ApiPropertyOptional({
    maxLength: TEST_TYPE_MAX,
    description: 'Only tests of this test type id, e.g. manual',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, TEST_TYPE_MAX)
  testType?: string;

  @ApiPropertyOptional({
    description: 'Planned tester: me, unassigned or a user id',
    example: 'unassigned',
  })
  @IsOptional()
  @IsString()
  @Matches(
    /^(me|unassigned|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    { message: 'tester must be me, unassigned or a user id' },
  )
  tester?: string;

  @ApiPropertyOptional({
    example: 'title:desc',
    default: 'key:asc',
    description: `${TEST_PLAN_TEST_SORT_FIELDS.join('|')}, optionally with :asc or :desc`,
  })
  @IsOptional()
  @IsString()
  @Matches(
    new RegExp(`^(${TEST_PLAN_TEST_SORT_FIELDS.join('|')})(:(asc|desc))?$`),
    { message: 'sort must be a known field with an optional :asc or :desc' },
  )
  sort?: string;
}

export class RunHistoryQueryDto {
  @ApiPropertyOptional({
    enum: [7, 30, 90],
    default: 30,
    description: 'How many days back to read finished runs',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value !== '' ? Number(value) : value,
  )
  @IsIn([7, 30, 90])
  days?: number;
}

/** Exactly one source; the fields of the other sources must be absent. */
export class AddPlanTestsDto {
  @ApiProperty({ enum: PLAN_TEST_SOURCES })
  @IsIn(PLAN_TEST_SOURCES)
  source: PlanTestSource;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: TEST_PLAN_LIMITS.idsPerCall,
    description: 'Only for source cases',
  })
  @ValidateIf(
    (dto: AddPlanTestsDto) =>
      dto.source === 'cases' || dto.case_ids !== undefined,
  )
  @OnlyForSource('cases')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TEST_PLAN_LIMITS.idsPerCall)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  case_ids?: string[];

  @ApiPropertyOptional({ format: 'uuid', description: 'Only for source set' })
  @ValidateIf(
    (dto: AddPlanTestsDto) => dto.source === 'set' || dto.set_id !== undefined,
  )
  @OnlyForSource('set')
  @IsUUID('all')
  set_id?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only for source folder',
  })
  @ValidateIf(
    (dto: AddPlanTestsDto) =>
      dto.source === 'folder' || dto.folder_id !== undefined,
  )
  @OnlyForSource('folder')
  @IsUUID('all')
  folder_id?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Only for source folder',
  })
  @ValidateIf((dto: AddPlanTestsDto) => dto.include_subfolders !== undefined)
  @OnlyForSource('folder')
  @IsBoolean()
  include_subfolders?: boolean;
}

export class RemovePlanTestsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: TEST_PLAN_LIMITS.idsPerCall,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TEST_PLAN_LIMITS.idsPerCall)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  case_ids: string[];
}

/** The property is required; null unassigns the test. */
export class SetPlannedTesterDto {
  @ApiProperty({ format: 'uuid', nullable: true })
  @ValidateIf((dto: SetPlannedTesterDto) => dto.planned_tester_id !== null)
  @IsUUID('all')
  planned_tester_id: string | null;
}

export type TestPlanPage<T> = TestSetPage<T>;

export interface TestPlan {
  id: string;
  key: string;
  key_number: number;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  is_archived: boolean;
  archived_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  test_count: number;
  execution_count: number;
  folder_id: string | null;

  // Key of the linked ticket; lists only.
  task_id?: string;
  task_key?: string | null;

  // Who last changed the plan; lists only.
  updater?: TestRecordUser | null;
}

export interface PlanTester {
  id: string;
  name: string;
  avatar_url: string | null;
  eligible: boolean;
}

export interface TestPlanTest {
  case_id: string;
  key: string;
  key_number: number;
  title: string;
  readiness: TestCaseReadiness;
  test_type: string;
  is_archived: boolean;
  added_at: string;
  planned_tester: PlanTester | null;

  // Key of the test case's ticket, when it has one.
  task_key?: string | null;
}

export interface EligibleTester {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
}

/** Result of tm_add_plan_tests, with the id lists turned into counts. */
export interface PlanTestsAdded {
  changed: boolean;
  added: number;
  already_present: number;
  skipped: {
    case_id: string;
    key: string;
    reason: 'archived' | 'deprecated';
  }[];
  warnings: { case_id: string; key: string; reason: 'draft' }[];
}

export interface PlanTestsRemoved {
  removed: number;
}

export interface TestPlanDeleted {
  executions_detached: number;
}

export const BULK_DELETE_PLAN_LIMIT = 100;

/** Test plans to delete together; each is checked as a single delete would be. */
export class BulkDeleteTestPlansDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: BULK_DELETE_PLAN_LIMIT,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_DELETE_PLAN_LIMIT)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  plan_ids: string[];
}

/** Test plans to archive or restore together. */
export class BulkArchiveTestPlansDto {
  @ApiProperty({ enum: BULK_ARCHIVE_ACTIONS })
  @IsIn(BULK_ARCHIVE_ACTIONS)
  action: BulkArchiveAction;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: BULK_ARCHIVE_LIMIT,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_ARCHIVE_LIMIT)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  plan_ids: string[];
}

export interface TestPlanBulkDeleteResult {
  changed: boolean;
  deleted: { plan_id: string; key: string; executions_detached: number }[];
  skipped: {
    plan_id: string;
    key: string;
    reason: 'has_results' | 'not_found' | 'failed';
  }[];
}

export interface TestPlanProgress {
  total_tests: number;
  counts: Record<FinalStatus | 'NOT_RUN', number>;
  success_rate: number | null;
  excluded: { archived: number; deprecated: number };
  by_tester: {
    user_id: string | null;
    name: string | null;
    avatar_url: string | null;
    total: number;
    final: number;
  }[];
}

export interface TestPlanRunHistory {
  since: string;
  items: { finished_at: string; status: FinalStatus; case_id: string }[];
}
