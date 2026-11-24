/**
 * @fileoverview DTO for reordering fields within a field group.
 * @module src/custom-fields/dto/reorder-fields.dto
 * @author Prince Jadiya
 */

import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsString,
  ValidateNested,
} from 'class-validator';

/** One entry in a reorder payload. */
export class ReorderFieldEntry {
  @ApiProperty()
  @IsString()
  custom_field_id!: string;

  @ApiProperty()
  @IsInt()
  sort_order!: number;
}

/** Payload for PUT /field-groups/:id/fields when reordering. */
export class ReorderFieldsDto {
  @ApiProperty({ default: true })
  @IsBoolean()
  reorder!: boolean;

  @ApiProperty({ type: [ReorderFieldEntry] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReorderFieldEntry)
  fields!: ReorderFieldEntry[];
}
