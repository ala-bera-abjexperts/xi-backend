import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SupportRequestPriority } from './create-support-request.dto';

export enum SupportRequestStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
}

export class ListSupportRequestsQueryDto {
  @ApiPropertyOptional({
    enum: SupportRequestStatus,
    description: 'Filter by ticket status',
  })
  @IsOptional()
  @IsEnum(SupportRequestStatus)
  status?: SupportRequestStatus;

  @ApiPropertyOptional({ description: 'Filter by space UUID' })
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Search subject text or an exact ticket number',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by the linked task status UUID' })
  @IsOptional()
  @IsUUID()
  taskStatusId?: string;

  @ApiPropertyOptional({
    enum: SupportRequestPriority,
    description: 'Legacy bucket filter (low|medium|high|critical)',
  })
  @IsOptional()
  @IsEnum(SupportRequestPriority)
  priority?: SupportRequestPriority;

  @ApiPropertyOptional({
    description:
      'Filter by a configurable priority UUID. Rows saved before this column existed are matched by their legacy bucket.',
  })
  @IsOptional()
  @IsUUID()
  priorityId?: string;

  @ApiPropertyOptional({
    description:
      'Human-readable request type label configured in the form builder',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  requestType?: string;

  @ApiPropertyOptional({
    enum: ['mine', 'shared', 'all'],
    default: 'mine',
    description:
      "'mine' = created by the caller, 'shared' = shared with the caller, 'all' = either",
  })
  @IsOptional()
  @IsIn(['mine', 'shared', 'all'])
  scope?: 'mine' | 'shared' | 'all' = 'mine';

  @ApiPropertyOptional({ description: 'ISO-8601 lower bound on created_at' })
  @IsOptional()
  @IsISO8601()
  createdFrom?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 upper bound on created_at' })
  @IsOptional()
  @IsISO8601()
  createdTo?: string;

  @ApiPropertyOptional({
    enum: ['created_at', 'updated_at', 'ticket_number', 'subject'],
    default: 'created_at',
  })
  @IsOptional()
  @IsIn(['created_at', 'updated_at', 'ticket_number', 'subject'])
  sortBy?: 'created_at' | 'updated_at' | 'ticket_number' | 'subject' =
    'created_at';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc' = 'desc';
}
