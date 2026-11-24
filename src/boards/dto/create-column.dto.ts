/**
 * @fileoverview DTO for creating a board column.
 * @module src/boards/dto/create-column.dto
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
  Min,
  MinLength,
} from 'class-validator';

export class CreateColumnDto {
  @ApiPropertyOptional({ description: 'Legacy board UUID echo (ignored)' })
  @IsOptional()
  @IsUUID()
  board_id?: string;

  @ApiPropertyOptional({
    description: 'Legacy organization UUID from Next clients (ignored)',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ example: 'In Progress' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional({ description: 'Minimum WIP' })
  @IsOptional()
  @IsInt()
  @Min(0)
  min_wip?: number;

  @ApiPropertyOptional({ description: 'Maximum WIP (0 = unlimited)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  max_wip?: number;

  @ApiPropertyOptional({ example: '#3B82F6' })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'color must be a valid hex color',
  })
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_backlog?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_kanban_backlog?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_done?: boolean;
}
