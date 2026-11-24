/**
 * @fileoverview DTO for adding a column to the GDPR spreadsheet.
 * Field names match risk-management-app's IColumnConfig exactly.
 * @module src/gdpr/dto/add-column.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const CELL_TYPES = [
  'text',
  'number',
  'date',
  'dropdown',
  'checkbox',
  'email',
  'url',
  'user',
  'priority',
  'status',
] as const;

export class ValidationRulesDto {
  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  minLength?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxLength?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pattern?: string;
}

export class GdprColumnConfigDto {
  @ApiProperty({ description: 'Unique column identifier', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  columnId?: string;

  @ApiProperty({ description: 'Display label for the column', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label?: string;

  @ApiProperty({ enum: CELL_TYPES })
  @IsOptional()
  @IsIn(CELL_TYPES)
  cellType?: string;

  @ApiProperty({ description: 'Display order (0-based)', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @ApiPropertyOptional({ minimum: 50, maximum: 1000, default: 150 })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(1000)
  width?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  resizable?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  reorderable?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'Options for dropdown cellType',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dropdownOptions?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => ValidationRulesDto)
  validation?: ValidationRulesDto;
}

export class AddColumnDto extends GdprColumnConfigDto {
  @ApiPropertyOptional({
    description:
      'Compatibility organization ID. Ignored; auth context is trusted.',
  })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiPropertyOptional({
    description: 'Legacy spreadsheet UUID. Accepted for compatibility.',
  })
  @IsOptional()
  @IsString()
  spreadsheet_id?: string;

  @ApiPropertyOptional({
    description: 'Legacy nested column config sent by the Next.js API client',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => GdprColumnConfigDto)
  column?: GdprColumnConfigDto;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Insert position in column list; defaults to end',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}
