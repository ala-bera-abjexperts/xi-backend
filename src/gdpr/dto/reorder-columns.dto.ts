/**
 * @fileoverview DTO for reordering GDPR spreadsheet columns.
 * Matches risk-management-app reorderColumnsSchema field names.
 * @module src/gdpr/dto/reorder-columns.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class ColumnOrderItemDto {
  @ApiProperty()
  @IsString()
  column_id!: string;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  new_order!: number;
}

export class ReorderColumnsDto {
  @IsOptional()
  @IsString()
  organizationId?: string;

  @IsOptional()
  @IsString()
  spreadsheet_id?: string;

  @ApiProperty({ type: [ColumnOrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ColumnOrderItemDto)
  column_orders!: ColumnOrderItemDto[];
}
