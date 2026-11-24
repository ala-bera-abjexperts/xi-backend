/**
 * @fileoverview The arithmetic behind the calendar report, kept free of the database so it can be tested alone.
 *
 * Every figure is read in one time zone: a day, a week and a month all start at that zone's midnight,
 * so an entry that runs past midnight is split between the two days it touches.
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export type InsightBucket = 'day' | 'week' | 'month';

export type InsightMoment = 'past' | 'upcoming' | 'ongoing';

/** The columns the report reads; nothing else of an entry is fetched. */
export interface InsightEvent {
  id: string;
  calendar_id: string;
  summary: string;
  is_all_day: boolean;
  starts_at: string | null;
  ends_at: string | null;
  start_date: string | null;
  end_date: string | null;
  timezone: string | null;
  links: unknown;

  /** 'local' for an entry written here, otherwise the outside calendar it was brought in from. */
  source?: string | null;
}

/** The outside calendars an entry can be brought in from, as its source names them. */
export const INSIGHT_PROVIDERS = [
  'google',
  'microsoft',
  'calendly',
  'ics',
  'zoom',
] as const;

export type InsightKind =
  | 'mine'
  | 'others'
  | 'ticket'
  | (typeof INSIGHT_PROVIDERS)[number]
  | 'synced';

/** The order a breakdown by kind reads in. */
export const INSIGHT_KINDS: InsightKind[] = [
  'mine',
  'others',
  'ticket',
  ...INSIGHT_PROVIDERS,
  'synced',
];

/**
 * What an entry is, so each one is counted under exactly one heading.
 *
 * An entry that links a ticket comes first, then where it was brought in from; what is left was
 * written here, by the reader or by somebody else.
 */
export function kindOf(event: InsightEvent, own: boolean): InsightKind {
  const links = Array.isArray(event.links) ? (event.links as unknown[]) : [];

  if (
    links.some((link) => (link as { type?: unknown } | null)?.type === 'task')
  ) {
    return 'ticket';
  }

  const provider = INSIGHT_PROVIDERS.find((name) => name === event.source);

  if (provider) return provider;

  // A source with no name here is still a copy from outside, not something written here.
  if (event.source && event.source !== 'local') return 'synced';

  return own ? 'mine' : 'others';
}

export interface InsightTotals {
  events: number;
  timed_events: number;
  all_day_events: number;

  /** Every entry's time added up, so two entries at once count twice. */
  event_minutes: number;

  /** Time with at least one entry on it, so two entries at once count once. */
  scheduled_minutes: number;
  average_minutes: number;
  overlapping_events: number;
  busiest_day: { day: string; minutes: number } | null;
}

export interface InsightSeriesPoint {
  key: string;
  events: number;
  event_minutes: number;
}

interface Span {
  id: string;
  start: number;
  end: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timezone, formatter);
  }

  return formatter;
}

