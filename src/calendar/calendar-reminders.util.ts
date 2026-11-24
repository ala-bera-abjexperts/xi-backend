/**
 * @fileoverview Pure rules behind calendar reminders: which reminders apply, when they fire, who gets
 * them and what they say. Kept free of Nest so they can be checked on their own.
 */
import type { CalendarReminderChannel } from './dto/calendar-reminder.dto';
import {
  CALENDAR_MAX_REMINDER_REPEATS,
  CALENDAR_MAX_REMINDERS,
  CALENDAR_REMINDER_CHANNELS,
  CALENDAR_REMINDER_MINUTES,
} from './dto/calendar-reminder.dto';

export interface CalendarReminder {
  minutes_before: number;
  channels: CalendarReminderChannel[];
  repeat_times: number;
}

export interface DueReminder extends CalendarReminder {
  fireAt: Date;

  /** Minutes still to go when this send happens; differs per repeat. */
  remainingMinutes: number;
}

/** A reminder this late after its moment is skipped, so a restart never sends a stale burst. */
export const REMINDER_CATCH_UP_MS = 5 * 60 * 1000;

/** All-day entries are reminded relative to this local time on their first day. */
const ALL_DAY_HOUR = 9;

const MINUTES = new Set<number>(CALENDAR_REMINDER_MINUTES);
const CHANNELS = new Set<string>(CALENDAR_REMINDER_CHANNELS);

/** Keeps only well-formed items; stored JSON is not trusted to match the request rules. */
export function cleanReminders(value: unknown): CalendarReminder[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<number>();
  const result: CalendarReminder[] = [];

  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;

    const { minutes_before: minutes, channels } = item as Record<
      string,
      unknown
    >;

    if (typeof minutes !== 'number' || !MINUTES.has(minutes)) continue;
    if (seen.has(minutes) || !Array.isArray(channels)) continue;

    const valid = [
      ...new Set(
        (channels as unknown[]).filter(
          (channel): channel is CalendarReminderChannel =>
            typeof channel === 'string' && CHANNELS.has(channel),
        ),
      ),
    ];

    if (valid.length === 0) continue;

    // "At start" has nothing left to spread repeats over, so it is sent once.
    const repeats = (item as Record<string, unknown>).repeat_times;
    const times =
      minutes > 0 &&
      typeof repeats === 'number' &&
      Number.isInteger(repeats) &&
      repeats >= 1
        ? Math.min(repeats, CALENDAR_MAX_REMINDER_REPEATS)
        : 1;

    seen.add(minutes);
    result.push({
      minutes_before: minutes,
      channels: valid,
      repeat_times: times,
    });
  }

  return result.slice(0, CALENDAR_MAX_REMINDERS);
}

/** The entry's own list wins, an empty one included; null or anything unreadable follows the calendar. */
export function effectiveReminders(
  entryReminders: unknown,
  calendarDefault: unknown,
): CalendarReminder[] {
  return Array.isArray(entryReminders)
    ? cleanReminders(entryReminders)
    : cleanReminders(calendarDefault);
}

/** Milliseconds the zone is ahead of UTC at this instant; an unknown zone counts as UTC. */
function zoneOffsetMs(instant: number, zone: string): number {
  let format: Intl.DateTimeFormat;

  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return 0;
  }

  const parts = Object.fromEntries(
    format
      .formatToParts(new Date(instant))
      .map((part) => [part.type, Number(part.value)]),
  );
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall-clock time on a date happens in a zone, with that date's own offset (DST-safe). */
export function zonedTimeToUtc(
  date: string,
  hour: number,
  minute: number,
  zone: string,
): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);

  if (!match) return null;

  const wall = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    hour,
    minute,
  );

  // Second pass corrects a guess that landed on the other side of a DST switch.
  const first = wall - zoneOffsetMs(wall, zone);

  return new Date(wall - zoneOffsetMs(first, zone));
}

/** When the entry starts for reminder purposes: its start, or 09:00 local on an all-day entry's first day. */
export function reminderStart(
  entry: Record<string, unknown>,
  calendarZone: unknown,
): Date | null {
  if (entry.is_all_day === true) {
    const zone =
      (typeof entry.timezone === 'string' && entry.timezone) ||
      (typeof calendarZone === 'string' && calendarZone) ||
      'UTC';

    return typeof entry.start_date === 'string'
      ? zonedTimeToUtc(entry.start_date, ALL_DAY_HOUR, 0, zone)
      : null;
  }

  if (typeof entry.starts_at !== 'string') return null;

  const start = new Date(entry.starts_at);

  return Number.isNaN(start.getTime()) ? null : start;
}

/** Reminders whose moment fell inside the last few minutes. */
export function dueReminders(
  start: Date,
  reminders: CalendarReminder[],
  now: Date,
): DueReminder[] {
  // A repeated reminder is sent at even steps from its first time towards the start, never at it.
  return reminders
    .flatMap((reminder) => {
      // A missing count means once, so a reminder is never silently dropped.
      const times = reminder.repeat_times >= 1 ? reminder.repeat_times : 1;
      const lead = reminder.minutes_before * 60_000;
      const step = lead / times;

      return Array.from({ length: times }, (_unused, index) => ({
        ...reminder,
        fireAt: new Date(start.getTime() - lead + index * step),
        remainingMinutes: Math.round((lead - index * step) / 60_000),
      }));
    })
    .filter(
      (reminder) =>
        reminder.fireAt.getTime() > now.getTime() - REMINDER_CATCH_UP_MS &&
        reminder.fireAt.getTime() <= now.getTime(),
    );
}

/** Creator, calendar owner, followers and linked people, each once. */
export function reminderRecipients(
  entry: Record<string, unknown>,
  ownerId: unknown,
): string[] {
  const watchers = Array.isArray(entry.watcher_ids)
    ? (entry.watcher_ids as unknown[])
    : [];
  const linked = Array.isArray(entry.links)
    ? (entry.links as unknown[])
        .filter(
          (link): link is { type: string; id: unknown } =>
            typeof link === 'object' &&
            link !== null &&
            (link as { type?: unknown }).type === 'user' &&
            // A linked person can be left out of the reminders on the link itself.
            (link as { remind?: unknown }).remind !== false,
        )
        .map((link) => link.id)
    : [];

  return [
    ...new Set(
      [entry.created_by, ownerId, ...watchers, ...linked].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];
}

/** "Starts in 15 minutes: Weekly sync", or "Starting now: …" at the start itself. */
export function reminderTitle(minutesBefore: number, summary: unknown): string {
  const name =
    (typeof summary === 'string' && summary.trim()) || 'Untitled entry';

  if (minutesBefore <= 0) return `Starting now: ${name}`;

  const [amount, unit] =
    minutesBefore % 1440 === 0
      ? [minutesBefore / 1440, 'day']
      : minutesBefore % 60 === 0
        ? [minutesBefore / 60, 'hour']
        : [minutesBefore, 'minute'];

  return `Starts in ${amount} ${unit}${amount === 1 ? '' : 's'}: ${name}`;
}
