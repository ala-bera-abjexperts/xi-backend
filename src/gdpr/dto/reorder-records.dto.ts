/**
 * @fileoverview DTO for reordering GDPR records.
 * @module src/gdpr/dto/reorder-records.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class RecordOrderItemDto {
  @ApiProperty()
  @IsUUID()
  record_id!: string;

  @ApiProperty({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  row_order?: number;

  @ApiProperty({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  new_order?: number;
}

export class ReorderRecordsDto {
  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @IsString()
  spreadsheetId?: string;

  @IsOptional()
  @IsString()
  spreadsheet_id?: string;

  @ApiProperty({ type: [RecordOrderItemDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => RecordOrderItemDto)
  updates!: RecordOrderItemDto[];
}