/** The wall-clock reading of an instant in a zone, as if it were UTC. */
function wallClock(at: number, timezone: string): number {
  const parts: Record<string, number> = {};

  for (const part of formatterFor(timezone).formatToParts(new Date(at))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }

  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

/** The calendar day an instant falls on in a zone, as YYYY-MM-DD. */
export function dayKeyIn(at: number, timezone: string): string {
  return new Date(wallClock(at, timezone)).toISOString().slice(0, 10);
}

export function addDaysToKey(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** The instant a day begins in a zone. Asked twice, so a clock change on that day is still right. */
export function startOfDayIn(day: string, timezone: string): number {
  const wall = Date.parse(`${day}T00:00:00Z`);
  const first = wall - (wallClock(wall, timezone) - wall);

  return wall - (wallClock(first, timezone) - first);
}

/** The bucket a day belongs to; a week starts on Monday, as the calendar grid does (WEEK_STARTS_ON). */
export function bucketKeyOf(day: string, bucket: InsightBucket): string {
  if (bucket === 'month') return `${day.slice(0, 7)}-01`;

  if (bucket === 'week') {
    const sinceMonday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;

    return addDaysToKey(day, -sinceMonday);
  }

  return day;
}

/** A timed entry as two instants; null for a whole-day entry or one whose times do not make a span. */
function spanOf(event: InsightEvent): Span | null {
  if (event.is_all_day || !event.starts_at || !event.ends_at) return null;

  const start = Date.parse(event.starts_at);
  const end = Date.parse(event.ends_at);

  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;

  return { id: event.id, start, end };
}

/** When an entry begins, whichever of the two shapes it uses. */
export function startInstant(event: InsightEvent, timezone: string): number {
  if (!event.is_all_day) return Date.parse(event.starts_at ?? '');

  return event.start_date ? startOfDayIn(event.start_date, timezone) : NaN;
}

/** When an entry is over; a whole-day end date is the first day it no longer covers. */
export function endInstant(event: InsightEvent, timezone: string): number {
  if (!event.is_all_day) return Date.parse(event.ends_at ?? '');

  return event.end_date ? startOfDayIn(event.end_date, timezone) : NaN;
}

/** Whether an entry touches the window at all. */
export function inWindow(
  event: InsightEvent,
  from: number,
  to: number,
  timezone: string,
): boolean {
  const start = startInstant(event, timezone);
  const end = endInstant(event, timezone);

  if (Number.isNaN(start) || Number.isNaN(end)) return false;

  // A timed entry of no length still belongs to the moment it sits on.
  return start < to && (end > from || (end === start && start >= from));
}

/** Past once it has ended, upcoming until it starts, ongoing in between. Read from the times alone. */
export function momentOf(
  event: InsightEvent,
  now: number,
  timezone: string,
): InsightMoment {
  if (endInstant(event, timezone) <= now) return 'past';

  return startInstant(event, timezone) > now ? 'upcoming' : 'ongoing';
}

/** Entries that share time with another one. Sorted by start, each is compared with the latest end so far. */
function overlappingIds(spans: Span[]): Set<string> {
  const marked = new Set<string>();
  const sorted = [...spans].sort((left, right) => left.start - right.start);
  let holder: Span | null = null;

  for (const span of sorted) {
    if (holder && span.start < holder.end) {
      marked.add(span.id);
      marked.add(holder.id);
    }

    if (!holder || span.end > holder.end) holder = span;
  }

  return marked;
}

export function overlappingEventIds(events: InsightEvent[]): Set<string> {
  return overlappingIds(
    events.map(spanOf).filter((span): span is Span => span !== null),
  );
}

/** The length of the time covered by any of the spans, counting shared time once. */
function coveredMs(spans: Span[]): number {
  const sorted = [...spans].sort((left, right) => left.start - right.start);
  let total = 0;
  let start = 0;
  let end = 0;
  let open = false;

  for (const span of sorted) {
    if (open && span.start <= end) {
      end = Math.max(end, span.end);
      continue;
    }

    if (open) total += end - start;

    start = span.start;
    end = span.end;
    open = true;
  }

  return open ? total + (end - start) : total;
}

function toMinutes(ms: number): number {
  return Math.round(ms / MINUTE_MS);
}

/** Minutes each day carries, with a span that crosses midnight shared between its days. */
function minutesByDay(
  spans: Span[],
  from: number,
  to: number,
  timezone: string,
): Map<string, number> {
  const days = new Map<string, number>();

  for (const span of spans) {
    let cursor = Math.max(span.start, from);
    const end = Math.min(span.end, to);

    while (cursor < end) {
      const day = dayKeyIn(cursor, timezone);
      const midnight = startOfDayIn(addDaysToKey(day, 1), timezone);
      const next = Math.min(
        end,
        midnight > cursor ? midnight : cursor + DAY_MS,
      );

      days.set(day, (days.get(day) ?? 0) + (next - cursor));
      cursor = next;
    }
  }

  return days;
}

/** The figures for one window. Only the part of an entry inside the window counts towards time. */
export function totalsOf(
  events: InsightEvent[],
  from: number,
  to: number,
  timezone: string,
): InsightTotals {
  const inside = events.filter((event) => inWindow(event, from, to, timezone));
  const spans = inside
    .map(spanOf)
    .filter((span): span is Span => span !== null);
  const clipped = spans.map((span) => ({
    id: span.id,
    start: Math.max(span.start, from),
    end: Math.min(span.end, to),
  }));

  const eventMs = clipped.reduce(
    (sum, span) => sum + (span.end - span.start),
    0,
  );
  const fullMs = spans.reduce((sum, span) => sum + (span.end - span.start), 0);

  let busiest: { day: string; minutes: number } | null = null;

  for (const [day, ms] of minutesByDay(spans, from, to, timezone)) {
    const minutes = toMinutes(ms);

    if (
      !busiest ||
      minutes > busiest.minutes ||
      (minutes === busiest.minutes && day < busiest.day)
    ) {
      busiest = { day, minutes };
    }
  }

  return {
    events: inside.length,
    timed_events: spans.length,
    all_day_events: inside.filter((event) => event.is_all_day).length,
    event_minutes: toMinutes(eventMs),
    scheduled_minutes: toMinutes(coveredMs(clipped)),
    average_minutes: spans.length ? toMinutes(fullMs / spans.length) : 0,
    overlapping_events: overlappingIds(spans).size,
    busiest_day: busiest,
  };
}

/**
 * One point per bucket across the window, empty ones included so a chart has no gaps.
 *
 * An entry is counted in the bucket where its part of the window begins, so the points add up to the
 * total; its minutes go to each day they fall on.
 */
export function seriesOf(
  events: InsightEvent[],
  from: number,
  to: number,
  timezone: string,
  bucket: InsightBucket,
): InsightSeriesPoint[] {
  const points = new Map<string, InsightSeriesPoint>();
  const lastDay = dayKeyIn(to - 1, timezone);

  for (
    let day = dayKeyIn(from, timezone);
    day <= lastDay;
    day = addDaysToKey(day, 1)
  ) {
    const key = bucketKeyOf(day, bucket);

    if (!points.has(key)) points.set(key, { key, events: 0, event_minutes: 0 });
  }

  const inside = events.filter((event) => inWindow(event, from, to, timezone));
  const spans = inside
    .map(spanOf)
    .filter((span): span is Span => span !== null);
  const pointFor = (at: number) =>
    points.get(bucketKeyOf(dayKeyIn(at, timezone), bucket));

  for (const event of inside) {
    const point = pointFor(Math.max(startInstant(event, timezone), from));

    if (point) point.events += 1;
  }

  const minutes = new Map<string, number>();

  for (const [day, ms] of minutesByDay(spans, from, to, timezone)) {
    const key = bucketKeyOf(day, bucket);

    minutes.set(key, (minutes.get(key) ?? 0) + ms);
  }

  for (const [key, ms] of minutes) {
    const point = points.get(key);

    if (point) point.event_minutes = toMinutes(ms);
  }

  return [...points.values()];
}

const WEEK_MS = 7 * DAY_MS;

/** How many earlier weeks the last seven days are measured against. */
export const UNUSUAL_BASELINE_WEEKS = 8;

/** A calendar younger than this has no usual week to compare with. */
export const UNUSUAL_MIN_WEEKS = 4;

/** Everything the comparison reads: the last seven days and the weeks before them. */
export const UNUSUAL_SPAN_MS = (UNUSUAL_BASELINE_WEEKS + 1) * WEEK_MS;

/** A rise of fewer entries than this is never called unusual, however quiet the usual week. */
const UNUSUAL_MIN_RISE = 5;

/** Weeks with copies arriving that a connected calendar needs before going quiet means anything. */
const SYNC_ACTIVE_WEEKS = 3;

/** A failing connection is reported once it has gone this long without a good run. */
const SYNC_FAILING_MS = DAY_MS;

/** An entry as the comparison reads it, removed ones included. */
export interface ActivityEvent extends InsightEvent {
  created_at: string;
  deleted_at: string | null;
  external_id: string | null;
}

export interface ActivityCalendar {
  id: string;
  created_at: string | null;

  /** Null when the calendar is not connected, or the reader may not see its connection. */
  sync: { status: string | null; last_synced_at: string | null } | null;
}

export type UnusualKind =
  | 'created'
  | 'deleted'
  | 'overlapping'
  | 'sync_quiet'
  | 'sync_failing';

export interface UnusualAlert {
  kind: UnusualKind;
  calendar_id: string;

  /** The count for the last seven days. */
  recent: number;

  /** The middle, lowest and highest of the earlier weeks; null where no count is compared. */
  typical: number | null;
  low: number | null;
  high: number | null;

  /** How many earlier weeks it was compared with. */
  weeks: number;

  /** Of the removed entries, how many were copies from a connected calendar. */
  synced?: number;
  last_synced_at?: string | null;
}

function median(sorted: number[]): number {
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The spread of the earlier weeks when the last seven days stand clear of all of them: above the
 * highest, at least double the middle one, and by a real number of entries. Anything less is an
 * ordinary busy week and gives null.
 */
export function unusualRise(
  recent: number,
  earlier: number[],
): { typical: number; low: number; high: number } | null {
  if (earlier.length === 0) return null;

  const sorted = [...earlier].sort((left, right) => left - right);
  const typical = median(sorted);
  const high = sorted[sorted.length - 1];

  if (
    recent <= high ||
    recent < typical * 2 ||
    recent - typical < UNUSUAL_MIN_RISE
  ) {
    return null;
  }

  return { typical, low: sorted[0], high };
}

/**
 * What stands out in the last seven days of each calendar, measured against its own earlier weeks.
 * A calendar too young to have a usual week is named separately instead of being judged.
 */
export function unusualActivity(
  events: ActivityEvent[],
  calendars: ActivityCalendar[],
  now: number,
  timezone: string,
): { alerts: UnusualAlert[]; not_enough_history: string[] } {
  const alerts: UnusualAlert[] = [];
  const young: string[] = [];
  const byCalendar = new Map<string, ActivityEvent[]>();

  for (const event of events) {
    byCalendar.set(event.calendar_id, [
      ...(byCalendar.get(event.calendar_id) ?? []),
      event,
    ]);
  }

  for (const calendar of calendars) {
    const rows = byCalendar.get(calendar.id) ?? [];
    const lastSynced = Date.parse(calendar.sync?.last_synced_at ?? '');

    // A broken connection needs no history to be worth saying.
    if (
      calendar.sync?.status === 'error' &&
      (Number.isNaN(lastSynced) || now - lastSynced > SYNC_FAILING_MS)
    ) {
      alerts.push({
        kind: 'sync_failing',
        calendar_id: calendar.id,
        recent: 0,
        typical: null,
        low: null,
        high: null,
        weeks: 0,
        last_synced_at: calendar.sync.last_synced_at,
      });
    }

    const born = Date.parse(calendar.created_at ?? '');

    // Only weeks the calendar existed for in full are a fair comparison.
    const weeks = Number.isNaN(born)
      ? UNUSUAL_BASELINE_WEEKS
      : Math.min(
          UNUSUAL_BASELINE_WEEKS,
          Math.floor((now - WEEK_MS - born) / WEEK_MS),
        );

    if (weeks < UNUSUAL_MIN_WEEKS) {
      young.push(calendar.id);
      continue;
    }

    // Index 0 is the last seven days; 1 and up are the weeks before, newest first.
    const weekOf = (at: number): number => {
      const index = Math.floor((now - at) / WEEK_MS);

      return at <= now && index <= weeks ? index : -1;
    };

    const tally = (
      picked: ActivityEvent[],
      at: (event: ActivityEvent) => number,
    ): number[] => {
      const counts = new Array<number>(weeks + 1).fill(0);

      for (const event of picked) {
        const index = weekOf(at(event));

        if (index >= 0) counts[index] += 1;
      }

      return counts;
    };

    const rise = (kind: UnusualKind, counts: number[], synced?: number) => {
      const spread = unusualRise(counts[0], counts.slice(1));

      if (!spread) return;

      alerts.push({
        kind,
        calendar_id: calendar.id,
        recent: counts[0],
        ...spread,
        weeks,
        ...(synced === undefined ? {} : { synced }),
      });
    };

    const copies = rows.filter((event) => Boolean(event.external_id));
    const removed = rows.filter((event) => Boolean(event.deleted_at));
    const createdAt = (event: ActivityEvent) => Date.parse(event.created_at);
    const removedAt = (event: ActivityEvent) =>
      Date.parse(event.deleted_at ?? '');

    // Copies arrive in batches by nature, so only entries written here count as created.
    rise(
      'created',
      tally(
        rows.filter((event) => !event.external_id),
        createdAt,
      ),
    );

    rise(
      'deleted',
      tally(removed, removedAt),
      removed.filter(
        (event) => Boolean(event.external_id) && weekOf(removedAt(event)) === 0,
      ).length,
    );

    // Entries are grouped by the week they start in, and only clash with others of that week.
    const starting: ActivityEvent[][] = Array.from(
      { length: weeks + 1 },
      () => [],
    );

    for (const event of rows) {
      const index = event.deleted_at
        ? -1
        : weekOf(startInstant(event, timezone));

      if (index >= 0) starting[index].push(event);
    }

    rise(
      'overlapping',
      starting.map((week) => overlappingEventIds(week).size),
    );

    const arrivals = tally(copies, createdAt);

    if (
      calendar.sync &&
      arrivals[0] === 0 &&
      arrivals[1] === 0 &&
      arrivals.slice(2).filter((count) => count > 0).length >= SYNC_ACTIVE_WEEKS
    ) {
      const sorted = arrivals.slice(1).sort((left, right) => left - right);

      alerts.push({
        kind: 'sync_quiet',
        calendar_id: calendar.id,
        recent: 0,
        typical: median(sorted),
        low: sorted[0],
        high: sorted[sorted.length - 1],
        weeks,
        last_synced_at: calendar.sync.last_synced_at,
      });
    }
  }

  return { alerts, not_enough_history: young };
}
