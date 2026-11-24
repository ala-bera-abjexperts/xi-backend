/**
 * @fileoverview Query DTO for GET /heatmap — generate heatmap data.
 * @module src/heatmap/dto/generate-heatmap-query.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class GenerateHeatmapQueryDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ description: 'Matrix size (2–5), default 5' })
  @IsOptional()
  @IsString()
  matrixSize?: string;

  @ApiPropertyOptional({
    description: '"false" to hide issue count, default true',
  })
  @IsOptional()
  @IsString()
  showIssueCount?: string;

  @ApiPropertyOptional({ description: 'Heatmap title' })
  @IsOptional()
  @IsString()
  title?: string;

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

  @ApiPropertyOptional({
    description: '"individual-cells" or "risk-level" (default)',
  })
  @IsOptional()
  @IsString()
  coloringMode?: string;

  @ApiPropertyOptional({
    description: 'Cell font size: small|medium|large|xlarge',
  })
  @IsOptional()
  @IsString()
  cellFontSize?: string;

  @ApiPropertyOptional({ description: 'Filter by space UUID' })
  @IsOptional()
  @IsUUID()
  spaceId?: string;
}
