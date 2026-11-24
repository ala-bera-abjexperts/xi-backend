/**
 * @fileoverview DTO for creating a relation type.
 * @module src/relation-types/dto/create-relation-type.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
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

export class CreateRelationTypeDto {
  @ApiPropertyOptional({
    description:
      'Legacy compatibility field. Ignored; organization is derived from auth context.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ example: 'Blocks', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    example: 'blocks',
    description: 'Description shown for the outward direction',
    maxLength: 255,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  outward_description!: string;

  @ApiProperty({
    example: 'is blocked by',
    description: 'Description shown for the inward direction',
    maxLength: 255,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  inward_description!: string;

  @ApiPropertyOptional({ default: {} })
  @IsOptional()
  @IsObject()
  name_i18n?: Record<string, string>;

  @ApiPropertyOptional({ default: {} })
  @IsOptional()
  @IsObject()
  outward_description_i18n?: Record<string, string>;

  @ApiPropertyOptional({ default: {} })
  @IsOptional()
  @IsObject()
  inward_description_i18n?: Record<string, string>;

  @ApiPropertyOptional({ example: '#6B7280' })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'color must be a valid hex color',
  })
  color?: string | null;

  @ApiPropertyOptional({ example: 'lucide:link' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  is_directional?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}
