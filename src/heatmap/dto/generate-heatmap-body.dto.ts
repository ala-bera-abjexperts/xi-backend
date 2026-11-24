/**
 * @fileoverview Body DTO for POST /heatmap — generate heatmap data with full config.
 * @module src/heatmap/dto/generate-heatmap-body.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Max,
  Min,
} from 'class-validator';

export class GenerateHeatmapBodyDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    description:
      'Accepted for legacy Next route compatibility; full config object.',
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Matrix size (2–5)',
    minimum: 2,
    maximum: 5,
  })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(5)
  matrixSize?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showIssueCount?: boolean;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  requestTypes?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  status?: string[];

  @ApiPropertyOptional({ enum: ['risk-level', 'individual-cells'] })
  @IsOptional()
  @IsIn(['risk-level', 'individual-cells'])
  coloringMode?: 'risk-level' | 'individual-cells';

  @ApiPropertyOptional({ enum: ['small', 'medium', 'large', 'xlarge'] })
  @IsOptional()
  @IsIn(['small', 'medium', 'large', 'xlarge'])
  cellFontSize?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  useCustomColors?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  customColors?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  individualCellColors?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  individualCellTexts?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  individualCellForegroundColors?: Record<string, string>;
}
