/**
 * @fileoverview DTO for adding multiple custom fields to a field group
 * atomically.
 * @module src/custom-fields/dto/add-fields-batch.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { AddFieldToGroupDto } from './add-field-to-group.dto';

/** Payload for batch add — POST /field-groups/:id/fields with `fields`. */
export class AddFieldsBatchDto {
  @ApiProperty({ type: [AddFieldToGroupDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AddFieldToGroupDto)
  fields!: AddFieldToGroupDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_hidden?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  column_span?: number;
}
