/**
 * @fileoverview Zoom meetings for calendar entries.
 *
 * Self-contained on purpose: the automation module has an equivalent token helper, but calendar must
 * not import from automations, so the exchange is repeated here rather than reaching across.
 */
import { randomInt } from 'node:crypto';

const TOKEN_URL = 'https://zoom.us/oauth/token';

const API = 'https://api.zoom.us/v2';

/** Scheduled meeting; webinars are out of scope. */
const SCHEDULED = 2;

/** A recurring meeting with fixed times, repeated by Zoom under one join link. */
const RECURRING_FIXED = 8;

const REPEAT_CODES = { daily: 1, weekly: 2, monthly: 3 } as const;

/** Zoom's own caps on "every N" per repeat kind. */
const REPEAT_LIMITS = { daily: 99, weekly: 50, monthly: 10 } as const;

/** Refreshed this long before Zoom's own expiry, so a call never starts with a token about to die. */
const EXPIRY_MARGIN_MS = 60_000;

/** Saving an entry waits on this, so a slow Zoom must give up well inside the request budget. */
const TIMEOUT_MS = 8_000;

/** Zoom refuses anything longer than a day on a scheduled meeting. */
const MAX_MINUTES = 1440;

const DEFAULT_MINUTES = 60;

let cached: { token: string; expiresAt: number } | null = null;

export interface ZoomMeeting {
  id: string;
  joinUrl: string;
  password: string | null;
}

export interface ZoomMeetingRequest {
  topic: string;
  startsAt: string;
  durationMinutes: number;
  timezone: string;
}

/** Choices made when the meeting is created; a field left out keeps the host's Zoom default. */
export interface ZoomMeetingOptions {
  use_pmi?: boolean;
  passcode_enabled?: boolean;
  passcode?: string;
  waiting_room?: boolean;
  encryption_type?: 'enhanced_encryption' | 'e2ee';
  host_video?: boolean;
  participant_video?: boolean;
  continuous_chat?: boolean;
  join_before_host?: boolean;
  mute_upon_entry?: boolean;
  auto_recording?: 'none' | 'local' | 'cloud';
  recurrence?: ZoomRecurrence;
}

export interface ZoomRecurrence {
  type: 'daily' | 'weekly' | 'monthly';
  repeat_interval: number;
  weekly_days?: number[];
  monthly_day?: number;
  end_times?: number;
  end_date?: string;
}

/** Zoom's recurrence object; a meeting with no end is given one, as Zoom requires it. */
export function zoomRecurrence(
  recurrence: ZoomRecurrence,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: REPEAT_CODES[recurrence.type],
    repeat_interval: Math.min(
      REPEAT_LIMITS[recurrence.type],
      Math.max(1, recurrence.repeat_interval),
    ),
  };

  if (recurrence.type === 'weekly') {
    const days = [...new Set(recurrence.weekly_days ?? [])].sort();

    if (days.length > 0) result.weekly_days = days.join(',');
  }

  if (recurrence.type === 'monthly' && recurrence.monthly_day) {
    result.monthly_day = recurrence.monthly_day;
  }

  if (recurrence.end_date) {
    result.end_date_time = `${recurrence.end_date}T23:59:59Z`;
  } else {
    result.end_times = recurrence.end_times ?? 7;
  }

  return result;
}

/** Zoom's own field names for the chosen options; only what was chosen is sent. */
export function zoomMeetingFields(
  options: ZoomMeetingOptions | undefined,
): Record<string, unknown> {
  if (!options) return {};

  const settings: Record<string, unknown> = {};
  const top: Record<string, unknown> = {};
  const copy = [
    'use_pmi',
    'waiting_room',
    'encryption_type',
    'host_video',
    'participant_video',
    'join_before_host',
    'mute_upon_entry',
    'auto_recording',
  ] as const;

  for (const key of copy) {
    if (options[key] !== undefined) settings[key] = options[key];
  }

  if (options.continuous_chat !== undefined) {
    settings.continuous_meeting_chat = { enable: options.continuous_chat };
  }

  if (options.passcode_enabled === false) {
    settings.default_password = false;
  } else if (options.passcode_enabled === true) {
    if (options.passcode) top.password = options.passcode;
    else settings.default_password = true;
  }

  return Object.keys(settings).length > 0 ? { ...top, settings } : top;
}

