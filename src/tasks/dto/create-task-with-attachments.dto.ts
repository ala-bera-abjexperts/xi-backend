/**
 * @fileoverview DTO for creating a task together with its files in one multipart request.
 * @module src/tasks/dto/create-task-with-attachments.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsString } from 'class-validator';

/** A repeated multipart field arrives as a lone string when exactly one value is sent. */
function toStringArray({ value }: { value: unknown }): unknown {
  if (typeof value !== 'string') return value;

  return [value];
}

export class CreateTaskWithAttachmentsDto {
  @ApiProperty({
    description:
      'JSON-encoded CreateTaskDto — multipart carries every non-file field as text.',
  })
  @IsString()
  payload!: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'One placeholder token per uploaded file, in the same order as `files`.',
  })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsString({ each: true })
  tokens?: string[];
}
