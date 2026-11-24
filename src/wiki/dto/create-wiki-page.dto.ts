/**
 * @fileoverview DTO for creating a wiki page.
 * @module src/wiki/dto/create-wiki-page.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateWikiPageDto {
  @ApiProperty({ description: 'Space this page belongs to' })
  @IsUUID()
  space_id!: string;

  @ApiProperty({ example: 'Getting Started', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  title!: string;

  @ApiPropertyOptional({
    description: 'URL-friendly slug (auto-generated if omitted)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'slug may only contain lowercase letters, numbers, and hyphens',
  })
  slug?: string;

  @ApiPropertyOptional({ description: 'Category UUID' })
  @IsOptional()
  @IsUUID()
  category_id?: string;

  @ApiPropertyOptional({
    description: 'Page content (HTML, EditorJS JSON, or TipTap JSON string)',
    maxLength: 5_000_000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(5_000_000)
  content?: string;

  @ApiPropertyOptional({
    enum: ['html', 'editorjs', 'tiptap'],
    default: 'editorjs',
  })
  @IsOptional()
  @IsIn(['html', 'editorjs', 'tiptap'])
  content_format?: string;

  @ApiPropertyOptional({
    description:
      'Map of custom field key → value. Keys must be org custom fields with ' +
      "the 'wiki' context.",
  })
  @IsOptional()
  @IsObject()
  custom_field_values?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Parent page UUID for hierarchy' })
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_published?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'Tags (max 20, each max 50 chars)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Arbitrary metadata JSONB' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
