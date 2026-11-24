import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

export class CreateResourceScheduleSavedViewDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ type: ScheduleViewStateDto })
  @ValidateNested()
  @Type(() => ScheduleViewStateDto)
  view_state!: ScheduleViewStateDto;

  @ApiPropertyOptional({
    description: 'Mark this view as the default for this user + organization.',
  })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}
