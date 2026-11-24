import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateFunnelDto {
  @ApiProperty({ description: 'Funnel name', minLength: 1, maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ description: 'Funnel description', nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({
    description: 'Subdomain (lowercase alphanumeric + hyphens, max 63 chars)',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(63)
  @Matches(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
    message:
      'sub_domain_name must be lowercase alphanumeric with hyphens, no leading/trailing hyphen',
  })
  sub_domain_name?: string | null;

  @ApiPropertyOptional({ description: 'Favicon URL', nullable: true })
  @IsOptional()
  @IsUrl({}, { message: 'favicon must be a valid URL' })
  favicon?: string | null;

  @ApiPropertyOptional({
    description:
      'Site template to start from (its pages, theme and form fields are copied). Omit for a blank site.',
  })
  @IsOptional()
  @IsUUID()
  template_id?: string;
}
