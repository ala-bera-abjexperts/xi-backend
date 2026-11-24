/**
 * @fileoverview DTO for updating a board.
 * @module src/boards/dto/update-board.dto
 * @author Prince Jadiya
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { BOARD_TYPES } from './create-board.dto';

export class UpdateBoardDto {
  @ApiPropertyOptional({ description: 'Legacy ID echo from Next clients' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiPropertyOptional({
    description: 'Legacy organization UUID from Next clients (ignored)',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Legacy board type field emitted by board settings forms',
    enum: BOARD_TYPES,
  })
  @IsOptional()
  @IsString()
  @IsIn(BOARD_TYPES as unknown as string[])
  board_type?: (typeof BOARD_TYPES)[number];

  @ApiPropertyOptional({
    description:
      'Legacy default swimlane field emitted by board settings forms',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  default_swimlane_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_archived?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional({ description: 'Saved filter UUID' })
  @IsOptional()
  @IsUUID()
  filter_id?: string | null;
}
