/**
 * @fileoverview DTO for creating a task.
 * @module src/tasks/dto/create-task.dto
 * @author Prince Jadiya
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateTaskDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    description: 'Legacy camelCase alias for space_id.',
  })
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @ApiPropertyOptional({ description: 'Space this task belongs to' })
  @IsOptional()
  @IsUUID()
  space_id?: string;

  @ApiProperty({ example: 'Fix login bug', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  summary!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: 'task',
    description: 'Task type ID from task_hierarchy_configurations (required)',
  })
  @IsString()
  @MinLength(1)
  task_type_id!: string;

  @ApiPropertyOptional({ description: 'Parent task UUID' })
  @IsOptional()
  @IsUUID()
  parent_task_id?: string;

  @ApiPropertyOptional({ description: 'Linked process UUID' })
  @IsOptional()
  @IsUUID()
  process_id?: string;

  @ApiPropertyOptional({ example: 'open' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Configurable status UUID' })
  @IsOptional()
  @IsUUID()
  status_id?: string;

  @ApiPropertyOptional({ example: 'medium' })
  @IsOptional()
  @IsString()
  priority?: string;

  @ApiPropertyOptional({ description: 'Configurable priority UUID' })
  @IsOptional()
  @IsUUID()
  priority_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigned_to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  reporter?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  due_date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  start_date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  end_date?: string;

  @ApiPropertyOptional({ description: 'Estimated time in minutes' })
  @IsOptional()
  @IsInt()
  @Min(0)
  estimated_time?: number;

  @ApiPropertyOptional({ description: 'Duration in minutes' })
  @IsOptional()
  @IsInt()
  @Min(0)
  duration?: number;

  @ApiPropertyOptional({ description: 'Progress 0-100' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimated_cost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  custom_field_values?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  labels?: string[];

  @ApiPropertyOptional({
    description: 'Planned budget for this task',
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  planned_budget?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}
