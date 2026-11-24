/**
 * @fileoverview DTO for updating a wiki comment.
 * @module src/wiki/dto/update-wiki-comment.dto
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateWikiCommentDto {
  @ApiProperty({ maxLength: 10_000 })
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  content!: string;
}
