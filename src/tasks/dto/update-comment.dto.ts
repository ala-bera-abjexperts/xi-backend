/**
 * @fileoverview DTO for updating a task comment.
 * @module src/tasks/dto/update-comment.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateCommentDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiProperty({ description: 'Updated comment content' })
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  content!: string;
}
