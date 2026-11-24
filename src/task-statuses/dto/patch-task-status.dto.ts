/**
 * @fileoverview DTO for PATCH actions on a task status.
 * @module src/task-statuses/dto/patch-task-status.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ReorderItemDto {
  @IsUUID()
  id!: string;

  @IsInt()
  @Min(0)
  sort_order!: number;
}

export class PatchTaskStatusDto {
  @ApiPropertyOptional({
    description:
      'Legacy frontend compatibility only; ignored in favor of the authenticated organization.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({
    enum: ['toggle_active', 'set_default', 'reorder', 'duplicate'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['toggle_active', 'set_default', 'reorder', 'duplicate'])
  action?: string;

  @ApiPropertyOptional({
    description:
      'Legacy PATCH compatibility: partial update when action is omitted.',
    example: 'In Review',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Legacy PATCH compatibility: immutable; accepted only when equal to the stored key when action is omitted.',
    example: 'in_review',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message:
      'key must start with a lowercase letter and contain only lowercase letters, digits, and underscores',
  })
  key?: string;

  @ApiPropertyOptional({
    description:
      'Legacy PATCH compatibility: partial update when action is omitted.',
    example: '#F59E0B',
  })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'color must be a valid hex color',
  })
  color?: string;

  @ApiPropertyOptional({
    description:
      'Legacy PATCH compatibility: partial update when action is omitted.',
    example: 'lucide:eye',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  icon?: string | null;

  @ApiPropertyOptional({
    description:
      'Legacy PATCH compatibility: partial update when action is omitted.',
    example: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional({
    description:
      'Legacy PATCH compatibility: partial update when action is omitted.',
  })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @ApiPropertyOptional({
    description:
      'Legacy PATCH compatibility: partial update when action is omitted.',
  })
  @IsOptional()
  @IsBoolean()
  is_completed?: boolean;

  @ApiPropertyOptional({ description: 'For toggle_active' })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({
    description:
      'Legacy PATCH compatibility: replace transition target IDs when action is omitted.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  allowed_transitions?: string[];

  @ApiPropertyOptional({ description: 'For duplicate' })
  @IsOptional()
  @IsString()
  new_name?: string;

  @ApiPropertyOptional({
    description:
      'Legacy PATCH compatibility: status category bucket when action is omitted. Explicit null is not allowed.',
  })
  @IsOptional()
  @IsUUID()
  category_id?: string;

  @ApiPropertyOptional({
    description: 'For reorder — array of { id, sort_order }',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  items?: ReorderItemDto[];
}
