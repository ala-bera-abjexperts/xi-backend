import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreatePageDto {
  @ApiProperty({ description: 'Page name', minLength: 1, maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({
    description:
      "URL path segment. Empty string for the landing page. Use 'about' or 'pricing/monthly' for sub-pages.",
    default: '',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/^$|^[a-z0-9]([a-z0-9/-]*[a-z0-9])?$/, {
    message:
      'path_name must be lowercase alphanumeric with hyphens or slashes, or empty string',
  })
  path_name?: string;
}
