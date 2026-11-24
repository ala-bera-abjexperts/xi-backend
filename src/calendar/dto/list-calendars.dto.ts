import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/** The orders the calendar list can be read in; left out, it stays sorted by name. */
export const CALENDAR_LIST_SORTS = [
  'name_asc',
  'name_desc',
  'created_desc',
  'created_asc',
  'updated_desc',
  'updated_asc',
] as const;

export type CalendarListSort = (typeof CALENDAR_LIST_SORTS)[number];

export class ListCalendarsDto {
  @ApiPropertyOptional({
    enum: CALENDAR_LIST_SORTS,
    description: 'Order of the list; by name when left out',
  })
  @IsOptional()
  @IsIn(CALENDAR_LIST_SORTS)
  sort?: CalendarListSort;
}
