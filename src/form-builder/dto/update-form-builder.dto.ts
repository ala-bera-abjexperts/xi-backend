import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import {
  PUBLIC_SLUG_MESSAGE,
  PUBLIC_SLUG_REGEX,
} from '../public/public-form-safety.util';

export class UpdateFormBuilderDto {
  @ApiProperty({ description: 'Current version for optimistic locking' })
  @IsInt()
  @Min(1)
  version: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icon?: string | null;

  @ApiPropertyOptional({ enum: ['draft', 'published', 'disabled', 'archived'] })
  @IsOptional()
  @IsString()
  status?: 'draft' | 'published' | 'disabled' | 'archived';

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(PUBLIC_SLUG_REGEX, { message: PUBLIC_SLUG_MESSAGE })
  public_slug?: string | null;
}
