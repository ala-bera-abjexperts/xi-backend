/**
 * @fileoverview DTO for updating an organization's risk configuration.
 * Validates per-value constraints matching risk-management-app's Zod schema:
 * - probability_mappings: each value 0–1 (z.number().min(0).max(1))
 * - impact_mappings: each value positive (z.number().positive())
 * @module src/risk-configuration/dto/update-risk-configuration.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Probability mappings: levels 1–4, each a decimal between 0 and 1. */
export class ProbabilityMappingsDto {
  @IsNumber()
  @Min(0)
  @Max(1)
  '1'!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  '2'!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  '3'!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  '4'!: number;
}

/** Impact mappings: levels 1–4, each a positive monetary value. */
export class ImpactMappingsDto {
  @IsNumber()
  @IsPositive()
  '1'!: number;

  @IsNumber()
  @IsPositive()
  '2'!: number;

  @IsNumber()
  @IsPositive()
  '3'!: number;

  @IsNumber()
  @IsPositive()
  '4'!: number;
}

export class UpdateRiskConfigurationDto {
  @ApiPropertyOptional({
    description:
      'Probability mappings for levels 1–4 (decimal 0–1 each). ' +
      'E.g. {"1":0.005,"2":0.055,"3":0.2,"4":0.65}',
    example: { '1': 0.005, '2': 0.055, '3': 0.2, '4': 0.65 },
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProbabilityMappingsDto)
  probability_mappings?: ProbabilityMappingsDto;

  @ApiPropertyOptional({
    description:
      'Impact mappings for levels 1–4 (positive monetary values). ' +
      'E.g. {"1":961.54,"2":10576.92,"3":105769.23,"4":855769.23}',
    example: {
      '1': 961.54,
      '2': 10576.92,
      '3': 105769.23,
      '4': 855769.23,
    },
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ImpactMappingsDto)
  impact_mappings?: ImpactMappingsDto;

  @ApiPropertyOptional({
    description:
      'Green risk threshold (must be < threshold_orange). Default 1000.',
    example: 1000,
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  threshold_green?: number;

  @ApiPropertyOptional({
    description:
      'Orange risk threshold (must be > threshold_green). Default 10000.',
    example: 10000,
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  threshold_orange?: number;
}
