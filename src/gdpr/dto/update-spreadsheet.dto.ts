/**
 * @fileoverview DTO for updating GDPR spreadsheet metadata.
 * Matches risk-management-app updateSpreadsheetSchema.
 * @module src/gdpr/dto/update-spreadsheet.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateSpreadsheetDto {
  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Full column configuration array (IColumnConfig[])',
  })
  @IsOptional()
  @IsArray()
  column_config?: unknown[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  sticky_columns?: Record<string, unknown>;

  @ApiPropertyOptional({ minimum: 24, maximum: 100, default: 32 })
  @IsOptional()
  @IsInt()
  @Min(24)
  @Max(100)
  default_row_height?: number;
}
