/**
 * @fileoverview DTO for updating a custom field. `field_key` and `field_type`
 * are immutable and the service will reject attempts to change them.
 * @module src/custom-fields/dto/update-custom-field.dto
 * @author Prince Jadiya
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  FIELD_TYPES,
  GRID_COLUMN_TYPES,
  GRID_MAX_COLUMN_WIDTH,
  GRID_MIN_COLUMN_WIDTH,
} from '../models/custom-field.model';
import type { FieldType, GridColumnType } from '../models/custom-field.model';

/** One choice offered by a `grid` column whose `column_type` is `select`. */
export class GridChoiceDto {
  @IsString()
  @MinLength(1)
  value: string;

  @IsString()
  @MinLength(1)
  label: string;
}

/**
 * Validated shape of a single field option
 * (select / multiselect / radio / cascading_select / grid).
 */
export class FieldOptionDto {
  @IsString()
  @MinLength(1)
  value: string;

  @IsString()
  @MinLength(1)
  label: string;

  /**
   * Permissive on purpose: options created before this DTO existed were never
   * validated, so stored colors include '', '#fff' and CSS names. Requiring
   * strict #RRGGBB made every such field permanently uneditable — the dialog
   * could not even round-trip its own data. Still constrained enough to be safe
   * in a style attribute (no separators, parens or quotes).
   */
  @IsOptional()
  @IsString()
  @Matches(
    /^$|^#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$|^[a-zA-Z]{1,30}$/,
    {
      message: 'color must be a hex color (#RGB, #RRGGBB) or a CSS color name',
    },
  )
  color?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsString()
  parent_value?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  level?: number;

  // --- `issue_group` only ----------------------------------------------------
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsOptional()
  @IsUUID()
  lead_user_id?: string | null;

  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';

  @IsOptional()
  @IsUUID()
  created_by?: string | null;

  // --- `grid` only -----------------------------------------------------------
  // A grid column IS an option (value = column key, label = header) plus a cell
  // editor, so grid columns reuse the `options` column. These keys existed on
  // the `FieldOption` interface but not on this DTO — and since `main.ts` sets
  // `forbidNonWhitelisted: true` (which propagates into `@ValidateNested`
  // children), every grid save failed with
  // `options.0.property column_type should not exist`.

  @IsOptional()
  @IsIn(GRID_COLUMN_TYPES)
  column_type?: GridColumnType;

  @IsOptional()
  @IsInt()
  @Min(GRID_MIN_COLUMN_WIDTH)
  @Max(GRID_MAX_COLUMN_WIDTH)
  width?: number;

  /** Only meaningful when `column_type === 'select'`. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GridChoiceDto)
  choices?: GridChoiceDto[];
}

/** Payload for `PUT /custom-fields/:id`. */
export class UpdateCustomFieldDto {
  /** Accepted from body to avoid 400 when client includes it — value is ignored, URL param is used */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  id?: string;

  /** Accepted from body but immutable — service rejects changes to field_type after creation */
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(FIELD_TYPES)
  field_type?: FieldType;

  /** Accepted from body but immutable — service rejects changes to field_key after creation */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  field_key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((o: UpdateCustomFieldDto) => o.description !== null)
  @IsString()
  @MaxLength(1000)
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

  @ApiPropertyOptional({ type: [FieldOptionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FieldOptionDto)
  options?: FieldOptionDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  validation_rules?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contexts?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}
