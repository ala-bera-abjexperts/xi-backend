import {
  Body,
  Controller,
  Delete,
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
import { CalendarsService } from './calendars.service';
import { SetCalendarFeedsDto } from './dto/calendar-feeds.dto';
import { SetCalendarFieldSettingsDto } from './dto/calendar-field-settings.dto';
import {
  ListLinkableTicketsDto,
  ListTicketLinksDto,
} from './dto/calendar-ticket-links.dto';
import { SetCalendarSharesDto } from './dto/calendar-share.dto';
import { CreateCalendarDto } from './dto/create-calendar.dto';
import { UpdateCalendarDto } from './dto/update-calendar.dto';
import { ListCalendarsDto } from './dto/list-calendars.dto';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { calendarIdParamSchema } from './dto/calendar-request.schemas';
import { CalendarResponseInterceptor } from './calendar-response.interceptor';

@RequireFeature('module_calendar')
@ApiTags('calendars')
@ApiBearerAuth()
@Controller('calendar/calendars')
@UseInterceptors(CalendarResponseInterceptor)
export class CalendarsController {
  constructor(private readonly service: CalendarsService) {}

  @Get()
  @ApiOperation({ summary: 'List the calendars this user may see' })
  @ApiResponse({
    status: 200,
    description: 'Calendars returned, each with the access level held',
  })
  @ApiResponse({ status: 403, description: 'Calendar module not enabled' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query() query: ListCalendarsDto = {},
  ) {
    await this.service.assertModuleEnabled(user.organizationId);

    // Without a chosen order the call is the one it always was.
    return query.sort
      ? this.service.listVisible(user.userId, user.organizationId, query.sort)
      : this.service.listVisible(user.userId, user.organizationId);
  }

  // Declared before ':id' so "can-create" is not read as a calendar id.
  @Get('can-create')
  @ApiOperation({ summary: 'Whether this user may create calendars' })
  @ApiResponse({ status: 200, description: '{ allowed: boolean }' })
  async canCreate(@CurrentUser() user: RequestUser) {
    await this.service.assertModuleEnabled(user.organizationId);

    return {
      allowed: await this.service.canCreateCalendars(
        user.userId,
        user.organizationId,
      ),
    };
  }

  // Declared before ':id' so "ownerless" is not read as a calendar id.
  @Get('ownerless')
  @ApiOperation({
    summary:
      'Calendars whose owner has left the organization (name and owner only)',
  })
  @ApiResponse({ status: 200, description: 'Calendars returned' })
  async ownerless(@CurrentUser() user: RequestUser) {
    await this.service.assertModuleEnabled(user.organizationId);

    return this.service.listOwnerless(user.organizationId, user.userId);
  }

  @Delete('ownerless/:id')
  @ApiOperation({
    summary: 'Delete a calendar left behind by someone who has left',
  })
  @ApiParam({ name: 'id', description: 'Calendar UUID' })
  @ApiResponse({ status: 200, description: 'Calendar deleted' })
  @ApiResponse({
    status: 404,
    description: 'Calendar not found or still owned',
  })
  async removeOwnerless(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertModuleEnabled(user.organizationId);

    return this.service.removeOwnerless(id, user.organizationId, user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a calendar, personal or in a space' })
  @ApiResponse({ status: 201, description: 'Calendar created' })
  @ApiResponse({
    status: 403,
    description: 'Not allowed to create a calendar in that space',
  })
  async create(
    @Body() dto: CreateCalendarDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertModuleEnabled(user.organizationId);

    return this.service.create(dto, user.userId, user.organizationId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one calendar' })
  @ApiParam({ name: 'id', description: 'Calendar UUID' })
  @ApiResponse({ status: 200, description: 'Calendar returned' })
  @ApiResponse({
    status: 404,
    description: 'Not found, or not visible to this user',
  })
  async get(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertModuleEnabled(user.organizationId);

    return this.service.getForUser(id, user.userId, user.organizationId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename, recolour or re-scope a calendar' })
  @ApiParam({ name: 'id', description: 'Calendar UUID' })
  @ApiResponse({ status: 200, description: 'Calendar updated' })
  @ApiResponse({ status: 403, description: 'Edit access required' })
  async update(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @Body() dto: UpdateCalendarDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertModuleEnabled(user.organizationId);

    return this.service.update(id, dto, user.userId, user.organizationId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a calendar and its entries' })
  @ApiParam({ name: 'id', description: 'Calendar UUID' })
  @ApiResponse({ status: 200, description: 'Calendar deleted' })
  @ApiResponse({ status: 403, description: 'Manage access required' })
  async remove(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertModuleEnabled(user.organizationId);

    return this.service.remove(id, user.userId, user.organizationId);
  }

  @Put(':id/shares')
  @ApiOperation({ summary: 'Replace who a calendar is shared with' })
  @ApiParam({ name: 'id', description: 'Calendar UUID' })
  @ApiResponse({ status: 200, description: 'Sharing updated' })
  @ApiResponse({ status: 403, description: 'Manage access required' })
  async setShares(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @Body() dto: SetCalendarSharesDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertModuleEnabled(user.organizationId);

    return this.service.setShares(
      id,
      dto.shares,
      user.userId,
      user.organizationId,
    );
  }

  @Get(':id/linkable-tickets')
  @ApiOperation({
    summary:
      "One page of the given spaces' tickets not linked to this calendar yet",
  })
  @ApiParam({ name: 'id', description: 'Calendar UUID' })
  @ApiResponse({ status: 200, description: 'Ticket ids, page and total' })
  @ApiResponse({
    status: 403,
    description:
      "No ticket-dates access, or you cannot see that space's tickets",
  })
  async linkableTickets(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @Query() query: ListLinkableTicketsDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertModuleEnabled(user.organizationId);

    return this.service.listLinkableTickets(
      id,
      user.userId,
      user.organizationId,
      query,
    );
  }

  @Get(':id/ticket-links')
  @ApiOperation({ summary: 'One page of the tickets linked to a calendar' })
  @ApiParam({ name: 'id', description: 'Calendar UUID' })
  @ApiResponse({
    status: 200,
    description: 'Linked ticket ids, page and total',
  })
  async ticketLinks(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @Query() query: ListTicketLinksDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertModuleEnabled(user.organizationId);

    return this.service.listTicketLinks(
      id,
      user.userId,
      user.organizationId,
      query,
    );
  }

  @Put(':id/feeds')
  @ApiOperation({ summary: 'Replace the ticket sources shown on a calendar' })
  @ApiParam({ name: 'id', description: 'Calendar UUID' })
  @ApiResponse({ status: 200, description: 'Ticket sources updated' })
  @ApiResponse({
    status: 403,
    description:
      "Manage access required, or you cannot see that space's tickets",
  })
  async setFeeds(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @Body() dto: SetCalendarFeedsDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertModuleEnabled(user.organizationId);

    return this.service.setFeeds(
      id,
      dto.feeds,
      user.userId,
      user.organizationId,
    );
  }

  @Put(':id/fields')
  @ApiOperation({
    summary: 'Replace the custom fields a calendar shows on its entries',
  })
  @ApiParam({ name: 'id', description: 'Calendar UUID' })
  @ApiResponse({ status: 200, description: 'Fields updated' })
  @ApiResponse({
    status: 400,
    description: 'A field is not available to this calendar',
  })
  async setFields(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @Body() dto: SetCalendarFieldSettingsDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.service.assertModuleEnabled(user.organizationId);

    return this.service.setFieldSettings(
      id,
      dto.fields,
      user.userId,
      user.organizationId,
    );
  }
}
