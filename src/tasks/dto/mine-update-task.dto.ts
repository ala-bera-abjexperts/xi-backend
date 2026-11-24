/**
 * @fileoverview Strict DTO for the MCP-facing space-safe task update endpoint
 * (`PATCH /tasks/mine/:taskIdOrKey`). Carries an `expectedVersion` for
 * optimistic locking plus the whitelisted mutable fields only. The global
 * `ValidationPipe({ whitelist, forbidNonWhitelisted })` rejects any other field
 * (status, custom fields, parent/process/task-type override, space/org move).
 * @module src/tasks/dto/mine-update-task.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class MineUpdateTaskDto {
  @ApiProperty({
    description: 'Expected current task version for optimistic locking.',
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  summary?: string;

  @ApiPropertyOptional({ maxLength: 50000 })
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  priority?: string;

  @ApiPropertyOptional({ description: 'Assignee public.users.id (org member)' })
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional({
    description: 'ISO-8601 due date, or null to clear it.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  dueDate?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labels?: string[];
}
