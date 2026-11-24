/**
 * @fileoverview Calendly: sign-in and the person's booked meetings.
 *
 * Calendly has no calendars to choose from — a person has one stream of scheduled events — so it
 * offers a single feed, and nothing written here is ever sent back to it.
 */
import { BadRequestException, Injectable } from '@nestjs/common';

import { integrationFetch } from '../../automations/actions/integrations/http-utils';
import type {
  CalendarProviderApi,
  ExternalCalendar,
  ExternalEvent,
  ProviderTokens,
} from './calendar-provider';

const AUTH_URL = 'https://auth.calendly.com/oauth/authorize';

const TOKEN_URL = 'https://auth.calendly.com/oauth/token';

const API = 'https://api.calendly.com';

/** The one feed a Calendly account offers. */
const FEED_ID = 'scheduled_events';

@Injectable()
export class CalendlyProvider implements CalendarProviderApi {
  readonly provider = 'calendly' as const;

  private get clientId(): string {
    return process.env.CALENDLY_CLIENT_ID ?? '';
  }

  private get clientSecret(): string {
    return process.env.CALENDLY_CLIENT_SECRET ?? '';
  }

  redirectUri(): string {
    const base = (
      process.env.APP_URL ??
      process.env.FRONTEND_URL ??
      ''
    ).replace(/\/$/, '');

    return `${base}/api/v1/calendar/oauth/calendly/callback`;
  }

  authorizeUrl(state: string): string {
    if (!this.clientId) {
      throw new BadRequestException(
        'Calendly is not configured on this server (CALENDLY_CLIENT_ID is missing).',
      );
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri(),
      state,
    });

    return `${AUTH_URL}?${params.toString()}`;
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
    const me = await this.me(accessToken);

    return { id: me.uri, email: me.email };
  }

  async listCalendars(accessToken: string): Promise<ExternalCalendar[]> {
    const me = await this.me(accessToken);

    return [
      {
        id: FEED_ID,
        name: me.name ? `${me.name} — Calendly` : 'Calendly',
        primary: true,
        timezone: me.timezone,
        access: 'reader',
      },
    ];
  }

  /** Calendly pages by token but offers no delta, so each read covers the window again. */
  async listEvents(
    accessToken: string,
    _calendarId: string,
    options: { from?: string; to?: string },
  ): Promise<{
    events: ExternalEvent[];
    nextSyncToken: string | null;
    expired: boolean;
  }> {
    const me = await this.me(accessToken);
    const events: ExternalEvent[] = [];

    let pageToken: string | undefined;

    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ user: me.uri, count: '100' });

      if (options.from) params.set('min_start_time', options.from);
      if (options.to) params.set('max_start_time', options.to);
      if (pageToken) params.set('page_token', pageToken);

      const res = await integrationFetch(
        `${API}/scheduled_events?${params.toString()}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      const data = (await res.json()) as Record<string, unknown>;

      if (!res.ok) {
        throw new BadRequestException(
          `Calendly: ${(data.message as string) ?? res.statusText}`,
        );
      }

      for (const item of (data.collection as Record<string, unknown>[]) ?? []) {
        events.push(this.toExternalEvent(item));
      }

      pageToken =
        ((data.pagination as Record<string, unknown>)
          ?.next_page_token as string) ?? undefined;

      if (!pageToken) break;
    }

    return { events, nextSyncToken: null, expired: false };
  }

  private toExternalEvent(item: Record<string, unknown>): ExternalEvent {
    const location = item.location as
      | { join_url?: string; location?: string; type?: string }
      | undefined;
    const uri = item.uri as string;

    return {
      external_id: uri,
      etag: (item.updated_at as string) ?? null,
      // A missing title stays empty so the sync can skip the entry
      summary: (item.name as string) || '',
      description: null,
      location: location?.join_url ? null : (location?.location ?? null),
      is_all_day: false,
      starts_at: (item.start_time as string) ?? null,
      ends_at: (item.end_time as string) ?? null,
      start_date: null,
      end_date: null,
      timezone: null,
      meeting_url: location?.join_url ?? null,
      cancelled: (item.status as string) === 'canceled',

      // Booked through Calendly, so it is changed there, not here.
      read_only: true,
      recurring_id: null,
      updated_at: (item.updated_at as string) ?? null,
    };
  }

  private async me(accessToken: string): Promise<{
    uri: string;
    email: string | null;
    name: string | null;
    timezone: string | null;
  }> {
    const res = await integrationFetch(`${API}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      throw new BadRequestException(
        `Calendly: ${(data.message as string) ?? res.statusText}`,
      );
    }

    const resource = (data.resource as Record<string, unknown>) ?? {};

    return {
      uri: (resource.uri as string) ?? '',
      email: (resource.email as string) ?? null,
      name: (resource.name as string) ?? null,
      timezone: (resource.timezone as string) ?? null,
    };
  }

  private async token(extra: Record<string, string>): Promise<ProviderTokens> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      ...extra,
    });

    const res = await integrationFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      throw new BadRequestException(
        `Calendly refused the sign-in: ${(data.error_description as string) ?? (data.error as string) ?? res.statusText}`,
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
}
