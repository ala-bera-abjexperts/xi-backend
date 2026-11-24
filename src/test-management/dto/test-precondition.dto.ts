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
  ValidateIf,
} from 'class-validator';

import { stripIllegalXml } from '../../backup/engine/writers/xml.writer';
import {
  cleanText,
  TEST_CASE_READINESS,
  TEST_TYPE_MAX,
  toUniqueList,
  type TestCaseReadiness,
} from './test-case.dto';
import {
  BULK_ARCHIVE_ACTIONS,
  BULK_ARCHIVE_LIMIT,
  TestSetPageQueryDto,
  type BulkArchiveAction,
  type TestSetPage,
} from './test-set.dto';

// Limits mirror the test_preconditions CHECKs; the database re-checks every one.
export const TEST_PRECONDITION_LIMITS = {
  title: 255,
  definition: 10000,
  testType: 100,
  search: 100,
  perCase: 100,
  perCall: 100,
} as const;

export const TEST_PRECONDITION_SORT_FIELDS = [
  'key',
  'title',
  'updated_at',
] as const;

// Control characters are dropped before trimming, so names and searches never carry them.
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? stripIllegalXml(value).trim() : value;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateTestPreconditionDto {
  @ApiProperty({ minLength: 1, maxLength: TEST_PRECONDITION_LIMITS.title })
  @Transform(trim)
  @IsString()
  @Length(1, TEST_PRECONDITION_LIMITS.title)
  title: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: TEST_PRECONDITION_LIMITS.testType,
    description: 'One of the space test type ids; default manual',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, TEST_PRECONDITION_LIMITS.testType)
  test_type?: string;

  @ApiPropertyOptional({
    maxLength: TEST_PRECONDITION_LIMITS.definition,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_PRECONDITION_LIMITS.definition)
  definition?: string | null;
}

/** Partial update; null clears the definition. The title and test type can never be null. */
export class UpdateTestPreconditionDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: TEST_PRECONDITION_LIMITS.title,
  })
  @ValidateIf((dto: UpdateTestPreconditionDto) => dto.title !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, TEST_PRECONDITION_LIMITS.title)
  title?: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: TEST_PRECONDITION_LIMITS.testType,
    description: 'One of the space test type ids',
  })
  @ValidateIf((dto: UpdateTestPreconditionDto) => dto.test_type !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, TEST_PRECONDITION_LIMITS.testType)
  test_type?: string;

  @ApiPropertyOptional({
    maxLength: TEST_PRECONDITION_LIMITS.definition,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_PRECONDITION_LIMITS.definition)
  definition?: string | null;
}

