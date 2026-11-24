import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';

import type { TestCaseReadiness } from './test-case.dto';
import type { UserRef } from './test-execution.dto';

export const TEST_REQUIREMENT_LINK_LIMITS = {
  itemsPerCall: 500,
  itemsPerTask: 500,
  tasksPerCase: 500,
} as const;

/** Test items a ticket can be linked to; also the URL segment. */
export const TASK_LINK_KINDS = ['cases', 'sets', 'plans'] as const;
export type TaskLinkKind = (typeof TASK_LINK_KINDS)[number];

/** How the ticket relates to the item: it covers it (requirement) or was found by it (defect). */
export const TASK_LINK_TYPES = ['requirement', 'defect'] as const;
export type TaskLinkType = (typeof TASK_LINK_TYPES)[number];

/** Which links a read or an unlink is about; requirement when left out. */
export class TaskLinkTypeQueryDto {
  @ApiPropertyOptional({ enum: TASK_LINK_TYPES, default: 'requirement' })
  @IsOptional()
  @IsIn(TASK_LINK_TYPES)
  link_type?: TaskLinkType;
}

const toUniqueArray = ({ value }: { value: unknown }) =>
  Array.isArray(value) ? [...new Set(value)] : value;

/** Links test cases, test sets or test plans of the ticket's space to the ticket. */
export class LinkTaskItemsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: TEST_REQUIREMENT_LINK_LIMITS.itemsPerCall,
    description: 'Duplicates are counted once',
  })
  @Transform(toUniqueArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TEST_REQUIREMENT_LINK_LIMITS.itemsPerCall)
  @IsUUID('all', { each: true })
  item_ids: string[];

  @ApiPropertyOptional({ enum: TASK_LINK_TYPES, default: 'requirement' })
  @IsOptional()
  @IsIn(TASK_LINK_TYPES)
  link_type?: TaskLinkType;
}

/** A linked test case, test set or test plan; fields another kind lacks are null. */
export interface TaskLinkedItem {
  item_id: string;
  link_type: TaskLinkType;
  key: string;
  name: string;
  is_archived: boolean;
  readiness: TestCaseReadiness | null;
  start_date: string | null;
  end_date: string | null;
  linked_at: string;
  linked_by: UserRef | null;
}

export type TaskItemSkipReason = 'already_linked' | 'archived' | 'not_found';

export interface TaskItemsLinkResult {
  added: number;
  skipped: { item_id: string; reason: TaskItemSkipReason }[];
}

export interface VisibleCaseLinkedTask {
  task_id: string;
  restricted: false;
  key: string;
  summary: string;
  status: { name: string; color: string | null; is_completed: boolean } | null;
  space_key: string;
  linked_at: string;
}

// The caller cannot see the ticket, so only the id is shown.
export interface RestrictedCaseLinkedTask {
  task_id: string;
  restricted: true;
  linked_at: string;
}

export type CaseLinkedTask = VisibleCaseLinkedTask | RestrictedCaseLinkedTask;
