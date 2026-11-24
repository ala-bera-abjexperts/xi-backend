/**
 * @fileoverview Apple Calendar, and any other published calendar, through its ICS feed.
 *
 * Apple gives out a public link rather than an OAuth app, so there is nothing to sign in to: the
 * person pastes the link and it is kept like a credential. The feed is read-only by nature, which is
 * why a calendar linked to one is only ever imported from.
 */
import { BadRequestException, Injectable } from '@nestjs/common';

import { integrationFetch } from '../../automations/actions/integrations/http-utils';
import type {
  CalendarProviderApi,
  ExternalCalendar,
  ExternalEvent,
  ProviderTokens,
} from './calendar-provider';

/** A feed is text; a huge one is either a mistake or an attack, and either way not worth parsing. */
const MAX_FEED_BYTES = 5_000_000;

const NOT_OAUTH =
  'An Apple or ICS calendar is connected with its published link, not by signing in.';

@Injectable()
export class AppleIcsProvider implements CalendarProviderApi {
  readonly provider = 'ics' as const;

  redirectUri(): string {
    return '';
  }

  authorizeUrl(): string {
    throw new BadRequestException(NOT_OAUTH);
  }

  exchangeCode(): Promise<ProviderTokens> {
    throw new BadRequestException(NOT_OAUTH);
  }

  refresh(): Promise<{ accessToken: string; expiresAt: string | null }> {
    // The link is the credential and it does not expire; nothing to refresh.
    throw new BadRequestException(NOT_OAUTH);
  }

  async identity(
    feedUrl: string,
  ): Promise<{ id: string; email: string | null }> {
    return { id: feedUrl, email: null };
  }

  /** The link is one calendar. Its name comes from the feed itself when it carries one. */
  async listCalendars(feedUrl: string): Promise<ExternalCalendar[]> {
    const text = await this.fetchFeed(feedUrl);
    const name =
      this.firstValue(text, 'X-WR-CALNAME') ??
      this.hostOf(feedUrl) ??
      'Calendar';

    return [
      {
        id: feedUrl,
        name,
        primary: true,
        timezone: this.firstValue(text, 'X-WR-TIMEZONE'),
        access: 'reader',
      },
    ];
  }

  /**
   * A feed has no change token: every read is the whole file, and the sync service works out what
   * moved by comparing against what it already stored.
   */
  async listEvents(
    feedUrl: string,
    _calendarId: string,
    options: { from?: string; to?: string },
  ): Promise<{
    events: ExternalEvent[];
    nextSyncToken: string | null;
    expired: boolean;
  }> {
    const text = await this.fetchFeed(feedUrl);
    const from = options.from ? new Date(options.from).getTime() : null;
    const to = options.to ? new Date(options.to).getTime() : null;

    const events = this.parse(text).filter((event) => {
      const at = new Date(
        event.starts_at ?? `${event.start_date}T00:00:00Z`,
      ).getTime();

      if (Number.isNaN(at)) return false;
      if (from !== null && at < from) return false;
      if (to !== null && at > to) return false;

      return true;
    });

    return { events, nextSyncToken: null, expired: false };
  }

