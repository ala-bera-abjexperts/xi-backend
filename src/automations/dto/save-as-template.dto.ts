import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsUUID,
  IsBoolean,
  IsArray,
  IsOptional,
  MinLength,
  MaxLength,
} from 'class-validator';

export class SaveAsTemplateDto {
  @ApiProperty({ description: 'Space UUID to save the template into' })
  @IsUUID()
  spaceId: string;

  @ApiPropertyOptional({
    description: 'Template name — defaults to the trigger kind if omitted',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    enum: ['notifications', 'scheduling', 'integrations', 'internal'],
    default: 'internal',
  })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ default: 'bx-bolt-circle' })
  @IsString()
  @IsOptional()
  icon?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  svg_icon?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  is_public?: boolean;
}
