import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
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
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { CalendarEventsService } from './calendar-events.service';
import { CalendarsService } from './calendars.service';
import { SetCalendarEventLinksDto } from './dto/calendar-event-links.dto';
import { SetCalendarEventWatchersDto } from './dto/calendar-event-watchers.dto';
import { CreateCalendarEventDto } from './dto/create-calendar-event.dto';
import { ListCalendarEventsDto } from './dto/list-calendar-events.dto';
import { UpdateCalendarEventDto } from './dto/update-calendar-event.dto';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { calendarIdParamSchema } from './dto/calendar-request.schemas';
import { CalendarResponseInterceptor } from './calendar-response.interceptor';

@RequireFeature('module_calendar')
@ApiTags('calendar-events')
@ApiBearerAuth()
@Controller('calendar/events')
@UseInterceptors(CalendarResponseInterceptor)
export class CalendarEventsController {
  constructor(
    private readonly events: CalendarEventsService,
    private readonly calendars: CalendarsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Entries in a date window, across the calendars this user may see',
  })
  @ApiResponse({ status: 200, description: 'Entries returned' })
  @ApiResponse({
    status: 400,
    description: 'Window missing, backwards or too wide',
  })
  async list(
    @Query() query: ListCalendarEventsDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.events.list(query, user.userId, user.organizationId);
  }

  @Post()
  @ApiOperation({ summary: 'Create an entry on a calendar' })
  @ApiResponse({ status: 201, description: 'Entry created' })
  @ApiResponse({
    status: 400,
    description: 'Dates, time zone, fields, followers or links rejected',
  })
  @ApiResponse({
    status: 403,
    description: 'Edit access to that calendar required',
  })
  async create(
    @Body() dto: CreateCalendarEventDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    // A meeting would be made on the impersonated person's own Zoom account.
    if (user.impersonation && dto.generate_meeting === true) {
      throw new ForbiddenException(
        'A Zoom meeting cannot be created while impersonating.',
      );
    }

    await this.events.assertNoPastWholeDay(
      dto,
      user.userId,
      user.organizationId,
    );

    await this.events.assertNoPastTime(dto, user.userId, user.organizationId);

    await this.events.assertNoOwnClash(dto, user.userId, user.organizationId);

    return this.events.create(dto, user.userId, user.organizationId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one entry' })
  @ApiParam({ name: 'id', description: 'Entry UUID' })
  @ApiResponse({ status: 200, description: 'Entry returned' })
  @ApiResponse({
    status: 404,
    description: 'Not found, or its calendar is not visible',
  })
  async get(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.events.getForUser(id, user.userId, user.organizationId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit an entry' })
  @ApiParam({ name: 'id', description: 'Entry UUID' })
  @ApiResponse({ status: 200, description: 'Entry updated' })
  @ApiResponse({
    status: 409,
    description: 'Someone else saved first; reload and try again',
  })
  async update(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @Body() dto: UpdateCalendarEventDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    // A meeting would be made on the impersonated person's own Zoom account.
    if (user.impersonation && dto.generate_meeting === true) {
      throw new ForbiddenException(
        'A Zoom meeting cannot be created while impersonating.',
      );
    }

    await this.events.assertNoPastWholeDay(
      dto,
      user.userId,
      user.organizationId,
      id,
    );

    await this.events.assertNoPastTime(
      dto,
      user.userId,
      user.organizationId,
      id,
    );

    await this.events.assertNoOwnClash(
      dto,
      user.userId,
      user.organizationId,
      id,
    );

    return this.events.update(id, dto, user.userId, user.organizationId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an entry' })
  @ApiParam({ name: 'id', description: 'Entry UUID' })
  @ApiResponse({ status: 200, description: 'Entry deleted' })
  @ApiResponse({
    status: 403,
    description: 'Edit access to its calendar required',
  })
  async remove(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.events.remove(id, user.userId, user.organizationId);
  }

  @Put(':id/watchers')
  @ApiOperation({ summary: 'Replace who follows an entry' })
  @ApiParam({ name: 'id', description: 'Entry UUID' })
  @ApiResponse({ status: 200, description: 'Followers updated' })
  @ApiResponse({
    status: 400,
    description: 'Someone named cannot see this calendar',
  })
  async setWatchers(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @Body() dto: SetCalendarEventWatchersDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.events.setWatchers(
      id,
      dto.watcher_ids,
      user.userId,
      user.organizationId,
    );
  }

  @Put(':id/links')
  @ApiOperation({ summary: 'Replace what an entry is linked to' })
  @ApiParam({ name: 'id', description: 'Entry UUID' })
  @ApiResponse({ status: 200, description: 'Links updated' })
  async setLinks(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @Body() dto: SetCalendarEventLinksDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.events.setLinks(
      id,
      dto.links,
      user.userId,
      user.organizationId,
    );
  }
}
