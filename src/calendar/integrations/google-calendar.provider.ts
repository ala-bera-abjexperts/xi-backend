/**
 * @fileoverview Google Calendar: sign-in, token refresh, listing calendars and reading changes.
 *
 * Separate from the automation action of the same name on purpose — that one is space-owned and can
 * only create. Nothing here touches it.
 */
import { BadRequestException, Injectable } from '@nestjs/common';

import { integrationFetch } from '../../automations/actions/integrations/http-utils';
import type {
  CalendarProviderApi,
  ExternalCalendar,
  ExternalEvent,
  OutgoingEvent,
  PushResult,
} from './calendar-provider';
import { ProviderConflictError } from './calendar-provider';

export type { ExternalCalendar, ExternalEvent } from './calendar-provider';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const API = 'https://www.googleapis.com/calendar/v3';

/** Read and write a person's own calendars; nothing wider. */
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
];

@Injectable()
export class GoogleCalendarProvider implements CalendarProviderApi {
  readonly provider = 'google' as const;

  private get clientId(): string {
    return process.env.GOOGLE_CLIENT_ID ?? '';
  }

  private get clientSecret(): string {
    return process.env.GOOGLE_CLIENT_SECRET ?? '';
  }

  /** Where Google sends the person back; must match a redirect URI on the Google app. */
  redirectUri(): string {
    const base = (
      process.env.APP_URL ??
      process.env.FRONTEND_URL ??
      ''
    ).replace(/\/$/, '');

    return `${base}/api/v1/calendar/oauth/google/callback`;
  }

