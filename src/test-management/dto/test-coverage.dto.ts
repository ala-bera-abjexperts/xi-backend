import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateBy,
  type ValidationArguments,
} from 'class-validator';

import { TestSetPageQueryDto } from './test-set.dto';

export const COVERAGE_STATUSES = [
  'OK',
  'NOK',
  'NOT_RUN',
  'NOT_APPLICABLE',
  'UNCOVERED',
] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export const TEST_COVERAGE_LIMITS = {
  tasksPerCall: 50,

  // The API returns at most this many rows per database call; a full result is reported as truncated.
  rows: 1000,
} as const;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

const toUniqueArray = ({ value }: { value: unknown }) =>
  Array.isArray(value) ? [...new Set(value)] : value;

/** The unlinked list exists in space scope only. */
function NotWithPlan() {
  return ValidateBy({
    name: 'notWithPlan',
    validator: {
      validate: (value: unknown, args?: ValidationArguments) =>
        value !== true ||
        (args?.object as { planId?: unknown } | undefined)?.planId ===
          undefined,
      defaultMessage: () => 'includeUncovered is not allowed with planId',
    },
  });
}

/** A ticket and a test case are two different scopes; only one may be asked for. */
function NotWithCase() {
  return ValidateBy({
    name: 'notWithCase',
    validator: {
      validate: (_value: unknown, args?: ValidationArguments) =>
        (args?.object as { caseId?: unknown } | undefined)?.caseId ===
        undefined,
      defaultMessage: () => 'taskId is not allowed with caseId',
    },
  });
}

export class CoverageQueryDto extends TestSetPageQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Coverage of this plan' })
  @IsOptional()
  @IsUUID('all')
  planId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only the tickets linked to this test case',
  })
  @IsOptional()
  @IsUUID('all')
  caseId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only this ticket (not with caseId)',
  })
  @IsOptional()
  @IsUUID('all')
  @NotWithCase()
  taskId?: string;

  @ApiPropertyOptional({ enum: COVERAGE_STATUSES })
  @IsOptional()
  @IsIn(COVERAGE_STATUSES)
  status?: CoverageStatus;

  @ApiPropertyOptional({
    description:
      'Also list tickets of a counted type that have no link yet (not with planId)',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  @NotWithPlan()
  includeUncovered?: boolean;
}

/** Links tickets to a test case as requirements. */
export class LinkRequirementsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: TEST_COVERAGE_LIMITS.tasksPerCall,
    description: 'Duplicates are counted once',
  })
  @Transform(toUniqueArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TEST_COVERAGE_LIMITS.tasksPerCall)
  @IsUUID('all', { each: true })
  task_ids: string[];
}

export interface CaseRequirementsLinkResult {
  added: number;
  skipped: { task_id: string; reason: 'already_linked' }[];
}

export interface CoverageTotals {
  fail: number;
  blocked: number;
  not_run: number;
  pass: number;
  not_applicable: number;
}

interface CoverageRowBase {
  task_id: string;
  status: CoverageStatus;

  // Counted test cases (active, not deprecated).
  counted: number;
  totals: CoverageTotals;
  case_ids: string[];
}

export interface VisibleCoverageRow extends CoverageRowBase {
  restricted: false;
  key: string;
  summary: string;
  task_type_id: string | null;
  space_key: string;
}

// The caller cannot see the ticket; status and counts come from test data only.
export interface RestrictedCoverageRow extends CoverageRowBase {
  restricted: true;
}

export type CoverageRow = VisibleCoverageRow | RestrictedCoverageRow;

export interface CoveragePage {
  items: CoverageRow[];
  total: number;
  page: number;
  pageSize: number;

  // Rows per status over the whole result, before paging.
  status_totals: Record<CoverageStatus, number>;

  // The result reached the row ceiling, so totals may be partial.
  truncated: boolean;

  // Unlinked tickets were asked for but the caller cannot view tickets of this space.
  uncovered_hidden: boolean;
}
