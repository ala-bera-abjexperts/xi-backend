/**
 * @fileoverview DTO for updating a relation type.
 * @module src/relation-types/dto/update-relation-type.dto
 * @author Prince Jadiya
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateRelationTypeDto {
  @ApiPropertyOptional({ example: 'Blocks' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  outward_description?: string;

  @ApiPropertyOptional()
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}
