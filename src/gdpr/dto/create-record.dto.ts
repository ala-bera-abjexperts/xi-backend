/**
 * @fileoverview DTO for creating a GDPR record.
 * @module src/gdpr/dto/create-record.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsUUID, Min } from 'class-validator';

export class CreateRecordDto {
  @ApiPropertyOptional({
    description:
      'Compatibility organization ID. Ignored; auth context is trusted.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    description: 'Legacy spreadsheet UUID. Accepted for compatibility.',
  })
  @IsOptional()
  @IsUUID()
  spreadsheetId?: string;

  @ApiPropertyOptional({
    description:
      'Legacy snake_case spreadsheet UUID. Accepted for compatibility.',
  })
  @IsOptional()
  @IsUUID()
  spreadsheet_id?: string;

  @ApiPropertyOptional({ description: 'Cell data as key-value pairs' })
  @IsOptional()
  @IsObject()
  cell_data?: Record<string, unknown>;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  row_order?: number;

  @ApiPropertyOptional({ description: 'Assigned user UUID' })
  @IsOptional()
  @IsUUID()
  assignee_id?: string;
}