export class ListTestPreconditionsQueryDto extends TestSetPageQueryDto {
  @ApiPropertyOptional({
    description:
      'true lists archived preconditions only; default lists active ones',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({
    maxLength: TEST_PRECONDITION_LIMITS.search,
    description: 'Matches the key, ticket key or title, ignoring case',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TEST_PRECONDITION_LIMITS.search)
  q?: string;

  @ApiPropertyOptional({
    description: `${TEST_PRECONDITION_SORT_FIELDS.join('|')}, optionally with :asc or :desc; default key ascending`,
  })
  @IsOptional()
  @Matches(
    new RegExp(`^(${TEST_PRECONDITION_SORT_FIELDS.join('|')})(:(asc|desc))?$`),
  )
  sort?: string;

  @ApiPropertyOptional({ description: 'Only the record of this ticket' })
  @IsOptional()
  @IsUUID('all')
  taskId?: string;

  @ApiPropertyOptional({
    description: 'Only the preconditions this test case needs',
  })
  @IsOptional()
  @IsUUID('all')
  caseId?: string;

  @ApiPropertyOptional({
    maxLength: TEST_PRECONDITION_LIMITS.testType,
    description: 'Only preconditions of this test type id',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, TEST_PRECONDITION_LIMITS.testType)
  testType?: string;

  @ApiPropertyOptional({
    description:
      'true adds tests_count, the test cases using each precondition',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  withTests?: boolean;
}

/** The full list of preconditions a test case needs; an empty list removes them all. */
export class SetCasePreconditionsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: TEST_PRECONDITION_LIMITS.perCase,
  })
  @IsArray()
  @ArrayMaxSize(TEST_PRECONDITION_LIMITS.perCase)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  precondition_ids: string[];
}

export interface TestPreconditionTicketStatus {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  is_completed: boolean;
}

export interface TestPreconditionAssignee {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  avatar_url: string | null;
}

export interface TestPrecondition {
  id: string;
  key: string;
  // Fields of its ticket; null when it has none.
  task_id: string | null;
  task_key: string | null;
  task_status: TestPreconditionTicketStatus | null;
  task_assignee: TestPreconditionAssignee | null;
  key_number: number;
  title: string;
  test_type: string;
  definition: string | null;
  is_archived: boolean;
  archived_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;

  // Only when the list is asked for withTests.
  tests_count?: number;
}

export type TestPreconditionPage = TestSetPage<TestPrecondition>;

export const PRECONDITION_CASE_SORT_FIELDS = [
  'key',
  'title',
  'test_type',
  'readiness',
] as const;

export class PreconditionCasesQueryDto extends TestSetPageQueryDto {
  @ApiPropertyOptional({
    maxLength: TEST_PRECONDITION_LIMITS.search,
    description: 'Matches the test case key or title, ignoring case',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TEST_PRECONDITION_LIMITS.search)
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
    description: 'Only test cases of this test type id, e.g. manual',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, TEST_TYPE_MAX)
  testType?: string;

  @ApiPropertyOptional({
    example: 'title:desc',
    default: 'key:asc',
    description: `${PRECONDITION_CASE_SORT_FIELDS.join('|')}, optionally with :asc or :desc`,
  })
  @IsOptional()
  @IsString()
  @Matches(
    new RegExp(`^(${PRECONDITION_CASE_SORT_FIELDS.join('|')})(:(asc|desc))?$`),
    { message: 'sort must be a known field with an optional :asc or :desc' },
  )
  sort?: string;
}

/** Adds the precondition to test cases and/or takes it off them. */
export class ChangePreconditionCasesDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: TEST_PRECONDITION_LIMITS.perCall,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TEST_PRECONDITION_LIMITS.perCall)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  add?: string[];

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: TEST_PRECONDITION_LIMITS.perCall,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TEST_PRECONDITION_LIMITS.perCall)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  remove?: string[];
}

export class UnlinkTestsQueryDto {
  @ApiPropertyOptional({
    description:
      'true takes the precondition off its test cases first, so a type change or delete is not refused',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unlink_tests?: boolean;
}

export interface PreconditionCase {
  id: string;
  key: string;
  // Key of the test case's ticket; null when it has none.
  task_key: string | null;
  title: string;
  test_type: string;
  readiness: string;
  is_archived: boolean;
}

export type PreconditionCasesPage = TestSetPage<PreconditionCase>;

export interface PreconditionCasesChange {
  added: string[];
  removed: string[];
  skipped: { case_id: string; reason: string }[];
  deleted: boolean;
}

/** Preconditions to archive or restore together. */
export class BulkArchiveTestPreconditionsDto {
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
  precondition_ids: string[];
}

export const BULK_DELETE_PRECONDITION_LIMIT = 100;

/** Preconditions to delete together; each is checked as a single delete would be. */
export class BulkDeleteTestPreconditionsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: BULK_DELETE_PRECONDITION_LIMIT,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_DELETE_PRECONDITION_LIMIT)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  precondition_ids: string[];

  @ApiPropertyOptional({
    description:
      'true takes each precondition off its test cases first, so ones in use are deleted too',
  })
  @IsOptional()
  @IsBoolean()
  unlink_tests?: boolean;
}

export interface TestPreconditionBulkDeleteResult {
  changed: boolean;
  deleted: { precondition_id: string; key: string }[];
  skipped: {
    precondition_id: string;
    key: string;
    reason: 'in_use' | 'not_found' | 'failed';
    // How many test cases use it, for in_use.
    tests?: number;
  }[];
}
