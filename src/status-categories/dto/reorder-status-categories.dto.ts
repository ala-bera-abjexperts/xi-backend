/**
 * @fileoverview DTO for bulk-reordering status categories.
 * @module src/status-categories/dto/reorder-status-categories.dto
 * @author Rajbha Manek
 */
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReorderItemDto {
  @ApiProperty() @IsUUID() id!: string;
  @ApiProperty() @IsInt() @Min(0) sort_order!: number;
}

export class ReorderStatusCategoriesDto {
  @ApiProperty({ type: [ReorderItemDto], minItems: 1, maxItems: 500 })
  @IsArray()
  // H4/L1: Enforce at least 1 item (prevents silent no-op + null audit log) and cap at
  // 500 to prevent abuse via large payloads in the parallel Promise.all reorder path.
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  items!: ReorderItemDto[];
}
