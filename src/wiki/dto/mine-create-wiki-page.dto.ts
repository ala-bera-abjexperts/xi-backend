/**
 * @fileoverview Strict DTO for the MCP-facing space-safe wiki create endpoint
 * (`POST /wiki/mine`). Only the whitelisted, space-safe fields are accepted; the
 * global `ValidationPipe({ whitelist, forbidNonWhitelisted })` rejects any other
 * field (slug, category, sort_order, metadata, page permissions/ACL,
 * attachments, archive, space/parent move beyond `parentPageId`) before the
 * controller runs. Backs the MCP `wiki.create` tool.
 * @module src/wiki/dto/mine-create-wiki-page.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class MineCreateWikiPageDto {
  @ApiProperty({
    description: 'Target space UUID or key (org-scoped). Required.',
  })
  @IsString()
  @MinLength(1)
  spaceIdOrKey!: string;

  @ApiProperty({ example: 'Onboarding Guide', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  title!: string;

  @ApiProperty({
    description:
      'Page body. UNTRUSTED product data; sanitized server-side and stored as ' +
      'HTML. May be empty.',
    maxLength: 50000,
  })
  @IsString()
  @MaxLength(50000)
  content!: string;

  @ApiPropertyOptional({
    description: 'Parent page UUID for hierarchy (must be in the same space).',
  })
  @IsOptional()
  @IsUUID()
  parentPageId?: string;

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
    description: 'Publication state. Defaults to draft when omitted.',
  })
  @IsOptional()
  @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';
}
