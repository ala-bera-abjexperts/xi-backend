/**
 * @fileoverview DTO for creating a custom field.
 * @module src/custom-fields/dto/create-custom-field.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { FIELD_TYPES } from '../models/custom-field.model';
import type { FieldType } from '../models/custom-field.model';

/** Payload for `POST /custom-fields`. */
export class CreateCustomFieldDto {
  // 255 to match both the DB column and UpdateCustomFieldDto — a lower cap here
  // meant a name that edits fine could not be created in the first place.
  @ApiProperty({ example: 'Priority' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({
    example: 'priority',
    description:
      'Unique field key within the organization. Auto-generated if omitted.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/)
  field_key?: string;

  @ApiProperty({ enum: [...FIELD_TYPES] })
  @IsIn(FIELD_TYPES)
  field_type!: FieldType;

  @ApiPropertyOptional({ enum: ['organization', 'space'] })
  @IsOptional()
  @IsIn(['organization', 'space'])
  scope?: 'organization' | 'space';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  space_id?: string | null;

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
  default_value?: unknown;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  options?: unknown[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  validation_rules?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  contexts?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sort_order?: number;

  /** Accepted from body but ignored — organization comes from the auth token */
  @ApiPropertyOptional({ description: 'Ignored — org comes from auth token' })
  @IsOptional()
  @IsString()
  organizationId?: string;
}
