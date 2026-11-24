import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  isUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
  type ValidationArguments,
} from 'class-validator';

import { stripIllegalXml } from '../../backup/engine/writers/xml.writer';

// Limits mirror the test_cases CHECKs and tm_normalize_steps; the database re-checks every one.
export const TEST_CASE_LIMITS = {
  title: 255,
  longText: 10000,
  stepText: 4000,
  steps: 100,
  estimateMinutes: 10080,
  automationKey: 1000,
} as const;

// Matches the test_cases.test_type CHECK.
export const TEST_TYPE_MAX = 100;

export const CREATE_READINESS = ['draft', 'ready'] as const;
export const TEST_CASE_READINESS = ['draft', 'ready', 'deprecated'] as const;
export type TestCaseReadiness = (typeof TEST_CASE_READINESS)[number];

export const TEST_CASE_SORT_FIELDS = [
  'key',
  'title',
  'readiness',
  'created_at',
  'updated_at',
] as const;

export const BULK_CASE_ACTIONS = ['move', 'archive', 'restore'] as const;
export type BulkCaseAction = (typeof BULK_CASE_ACTIONS)[number];
export const BULK_CASE_LIMIT = 500;

// Half of a broken emoji (an unpaired UTF-16 surrogate) cannot be stored as text.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** UTF-8 byte length, as the database counts it. The library byte check throws on a lone surrogate, which gave a 500. */
function IsUtf8ByteLength(min: number, max: number) {
  return ValidateBy({
    name: 'isUtf8ByteLength',
    validator: {
      validate: (value: unknown) => {
        if (typeof value !== 'string' || LONE_SURROGATE.test(value))
          return false;

        const bytes = Buffer.byteLength(value, 'utf8');

        return bytes >= min && bytes <= max;
      },
      defaultMessage: (args?: ValidationArguments) =>
        `${args?.property ?? 'value'} must be valid text of ${min} to ${max} bytes`,
    },
  });
}

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Plain text: drops invisible control characters only, so '<Enter>', '<= 5' and '&' are kept as typed.
export const cleanText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? stripIllegalXml(value) : value;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

// Accepts ?r=a, ?r=a&r=b and ?r=a,b alike.
export const toUniqueList = ({ value }: { value: unknown }) => {
  if (value === undefined) return value;

  const parts = (Array.isArray(value) ? value : [value]).flatMap(
    (item: unknown) =>
      typeof item === 'string' ? item.split(',').map((p) => p.trim()) : [item],
  );

  return [...new Set(parts)];
};

