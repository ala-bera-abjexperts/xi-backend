import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { CalendarEventLinkDto } from './calendar-event-links.dto';
import { ZoomMeetingOptionsDto } from './zoom-meeting-options.dto';
import {
  CALENDAR_MAX_REMINDERS,
  CalendarReminderDto,
  ReminderList,
} from './calendar-reminder.dto';
import {
  CALENDAR_DATE_PATTERN,
  CALENDAR_INSTANT_PATTERN,
  CALENDAR_MAX_LINKS,
  CALENDAR_MAX_WATCHERS,
  CALENDAR_MEETING_PROVIDERS,
} from './calendar-validation';

/**
 * A new event.
 *
 * An event is either all-day (start_date/end_date, end exclusive) or timed (starts_at/ends_at with an
 * offset). Which of the two a payload must use, and that the end is not before the start, is enforced by
 * the `calendar_events_time_shape_check` constraint until the service layer repeats it with a friendlier
 * message.
 */
export class CreateCalendarEventDto {
  @ApiProperty()
  @IsUUID()
  calendar_id!: string;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(500)
  summary!: string;

  @ApiPropertyOptional({ maxLength: 20000 })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  description?: string;

  @ApiPropertyOptional({ maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  location?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_all_day?: boolean;

  @ApiPropertyOptional({
    description: 'Timed start with its offset, e.g. 2026-09-24T09:00:00+02:00',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(CALENDAR_INSTANT_PATTERN, {
    message:
      'starts_at must carry a UTC offset, e.g. 2026-09-24T09:00:00+02:00',
  })
  starts_at?: string;

  @ApiPropertyOptional({ description: 'Timed end with its offset' })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(CALENDAR_INSTANT_PATTERN, {
    message: 'ends_at must carry a UTC offset, e.g. 2026-09-24T10:00:00+02:00',
  })
  ends_at?: string;

  @ApiPropertyOptional({ description: 'All-day start, e.g. 2026-09-24' })
  @IsOptional()
  @IsDateString()
  @Matches(CALENDAR_DATE_PATTERN, {
    message: 'start_date must be a date such as 2026-09-24',
  })
  start_date?: string;

  @ApiPropertyOptional({
    description: 'All-day end, exclusive: a single day ends on the next date',
  })
  @IsOptional()
  @IsDateString()
  @Matches(CALENDAR_DATE_PATTERN, {
    message: 'end_date must be a date such as 2026-09-25',
  })
  end_date?: string;

  @ApiPropertyOptional({ description: 'IANA time zone, e.g. Europe/Berlin' })
  @IsOptional()
  @IsTimeZone()
  timezone?: string;

  @ApiPropertyOptional({ enum: CALENDAR_MEETING_PROVIDERS })
  @IsOptional()
  @IsIn(CALENDAR_MEETING_PROVIDERS as unknown as string[])
  meeting_provider?: string;

  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  meeting_url?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  meeting_id?: string;

  @ApiPropertyOptional({
    description: 'Create the Zoom meeting rather than taking a pasted link',
  })
  @IsOptional()
  @IsBoolean()
  generate_meeting?: boolean;

  @ApiPropertyOptional({
    type: ZoomMeetingOptionsDto,
    description:
      'How the generated Zoom meeting is set up; used only with generate_meeting',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ZoomMeetingOptionsDto)
  zoom_options?: ZoomMeetingOptionsDto;

  @ApiPropertyOptional({
    type: Object,
    description:
      'Values of the custom fields the calendar shows, keyed by field key',
  })
  @IsOptional()
  @IsObject()
  custom_field_values?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [String], maxItems: CALENDAR_MAX_WATCHERS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CALENDAR_MAX_WATCHERS)
  @IsUUID(undefined, { each: true })
  watcher_ids?: string[];

  @ApiPropertyOptional({
    type: [CalendarEventLinkDto],
    maxItems: CALENDAR_MAX_LINKS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CALENDAR_MAX_LINKS)
  @ValidateNested({ each: true })
  @Type(() => CalendarEventLinkDto)
  links?: CalendarEventLinkDto[];

  @ApiPropertyOptional({
    type: [CalendarReminderDto],
    maxItems: CALENDAR_MAX_REMINDERS,
    nullable: true,
    description:
      "This entry's reminders; null follows the calendar's default and an empty list turns them off",
  })
  @IsOptional()
  @ReminderList()
  reminders?: CalendarReminderDto[] | null;
}
