/**
 * @fileoverview DTO for updating a wiki page (all fields optional).
 * @module src/wiki/dto/update-wiki-page.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateWikiPageDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional()
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

  @ApiPropertyOptional({ maxLength: 5_000_000 })
  @IsOptional()
  @IsString()
  @MaxLength(5_000_000)
  content?: string;

  @ApiPropertyOptional({ enum: ['html', 'editorjs', 'tiptap'] })
  @IsOptional()
  @IsIn(['html', 'editorjs', 'tiptap'])
  content_format?: string;

  @ApiPropertyOptional({
    enum: ['editorjs', 'html'],
    description:
      'Lazy-conversion claim: the format this client converted FROM. The ' +
      'update only wins if the page still has this content_format; a loser ' +
      'receives 409 ALREADY_CONVERTED.',
  })
  @IsOptional()
  @IsIn(['editorjs', 'html'])
  convertedFrom?: 'editorjs' | 'html';

  @ApiPropertyOptional({
    description:
      'Optimistic lock: expected current updated_at (ISO-8601). A stale ' +
      'value receives 409 STALE_WRITE with the current updatedAt.',
  })
  @IsOptional()
  @IsISO8601()
  expectedUpdatedAt?: string;

  @ApiPropertyOptional({
    description:
      'Collab session id owning this write; required to write while a live ' +
      'collaborative session holds the page (else 409 COLLAB_ACTIVE).',
  })
  @IsOptional()
  @IsUUID()
  collabSessionId?: string;

  @ApiPropertyOptional({
    description:
      'Map of custom field key → value. Keys must be org custom fields with ' +
      "the 'wiki' context.",
  })
  @IsOptional()
  @IsObject()
  custom_field_values?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_published?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_archived?: boolean;

  @ApiPropertyOptional({ description: 'Sort order among siblings' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional({
    description: 'ISO 8601 datetime when page was published',
  })
  @IsOptional()
  @IsISO8601()
  published_at?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
