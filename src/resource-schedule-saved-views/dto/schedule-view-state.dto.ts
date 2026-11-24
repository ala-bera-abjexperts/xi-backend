/**
 * @fileoverview Nested `view_state` shape for a saved resource-schedule view.
 * @module src/resource-schedule-saved-views/dto/schedule-view-state.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { GRANULARITIES } from '../../resource-planning/schedule/dto/schedule-query.dto';

export class ScheduleViewStateDto {
  @ApiProperty({ type: [String], description: 'organization_unit ids' })
  @IsArray()
  @IsUUID(undefined, { each: true })
  unit_ids!: string[];

  @ApiProperty({ type: [String], description: 'user ids' })
  @IsArray()
  @IsUUID(undefined, { each: true })
  user_ids!: string[];

  @ApiProperty({ enum: GRANULARITIES })
  @IsIn(GRANULARITIES)
  granularity!: 'day' | 'week';

  @ApiPropertyOptional({ type: [String], description: 'role names' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  roles?: string[];
}
