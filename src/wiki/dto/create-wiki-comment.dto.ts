/**
 * @fileoverview DTO for creating a wiki page comment (optionally anchored to
 * an inline text range via a TipTap comment mark thread).
 * @module src/wiki/dto/create-wiki-comment.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Anchor payload. Shape is validated in WikiCommentsService.validateAnchor:
 * `{ type: 'text-range', threadId: uuid, quotedText: string(≤500), blockId?: string }`, or on a
 * whiteboard link row `{ type: 'canvas', threadId: uuid, x, y, elementId?, dx?, dy? }`.
 * Only root comments may carry an anchor; replies inherit the thread.
 */
export class CreateWikiCommentDto {
  @ApiProperty({ description: 'Comment text content', maxLength: 10_000 })
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  content!: string;

  @ApiPropertyOptional({ description: 'Parent comment UUID for threading' })
  @IsOptional()
  @IsUUID()
  parent_id?: string;

  @ApiPropertyOptional({
    description:
      "Inline anchor: { type: 'text-range', threadId: uuid, quotedText: " +
      "string(≤500), blockId?: string }, or on a whiteboard { type: 'canvas', " +
      'threadId: uuid, x, y, elementId?, dx?, dy? }. Root comments only.',
  })
  @IsOptional()
  @IsObject()
  anchor?: Record<string, unknown>;
}
