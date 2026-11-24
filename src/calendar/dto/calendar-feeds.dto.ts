import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import {
  CALENDAR_MAX_FEEDS,
  CALENDAR_TICKET_DATE_FIELDS,
} from './calendar-validation';

/** One ticket source shown on a calendar: a space, and which of its dates places the ticket. */
export class CalendarFeedDto {
  @ApiPropertyOptional({ description: 'Kept when editing an existing source' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ description: 'Space whose tickets are shown' })
  @IsUUID()
  space_id!: string;

  @ApiPropertyOptional({
    description: 'One ticket to show. Left out, the whole space is shown.',
  })
  @IsOptional()
  @IsUUID()
  task_id?: string;

  @ApiProperty({ enum: CALENDAR_TICKET_DATE_FIELDS })
  @IsIn(CALENDAR_TICKET_DATE_FIELDS as unknown as string[])
  date_field!: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'What the source is called on the calendar',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @ApiPropertyOptional({ description: 'Hex colour, e.g. #f59e0b' })
  @IsOptional()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'color must be a hex value such as #f59e0b',
  })
  color?: string;

  @ApiPropertyOptional({
    description: 'When the source was first linked (set by the server)',
  })
  @IsOptional()
  @IsISO8601()
  linked_at?: string;

  @ApiPropertyOptional({
    description: 'Tickets of an All-tickets source that are not shown',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  excluded_task_ids?: string[];
}

/** Replaces the ticket sources of one calendar; an empty array removes them all. */
export class SetCalendarFeedsDto {
  @ApiProperty({ type: [CalendarFeedDto], maxItems: CALENDAR_MAX_FEEDS })
  @IsArray()
  @ArrayMaxSize(CALENDAR_MAX_FEEDS)
  @ValidateNested({ each: true })
  @Type(() => CalendarFeedDto)
  feeds!: CalendarFeedDto[];
}
