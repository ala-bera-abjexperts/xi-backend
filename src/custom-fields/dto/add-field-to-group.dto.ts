/**
 * @fileoverview DTO for adding a single custom field to a field group.
 * @module src/custom-fields/dto/add-field-to-group.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Payload for `POST /field-groups/:id/fields`. */
export class AddFieldToGroupDto {
  @ApiProperty()
  @IsString()
  custom_field_id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sort_order?: number;

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

  @ApiPropertyOptional()
  @IsOptional()
  default_value_override?: unknown;
}
