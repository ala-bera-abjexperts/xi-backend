/**
 * @fileoverview DTO for creating a board.
 * @module src/boards/dto/create-board.dto
 * @author Prince Jadiya
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

export const BOARD_TYPES = ['kanban', 'scrum'] as const;

export class CreateBoardDto {
  @ApiPropertyOptional({
    description: 'Legacy organization UUID from Next clients (ignored)',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ description: 'Space this board belongs to' })
  @IsUUID()
  space_id!: string;

  @ApiProperty({ example: 'Engineering Kanban', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiProperty({ enum: BOARD_TYPES })
  @IsOptional()
  @IsString()
  @IsIn(BOARD_TYPES as unknown as string[])
  board_type?: (typeof BOARD_TYPES)[number];

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Saved filter UUID' })
  @IsOptional()
  @IsUUID()
  filter_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @ApiPropertyOptional({
    default: false,
    description: 'Auto-create default columns from task-statuses',
  })
  @IsOptional()
  @IsBoolean()
  auto_create_columns?: boolean;

  @ApiPropertyOptional({ default: 'Everything else' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  default_swimlane_name?: string;
}
