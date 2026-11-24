import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class IssueGroupMenuQueryDto {
  @IsUUID()
  spaceId!: string;
}

/** Comma-separated lists; one set of filters drives both the counts and the ticket lists. */
export class IssueGroupFiltersDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsString()
  statusIds?: string;

  @IsOptional()
  @IsString()
  priorityIds?: string;

  @IsOptional()
  @IsString()
  assigneeIds?: string;

  @IsOptional()
  @IsString()
  taskTypeIds?: string;

  @IsOptional()
  @IsString()
  labels?: string;

  @IsOptional()
  @IsBooleanString()
  hideDone?: string;
}

export class IssueGroupTasksQueryDto extends IssueGroupFiltersDto {
  /** An option id, or `none` for tickets without a value. */
  @Matches(
    /^(none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  )
  option!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: string;
}
