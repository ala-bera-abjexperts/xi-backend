/**
 * @fileoverview DTO for updating a list item — aligned with asset_items table.
 * @module src/lists/dto/update-list-item.dto
 * @author Prince Jadiya
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateListItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Structured field values keyed by column ID',
  })
  @IsOptional()
  @IsObject()
  fields_data?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Custom field values keyed by field ID' })
  @IsOptional()
  @IsObject()
  custom_field_values?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Sort position within schema' })
  @IsOptional()
  @IsInt()
  @Min(0)
  row_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_archived?: boolean;

  @ApiPropertyOptional({
    description: 'Current version for optimistic locking',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
