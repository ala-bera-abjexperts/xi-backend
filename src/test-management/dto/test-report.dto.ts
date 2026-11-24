import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUUID,
  Length,
  Matches,
  ValidateBy,
  ValidateIf,
  type ValidationArguments,
} from 'class-validator';

import { TEST_EXECUTION_LIMITS } from './test-execution.dto';
import { TestSetPageQueryDto } from './test-set.dto';

// Route names; the database function takes the same names with underscores.
export const TEST_REPORT_ROUTES = [
  'execution-progress',
  'plan-progress',
  'tester-workload',
  'run-history',
  'effort',
] as const;
export type TestReportRoute = (typeof TEST_REPORT_ROUTES)[number];

export const TEST_REPORT_LIMITS = {
  days: 366,
  defaultDays: 30,
  exportRows: 10_000,
} as const;

export const TEST_REPORT_FORMATS = ['csv', 'pdf'] as const;
export type TestReportFormat = (typeof TEST_REPORT_FORMATS)[number];

export const TEST_REPORT_LANGS = ['en', 'de'] as const;
export type TestReportLang = (typeof TEST_REPORT_LANGS)[number];

export type TestReportFilterKey =
  | 'planId'
  | 'executionId'
  | 'environment'
  | 'assigneeId';

const ALL_FILTERS: readonly TestReportFilterKey[] = [
  'planId',
  'executionId',
  'environment',
  'assigneeId',
];

// A filter a report cannot apply is refused instead of being ignored silently.
export const TEST_REPORT_FILTERS: Record<
  TestReportRoute,
  readonly TestReportFilterKey[]
> = {
  'execution-progress': ALL_FILTERS,
  'plan-progress': ['planId'],
  'tester-workload': ALL_FILTERS,
  'run-history': ALL_FILTERS,
  effort: ALL_FILTERS,
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// The database matches zone names exactly, so send the canonical spelling.
const toCanonicalZone = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;

  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return value;
  }
};

const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();

  return trimmed === '' ? undefined : trimmed;
};

const datePairSent = (dto: TestReportQueryDto) =>
  dto.from !== undefined || dto.to !== undefined;

/** from ≤ to and at most 366 days counted inclusively, as the database checks. */
function ReportRange() {
  return ValidateBy({
    name: 'reportRange',
    validator: {
      validate: (value: unknown, args?: ValidationArguments) => {
        const from = (args?.object as { from?: unknown } | undefined)?.from;

        // Format errors are reported by the other validators of each field.
        if (
          typeof value !== 'string' ||
          typeof from !== 'string' ||
          !DATE_ONLY.test(value) ||
          !DATE_ONLY.test(from)
        ) {
          return true;
        }

        const days = (Date.parse(value) - Date.parse(from)) / 86_400_000 + 1;

        return days >= 1 && days <= TEST_REPORT_LIMITS.days;
      },
      defaultMessage: () =>
        `from must not be after to, and the range is at most ${TEST_REPORT_LIMITS.days} days`,
    },
  });
}

export class TestReportQueryDto extends TestSetPageQueryDto {
  @ApiPropertyOptional({
    example: '2026-09-22',
    description:
      'First day (YYYY-MM-DD); sent together with to; default the last 30 days',
  })
  @ValidateIf(datePairSent)
  @IsDefined({ message: 'from and to are sent together' })
  @Matches(DATE_ONLY, { message: 'from must be a date (YYYY-MM-DD)' })
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-21', description: 'Last day' })
  @ValidateIf(datePairSent)
  @IsDefined({ message: 'from and to are sent together' })
  @Matches(DATE_ONLY, { message: 'to must be a date (YYYY-MM-DD)' })
  @IsISO8601({ strict: true })
  @ReportRange()
  to?: string;

  @ApiPropertyOptional({ example: 'Europe/Berlin', default: 'UTC' })
  @IsOptional()
  @Transform(toCanonicalZone)
  @IsTimeZone()
  tz?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  planId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  executionId?: string;

  @ApiPropertyOptional({ description: 'Matched case-insensitively' })
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @Length(1, TEST_EXECUTION_LIMITS.environment)
  environment?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  assigneeId?: string;
}

export class TestReportExportQueryDto extends TestReportQueryDto {
  @ApiPropertyOptional({ enum: TEST_REPORT_FORMATS })
  @IsIn(TEST_REPORT_FORMATS)
  format: TestReportFormat;

  @ApiPropertyOptional({ enum: TEST_REPORT_LANGS, default: 'en' })
  @IsOptional()
  @IsIn(TEST_REPORT_LANGS)
  lang?: TestReportLang;
}

export interface TestReportRange {
  from: string;
  to: string;
  tz: string;
}

export interface TestReportPage<Row, Totals> {
  report: TestReportRoute;
  range: TestReportRange;
  items: Row[];
  total: number;
  page: number;
  pageSize: number;
  totals: Totals;

  // Set when an archived execution is the filter: archived executions are never counted.
  archived_filter?: boolean;
}

export interface RunStatusCounts {
  total: number;
  todo: number;
  executing: number;
  pass: number;
  fail: number;
  blocked: number;
  aborted: number;
  not_applicable: number;
}

export interface ExecutionProgressRow extends RunStatusCounts {
  execution_id: string;
  execution_key: string;
  execution_name: string;
  plan_id: string | null;
  environment: string | null;
  created_at: string;

  // Share of runs with a final status, 0..1.
  final_ratio: number;

  // PASS / (total - NOT_APPLICABLE); null when that is zero.
  success_rate: number | null;
}

export interface ExecutionProgressTotals extends RunStatusCounts {
  // Executions with at least one open run.
  active: number;
}

export interface PlanTrendPoint {
  day: string;
  pass: number;
  fail: number;
  blocked: number;
  aborted: number;
  not_applicable: number;
}

export interface PlanProgressCounts {
  // Every test of the plan, archived and deprecated cases included.
  tests: number;
  pass: number;
  fail: number;
  blocked: number;
  not_run: number;
  not_applicable: number;
}

export interface PlanProgressRow extends PlanProgressCounts {
  plan_id: string;
  plan_key: string;
  plan_name: string;
  start_date: string | null;
  end_date: string | null;
  success_rate: number | null;
  trend: PlanTrendPoint[];
}

export interface TesterWorkloadRow extends RunStatusCounts {
  // Null for unassigned runs, including runs of a deleted tester.
  assignee_id: string | null;
  name: string | null;
}

export interface RunHistoryRow {
  day: string;
  total: number;
  pass: number;
  fail: number;
  blocked: number;
  aborted: number;
  not_applicable: number;
}

export interface RunHistoryTotals extends Omit<RunHistoryRow, 'day'> {
  // PASS / (results - NOT_APPLICABLE); null when that is zero.
  pass_rate: number | null;
}

export interface EffortCounts {
  runs: number;
  estimate_minutes: number;

  // Typed minutes only.
  actual_minutes: number;
  no_estimate_runs: number;
  no_estimate_actual_minutes: number;

  // actual - estimate over runs that have an estimate.
  variance: number;
}

export interface EffortRow extends EffortCounts {
  dimension: 'execution' | 'plan' | 'tester';

  // Null for runs without a plan or without a tester.
  dimension_id: string | null;
  dimension_key: string | null;
  name: string | null;
}
