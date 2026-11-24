import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdatePageDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description: 'URL path segment (cannot change landing page path)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(/^$|^[a-z0-9]([a-z0-9/-]*[a-z0-9])?$/, {
    message:
      'path_name must be lowercase alphanumeric with hyphens or slashes, or empty string',
  })
  path_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  published?: boolean;

  @ApiPropertyOptional({ nullable: true, maxLength: 70 })
  @IsOptional()
  @IsString()
  @MaxLength(70)
  seo_title?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  seo_description?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUrl({}, { message: 'seo_image must be a valid URL' })
  seo_image?: string | null;
}
