/**
 * @fileoverview DTO for PATCH actions on a relation type.
 * @module src/relation-types/dto/patch-relation-type.dto
 * @author Prince Jadiya
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
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class PatchRelationTypeDto {
  @ApiProperty({ enum: ['toggle_active', 'duplicate'] })
  @IsOptional()
  @IsString()
  @IsIn(['toggle_active', 'duplicate'])
  action?: string;

  @ApiPropertyOptional({
    description:
      'Legacy PATCH compatibility: partial update when action is omitted.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Legacy PATCH compatibility: partial update when action is omitted.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  outward_description?: string;

  @ApiPropertyOptional({
    description:
      'Legacy PATCH compatibility: partial update when action is omitted.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  inward_description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  name_i18n?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  outward_description_i18n?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  inward_description_i18n?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'color must be a valid hex color',
  })
  color?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_directional?: boolean;

  @ApiPropertyOptional({ description: 'For toggle_active' })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional({
    description:
      'Legacy compatibility field. Ignored; organization is derived from auth context.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ description: 'New name for duplicate action' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  newName?: string;
}
