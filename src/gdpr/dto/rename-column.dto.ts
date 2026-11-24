/**
 * @fileoverview DTO for renaming a GDPR spreadsheet column.
 * @module src/gdpr/dto/rename-column.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RenameColumnDto {
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
    description: 'Legacy column ID. Route param remains authoritative.',
  })
  @IsOptional()
  @IsString()
  column_id?: string;

  @ApiProperty({ description: 'New display label', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label?: string;

  @ApiPropertyOptional({
    description: 'Legacy new display label alias',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  new_label?: string;
}
