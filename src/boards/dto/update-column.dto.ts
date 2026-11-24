/**
 * @fileoverview DTO for updating a board column.
 * @module src/boards/dto/update-column.dto
 * @author Prince Jadiya
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
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

export class UpdateColumnDto {
  @ApiPropertyOptional({ description: 'Legacy column ID echo from clients' })
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
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  min_wip?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  max_wip?: number;

  @ApiPropertyOptional()
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
