import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

import { CreateCalendarEventDto } from './create-calendar-event.dto';

/**
 * Editable fields of an event: everything a create takes except the calendar it lives in.
 *
 * organization_id, source and deleted_at are absent on purpose, and moving an event to another calendar
 * gets its own endpoint, because it needs edit rights on both sides.
 */
export class UpdateCalendarEventDto extends PartialType(
  OmitType(CreateCalendarEventDto, ['calendar_id'] as const),
) {
  @ApiPropertyOptional({
    description:
      'The updated_at the client last read. When it no longer matches, the edit is rejected instead of overwriting someone else.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  updated_at?: string;
}
