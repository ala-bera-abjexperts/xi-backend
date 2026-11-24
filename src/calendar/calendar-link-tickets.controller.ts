import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { CalendarLinkTicketsService } from './calendar-link-tickets.service';
import { CalendarsService } from './calendars.service';
import {
  LinkedTicketsQueryDto,
  LinkTicketsLookupDto,
  LinkTicketsSearchDto,
} from './dto/calendar-link-tickets.dto';

/** Spaces and tickets offered by the Link ticket tab; its own controller, outside the calendar response check. */
@RequireFeature('module_calendar')
@ApiTags('calendars')
@ApiBearerAuth()
@Controller('calendar/link-tickets')
export class CalendarLinkTicketsController {
  constructor(
    private readonly service: CalendarLinkTicketsService,
    private readonly calendars: CalendarsService,
  ) {}

  @Get('spaces')
  @ApiOperation({
    summary: 'Every open space with Tasks on, for the Link ticket tab',
  })
  @ApiResponse({ status: 200, description: 'Spaces, by name' })
  async spaces(@CurrentUser() user: RequestUser) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.service.spaces(user.organizationId);
  }

  @Get()
  @ApiOperation({ summary: "One page of a linkable space's tickets" })
  @ApiResponse({ status: 200, description: 'Tickets, page and total' })
  @ApiResponse({ status: 403, description: 'That space cannot be linked' })
  async search(
    @Query() query: LinkTicketsSearchDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.service.search(user.organizationId, {
      spaceId: query.space_id,
      search: query.search,
      page: query.page ?? 1,
      pageSize: query.page_size ?? 25,
    });
  }

  @Get('linked')
  @ApiOperation({
    summary:
      'One page of the tickets linked to the calendars this person may list',
  })
  @ApiResponse({ status: 200, description: 'Linked tickets, page and total' })
  async linked(
    @Query() query: LinkedTicketsQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    // Only calendars whose "Show in Link form" box is ticked, or the one asked for
    const listable = (
      await this.calendars.listVisible(user.userId, user.organizationId)
    ).filter(
      (calendar) =>
        calendar.permissions.task_events.form === true &&
        (!query.calendar || calendar.id === query.calendar),
    );

    return this.service.linked(
      user.organizationId,
      listable.map((calendar) => ({
        id: String(calendar.id),
        feeds: calendar.feeds,
      })),
      {
        space: query.space,
        status: query.status,
        priority: query.priority,
        type: query.type,
        dateField: query.date_field,
        search: query.search,
        page: query.page ?? 1,
        pageSize: query.page_size ?? 10,
      },
    );
  }

  @Post('lookup')
  @ApiOperation({ summary: 'Tickets by id, from linkable spaces only' })
  @ApiResponse({ status: 200, description: 'Found tickets and missing ids' })
  async lookup(
    @Body() body: LinkTicketsLookupDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.service.lookup(user.organizationId, body.ids);
  }
}
