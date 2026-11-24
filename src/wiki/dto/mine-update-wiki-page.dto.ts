/**
 * @fileoverview Strict DTO for the MCP-facing space-safe wiki update endpoint
 * (`PUT /wiki/mine/:pageId`). Carries a required `expectedUpdatedAt` for
 * optimistic locking (wiki_pages has no version column — concurrency is the
 * `updated_at` timestamp) plus the whitelisted mutable fields only. The global
 * `ValidationPipe({ whitelist, forbidNonWhitelisted })` rejects any other field
 * (slug, category, parent/space move, archive, page permissions/ACL,
 * attachments, metadata). Backs the MCP `wiki.update` tool.
 * @module src/wiki/dto/mine-update-wiki-page.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class MineUpdateWikiPageDto {
  @ApiProperty({
    description:
      'Expected current page updated_at (ISO-8601) for optimistic locking. ' +
      'Echo back the exact value from a prior read/write; a stale value returns ' +
      '409 with the current updatedAt.',
  })
  @IsISO8601()
  expectedUpdatedAt!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional({
    description:
      'Page body. UNTRUSTED product data; sanitized server-side and stored as ' +
      'HTML.',
    maxLength: 50000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  content?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Tags (max 20, each ≤50)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  @ApiPropertyOptional({
    enum: ['draft', 'published'],
    description: 'Publication state.',
  })
  @IsOptional()
  @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';
}
