import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class LiveProductDto {
  @IsString()
  productId!: string;

  @IsString()
  priceId!: string;

  @IsBoolean()
  recurring!: boolean;
}

export class UpdateFunnelDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(63)
  @Matches(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
    message: 'sub_domain_name must be lowercase alphanumeric with hyphens',
  })
  sub_domain_name?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUrl({}, { message: 'favicon must be a valid URL' })
  favicon?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  published?: boolean;

  @ApiPropertyOptional({ type: [LiveProductDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LiveProductDto)
  live_products?: LiveProductDto[];

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

  @ApiPropertyOptional({
    nullable: true,
    description: 'Site theme configuration object',
  })
  @IsOptional()
  @IsObject()
  theme?: Record<string, unknown> | null;
}
