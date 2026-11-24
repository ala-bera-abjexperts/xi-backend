/**
 * @fileoverview Microsoft 365 calendars through Graph: sign-in, refresh, listing and reading changes.
 *
 * Uses the same Azure app registration the automations already sign in with (AZURE_CLIENT_ID /
 * AZURE_CLIENT_SECRET / AZURE_TENANT_ID); only the redirect address differs, so that one address has
 * to be added to the app registration.
 */
import { BadRequestException, Injectable } from '@nestjs/common';

import { integrationFetch } from '../../automations/actions/integrations/http-utils';
import type {
  CalendarProviderApi,
  ExternalCalendar,
  ExternalEvent,
  ProviderTokens,
  OutgoingEvent,
  PushResult,
} from './calendar-provider';
import { ProviderConflictError } from './calendar-provider';

const API = 'https://graph.microsoft.com/v1.0';

/** Read and write the person's own calendars, plus a refresh token so sync survives the hour. */
const SCOPES = [
  'offline_access',
  'openid',
  'email',
  'profile',
  'https://graph.microsoft.com/Calendars.ReadWrite',
];

/** Graph hands back naive local times; asking for UTC makes every instant unambiguous. */
const UTC_PREFERENCE = 'outlook.timezone="UTC"';

@Injectable()
export class MicrosoftCalendarProvider implements CalendarProviderApi {
  readonly provider = 'microsoft' as const;

  private get clientId(): string {
    return process.env.AZURE_CLIENT_ID ?? '';
  }

  private get clientSecret(): string {
    return process.env.AZURE_CLIENT_SECRET ?? '';
  }

  /** `common` lets a personal or a work account sign in when no tenant is pinned. */
  private get tenant(): string {
    return process.env.AZURE_TENANT_ID || 'common';
  }

  private get authority(): string {
    return `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0`;
  }

  redirectUri(): string {
    const base = (
      process.env.MICROSOFT_CALENDAR_REDIRECT_BASE ??
      process.env.APP_URL ??
      process.env.FRONTEND_URL ??
      ''
    ).replace(/\/$/, '');

    return `${base}/api/v1/calendar/oauth/microsoft/callback`;
  }

  authorizeUrl(state: string): string {
    if (!this.clientId) {
      throw new BadRequestException(
        'Microsoft 365 is not configured on this server (AZURE_CLIENT_ID is missing).',
      );
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      response_mode: 'query',

      // Lets someone add another Microsoft account instead of silently reusing the signed-in one.
      prompt: 'select_account',
      scope: SCOPES.join(' '),
      state,
    });

