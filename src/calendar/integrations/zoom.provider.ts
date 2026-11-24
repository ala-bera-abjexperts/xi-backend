/**
 * @fileoverview Zoom: a person's own sign-in, used to make meetings for calendar entries.
 *
 * Zoom holds no calendars: the account makes meetings, and its scheduled meetings can be imported as one feed.
 * The sign-in uses PKCE on top of the client secret, with the verifier derived from the signed state
 * so nothing has to be stored between the redirect and the callback.
 */
import { createHash, createHmac } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';

import { integrationFetch } from '../../automations/actions/integrations/http-utils';
import type {
  CalendarProviderApi,
  ExternalCalendar,
  ExternalEvent,
  ProviderTokens,
} from './calendar-provider';
import { secret } from './calendar-oauth.state';

const AUTH_URL = 'https://zoom.us/oauth/authorize';

const TOKEN_URL = 'https://zoom.us/oauth/token';

const REVOKE_URL = 'https://zoom.us/oauth/revoke';

const API = 'https://api.zoom.us/v2';

/** The one feed a Zoom account offers: its scheduled meetings. */
export const ZOOM_FEED_ID = 'zoom-meetings';

const MAX_MEETING_PAGES = 10;

const MAX_RECURRING_LOOKUPS = 50;

/** Zoom's meeting list cuts each agenda to this many characters. */
const AGENDA_LIST_LIMIT = 250;

/** The longest a rate-limited request waits before its one retry. */
const MAX_RETRY_WAIT_MS = 5_000;

