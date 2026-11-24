/**
 * @fileoverview DTO for fully updating a dashboard (all fields optional).
 * @module src/dashboards/dto/update-dashboard.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateDashboardDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  space_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  layout_config?: { columns?: number; rowHeight?: number };

  @ApiPropertyOptional({ enum: ['draft', 'active', 'archived'] })
  @IsOptional()
  @IsIn(['draft', 'active', 'archived'])
  status?: string;

  @ApiPropertyOptional({ enum: ['private', 'space', 'organization'] })
  @IsOptional()
  @IsIn(['private', 'space', 'organization'])
  visibility?: string;
}
