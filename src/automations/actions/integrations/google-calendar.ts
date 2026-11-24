import { z } from 'zod';

import type { ActionDefinition, ExecutionContext } from '../types';
import { integrationFetch } from './http-utils';
import { unpackStoredSecret } from '../../../lib/crypto/encryption';
import { hasUnresolvedPlaceholder } from '../../utils/template';

async function getAccessToken(conn: {
  decryptedSecret: string;
  metadata: Record<string, unknown>;
}): Promise<string> {
  const refreshToken = unpackStoredSecret(
    (conn.metadata as Record<string, string>).refresh_token,
  );
  if (!refreshToken) return conn.decryptedSecret;

  // Exchange refresh_token for a fresh access_token
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    refresh_token: refreshToken,
  });

  const res = await integrationFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = (await res.json()) as {
      error?: string;
      error_description?: string;
    };
    throw new Error(
      `Google token refresh failed: ${err.error_description ?? err.error ?? res.statusText}`,
    );
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

const DEFAULT_DURATION_MINUTES = 60;

/** Trailing "Z" or "+02:00"/"+0200" — i.e. the value pins itself to an absolute instant. */
const HAS_UTC_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse a config date/time to a comparable instant.
 *
 * A value without an offset is a wall-clock time that Google reads in the event's `timeZone`, so it
 * is parsed as UTC rather than through `new Date(value)` — the latter would apply whatever timezone
 * the worker process happens to run in, making the result depend on the server's locale.
 */
function parseInstant(value: string): Date {
  return new Date(HAS_UTC_OFFSET.test(value) ? value : `${value}Z`);
}

/**
 * Render an instant back in the same shape the start value used, so both ends of the event stay in
 * one frame of reference. Offset-less in, offset-less out — otherwise a derived end would become an
 * absolute UTC instant while the start was still being read in the event's `timeZone`, and the
 * event would come out the wrong length by that zone's offset.
 */
function formatLike(instant: Date, reference: string): string {
  const iso = instant.toISOString();

  return HAS_UTC_OFFSET.test(reference) ? iso : iso.slice(0, 19);
}

/**
 * Work out the event's start and end instants.
 *
 * Google rejects a zero-length event with "The specified time range is empty", and rejects a
 * leftover "{{ trigger.task.due_date }}" with a message that never names the field — so both are
 * caught here, where the offending expression is still available to put in the message.
 *
 * The two ends are treated differently on purpose: a start we cannot resolve is fatal, because
 * there is nothing sensible to invent, whereas a missing or nonsensical end has an obvious default.
 * That fallback is also what keeps automations already installed from the built-in templates
 * working — their stored config binds start and end to the same field.
 */
export function resolveEventWindow(conf: {
  start: string;
  end?: string;
  durationMinutes?: number;
}): { start: string; end: string } {
  const rawStart = conf.start?.trim() ?? '';

  if (!rawStart || hasUnresolvedPlaceholder(rawStart)) {
    throw new Error(
      `Google Calendar: "Start" is empty — ${rawStart || 'no value'} resolved to nothing for this trigger. ` +
        'Set a fixed start time, or pick a field the trigger actually provides.',
    );
  }

  const startAt = parseInstant(rawStart);

  if (Number.isNaN(startAt.getTime())) {
    throw new Error(
      `Google Calendar: "Start" is not a valid date/time (received "${rawStart}"). ` +
        'Use an ISO value such as 2026-06-01T10:00:00Z.',
    );
  }

  const rawEnd = conf.end?.trim() ?? '';
  const endAt =
    rawEnd && !hasUnresolvedPlaceholder(rawEnd) ? parseInstant(rawEnd) : null;

  // A usable end is passed through untouched, so an already-working config produces exactly the
  // request body it did before.
  if (
    endAt &&
    !Number.isNaN(endAt.getTime()) &&
    endAt.getTime() > startAt.getTime()
  ) {
    return { start: rawStart, end: rawEnd };
  }

  const durationMs =
    (conf.durationMinutes ?? DEFAULT_DURATION_MINUTES) * 60_000;

  return {
    start: rawStart,
    end: formatLike(new Date(startAt.getTime() + durationMs), rawStart),
  };
}

