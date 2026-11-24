/**
 * @fileoverview DTO for updating a workflow assignment.
 * @module src/workflow-assignments/dto/update-workflow-assignment.dto
 * @author Rajbha Manek
 */
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsUUID } from 'class-validator';

export class UpdateWorkflowAssignmentDto {
  @ApiPropertyOptional({ description: 'New workflow to assign' })
  @IsOptional()
  @IsUUID()
  workflow_id?: string;

  @ApiPropertyOptional({
    description:
      'When workflow_id changes and the current workflow has statuses not in the new workflow, ' +
      'supplying migration_map runs a server-side migration in a single transaction: each orphan ' +
      "task is reassigned to the mapped status. Map shape: { '<orphan_status_id>': '<new_status_id>' }. " +
      'Missing entries → 400; the server returns suggested_mappings on the 409 to help the UI prefill ' +
      'the picker.',
  })
  @IsOptional()
  @IsObject()
  migration_map?: Record<string, string>;
}
