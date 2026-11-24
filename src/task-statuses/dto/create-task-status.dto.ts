/**
 * @fileoverview DTO for creating a task status.
 * @module src/task-statuses/dto/create-task-status.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
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

export class CreateTaskStatusDto {
  @ApiPropertyOptional({
    description:
      'Legacy frontend compatibility only; ignored in favor of the authenticated organization.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ example: 'In Review', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    example: 'in_review',
    description:
      'Unique key (lowercase, underscores). Immutable after creation.',
    maxLength: 50,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message:
      'key must start with a lowercase letter and contain only lowercase letters, digits, and underscores',
  })
  key!: string;

  @ApiProperty({ example: '#F59E0B', description: 'Hex color (#RRGGBB)' })
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'color must be a valid hex color (e.g. #F59E0B)',
  })
  color!: string;

  @ApiPropertyOptional({ example: 'lucide:eye' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  icon?: string | null;

  @ApiPropertyOptional({ description: 'Space ID (null = org-level)' })
  @IsOptional()
  @IsUUID()
  space_id?: string | null;

  @ApiPropertyOptional({
    description:
      'Status category (To Do / In Progress / Done bucket). If omitted, the DB trigger auto-links by is_completed. Explicit null is not allowed — omit the field instead.',
  })
  @IsOptional()
  @IsUUID()
  category_id?: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'Marks terminal/completed states (e.g. Done, Closed)',
  })
  @IsOptional()
  @IsBoolean()
  is_completed?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({
    description: 'IDs of statuses this status can transition to',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  allowed_transitions?: string[];
}
