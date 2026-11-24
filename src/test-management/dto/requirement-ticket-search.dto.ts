import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export const REQUIREMENT_TICKET_SORT_FIELDS = [
  'updated_at',
  'created_at',
  'key',
  'summary',
  'status',
] as const;
export type RequirementTicketSortField =
  (typeof REQUIREMENT_TICKET_SORT_FIELDS)[number];

export const REQUIREMENT_TICKET_SORT_DIRS = ['asc', 'desc'] as const;
export type RequirementTicketSortDir =
  (typeof REQUIREMENT_TICKET_SORT_DIRS)[number];

export const REQUIREMENT_TICKET_MAX_PAGE_SIZE = 50;

/** Filters and sorting for the tickets that can be linked to a test case as requirements. */
export class RequirementTicketSearchQueryDto {
  @ApiPropertyOptional({ description: 'Matches key, summary or description' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  taskTypeId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  statusId?: string;

  @ApiPropertyOptional({ description: "'unassigned' or a user id" })
  @IsOptional()
  @ValidateIf((_, value) => value !== 'unassigned')
  @IsUUID()
  assignedTo?: string;

  @ApiPropertyOptional({
    enum: REQUIREMENT_TICKET_SORT_FIELDS,
    default: 'updated_at',
  })
  @IsOptional()
  @IsIn(REQUIREMENT_TICKET_SORT_FIELDS)
  sortBy?: RequirementTicketSortField;

  @ApiPropertyOptional({ enum: REQUIREMENT_TICKET_SORT_DIRS, default: 'desc' })
  @IsOptional()
  @IsIn(REQUIREMENT_TICKET_SORT_DIRS)
  sortDir?: RequirementTicketSortDir;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: REQUIREMENT_TICKET_MAX_PAGE_SIZE,
    default: 25,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(REQUIREMENT_TICKET_MAX_PAGE_SIZE)
  pageSize?: number;
}
