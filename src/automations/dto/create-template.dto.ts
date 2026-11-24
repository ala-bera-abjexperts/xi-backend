import {
  IsString,
  IsUUID,
  IsBoolean,
  IsArray,
  IsOptional,
  IsObject,
  IsNotEmpty,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTemplateDto {
  @ApiProperty({ description: 'Space UUID' })
  @IsUUID()
  spaceId: string;

  @ApiProperty({ description: 'Template name (1–200 chars)' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(200)
  name: string;

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

  @ApiProperty({ description: 'Trigger event kind (e.g. app.task.created)' })
  @IsString()
  @IsNotEmpty()
  trigger_kind: string;

  @ApiPropertyOptional({
    description: 'Trigger configuration JSON — defaults to {}',
  })
  @IsObject()
  @IsOptional()
  trigger_config?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Automation definition with nodes and edges arrays — defaults to empty canvas',
  })
  @IsObject()
  @IsOptional()
  definition?: { nodes: unknown[]; edges: unknown[] };

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  is_public?: boolean;
}
