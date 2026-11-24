/**
 * @fileoverview DTO for creating/updating a task-type → form assignment.
 * @module src/task-type-form-assignments/dto/upsert-task-type-form-assignment.dto
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpsertTaskTypeFormAssignmentDto {
  @ApiProperty({
    description: "Hierarchy level ID or '*' for space-wide default",
    example: '*',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  task_type_level_id!: string;

  @ApiProperty({ description: 'Form to attach' })
  @IsUUID()
  form_id!: string;

  @ApiPropertyOptional({
    description: 'Where the form is shown on the task',
    enum: ['only_on_create', 'inline'],
    default: 'inline',
  })
  @IsOptional()
  @IsIn(['only_on_create', 'inline'])
  display_mode?: 'only_on_create' | 'inline';

  @ApiPropertyOptional({ description: 'Display order within the task type' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}
