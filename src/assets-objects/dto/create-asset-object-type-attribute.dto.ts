import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const ASSET_ATTRIBUTE_DATA_TYPES = [
  'text',
  'textarea',
  'select',
  'multiselect',
  'bool',
  'url',
  'email',
  'integer',
  'float',
  'date',
  'datetime',
  'user',
  'user_multi',
  'status',
  'object_reference',
  'formula',
  'tab_separator',
] as const;

export class CreateAssetObjectTypeAttributeDto {
  @ApiPropertyOptional({
    description:
      'Parent object type id — sourced from URL param, not required in body',
  })
  @IsOptional()
  @IsUUID('4')
  object_type_id?: string;

  @ApiProperty({ minLength: 1, maxLength: 150 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiProperty({
    description:
      'Stable machine key, 1–50 lowercase letters/digits/underscores',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z][a-z0-9_]{0,49}$/, {
    message:
      'field_key must start with a letter and contain only lowercase letters, digits, or underscores (max 50 chars)',
  })
  field_key!: string;

  @ApiProperty({ enum: ASSET_ATTRIBUTE_DATA_TYPES })
  @IsIn(ASSET_ATTRIBUTE_DATA_TYPES)
  data_type!: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  validation_rules?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Target type id for object_reference attributes',
  })
  @IsOptional()
  @IsUUID('4')
  reference_object_type_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  reference_type_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  include_child_object_types?: boolean;

  @ApiPropertyOptional({ description: '-1 = unlimited' })
  @IsOptional()
  @IsInt()
  @Min(-1)
  min_cardinality?: number;

  @ApiPropertyOptional({ description: '-1 = unlimited' })
  @IsOptional()
  @IsInt()
  @Min(-1)
  max_cardinality?: number;

  @ApiPropertyOptional()
  @IsOptional()
  default_value?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_unique?: boolean;

  @ApiPropertyOptional({
    description: 'Whether this attribute is the display label',
  })
  @IsOptional()
  @IsBoolean()
  is_label?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_hidden?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sort_order?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  field_group_ids?: string[];
}
