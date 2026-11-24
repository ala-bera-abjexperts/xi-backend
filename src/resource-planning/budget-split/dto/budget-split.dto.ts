/**
 * @fileoverview DTOs for Budget Splits (`/resource-planning/budget-splits`):
 * part of a space's Overall Budget assigned to an epic or task.
 * @module src/resource-planning/budget-split/dto/budget-split.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
} from 'class-validator';
import { OVERALL_BUDGET_MAX_AMOUNT } from '../../overall-budget/dto/overall-budget.dto';

/** Trimmed; blank becomes null so the column is cleared. */
const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

export class CreateBudgetSplitDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  overall_budget_id!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  task_id!: string;

  @ApiProperty({ minimum: 0.01, maximum: OVERALL_BUDGET_MAX_AMOUNT })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(OVERALL_BUDGET_MAX_AMOUNT)
  amount!: number;

  @ApiPropertyOptional({ nullable: true, maxLength: 1000 })
  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}

/** The budget and task are fixed; amount may be omitted but not nulled (the service rejects null). */
export class UpdateBudgetSplitDto {
  @ApiPropertyOptional({ minimum: 0.01, maximum: OVERALL_BUDGET_MAX_AMOUNT })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(OVERALL_BUDGET_MAX_AMOUNT)
  amount?: number;

  @ApiPropertyOptional({ nullable: true, maxLength: 1000 })
  @Transform(trimToNull)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}
