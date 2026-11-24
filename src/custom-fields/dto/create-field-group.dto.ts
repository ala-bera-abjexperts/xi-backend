/**
 * @fileoverview DTO for creating a field group.
 * @module src/custom-fields/dto/create-field-group.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Payload for `POST /field-groups`. */
export class CreateFieldGroupDto {
  @ApiPropertyOptional({ description: 'Ignored — org comes from auth token' })
  @IsOptional()
  @IsString()
  organizationId?: string;

  @ApiProperty({ example: 'General Information' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  name_i18n?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  description_i18n?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sort_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_collapsed_default?: boolean;

  @ApiPropertyOptional({ example: '#3b82f6' })
  @IsOptional()
  @IsString()
  color?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icon?: string | null;

  @ApiPropertyOptional({
    description: 'Optional space id; when omitted, the group is org-level.',
  })
  @IsOptional()
  @IsString()
  space_id?: string | null;
}
