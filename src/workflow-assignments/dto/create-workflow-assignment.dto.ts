/**
 * @fileoverview DTO for creating a workflow assignment.
 * @module src/workflow-assignments/dto/create-workflow-assignment.dto
 * @author Rajbha Manek
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

export class CreateWorkflowAssignmentDto {
  @ApiProperty({ description: 'Space to assign the workflow to' })
  @IsUUID()
  space_id!: string;

  @ApiProperty({
    description: "Hierarchy level ID or '*' for space-wide default",
    example: '*',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  task_type_level_id!: string;

  @ApiProperty({ description: 'Workflow to assign' })
  @IsUUID()
  workflow_id!: string;

  @ApiPropertyOptional({
    description: "True only when task_type_level_id = '*'",
  })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @ApiPropertyOptional({
    description:
      'When true, migrate all existing tasks of this type to the workflow initial status',
  })
  @IsOptional()
  @IsBoolean()
  apply_to_existing?: boolean;
}
