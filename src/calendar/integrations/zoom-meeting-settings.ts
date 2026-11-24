/**
 * @fileoverview Reads and changes the settings of a Zoom meeting that already exists.
 *
 * Kept apart from zoom-meeting.ts so that file stays as it is; its private request helpers are
 * repeated here in their smallest form.
 */
import { zoomMeetingFields, zoomRecurrence } from './zoom-meeting';
import type { ZoomMeetingOptions, ZoomRecurrence } from './zoom-meeting';

const TOKEN_URL = 'https://zoom.us/oauth/token';

const API = 'https://api.zoom.us/v2';

const SCHEDULED = 2;

const RECURRING_FIXED = 8;

const TIMEOUT_MS = 8_000;

const REPEATS = { 1: 'daily', 2: 'weekly', 3: 'monthly' } as const;

/** What Zoom answers for one meeting; only the fields read here are named. */
export interface ZoomMeetingRecord {
  type?: unknown;
  join_url?: unknown;
  password?: unknown;
  settings?: {
    use_pmi?: unknown;
    waiting_room?: unknown;
    encryption_type?: unknown;
    host_video?: unknown;
    participant_video?: unknown;
    join_before_host?: unknown;
    mute_upon_entry?: unknown;
    auto_recording?: unknown;
    continuous_meeting_chat?: { enable?: unknown };
  };
  recurrence?: {
    type?: unknown;
    repeat_interval?: unknown;
    weekly_days?: unknown;
    monthly_day?: unknown;
    end_times?: unknown;
    end_date_time?: unknown;
  };
}

export interface ZoomMeetingSettings {
  options: ZoomMeetingOptions;
  pmi: boolean;
}

async function describe(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; reason?: unknown };
    const detail = body.message ?? body.reason;

    if (typeof detail === 'string' && detail.length > 0) return detail;
  } catch {
    // Not JSON; the status text is all there is.
  }

  return res.statusText || 'Unknown error';
}

async function zoomFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';

    throw new Error(`Zoom could not be reached: ${reason} (504)`);
  }
}

/** The server's own keys, for a meeting made before personal logins; rare, so not cached. */
async function serverToken(): Promise<string> {
  const accountId = process.env.ZOOM_ACCOUNT_ID ?? '';
  const clientId = process.env.ZOOM_CLIENT_ID ?? '';
  const clientSecret = process.env.ZOOM_CLIENT_SECRET ?? '';

  if (!accountId || !clientId || !clientSecret) {
    throw new Error('Zoom is not set up on this server (503)');
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await zoomFetch(
    `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  );

  if (!res.ok) {
    throw new Error(
      `Zoom sign-in failed: ${await describe(res)} (${res.status})`,
    );
  }

  const data = (await res.json()) as { access_token?: unknown };

  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new Error('Zoom returned no access token (502)');
  }

  return data.access_token;
}

/** One meeting as Zoom holds it. The host token it carries is never passed on. */
export async function getZoomMeeting(
  id: string,
  personToken?: string,
): Promise<ZoomMeetingRecord> {
  const token = personToken ?? (await serverToken());
  const res = await zoomFetch(`${API}/meetings/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(
      `Zoom meeting could not be read: ${await describe(res)} (${res.status})`,
    );
  }

  return (await res.json()) as ZoomMeetingRecord;
}

/**
 * Changes a meeting's settings. Zoom only takes the personal meeting ID at creation, so `use_pmi`
 * is never sent; dropping the recurrence turns the meeting back into a one-time one.
 */
export async function updateZoomMeetingSettings(
  id: string,
  options: ZoomMeetingOptions,
  wasRecurring: boolean,
  personToken?: string,
): Promise<void> {
  const token = personToken ?? (await serverToken());
  const recurrence = options.recurrence
    ? {
        type: RECURRING_FIXED,
        recurrence: zoomRecurrence(options.recurrence),
      }
    : wasRecurring
      ? { type: SCHEDULED }
      : {};

  const res = await zoomFetch(`${API}/meetings/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...zoomMeetingFields({ ...options, use_pmi: undefined }),
      // default_password=false alone leaves an existing passcode in place.
      ...(options.passcode_enabled === false ? { password: '' } : {}),
      ...recurrence,
    }),
  });

  if (res.ok) return;

  throw new Error(
    `Zoom meeting settings update failed: ${await describe(res)} (${res.status})`,
  );
}

const bool = (value: unknown): boolean => value === true;

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;

/** Zoom's recurrence in the shape the create form sends; the inverse of zoomRecurrence. */
export function zoomRecurrenceFromMeeting(
  meeting: ZoomMeetingRecord,
): ZoomRecurrence | undefined {
  const source = meeting.recurrence;
  const type =
    meeting.type === RECURRING_FIXED && source
      ? REPEATS[source.type as keyof typeof REPEATS]
      : undefined;

  if (!source || !type) return undefined;

  const result: ZoomRecurrence = {
    type,
    repeat_interval: count(source.repeat_interval) ?? 1,
  };

  if (type === 'weekly' && typeof source.weekly_days === 'string') {
    const days = source.weekly_days
      .split(',')
      .map(Number)
      .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);

    if (days.length > 0) result.weekly_days = days;
  }

  const monthlyDay = count(source.monthly_day);

  if (type === 'monthly' && monthlyDay) result.monthly_day = monthlyDay;

  if (typeof source.end_date_time === 'string' && source.end_date_time) {
    result.end_date = source.end_date_time.slice(0, 10);
  } else {
    const endTimes = count(source.end_times);

    if (endTimes) result.end_times = endTimes;
  }

  return result;
}

/** The meeting's current settings as the options form holds them. */
export function zoomOptionsFromMeeting(
  meeting: ZoomMeetingRecord,
): ZoomMeetingSettings {
  const settings = meeting.settings ?? {};
  const passcode =
    typeof meeting.password === 'string' && meeting.password !== ''
      ? meeting.password
      : undefined;
  const recurrence = zoomRecurrenceFromMeeting(meeting);

  // Zoom's own defaults stand in for a value it leaves out or that the form does not offer.
  const options: ZoomMeetingOptions = {
    use_pmi: bool(settings.use_pmi),
    passcode_enabled: passcode !== undefined,
    ...(passcode ? { passcode } : {}),
    waiting_room: bool(settings.waiting_room),
    encryption_type:
      settings.encryption_type === 'e2ee' ? 'e2ee' : 'enhanced_encryption',
    host_video: bool(settings.host_video),
    participant_video: bool(settings.participant_video),
    continuous_chat: bool(settings.continuous_meeting_chat?.enable),
    join_before_host: bool(settings.join_before_host),
    mute_upon_entry: bool(settings.mute_upon_entry),
    auto_recording:
      settings.auto_recording === 'local' || settings.auto_recording === 'cloud'
        ? settings.auto_recording
        : 'none',
    ...(recurrence ? { recurrence } : {}),
  };

  return { options, pmi: options.use_pmi === true };
}
