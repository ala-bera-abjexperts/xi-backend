/**
 * @fileoverview The calendar report: scheduled time, past and upcoming entries, and linked tickets that are overdue.
 *
 * Nothing is stored and no entry carries a state. Every figure is worked out from the entries this
 * person may read, and a linked ticket is judged by the ticket's own due date and status.
 */
import { BadRequestException, Injectable } from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { CalendarAccessService } from './calendar-access.service';
import type {
  ActivityCalendar,
  ActivityEvent,
  InsightEvent,
  InsightKind,
  InsightTotals,
} from './calendar-insights.util';
import {
  endInstant,
  INSIGHT_KINDS,
  inWindow,
  kindOf,
  momentOf,
  overlappingEventIds,
  seriesOf,
  startInstant,
  totalsOf,
  UNUSUAL_BASELINE_WEEKS,
  UNUSUAL_MIN_WEEKS,
  UNUSUAL_SPAN_MS,
  unusualActivity,
} from './calendar-insights.util';
import type { CalendarWithAccess } from './calendars.service';
import { CalendarsService } from './calendars.service';
import type {
  CalendarInsightEventsDto,
  CalendarInsightPageDto,
  CalendarInsightsDto,
  CalendarInsightUnusualDto,
} from './dto/calendar-insights.dto';

const DAY_MS = 86_400_000;

/** A year at a time; the earlier period it is compared with is read on top of that. */
const MAX_RANGE_DAYS = 366;

const DEFAULT_RANGE_DAYS = 30;

/** The database hands back at most this many rows a request, so longer answers are read in pages. */
const PAGE_ROWS = 1000;

/** Past this the report says it is incomplete instead of reading without end. */
const MAX_ROWS = 20_000;

const ID_CHUNK = 100;

const DEFAULT_PAGE = 25;

const COLUMNS =
  'id, calendar_id, summary, is_all_day, starts_at, ends_at, start_date, end_date, timezone, links, source, created_by, external_id, sync_read_only';

/** The statuses the ticket list already treats as finished when it filters for overdue. */
const FINISHED_STATUSES = '("done","closed")';

interface EventRow extends InsightEvent {
  created_by: string | null;
  external_id: string | null;
  sync_read_only: boolean | null;
}

type ActivityRow = EventRow & ActivityEvent;

interface TaskRow {
  id: string;
  key: string | null;
  summary: string | null;
  status: string | null;
  priority: string | null;
  due_date: string | null;
  space_id: string | null;
}

interface Window {
  from: number;
  to: number;
  timezone: string;
}

export interface InsightEventItem {
  id: string;
  calendar_id: string;
  summary: string;
  is_all_day: boolean;
  starts_at: string | null;
  ends_at: string | null;
  start_date: string | null;
  end_date: string | null;
  timezone: string | null;
}

export interface InsightOverdueItem {
  task: TaskRow & { space_key: string | null };
  events: Array<{ id: string; summary: string; calendar_id: string }>;
}

