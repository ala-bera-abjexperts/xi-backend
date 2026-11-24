/**
 * @fileoverview DTO for creating a task priority.
 * @module src/task-priorities/dto/create-task-priority.dto
 * @author Prince Jadiya
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

export class CreateTaskPriorityDto {
  @ApiPropertyOptional({
    description:
      'Legacy frontend compatibility only; ignored in favor of the authenticated organization.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ example: 'Critical', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    example: 'critical',
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

  @ApiProperty({ example: '#EF4444', description: 'Hex color (#RRGGBB)' })
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'color must be a valid hex color (e.g. #EF4444)',
  })
  color!: string;

  @ApiPropertyOptional({ example: 'lucide:chevrons-up' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  icon?: string | null;

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
  is_default?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