/**
 * Zoom answers errors as JSON, but a gateway in front of it may not — never assume a shape.
 */
async function describe(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const asRecord = body as { message?: unknown; reason?: unknown };
    const detail = asRecord.message ?? asRecord.reason;

    if (typeof detail === 'string' && detail.length > 0) return detail;
  } catch {
    // Body was not JSON; the status line below is all there is to report.
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

/**
 * An access token for the account the server is configured with.
 *
 * Cached, because a token lasts an hour and fetching one per entry would double the round trips a
 * person waits through while saving.
 */
async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;

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

  const data = (await res.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };

  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw new Error('Zoom returned no access token (502)');
  }

  const ttlSeconds =
    typeof data.expires_in === 'number' ? data.expires_in : 3600;

  cached = {
    token: data.access_token,
    expiresAt: Date.now() + ttlSeconds * 1000 - EXPIRY_MARGIN_MS,
  };

  return data.access_token;
}

/** Zoom wants a stamp with no fractional seconds; the timezone field carries the zone. */
function startStamp(value: string): string {
  const startsAt = new Date(value);

  if (Number.isNaN(startsAt.getTime())) {
    throw new Error(`Zoom start time is not a date: ${value} (400)`);
  }

  return startsAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** How long the meeting runs, taken from the entry's own times. */
export function meetingMinutes(
  startsAt: string,
  endsAt: string | null,
): number {
  const start = new Date(startsAt).getTime();
  const end = endsAt ? new Date(endsAt).getTime() : Number.NaN;

  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return DEFAULT_MINUTES;
  }

  const minutes = Math.round((end - start) / 60_000);

  return Math.min(MAX_MINUTES, Math.max(1, minutes));
}

/**
 * Schedules a meeting and hands back its join link.
 *
 * `start_url` is never read: it carries a host token, and an entry's link is seen by everyone who
 * can see the entry.
 */
export async function createZoomMeeting(
  request: ZoomMeetingRequest,
  personToken?: string,
  options?: ZoomMeetingOptions,
): Promise<ZoomMeeting> {
  const start = startStamp(request.startsAt);

  // A person's own login when given; the server's keys only for meetings made before personal logins.
  const token = personToken ?? (await accessToken());

  const res = await zoomFetch(`${API}/users/me/meetings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...zoomMeetingFields(options),
      topic: request.topic.slice(0, 200),
      type: options?.recurrence ? RECURRING_FIXED : SCHEDULED,
      ...(options?.recurrence
        ? { recurrence: zoomRecurrence(options.recurrence) }
        : {}),
      start_time: start,
      duration: request.durationMinutes,
      timezone: request.timezone,
    }),
  });

  if (!res.ok) {
    // A rejected token may have been rotated behind our back; drop it rather than replay it.
    if (res.status === 401 && !personToken) cached = null;

    throw new Error(
      `Zoom meeting creation failed: ${await describe(res)} (${res.status})`,
    );
  }

  const meeting = (await res.json()) as {
    id?: unknown;
    join_url?: unknown;
    password?: unknown;
  };

  // Zoom sends the id as a number; it is kept as text so a large id stays exact.
  const id =
    typeof meeting.id === 'number' || typeof meeting.id === 'string'
      ? String(meeting.id)
      : '';

  if (id === '' || typeof meeting.join_url !== 'string' || !meeting.join_url) {
    throw new Error('Zoom made the meeting but returned no join link (502)');
  }

  return {
    id,
    joinUrl: meeting.join_url,
    password:
      typeof meeting.password === 'string' && meeting.password !== ''
        ? meeting.password
        : null,
  };
}

/** Moves a meeting that already exists so it still matches its entry. Zoom answers 204, no body. */
export async function updateZoomMeeting(
  id: string,
  request: ZoomMeetingRequest,
  personToken?: string,
): Promise<void> {
  const start = startStamp(request.startsAt);
  const token = personToken ?? (await accessToken());

  const res = await zoomFetch(`${API}/meetings/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topic: request.topic.slice(0, 200),
      start_time: start,
      duration: request.durationMinutes,
      timezone: request.timezone,
    }),
  });

  if (res.ok) return;

  if (res.status === 401 && !personToken) cached = null;

  throw new Error(
    `Zoom meeting update failed: ${await describe(res)} (${res.status})`,
  );
}

