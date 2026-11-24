import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export const ZOOM_ENCRYPTION_TYPES = ['enhanced_encryption', 'e2ee'] as const;
export const ZOOM_AUTO_RECORDING = ['none', 'local', 'cloud'] as const;
export const ZOOM_REPEATS = ['daily', 'weekly', 'monthly'] as const;

/** How the Zoom meeting repeats; only Zoom repeats it, the calendar keeps one entry. */
export class ZoomRecurrenceDto {
  @ApiPropertyOptional({ enum: ZOOM_REPEATS })
  @IsIn(ZOOM_REPEATS)
  type!: (typeof ZOOM_REPEATS)[number];

  @ApiPropertyOptional({
    description:
      'Every this many days, weeks or months; Zoom allows up to 99, 50 and 10',
  })
  @IsInt()
  @Min(1)
  @Max(99)
  repeat_interval!: number;

  @ApiPropertyOptional({
    description: 'Weekly only: 1 = Sunday … 7 = Saturday',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekly_days?: number[];

  @ApiPropertyOptional({ description: 'Monthly only: day of the month' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  monthly_day?: number;

  @ApiPropertyOptional({ description: 'Ends after this many meetings' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  end_times?: number;

  @ApiPropertyOptional({ description: 'Or ends on this day (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'end_date must be YYYY-MM-DD' })
  end_date?: string;
}

/**
 * How the Zoom meeting is set up when it is made. Every field is optional: one left out keeps the
 * host's own Zoom default, so an empty object behaves exactly like sending nothing.
 */
export class ZoomMeetingOptionsDto {
  @ApiPropertyOptional({
    description: 'Use the host personal meeting ID instead of a new one',
  })
  @IsOptional()
  @IsBoolean()
  use_pmi?: boolean;

  @ApiPropertyOptional({ description: 'Require a passcode to join' })
  @IsOptional()
  @IsBoolean()
  passcode_enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'The passcode; left out, Zoom makes one. Up to 10 letters, digits or @ - _ *',
  })
  @IsOptional()
  @Matches(/^[A-Za-z0-9@\-_*]{1,10}$/, {
    message:
      'The passcode can be up to 10 letters, digits or the characters @ - _ *.',
  })
  passcode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  waiting_room?: boolean;

  @ApiPropertyOptional({ enum: ZOOM_ENCRYPTION_TYPES })
  @IsOptional()
  @IsIn(ZOOM_ENCRYPTION_TYPES)
  encryption_type?: (typeof ZOOM_ENCRYPTION_TYPES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  host_video?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  participant_video?: boolean;

  @ApiPropertyOptional({
    description: 'Let people use the meeting chat before and after',
  })
  @IsOptional()
  @IsBoolean()
  continuous_chat?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  join_before_host?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  mute_upon_entry?: boolean;

  @ApiPropertyOptional({ enum: ZOOM_AUTO_RECORDING })
  @IsOptional()
  @IsIn(ZOOM_AUTO_RECORDING)
  auto_recording?: (typeof ZOOM_AUTO_RECORDING)[number];

  @ApiPropertyOptional({ type: ZoomRecurrenceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ZoomRecurrenceDto)
  recurrence?: ZoomRecurrenceDto;
}

/** Body of the endpoint that makes the meeting for an entry already saved. */
export class CreateZoomMeetingDto {
  @ApiPropertyOptional({ type: ZoomMeetingOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ZoomMeetingOptionsDto)
  zoom_options?: ZoomMeetingOptionsDto;
}
