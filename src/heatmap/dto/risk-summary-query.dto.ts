/**
 * @fileoverview Query DTO for GET /heatmap/risk-summary.
 * @module src/heatmap/dto/risk-summary-query.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class RiskSummaryQueryDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ description: 'Comma-separated request types' })
  @IsOptional()
  @IsString()
  requestTypes?: string;

  @ApiPropertyOptional({
    description: 'Comma-separated status values, default "active"',
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by space UUID' })
  @IsOptional()
  @IsUUID()
  spaceId?: string;
}
