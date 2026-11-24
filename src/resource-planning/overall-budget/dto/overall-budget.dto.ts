/**
 * @fileoverview DTOs for space Overall Budget records
 * (`/resource-planning/spaces/:spaceId/overall-budgets`).
 * @module src/resource-planning/overall-budget/dto/overall-budget.dto
 */

import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  SUPPORTED_CAPACITY_CURRENCIES,
  trimUpperString,
  UNSUPPORTED_CURRENCY_MESSAGE,
} from '../../dto/capacity-period.dto';

/** Largest amount that is exact in JS and fits numeric(18,2). */
export const OVERALL_BUDGET_MAX_AMOUNT = Number.MAX_SAFE_INTEGER;

/**
 * Where a budget's money comes from. Same order and codes as the frontend
 * OVERALL_BUDGET_SOURCES (parity spec) and the overall_budgets_source_check
 * constraint.
 */
export const OVERALL_BUDGET_SOURCES = [
  'internal',
  'customer',
  'grant',
  'partner',
  'investor',
  'loan',
  'other',
] as const;
export type OverallBudgetSource = (typeof OVERALL_BUDGET_SOURCES)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Trimmed; blank becomes null so the column is cleared. */
const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export class CreateOverallBudgetDto {
  @ApiProperty({ maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ minimum: 0.01, maximum: OVERALL_BUDGET_MAX_AMOUNT })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(OVERALL_BUDGET_MAX_AMOUNT)
  amount!: number;

  @ApiProperty({ enum: SUPPORTED_CAPACITY_CURRENCIES })
  @Transform(({ value }) => trimUpperString(value))
  @IsIn(SUPPORTED_CAPACITY_CURRENCIES, {
    message: UNSUPPORTED_CURRENCY_MESSAGE,
  })
  currency!: string;

  /** Funding type code (labels live in the app); blank becomes null. */
  @ApiPropertyOptional({ nullable: true, enum: OVERALL_BUDGET_SOURCES })
  @Transform(trimToNull)
  @IsOptional()
  @IsIn(OVERALL_BUDGET_SOURCES)
  source?: OverallBudgetSource | null;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 20,
    example: '2026/27',
  })
  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  financial_year?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  responsible_user_id?: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cost_category_id?: string | null;
}

/** name / amount / currency may be omitted but not nulled; the service rejects null. */
export class UpdateOverallBudgetDto extends PartialType(
  CreateOverallBudgetDto,
) {}
