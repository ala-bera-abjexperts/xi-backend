/**
 * @fileoverview DTO for bulk-reordering relation types.
 * @module src/relation-types/dto/reorder-relation-types.dto
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

export class ReorderRelationTypesDto {
  @ApiProperty({ type: [ReorderItemDto], minItems: 1, maxItems: 500 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  items!: ReorderItemDto[];
}
