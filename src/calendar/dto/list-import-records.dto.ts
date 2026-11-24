import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const IMPORT_RECORD_PROVIDERS = [
  'google',
  'microsoft',
  'calendly',
  'ics',
  'zoom',
] as const;

export const IMPORT_RECORD_STATUS_FILTERS = [
  'synced',
  'removed',
  'unlinked',
  'all',
] as const;

export const IMPORT_RECORD_SORTS = [
  'source',
  'event',
  'calendar',
  'starts',
  'ends',
  'status',
  'last_synced',
] as const;

export const IMPORT_RECORD_DIRECTIONS = ['asc', 'desc'] as const;

export type ImportRecordSort = (typeof IMPORT_RECORD_SORTS)[number];
export type ImportRecordDirection = (typeof IMPORT_RECORD_DIRECTIONS)[number];

export type ImportRecordProvider = (typeof IMPORT_RECORD_PROVIDERS)[number];

export type ImportRecordStatusFilter =
  (typeof IMPORT_RECORD_STATUS_FILTERS)[number];

/** One page of entries brought in from connected calendars. */
export class ListImportRecordsDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: IMPORT_RECORD_PROVIDERS })
  @IsOptional()
  @IsIn(IMPORT_RECORD_PROVIDERS)
  provider?: ImportRecordProvider;

  @ApiPropertyOptional({
    enum: IMPORT_RECORD_STATUS_FILTERS,
    default: 'synced',
  })
  @IsOptional()
  @IsIn(IMPORT_RECORD_STATUS_FILTERS)
  status?: ImportRecordStatusFilter;

  @ApiPropertyOptional({ description: 'Only entries of this calendar' })
  @IsOptional()
  @IsUUID()
  calendar_id?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Matches the title or the calendar name',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({
    enum: IMPORT_RECORD_SORTS,
    description: 'Column to sort by; newest change first when left out',
  })
  @IsOptional()
  @IsIn(IMPORT_RECORD_SORTS)
  sort?: ImportRecordSort;

  @ApiPropertyOptional({ enum: IMPORT_RECORD_DIRECTIONS, default: 'asc' })
  @IsOptional()
  @IsIn(IMPORT_RECORD_DIRECTIONS)
  dir?: ImportRecordDirection;
}
