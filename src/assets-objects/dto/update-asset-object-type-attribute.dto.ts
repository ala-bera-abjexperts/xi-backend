import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateAssetObjectTypeAttributeDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 150 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  // field_key is intentionally EXCLUDED — immutable after creation

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  validation_rules?: Record<string, unknown>;

  @ApiPropertyOptional()
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(-1)
  min_cardinality?: number;

  @ApiPropertyOptional()
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

  @ApiPropertyOptional()
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
