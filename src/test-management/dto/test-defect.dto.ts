import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

import {
  REQUIREMENT_TICKET_SORT_DIRS,
  type RequirementTicketSortDir,
} from './requirement-ticket-search.dto';
import { cleanText } from './test-case.dto';
import type { RunStatus } from './test-execution.dto';

// Summary and description match MineCreateTaskDto, which creates the ticket.
export const TEST_DEFECT_LIMITS = {
  summary: 500,
  description: 50000,
  priority: 50,
} as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Control characters would break exports of the ticket later.
const cleanAndTrim = ({ value }: { value: unknown }) =>
  trim({ value: cleanText({ value }) });

/** Links an existing ticket to a run; any other field is refused. */
export class LinkDefectDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  task_id: string;
}

/** Creates a ticket in the run's space and links it; no assignee, space, type or labels. */
export class CreateDefectDto {
  @ApiProperty({
    format: 'uuid',
    description: 'New per create dialog; a resend returns the same link',
  })
  @IsUUID('all')
  request_id: string;

  @ApiProperty({ minLength: 1, maxLength: TEST_DEFECT_LIMITS.summary })
  @Transform(cleanAndTrim)
  @IsString()
  @Length(1, TEST_DEFECT_LIMITS.summary)
  summary: string;

  @ApiPropertyOptional({ maxLength: TEST_DEFECT_LIMITS.description })
  @IsOptional()
  @Transform(cleanText)
  @IsString()
  @MaxLength(TEST_DEFECT_LIMITS.description)
  description?: string;

  @ApiPropertyOptional({ maxLength: TEST_DEFECT_LIMITS.priority })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, TEST_DEFECT_LIMITS.priority)
  priority?: string;
}

/** A defect row of test_ticket_links. */
export interface RunDefectLink {
  id: string;
  task_id: string;
  attempt_no: number | null;
  created_at: string;
}

/** Where the defect link sits: on this run, or on its test case or a test set or plan containing it. */
export type RunDefectSource = 'run' | 'case' | 'set' | 'plan';

export interface VisibleRunDefect {
  task_id: string;
  restricted: false;
  source: RunDefectSource;
  // Key of the set or plan the link comes through; null for run and case links.
  via_key: string | null;
  key: string;
  summary: string;
  status: { name: string; color: string | null; is_completed: boolean } | null;
  space_key: string;
  attempt_no: number | null;
  created_at: string;
}

// The caller cannot see the ticket, so only the id is shown.
export interface RestrictedRunDefect {
  task_id: string;
  restricted: true;
  source: RunDefectSource;
  via_key: string | null;
  attempt_no: number | null;
  created_at: string;
}

export type RunDefect = VisibleRunDefect | RestrictedRunDefect;

/** A test run that lists the ticket as a defect, for the ticket page. */
export interface TaskDefectRun {
  run_id: string;
  case_key: string;
  case_title: string;
  execution_id: string;
  execution_key: string;
  execution_name: string;
  attempt_no: number | null;
  status: RunStatus;
  linked_at: string;
}

export interface CreatedDefectTask {
  id: string;
  key: string;
  summary: string;
}

// linked false: the ticket exists but the link could not be saved; the caller links it instead.
export type DefectCreated =
  | { linked: true; link: RunDefectLink; task: CreatedDefectTask }
  | { linked: false; task: CreatedDefectTask };

export const TASK_DEFECTS_SORT_FIELDS = [
  'case_key',
  'execution_key',
  'attempt',
  'status',
] as const;
export type TaskDefectsSortField = (typeof TASK_DEFECTS_SORT_FIELDS)[number];

/** Optional sorting for the ticket's defect runs; left out, newest link first. */
export class TaskDefectsQueryDto {
  @ApiPropertyOptional({ enum: TASK_DEFECTS_SORT_FIELDS })
  @IsOptional()
  @IsIn(TASK_DEFECTS_SORT_FIELDS)
  sortBy?: TaskDefectsSortField;

  @ApiPropertyOptional({ enum: REQUIREMENT_TICKET_SORT_DIRS, default: 'asc' })
  @IsOptional()
  @IsIn(REQUIREMENT_TICKET_SORT_DIRS)
  sortDir?: RequirementTicketSortDir;
}
