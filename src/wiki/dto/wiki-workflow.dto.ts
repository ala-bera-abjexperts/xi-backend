/**
 * @fileoverview DTOs for the wiki review/approval workflow endpoints.
 * @module src/wiki/dto/wiki-workflow.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const WIKI_WORKFLOW_ACTIONS = [
  'submit_for_review',
  'approve',
  'reject',
  'withdraw',
  'publish',
  'unpublish',
] as const;

export type WikiWorkflowAction = (typeof WIKI_WORKFLOW_ACTIONS)[number];

export class WikiWorkflowTransitionDto {
  @ApiProperty({ enum: WIKI_WORKFLOW_ACTIONS })
  @IsIn(WIKI_WORKFLOW_ACTIONS as unknown as string[])
  action!: WikiWorkflowAction;

  @ApiPropertyOptional({
    description: 'Reviewer note (required for reject)',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Approver user UUIDs for submit_for_review (defaults to the space ' +
      'settings default_approver_ids).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  approverIds?: string[];
}

export class WikiSpaceSettingsDto {
  @ApiProperty({
    description: 'Whether publishing requires the review/approval flow',
  })
  @IsBoolean()
  require_approval!: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'Default approver user UUIDs',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  default_approver_ids?: string[];
}
