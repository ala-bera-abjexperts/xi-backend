import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export type FormFieldType =
  | 'text'
  | 'email'
  | 'phone'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'number'
  | 'date'
  | 'url';

const FIELD_TYPES: FormFieldType[] = [
  'text',
  'email',
  'phone',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'number',
  'date',
  'url',
];

class FieldOptionDto {
  @IsString()
  label!: string;

  @IsString()
  value!: string;
}

class ValidationRulesDto {
  @IsOptional()
  min?: number;

  @IsOptional()
  max?: number;

  @IsOptional()
  @IsString()
  pattern?: string;

  @IsOptional()
  @IsString()
  custom_message?: string;
}

class FormFieldItemDto {
  @IsString()
  @MinLength(1)
  element_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  field_name!: string;

  @IsEnum(FIELD_TYPES)
  field_type!: FormFieldType;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  placeholder?: string | null;

  @IsBoolean()
  required!: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FieldOptionDto)
  options!: FieldOptionDto[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ValidationRulesDto)
  validation_rules?: ValidationRulesDto | null;

  @IsInt()
  @Min(0)
  sort_order!: number;
}

export class SaveFormFieldsDto {
  @ApiProperty({ type: [FormFieldItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormFieldItemDto)
  fields!: FormFieldItemDto[];
}
