/**
 * @fileoverview What every outside calendar has to offer this module, so the sync service can work
 * against one shape instead of knowing each vendor.
 */
import type { CalendarProvider } from './calendar-accounts.service';

export interface ExternalCalendar {
  id: string;
  name: string;
  primary: boolean;
  timezone: string | null;
  access: string | null;
}

export interface ExternalEvent {
  external_id: string;
  etag: string | null;
  summary: string;
  description: string | null;
  location: string | null;
  is_all_day: boolean;
  starts_at: string | null;
  ends_at: string | null;
  start_date: string | null;
  end_date: string | null;
  timezone: string | null;
  meeting_url: string | null;
  cancelled: boolean;
  read_only: boolean;
  recurring_id: string | null;
  updated_at: string | null;
}

/** An entry as it is sent out to a provider that can be written to. */
export interface OutgoingEvent {
  summary: string;
  description: string | null;
  location: string | null;
  is_all_day: boolean;
  starts_at: string | null;
  ends_at: string | null;
  start_date: string | null;
  end_date: string | null;
  timezone: string;
}

/** What a provider hands back after a write: its id for the event and the version it now holds. */
export interface PushResult {
  external_id: string;
  etag: string | null;
}

/** The event changed at the provider since it was last read, so it is not overwritten. */
export class ProviderConflictError extends Error {}

export interface ProviderTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scope: string | null;
}

export interface CalendarProviderApi {
  readonly provider: CalendarProvider;

  /** Where the vendor sends the person back; must match the app registered with them. */
  redirectUri(): string;

  authorizeUrl(state: string): string;

  /** `state` is the signed value the sign-in started with; a provider using PKCE derives its verifier from it. */
  exchangeCode(code: string, state?: string): Promise<ProviderTokens>;

  /** A provider that rotates refresh tokens returns the new one, which must replace the stored one. */
  refresh(refreshToken: string): Promise<{
    accessToken: string;
    expiresAt: string | null;
    refreshToken?: string | null;
  }>;

  /** Withdraws the app's access at the provider; only providers that offer it implement this. */
  revoke?(accessToken: string): Promise<void>;

  /** Who the tokens belong to, so the account row can name itself. */
  identity(accessToken: string): Promise<{ id: string; email: string | null }>;

  listCalendars(accessToken: string): Promise<ExternalCalendar[]>;

  /**
   * Changes since the last read. `expired` tells the caller its token is no good and the next read
   * must start from the window again.
   */
  listEvents(
    accessToken: string,
    calendarId: string,
    options: { syncToken?: string | null; from?: string; to?: string },
  ): Promise<{
    events: ExternalEvent[];
    nextSyncToken: string | null;
    expired: boolean;

    /** The whole window was read, so an entry it no longer lists is gone at the provider. */
    complete?: boolean;
  }>;

  /** Writing back. Only providers that can be written to have these; a published link cannot. */
  createEvent?(
    accessToken: string,
    calendarId: string,
    event: OutgoingEvent,
  ): Promise<PushResult>;
  updateEvent?(
    accessToken: string,
    calendarId: string,
    externalId: string,
    event: OutgoingEvent,
    etag: string | null,
  ): Promise<PushResult>;
  deleteEvent?(
    accessToken: string,
    calendarId: string,
    externalId: string,
  ): Promise<void>;
}
