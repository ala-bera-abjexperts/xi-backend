/**
 * @fileoverview DTOs for wiki page templates (space- or tenant-level).
 * A template is a wiki page under the space's Templates root; these DTOs create that
 * page and edit its settings. Legacy rows (no page) are edited via UpdateWikiTemplateDto.
 * @module src/wiki/dto/wiki-template.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Empty / whitespace-only optional text is stored as NULL. */
const trimToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;

/** POST: create a template page under the space's Templates root. */
export class CreateWikiTemplateDto {
  @ApiProperty({ maxLength: 500, description: 'Title of the template page' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  name!: string;

  @ApiPropertyOptional({
    description: 'Copy this page (same space) into the new template',
  })
  @IsOptional()
  @IsUUID()
  source_page_id?: string;
}

/** PUT pages/:pageId/settings */
export class WikiTemplateSettingsDto {
  @ApiProperty({ enum: ['space', 'tenant'] })
  @IsIn(['space', 'tenant'])
  scope!: 'space' | 'tenant';

  @ApiPropertyOptional({
    maxLength: 500,
    nullable: true,
    description: 'Title for new pages; may contain {{date,YYYY-MM-DD}}',
  })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  page_title?: string | null;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

/** PATCH :id — legacy (dialog-made) templates only. Scope is immutable. */
export class UpdateWikiTemplateDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @Transform(trimToNull)
  @IsString()
  @MaxLength(500)
  page_title?: string | null;

  @ApiPropertyOptional({
    description: 'TipTap JSON string',
    maxLength: 5_000_000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(5_000_000)
  content?: string;
}
