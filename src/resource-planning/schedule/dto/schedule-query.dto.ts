/**
 * @fileoverview Query DTO for `GET /resource-planning/schedule`.
 * @module src/resource-planning/schedule/dto/schedule-query.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const GRANULARITIES = ['day', 'week', 'month'] as const;

/** Above this, a day-granularity query is rejected outright rather than let O(users x days)
 *  degrade silently -- see 12-phase-3-team-employee-planning.md 3.2. */
export const SCHEDULE_MAX_DAY_GRANULARITY_DAYS = 92;

/** Hard ceiling on resolved users per request; past this the response is truncated and says so
 *  via `truncated_users` rather than silently growing unbounded. */
export const SCHEDULE_MAX_USERS = 500;

/** Same comma-separated-string-to-array pattern as GroupMembershipsQueryDto
 *  (src/user-groups/dto/group-memberships-query.dto.ts) -- the established convention in this
 *  codebase for repeatable-id query filters, not repeated query keys. */
function toUuidArray({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;

  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export class ScheduleQueryDto {
  @ApiProperty({ format: 'date', description: 'Inclusive UTC start date' })
  @IsDateString({ strict: true })
  from!: string;

  @ApiProperty({ format: 'date', description: 'Inclusive UTC end date' })
  @IsDateString({ strict: true })
  to!: string;

  @ApiPropertyOptional({ enum: GRANULARITIES, default: 'week' })
  @IsOptional()
  @IsIn(GRANULARITIES)
  granularity?: 'day' | 'week' | 'month';

  @ApiPropertyOptional({
    type: [String],
    description: 'Comma-separated organization_unit ids',
  })
  @IsOptional()
  @Transform(toUuidArray)
  @IsArray()
  // Bare @IsUUID (not '4') to match the rest of the module -- see
  // reporting/dto/resource-planning-report-query.dto.ts. A version-pinned check would 400 here
  // for ids that /reports accepts.
  @ArrayMaxSize(SCHEDULE_MAX_USERS)
  @IsUUID(undefined, { each: true })
  unit_ids?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Comma-separated user ids',
  })
  @IsOptional()
  @Transform(toUuidArray)
  @IsArray()
  @ArrayMaxSize(SCHEDULE_MAX_USERS)
  @IsUUID(undefined, { each: true })
  user_ids?: string[];

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      "Restrict to people working on this portfolio. Resolved to the portfolio's " +
      'non-archived plans, then to everyone allocated to those plans or their tasks.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @IsUUID()
  portfolio_id?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Restrict to one space: only people with a plan or task allocation there, and only ' +
      'those assignments. 403 when Resource Planning is not available in that space.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  )
  @IsUUID()
  space_id?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Comma-separated plan ids. Combined with portfolio_id it narrows further ' +
      '(intersection), it does not widen.',
  })
  @IsOptional()
  @Transform(toUuidArray)
  @IsArray()
  @ArrayMaxSize(SCHEDULE_MAX_USERS)
  @IsUUID(undefined, { each: true })
  plan_ids?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Comma-separated role labels (free-text, not a lookup table)',
  })
  @IsOptional()
  @Transform(toUuidArray)
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  roles?: string[];
}
