import { ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsTimeZone,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { CALENDAR_MAX_IDS_PER_QUERY } from './calendar-validation';

export const CALENDAR_INSIGHT_BUCKETS = ['day', 'week', 'month'] as const;

export const CALENDAR_INSIGHT_EVENT_KINDS = [
  'all',
  'past',
  'upcoming',
  'overlapping',
] as const;

export const CALENDAR_INSIGHT_MAX_PAGE = 100;

/** The window and filters every part of the report shares. The service caps how wide the window is. */
export class CalendarInsightsDto {
  @ApiPropertyOptional({ description: 'Start of the window, inclusive' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ description: 'End of the window, exclusive' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional({
    description:
      "The reader's time zone, e.g. Europe/Berlin. Decides where a day begins.",
  })
  @IsOptional()
  @IsTimeZone()
  tz?: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: CALENDAR_MAX_IDS_PER_QUERY,
    description:
      'Calendars to read; comma separated or repeated. All visible ones when left out.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayMaxSize(CALENDAR_MAX_IDS_PER_QUERY)
  @IsUUID(undefined, { each: true })
  calendar_ids?: string[];

  @ApiPropertyOptional({ enum: CALENDAR_INSIGHT_BUCKETS })
  @IsOptional()
  @IsIn(CALENDAR_INSIGHT_BUCKETS as unknown as string[])
  bucket?: (typeof CALENDAR_INSIGHT_BUCKETS)[number];
}

/** One page of a list behind the report. */
export class CalendarInsightPageDto extends CalendarInsightsDto {
  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: CALENDAR_INSIGHT_MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CALENDAR_INSIGHT_MAX_PAGE)
  limit?: number;
}

export class CalendarInsightEventsDto extends CalendarInsightPageDto {
  @ApiPropertyOptional({ enum: CALENDAR_INSIGHT_EVENT_KINDS })
  @IsOptional()
  @IsIn(CALENDAR_INSIGHT_EVENT_KINDS as unknown as string[])
  kind?: (typeof CALENDAR_INSIGHT_EVENT_KINDS)[number];
}

/** Unusual activity has its own fixed window, so only the time zone and the calendars are taken. */
export class CalendarInsightUnusualDto extends PickType(CalendarInsightsDto, [
  'tz',
  'calendar_ids',
] as const) {}
