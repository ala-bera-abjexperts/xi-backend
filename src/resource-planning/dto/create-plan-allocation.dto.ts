/**
 * @fileoverview DTO for creating a plan resource allocation.
 * @module src/resource-planning/dto/create-plan-allocation.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Max,
  Min,
} from 'class-validator';
import type { AllocationMode } from '../resource-planning.validation';

export const ALLOCATION_MODES: AllocationMode[] = [
  'total_hours',
  'hours_per_week',
  'capacity_percent',
];

export class CreatePlanAllocationDto {
  @ApiProperty({ description: 'User to allocate to this plan' })
  @IsUUID()
  user_id!: string;

  @ApiPropertyOptional({
    description: 'Planned hours for this allocation',
    minimum: 0,
    default: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  planned_hours?: number;

  @ApiPropertyOptional({
    description: 'Planned budget for this allocation',
    minimum: 0,
    default: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  planned_budget?: number;

  @ApiPropertyOptional({ enum: ALLOCATION_MODES, default: 'total_hours' })
  @IsOptional()
  @IsIn(ALLOCATION_MODES)
  allocation_mode?: AllocationMode;

  @ApiPropertyOptional({ minimum: 0, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  weekly_hours?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 100, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  capacity_percent?: number | null;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @IsDateString()
  start_date?: string | null;

  @ApiPropertyOptional({ format: 'date', nullable: true })
  @IsOptional()
  @IsDateString()
  end_date?: string | null;

  @ApiPropertyOptional({
    description: 'Role label for this allocation',
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  role?: string | null;

  @ApiPropertyOptional({
    description: 'Notes for this allocation',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}
