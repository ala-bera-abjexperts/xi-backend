/**
 * @fileoverview The caller's own Zoom login, as the calendar needs to know it.
 *
 * Only booleans and the person's own Zoom email leave here; tokens never do.
 */
import { Controller, Get, Logger } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { CalendarsService } from './calendars.service';
import {
  calendarZoomStatusSchema,
  zoomMeetingDefaultsSchema,
} from './dto/calendar-zoom.schemas';
import type {
  CalendarZoomStatus,
  ZoomMeetingDefaults,
} from './dto/calendar-zoom.schemas';
import { zoomPasscodeDefaults } from './integrations/zoom-meeting';
import { ZoomTokensService } from './integrations/zoom-tokens.service';

@RequireFeature('module_calendar')
@ApiTags('calendar-zoom')
@ApiBearerAuth()
@Controller('calendar/zoom')
export class CalendarZoomController {
  private readonly logger = new Logger(CalendarZoomController.name);

  constructor(
    private readonly calendars: CalendarsService,
    private readonly zoomTokens: ZoomTokensService,
  ) {}

  @Get('status')
  @ApiOperation({
    summary: "The caller's Zoom login: set up, connected, needs reconnecting",
  })
  @ApiResponse({
    status: 200,
    description: 'Booleans and own email only; no token is ever returned',
  })
  @ApiResponse({ status: 403, description: 'Calendar module not enabled' })
  async status(@CurrentUser() user: RequestUser): Promise<CalendarZoomStatus> {
    await this.calendars.assertModuleEnabled(user.organizationId);

    // The caller's own login only: never a token, never anyone else's account.
    const parsed = calendarZoomStatusSchema.safeParse(
      await this.zoomTokens.status(user.userId, user.organizationId),
    );

    if (parsed.success) return parsed.data;

    this.logger.warn('Zoom status did not match its response shape');

    return { configured: false, connected: false };
  }

  @Get('meeting-defaults')
  @ImpersonationBlocked()
  @ApiOperation({
    summary:
      "Passcode settings from the caller's own Zoom account, for the meeting options form",
  })
  @ApiResponse({
    status: 200,
    description:
      'available=false with a reason when Zoom is not connected or refuses; never a token',
  })
  @ApiResponse({ status: 403, description: 'Calendar module not enabled' })
  async meetingDefaults(
    @CurrentUser() user: RequestUser,
  ): Promise<ZoomMeetingDefaults> {
    await this.calendars.assertModuleEnabled(user.organizationId);

    const parsed = zoomMeetingDefaultsSchema.safeParse(
      await this.readMeetingDefaults(user),
    );

    if (parsed.success) return parsed.data;

    this.logger.warn(
      'Zoom meeting defaults did not match their response shape',
    );

    return { available: false, reason: 'Zoom unavailable' };
  }

  private async readMeetingDefaults(user: RequestUser): Promise<unknown> {
    // Read through the caller's own Zoom login, so only their own settings come back.
    try {
      const login = await this.zoomTokens.forPerson(
        user.userId,
        user.organizationId,
      );

      return {
        available: true,
        ...(await zoomPasscodeDefaults(login.token)),
      };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : 'Zoom unavailable',
      };
    }
  }
}
