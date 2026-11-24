/**
 * @fileoverview DTO for bulk-updating widget layout positions.
 * @module src/dashboards/dto/update-layout.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';

class LayoutItemDto {
  @IsUUID()
  id!: string;

  @IsInt()
  x!: number;

  @IsInt()
  y!: number;

  @IsInt()
  w!: number;

  @IsInt()
  h!: number;
}

export class UpdateLayoutDto {
  @ApiProperty({
    type: [LayoutItemDto],
    description: 'Array of widget positions to update',
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LayoutItemDto)
  items?: LayoutItemDto[];

  @ApiProperty({
    type: [LayoutItemDto],
    description: 'Array of widget positions to update',
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LayoutItemDto)
  positions?: LayoutItemDto[];
}
