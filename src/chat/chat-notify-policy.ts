/**
 * @fileoverview The chat notification rules (XE-T353 CHAT-16) as pure functions: no
 * I/O, and the clock is always passed in.
 *
 * Pause ("do not disturb" and working hours) is always answered as "what time is it
 * NOW for this person", by formatting the instant in their timezone with `Intl`. A
 * local time is never converted to UTC and no UTC boundary is ever stored, so a
 * daylight-saving change cannot move or double a boundary.
 * @module src/chat/chat-notify-policy
 */

export const WEEK_DAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

/**
 * 'HH:mm' per working day. A missing day is a day off. `start > end` runs overnight
 * and belongs to the start day (Fri 22:00–06:00 ends on Saturday morning).
 */
export type WorkingHours = Partial<
  Record<WeekDay, { start: string; end: string }>
>;

/** The part of `chat_user_settings` that can pause notifications. */
export interface ChatPauseSettings {
  dndUntil: string | null;
  workingHours: WorkingHours | null;
  /** IANA name; without one the working hours are ignored. */
  timezone: string | null;
}

/** Why a message could notify someone. `plain` = none of the other three. */
export type ChatNotifyReason = 'plain' | 'mention' | 'dm' | 'thread_reply';

/** Keys of `notification_preferences`; `chat_mention` also gates thread replies. */
export type ChatPreferenceKey = 'chat_mention' | 'chat_dm';
export type ChatPreferences = Partial<
  Record<ChatPreferenceKey, { inApp: boolean; email: boolean }>
>;

export interface ChatNotifyInput {
  reason: ChatNotifyReason;
  /** The recipient's level for this conversation. */
  level: 'all' | 'mentions' | 'none';
  /** The conversation is muted right now (`muted_until` in the future). */
  muted: boolean;
  /** The recipient switched off "mentions break through" for this conversation. */
  muteMentions: boolean;
  /** {@link isPaused} is not null for the recipient. */
  paused: boolean;
  /** Missing keys count as switched on. */
  preferences: ChatPreferences;
  /** 0 = never. */
  emailFallbackMinutes: number;
}

export interface ChatNotifyDecision {
  /** `now` = bell entry at once, `held` = on release from the pause, `none` = no entry. */
  bell: 'now' | 'held' | 'none';
  /** Minutes an unread mention or DM waits before the email; null = no email. */
  emailAfterMinutes: number | null;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MINUTE_MS = 60_000;
const PROBE_MS = 15 * MINUTE_MS;
const MAX_PROBES = 8 * 24 * 4;
/**
 * Where the search for the next free moment starts at the latest. Year 10000 is
 * "+010000-…" in toISOString(), which Postgres does not read as a timestamp.
 */
const LATEST_START_MS = Date.UTC(9999, 11, 1);

/** The preference that gates a reason. */
export function chatPreferenceKey(reason: ChatNotifyReason): ChatPreferenceKey {
  return reason === 'dm' ? 'chat_dm' : 'chat_mention';
}

/**
 * Decides what one recipient gets for one message.
 *
 * quiet = muted OR level "nothing":
 *  - plain message: never a bell entry (the client shows a toast at level "all");
 *  - DM and thread reply: unless quiet;
 *  - mention: always, unless quiet AND the recipient muted mentions too.
 * A thread reply is never emailed.
 */
export function decideChatNotification(
  input: ChatNotifyInput,
): ChatNotifyDecision {
  const quiet = input.muted || input.level === 'none';
  const notifies =
    input.reason === 'mention'
      ? !quiet || !input.muteMentions
      : input.reason !== 'plain' && !quiet;

  if (!notifies) return { bell: 'none', emailAfterMinutes: null };

  const preference = input.preferences[chatPreferenceKey(input.reason)] ?? {
    inApp: true,
    email: true,
  };

  return {
    bell: !preference.inApp ? 'none' : input.paused ? 'held' : 'now',
    emailAfterMinutes:
      input.reason !== 'thread_reply' &&
      preference.email &&
      input.emailFallbackMinutes > 0
        ? input.emailFallbackMinutes
        : null,
  };
}

// One formatter per zone: constructing Intl.DateTimeFormat is the slow part.
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Weekday and wall-clock time of an instant in a timezone; null for an unknown zone. */
function localClock(
  timezone: string,
  at: Date,
): { day: WeekDay; minutes: number; time: string } | null {
  try {
    let formatter = formatters.get(timezone);

    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      formatters.set(timezone, formatter);
    }

    const parts = new Map(
      formatter.formatToParts(at).map((part) => [part.type, part.value]),
    );
    const hour = Number(parts.get('hour'));
    const minute = Number(parts.get('minute'));

    return {
      day: (parts.get('weekday') ?? '').toLowerCase() as WeekDay,
      minutes: hour * 60 + minute,
      time: `${parts.get('hour')}:${parts.get('minute')}`,
    };
  } catch {
    return null;
  }
}

