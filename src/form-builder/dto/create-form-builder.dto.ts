import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

import {
  PUBLIC_SLUG_MESSAGE,
  PUBLIC_SLUG_REGEX,
} from '../public/public-form-safety.util';

export class CreateFormBuilderDto {
  @ApiProperty()
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(PUBLIC_SLUG_REGEX, { message: PUBLIC_SLUG_MESSAGE })
  public_slug?: string;
}