@Injectable()
export class CalendarInsightsService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly calendars: CalendarsService,
    private readonly access: CalendarAccessService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Totals for the window and the one before it, a point per bucket, and a line per calendar. */
  async summary(
    query: CalendarInsightsDto,
    userId: string,
    organizationId: string,
  ) {
    const window = this.window(query);
    const length = window.to - window.from;
    const previousFrom = window.from - length;
    const now = Date.now();

    // One read covers both periods.
    const { events, calendars, truncated } = await this.readable(
      previousFrom,
      window.to,
      query.calendar_ids,
      userId,
      organizationId,
    );

    const current = events.filter((event) =>
      inWindow(event, window.from, window.to, window.timezone),
    );

    const moments = { past: 0, upcoming: 0, ongoing: 0 };

    for (const event of current) {
      moments[momentOf(event, now, window.timezone)] += 1;
    }

    const overdue = await this.overdueFor(current, userId, organizationId, now);

    return {
      range: {
        from: new Date(window.from).toISOString(),
        to: new Date(window.to).toISOString(),
        tz: window.timezone,
        bucket: query.bucket ?? 'day',
      },
      totals: {
        ...totalsOf(events, window.from, window.to, window.timezone),
        past_events: moments.past,
        upcoming_events: moments.upcoming,
        ongoing_events: moments.ongoing,
        overdue_linked_tickets: overdue.length,
      },
      previous: {
        from: new Date(previousFrom).toISOString(),
        to: new Date(window.from).toISOString(),
        totals: totalsOf(events, previousFrom, window.from, window.timezone),
      },
      series: seriesOf(
        events,
        window.from,
        window.to,
        window.timezone,
        query.bucket ?? 'day',
      ),
      by_calendar: this.byCalendar(current, calendars, window),
      by_kind: this.byKind(current, userId),
      truncated,
    };
  }

  /** One page of the entries behind a figure, in the order that figure is read in. */
  async events(
    query: CalendarInsightEventsDto,
    userId: string,
    organizationId: string,
  ): Promise<{ items: InsightEventItem[]; total: number }> {
    const window = this.window(query);
    const now = Date.now();
    const kind = query.kind ?? 'all';

    const { events } = await this.readable(
      window.from,
      window.to,
      query.calendar_ids,
      userId,
      organizationId,
    );

    const inside = events.filter((event) =>
      inWindow(event, window.from, window.to, window.timezone),
    );

    const overlapping =
      kind === 'overlapping' ? overlappingEventIds(inside) : null;

    const matching = inside.filter((event) => {
      if (overlapping) return overlapping.has(event.id);
      if (kind === 'all') return true;

      return momentOf(event, now, window.timezone) === kind;
    });

    // What has passed reads newest first; everything else reads in the order it happens.
    matching.sort((left, right) =>
      kind === 'past'
        ? endInstant(right, window.timezone) - endInstant(left, window.timezone)
        : startInstant(left, window.timezone) -
          startInstant(right, window.timezone),
    );

    return {
      items: this.page(matching, query).map((event) => ({
        id: event.id,
        calendar_id: event.calendar_id,
        summary: event.summary,
        is_all_day: event.is_all_day,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        start_date: event.start_date,
        end_date: event.end_date,
        timezone: event.timezone,
      })),
      total: matching.length,
    };
  }

  /** One page of the overdue tickets linked from entries in the window, most overdue first. */
  async overdue(
    query: CalendarInsightPageDto,
    userId: string,
    organizationId: string,
  ): Promise<{ items: InsightOverdueItem[]; total: number }> {
    const window = this.window(query);

    const { events } = await this.readable(
      window.from,
      window.to,
      query.calendar_ids,
      userId,
      organizationId,
    );

    const items = await this.overdueFor(
      events.filter((event) =>
        inWindow(event, window.from, window.to, window.timezone),
      ),
      userId,
      organizationId,
      Date.now(),
    );

    return { items: this.page(items, query), total: items.length };
  }

  /**
   * What stands out in the last seven days of each calendar against its own earlier weeks.
   * Counts only: no entry is named, and removed entries follow the same read rule as live ones.
   */
  async unusual(
    query: CalendarInsightUnusualDto,
    userId: string,
    organizationId: string,
  ) {
    const now = Date.now();
    const since = now - UNUSUAL_SPAN_MS;
    const visible = await this.calendars.listVisible(userId, organizationId);
    const wanted = query.calendar_ids?.length
      ? visible.filter((calendar) => query.calendar_ids?.includes(calendar.id))
      : visible;

    const window = {
      recent_from: new Date(now - 7 * DAY_MS).toISOString(),
      to: new Date(now).toISOString(),
      baseline_weeks: UNUSUAL_BASELINE_WEEKS,
      min_weeks: UNUSUAL_MIN_WEEKS,
    };

    const { events, truncated } = await this.activity(
      since,
      now,
      wanted,
      userId,
      organizationId,
    );

    // Half a history would turn missing rows into a false quiet week, so nothing is judged.
    if (truncated) {
      return { window, alerts: [], not_enough_history: [], truncated };
    }

    const text = (value: unknown) => (typeof value === 'string' ? value : null);

    const calendars = wanted.map<ActivityCalendar>((calendar) => ({
      id: calendar.id,
      created_at: text(calendar.created_at),
      sync:
        text(calendar.sync_account_id) && calendar.permissions.sync.read
          ? {
              status: text(calendar.sync_status),
              last_synced_at: text(calendar.sync_last_synced_at),
            }
          : null,
    }));

    return {
      window,
      ...unusualActivity(events, calendars, now, query.tz ?? 'UTC'),
      truncated,
    };
  }

  /** Entries written, removed or scheduled since the given moment, removed ones included. */
  private async activity(
    since: number,
    now: number,
    wanted: CalendarWithAccess[],
    userId: string,
    organizationId: string,
  ): Promise<{ events: ActivityRow[]; truncated: boolean }> {
    if (wanted.length === 0) return { events: [], truncated: false };

    const calendars = new Map(
      wanted.map((calendar) => [calendar.id, calendar]),
    );
    const sinceIso = new Date(since).toISOString();
    const fromDate = new Date(since - DAY_MS).toISOString().slice(0, 10);
    const toDate = new Date(now + DAY_MS).toISOString().slice(0, 10);
    const rows: ActivityRow[] = [];

    for (let offset = 0; ; offset += PAGE_ROWS) {
      if (offset >= MAX_ROWS) return { events: [], truncated: true };

      const { data, error } = await this.client
        .from('calendar_events')
        .select(`${COLUMNS}, created_at, deleted_at`)
        .eq('organization_id', organizationId)
        .in('calendar_id', [...calendars.keys()])
        .or(
          `created_at.gte.${sinceIso},deleted_at.gte.${sinceIso},` +
            `and(starts_at.lt.${new Date(now).toISOString()},ends_at.gte.${sinceIso}),` +
            `and(start_date.lte.${toDate},end_date.gte.${fromDate})`,
        )
        .order('id')
        .range(offset, offset + PAGE_ROWS - 1);

      if (error) throw new BadRequestException(error.message);

      const batch = (data ?? []) as unknown as ActivityRow[];

      rows.push(...batch);

      if (batch.length < PAGE_ROWS) break;
    }

    const seen = new Set<string>();

    const events = rows.filter((event) => {
      const calendar = calendars.get(event.calendar_id);

      if (!calendar || seen.has(event.id)) return false;

      seen.add(event.id);

      return this.mayRead(event, calendar, userId);
    });

    return { events, truncated: false };
  }

  private page<T>(rows: T[], query: CalendarInsightPageDto): T[] {
    const offset = query.offset ?? 0;

    return rows.slice(offset, offset + (query.limit ?? DEFAULT_PAGE));
  }

  /** Defaults to the last thirty days, and refuses a window too wide to read in one go. */
  private window(query: CalendarInsightsDto): Window {
    const now = Date.now();
    const to = query.to ? Date.parse(query.to) : now;
    const from = query.from
      ? Date.parse(query.from)
      : to - DEFAULT_RANGE_DAYS * DAY_MS;

    if (Number.isNaN(from) || Number.isNaN(to)) {
      throw new BadRequestException('from and to must be dates');
    }

    if (to <= from) {
      throw new BadRequestException('to must be after from');
    }

    if (to - from > MAX_RANGE_DAYS * DAY_MS) {
      throw new BadRequestException(
        `Ask for at most ${MAX_RANGE_DAYS} days at a time`,
      );
    }

    return { from, to, timezone: query.tz ?? 'UTC' };
  }

  /**
   * The entries this person may read that touch the span, each one once.
   *
   * It follows the entry list's own rule: the calendar must be visible, and each kind of content -
   * their own, somebody else's, a copy from a connected calendar - is granted separately. Ticket
   * dates shown through a calendar's sources are not entries and are never read here.
   */
  private async readable(
    from: number,
    to: number,
    calendarIds: string[] | undefined,
    userId: string,
    organizationId: string,
  ): Promise<{
    events: EventRow[];
    calendars: Map<string, CalendarWithAccess>;
    truncated: boolean;
  }> {
    const visible = await this.calendars.listVisible(userId, organizationId);
    const wanted = calendarIds?.length
      ? visible.filter((calendar) => calendarIds.includes(calendar.id))
      : visible;
    const calendars = new Map(
      wanted.map((calendar) => [calendar.id, calendar]),
    );

    if (wanted.length === 0) return { events: [], calendars, truncated: false };

    // Whole-day entries are plain dates, so the date window is a day wider and the exact test follows.
    const fromDate = new Date(from - DAY_MS).toISOString().slice(0, 10);
    const toDate = new Date(to + DAY_MS).toISOString().slice(0, 10);
    const rows: EventRow[] = [];
    let truncated = false;

    for (let offset = 0; ; offset += PAGE_ROWS) {
      if (offset >= MAX_ROWS) {
        truncated = true;
        break;
      }

      const { data, error } = await this.client
        .from('calendar_events')
        .select(COLUMNS)
        .eq('organization_id', organizationId)
        .in(
          'calendar_id',
          wanted.map((calendar) => calendar.id),
        )
        .is('deleted_at', null)
        .or(
          `and(starts_at.lt.${new Date(to).toISOString()},ends_at.gte.${new Date(from).toISOString()}),` +
            `and(start_date.lte.${toDate},end_date.gte.${fromDate})`,
        )
        .order('id')
        .range(offset, offset + PAGE_ROWS - 1);

      if (error) throw new BadRequestException(error.message);

      const batch = (data ?? []) as unknown as EventRow[];

      rows.push(...batch);

      if (batch.length < PAGE_ROWS) break;
    }

    const seen = new Set<string>();

    const events = rows.filter((event) => {
      const calendar = calendars.get(event.calendar_id);

      if (!calendar || seen.has(event.id)) return false;

      seen.add(event.id);

      return this.mayRead(event, calendar, userId);
    });

    return { events, calendars, truncated };
  }

  /** The same per-kind rule the entry list applies before it returns a row. */
  private mayRead(
    event: EventRow,
    calendar: CalendarWithAccess,
    userId: string,
  ): boolean {
    const permissions = calendar.permissions;

    if (Boolean(event.external_id) || event.sync_read_only === true) {
      return permissions.sync.read;
    }

    return event.created_by === userId
      ? permissions.events.own_read
      : permissions.events.others_read;
  }

  private byCalendar(
    events: EventRow[],
    calendars: Map<string, CalendarWithAccess>,
    window: Window,
  ) {
    const grouped = new Map<string, EventRow[]>();

    for (const event of events) {
      grouped.set(event.calendar_id, [
        ...(grouped.get(event.calendar_id) ?? []),
        event,
      ]);
    }

    return [...grouped.entries()]
      .map(([calendarId, rows]) => {
        const calendar = calendars.get(calendarId);
        const totals: InsightTotals = totalsOf(
          rows,
          window.from,
          window.to,
          window.timezone,
        );

        return {
          calendar_id: calendarId,
          name: (calendar?.name as string | undefined) ?? '',
          color: (calendar?.color as string | null | undefined) ?? null,
          events: totals.events,
          event_minutes: totals.event_minutes,
          scheduled_minutes: totals.scheduled_minutes,
        };
      })
      .sort((left, right) => right.event_minutes - left.event_minutes);
  }

  /** How many entries of each kind, in a fixed order, leaving out the kinds with none. */
  private byKind(
    events: EventRow[],
    userId: string,
  ): Array<{ kind: InsightKind; events: number }> {
    const counts = new Map<InsightKind, number>();

    for (const event of events) {
      const kind = kindOf(event, event.created_by === userId);

      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }

    return INSIGHT_KINDS.filter((kind) => counts.has(kind)).map((kind) => ({
      kind,
      events: counts.get(kind) ?? 0,
    }));
  }

  /**
   * The tickets linked from these entries that are past due and not finished.
   *
   * A ticket is listed once however many entries link it. One that was deleted, has no due date, sits
   * in no space, or sits in a space this person cannot read the tickets of is left out without a trace.
   */
  private async overdueFor(
    events: EventRow[],
    userId: string,
    organizationId: string,
    now: number,
  ): Promise<InsightOverdueItem[]> {
    const linkedFrom = new Map<string, EventRow[]>();

    for (const event of events) {
      const links = Array.isArray(event.links)
        ? (event.links as unknown[])
        : [];

      for (const link of links) {
        const { type, id } = (link ?? {}) as { type?: unknown; id?: unknown };

        if (type !== 'task' || typeof id !== 'string') continue;

        const holders = linkedFrom.get(id) ?? [];

        if (!holders.includes(event)) holders.push(event);

        linkedFrom.set(id, holders);
      }
    }

    const ids = [...linkedFrom.keys()];

    if (ids.length === 0) return [];

    const tasks: TaskRow[] = [];

    for (let index = 0; index < ids.length; index += ID_CHUNK) {
      const { data, error } = await this.client
        .from('tasks')
        .select('id, key, summary, status, priority, due_date, space_id')
        .eq('organization_id', organizationId)
        .in('id', ids.slice(index, index + ID_CHUNK))
        .lt('due_date', new Date(now).toISOString())
        .not('status', 'in', FINISHED_STATUSES);

      if (error) throw new BadRequestException(error.message);

      tasks.push(...((data ?? []) as unknown as TaskRow[]));
    }

    // One access answer per space, however many tickets sit in it.
    const allowed = new Map<string, boolean>();

    for (const spaceId of new Set(tasks.map((task) => task.space_id))) {
      if (!spaceId) continue;

      allowed.set(
        spaceId,
        await this.access
          .canReadSpaceTickets(userId, organizationId, spaceId)
          .catch(() => false),
      );
    }

    const readable = tasks.filter(
      (task) => task.space_id && allowed.get(task.space_id) && task.due_date,
    );

    if (readable.length === 0) return [];

    const spaceKeys = await this.spaceKeys(
      [...new Set(readable.map((task) => task.space_id as string))],
      organizationId,
    );

    return readable
      .sort(
        (left, right) =>
          Date.parse(left.due_date as string) -
          Date.parse(right.due_date as string),
      )
      .map((task) => ({
        task: {
          ...task,
          space_key: spaceKeys.get(task.space_id as string) ?? null,
        },
        events: (linkedFrom.get(task.id) ?? []).map((event) => ({
          id: event.id,
          summary: event.summary,
          calendar_id: event.calendar_id,
        })),
      }));
  }

  private async spaceKeys(
    spaceIds: string[],
    organizationId: string,
  ): Promise<Map<string, string>> {
    const { data } = await this.client
      .from('spaces')
      .select('id, key')
      .eq('organization_id', organizationId)
      .in('id', spaceIds);

    return new Map(
      ((data ?? []) as Array<{ id: string; key: string | null }>)
        .filter((space) => space.key)
        .map((space) => [space.id, space.key as string]),
    );
  }
}
