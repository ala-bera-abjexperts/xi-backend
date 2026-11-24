/**
 * @fileoverview DTO for creating a task comment.
 * @module src/tasks/dto/create-comment.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateCommentDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  task_id?: string;

  @ApiProperty({ description: 'Comment content (max 10000 chars)' })
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  content!: string;

  @ApiPropertyOptional({
    description:
      'Post as this user (requires add-comments-for-other-users permission)',
  })
  @IsOptional()
  @IsUUID()
  author_id?: string;

  @ApiPropertyOptional({
    description:
      'Post the same comment once as every active member of the task space (requires add-comments-for-other-users permission)',
  })
  @IsOptional()
  @IsBoolean()
  all_members?: boolean;
}
