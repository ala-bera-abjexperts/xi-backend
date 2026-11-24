import { ApiProperty } from '@nestjs/swagger';

export const TEST_COVERAGE_BUCKETS = [
  'fail',
  'blocked',
  'not_run',
  'pass',
  'not_applicable',
] as const;

export type TestCoverageBucket = (typeof TEST_COVERAGE_BUCKETS)[number];

/** One status; color_token is a theme palette key, never a hex value. */
export class TestStatusResponseDto {
  @ApiProperty({ example: 'PASS' })
  code: string;

  @ApiProperty()
  applies_to_run: boolean;

  @ApiProperty()
  applies_to_step: boolean;

  @ApiProperty()
  is_final: boolean;

  @ApiProperty({ enum: TEST_COVERAGE_BUCKETS })
  coverage_bucket: TestCoverageBucket;

  @ApiProperty()
  sort_order: number;

  @ApiProperty({ example: 'success' })
  color_token: string;
}

/**
 * The fixed status vocabulary. Must match the status CHECK lists and tm_status_bucket() in
 * The step CHECK on test_run_attempts.step_results.
 */
export const TEST_STATUSES: readonly TestStatusResponseDto[] = [
  {
    code: 'TODO',
    applies_to_run: true,
    applies_to_step: true,
    is_final: false,
    coverage_bucket: 'not_run',
    sort_order: 10,
    color_token: 'secondary',
  },
  {
    code: 'EXECUTING',
    applies_to_run: true,
    applies_to_step: false,
    is_final: false,
    coverage_bucket: 'not_run',
    sort_order: 20,
    color_token: 'info',
  },
  {
    code: 'PASS',
    applies_to_run: true,
    applies_to_step: true,
    is_final: true,
    coverage_bucket: 'pass',
    sort_order: 30,
    color_token: 'success',
  },
  {
    code: 'FAIL',
    applies_to_run: true,
    applies_to_step: true,
    is_final: true,
    coverage_bucket: 'fail',
    sort_order: 40,
    color_token: 'error',
  },
  {
    code: 'BLOCKED',
    applies_to_run: true,
    applies_to_step: true,
    is_final: true,
    coverage_bucket: 'blocked',
    sort_order: 50,
    color_token: 'warning',
  },
  {
    code: 'ABORTED',
    applies_to_run: true,
    applies_to_step: false,
    is_final: true,
    coverage_bucket: 'blocked',
    sort_order: 60,
    color_token: 'warning',
  },
  {
    code: 'NOT_APPLICABLE',
    applies_to_run: true,
    applies_to_step: true,
    is_final: true,
    coverage_bucket: 'not_applicable',
    sort_order: 70,
    color_token: 'secondary',
  },
];
