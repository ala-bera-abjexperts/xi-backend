/**
 * @fileoverview DTO for creating a resolution.
 * @module src/resolutions/dto/create-resolution.dto
 * @author Rajbha Manek
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateResolutionDto {
  @ApiProperty({ example: 'Fixed', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'fixed', maxLength: 50 })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^[a-z][a-z0-9_]*$/, {
    message:
      'key must start with a lowercase letter and contain only lowercase letters, digits, and underscores',
  })
  key!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  // H1: is_default intentionally excluded — always inserts as false.
  // Use PATCH /resolutions/:id/set-default to promote a resolution.

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
