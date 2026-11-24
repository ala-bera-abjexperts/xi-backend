import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';

import { CalendarFieldSettingDto } from './calendar-field-settings.dto';
import { CalendarShareDto } from './calendar-share.dto';
import {
  CALENDAR_MAX_REMINDERS,
  CalendarReminderDto,
  ReminderList,
} from './calendar-reminder.dto';
import {
  CALENDAR_MAX_FIELDS,
  CALENDAR_MAX_SHARES,
  CALENDAR_VISIBILITIES,
} from './calendar-validation';

export class CreateCalendarDto {
  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({
    description: 'Space the calendar belongs to. Left out for a personal one.',
  })
  @IsOptional()
  @IsUUID()
  space_id?: string;

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
    enum: CALENDAR_VISIBILITIES,
    description:
      'private or organization for a personal calendar, private or space for a space calendar',
    default: 'private',
  })
  @IsOptional()
  @IsIn(CALENDAR_VISIBILITIES as unknown as string[])
  visibility?: string;

  @ApiPropertyOptional({
    description: 'IANA time zone new events start in, e.g. Europe/Berlin',
    default: 'UTC',
  })
  @IsOptional()
  @IsTimeZone()
  default_timezone?: string;

  @ApiPropertyOptional({
    type: [CalendarShareDto],
    maxItems: CALENDAR_MAX_SHARES,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CALENDAR_MAX_SHARES)
  @ValidateNested({ each: true })
  @Type(() => CalendarShareDto)
  shares?: CalendarShareDto[];

  @ApiPropertyOptional({
    type: [CalendarFieldSettingDto],
    maxItems: CALENDAR_MAX_FIELDS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CALENDAR_MAX_FIELDS)
  @ValidateNested({ each: true })
  @Type(() => CalendarFieldSettingDto)
  field_settings?: CalendarFieldSettingDto[];

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
