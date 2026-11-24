/**
 * @fileoverview DTO for PATCH actions on a task priority.
 * @module src/task-priorities/dto/patch-task-priority.dto
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

export class PatchTaskPriorityDto {
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
    example: 'Critical',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Legacy PATCH compatibility: partial update when action is omitted.',
    example: '#EF4444',
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
    example: 'lucide:chevrons-up',
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

  @ApiPropertyOptional({ description: 'For toggle_active' })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ description: 'For duplicate' })
  @IsOptional()
  @IsString()
  new_name?: string;

  @ApiPropertyOptional({
    description: 'For reorder — array of { id, sort_order }',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  items?: ReorderItemDto[];
}
