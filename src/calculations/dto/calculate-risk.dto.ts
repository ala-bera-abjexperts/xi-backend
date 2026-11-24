/**
 * @fileoverview DTO for triggering a risk calculation for a business process.
 * @module src/calculations/dto/calculate-risk.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class CalculateRiskDto {
  @ApiProperty({ description: 'Business process UUID to calculate' })
  @IsUUID()
  process_id!: string;

  @ApiPropertyOptional({
    description:
      'Whether to cascade calculation to parent processes (default true)',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  cascade_to_parents?: boolean;
}
