/**
 * @fileoverview Calendar module: calendars (personal or space) and their entries.
 *
 * SupabaseModule is global, so only PermissionsModule is imported here — the access rules need its
 * space-membership lookup. Nothing outside this folder is imported, and nothing imports it back.
 */
import { Module } from '@nestjs/common';

import { LicensingModule } from '../licensing/licensing.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PermissionsModule } from '../permissions/permissions.module';

import { CalendarAccessService } from './calendar-access.service';
import { CalendarRemindersService } from './calendar-reminders.service';
import { CalendarEventsController } from './calendar-events.controller';
import { CalendarEventsService } from './calendar-events.service';
import { CalendarInsightsController } from './calendar-insights.controller';
import { CalendarInsightsService } from './calendar-insights.service';
import { CalendarsController } from './calendars.controller';
import { CalendarsService } from './calendars.service';
import { CalendarAccountsService } from './integrations/calendar-accounts.service';
import { CalendarIntegrationsController } from './integrations/calendar-integrations.controller';
import { CalendarOauthController } from './integrations/calendar-oauth.controller';
import { CalendarSyncService } from './integrations/calendar-sync.service';
import { AppleIcsProvider } from './integrations/apple-ics.provider';
import { CalendarProvidersService } from './integrations/calendar-providers.service';
import { CalendarLinkTicketsController } from './calendar-link-tickets.controller';
import { CalendarLinkTicketsService } from './calendar-link-tickets.service';
import { CalendarPrincipalsService } from './calendar-principals.service';
import { CalendarAuditController } from './calendar-audit.controller';
import { CalendarAuditService } from './calendar-audit.service';
import { CalendlyProvider } from './integrations/calendly.provider';
import { GoogleCalendarProvider } from './integrations/google-calendar.provider';
import { MicrosoftCalendarProvider } from './integrations/microsoft-calendar.provider';
import { CalendarImportRecordsController } from './integrations/calendar-import-records.controller';
import { CalendarImportRecordsService } from './integrations/calendar-import-records.service';
import { CalendarZoomController } from './calendar-zoom.controller';
import { CalendarZoomMeetingController } from './calendar-zoom-meeting.controller';
import { ZoomProvider } from './integrations/zoom.provider';
import { ZoomTokensService } from './integrations/zoom-tokens.service';

@Module({
  imports: [
    PermissionsModule,
    NotificationsModule,
    MailModule,
    LicensingModule,
  ],
  controllers: [
    CalendarsController,
    CalendarEventsController,
    CalendarIntegrationsController,
    CalendarOauthController,
    CalendarImportRecordsController,
    CalendarLinkTicketsController,
    CalendarAuditController,
    CalendarInsightsController,
    CalendarZoomController,
    CalendarZoomMeetingController,
  ],
  providers: [
    CalendarAccessService,
    CalendarPrincipalsService,
    CalendarAuditService,
    CalendarsService,
    CalendarEventsService,
    CalendarAccountsService,
    CalendarSyncService,
    GoogleCalendarProvider,
    MicrosoftCalendarProvider,
    CalendlyProvider,
    AppleIcsProvider,
    ZoomProvider,
    ZoomTokensService,
    CalendarProvidersService,
    CalendarImportRecordsService,
    CalendarLinkTicketsService,
    CalendarRemindersService,
    CalendarInsightsService,
  ],
  exports: [CalendarsService, CalendarEventsService, CalendarAccessService],
})
export class CalendarModule {}