  authorizeUrl(state: string): string {
    if (!this.clientId) {
      throw new BadRequestException(
        'Google is not configured on this server (GOOGLE_CLIENT_ID is missing).',
      );
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',

      // `consent`: without it a second connect returns no refresh token and sync dies at the first expiry.
      // `select_account`: lets someone add another Google account instead of silently reusing the signed-in one.
      prompt: 'select_account consent',
      include_granted_scopes: 'true',
      state,
    });

    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresAt: string | null;
    scope: string | null;
  }> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri(),
    });

    const res = await integrationFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      throw new BadRequestException(
        `Google refused the sign-in: ${(data.error_description as string) ?? (data.error as string) ?? res.statusText}`,
      );
    }

    return {
      accessToken: data.access_token as string,
      refreshToken: (data.refresh_token as string) ?? null,
      expiresAt: this.expiryFrom(data.expires_in as number | undefined),
      scope: (data.scope as string) ?? null,
    };
  }

  async refresh(refreshToken: string): Promise<{
    accessToken: string;
    expiresAt: string | null;
  }> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await integrationFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      throw new BadRequestException(
        `reconnect: ${(data.error_description as string) ?? (data.error as string) ?? res.statusText}`,
      );
    }

    return {
      accessToken: data.access_token as string,
      expiresAt: this.expiryFrom(data.expires_in as number | undefined),
    };
  }

  /** Who the tokens belong to, so the account row can name the connected mailbox. */
  async identity(
    accessToken: string,
  ): Promise<{ id: string; email: string | null }> {
    const res = await integrationFetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    if (!res.ok) return { id: '', email: null };

    const data = (await res.json()) as { id?: string; email?: string };

    return { id: data.id ?? data.email ?? '', email: data.email ?? null };
  }

  async listCalendars(accessToken: string): Promise<ExternalCalendar[]> {
    const res = await integrationFetch(
      `${API}/users/me/calendarList?maxResults=250`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      throw new BadRequestException(
        `Google Calendar: ${((data.error as Record<string, unknown>)?.message as string) ?? res.statusText}`,
      );
    }

    return ((data.items as Record<string, unknown>[]) ?? []).map((item) => ({
      id: item.id as string,
      name:
        (item.summaryOverride as string) ??
        (item.summary as string) ??
        (item.id as string),
      primary: item.primary === true,
      timezone: (item.timeZone as string) ?? null,
      access: (item.accessRole as string) ?? null,
    }));
  }

  /**
   * Changes since the last read.
   *
   * `syncToken` cannot be combined with a time window, so the window is applied on the first read and
   * the token carries the position after that. A 410 means the token went stale: the caller starts over.
   */
  async listEvents(
    accessToken: string,
    calendarId: string,
    options: { syncToken?: string | null; from?: string; to?: string },
  ): Promise<{
    events: ExternalEvent[];
    nextSyncToken: string | null;
    expired: boolean;
  }> {
    const events: ExternalEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;

    do {
      const params = new URLSearchParams({
        maxResults: '250',
        singleEvents: 'true',
      });

      if (options.syncToken) {
        params.set('syncToken', options.syncToken);
      } else {
        if (options.from) params.set('timeMin', options.from);
        if (options.to) params.set('timeMax', options.to);
      }

      if (pageToken) params.set('pageToken', pageToken);

      const res = await integrationFetch(
        `${API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      if (res.status === 410) {
        return { events: [], nextSyncToken: null, expired: true };
      }

      const data = (await res.json()) as Record<string, unknown>;

      if (!res.ok) {
        throw new BadRequestException(
          `Google Calendar: ${((data.error as Record<string, unknown>)?.message as string) ?? res.statusText}`,
        );
      }

      for (const item of (data.items as Record<string, unknown>[]) ?? []) {
        events.push(this.toExternalEvent(item));
      }

      pageToken = (data.nextPageToken as string) ?? undefined;
      nextSyncToken = (data.nextSyncToken as string) ?? nextSyncToken;
    } while (pageToken);

    return { events, nextSyncToken, expired: false };
  }

  /** The body Google expects: dates for a whole day, an instant plus its zone otherwise. */
  private static body(event: OutgoingEvent): Record<string, unknown> {
    return {
      summary: event.summary,
      description: event.description ?? '',
      location: event.location ?? '',
      start: event.is_all_day
        ? { date: event.start_date }
        : { dateTime: event.starts_at, timeZone: event.timezone },
      end: event.is_all_day
        ? { date: event.end_date }
        : { dateTime: event.ends_at, timeZone: event.timezone },
    };
  }

  private async write(
    accessToken: string,
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    etag?: string | null,
  ): Promise<Record<string, unknown> | null> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',

        // Only overwrite the version last read; anything newer at Google answers 412 instead.
        ...(etag ? { 'If-Match': etag } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 412)
      throw new ProviderConflictError(
        'Changed in Google Calendar since the last sync',
      );

    // Already gone at Google is what a delete wanted anyway.
    if (method === 'DELETE' && (res.status === 404 || res.status === 410))
      return null;

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const error = data.error as Record<string, unknown> | undefined;

      throw new BadRequestException(
        `Google refused the change: ${(error?.message as string) ?? res.statusText}`,
      );
    }

    return method === 'DELETE'
      ? null
      : ((await res.json()) as Record<string, unknown>);
  }

  async createEvent(
    accessToken: string,
    calendarId: string,
    event: OutgoingEvent,
  ): Promise<PushResult> {
    const data = await this.write(
      accessToken,
      'POST',
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      GoogleCalendarProvider.body(event),
    );

    return {
      external_id: data?.id as string,
      etag: (data?.etag as string) ?? null,
    };
  }

  async updateEvent(
    accessToken: string,
    calendarId: string,
    externalId: string,
    event: OutgoingEvent,
    etag: string | null,
  ): Promise<PushResult> {
    const data = await this.write(
      accessToken,
      'PATCH',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`,
      GoogleCalendarProvider.body(event),
      etag,
    );

    return { external_id: externalId, etag: (data?.etag as string) ?? null };
  }

  async deleteEvent(
    accessToken: string,
    calendarId: string,
    externalId: string,
  ): Promise<void> {
    await this.write(
      accessToken,
      'DELETE',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`,
    );
  }

  private toExternalEvent(item: Record<string, unknown>): ExternalEvent {
    const start = (item.start as Record<string, string>) ?? {};
    const end = (item.end as Record<string, string>) ?? {};
    const allDay = Boolean(start.date);
    const conference = item.conferenceData as
      | { entryPoints?: Array<{ entryPointType?: string; uri?: string }> }
      | undefined;

    return {
      external_id: item.id as string,
      etag: (item.etag as string) ?? null,
      // A missing title stays empty so the sync can skip the entry
      summary: (item.summary as string) ?? '',
      description: (item.description as string) ?? null,
      location: (item.location as string) ?? null,
      is_all_day: allDay,
      starts_at: allDay ? null : (start.dateTime ?? null),
      ends_at: allDay ? null : (end.dateTime ?? null),
      start_date: allDay ? (start.date ?? null) : null,
      end_date: allDay ? (end.date ?? null) : null,
      timezone: start.timeZone ?? null,
      meeting_url:
        (item.hangoutLink as string) ??
        (conference?.entryPoints ?? []).find(
          (point) => point.entryPointType === 'video',
        )?.uri ??
        null,
      cancelled: item.status === 'cancelled',

      // An invitation someone else owns is shown here but edited where it lives.
      read_only: item.organizer
        ? (item.organizer as Record<string, unknown>).self !== true
        : false,
      recurring_id: (item.recurringEventId as string) ?? null,
      updated_at: (item.updated as string) ?? null,
    };
  }

  private expiryFrom(seconds: number | undefined): string | null {
    return seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null;
  }
}
