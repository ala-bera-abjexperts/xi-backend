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
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { sanitizeRichText } from '../../common/utils/sanitize-rich-text';
import {
  TEST_CASE_READINESS,
  TEST_TYPE_MAX,
  toUniqueList,
  type TestCaseReadiness,
  type TestRecordUser,
} from './test-case.dto';

// Limits mirror the test_sets CHECKs and tm_change_set_members; the database re-checks every one.
export const TEST_SET_LIMITS = {
  name: 255,
  description: 10000,
  members: 1000,
} as const;

export const TEST_SET_SORT_FIELDS = ['key', 'name', 'updated_at'] as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Set and plan descriptions are rich text, cleaned the same way as a task description.
export const cleanRichText = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? sanitizeRichText(value, { allowTables: true })
    : value;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateTestSetDto {
  @ApiProperty({ minLength: 1, maxLength: TEST_SET_LIMITS.name })
  @Transform(trim)
  @IsString()
  @Length(1, TEST_SET_LIMITS.name)
  name: string;

  @ApiPropertyOptional({
    maxLength: TEST_SET_LIMITS.description,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanRichText)
  @IsString()
  @MaxLength(TEST_SET_LIMITS.description)
  description?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  folder_id?: string | null;
}

/** Partial update; null clears the description or takes the set out of its folder. The name can never be null. */
export class UpdateTestSetDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: TEST_SET_LIMITS.name })
  @ValidateIf((dto: UpdateTestSetDto) => dto.name !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, TEST_SET_LIMITS.name)
  name?: string;

  @ApiPropertyOptional({
    maxLength: TEST_SET_LIMITS.description,
    nullable: true,
  })
  @IsOptional()
  @Transform(cleanRichText)
  @IsString()
  @MaxLength(TEST_SET_LIMITS.description)
  description?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  folder_id?: string | null;
}

export class TestSetPageQueryDto {
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
}

export const TEST_SET_MEMBER_SORT_FIELDS = [
  'key',
  'title',
  'readiness',
  'test_type',
] as const;

export class TestSetMembersQueryDto extends TestSetPageQueryDto {
  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Matches the case key or title, ignoring case',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
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
    description: 'Only cases of this test type id, e.g. manual',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, TEST_TYPE_MAX)
  testType?: string;

  @ApiPropertyOptional({
    description: 'Ticket assignee: me, unassigned or a user id',
    example: 'me',
  })
  @IsOptional()
  @IsString()
  @Matches(
    /^(me|unassigned|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    { message: 'assignee must be me, unassigned or a user id' },
  )
  assignee?: string;

  @ApiPropertyOptional({
    example: 'title:desc',
    default: 'key:asc',
    description: `${TEST_SET_MEMBER_SORT_FIELDS.join('|')}, optionally with :asc or :desc`,
  })
  @IsOptional()
  @IsString()
  @Matches(
    new RegExp(`^(${TEST_SET_MEMBER_SORT_FIELDS.join('|')})(:(asc|desc))?$`),
    { message: 'sort must be a known field with an optional :asc or :desc' },
  )
  sort?: string;
}

export class ListTestSetsQueryDto extends TestSetPageQueryDto {
  @ApiPropertyOptional({
    description: 'true lists archived sets only; default lists active ones',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Matches the key or name, ignoring case',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description: `${TEST_SET_SORT_FIELDS.join('|')}, optionally with :asc or :desc; default key ascending`,
  })
  @IsOptional()
  @Matches(new RegExp(`^(${TEST_SET_SORT_FIELDS.join('|')})(:(asc|desc))?$`))
  sort?: string;

  @ApiPropertyOptional({ description: 'Only the record of this ticket' })
  @IsOptional()
  @IsUUID('all')
  taskId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only sets directly in this folder',
  })
  @IsOptional()
  @IsUUID()
  folderId?: string;
}

export class ChangeTestSetMembersDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: TEST_SET_LIMITS.members,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TEST_SET_LIMITS.members)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  case_ids: string[];
}

export const BULK_DELETE_SET_LIMIT = 100;

/** Test sets to delete together; each is checked as a single delete would be. */
export class BulkDeleteTestSetsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: BULK_DELETE_SET_LIMIT,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_DELETE_SET_LIMIT)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  set_ids: string[];
}

export interface TestSetBulkDeleteResult {
  changed: boolean;
  deleted: { set_id: string; key: string }[];
  skipped: { set_id: string; key: string; reason: 'not_found' | 'failed' }[];
}

// Shared by the bulk archive and restore of sets, plans and executions.
export const BULK_ARCHIVE_ACTIONS = ['archive', 'restore'] as const;
export type BulkArchiveAction = (typeof BULK_ARCHIVE_ACTIONS)[number];
export const BULK_ARCHIVE_LIMIT = 100;

export interface TestRecordBulkArchiveResult {
  changed: boolean;
  updated: { id: string; key: string }[];
  skipped: {
    id: string;
    key: string;
    reason: 'already_in_state' | 'not_found' | 'failed';
  }[];
}

/** Test sets to archive or restore together. */
export class BulkArchiveTestSetsDto {
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
  set_ids: string[];
}

export interface TestSetSummary {
  id: string;
  key: string;
  key_number: number;
  name: string;
  description: string | null;
  is_archived: boolean;
  member_count: number;
  updated_at: string;
  folder_id: string | null;
  /** List rows only: key of the task ticket the set belongs to, null when it has none. */
  task_key?: string | null;
  /** List rows only: who last changed the set. */
  updater?: TestRecordUser | null;
}

export interface TestSetDetail extends TestSetSummary {
  archived_at: string | null;
  archived_by: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;

  // The ticket of the set, when it has one.
  task_id?: string | null;
}

export interface TestSetMember {
  id: string;
  key: string;
  task_key: string | null;
  title: string;
  readiness: TestCaseReadiness;
  test_type: string;
  is_archived: boolean;
  assignee?: TestRecordUser | null;
}

export interface TestSetPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Result of tm_change_set_members. */
export interface TestSetMembersChange {
  changed: boolean;
  added: string[];
  already_present: string[];
  removed: string[];
  skipped: {
    case_id: string;
    key: string;
    reason: 'archived' | 'deprecated' | 'not_member';
  }[];
}
