import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** Lead times a reminder may use, in minutes: at start, 5 min … 2 hours, then each whole day up to 1 week. */
export const CALENDAR_REMINDER_MINUTES = [
  0, 5, 10, 15, 30, 60, 120, 1440, 2880, 4320, 5760, 7200, 8640, 10080,
] as const;

export const CALENDAR_REMINDER_CHANNELS = ['notification', 'email'] as const;

export type CalendarReminderChannel =
  (typeof CALENDAR_REMINDER_CHANNELS)[number];

export const CALENDAR_MAX_REMINDERS = 5;

/** How often one reminder may be sent; repeats are spread evenly between it and the start. */
export const CALENDAR_MAX_REMINDER_REPEATS = 5;

export class CalendarReminderDto {
  @ApiProperty({ enum: CALENDAR_REMINDER_MINUTES })
  @IsIn(CALENDAR_REMINDER_MINUTES as unknown as number[])
  minutes_before!: number;

  @ApiProperty({ enum: CALENDAR_REMINDER_CHANNELS, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(CALENDAR_REMINDER_CHANNELS.length)
  @ArrayUnique()
  @IsIn(CALENDAR_REMINDER_CHANNELS as unknown as string[], { each: true })
  channels!: CalendarReminderChannel[];

  @ApiPropertyOptional({
    minimum: 1,
    maximum: CALENDAR_MAX_REMINDER_REPEATS,
    description:
      'Times to send it, spaced evenly up to the start; once when left out',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(CALENDAR_MAX_REMINDER_REPEATS)
  repeat_times?: number;
}

/** The list rules shared by a calendar's default and an entry's own reminders. */
export function ReminderList(): PropertyDecorator {
  return applyDecorators(
    IsArray(),
    ArrayMaxSize(CALENDAR_MAX_REMINDERS),
    ArrayUnique((item: CalendarReminderDto) => item?.minutes_before, {
      message: 'Each reminder needs a different time',
    }),
    ValidateNested({ each: true }),
    Type(() => CalendarReminderDto),
  );
}
