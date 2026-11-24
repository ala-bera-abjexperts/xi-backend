/**
 * @fileoverview DTO for updating a task.
 * @module src/tasks/dto/update-task.dto
 * @author Prince Jadiya
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
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

export class UpdateTaskDto {
  @ApiPropertyOptional({
    description: 'Accepted for legacy Next route compatibility; ignored.',
  })
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  summary?: string;

  @ApiPropertyOptional({
    description: 'Legacy alias for summary from older task screens.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  task_type_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parent_task_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  process_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  space_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  status_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  priority?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  priority_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigned_to?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  reporter?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  due_date?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  start_date?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  end_date?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  estimated_time?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  actual_time?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  duration?: number;

  @ApiPropertyOptional()
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
  @IsNumber()
  @Min(0)
  actual_cost?: number;

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

  @ApiPropertyOptional({
    description:
      'Resolution for this task, scoped to the caller org and required to be active. Send null to clear. Rejected together with a status change in the same request.',
  })
  @IsOptional()
  @IsUUID()
  resolution_id?: string | null;
}
