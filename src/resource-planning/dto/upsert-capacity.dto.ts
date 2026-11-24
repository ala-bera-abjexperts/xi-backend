/**
 * @fileoverview DTO for upserting an employee capacity row.
 * @module src/resource-planning/dto/upsert-capacity.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';
import {
  IsRateCurrency,
  SUPPORTED_CAPACITY_CURRENCIES,
} from './capacity-period.dto';

export class UpsertCapacityDto {
  @ApiProperty({
    description: 'Weekly capacity hours for the employee',
    minimum: 0,
  })
  @IsNumber()
  @Min(0)
  weekly_capacity_hours!: number;

  @ApiPropertyOptional({
    description: 'Cost rate per hour (optional)',
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  cost_rate?: number | null;

  @ApiPropertyOptional({
    description: 'Currency code (ISO 4217); required when cost_rate is set',
    enum: SUPPORTED_CAPACITY_CURRENCIES,
    nullable: true,
  })
  @IsRateCurrency()
  currency?: string | null;

  @ApiPropertyOptional({
    description: 'Whether this capacity record is active',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
