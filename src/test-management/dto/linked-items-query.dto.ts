import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import {
  REQUIREMENT_TICKET_SORT_DIRS,
  type RequirementTicketSortDir,
} from './requirement-ticket-search.dto';
import { TaskLinkTypeQueryDto } from './test-requirement-link.dto';

export const LINKED_ITEMS_SORT_FIELDS = [
  'key',
  'type',
  'status',
  'linked_at',
] as const;
export type LinkedItemsSortField = (typeof LINKED_ITEMS_SORT_FIELDS)[number];

/** Link type and optional sorting for all test items linked to a ticket. */
export class LinkedItemsQueryDto extends TaskLinkTypeQueryDto {
  @ApiPropertyOptional({
    enum: LINKED_ITEMS_SORT_FIELDS,
    description: 'Left out: cases, then sets, then plans, each by link order',
  })
  @IsOptional()
  @IsIn(LINKED_ITEMS_SORT_FIELDS)
  sortBy?: LinkedItemsSortField;

  @ApiPropertyOptional({ enum: REQUIREMENT_TICKET_SORT_DIRS, default: 'asc' })
  @IsOptional()
  @IsIn(REQUIREMENT_TICKET_SORT_DIRS)
  sortDir?: RequirementTicketSortDir;
}
