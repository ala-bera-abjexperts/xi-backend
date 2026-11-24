/**
 * @fileoverview DTO for POST /tasks/:id/transitions/:transition_id/execute.
 * Carries the user-supplied screen input, optimistic-concurrency hint, and
 * idempotency key the engine uses to safely re-run a transition.
 * @module src/workflow-engine/dto/execute-transition.dto
 * @author Rajbha Manek
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * Body payload accepted by the controller-level transition endpoint and
 * forwarded into {@link WorkflowEngineService.executeTransition}. All fields
 * are optional — the engine fills sensible defaults (empty screen, no version
 * check, no idempotency cache key) when omitted.
 */
export class ExecuteTransitionDto {
  @ApiProperty({
    required: false,
    description: 'Form values from the transition screen, if any',
  })
  @IsOptional()
  @IsObject()
  screen_input?: Record<string, unknown>;

  @ApiProperty({
    required: false,
    description:
      "Optimistic concurrency: caller's expected task.version. A mismatch raises 409 ConflictException.",
  })
  @IsOptional()
  @IsInt()
  expected_version?: number;

  @ApiProperty({
    required: false,
    description:
      'Idempotency key — re-running with the same key returns the cached result.',
  })
  @IsOptional()
  @IsString()
  execution_id?: string;
}
