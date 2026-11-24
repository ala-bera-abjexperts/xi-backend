import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, ValidateNested } from 'class-validator';

import { ZoomMeetingOptionsDto } from './zoom-meeting-options.dto';

/** Body of the endpoint that changes the settings of a meeting made here. */
export class UpdateZoomMeetingDto {
  @ApiProperty({ type: ZoomMeetingOptionsDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ZoomMeetingOptionsDto)
  zoom_options!: ZoomMeetingOptionsDto;
}
