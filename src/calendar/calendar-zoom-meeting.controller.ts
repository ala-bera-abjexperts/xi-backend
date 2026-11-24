/**
 * @fileoverview Makes the Zoom meeting for an entry that is already saved, and changes its settings.
 *
 * Kept apart from the entries controller so that controller's own routes stay as they are.
 */
import {
  BadGatewayException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CalendarEventsService } from './calendar-events.service';
import { CalendarResponseInterceptor } from './calendar-response.interceptor';
import { CalendarsService } from './calendars.service';
import { calendarIdParamSchema } from './dto/calendar-request.schemas';
import { zoomMeetingSettingsSchema } from './dto/calendar-zoom.schemas';
import type { ZoomMeetingSettingsResponse } from './dto/calendar-zoom.schemas';
import { UpdateZoomMeetingDto } from './dto/update-zoom-meeting.dto';
import { CreateZoomMeetingDto } from './dto/zoom-meeting-options.dto';

@RequireFeature('module_calendar')
@ApiTags('calendar-events')
@ApiBearerAuth()
@Controller('calendar/events')
export class CalendarZoomMeetingController {
  private readonly logger = new Logger(CalendarZoomMeetingController.name);

  constructor(
    private readonly events: CalendarEventsService,
    private readonly calendars: CalendarsService,
  ) {}

  @Post(':id/zoom-meeting')
  @UseInterceptors(CalendarResponseInterceptor)
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Create the Zoom meeting for an entry that has no link yet',
  })
  @ApiParam({ name: 'id', description: 'Entry UUID' })
  @ApiResponse({ status: 201, description: 'Entry returned with its link' })
  @ApiResponse({
    status: 400,
    description: 'Already linked, has no start time, or came from elsewhere',
  })
  @ApiResponse({
    status: 403,
    description: 'Edit access to the entry required',
  })
  async zoomMeeting(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @CurrentUser() user: RequestUser,
    @Body() body?: CreateZoomMeetingDto,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    // Without options the host's own Zoom defaults apply.
    return body?.zoom_options
      ? this.events.zoomMeeting(
          id,
          user.userId,
          user.organizationId,
          body.zoom_options,
        )
      : this.events.zoomMeeting(id, user.userId, user.organizationId);
  }

  @Get(':id/zoom-meeting')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: "The current settings of the entry's Zoom meeting, read from Zoom",
  })
  @ApiParam({ name: 'id', description: 'Entry UUID' })
  @ApiResponse({ status: 200, description: 'Meeting options; never a token' })
  @ApiResponse({
    status: 400,
    description: 'No Zoom meeting made here, or Zoom refused',
  })
  @ApiResponse({ status: 404, description: 'Meeting deleted inside Zoom' })
  async zoomMeetingSettings(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<ZoomMeetingSettingsResponse> {
    await this.calendars.assertModuleEnabled(user.organizationId);

    // Rebuilt from the fixed field list, so nothing else Zoom sends can leave here.
    const parsed = zoomMeetingSettingsSchema.safeParse(
      await this.events.zoomMeetingSettings(
        id,
        user.userId,
        user.organizationId,
      ),
    );

    if (parsed.success) return parsed.data;

    this.logger.warn(
      `Zoom meeting settings for entry ${id} did not match their response shape`,
    );

    throw new BadGatewayException('Zoom answered in an unexpected shape (502)');
  }

  @Patch(':id/zoom-meeting')
  @UseInterceptors(CalendarResponseInterceptor)
  @ImpersonationBlocked()
  @ApiOperation({
    summary: "Change the settings of the entry's Zoom meeting",
  })
  @ApiParam({ name: 'id', description: 'Entry UUID' })
  @ApiResponse({ status: 200, description: 'Entry returned with its link' })
  @ApiResponse({
    status: 400,
    description: 'No Zoom meeting made here, or Zoom refused',
  })
  @ApiResponse({ status: 404, description: 'Meeting deleted inside Zoom' })
  @ApiResponse({ status: 409, description: 'Meeting still being created' })
  async updateZoomMeetingSettings(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @CurrentUser() user: RequestUser,
    @Body() body: UpdateZoomMeetingDto,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.events.updateZoomMeetingSettings(
      id,
      user.userId,
      user.organizationId,
      body.zoom_options,
    );
  }
}
