/**
 * @fileoverview DTO for PUT /workflow-transitions/:id/rules. Items are typed
 * as `unknown[]` because per-item shape is validated by the workflow-engine
 * HandlerRegistryService via each handler's Zod schema. Top-level array caps
 * defend against payload abuse before per-item Zod validation runs.
 * @module src/workflow-transitions/dto/save-rules.dto
 * @author Rajbha Manek
 */

import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray } from 'class-validator';

const MAX_RULES_PER_PHASE = 50;

export class SaveRulesDto {
  @ApiProperty({
    type: [Object],
    description: 'Condition rule configs (validated via handler registry)',
  })
  @IsArray()
  @ArrayMaxSize(MAX_RULES_PER_PHASE)
  conditions!: unknown[];

  @ApiProperty({
    type: [Object],
    description: 'Validator rule configs (validated via handler registry)',
  })
  @IsArray()
  @ArrayMaxSize(MAX_RULES_PER_PHASE)
  validators!: unknown[];

  @ApiProperty({
    type: [Object],
    description: 'Post-function rule configs (validated via handler registry)',
  })
  @IsArray()
  @ArrayMaxSize(MAX_RULES_PER_PHASE)
  post_functions!: unknown[];

  @ApiProperty({
    type: [Object],
    description: 'Trigger rule configs (validated via handler registry)',
  })
  @IsArray()
  @ArrayMaxSize(MAX_RULES_PER_PHASE)
  triggers!: unknown[];
}
