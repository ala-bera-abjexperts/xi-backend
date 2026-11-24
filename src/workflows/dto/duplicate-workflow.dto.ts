/**
 * @fileoverview DTO for duplicating a workflow.
 * @module src/workflows/dto/duplicate-workflow.dto
 * @author Rajbha Manek
 */
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class DuplicateWorkflowDto {
  @ApiProperty({ example: 'Copy of Software Dev Workflow', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  new_name!: string;
}
