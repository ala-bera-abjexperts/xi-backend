import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

import { toUniqueList } from './test-case.dto';
import {
  ATTEMPT_KINDS,
  RUN_STATUSES,
  type AttemptKind,
  type RunStatus,
  type StepResult,
  type StepStatus,
  type TestRunDetail,
  type UserRef,
} from './test-execution.dto';
import { TestSetPageQueryDto } from './test-set.dto';

export const ATTEMPT_SORT_FIELDS = [
  'attempt',
  'result',
  'steps',
  'tester',
  'ran',
  'time',
] as const;
export type AttemptSortField = (typeof ATTEMPT_SORT_FIELDS)[number];

const ATTEMPT_FILTER_KINDS = ['initial', ...ATTEMPT_KINDS] as const;

// Paging comes from TestSetPageQueryDto (page, pageSize ≤ 100).
export class AttemptHistoryQueryDto extends TestSetPageQueryDto {
  @ApiPropertyOptional({
    example: 'ran:asc',
    default: 'attempt:desc',
    description: `${ATTEMPT_SORT_FIELDS.join('|')}, optionally with :asc or :desc`,
  })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(`^(${ATTEMPT_SORT_FIELDS.join('|')})(:(asc|desc))?$`), {
    message: 'sort must be a known field with an optional :asc or :desc',
  })
  sort?: string;

  @ApiPropertyOptional({
    enum: RUN_STATUSES,
    isArray: true,
    description: 'Attempt result; repeat or comma-separate',
  })
  @IsOptional()
  @Transform(toUniqueList)
  @IsArray()
  @ArrayMaxSize(RUN_STATUSES.length)
  @IsIn(RUN_STATUSES, { each: true })
  status?: RunStatus[];

  @ApiPropertyOptional({
    enum: ATTEMPT_FILTER_KINDS,
    isArray: true,
    description: 'How the attempt started; repeat or comma-separate',
  })
  @IsOptional()
  @Transform(toUniqueList)
  @IsArray()
  @ArrayMaxSize(ATTEMPT_FILTER_KINDS.length)
  @IsIn(ATTEMPT_FILTER_KINDS, { each: true })
  kind?: ('initial' | AttemptKind)[];
}

export type AttemptSnapshot = TestRunDetail['current_attempt']['snapshot'];

export interface AttemptHistoryItem {
  id: string;
  attempt_no: number;
  kind: 'initial' | AttemptKind;
  status: RunStatus;
  status_overridden: boolean;
  comment: string | null;
  actual_minutes: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  created_by: UserRef | null;
  is_current: boolean;

  // Snapshot steps per status; a step without a result counts as TODO.
  counts: Record<StepStatus, number>;
}

export interface AttemptDetail extends AttemptHistoryItem {
  run_id: string;
  case_revision: number;
  snapshot: AttemptSnapshot;

  // Keyed by snapshot step id; a missing step is TODO.
  step_results: Record<string, StepResult>;
  iterations: TestRunDetail['current_attempt']['iterations'];
}
