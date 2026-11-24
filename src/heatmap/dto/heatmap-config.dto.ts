/**
 * @fileoverview DTOs for heatmap configuration create/update.
 * @module src/heatmap/dto/heatmap-config.dto
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
} from 'class-validator';

const FONT_SIZES = ['small', 'medium', 'large', 'xlarge'] as const;
const MATRIX_SIZES = [2, 3, 4, 5] as const;
const COLOR_SCHEMES = ['risk', 'blue', 'green', 'custom'] as const;
const COLORING_MODES = ['risk-level', 'individual-cells'] as const;

export class HeatmapConfigDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    description:
      'Accepted for legacy Next route compatibility; nested config payload.',
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  show_issue_count?: boolean;

  @ApiPropertyOptional({ enum: FONT_SIZES })
  @IsOptional()
  @IsIn(FONT_SIZES)
  cell_font_size?: (typeof FONT_SIZES)[number];

  @ApiPropertyOptional({ enum: MATRIX_SIZES })
  @IsOptional()
  @IsInt()
  @IsIn(MATRIX_SIZES)
  matrix_size?: (typeof MATRIX_SIZES)[number];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  status_filter?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  request_types?: string[];

  @ApiPropertyOptional({ enum: COLOR_SCHEMES })
  @IsOptional()
  @IsIn(COLOR_SCHEMES)
  color_scheme?: (typeof COLOR_SCHEMES)[number];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  custom_colors?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  use_custom_colors?: boolean;

  @ApiPropertyOptional({ enum: COLORING_MODES })
  @IsOptional()
  @IsIn(COLORING_MODES)
  coloring_mode?: (typeof COLORING_MODES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  individual_cell_colors?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  individual_cell_texts?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  individual_cell_foreground_colors?: Record<string, string>;
}
