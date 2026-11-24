/**
 * @fileoverview Strict DTO for the MCP-facing space-safe task comment endpoint
 * (`POST /tasks/mine/:taskIdOrKey/comments`). Only `content` is accepted, with
 * the same 10000-char ceiling the core `CreateCommentDto` enforces; the global
 * `ValidationPipe({ whitelist, forbidNonWhitelisted })` rejects any other field.
 * @module src/tasks/dto/mine-add-comment.dto
 * @author Prince Jadiya
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class MineAddCommentDto {
  @ApiProperty({ description: 'Comment content (max 10000 chars)' })
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  content!: string;
}
