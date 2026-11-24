import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ScheduleViewStateDto } from './schedule-view-state.dto';

export class UpdateResourceScheduleSavedViewDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ type: ScheduleViewStateDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ScheduleViewStateDto)
  view_state?: ScheduleViewStateDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}
