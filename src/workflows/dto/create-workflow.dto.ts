/**
 * @fileoverview DTO for creating a workflow.
 * @module src/workflows/dto/create-workflow.dto
 * @author Rajbha Manek
 */
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateWorkflowDto {
  @ApiProperty({ example: 'Software Dev Workflow', maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Space ID (null = org-level)' })
  @IsOptional()
  @IsUUID()
  space_id?: string | null;

  @ApiPropertyOptional({ description: 'Initial status node ID' })
  @IsOptional()
  @IsUUID()
  initial_status_id?: string | null;
}
