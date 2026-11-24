import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

import { CALENDAR_MAX_WATCHERS } from './calendar-validation';

/** Replaces an event's watchers; an empty array clears them. */
export class SetCalendarEventWatchersDto {
  @ApiProperty({
    type: [String],
    maxItems: CALENDAR_MAX_WATCHERS,
    description: 'User ids that follow this event',
  })
  @IsArray()
  @ArrayMaxSize(CALENDAR_MAX_WATCHERS)
  @IsUUID(undefined, { each: true })
  watcher_ids!: string[];
}
