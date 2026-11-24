import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';

import {
  CALENDAR_EVENT_LINK_TYPES,
  CALENDAR_MAX_LINKS,
} from './calendar-validation';

export class CalendarEventLinkDto {
  @ApiProperty({ enum: CALENDAR_EVENT_LINK_TYPES })
  @IsIn(CALENDAR_EVENT_LINK_TYPES as unknown as string[])
  type!: string;

  @ApiProperty({
    description: 'Id of the linked ticket, process, user or asset',
  })
  @IsUUID()
  id!: string;

  @ApiPropertyOptional({
    description: 'For a linked person: false leaves them out of the reminders',
  })
  @IsOptional()
  @IsBoolean()
  remind?: boolean;
}

/** Replaces an event's links; an empty array clears them. */
export class SetCalendarEventLinksDto {
  @ApiProperty({ type: [CalendarEventLinkDto], maxItems: CALENDAR_MAX_LINKS })
  @IsArray()
  @ArrayMaxSize(CALENDAR_MAX_LINKS)
  @ValidateNested({ each: true })
  @Type(() => CalendarEventLinkDto)
  links!: CalendarEventLinkDto[];
}
