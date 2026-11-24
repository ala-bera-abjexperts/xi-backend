/**
 * @fileoverview DTO for bulk reorder operations (wiki pages and labels).
 * @module src/wiki/dto/reorder-items.dto
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

class ReorderItemDto {
  @IsUUID()
  id!: string;

  @IsInt()
  @Min(0)
  sort_order!: number;
}

export class ReorderItemsDto {
  @ApiProperty({
    type: [ReorderItemDto],
    description: 'Array of {id, sort_order} pairs',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  updates!: ReorderItemDto[];
}
