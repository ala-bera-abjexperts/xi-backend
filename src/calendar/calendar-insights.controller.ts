/**
 * @fileoverview The calendar report. Read-only: each route answers from the entries the caller may already read.
 */
import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { CalendarInsightsService } from './calendar-insights.service';
import { CalendarsService } from './calendars.service';
import {
  CalendarInsightEventsDto,
  CalendarInsightPageDto,
  CalendarInsightsDto,
  CalendarInsightUnusualDto,
} from './dto/calendar-insights.dto';

@RequireFeature('module_calendar')
@ApiTags('calendar-insights')
@ApiBearerAuth()
@Controller('calendar/insights')
export class CalendarInsightsController {
  constructor(
    private readonly insights: CalendarInsightsService,
    private readonly calendars: CalendarsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Scheduled time and entry counts for a window, with the one before',
  })
  @ApiResponse({ status: 200, description: 'Report returned' })
  @ApiResponse({ status: 400, description: 'Window backwards or too wide' })
  async summary(
    @Query() query: CalendarInsightsDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.insights.summary(query, user.userId, user.organizationId);
  }

  @Get('events')
  @ApiOperation({ summary: 'The entries behind a figure, a page at a time' })
  @ApiResponse({ status: 200, description: 'Page of entries with the total' })
  async events(
    @Query() query: CalendarInsightEventsDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.insights.events(query, user.userId, user.organizationId);
  }

  @Get('overdue')
  @ApiOperation({
    summary: 'Overdue tickets linked from entries in the window',
  })
  @ApiResponse({ status: 200, description: 'Page of tickets with the total' })
  async overdue(
    @Query() query: CalendarInsightPageDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.insights.overdue(query, user.userId, user.organizationId);
  }

  @Get('unusual')
  @ApiOperation({
    summary:
      "What stands out in each calendar's last seven days against its own earlier weeks",
  })
  @ApiResponse({ status: 200, description: 'Alerts with their numbers' })
  async unusual(
    @Query() query: CalendarInsightUnusualDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.insights.unusual(query, user.userId, user.organizationId);
  }
}
