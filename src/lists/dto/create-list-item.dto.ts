/**
 * @fileoverview DTO for creating a list item — aligned with asset_items table.
 * @module src/lists/dto/create-list-item.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateListItemDto {
  @ApiProperty({ description: 'List schema UUID (asset_schemas.id)' })
  @IsUUID()
  schema_id!: string;

  @ApiPropertyOptional({
    description: 'Space UUID — inferred from schema if omitted',
  })
  @IsOptional()
  @IsUUID()
  space_id?: string;

  @ApiProperty({ example: 'Row title', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  title!: string;

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

  @ApiPropertyOptional({
    description: 'Sort position — auto-assigned if omitted',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  row_order?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_archived?: boolean;

  @ApiPropertyOptional({ description: 'Initial version (defaults to 1)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
