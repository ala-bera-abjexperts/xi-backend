/**
 * @fileoverview DTO for creating a dashboard widget.
 * @module src/dashboards/dto/create-widget.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const WIDGET_TYPES = [
  'heatmap',
  'list',
  'flow',
  'chart',
  'stats',
  'calendar',
  'recent_activity',
  'custom',
  'table',
  'html_text',
  'text',
  'process',
  'countdown',
  'filter',
  'time_tracking_personal',
  'time_tracking_team',
  'resource_planning',
  'automation_run_analytics',
  'space_storage_usage',
  'file_explorer_list',
  'asset_list',
  'asset_chart',
  'git_development',
  'velocity_chart',
] as const;

const DATA_SOURCE_TYPES = ['process', 'task', 'list', 'filter'] as const;

class WidgetPositionDto {
  @IsInt()
  x!: number;

  @IsInt()
  y!: number;

  @IsInt()
  @Min(1)
  w!: number;

  @IsInt()
  @Min(1)
  h!: number;

  @IsOptional()
  @IsInt()
  minW?: number;

  @IsOptional()
  @IsInt()
  minH?: number;
}

export class CreateWidgetDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ enum: WIDGET_TYPES })
  @IsIn(WIDGET_TYPES)
  widget_type!: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ description: 'Grid position {x, y, w, h, minW?, minH?}' })
  @ValidateNested()
  @Type(() => WidgetPositionDto)
  position!: WidgetPositionDto;

  @ApiPropertyOptional({ description: 'Widget-specific config JSONB' })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: DATA_SOURCE_TYPES })
  @IsOptional()
  @IsIn(DATA_SOURCE_TYPES)
  data_source_type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  data_source_id?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  auto_refresh?: boolean;

  @ApiPropertyOptional({
    description: 'Refresh interval in seconds',
    default: 300,
  })
  @IsOptional()
  @IsInt()
  @Min(30)
  refresh_interval?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}
