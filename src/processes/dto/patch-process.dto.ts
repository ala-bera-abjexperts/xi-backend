/**
 * @fileoverview DTO for PATCH actions on a process.
 * @module src/processes/dto/patch-process.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProcessReorderItemDto {
  @IsUUID()
  id!: string;

  @IsInt()
  @Min(0)
  sort_order!: number;
}

export class PatchProcessDto {
  @ApiProperty({ enum: ['reorder', 'partial_update'] })
  @IsString()
  @IsIn(['reorder', 'partial_update'])
  action!: string;

  @ApiPropertyOptional({ type: [ProcessReorderItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProcessReorderItemDto)
  items?: ProcessReorderItemDto[];
}
