/**
 * @fileoverview DTO for deleting a workflow assignment.
 * @module src/workflow-assignments/dto/delete-workflow-assignment.dto
 * @author Rajbha Manek
 */
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class DeleteWorkflowAssignmentDto {
  @ApiPropertyOptional({
    description: 'Set to true to proceed when orphaned tasks exist',
  })
  @IsOptional()
  @IsBoolean()
  acknowledge_orphaned_tasks?: boolean;
}
