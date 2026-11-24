/**
 * @fileoverview DTO for updating a dashboard widget (all fields optional).
 * @module src/dashboards/dto/update-widget.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
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

class WidgetPositionDto {
  @IsOptional()
  @IsInt()
  x?: number;

  @IsOptional()
  @IsInt()
  y?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  w?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  h?: number;

  @IsOptional()
  @IsInt()
  minW?: number;

  @IsOptional()
  @IsInt()
  minH?: number;
}

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

export class UpdateWidgetDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ enum: WIDGET_TYPES })
  @IsOptional()
  @IsIn(WIDGET_TYPES)
  widget_type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => WidgetPositionDto)
  position?: WidgetPositionDto;

  @ApiPropertyOptional()
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  auto_refresh?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(30)
  refresh_interval?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}
