import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, Max, Min, ValidateIf } from 'class-validator';

/** Bodies for the board's live rail features (timer, private mode). */

export const TIMER_ACTIONS = [
  'start',
  'set',
  'pause',
  'resume',
  'stop',
  'add_minute',
] as const;

export type TimerAction = (typeof TIMER_ACTIONS)[number];

/** 5 s to 8 h (the timer table's CHECK allows down to 1 s). */
export const TIMER_MIN_MS = 5000;
export const TIMER_MAX_MS = 28_800_000;

export class TimerCommandDto {
  @ApiProperty({ enum: TIMER_ACTIONS })
  @IsIn(TIMER_ACTIONS)
  action: TimerAction;

  @ApiPropertyOptional({
    minimum: TIMER_MIN_MS,
    maximum: TIMER_MAX_MS,
    description:
      'Required for start and set (the time typed on the card); optional for resume (resume with an edited time)',
  })
  @ValidateIf(
    (dto: TimerCommandDto) =>
      dto.action === 'start' ||
      dto.action === 'set' ||
      (dto.action === 'resume' && dto.duration_ms !== undefined),
  )
  @IsInt()
  @Min(TIMER_MIN_MS)
  @Max(TIMER_MAX_MS)
  duration_ms?: number;
}

export class StartPrivateModeDto {
  @ApiProperty({
    description: 'Keep authors anonymous after the session ends',
  })
  @IsBoolean()
  keep_anonymous: boolean;
}
