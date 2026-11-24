/**
 * @fileoverview DTO for updating a resolution.
 * @module src/resolutions/dto/update-resolution.dto
 * @author Rajbha Manek
 */
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateResolutionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) sort_order?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() is_active?: boolean;
}
