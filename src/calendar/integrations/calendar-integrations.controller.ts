import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../../auth/decorators/impersonation-blocked.decorator';
import { RequireFeature } from '../../auth/decorators/require-feature.decorator';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import type { Request } from 'express';
import { CalendarsService } from '../calendars.service';
import { LinkCalendarSyncDto } from '../dto/calendar-sync.dto';
import { CalendarAccountsService } from './calendar-accounts.service';
import { createState } from './calendar-oauth.state';
import { CalendarProvidersService } from './calendar-providers.service';
import { CalendarSyncService } from './calendar-sync.service';
import { ConnectIcsDto } from '../dto/calendar-sync.dto';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  calendarIdParamSchema,
  calendarProviderParamSchema
} from '../dto/calendar-request.schemas';
import { CalendarResponseInterceptor } from '../calendar-response.interceptor';

/**
 * An address on this deployment's own domain, or nothing.
 *
 * The caller supplies it, so it is checked against the configured host before being signed into the
 * state — otherwise the round trip could be pointed anywhere.
 */
function ownAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const configured = process.env.APP_URL ?? process.env.FRONTEND_URL ?? '';

  try {
    const asked = new URL(value);
    const home = new URL(configured);

    // Same site, any subdomain: tenants each have their own.
    const root = home.hostname.split('.').slice(-2).join('.');

    return asked.hostname === root || asked.hostname.endsWith(`.${root}`)
      ? asked.origin
      : undefined;
  } catch {
    return undefined;
  }
}

@RequireFeature('module_calendar')
@ApiTags('calendar-integrations')
@ApiBearerAuth()
@Controller('calendar')
@UseInterceptors(CalendarResponseInterceptor)
export class CalendarIntegrationsController {
  constructor(
    private readonly accounts: CalendarAccountsService,
    private readonly sync: CalendarSyncService,
    private readonly calendars: CalendarsService,
    private readonly providers: CalendarProvidersService,
  ) {}

  @Get('accounts')
  @ApiOperation({
    summary: 'External calendar accounts this person has connected',
  })
  @ApiResponse({
    status: 200,
    description: 'Accounts returned, never their tokens',
  })
  async listAccounts(@CurrentUser() user: RequestUser) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.accounts.listForUser(user.userId, user.organizationId);
  }

  @Get('accounts/connect/:provider')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Where to send the person to connect an outside calendar',
  })
  @ApiParam({
    name: 'provider',
    description: 'google, microsoft or calendly',
  })
  @ApiResponse({ status: 200, description: 'Sign-in address returned' })
  async connect(
    @Param('provider', new ZodValidationPipe(calendarProviderParamSchema)) provider: string,
    @CurrentUser() user: RequestUser,
    @Req() req?: Request,
    @Query('return_to') returnTo?: string,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    // Blocked while impersonating on purpose: otherwise an administrator would attach their own
    // account to somebody else.
    return {
      url: this.providers.get(provider).authorizeUrl(
        // Their own address travels with the flow, so they come back to the tenant they left. It is
        // sent by the browser because the API is reached through a rewrite, which forwards no origin.
        createState(
          user.userId,
          user.organizationId,
          provider,
          ownAddress(returnTo ?? req?.headers.origin),
        ),
      ),
    };
  }

  @Post('accounts/ics')
  @ImpersonationBlocked()
  @ApiOperation({
    summary: 'Connect an Apple or other published calendar by its link',
  })
  @ApiResponse({ status: 201, description: 'Link accepted and stored' })
  async connectIcs(
    @Body() dto: ConnectIcsDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    const api = this.providers.get('ics');

    // Read it once before storing it: a link that answers nothing is not worth keeping.
    const found = await api.listCalendars(dto.url);

    await this.accounts.save({
      organizationId: user.organizationId,
      userId: user.userId,
      provider: 'ics',
      externalAccountId: dto.url,
      displayName: dto.name ?? found[0]?.name ?? null,
      accessToken: dto.url,
      refreshToken: null,
      expiresAt: null,
      scope: null,
    });

    return { connected: true, name: found[0]?.name ?? null };
  }

  @Delete('accounts/:id')
  @ImpersonationBlocked()
  @ApiOperation({
    summary:
      'Disconnect an account; calendars keep their entries and stop syncing',
  })
  @ApiParam({ name: 'id', description: 'Account UUID' })
  @ApiResponse({ status: 200, description: 'Account disconnected' })
  async disconnect(@Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string, @CurrentUser() user: RequestUser) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.accounts.disconnect(
      id,
      user.userId,
      user.organizationId,
      (provider, token) => this.providers.get(provider).revoke?.(token),
    );
  }

  @Get('accounts/:id/calendars')
  @ApiOperation({ summary: 'The calendars that account can offer' })
  @ApiParam({ name: 'id', description: 'Account UUID' })
  @ApiResponse({ status: 200, description: 'External calendars returned' })
  async externalCalendars(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.sync.listExternalCalendars(
      id,
      user.userId,
      user.organizationId,
    );
  }

  @Put('calendars/:id/sync')
  @ApiOperation({ summary: 'Link a calendar to an external one' })
  @ApiParam({ name: 'id', description: 'Calendar UUID' })
  @ApiResponse({ status: 200, description: 'Linked' })
  @ApiResponse({
    status: 400,
    description: 'That external calendar is already linked here',
  })
  async link(
    @Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string,
    @Body() dto: LinkCalendarSyncDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.sync.link(id, dto, user.userId, user.organizationId);
  }

  @Delete('calendars/:id/sync')
  @ApiOperation({ summary: 'Stop syncing; imported entries stay' })
  @ApiParam({ name: 'id', description: 'Calendar UUID' })
  @ApiResponse({ status: 200, description: 'Unlinked' })
  async unlink(@Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string, @CurrentUser() user: RequestUser) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.sync.unlink(id, user.userId, user.organizationId);
  }

  @Post('calendars/:id/sync/run')
  @ApiOperation({ summary: 'Bring changes in now' })
  @ApiParam({ name: 'id', description: 'Calendar UUID' })
  @ApiResponse({
    status: 201,
    description: 'Counts of what came in and what was removed',
  })
  async runNow(@Param('id', new ZodValidationPipe(calendarIdParamSchema)) id: string, @CurrentUser() user: RequestUser) {
    await this.calendars.assertModuleEnabled(user.organizationId);

    return this.sync.runNow(id, user.userId, user.organizationId);
  }
}