  private async fetchFeed(feedUrl: string): Promise<string> {
    // Apple hands out `webcal://`, which is plain https underneath.
    const url = feedUrl.replace(/^webcal:\/\//i, 'https://');

    if (!/^https?:\/\//i.test(url)) {
      throw new BadRequestException(
        'A calendar link must start with https:// or webcal://',
      );
    }

    const res = await integrationFetch(url, {
      headers: { Accept: 'text/calendar, text/plain' },
    });

    if (!res.ok) {
      throw new BadRequestException(
        `The calendar link did not answer (${res.status}). Check that it is still published.`,
      );
    }

    const text = await res.text();

    if (text.length > MAX_FEED_BYTES) {
      throw new BadRequestException('That calendar feed is too large to read.');
    }

    if (!text.includes('BEGIN:VCALENDAR')) {
      throw new BadRequestException(
        'That link does not lead to a calendar feed.',
      );
    }

    return text;
  }

  /** Parses the VEVENT blocks. Repeating entries are taken as their first occurrence for now. */
  private parse(text: string): ExternalEvent[] {
    const lines = this.unfold(text);
    const events: ExternalEvent[] = [];
    let current: Record<string, { params: string; value: string }> | null =
      null;

    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') {
        current = {};
        continue;
      }

      if (line === 'END:VEVENT') {
        if (current) {
          const event = this.toExternalEvent(current);

          if (event) events.push(event);
        }

        current = null;
        continue;
      }

      if (!current) continue;

      const colon = line.indexOf(':');

      if (colon < 0) continue;

      const head = line.slice(0, colon);
      const semicolon = head.indexOf(';');
      const name = (
        semicolon < 0 ? head : head.slice(0, semicolon)
      ).toUpperCase();

      current[name] = {
        params: semicolon < 0 ? '' : head.slice(semicolon + 1),
        value: line.slice(colon + 1),
      };
    }

    return events;
  }

  private toExternalEvent(
    fields: Record<string, { params: string; value: string }>,
  ): ExternalEvent | null {
    const uid = fields.UID?.value;
    const start = fields.DTSTART;

    if (!uid || !start) return null;

    const allDay = /VALUE=DATE(?!-)/i.test(start.params);
    const end = fields.DTEND ?? fields.DUE;

    return {
      external_id: uid,
      etag: fields['LAST-MODIFIED']?.value ?? fields.SEQUENCE?.value ?? null,
      // A missing title stays empty so the sync can skip the entry
      summary: this.unescape(fields.SUMMARY?.value) || '',
      description: this.unescape(fields.DESCRIPTION?.value) || null,
      location: this.unescape(fields.LOCATION?.value) || null,
      is_all_day: allDay,
      starts_at: allDay ? null : this.instant(start.value),
      ends_at: allDay ? null : this.instant(end?.value),
      start_date: allDay ? this.day(start.value) : null,
      end_date: allDay ? this.day(end?.value ?? start.value) : null,
      timezone: this.tzid(start.params),
      meeting_url: fields.URL?.value ?? null,
      cancelled: (fields.STATUS?.value ?? '').toUpperCase() === 'CANCELLED',

      // Nothing written here ever reaches the feed, so every entry from one is read-only.
      read_only: true,
      recurring_id: fields['RECURRENCE-ID']?.value ?? null,
      updated_at: this.instant(fields['LAST-MODIFIED']?.value),
    };
  }

  /** RFC 5545 folds long lines by starting the continuation with a space or tab. */
  private unfold(text: string): string[] {
    const out: string[] = [];

    for (const raw of text.split(/\r?\n/)) {
      if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length > 0) {
        out[out.length - 1] += raw.slice(1);
        continue;
      }

      out.push(raw);
    }

    return out;
  }

  private instant(value: string | undefined): string | null {
    if (!value) return null;

    const match = value.match(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/,
    );

    if (!match) return null;

    const [, year, month, day, hour, minute, second, zulu] = match;

    // A local time without a zone is read as UTC; the entry keeps the feed's own TZID beside it.
    return new Date(
      `${year}-${month}-${day}T${hour}:${minute}:${second}${zulu ? 'Z' : 'Z'}`,
    ).toISOString();
  }

  private day(value: string | undefined): string | null {
    if (!value) return null;

    const match = value.match(/^(\d{4})(\d{2})(\d{2})/);

    return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  }

  private tzid(params: string): string | null {
    return params.match(/TZID=([^;:]+)/i)?.[1] ?? null;
  }

  private unescape(value: string | undefined): string {
    return (value ?? '')
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\');
  }

  private firstValue(text: string, name: string): string | null {
    return (
      this.unfold(text)
        .find((line) => line.toUpperCase().startsWith(`${name}:`))
        ?.slice(name.length + 1)
        .trim() ?? null
    );
  }

  private hostOf(value: string): string | null {
    try {
      return new URL(value.replace(/^webcal:\/\//i, 'https://')).hostname;
    } catch {
      return null;
    }
  }
}