export class TestStepDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Existing step id; omit for a new step',
  })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ minLength: 1, maxLength: TEST_CASE_LIMITS.stepText })
  @Transform(cleanText)
  @Transform(trim)
  @IsString()
  @Length(1, TEST_CASE_LIMITS.stepText)
  action: string;

  @ApiPropertyOptional({
    maxLength: TEST_CASE_LIMITS.stepText,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_CASE_LIMITS.stepText)
  data?: string | null;

  @ApiPropertyOptional({
    maxLength: TEST_CASE_LIMITS.stepText,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_CASE_LIMITS.stepText)
  expected_result?: string | null;
}

export class CreateTestCaseDto {
  @ApiProperty({ minLength: 1, maxLength: TEST_CASE_LIMITS.title })
  @Transform(trim)
  @IsString()
  @Length(1, TEST_CASE_LIMITS.title)
  title: string;

  @ApiPropertyOptional({
    maxLength: TEST_CASE_LIMITS.longText,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_CASE_LIMITS.longText)
  objective?: string | null;

  @ApiPropertyOptional({
    maxLength: TEST_CASE_LIMITS.longText,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_CASE_LIMITS.longText)
  preconditions?: string | null;

  @ApiPropertyOptional({ enum: CREATE_READINESS, default: 'draft' })
  @IsOptional()
  @IsIn(CREATE_READINESS)
  readiness?: (typeof CREATE_READINESS)[number];

  @ApiPropertyOptional({
    minimum: 0,
    maximum: TEST_CASE_LIMITS.estimateMinutes,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(TEST_CASE_LIMITS.estimateMinutes)
  estimate_minutes?: number | null;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: TEST_CASE_LIMITS.automationKey,
    nullable: true,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsUtf8ByteLength(1, TEST_CASE_LIMITS.automationKey)
  automation_key?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The test file a run from this test case uses, from the tests folder; blank clears it',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  automation_spec_path?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  folder_id?: string | null;

  @ApiPropertyOptional({ type: [TestStepDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TEST_CASE_LIMITS.steps)
  @ValidateNested({ each: true })
  @Type(() => TestStepDto)
  steps?: TestStepDto[];
}

export class SetCaseAssigneeDto {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'Who is assigned; null clears it',
  })
  @ValidateIf((dto: SetCaseAssigneeDto) => dto.assignee_id !== null)
  @IsUUID()
  assignee_id: string | null;
}

/** Partial update; null clears an optional text field. Title and readiness can never be null. */
export class UpdateTestCaseDto {
  @ApiProperty({
    minimum: 1,
    description: 'Revision the edit is based on',
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expected_revision: number;

  @ApiPropertyOptional({ minLength: 1, maxLength: TEST_CASE_LIMITS.title })
  @ValidateIf((dto: UpdateTestCaseDto) => dto.title !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, TEST_CASE_LIMITS.title)
  title?: string;

  @ApiPropertyOptional({
    maxLength: TEST_CASE_LIMITS.longText,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_CASE_LIMITS.longText)
  objective?: string | null;

  @ApiPropertyOptional({
    maxLength: TEST_CASE_LIMITS.longText,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_CASE_LIMITS.longText)
  preconditions?: string | null;

  @ApiPropertyOptional({ enum: TEST_CASE_READINESS })
  @ValidateIf((dto: UpdateTestCaseDto) => dto.readiness !== undefined)
  @IsIn(TEST_CASE_READINESS)
  readiness?: TestCaseReadiness;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: TEST_CASE_LIMITS.estimateMinutes,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(TEST_CASE_LIMITS.estimateMinutes)
  estimate_minutes?: number | null;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: TEST_CASE_LIMITS.automationKey,
    nullable: true,
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsUtf8ByteLength(1, TEST_CASE_LIMITS.automationKey)
  automation_key?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The test file a run from this test case uses, from the tests folder; blank clears it',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  automation_spec_path?: string | null;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: TEST_TYPE_MAX,
    description: 'One of the space test type ids',
  })
  @ValidateIf((dto: UpdateTestCaseDto) => dto.test_type !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, TEST_TYPE_MAX)
  test_type?: string;

  @ApiPropertyOptional({
    maxLength: TEST_CASE_LIMITS.longText,
    nullable: true,
    description: 'Scenario, definition or notes for tests without steps',
  })
  @IsOptional()
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_CASE_LIMITS.longText)
  definition?: string | null;
}

export class SaveTestStepsDto {
  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expected_revision: number;

  @ApiProperty({ type: [TestStepDto] })
  @IsArray()
  @ArrayMaxSize(TEST_CASE_LIMITS.steps)
  @ValidateNested({ each: true })
  @Type(() => TestStepDto)
  steps: TestStepDto[];
}

export class ListTestCasesQueryDto {
  @ApiPropertyOptional({
    description: 'true lists archived cases only; default lists active ones',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 100000, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Matches the key or title, ignoring case',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(200)
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
    format: 'uuid',
    description: 'Only cases directly in this folder',
  })
  @IsOptional()
  @IsUUID()
  folderId?: string;

  @ApiPropertyOptional({
    example: 'updated_at:desc',
    default: 'key:asc',
    description: `${TEST_CASE_SORT_FIELDS.join('|')}, optionally with :asc or :desc`,
  })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(`^(${TEST_CASE_SORT_FIELDS.join('|')})(:(asc|desc))?$`), {
    message: 'sort must be a known field with an optional :asc or :desc',
  })
  sort?: string;

  @ApiPropertyOptional({ description: 'Only the record of this ticket' })
  @IsOptional()
  @IsUUID('all')
  taskId?: string;

  @ApiPropertyOptional({
    maxLength: TEST_TYPE_MAX,
    description: 'Only cases of this test type id, e.g. manual',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, TEST_TYPE_MAX)
  testType?: string;
}

/** folder_id must be sent for move (null = root) and must be absent otherwise. */
export class BulkTestCasesDto {
  @ApiProperty({ enum: BULK_CASE_ACTIONS })
  @IsIn(BULK_CASE_ACTIONS)
  action: BulkCaseAction;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: BULK_CASE_LIMIT,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_CASE_LIMIT)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  case_ids: string[];

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Target folder for move; null moves to the root',
  })
  @ValidateBy({
    name: 'bulkFolderId',
    validator: {
      validate: (value: unknown, args?: ValidationArguments) =>
        (args?.object as BulkTestCasesDto | undefined)?.action === 'move'
          ? value === null || isUUID(value, 'all')
          : value === undefined,
      defaultMessage: () =>
        'folder_id (a uuid or null) is required for move and not allowed otherwise',
    },
  })
  folder_id?: string | null;
}

export const BULK_DELETE_CASE_LIMIT = 100;

/** Test cases to delete together; each is checked as a single delete would be. */
export class BulkDeleteTestCasesDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: BULK_DELETE_CASE_LIMIT,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_DELETE_CASE_LIMIT)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  case_ids: string[];
}

export class DeleteTestCaseQueryDto {
  @ApiPropertyOptional({
    description:
      'true returns the counts that would be removed without deleting',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  dryRun?: boolean;
}

export class TestCaseHistoryQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Id of the oldest entry already shown',
  })
  @IsOptional()
  @IsUUID()
  before?: string;
}

