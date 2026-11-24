/**
 * @fileoverview DTO for bulk-editing or resetting default employee capacity rows.
 * @module src/resource-planning/dto/bulk-update-capacity.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  SUPPORTED_CAPACITY_CURRENCIES,
  trimUpperString,
  UNSUPPORTED_CURRENCY_MESSAGE,
} from './capacity-period.dto';

const isSet = (_: unknown, value: unknown) =>
  value !== null && value !== undefined;

/** Fields to apply to every selected employee; undefined = untouched, null = clear. */
export class BulkCapacityChangesDto {
  @ApiPropertyOptional({ minimum: 0 })
  @ValidateIf((_, value) => value !== undefined)
  @IsNumber()
  @Min(0)
  weekly_capacity_hours?: number;

  @ApiPropertyOptional({ minimum: 0, nullable: true })
  @ValidateIf(isSet)
  @IsNumber()
  @Min(0)
  cost_rate?: number | null;

  @ApiPropertyOptional({ enum: SUPPORTED_CAPACITY_CURRENCIES, nullable: true })
  @Transform(({ value }) => {
    const normalized = trimUpperString(value);
    return normalized === '' ? null : normalized;
  })
  @ValidateIf(isSet)
  @IsIn(SUPPORTED_CAPACITY_CURRENCIES, {
    message: UNSUPPORTED_CURRENCY_MESSAGE,
  })
  currency?: string | null;
}

export class BulkUpdateCapacityDto {
  @ApiProperty({ enum: ['update', 'reset'] })
  @IsIn(['update', 'reset'])
  action!: 'update' | 'reset';

  @ApiProperty({ type: [String], minItems: 1, maxItems: 1000 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  user_ids!: string[];

  @ApiPropertyOptional({
    type: BulkCapacityChangesDto,
    description: "Required for 'update', must be omitted for 'reset'",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => BulkCapacityChangesDto)
  changes?: BulkCapacityChangesDto;
}
