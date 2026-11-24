import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  Matches,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { CALENDAR_TICKET_DATE_FIELDS } from './calendar-validation';

// 1 to 20 short names or ids, comma separated
const NAME_LIST = /^[^,]{1,100}(,[^,]{1,100}){0,19}$/;

/** One page of a linkable space's tickets. */
export class LinkTicketsSearchDto {
  @ApiProperty({ description: 'Space to read' })
  @IsUUID()
  space_id!: string;

  @ApiPropertyOptional({ description: 'Search on key or summary' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  page_size?: number;
}

/** Tickets read back by id. */
export class LinkTicketsLookupDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids!: string[];
}

/** One page of the tickets linked to the calendars this person may list. */
export class LinkedTicketsQueryDto {
  @ApiPropertyOptional({ description: 'Only this calendar' })
  @IsOptional()
  @IsUUID()
  calendar?: string;

  @ApiPropertyOptional({ description: 'Only this space' })
  @IsOptional()
  @IsUUID()
  space?: string;

  @ApiPropertyOptional({ description: 'Status names, comma separated' })
  @IsOptional()
  @Matches(NAME_LIST)
  status?: string;

  @ApiPropertyOptional({ description: 'Priority names, comma separated' })
  @IsOptional()
  @Matches(NAME_LIST)
  priority?: string;

  @ApiPropertyOptional({ description: 'Task type ids, comma separated' })
  @IsOptional()
  @Matches(NAME_LIST)
  type?: string;

  @ApiPropertyOptional({ description: 'Only links shown by this date' })
  @IsOptional()
  @IsIn(CALENDAR_TICKET_DATE_FIELDS)
  date_field?: string;

  @ApiPropertyOptional({ description: 'Search on key or summary' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  page_size?: number;
}
