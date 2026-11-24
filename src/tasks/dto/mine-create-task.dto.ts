/**
 * @fileoverview Strict DTO for the MCP-facing space-safe task create endpoint
 * (`POST /tasks/mine`). Only the whitelisted, space-safe fields are accepted;
 * the global `ValidationPipe({ whitelist, forbidNonWhitelisted })` rejects any
 * other field (status, custom fields, process override, space/org move) before
 * the controller runs. `parentTaskId` and `taskTypeId` ARE accepted — the
 * service resolves the parent org-scoped and `TasksService.create`'s
 * `validateCreateTaskInput` enforces type-active and parent-child hierarchy
 * rules with the same clear 400s the org route produces.
 * @module src/tasks/dto/mine-create-task.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class MineCreateTaskDto {
  @ApiProperty({
    description: 'Target space UUID or key (org-scoped). Required.',
  })
  @IsString()
  @MinLength(1)
  spaceIdOrKey!: string;

  @ApiProperty({ example: 'Fix login bug', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  summary!: string;

  @ApiPropertyOptional({ maxLength: 50000 })
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  description?: string;

  @ApiPropertyOptional({ example: 'medium' })
  @IsOptional()
  @IsString()
  priority?: string;

  @ApiPropertyOptional({ description: 'Assignee public.users.id (org member)' })
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 due date' })
  @IsOptional()
  @IsString()
  dueDate?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  labels?: string[];

  @ApiPropertyOptional({
    description:
      'Parent task UUID or key (org-scoped, must be in the same space). ' +
      'Hierarchy compatibility is validated backend-side.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  parentTaskId?: string;

  @ApiPropertyOptional({
    description:
      'Task hierarchy level id (e.g. "story", "sub_task") for the new task. ' +
      'Must be an active type for the space and hierarchy-compatible with ' +
      'the parent. Defaults to the space\'s task-level type.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  taskTypeId?: string;
}
