import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

class FormBuilderFieldDto {
  @IsString()
  @MaxLength(64)
  field_key: string;

  @IsString()
  @MaxLength(40)
  field_type: string;

  @IsString()
  label: string;

  @IsOptional()
  @IsString()
  placeholder?: string;

  @IsOptional()
  @IsString()
  help_text?: string;

  @IsOptional()
  required?: boolean;

  // Polymorphic per field_type: choice/product fields store an array of items, while a
  // matrix stores an object { rows, columns }. Free-form like default_value — the per-type
  // shape is enforced at submit time (validateValue), not by class-validator here.
  @IsOptional()
  @Allow()
  options?: unknown;

  @IsOptional()
  @IsObject()
  validation_rules?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  page_index?: number;

  @IsOptional()
  @IsString()
  section?: string;

  @IsOptional()
  @IsInt()
  column_span?: number;

  @IsInt()
  @Min(0)
  sort_order: number;

  @IsOptional()
  is_hidden?: boolean;

  @IsOptional()
  read_only?: boolean;

  // Phase 4 — conditional logic ({ action, ruleGroup }); deep-validated by the
  // save-time logic guard in the service, not by class-validator.
  @IsOptional()
  @IsObject()
  conditional_logic?: Record<string, unknown>;

  // Phase 4 — calculation ({ expression, format? }); expression is compiled +
  // ref/cycle-checked by the save-time logic guard in the service.
  @IsOptional()
  @IsObject()
  calculation?: Record<string, unknown>;

  // Prefill/default value — free-form (string | number | boolean | array | object).
  @IsOptional()
  @Allow()
  default_value?: unknown;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  label_i18n?: Record<string, unknown>;
}

export class ReplaceFormBuilderFieldsDto {
  @ApiProperty({ description: 'Current form version for optimistic locking' })
  @IsInt()
  @Min(1)
  version: number;

  @ApiProperty({ type: [FormBuilderFieldDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormBuilderFieldDto)
  fields: FormBuilderFieldDto[];
}
