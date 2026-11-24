import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { CALENDAR_MAX_FIELDS } from './calendar-validation';

export class CalendarFieldSettingDto {
  @ApiProperty({ description: 'Id of an existing custom field' })
  @IsUUID()
  field_id!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 999 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  order?: number;
}

/** Replaces the fields shown on a calendar's events; an empty array shows none. */
export class SetCalendarFieldSettingsDto {
  @ApiProperty({
    type: [CalendarFieldSettingDto],
    maxItems: CALENDAR_MAX_FIELDS,
  })
  @IsArray()
  @ArrayMaxSize(CALENDAR_MAX_FIELDS)
  @ValidateNested({ each: true })
  @Type(() => CalendarFieldSettingDto)
  fields!: CalendarFieldSettingDto[];
}
