import {
  IsString,
  IsUUID,
  IsBoolean,
  IsArray,
  IsOptional,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateTemplateDto {
  @ApiProperty({ description: 'Space UUID' })
  @IsUUID()
  spaceId: string;

  @ApiPropertyOptional()
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
  })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional()
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

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  is_public?: boolean;

  @ApiPropertyOptional({
    description: 'Updated workflow definition (nodes + edges)',
  })
  @IsOptional()
  definition?: { nodes: unknown[]; edges: unknown[] };
}
