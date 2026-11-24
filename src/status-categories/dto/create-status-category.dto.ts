/**
 * @fileoverview DTO for creating a status category.
 * @module src/status-categories/dto/create-status-category.dto
 * @author Rajbha Manek
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateStatusCategoryDto {
  @ApiProperty({ example: 'In Review', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'in_review', maxLength: 50 })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message:
      'key must start with a lowercase letter and contain only lowercase letters, digits, and underscores',
  })
  key!: string;

  @ApiProperty({ example: '#3B82F6' })
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'color must be a valid hex color (e.g. #3B82F6)',
  })
  color!: string;

  @ApiPropertyOptional({ example: '#FFFFFF' })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'text_color must be a valid hex color',
  })
  text_color?: string;

  @ApiPropertyOptional({ description: 'Space ID (null = org-level)' })
  @IsOptional()
  @IsUUID()
  space_id?: string | null;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_done_like?: boolean;
}
