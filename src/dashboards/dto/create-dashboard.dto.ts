/**
 * @fileoverview DTO for creating a dashboard.
 * @module src/dashboards/dto/create-dashboard.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export class CreateDashboardDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ example: 'My Dashboard', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Space UUID — null for org-level dashboard',
  })
  @IsOptional()
  @IsUUID()
  space_id?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @ApiPropertyOptional({
    description: 'Grid layout config',
    example: { columns: 12, rowHeight: 100 },
  })
  @IsOptional()
  @IsObject()
  layout_config?: { columns?: number; rowHeight?: number };

  @ApiPropertyOptional({
    enum: ['draft', 'active', 'archived'],
    default: 'active',
  })
  @IsOptional()
  @IsIn(['draft', 'active', 'archived'])
  status?: string;

  @ApiPropertyOptional({
    enum: ['private', 'space', 'organization'],
    default: 'private',
  })
  @IsOptional()
  @IsIn(['private', 'space', 'organization'])
  visibility?: string;
}