    return `${this.authority}/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<ProviderTokens> {
    return this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(),
    });
  }

  async refresh(
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresAt: string | null }> {
    const tokens = await this.token({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  }

  async identity(
    accessToken: string,
  ): Promise<{ id: string; email: string | null }> {
    const res = await integrationFetch(`${API}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) return { id: '', email: null };

    const data = (await res.json()) as {
      id?: string;
      mail?: string;
      userPrincipalName?: string;
    };
    const email = data.mail ?? data.userPrincipalName ?? null;

    return { id: data.id ?? email ?? '', email };
  }

  async listCalendars(accessToken: string): Promise<ExternalCalendar[]> {
    const res = await integrationFetch(`${API}/me/calendars?$top=100`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) throw this.graphError(data, res.statusText);

    return ((data.value as Record<string, unknown>[]) ?? []).map((item) => ({
      id: item.id as string,
      name: (item.name as string) ?? (item.id as string),
      primary: item.isDefaultCalendar === true,
      timezone: null,
      access: (item.canEdit as boolean) === false ? 'reader' : 'owner',
    }));
  }

  /**
   * Graph's delta feed over a calendar view. The first read needs the window; after that the delta
   * link carries the position, and a 410 means it went stale and the caller starts over.
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

    let url = options.syncToken ?? this.firstPageUrl(calendarId, options);
    let nextSyncToken: string | null = null;

    // A window is wide; without a ceiling one bad feed could page forever.
    for (let page = 0; page < 20; page++) {
      const res = await integrationFetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: `${UTC_PREFERENCE}, odata.maxpagesize=100`,
        },
      });

      if (res.status === 410) {
        return { events: [], nextSyncToken: null, expired: true };
      }

      const data = (await res.json()) as Record<string, unknown>;

      if (!res.ok) throw this.graphError(data, res.statusText);

      for (const item of (data.value as Record<string, unknown>[]) ?? []) {
        events.push(this.toExternalEvent(item));
      }

      const nextLink = data['@odata.nextLink'] as string | undefined;
      const deltaLink = data['@odata.deltaLink'] as string | undefined;

      if (deltaLink) nextSyncToken = deltaLink;

      if (!nextLink) break;

      url = nextLink;
    }

    return { events, nextSyncToken, expired: false };
  }

  private firstPageUrl(
    calendarId: string,
    options: { from?: string; to?: string },
  ): string {
    const params = new URLSearchParams({
      startDateTime: options.from ?? new Date().toISOString(),
      endDateTime:
        options.to ?? new Date(Date.now() + 90 * 86_400_000).toISOString(),
    });

    return `${API}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?${params.toString()}`;
  }

  /** Graph wants a wall time plus its zone; instants go out in UTC, whole days as midnights in the entry's zone. */
  private static body(event: OutgoingEvent): Record<string, unknown> {
    const wall = (instant: string | null) =>
      instant ? new Date(instant).toISOString().slice(0, 19) : null;

    return {
      subject: event.summary,
      body: { contentType: 'HTML', content: event.description ?? '' },
      location: { displayName: event.location ?? '' },
      isAllDay: event.is_all_day,
      start: event.is_all_day
        ? { dateTime: `${event.start_date}T00:00:00`, timeZone: event.timezone }
        : { dateTime: wall(event.starts_at), timeZone: 'UTC' },
      end: event.is_all_day
        ? { dateTime: `${event.end_date}T00:00:00`, timeZone: event.timezone }
        : { dateTime: wall(event.ends_at), timeZone: 'UTC' },
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

        // Graph versions an event by its changeKey; anything newer there answers 412 instead.
        ...(etag ? { 'If-Match': `W/"${etag}"` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 412)
      throw new ProviderConflictError(
        'Changed in Microsoft Outlook since the last sync',
      );

    // Already gone at Microsoft is what a delete wanted anyway.
    if (method === 'DELETE' && res.status === 404) return null;

    const data =
      method === 'DELETE'
        ? {}
        : ((await res.json().catch(() => ({}))) as Record<string, unknown>);

    if (!res.ok) throw this.graphError(data, res.statusText);

    return method === 'DELETE' ? null : data;
  }

  async createEvent(
    accessToken: string,
    calendarId: string,
    event: OutgoingEvent,
  ): Promise<PushResult> {
    const data = await this.write(
      accessToken,
      'POST',
      `/me/calendars/${encodeURIComponent(calendarId)}/events`,
      MicrosoftCalendarProvider.body(event),
    );

    return {
      external_id: data?.id as string,
      etag: (data?.changeKey as string) ?? null,
    };
  }

  async updateEvent(
    accessToken: string,
    _calendarId: string,
    externalId: string,
    event: OutgoingEvent,
    etag: string | null,
  ): Promise<PushResult> {
    const data = await this.write(
      accessToken,
      'PATCH',
      `/me/events/${encodeURIComponent(externalId)}`,
      MicrosoftCalendarProvider.body(event),
      etag,
    );

    return {
      external_id: externalId,
      etag: (data?.changeKey as string) ?? null,
    };
  }

  async deleteEvent(
    accessToken: string,
    _calendarId: string,
    externalId: string,
  ): Promise<void> {
    await this.write(
      accessToken,
      'DELETE',
      `/me/events/${encodeURIComponent(externalId)}`,
    );
  }

  private toExternalEvent(item: Record<string, unknown>): ExternalEvent {
    const start = (item.start as Record<string, string>) ?? {};
    const end = (item.end as Record<string, string>) ?? {};
    const allDay = item.isAllDay === true;
    const online = item.onlineMeeting as { joinUrl?: string } | undefined;
    const body = item.body as { content?: string } | undefined;
    const location = item.location as { displayName?: string } | undefined;

    // A removed event arrives as a tombstone carrying nothing but its id.
    const removed = Boolean(item['@removed']);

    return {
      external_id: item.id as string,
      etag: (item.changeKey as string) ?? null,
      // A missing title stays empty so the sync can skip the entry
      summary: (item.subject as string) || '',
      description: body?.content ?? (item.bodyPreview as string) ?? null,
      location: location?.displayName ?? null,
      is_all_day: allDay,
      starts_at: allDay ? null : this.instant(start.dateTime),
      ends_at: allDay ? null : this.instant(end.dateTime),
      start_date: allDay ? this.dayOnly(start.dateTime) : null,
      end_date: allDay ? this.dayOnly(end.dateTime) : null,
      timezone: start.timeZone ?? null,
      meeting_url: online?.joinUrl ?? (item.onlineMeetingUrl as string) ?? null,
      cancelled: removed || item.isCancelled === true,
      read_only: item.isOrganizer === false,
      recurring_id: (item.seriesMasterId as string) ?? null,
      updated_at: (item.lastModifiedDateTime as string) ?? null,
    };
  }

  /** Graph writes `2026-09-25T09:00:00.0000000` with the zone beside it; asked for UTC, it is an instant. */
  private instant(value: string | undefined): string | null {
    if (!value) return null;

    const trimmed = value.replace(/\.\d+$/, '');

    return /[zZ]|[+-]\d{2}:\d{2}$/.test(trimmed)
      ? new Date(trimmed).toISOString()
      : new Date(`${trimmed}Z`).toISOString();
  }

  private dayOnly(value: string | undefined): string | null {
    return value ? value.slice(0, 10) : null;
  }

  private async token(extra: Record<string, string>): Promise<ProviderTokens> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: SCOPES.join(' '),
      ...extra,
    });

    const res = await integrationFetch(`${this.authority}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      throw new BadRequestException(
        `Microsoft refused the sign-in: ${(data.error_description as string) ?? (data.error as string) ?? res.statusText}`,
      );
    }

    return {
      accessToken: data.access_token as string,
      refreshToken: (data.refresh_token as string) ?? null,
      expiresAt: data.expires_in
        ? new Date(
            Date.now() + (data.expires_in as number) * 1000,
          ).toISOString()
        : null,
      scope: (data.scope as string) ?? null,
    };
  }

  private graphError(
    data: Record<string, unknown>,
    fallback: string,
  ): BadRequestException {
    const error = data.error as Record<string, unknown> | undefined;

    return new BadRequestException(
      `Microsoft 365: ${(error?.message as string) ?? fallback}`,
    );
  }
}