/** A day's window in minutes; null for a day off or an unusable entry. */
function dayWindow(
  hours: WorkingHours,
  day: WeekDay,
): { start: number; end: number } | null {
  const entry = hours[day];

  if (!entry || !TIME_RE.test(entry.start) || !TIME_RE.test(entry.end)) {
    return null;
  }

  const [start, end] = [entry.start, entry.end].map(
    (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3)),
  );

  return start === end ? null : { start, end };
}

/** 'HH:mm' right now in a timezone, or null when the zone is missing or unknown. */
export function localTime(timezone: string | null, now: Date): string | null {
  return timezone ? (localClock(timezone, now)?.time ?? null) : null;
}

/**
 * Whether `now` falls outside the person's working hours. False when they set no
 * schedule, no timezone or an unknown timezone (the schedule is then ignored).
 */
export function isOutsideWorkingHours(
  settings: Pick<ChatPauseSettings, 'workingHours' | 'timezone'>,
  now: Date,
): boolean {
  const hours = settings.workingHours;

  if (!hours || !settings.timezone) return false;
  if (!WEEK_DAYS.some((day) => dayWindow(hours, day))) return false;

  const clock = localClock(settings.timezone, now);

  if (!clock) return false;

  const today = dayWindow(hours, clock.day);
  const yesterday = dayWindow(
    hours,
    WEEK_DAYS[(WEEK_DAYS.indexOf(clock.day) + 6) % 7],
  );

  const inToday =
    !!today &&
    clock.minutes >= today.start &&
    // An overnight window runs to midnight on its start day.
    (today.start > today.end || clock.minutes < today.end);
  // ...and its morning part belongs to the day it started on.
  const inOvernightTail =
    !!yesterday &&
    yesterday.start > yesterday.end &&
    clock.minutes < yesterday.end;

  return !inToday && !inOvernightTail;
}

/** Why the person is not to be disturbed at `now`, or null when they are available. */
export function isPaused(
  settings: ChatPauseSettings | null | undefined,
  now: Date,
): 'dnd' | 'working_hours' | null {
  if (!settings) return null;

  if (settings.dndUntil && Date.parse(settings.dndUntil) > now.getTime()) {
    return 'dnd';
  }

  return isOutsideWorkingHours(settings, now) ? 'working_hours' : null;
}

/**
 * The first instant from `now` on at which the person is no longer paused. Used only
 * as "look again at" for held notifications: the sweep re-evaluates {@link isPaused}
 * when it gets there.
 *
 * A forward scan over real instants (never "08:00 local, converted to UTC"), so a
 * daylight-saving change cannot produce a wrong or non-existent time.
 */
export function nextAvailableAt(
  settings: ChatPauseSettings | null | undefined,
  now: Date,
): Date {
  if (!settings) return now;

  const dndEnd = settings.dndUntil ? Date.parse(settings.dndUntil) : NaN;
  const from = Math.min(
    Math.max(now.getTime(), Number.isNaN(dndEnd) ? 0 : dndEnd),
    LATEST_START_MS,
  );

  if (!isOutsideWorkingHours(settings, new Date(from))) return new Date(from);

  // ponytail: 15-minute probes skip a working window shorter than 15 minutes; scan
  // minute by minute if such schedules ever exist.
  let probe = Math.floor(from / MINUTE_MS) * MINUTE_MS;

  for (let i = 0; i < MAX_PROBES; i += 1) {
    const next = probe + PROBE_MS;

    if (!isOutsideWorkingHours(settings, new Date(next))) {
      for (let minute = probe + MINUTE_MS; minute < next; minute += MINUTE_MS) {
        if (!isOutsideWorkingHours(settings, new Date(minute))) {
          return new Date(minute);
        }
      }

      return new Date(next);
    }

    probe = next;
  }

  // Nothing within 8 days: look again then.
  return new Date(probe);
}

/** Shape check for a `workingHours` value coming from a client. */
export function isWorkingHours(value: unknown): value is WorkingHours {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  return Object.entries(value).every(([day, entry]) => {
    if (!(WEEK_DAYS as readonly string[]).includes(day)) return false;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return false;
    }

    const { start, end, ...rest } = entry as Record<string, unknown>;

    return (
      Object.keys(rest).length === 0 &&
      typeof start === 'string' &&
      typeof end === 'string' &&
      TIME_RE.test(start) &&
      TIME_RE.test(end) &&
      start !== end
    );
  });
}