interface ZoomMeeting {
  id: number | string;
  type?: number;
  topic?: string;
  agenda?: string;
  start_time?: string;
  duration?: number;
  timezone?: string;
  join_url?: string;
  occurrences?: {
    occurrence_id: string;
    start_time?: string;
    duration?: number;
    status?: string;
  }[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** One meeting, or one occurrence of it, as an entry; changed in Zoom, so read-only here. */
function zoomEvent(
  meeting: ZoomMeeting,
  slot: {
    externalId: string;
    start: string;
    duration?: number;
    cancelled: boolean;
  },
): ExternalEvent {
  const start = Date.parse(slot.start);
  const minutes = slot.duration && slot.duration > 0 ? slot.duration : 0;
  const agenda = meeting.agenda?.trim();

  return {
    external_id: slot.externalId,
    etag: null,
    summary: meeting.topic?.trim() || 'Zoom meeting',
    description: agenda
      ? `<p>${escapeHtml(agenda).slice(0, 19_990)}</p>`
      : null,
    location: null,
    is_all_day: false,
    starts_at: new Date(start).toISOString(),
    ends_at: new Date(start + minutes * 60_000).toISOString(),
    start_date: null,
    end_date: null,
    timezone: meeting.timezone || null,
    meeting_url: meeting.join_url ?? null,
    cancelled: slot.cancelled,
    read_only: true,
    recurring_id: String(meeting.id),
    updated_at: null,
  };
}

@Injectable()
export class ZoomProvider implements CalendarProviderApi {
  readonly provider = 'zoom' as const;

  private get clientId(): string {
    return process.env.ZOOM_OAUTH_CLIENT_ID ?? '';
  }

  private get clientSecret(): string {
    return process.env.ZOOM_OAUTH_CLIENT_SECRET ?? '';
  }

  /** Whether this server has a Zoom app to sign people in with. */
  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  redirectUri(): string {
    // Zoom only accepts an address on its allow list; a Zoom-only setting keeps the other providers where they are,
    // and an empty line in .env counts as not set.
    const base = (
      process.env.ZOOM_OAUTH_REDIRECT_BASE_URL ||
      process.env.CALENDAR_OAUTH_BASE_URL ||
      process.env.APP_URL ||
      process.env.FRONTEND_URL ||
      ''
    ).replace(/\/$/, '');

    return `${base}/api/v1/calendar/oauth/zoom/callback`;
  }

  authorizeUrl(state: string): string {
    if (!this.configured) {
      throw new BadRequestException(
        'Zoom is not configured on this server (ZOOM_OAUTH_CLIENT_ID is missing).',
      );
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri(),
      state,
      code_challenge: createHash('sha256')
        .update(this.verifier(state))
        .digest('base64url'),
      code_challenge_method: 'S256',
    });

    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, state?: string): Promise<ProviderTokens> {
    if (!state) throw new BadRequestException('expired');

    return this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(),
      code_verifier: this.verifier(state),
    });
  }

  /** Zoom rotates refresh tokens, so the new one is handed back to replace the stored one. */
  async refresh(refreshToken: string): Promise<{
    accessToken: string;
    expiresAt: string | null;
    refreshToken?: string | null;
  }> {
    const tokens = await this.token({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    return {
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      refreshToken: tokens.refreshToken,
    };
  }

  async identity(
    accessToken: string,
  ): Promise<{ id: string; email: string | null }> {
    const res = await integrationFetch(`${API}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const data = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!res.ok) {
      throw new BadRequestException(
        `Zoom did not say who signed in: ${(data.message as string) ?? res.statusText} (${res.status})`,
      );
    }

    return {
      id:
        typeof data.id === 'string' || typeof data.id === 'number'
          ? String(data.id)
          : '',
      email: (data.email as string) ?? null,
    };
  }

  /** Zoom has no calendars of its own, so a person's scheduled meetings are offered as one feed. */
  async listCalendars(accessToken: string): Promise<ExternalCalendar[]> {
    const me = await this.zoomGet(accessToken, '/users/me');
    const name = [me.first_name, me.last_name]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(' ');

    return [
      {
        id: ZOOM_FEED_ID,
        name: name ? `${name} — Zoom meetings` : 'Zoom meetings',
        primary: true,
        timezone: typeof me.timezone === 'string' ? me.timezone : null,
        access: 'reader',
      },
    ];
  }

  /**
   * Every scheduled meeting in the window, recurring ones as one entry per occurrence.
   * `complete` is false when a cap was hit, so the caller never treats a partial read as the whole list.
   */
  async listEvents(
    accessToken: string,
    _calendarId: string,
    options: { from?: string; to?: string },
  ): Promise<{
    events: ExternalEvent[];
    nextSyncToken: string | null;
    expired: boolean;
    complete: boolean;
  }> {
    const from = options.from ? Date.parse(options.from) : -Infinity;
    const to = options.to ? Date.parse(options.to) : Infinity;
    const events: ExternalEvent[] = [];
    let complete = true;
    let lookups = 0;
    let pageToken = '';

    for (let page = 0; ; page++) {
      if (page === MAX_MEETING_PAGES) {
        complete = false;
        break;
      }

      const params = new URLSearchParams({
        type: 'scheduled',
        page_size: '300',
      });

      if (pageToken) params.set('next_page_token', pageToken);

      const data = await this.zoomGet(
        accessToken,
        `/users/me/meetings?${params.toString()}`,
      );

      for (const meeting of (data.meetings as ZoomMeeting[]) ?? []) {
        if (meeting.type === 8) {
          if (lookups === MAX_RECURRING_LOOKUPS) {
            complete = false;
            continue;
          }

          lookups++;

          const full = (await this.zoomGet(
            accessToken,
            `/meetings/${encodeURIComponent(String(meeting.id))}`,
          )) as unknown as ZoomMeeting;

          for (const occurrence of full.occurrences ?? []) {
            const at = Date.parse(occurrence.start_time ?? '');

            if (Number.isNaN(at) || at < from || at > to) continue;

            events.push(
              zoomEvent(full, {
                externalId: `${String(full.id)}:${occurrence.occurrence_id}`,
                start: occurrence.start_time as string,
                duration: occurrence.duration ?? full.duration,
                cancelled: occurrence.status === 'deleted',
              }),
            );
          }

          continue;
        }

        // Instant meetings and recurring ones with no fixed time have no slot to show.
        if (meeting.type !== 2 || !meeting.start_time) continue;

        const at = Date.parse(meeting.start_time);

        if (Number.isNaN(at) || at < from || at > to) continue;

        // The list cuts the agenda at 250 characters; the meeting itself has the full text.
        let detailed = meeting;

        if (
          meeting.agenda?.length === AGENDA_LIST_LIMIT &&
          lookups < MAX_RECURRING_LOOKUPS
        ) {
          lookups++;
          detailed = {
            ...meeting,
            agenda: (
              (await this.zoomGet(
                accessToken,
                `/meetings/${encodeURIComponent(String(meeting.id))}`,
              )) as unknown as ZoomMeeting
            ).agenda,
          };
        }

        events.push(
          zoomEvent(detailed, {
            externalId: String(meeting.id),
            start: meeting.start_time,
            duration: meeting.duration,
            cancelled: false,
          }),
        );
      }

      pageToken =
        typeof data.next_page_token === 'string' ? data.next_page_token : '';

      if (!pageToken) break;
    }

    return { events, nextSyncToken: null, expired: false, complete };
  }

  private async zoomGet(
    accessToken: string,
    path: string,
    retried = false,
  ): Promise<Record<string, unknown>> {
    const res = await integrationFetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // Rate limited: wait what Zoom asks (1 s if it does not say, at most 5 s) and try once more.
    if (res.status === 429 && !retried) {
      const asked = Number(res.headers.get('Retry-After')) * 1000;

      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(asked > 0 ? asked : 1000, MAX_RETRY_WAIT_MS),
        ),
      );

      return this.zoomGet(accessToken, path, true);
    }

    const data = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!res.ok) {
      throw new BadRequestException(
        `Zoom request failed: ${(data.message as string) ?? res.statusText} (${res.status})`,
      );
    }

    return data;
  }

  async revoke(accessToken: string): Promise<void> {
    const res = await integrationFetch(REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.basic()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ token: accessToken }).toString(),
    });

    if (!res.ok) {
      throw new Error(`Zoom did not revoke the sign-in (${res.status})`);
    }
  }

  /** The PKCE verifier for one sign-in, rebuilt from its signed state rather than stored. */
  private verifier(state: string): string {
    return createHmac('sha256', secret())
      .update(`zoom-pkce:${state}`)
      .digest('base64url');
  }

  private basic(): string {
    return Buffer.from(`${this.clientId}:${this.clientSecret}`).toString(
      'base64',
    );
  }

  private async token(extra: Record<string, string>): Promise<ProviderTokens> {
    const res = await integrationFetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.basic()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(extra).toString(),
    });

    const data = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!res.ok || typeof data.access_token !== 'string') {
      const reason =
        (data.reason as string) ??
        (data.error_description as string) ??
        (data.error as string) ??
        res.statusText;

      throw new BadRequestException(
        `Zoom refused the sign-in: ${reason} (${res.status})`,
      );
    }

    return {
      accessToken: data.access_token,
      refreshToken: (data.refresh_token as string) ?? null,
      expiresAt:
        typeof data.expires_in === 'number'
          ? new Date(Date.now() + data.expires_in * 1000).toISOString()
          : null,
      scope: (data.scope as string) ?? null,
    };
  }
}