export interface TestCaseBulkDeleteResult {
  changed: boolean;
  deleted: { case_id: string; key: string }[];
  skipped: {
    case_id: string;
    key: string;
    reason: 'has_runs' | 'not_found' | 'failed';
  }[];
}

export interface TestCaseBulkResult {
  changed: boolean;
  updated: string[];
  skipped: {
    case_id: string;
    key: string;
    reason: 'already_in_state' | 'archived';
  }[];
}

export interface TestStep {
  id: string;
  action: string;
  data: string | null;
  expected_result: string | null;
}

export interface TestCaseSummary {
  id: string;
  key: string;
  key_number: number;
  folder_id: string | null;
  title: string;
  readiness: TestCaseReadiness;
  test_type: string;
  estimate_minutes: number | null;
  revision: number;
  is_archived: boolean;
  updated_at: string;
}

/** The person who last changed a record; null when nobody is recorded or the user was deleted. */
export interface TestRecordUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  avatar_url: string | null;
}

export interface TestCaseDetail extends TestCaseSummary {
  objective: string | null;
  preconditions: string | null;
  automation_key: string | null;
  automation_spec_path: string | null;
  definition: string | null;
  labels?: string[];
  steps: TestStep[];
  archived_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;

  // The ticket of the case, when it has one.
  task_id?: string | null;
  task_key?: string | null;
  assignee?: TestRecordUser | null;
}

/** What changing a test case's assignee updated besides the test case itself. */
export interface TestCaseAssigneeResult {
  changed: boolean;
  plan_tests: number;
  runs: number;
  case: TestCaseDetail;

  // The ticket could not take the change, so it keeps its own assignee.
  ticket_warning: boolean;
}

export interface TestCaseHistoryEntry {
  id: string;
  revision: number;
  change_kind: string;
  changes: Record<string, unknown>;
  changed_by: string | null;
  changed_at: string;
  changed_by_user: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string;
  } | null;
}

export interface TestCaseHistoryPage {
  items: TestCaseHistoryEntry[];
  has_more: boolean;
}
