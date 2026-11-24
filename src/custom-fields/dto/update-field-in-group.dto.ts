/**
 * @fileoverview DTO for updating a field's settings within a group.
 * @module src/custom-fields/dto/update-field-in-group.dto
 * @author Prince Jadiya
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/** Payload for updating a field's per-group settings. */
export class UpdateFieldInGroupDto {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sort_order?: number;
}
