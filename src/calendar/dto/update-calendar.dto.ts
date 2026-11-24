import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import {
  CALENDAR_MAX_REMINDERS,
  CalendarReminderDto,
  ReminderList,
} from './calendar-reminder.dto';
import { CALENDAR_VISIBILITIES } from './calendar-validation';

/**
 * Editable fields of a calendar.
 *
 * organization_id, space_id and owner_id are deliberately absent: a calendar never moves to another
 * tenant, space or owner through this endpoint, and the global whitelist turns any attempt into a 400.
 */
export class UpdateCalendarDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Hex colour, e.g. #4f8cff' })
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'color must be a hex value such as #4f8cff',
  })
  color?: string;

  @ApiPropertyOptional({
    description: 'The space the calendar belongs to; null makes it personal',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  space_id?: string | null;

  @ApiPropertyOptional({ enum: CALENDAR_VISIBILITIES })
  @IsOptional()
  @IsIn(CALENDAR_VISIBILITIES as unknown as string[])
  visibility?: string;

  @ApiPropertyOptional({ description: 'IANA time zone, e.g. Europe/Berlin' })
  @IsOptional()
  @IsTimeZone()
  default_timezone?: string;

  @ApiPropertyOptional({
    type: [CalendarReminderDto],
    maxItems: CALENDAR_MAX_REMINDERS,
    description: 'Reminders every entry gets unless it sets its own',
  })
  // Null is refused: the column always holds a list.
  @ValidateIf((_, value) => value !== undefined)
  @ReminderList()
  default_reminders?: CalendarReminderDto[];
}
