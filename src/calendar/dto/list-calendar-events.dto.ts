import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsOptional,
  IsTimeZone,
  IsUUID,
} from 'class-validator';

import { CALENDAR_MAX_IDS_PER_QUERY } from './calendar-validation';

/** Window a calendar view asks for. The service caps how wide it may be. */
export class ListCalendarEventsDto {
  @ApiPropertyOptional({ description: 'Start of the window, e.g. 2026-09-01' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ description: 'End of the window, e.g. 2026-10-01' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

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

  @ApiPropertyOptional({
    description:
      "The reader's time zone, e.g. Europe/Berlin. Decides which day a ticket deadline lands on.",
  })
  @IsOptional()
  @IsTimeZone()
  tz?: string;
}