/** Cancels a meeting. One that is already gone counts as cancelled. */
export async function cancelZoomMeeting(
  id: string,
  personToken?: string,
): Promise<void> {
  const token = personToken ?? (await accessToken());

  const res = await zoomFetch(`${API}/meetings/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.ok || res.status === 404) return;

  if (res.status === 401 && !personToken) cached = null;

  throw new Error(
    `Zoom meeting cancellation failed: ${await describe(res)} (${res.status})`,
  );
}

export interface ZoomStatus {
  configured: boolean;
  connected: boolean;
}

/** Whether this server can make meetings; the cached token keeps this to one sign-in an hour. */
export async function zoomStatus(): Promise<ZoomStatus> {
  const configured = Boolean(
    process.env.ZOOM_ACCOUNT_ID &&
    process.env.ZOOM_CLIENT_ID &&
    process.env.ZOOM_CLIENT_SECRET,
  );

  if (!configured) return { configured, connected: false };

  try {
    await accessToken();

    return { configured, connected: true };
  } catch {
    return { configured, connected: false };
  }
}

/** What the person's own Zoom account says about passcodes, for the meeting options form. */
export interface ZoomPasscodeDefaults {
  passcodeRequired: boolean;
  suggestedPasscode: string | null;
  pmi: string | null;
  pmiPasscode: string | null;
}

interface ZoomPasscodeRule {
  length?: unknown;
  have_letter?: unknown;
  have_number?: unknown;
  have_special_character?: unknown;
  have_upper_and_lower_characters?: unknown;
  only_allow_numeric?: unknown;
}

const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SPECIAL = '@-_*';

/** A random passcode that meets the account's rule; Zoom caps a passcode at 10 characters. */
export function passcodeFor(rule: ZoomPasscodeRule | null | undefined): string {
  const wanted = typeof rule?.length === 'number' ? rule.length : 6;
  const length = Math.min(10, Math.max(6, wanted));
  const pick = (set: string) => set[randomInt(set.length)];

  if (rule?.only_allow_numeric === true) {
    return Array.from({ length }, () => pick('0123456789')).join('');
  }

  // One of each required kind first, then any mix, then shuffled so the kinds do not sit in order.
  const required = [
    pick(LOWER),
    pick(DIGITS),
    ...(rule?.have_upper_and_lower_characters === true ? [pick(UPPER)] : []),
    ...(rule?.have_special_character === true ? [pick(SPECIAL)] : []),
  ];
  const pool = LOWER + UPPER + DIGITS;
  const chars = [
    ...required,
    ...Array.from({ length: length - required.length }, () => pick(pool)),
  ];

  for (let index = chars.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1);

    [chars[index], chars[other]] = [chars[other], chars[index]];
  }

  return chars.join('');
}

async function zoomGet(path: string, token: string): Promise<unknown> {
  const res = await zoomFetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(
      `Zoom settings could not be read: ${await describe(res)} (${res.status})`,
    );
  }

  return res.json();
}

/**
 * Reads the person's own passcode settings through their Zoom login. The personal meeting passcode
 * goes back only to that same person, who can already see it in Zoom.
 */
export async function zoomPasscodeDefaults(
  personToken: string,
): Promise<ZoomPasscodeDefaults> {
  const settings = (await zoomGet('/users/me/settings', personToken)) as {
    schedule_meeting?: {
      require_password_for_scheduling_new_meetings?: unknown;
      pmi_password?: unknown;
    };
    meeting_security?: { meeting_password_requirement?: ZoomPasscodeRule };
  };

  // The personal meeting ID needs another scope; without it the rest still works.
  let pmi: string | null = null;

  try {
    const me = (await zoomGet('/users/me', personToken)) as { pmi?: unknown };

    pmi =
      typeof me.pmi === 'number' || typeof me.pmi === 'string'
        ? String(me.pmi)
        : null;
  } catch {
    pmi = null;
  }

  const pmiPasscode = settings.schedule_meeting?.pmi_password;

  return {
    passcodeRequired:
      settings.schedule_meeting
        ?.require_password_for_scheduling_new_meetings === true,
    suggestedPasscode: passcodeFor(
      settings.meeting_security?.meeting_password_requirement,
    ),
    pmi,
    pmiPasscode:
      typeof pmiPasscode === 'string' && pmiPasscode !== ''
        ? pmiPasscode
        : null,
  };
}