export const googleCalendarCreateEvent: ActionDefinition = {
  kind: 'integration.google_calendar.create_event',
  category: 'integration',
  type: 'action',
  label: {
    en: 'Create Google Calendar event',
    de: 'Google-Kalender-Ereignis erstellen',
  },
  description: {
    en: 'Creates a new event in Google Calendar',
    de: 'Erstellt ein neues Ereignis in Google Kalender',
  },
  icon: 'bx-calendar-event',
  requiresConnection: 'google_calendar',
  inputSchema: z.unknown(),
  configSchema: z.object({
    connectionId: z.string().uuid().optional(),
    calendarId: z.string().default('primary'),
    summary: z.string().min(1).max(500),
    start: z.string().min(1),

    // Optional: when it is missing, still a placeholder, unparseable, or not after start, the
    // handler derives it from durationMinutes. Google rejects a zero-length event outright.
    end: z.string().optional(),
    durationMinutes: z.number().int().positive().max(1440).default(60),
    description: z.string().max(5000).optional(),
    attendees: z
      .array(
        z.union([z.string().email(), z.object({ email: z.string().email() })]),
      )
      .optional(),
    timezone: z.string().default('UTC'),
    location: z.string().max(1024).optional(),
    eventType: z
      .enum(['create_event', 'create_event_with_meet'])
      .default('create_event'),
    sendUpdates: z.enum(['none', 'all', 'externalOnly']).default('none'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    eventId: z.string(),
    htmlLink: z.string(),
    meetLink: z.string().optional(),
  }),
  handler: async (config: unknown, _input: unknown, ctx: ExecutionContext) => {
    const conf = config as {
      connectionId?: string;
      calendarId?: string;
      summary: string;
      start: string;
      end?: string;
      durationMinutes?: number;
      description?: string;
      attendees?: (string | { email: string })[];
      timezone?: string;
      location?: string;
      eventType?: 'create_event' | 'create_event_with_meet';
      sendUpdates?: 'none' | 'all' | 'externalOnly';
    };

    const conn = await ctx.resolveConnection(
      'google_calendar',
      conf.connectionId,
    );
    if (!conn.decryptedSecret?.trim())
      throw new Error(
        'Google Calendar connection token is empty — revoke and re-authorize the connection',
      );
    const accessToken = await getAccessToken(conn);
    const withMeet = conf.eventType === 'create_event_with_meet';
    const calendarId = encodeURIComponent(conf.calendarId ?? 'primary');

    const { start, end } = resolveEventWindow(conf);

    const requestBody: Record<string, unknown> = {
      summary: conf.summary,
      start: { dateTime: start, timeZone: conf.timezone ?? 'UTC' },
      end: { dateTime: end, timeZone: conf.timezone ?? 'UTC' },
    };

    if (conf.description) requestBody.description = conf.description;
    if (conf.location) requestBody.location = conf.location;
    // The form builder's array widget stores attendees as a flat string[] of emails, but Google's
    // API (and older configs) use {email} objects — accept either shape and normalize to {email}.
    if (conf.attendees?.length)
      requestBody.attendees = conf.attendees.map((a) =>
        typeof a === 'string' ? { email: a } : { email: a.email },
      );

    if (withMeet) {
      requestBody.conferenceData = {
        createRequest: {
          requestId: `automation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }

    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
    );
    if (withMeet) url.searchParams.set('conferenceDataVersion', '1');
    url.searchParams.set('sendUpdates', conf.sendUpdates ?? 'none');

    const res = await integrationFetch(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const err = (await res.json()) as {
        error?: { message?: string; status?: string };
      };
      throw new Error(
        `Google Calendar API error: ${err.error?.message ?? res.statusText} (${res.status})`,
      );
    }

    const event = (await res.json()) as {
      id?: string;
      htmlLink?: string;
      conferenceData?: {
        entryPoints?: Array<{ entryPointType: string; uri: string }>;
      };
    };

    const meetLink = withMeet
      ? (event.conferenceData?.entryPoints ?? []).find(
          (ep) => ep.entryPointType === 'video',
        )?.uri
      : undefined;

    return {
      ok: true,
      eventId: event.id ?? '',
      htmlLink: event.htmlLink ?? '',
      meetLink,
    };
  },
};
