import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateSpaceTypeDto {
  @ApiProperty({ description: 'Space type name', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ description: 'Description', maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  @ApiPropertyOptional({ description: 'Icon identifier', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  icon?: string | null;

  @ApiPropertyOptional({ description: 'Hex color e.g. #6B7280' })
  @IsOptional()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'color must be a 6-digit hex color (e.g. #6B7280)',
  })
  color?: string;

  @ApiPropertyOptional({ description: 'Sort order', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}
