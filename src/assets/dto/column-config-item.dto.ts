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
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ColumnValidationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  minLength?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  maxLength?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pattern?: string;
}

export class ColumnConfigItemDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  columnId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;

  @ApiPropertyOptional({ minimum: 50, maximum: 1000, default: 150 })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(1000)
  width?: number;

  @ApiPropertyOptional({
    enum: [
      'text',
      'number',
      'date',
      'datetime',
      'time',
      'dropdown',
      'checkbox',
      'email',
      'url',
      'user',
      'priority',
      'status',
      'multiselect',
    ],
    default: 'text',
  })
  @IsOptional()
  @IsIn([
    'text',
    'number',
    'date',
    'datetime',
    'time',
    'dropdown',
    'checkbox',
    'email',
    'url',
    'user',
    'priority',
    'status',
    'multiselect',
  ])
  cellType?: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  order!: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  resizable?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  reorderable?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dropdownOptions?: string[];

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  validation?: Record<string, unknown>;
}
