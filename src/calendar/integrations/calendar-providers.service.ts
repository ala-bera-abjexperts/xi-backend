/**
 * @fileoverview Which implementation answers for which provider, in one place.
 */
import { BadRequestException, Injectable } from '@nestjs/common';

import { AppleIcsProvider } from './apple-ics.provider';
import type { CalendarProvider } from './calendar-accounts.service';
import type { CalendarProviderApi } from './calendar-provider';
import { CalendlyProvider } from './calendly.provider';
import { GoogleCalendarProvider } from './google-calendar.provider';
import { MicrosoftCalendarProvider } from './microsoft-calendar.provider';
import { ZoomProvider } from './zoom.provider';

/** Connected by pasting a published link rather than by signing in. */
const LINK_BASED: CalendarProvider[] = ['ics'];

@Injectable()
export class CalendarProvidersService {
  constructor(
    private readonly google: GoogleCalendarProvider,
    private readonly microsoft: MicrosoftCalendarProvider,
    private readonly calendly: CalendlyProvider,
    private readonly apple: AppleIcsProvider,
    private readonly zoom: ZoomProvider,
  ) {}

  get(provider: string): CalendarProviderApi {
    switch (provider) {
      case 'google':
        return this.google;
      case 'microsoft':
        return this.microsoft;
      case 'calendly':
        return this.calendly;
      case 'ics':
        return this.apple;
      case 'zoom':
        return this.zoom;
      default:
        throw new BadRequestException(`Unknown calendar provider "${provider}"`);
    }
  }

  isLinkBased(provider: string): boolean {
    return LINK_BASED.includes(provider as CalendarProvider);
  }
}
