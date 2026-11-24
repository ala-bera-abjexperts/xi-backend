/**
 * @fileoverview Calendar entries: read a date range, create, edit, delete, watchers and links.
 *
 * Access always comes from the entry's calendar, never from the entry itself.
 */
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { cleanDescription } from './calendar-description';
import { meetingLinkProblem } from './calendar-meeting-link';
import { CalendarAuditService } from './calendar-audit.service';
import { CalendarSyncService } from './integrations/calendar-sync.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import type { CalendarRow } from './calendar-access.service';
import { CalendarAccessService } from './calendar-access.service';
import type { CalendarWithAccess } from './calendars.service';
import { CalendarsService } from './calendars.service';
import type { CalendarEventLinkDto } from './dto/calendar-event-links.dto';
import type { CreateCalendarEventDto } from './dto/create-calendar-event.dto';
import type { ListCalendarEventsDto } from './dto/list-calendar-events.dto';
import type { UpdateCalendarEventDto } from './dto/update-calendar-event.dto';
import {
  cancelZoomMeeting,
  createZoomMeeting,
  meetingMinutes,
  updateZoomMeeting,
} from './integrations/zoom-meeting';
import type { ZoomMeetingOptions } from './integrations/zoom-meeting';
import {
  getZoomMeeting,
  updateZoomMeetingSettings,
  zoomOptionsFromMeeting,
} from './integrations/zoom-meeting-settings';
import type { ZoomMeetingSettings } from './integrations/zoom-meeting-settings';
import type { ZoomLogin } from './integrations/zoom-tokens.service';
import { ZoomTokensService } from './integrations/zoom-tokens.service';

/** How far into the past a timed start may sit, for a form filled in slowly or a clock slightly off. */
const PAST_TIME_GRACE_MS = 5 * 60 * 1000;

const TABLE = 'calendar_events';

/** A calendar screen never asks for more than a few months; this keeps one request from reading a decade. */
const MAX_RANGE_DAYS = 100;

const DAY_MS = 86_400_000;

/** Ceiling per space and date field, so one very large space cannot swamp a month view. */
const MAX_TICKETS_PER_SOURCE = 500;

/**
 * How the new Zoom meeting repeats, for the entry to show. Written only when there is something to
 * say, or an older recurrence to clear.
 */
function recurrenceColumn(
  entry: Record<string, unknown>,
  options: ZoomMeetingOptions | undefined,
): Record<string, unknown> {
  if (options?.recurrence) return { meeting_recurrence: options.recurrence };

  return entry.meeting_recurrence ? { meeting_recurrence: null } : {};
}

/**
 * A meeting that never happened leaves no provider behind: a provider without a link fails the
 * entry's own save check, which would leave the entry impossible to edit. The reason is kept.
 */
const FAILED_MEETING = {
  meeting_provider: null,
  meeting_status: 'failed',
};

/** Zoom's own words reach an entry and a screen, so an unbounded message is cut to a readable size. */
const MAX_MEETING_ERROR = 300;

/** A claim older than this was left by a request that never finished, so it may be taken over. */
const STALE_PENDING_MS = 2 * 60 * 1000;

const ZOOM_BUSY = 'A Zoom meeting is already being created for this entry.';

/** The Zoom settings an audit row compares before and after a settings change. */
const ZOOM_SETTING_FIELDS = [
  'passcode_enabled',
  'passcode',
  'waiting_room',
  'encryption_type',
  'host_video',
  'participant_video',
  'continuous_chat',
  'join_before_host',
  'mute_upon_entry',
  'auto_recording',
  'recurrence',
  'meeting_url',
] as const;

/** The HTTP status every Zoom helper error ends with, e.g. "(404)". */
function zoomCode(error: unknown): number | null {
  const match =
    error instanceof Error ? /\((\d{3})\)$/.exec(error.message) : null;

  return match ? Number(match[1]) : null;
}

interface FieldSetting {
  field_id: string;
  required?: boolean;
}

/** A ticket source stored on a calendar. */
interface CalendarFeed {
  id: string;
  space_id: string;
  task_id?: string | null;
  date_field: string;
  label?: string | null;
  color?: string | null;
  excluded_task_ids?: string[] | null;
}

interface TaskRow {
  id: string;
  key: string | null;
  summary: string | null;
  status: string | null;
  priority: string | null;
  space_id: string;
  due_date: string | null;
  start_date: string | null;
  end_date: string | null;
}

@Injectable()
export class CalendarEventsService {
  private readonly logger = new Logger(CalendarEventsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly calendars: CalendarsService,
    private readonly access: CalendarAccessService,
    private readonly audit: CalendarAuditService,
    private readonly sync: CalendarSyncService,
    @Optional()
    private readonly notificationsBroadcast?: NotificationsBroadcastService,
    @Optional()
    private readonly zoomTokens?: ZoomTokensService,
  ) {}

  /** A calendar linked two-way or export-only sends its own changes out; an import-only one only ever reads. */
  private static twoWay(calendar: object): boolean {
    const row = calendar as {
      sync_direction?: unknown;
      sync_account_id?: unknown;
    };

    return (
      (row.sync_direction === 'two_way' || row.sync_direction === 'export') &&
      Boolean(row.sync_account_id)
    );
  }

  /** Only an entry written here can be given a meeting; a synced or read-only copy cannot. */
  private static authoredHere(entry: Record<string, unknown>): boolean {
    return (
      entry.sync_read_only !== true &&
      (entry.source === 'local' || entry.source === 'automation')
    );
  }

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Entries of every calendar the user may see, inside the window. */
  async list(
    query: ListCalendarEventsDto,
    userId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>[]> {
    const { from, to } = this.window(query);
    const visible = await this.calendars.listVisible(userId, organizationId);
    const wanted = query.calendar_ids?.length
      ? visible.filter((calendar) => query.calendar_ids!.includes(calendar.id))
      : visible;

    if (wanted.length === 0) return [];

    // All-day entries are plain dates, so the date window is widened by a day at each end and the
    // exact comparison happens below. Without it an entry could be missed either side of midnight.
    const fromDate = new Date(from.getTime() - DAY_MS)
      .toISOString()
      .slice(0, 10);
    const toDate = new Date(to.getTime() + DAY_MS).toISOString().slice(0, 10);

    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .in(
        'calendar_id',
        wanted.map((calendar) => calendar.id),
      )
      .is('deleted_at', null)
      .or(
        `and(starts_at.lte.${to.toISOString()},ends_at.gte.${from.toISOString()}),` +
          `and(start_date.lte.${toDate},end_date.gte.${fromDate})`,
      );

    if (error) throw new BadRequestException(error.message);

    const byId = new Map(wanted.map((calendar) => [calendar.id, calendar]));

    // Reading is granted per kind of content, so an entry is kept only when this person may see that
    // kind: their own, somebody else's, or one brought in from a connected calendar. Marking it
    // read-only is the same question asked about changing it, which the editor needs before it opens.
    const events = ((data ?? []) as Record<string, unknown>[])
      .map((event) => {
        const calendar = byId.get(event.calendar_id as string);

        if (!calendar) return null;

        if (!this.mayRead(event, calendar, userId)) return null;

        // Changed in Zoom only; the next sync would overwrite an edit made here.
        if (event.source === 'zoom') return { ...event, read_only: true };

        return this.mayTouch(event, calendar, userId, 'update').allowed
          ? event
          : { ...event, read_only: true };
      })
      .filter((event): event is Record<string, unknown> => event !== null);

    // Ticket dates are their own permission; a calendar that may not show them contributes none.
    const withTickets = wanted.filter(
      (calendar) => calendar.permissions.task_events.read,
    );

    const tickets = await this.ticketItems(
      withTickets,
      from,
      to,
      query.tz,
      userId,
      organizationId,
    );

    return [...events, ...tickets];
  }

  /**
   * Tickets shown through a calendar's sources, worked out at read time.
   *
   * Nothing is copied: every read re-checks the viewer's own access to the space, so moving a due
   * date, deleting a ticket or losing access all take effect immediately.
   */
  private async ticketItems(
    calendars: Array<CalendarRow & { access?: string }>,
    from: Date,
    to: Date,
    timezone: string | undefined,
    userId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>[]> {
    const sources: Array<{ calendar: CalendarRow; feed: CalendarFeed }> = [];

    for (const calendar of calendars) {
      for (const feed of (calendar.feeds ?? []) as CalendarFeed[]) {
        if (feed?.space_id && feed.date_field) sources.push({ calendar, feed });
      }
    }

    if (sources.length === 0) return [];

    // Any open space with Tasks on shows its linked tickets; the calendar's own "View ticket dates" decides who sees them
    const linkable = new Set(
      (await this.access.linkableSpaces(organizationId)).map(
        (space) => space.id,
      ),
    );

    const visible = sources.filter((source) =>
      linkable.has(source.feed.space_id),
    );

    if (visible.length === 0) return [];

    const items: Record<string, unknown>[] = [];
    const spaceKeys = await this.spaceKeys(
      [...new Set(visible.map((source) => source.feed.space_id))],
      organizationId,
    );

    // One query per space + date field, not per calendar.
    const groups = new Map<
      string,
      Array<{ calendar: CalendarRow; feed: CalendarFeed }>
    >();

    for (const source of visible) {
      // A source pinned to one ticket queries on its own, so it cannot pick up the rest of the space.
      const groupKey = `${source.feed.space_id}:${source.feed.date_field}:${source.feed.task_id ?? ''}`;

      groups.set(groupKey, [...(groups.get(groupKey) ?? []), source]);
    }

    // A ticket belongs on a calendar once, however many of its sources happen to match.
    const placed = new Set<string>();

    for (const [groupKey, grouped] of groups) {
      const [spaceId, dateField, taskId] = groupKey.split(':');
      let query = this.client
        .from('tasks')
        .select(
          'id, key, summary, status, priority, space_id, due_date, start_date, end_date',
        )
        .eq('organization_id', organizationId)
        .eq('space_id', spaceId)
        .gte(dateField, new Date(from.getTime() - DAY_MS).toISOString())
        .lte(dateField, new Date(to.getTime() + DAY_MS).toISOString())
        .limit(MAX_TICKETS_PER_SOURCE);

      if (taskId) query = query.eq('id', taskId);

      const { data, error } = await query;

      if (error) throw new BadRequestException(error.message);

      for (const task of (data ?? []) as TaskRow[]) {
        const at = task[dateField as 'due_date' | 'start_date' | 'end_date'];

        if (!at) continue;

        for (const { calendar, feed } of grouped) {
          const seat = `${calendar.id}:${task.id}`;

          // A ticket left out of a whole-space source is not shown through it
          if (feed.excluded_task_ids?.includes(task.id)) continue;

          if (placed.has(seat)) continue;

          placed.add(seat);
          items.push(
            this.ticketItem(
              task,
              at,
              calendar,
              feed,
              spaceKeys.get(spaceId),
              timezone,
            ),
          );
        }
      }
    }

    return items;
  }

  /** A ticket as a whole-day entry, on the day the viewer reads the date as. */
  private ticketItem(
    task: TaskRow,
    at: string,
    calendar: CalendarRow,
    feed: CalendarFeed,
    spaceKey: string | undefined,
    timezone: string | undefined,
  ): Record<string, unknown> {
    const day = this.dayIn(
      at,
      timezone ?? (calendar.default_timezone as string),
    );

    return {
      id: `feed:${feed.id}:${task.id}`,
      organization_id: calendar.organization_id,
      calendar_id: calendar.id,
      summary: task.key
        ? `${task.key} ${task.summary ?? ''}`.trim()
        : (task.summary ?? 'Ticket'),
      description: null,
      location: null,
      is_all_day: true,
      starts_at: null,
      ends_at: null,
      start_date: day,
      end_date: this.nextDay(day),
      timezone: timezone ?? calendar.default_timezone,
      meeting_provider: null,
      meeting_url: null,
      meeting_id: null,
      meeting_status: 'none',
      meeting_error: null,
      custom_field_values: {},
      watcher_ids: [],
      links: [{ type: 'task', id: task.id }],
      source: 'feed',
      deleted_at: null,
      created_at: at,
      updated_at: at,

      // Everything below is what a calendar screen needs to show and open the ticket.
      read_only: true,
      feed: {
        id: feed.id,
        label: feed.label ?? null,
        color: feed.color ?? null,
        date_field: feed.date_field,
      },
      ticket: {
        id: task.id,
        key: task.key,
        summary: task.summary,
        status: task.status,
        priority: task.priority,
        space_id: task.space_id,
        space_key: spaceKey ?? null,
        at,
      },
    };
  }

  /**
   * The calendar day an instant falls on, read in one time zone.
   *
   * A ticket due date is a day, not a moment: many are stored as local midnight elsewhere, so reading
   * them in the viewer's zone is what keeps a deadline on the day people set it.
   */
  private dayIn(at: string, timezone: string): string {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(at));
    } catch {
      return new Date(at).toISOString().slice(0, 10);
    }
  }

  private nextDay(day: string): string {
    return new Date(new Date(`${day}T00:00:00Z`).getTime() + DAY_MS)
      .toISOString()
      .slice(0, 10);
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

  /**
   * Which flag governs this entry, and whether the person holds it.
   *
   * An entry is one of three things and each is granted separately: a copy pulled in from a connected
   * calendar, something this person wrote, or something somebody else wrote. A ticket date never
   * reaches here — it has no row of its own.
   */
  private mayTouch(
    event: Record<string, unknown>,
    calendar: CalendarWithAccess,
    userId: string,
    action: 'update' | 'delete',
  ): { allowed: boolean; what: string } {
    const permissions = calendar.permissions;

    // Editing and deleting follow the Entries boxes only, imported entries included.
    // Previously an entry brought in from a connected calendar asked for the synced-entries flags:
    // const imported = Boolean(event.external_id) || event.sync_read_only === true;
    // if (imported) {
    //   return {
    //     allowed: action === 'update' ? permissions.sync.update : permissions.sync.delete,
    //     what: action === 'update'
    //       ? 'change an entry brought in from a connected calendar'
    //       : 'remove an entry brought in from a connected calendar',
    //   };
    // }

    const mine = event.created_by === userId;

    if (mine) {
      return {
        allowed:
          action === 'update'
            ? permissions.events.own_update
            : permissions.events.own_delete,
        what:
          action === 'update'
            ? 'change your own entries'
            : 'delete your own entries',
      };
    }

    return {
      allowed:
        action === 'update'
          ? permissions.events.others_update
          : permissions.events.others_delete,
      what:
        action === 'update'
          ? 'change entries somebody else created'
          : 'delete entries somebody else created',
    };
  }

  /** Whether this person may see this one entry, by the kind of content it is. */
  private mayRead(
    event: Record<string, unknown>,
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

  /** Whether a person may read this entry, by its calendar and its kind; never throws. */
  async canUserSeeEntry(
    entry: Record<string, unknown>,
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    try {
      const calendar = await this.calendars.getForUser(
        entry.calendar_id as string,
        userId,
        organizationId,
        'view',
      );

      return this.mayRead(entry, calendar, userId);
    } catch {
      return false;
    }
  }

  /**
   * A person's timed entry starts now or later and ends after it starts. An entry being changed keeps its
   * own earlier start; a few minutes of grace cover a form left open. Request path only, like the whole-day rule.
   */
  async assertNoPastTime(
    dto: Pick<CreateCalendarEventDto, 'is_all_day' | 'starts_at' | 'ends_at'>,
    userId: string,
    organizationId: string,
    id?: string,
  ): Promise<void> {
    if (!dto.starts_at && !dto.ends_at) return;

    const current = id
      ? await this.getForUser(id, userId, organizationId, 'edit')
      : null;
    const allDay =
      dto.is_all_day ?? (current?.is_all_day as boolean | undefined) ?? false;

    if (allDay) return;

    const start = dto.starts_at ?? (current?.starts_at as string | undefined);
    const end = dto.ends_at ?? (current?.ends_at as string | undefined);

    if (start && end && Date.parse(end) <= Date.parse(start)) {
      throw new BadRequestException('An entry must end after it starts.');
    }

    if (!dto.starts_at) return;

    const stored = current?.starts_at
      ? Date.parse(current.starts_at as string)
      : Number.POSITIVE_INFINITY;
    const floor = Math.min(stored, Date.now() - PAST_TIME_GRACE_MS);

    if (Date.parse(dto.starts_at) < floor) {
      throw new BadRequestException('An entry cannot start in the past.');
    }
  }

  /**
   * A person's own entries in one calendar may touch but never overlap; other calendars do not count.
   * Mirrors the entry dialog's check, so a save that skips the dialog is held to the same rule.
   * Request path only, like the past-date rules, so sync and automations are not held to it.
   */
  async assertNoOwnClash(
    dto: Partial<
      Pick<
        CreateCalendarEventDto,
        | 'calendar_id'
        | 'is_all_day'
        | 'starts_at'
        | 'ends_at'
        | 'start_date'
        | 'end_date'
      >
    >,
    userId: string,
    organizationId: string,
    id?: string,
  ): Promise<void> {
    const changesTime =
      dto.is_all_day !== undefined ||
      dto.starts_at !== undefined ||
      dto.ends_at !== undefined ||
      dto.start_date !== undefined ||
      dto.end_date !== undefined;

    // An edit that leaves the time alone cannot create a new overlap.
    if (id && !changesTime) return;

    const current = id
      ? await this.getForUser(id, userId, organizationId, 'edit')
      : null;
    const calendarId =
      dto.calendar_id ?? (current?.calendar_id as string | undefined);

    if (!calendarId) return;

    const allDay =
      dto.is_all_day ?? (current?.is_all_day as boolean | undefined) ?? false;

    let query = this.client
      .from(TABLE)
      .select(
        'id, summary, is_all_day, starts_at, ends_at, start_date, end_date, timezone',
      )
      .eq('organization_id', organizationId)
      .eq('calendar_id', calendarId)
      .eq('created_by', userId)
      .eq('source', 'local')
      .eq('is_all_day', allDay)
      .is('deleted_at', null);

    if (allDay) {
      const first =
        dto.start_date ?? (current?.start_date as string | undefined);
      const after = dto.end_date ?? (current?.end_date as string | undefined);

      if (!first || !after) return;

      // The stored end is the day after the last one, so days that only touch do not overlap.
      query = query.lt('start_date', after).gt('end_date', first);
    } else {
      const from = dto.starts_at ?? (current?.starts_at as string | undefined);
      const to = dto.ends_at ?? (current?.ends_at as string | undefined);

      if (!from || !to || Date.parse(to) <= Date.parse(from)) return;

      query = query.lt('starts_at', to).gt('ends_at', from);
    }

    if (id) query = query.neq('id', id);

    const { data, error } = await query.limit(1);

    if (error) throw new BadRequestException(error.message);

    const clash = ((data ?? []) as Record<string, unknown>[])[0];

    if (!clash) return;

    const zone = (clash.timezone as string | null) || 'UTC';
    const start = new Date(clash.starts_at as string);
    const end = new Date(clash.ends_at as string);
    const when = clash.is_all_day
      ? 'a whole day'
      : `${CalendarEventsService.dayLabel(start, zone)} · ${CalendarEventsService.clockLabel(start, zone)} – ${CalendarEventsService.clockLabel(end, zone)}`;

    throw new ConflictException(
      `You already have "${(clash.summary as string) || 'an entry'}" in this calendar at that time (${when}). Your own entries in one calendar cannot overlap.`,
    );
  }

  /**
   * A person may not put a whole-day entry on a day already gone, counted in the entry's own time zone.
   * An entry being changed keeps its own earlier first day. Called from the request path only, so sync
   * and automations, which write through other paths, are not held to it.
   */
  async assertNoPastWholeDay(
    dto: Pick<CreateCalendarEventDto, 'is_all_day' | 'start_date' | 'timezone'>,
    userId: string,
    organizationId: string,
    id?: string,
  ): Promise<void> {
    if (!dto.start_date) return;

    const current = id
      ? await this.getForUser(id, userId, organizationId, 'edit')
      : null;
    const allDay =
      dto.is_all_day ?? (current?.is_all_day as boolean | undefined) ?? false;

    if (!allDay) return;

    const today = CalendarEventsService.todayIn(
      dto.timezone ?? (current?.timezone as string | undefined) ?? 'UTC',
    );
    const stored = current?.start_date as string | null | undefined;
    const floor = stored && stored < today ? stored : today;

    if (dto.start_date < floor) {
      throw new BadRequestException(
        'A whole-day entry cannot start before today.',
      );
    }
  }

  /** Today's date as YYYY-MM-DD in a time zone; an unknown zone falls back to UTC. */
  private static todayIn(zone: string): string {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  async getForUser(
    id: string,
    userId: string,
    organizationId: string,
    needed: 'view' | 'edit' | 'manage' = 'view',
  ): Promise<Record<string, unknown>> {
    const result = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .maybeSingle();

    if (result.error) throw new BadRequestException(result.error.message);
    if (!result.data) throw new NotFoundException('Calendar entry not found');

    const event = result.data as Record<string, unknown>;

    const calendar = await this.calendars.getForUser(
      event.calendar_id as string,
      userId,
      organizationId,
      needed,
    );

    // An entry this person may not see must not be reachable by its id either.
    if (!this.mayRead(event, calendar, userId)) {
      throw new NotFoundException('Calendar entry not found');
    }

    if (event.source === 'zoom') return { ...event, read_only: true };

    // The list marks these; one entry read alone must say the same, or the editor opens a form the
    // save would refuse.
    return this.mayTouch(event, calendar, userId, 'update').allowed
      ? event
      : { ...event, read_only: true };
  }

  async create(
    dto: CreateCalendarEventDto,
    userId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const calendar = await this.calendars.getForUser(
      dto.calendar_id,
      userId,
      organizationId,
      'edit',
    );

    // Adding an entry is "Add entries" alone, linked calendar or not.
    // Previously a linked calendar asked for the synced-entries create flag instead:
    // const linked = Boolean(calendar.sync_account_id);
    // this.access.assertAllowed(
    //   linked ? calendar.permissions.sync.create : calendar.permissions.events.create,
    //   linked ? 'add entries to a synced calendar' : 'add entries to this calendar',
    // );
    this.access.assertAllowed(
      calendar.permissions.events.create,
      'add entries to this calendar',
    );
    this.assertTimezone(dto.timezone);

    // Only an explicit ask generates one, so feeds, syncs and automations still paste their own link.
    const generating =
      dto.generate_meeting === true &&
      dto.meeting_provider === 'zoom' &&
      !dto.meeting_url;

    this.assertMeeting(dto.meeting_provider, dto.meeting_url, generating);
    this.assertMeetingLink(dto.meeting_url, dto.meeting_provider ?? null);
    await this.assertCustomFields(calendar, dto.custom_field_values ?? {}, {});
    await this.assertWatchers(calendar, dto.watcher_ids ?? []);
    this.assertLinks(dto.links ?? []);

    const row = {
      organization_id: organizationId,
      calendar_id: calendar.id,
      summary: dto.summary,
      description: cleanDescription(dto.description),
      location: dto.location ?? null,
      is_all_day: dto.is_all_day ?? false,
      starts_at: dto.starts_at ?? null,
      ends_at: dto.ends_at ?? null,
      start_date: dto.start_date ?? null,
      end_date: dto.end_date ?? null,
      timezone: dto.timezone ?? (calendar.default_timezone as string) ?? 'UTC',
      meeting_provider: dto.meeting_provider ?? null,
      meeting_url: dto.meeting_url ?? null,
      meeting_id: dto.meeting_id ?? null,
      ...(generating ? { meeting_status: 'pending', meeting_id: null } : {}),
      custom_field_values: dto.custom_field_values ?? {},
      watcher_ids: dto.watcher_ids ?? [],
      links: dto.links ?? [],
      ...(dto.reminders !== undefined ? { reminders: dto.reminders } : {}),
      source: 'local',
      sync_pending: CalendarEventsService.twoWay(calendar),
      created_by: userId,
      updated_by: userId,
    };

    const result = await this.client.from(TABLE).insert(row).select().single();

    if (result.error) throw this.friendlyWriteError(result.error.message);

    const created = result.data as Record<string, unknown>;

    this.audit.entry('create', organizationId, userId, created.id as string, {
      summary: created.summary as string,
      calendar_id: calendar.id,
    });

    if (CalendarEventsService.twoWay(calendar)) this.sync.pushSoon(calendar.id);

    this.notifyLinkedUsers(created, calendar, [], userId, organizationId);
    this.notifyFollowers(created, calendar, [], userId, organizationId);

    // The entry is stored first, so a Zoom failure never costs the entry itself.
    return generating
      ? this.generateZoomMeeting(created, userId, dto.zoom_options)
      : created;
  }

  async update(
    id: string,
    dto: UpdateCalendarEventDto,
    userId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const current = await this.getForUser(id, userId, organizationId, 'edit');
    const calendar = await this.calendars.getForUser(
      current.calendar_id as string,
      userId,
      organizationId,
      'edit',
    );

    // The next sync would overwrite any edit, so a Zoom entry is changed in Zoom only.
    if (current.source === 'zoom') {
      throw new BadRequestException(
        'This entry comes from Zoom — change it in Zoom; the next sync brings the change in.',
      );
    }

    const mayUpdate = this.mayTouch(current, calendar, userId, 'update');

    this.access.assertAllowed(mayUpdate.allowed, mayUpdate.what);
    this.assertTimezone(dto.timezone);

    const nextProvider =
      dto.meeting_provider !== undefined
        ? dto.meeting_provider
        : (current.meeting_provider as string | null);
    const nextUrl =
      dto.meeting_url !== undefined
        ? dto.meeting_url
        : (current.meeting_url as string | null);

    // The same opt-in a create uses, and only on an entry authored here.
    const generating =
      dto.generate_meeting === true &&
      nextProvider === 'zoom' &&
      !nextUrl &&
      CalendarEventsService.authoredHere(current);

    // A partial edit is judged on what the entry ends up as, not on what this request happens to carry.
    this.assertMeeting(
      dto.meeting_provider !== undefined
        ? dto.meeting_provider
        : (current.meeting_provider as string | null),
      dto.meeting_url !== undefined
        ? dto.meeting_url
        : (current.meeting_url as string | null),
      generating,
    );
    this.assertMeetingLink(
      dto.meeting_url,
      dto.meeting_provider !== undefined
        ? dto.meeting_provider
        : (current.meeting_provider as string | null),
    );

    if (dto.custom_field_values !== undefined) {
      await this.assertCustomFields(
        calendar,
        dto.custom_field_values,
        (current.custom_field_values as Record<string, unknown>) ?? {},
      );
    }

    if (dto.watcher_ids !== undefined) {
      await this.assertWatchers(calendar, dto.watcher_ids);
    }

    if (dto.links !== undefined) this.assertLinks(dto.links);

    const { updated_at: seen, ...patch } = dto;

    // An instruction rather than a column, so it must never reach the write.
    delete patch.generate_meeting;
    delete patch.zoom_options;

    // Once Zoom holds a meeting for this entry its id is the server's, or an edit could aim at another meeting.
    if (
      current.meeting_status === 'created' ||
      current.meeting_status === 'pending'
    ) {
      delete patch.meeting_id;
    }

    if (generating && this.pendingIsFresh(current)) {
      throw new ConflictException(ZOOM_BUSY);
    }

    const fields: Record<string, unknown> = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );

    if (dto.description !== undefined) {
      fields.description = cleanDescription(dto.description);
    }

    if (CalendarEventsService.twoWay(calendar)) fields.sync_pending = true;

    let write = this.client
      .from(TABLE)
      .update({
        ...fields,
        ...(generating ? { meeting_status: 'pending' } : {}),
        updated_by: userId,
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .is('deleted_at', null);

    // Optimistic check: the row only changes while it still looks the way the user last saw it.
    if (seen) write = write.eq('updated_at', seen);

    // Only one request may start the meeting; a second one finds it pending and gets the usual 409.
    if (generating) write = write.neq('meeting_status', 'pending');

    const result = await write.select().maybeSingle();

    if (result.error) throw this.friendlyWriteError(result.error.message);

    if (!result.data) {
      throw new ConflictException(
        'This entry was changed by someone else. Reload it and try again.',
      );
    }

    const written = result.data as Record<string, unknown>;

    const values = CalendarAuditService.valueChanges(
      current,
      written,
      Object.keys(fields),
    );

    // A save that changed nothing is not an edit, so it leaves no row in the trail.
    if (Object.keys(values).length > 0) {
      this.audit.entry('update', organizationId, userId, id, {
        summary:
          (written?.summary as string | undefined) ??
          (current.summary as string),
        calendar_id: calendar.id,

        // Only what was actually sent: an optional field left out arrives as undefined, not as a change.
        fields: Object.keys(fields),
        values,
      });
    }

    if (CalendarEventsService.twoWay(calendar)) this.sync.pushSoon(calendar.id);

    // A follower added during an edit is told; one already following is not told again.
    if (dto.watcher_ids !== undefined) {
      this.notifyFollowers(
        written,
        calendar,
        (current.watcher_ids as string[] | null) ?? [],
        userId,
        organizationId,
      );
    }

    if (dto.links !== undefined) {
      this.notifyLinkedUsers(
        written,
        calendar,
        (current.links as CalendarEventLinkDto[] | null) ?? [],
        userId,
        organizationId,
      );
    }

    // The old meeting goes first, so a new one asked for in the same save never leaves two behind.
    const settled = this.zoomLeft(current, written)
      ? await this.dropZoomMeeting(current, written, userId)
      : null;

    return generating
      ? this.generateZoomMeeting(settled ?? written, userId, dto.zoom_options)
      : (settled ?? this.syncZoomMeeting(current, written, userId));
  }

  /**
   * Makes the Zoom meeting for an entry that has none, and hands the entry back with its link.
   *
   * Apart from the save so an entry whose meeting never happened can try again without being edited,
   * and so the slow part sits outside every ordinary save.
   */
  async zoomMeeting(
    id: string,
    userId: string,
    organizationId: string,
    zoomOptions?: ZoomMeetingOptions,
  ): Promise<Record<string, unknown>> {
    const current = await this.getForUser(id, userId, organizationId, 'edit');

    const calendar = await this.calendars.getForUser(
      current.calendar_id as string,
      userId,
      organizationId,
      'edit',
    );

    const mayUpdate = this.mayTouch(current, calendar, userId, 'update');

    this.access.assertAllowed(mayUpdate.allowed, mayUpdate.what);

    // An entry mirrored from an outside calendar is shown here, never authored here.
    if (!CalendarEventsService.authoredHere(current)) {
      throw new BadRequestException(
        'This entry comes from a connected calendar.',
      );
    }

    if (current.meeting_url) {
      throw new BadRequestException('This entry already has a meeting link.');
    }

    if (!current.starts_at) {
      throw new BadRequestException('A Zoom meeting needs a start time.');
    }

    if (this.hasEnded(current)) {
      throw new BadRequestException('This entry has already ended.');
    }

    return this.generateZoomMeeting(
      await this.claimZoomMeeting(current),
      userId,
      zoomOptions,
    );
  }

  /** The current settings of the entry's Zoom meeting, read from Zoom through the host's login. */
  async zoomMeetingSettings(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<ZoomMeetingSettings> {
    const current = await this.madeZoomMeeting(id, userId, organizationId);
    let host: ZoomLogin | undefined;

    try {
      host = await this.hostLogin(current);

      return zoomOptionsFromMeeting(
        await getZoomMeeting(current.meeting_id as string, host?.token),
      );
    } catch (error) {
      return this.zoomSettingsFailed(current, host, error);
    }
  }

  /** Changes the entry's Zoom meeting settings and stores the join link Zoom now gives it. */
  async updateZoomMeetingSettings(
    id: string,
    userId: string,
    organizationId: string,
    options: ZoomMeetingOptions,
  ): Promise<Record<string, unknown>> {
    const current = await this.madeZoomMeeting(id, userId, organizationId);
    const meetingId = current.meeting_id as string;
    let host: ZoomLogin | undefined;
    let joinUrl: unknown;
    let before: ZoomMeetingOptions | undefined;
    let after: ZoomMeetingOptions | undefined;

    try {
      host = await this.hostLogin(current);

      // Read from Zoom on both sides, so the log shows what Zoom really had and has.
      before = zoomOptionsFromMeeting(
        await getZoomMeeting(meetingId, host?.token),
      ).options;

      await updateZoomMeetingSettings(
        meetingId,
        options,
        Boolean(current.meeting_recurrence),
        host?.token,
      );

      // A new passcode changes the join link, so it is read back rather than assumed.
      const read = await getZoomMeeting(meetingId, host?.token);

      joinUrl = read.join_url;
      after = zoomOptionsFromMeeting(read).options;
    } catch (error) {
      this.audit.entry('zoom_meeting_failed', organizationId, userId, id, {
        summary: current.summary as string,
        meeting_id: meetingId,
        stage: 'settings',
        status: zoomCode(error),
      });

      return this.zoomSettingsFailed(current, host, error);
    }

    if (typeof joinUrl !== 'string' || meetingLinkProblem(joinUrl, 'zoom')) {
      throw new BadGatewayException(
        `Zoom answered with a link that is not a Zoom meeting link (meeting ${meetingId}). (502)`,
      );
    }

    this.audit.entry('zoom_meeting_settings', organizationId, userId, id, {
      summary: current.summary as string,
      meeting_id: meetingId,
      values: CalendarAuditService.valueChanges(
        { ...before, meeting_url: current.meeting_url },
        { ...after, meeting_url: joinUrl },
        ZOOM_SETTING_FIELDS,
      ),
    });

    return this.writeMeeting(current, {
      meeting_url: joinUrl,
      meeting_error: null,
      ...recurrenceColumn(current, options),
    });
  }

  /** The entry, once the caller may edit it and its Zoom meeting was made here. */
  private async madeZoomMeeting(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const current = await this.getForUser(id, userId, organizationId, 'edit');

    const calendar = await this.calendars.getForUser(
      current.calendar_id as string,
      userId,
      organizationId,
      'edit',
    );

    const mayUpdate = this.mayTouch(current, calendar, userId, 'update');

    this.access.assertAllowed(mayUpdate.allowed, mayUpdate.what);

    if (!CalendarEventsService.authoredHere(current)) {
      throw new BadRequestException(
        'This entry comes from a connected calendar. (400)',
      );
    }

    // Checked before the meeting itself, as a meeting being made is not yet 'created'.
    if (this.pendingIsFresh(current)) {
      throw new ConflictException(`${ZOOM_BUSY} (409)`);
    }

    if (
      current.meeting_provider !== 'zoom' ||
      current.meeting_status !== 'created' ||
      !current.meeting_id
    ) {
      throw new BadRequestException(
        'This entry has no Zoom meeting made here. (400)',
      );
    }

    return current;
  }

  /** Turns a Zoom refusal on the settings routes into the matching HTTP error. */
  private async zoomSettingsFailed(
    current: Record<string, unknown>,
    host: ZoomLogin | undefined,
    error: unknown,
  ): Promise<never> {
    const code = zoomCode(error);

    if (code === 404) {
      await this.forgetGoneMeeting(current);

      throw new NotFoundException('This Zoom meeting no longer exists (404)');
    }

    if (code === 401) {
      if (host) {
        await this.zoomTokens?.invalid(host.accountId, this.zoomReason(error));
      }

      throw new BadRequestException(
        'Reconnect Zoom to change this meeting (401)',
      );
    }

    if (code === 504) {
      throw new GatewayTimeoutException(this.zoomReason(error));
    }

    // Every Zoom helper error already ends with its status, 429 included.
    throw new BadRequestException(this.zoomReason(error));
  }

  /** Soft delete: the tombstone is what lets the deletion reach an external calendar later. */
  async remove(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<{ success: true }> {
    const current = await this.getForUser(id, userId, organizationId, 'edit');

    const calendar = await this.calendars.getForUser(
      current.calendar_id as string,
      userId,
      organizationId,
      'edit',
    );

    const mayDelete = this.mayTouch(current, calendar, userId, 'delete');

    this.access.assertAllowed(mayDelete.allowed, mayDelete.what);

    const { error } = await this.client
      .from(TABLE)
      .update({
        deleted_at: new Date().toISOString(),
        updated_by: userId,
        ...(CalendarEventsService.twoWay(calendar)
          ? { sync_pending: true }
          : {}),
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .is('deleted_at', null);

    if (error) throw new BadRequestException(error.message);

    this.audit.entry('delete', organizationId, userId, id, {
      summary: current.summary as string,
      calendar_id: calendar.id,
    });

    if (CalendarEventsService.twoWay(calendar)) this.sync.pushSoon(calendar.id);

    if (
      current.meeting_provider === 'zoom' &&
      current.meeting_status === 'created' &&
      current.meeting_id
    ) {
      // The entry is already gone; a meeting left behind is logged, never worth failing the request for.
      await this.cancelQuietly(current, id, userId, organizationId);
    }

    return { success: true };
  }

  async setWatchers(
    id: string,
    watcherIds: string[],
    userId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const current = await this.getForUser(id, userId, organizationId, 'edit');
    const calendar = await this.calendars.getForUser(
      current.calendar_id as string,
      userId,
      organizationId,
      'edit',
    );

    const mayWatch = this.mayTouch(current, calendar, userId, 'update');

    this.access.assertAllowed(mayWatch.allowed, mayWatch.what);
    await this.assertWatchers(calendar, watcherIds);

    const written = await this.write(id, organizationId, {
      watcher_ids: watcherIds,
      updated_by: userId,
    });

    this.notifyFollowers(
      written,
      calendar,
      (current.watcher_ids as string[] | null) ?? [],
      userId,
      organizationId,
    );

    return written;
  }

  async setLinks(
    id: string,
    links: CalendarEventLinkDto[],
    userId: string,
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const current = await this.getForUser(id, userId, organizationId, 'edit');

    const calendar = await this.calendars.getForUser(
      current.calendar_id as string,
      userId,
      organizationId,
      'edit',
    );

    const mayLink = this.mayTouch(current, calendar, userId, 'update');

    this.access.assertAllowed(mayLink.allowed, mayLink.what);
    this.assertLinks(links);

    const written = await this.write(id, organizationId, {
      links,
      updated_by: userId,
    });

    this.notifyLinkedUsers(
      written,
      calendar,
      (current.links as CalendarEventLinkDto[] | null) ?? [],
      userId,
      organizationId,
    );

    return written;
  }

  /**
   * Fills in the Zoom link for an entry that asked for one.
   *
   * The entry is already stored, so a Zoom failure is recorded on the row rather than thrown —
   * losing someone's entry because Zoom was down is the worse outcome of the two.
   */
  private async generateZoomMeeting(
    created: Record<string, unknown>,
    userId: string,
    zoomOptions?: ZoomMeetingOptions,
  ): Promise<Record<string, unknown>> {
    const patch = await this.zoomPatch(created, userId, zoomOptions);

    const result = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', created.id as string)
      .eq('organization_id', created.organization_id as string)
      .is('deleted_at', null)
      .select()
      .maybeSingle();

    if (!result.error && result.data) {
      return result.data as Record<string, unknown>;
    }

    // Deleted meanwhile, or the link could not be stored: the meeting must not outlive its entry.
    if (patch.meeting_status === 'created') {
      await this.cancelQuietly(
        patch,
        created.id as string,
        userId,
        created.organization_id as string,
      );

      return {
        ...created,
        ...FAILED_MEETING,
        meeting_error: 'The Zoom meeting could not be saved on this entry.',
      };
    }

    // The entry is saved either way; a failed patch only costs the stored link.
    return { ...created, ...patch };
  }

  /** Marks the entry as getting a meeting, so a second request cannot make another one. */
  private async claimZoomMeeting(
    current: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Plain filters only: on an update an .or() is judged against the row after the change.
    const claim = () =>
      this.client
        .from(TABLE)
        .update({ meeting_status: 'pending' })
        .eq('id', current.id as string)
        .eq('organization_id', current.organization_id as string)
        .is('deleted_at', null)
        .is('meeting_url', null);

    const first = await claim()
      .neq('meeting_status', 'pending')
      .select()
      .maybeSingle();

    if (first.error) throw new BadRequestException(first.error.message);
    if (first.data) return first.data as Record<string, unknown>;

    // A claim left by a request that never finished may be taken over.
    const stale = new Date(Date.now() - STALE_PENDING_MS).toISOString();

    const second = await claim()
      .eq('meeting_status', 'pending')
      .lt('updated_at', stale)
      .select()
      .maybeSingle();

    if (second.error) throw new BadRequestException(second.error.message);
    if (second.data) return second.data as Record<string, unknown>;

    throw new ConflictException(ZOOM_BUSY);
  }

  /** Whether another request is creating this entry's meeting right now. */
  private pendingIsFresh(row: Record<string, unknown>): boolean {
    return (
      row.meeting_status === 'pending' &&
      Date.parse(row.updated_at as string) > Date.now() - STALE_PENDING_MS
    );
  }

  private hasEnded(row: Record<string, unknown>): boolean {
    const endsAt = row.ends_at as string | null;

    return Boolean(endsAt) && Date.parse(endsAt as string) < Date.now();
  }

  /** The entry had a meeting made for it and has now moved away from that link. */
  private zoomLeft(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): boolean {
    return (
      before.meeting_provider === 'zoom' &&
      before.meeting_status === 'created' &&
      Boolean(before.meeting_id) &&
      (after.meeting_url !== before.meeting_url ||
        after.meeting_provider !== 'zoom' ||
        after.is_all_day === true)
    );
  }

  /** Cancels the meeting an entry no longer uses and forgets it. */
  private async dropZoomMeeting(
    before: Record<string, unknown>,
    written: Record<string, unknown>,
    userId: string,
  ): Promise<Record<string, unknown>> {
    await this.cancelQuietly(
      before,
      written.id as string,
      userId,
      written.organization_id as string,
    );

    // The cancelled meeting's own link goes with it; a link the person typed instead stays.
    const cleared = {
      meeting_id: null,
      meeting_status: 'none',
      meeting_error: null,
      meeting_host_user_id: null,
      meeting_zoom_user_id: null,
      ...(written.meeting_url === before.meeting_url
        ? { meeting_url: null, meeting_provider: null }
        : {}),
    };

    return this.writeMeeting(written, cleared);
  }

  /** The meeting was deleted inside Zoom, so its dead link goes and a fresh one can be made. */
  private forgetGoneMeeting(
    written: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.writeMeeting(written, {
      ...FAILED_MEETING,
      meeting_url: null,
      meeting_id: null,
      meeting_host_user_id: null,
      meeting_zoom_user_id: null,
      meeting_error: 'The Zoom meeting no longer exists. (404)',
    });
  }

  /** Stores meeting fields on a live entry; the merged row stands in when the write fails. */
  private async writeMeeting(
    row: Record<string, unknown>,
    fields: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.client
      .from(TABLE)
      .update(fields)
      .eq('id', row.id as string)
      .eq('organization_id', row.organization_id as string)
      .is('deleted_at', null)
      .select()
      .maybeSingle();

    return !result.error && result.data
      ? (result.data as Record<string, unknown>)
      : { ...row, ...fields };
  }

  /** Cancels through the host's login without failing the caller; only ids and status are logged. */
  private async cancelQuietly(
    meeting: Record<string, unknown>,
    entryId: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    const meetingId = meeting.meeting_id as string;
    let host: ZoomLogin | undefined;

    try {
      host = await this.hostLogin(meeting);

      await cancelZoomMeeting(meetingId, host?.token);

      this.audit.entry('zoom_meeting_cancel', organizationId, userId, entryId, {
        meeting_id: meetingId,
      });
    } catch (error) {
      this.logger.warn(
        `Zoom meeting for entry ${entryId} was not cancelled (${zoomCode(error) ?? 'no status'})`,
      );

      this.audit.entry('zoom_meeting_failed', organizationId, userId, entryId, {
        meeting_id: meetingId,
        stage: 'cancel',
        status: zoomCode(error),
      });

      // Zoom refusing the host's token means that login was withdrawn there.
      if (host && zoomCode(error) === 401) {
        await this.zoomTokens?.invalid(host.accountId, this.zoomReason(error));
      }
    }
  }

  /** The acting person's own Zoom login; there is no server fallback for a new meeting. */
  private personLogin(
    userId: string,
    organizationId: string,
  ): Promise<ZoomLogin> {
    if (!this.zoomTokens) {
      return Promise.reject(
        new Error('Zoom is not available on this server (503)'),
      );
    }

    return this.zoomTokens.forPerson(userId, organizationId);
  }

  /** The login that made this meeting; none for a meeting made by the server's own keys. */
  private async hostLogin(
    row: Record<string, unknown>,
  ): Promise<ZoomLogin | undefined> {
    const zoomUserId = row.meeting_zoom_user_id as string | null | undefined;

    if (!zoomUserId) return undefined;

    if (!this.zoomTokens) {
      throw new Error('Zoom is not available on this server (503)');
    }

    return this.zoomTokens.forHost(
      (row.meeting_host_user_id as string | null) ?? null,
      zoomUserId,
    );
  }

  /**
   * Keeps a meeting that already exists in step with its entry.
   *
   * Only a moved time or a renamed entry reaches Zoom, so an ordinary edit still costs nothing, and a
   * Zoom that refuses leaves the entry saved with the reason recorded against it.
   */
  private async syncZoomMeeting(
    before: Record<string, unknown>,
    written: Record<string, unknown>,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const meetingId = written.meeting_id as string | null;
    const startsAt = written.starts_at as string | null;

    const moved =
      before.starts_at !== written.starts_at ||
      before.ends_at !== written.ends_at ||
      before.timezone !== written.timezone ||
      before.summary !== written.summary;

    if (
      written.meeting_provider !== 'zoom' ||
      written.meeting_status !== 'created' ||
      !meetingId ||
      !startsAt ||
      !moved ||
      this.hasEnded(written)
    ) {
      return written;
    }

    let reason: string | null = null;
    let host: ZoomLogin | undefined;
    const org = written.organization_id as string;
    const entryId = written.id as string;

    try {
      // Moved through the login that made it, whoever is editing the entry now.
      host = await this.hostLogin(written);

      await updateZoomMeeting(
        meetingId,
        {
          topic: written.summary as string,
          startsAt,
          durationMinutes: meetingMinutes(
            startsAt,
            written.ends_at as string | null,
          ),
          timezone: (written.timezone as string) ?? 'UTC',
        },
        host?.token,
      );

      this.audit.entry('zoom_meeting_update', org, userId, entryId, {
        summary: written.summary as string,
        meeting_id: meetingId,

        // What Zoom was moved by: the same fields sent to it, old and new.
        values: CalendarAuditService.valueChanges(before, written, [
          'summary',
          'starts_at',
          'ends_at',
          'timezone',
        ]),
      });
    } catch (error) {
      this.audit.entry('zoom_meeting_failed', org, userId, entryId, {
        summary: written.summary as string,
        meeting_id: meetingId,
        stage: 'update',
        status: zoomCode(error),
      });

      // Deleted inside Zoom: the dead link goes, so the entry can be given a fresh meeting.
      if (zoomCode(error) === 404) return this.forgetGoneMeeting(written);

      // Zoom refusing the host's token means that login was withdrawn there.
      if (host && zoomCode(error) === 401) {
        await this.zoomTokens?.invalid(host.accountId, this.zoomReason(error));
      }

      reason = this.zoomReason(error);
    }

    // Nothing new to say, and writing an unchanged value would only churn the row.
    if (reason === ((written.meeting_error as string | null) ?? null)) {
      return written;
    }

    const result = await this.client
      .from(TABLE)
      .update({ meeting_error: reason })
      .eq('id', written.id as string)
      .eq('organization_id', written.organization_id as string)
      .is('deleted_at', null)
      .select()
      .maybeSingle();

    return !result.error && result.data
      ? (result.data as Record<string, unknown>)
      : { ...written, meeting_error: reason };
  }

  /** Why Zoom refused, in words short enough to store and show. */
  private zoomReason(error: unknown): string {
    const said =
      error instanceof Error ? error.message : 'Zoom could not be reached.';

    return said.slice(0, MAX_MEETING_ERROR);
  }

  /** What to store once Zoom has answered: a link, or the reason there is none. */
  private async zoomPatch(
    created: Record<string, unknown>,
    userId: string,
    zoomOptions?: ZoomMeetingOptions,
  ): Promise<Record<string, unknown>> {
    const startsAt = created.starts_at as string | null;

    if (!startsAt) {
      return {
        ...FAILED_MEETING,
        meeting_error: 'A Zoom meeting needs a start time.',
      };
    }

    const org = created.organization_id as string;
    const entryId = created.id as string;
    let login: ZoomLogin | undefined;

    try {
      // Hosted by the person asking for it, through their own Zoom login.
      login = await this.personLogin(userId, org);

      const meeting = await createZoomMeeting(
        {
          topic: created.summary as string,
          startsAt,
          durationMinutes: meetingMinutes(
            startsAt,
            created.ends_at as string | null,
          ),
          timezone: (created.timezone as string) ?? 'UTC',
        },
        login.token,
        zoomOptions,
      );

      // Every option the new meeting really has, read back from Zoom; the request is the fallback.
      const made = await getZoomMeeting(meeting.id, login.token)
        .then((read) => zoomOptionsFromMeeting(read).options)
        .catch(() => zoomOptions ?? {});

      this.audit.entry('zoom_meeting_create', org, userId, entryId, {
        summary: created.summary as string,
        meeting_id: meeting.id,
        values: CalendarAuditService.valueChanges(
          {},
          { ...made, meeting_url: meeting.joinUrl },
          ZOOM_SETTING_FIELDS,
        ),
      });

      const host = {
        meeting_id: meeting.id,
        meeting_host_user_id: userId,
        meeting_zoom_user_id: login.zoomUserId,
      };

      // A generated link is stored and then offered as a join button, so it faces the same check a
      // pasted one does rather than being trusted for coming from Zoom.
      if (meetingLinkProblem(meeting.joinUrl, 'zoom')) {
        await this.cancelQuietly(host, entryId, userId, org);

        return {
          ...FAILED_MEETING,
          meeting_error: `Zoom answered with a link that is not a Zoom meeting link (meeting ${meeting.id}).`,
        };
      }

      return {
        ...host,
        meeting_provider: 'zoom',
        meeting_url: meeting.joinUrl,
        meeting_status: 'created',
        meeting_error: null,
        ...recurrenceColumn(created, zoomOptions),
      };
    } catch (error) {
      // Zoom refusing this person's token means their login was withdrawn there.
      if (login && zoomCode(error) === 401) {
        await this.zoomTokens?.invalid(login.accountId, this.zoomReason(error));
      }

      this.audit.entry('zoom_meeting_failed', org, userId, entryId, {
        summary: created.summary as string,
        stage: 'create',
        status: zoomCode(error),
      });

      return { ...FAILED_MEETING, meeting_error: this.zoomReason(error) };
    }
  }

  /** Defaults to the month around today, and refuses a window nobody could be looking at. */
  private window(query: ListCalendarEventsDto): { from: Date; to: Date } {
    const now = Date.now();
    const from = query.from
      ? new Date(query.from)
      : new Date(now - 30 * DAY_MS);
    const to = query.to ? new Date(query.to) : new Date(now + 30 * DAY_MS);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from and to must be dates');
    }

    if (to.getTime() < from.getTime()) {
      throw new BadRequestException('to must not be before from');
    }

    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new BadRequestException(
        `Ask for at most ${MAX_RANGE_DAYS} days at a time`,
      );
    }

    return { from, to };
  }

  /** A meeting and its link travel together: half of either is a dead "Join" for whoever reads it. */
  private assertMeeting(
    provider?: string | null,
    url?: string | null,
    generating = false,
  ): void {
    const hasProvider = Boolean(provider);
    const hasUrl = Boolean(url);

    // A meeting being generated supplies its own link moments later.
    if (hasProvider && !hasUrl && !generating) {
      throw new BadRequestException('A meeting needs its link.');
    }

    if (hasUrl && !hasProvider) {
      throw new BadRequestException('A meeting link needs a meeting.');
    }
  }

  /** Only a link this request sets is checked, so an entry with an older link still saves. */
  private assertMeetingLink(
    url: string | null | undefined,
    provider: string | null,
  ): void {
    if (!url || url.trim() === '') return;

    const problem = meetingLinkProblem(url, provider);

    if (problem) throw new BadRequestException(problem);
  }

  private assertTimezone(timezone?: string): void {
    if (!timezone) return;

    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch {
      throw new BadRequestException(
        `timezone "${timezone}" is not a time zone`,
      );
    }
  }

  /**
   * Values may only use fields the calendar shows, and every required one must be filled.
   *
   * Keys already stored on the entry are tolerated, so unassigning a field later does not make every
   * existing entry unsaveable — the same rule the wiki uses.
   */
  private async assertCustomFields(
    calendar: CalendarRow,
    values: Record<string, unknown>,
    stored: Record<string, unknown>,
  ): Promise<void> {
    const settings = (calendar.field_settings ?? []) as FieldSetting[];
    const keys = Object.keys(values);

    if (settings.length === 0 && keys.length === 0) return;

    const { data, error } = await this.client
      .from('custom_fields')
      .select('id, field_key, is_active, is_deleted')
      .eq('organization_id', calendar.organization_id)
      .in(
        'id',
        settings.map((setting) => setting.field_id),
      );

    if (error) throw new BadRequestException(error.message);

    const fields = (data ?? []) as Array<{
      id: string;
      field_key: string;
      is_active: boolean | null;
      is_deleted: boolean | null;
    }>;
    const byId = new Map(fields.map((field) => [field.id, field]));
    const allowed = new Set(fields.map((field) => field.field_key));
    const known = new Set(Object.keys(stored));
    const unexpected = keys.filter(
      (key) => !allowed.has(key) && !known.has(key),
    );

    // A field the calendar does not list is still accepted when it is live in the calendar's scope.
    const inScope = await this.fieldKeysInScope(calendar, unexpected);
    const refused = unexpected.filter((key) => !inScope.has(key));

    if (refused.length > 0) {
      throw new BadRequestException(
        `These fields are not shown on this calendar: ${refused.join(', ')}`,
      );
    }

    for (const setting of settings) {
      const field = byId.get(setting.field_id);

      // A field that was deleted or switched off cannot hold an entry back.
      if (!setting.required || !field) continue;
      if (field.is_active === false || field.is_deleted) continue;

      const value = values[field.field_key] ?? stored[field.field_key];
      const empty =
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);

      if (empty) {
        throw new BadRequestException(`"${field.field_key}" is required`);
      }
    }
  }

  /**
   * Keys of custom fields an entry may hold without the calendar listing them: active, not deleted,
   * and org-level or in the calendar's space. An org-level calendar takes any space not archived.
   */
  private async fieldKeysInScope(
    calendar: CalendarRow,
    keys: string[],
  ): Promise<Set<string>> {
    if (keys.length === 0) return new Set();

    const { data, error } = await this.client
      .from('custom_fields')
      .select('field_key, space_id, is_active, is_deleted, deleted_at')
      .eq('organization_id', calendar.organization_id)
      .in('field_key', keys);

    if (error) throw new BadRequestException(error.message);

    const live = (
      (data ?? []) as Array<{
        field_key: string;
        space_id: string | null;
        is_active: boolean | null;
        is_deleted: boolean | null;
        deleted_at: string | null;
      }>
    ).filter(
      (field) =>
        field.is_active !== false && !field.is_deleted && !field.deleted_at,
    );

    let openSpaces = new Set<string>();
    const spaceIds = [
      ...new Set(
        live.map((field) => field.space_id).filter((id): id is string => !!id),
      ),
    ];

    if (!calendar.space_id && spaceIds.length > 0) {
      const { data: spaces, error: spaceError } = await this.client
        .from('spaces')
        .select('id')
        .eq('organization_id', calendar.organization_id)
        .in('id', spaceIds)
        .or('is_archived.is.null,is_archived.eq.false');

      if (spaceError) throw new BadRequestException(spaceError.message);

      openSpaces = new Set(
        ((spaces ?? []) as Array<{ id: string }>).map((space) => space.id),
      );
    }

    return new Set(
      live
        .filter(
          (field) =>
            !field.space_id ||
            (calendar.space_id
              ? field.space_id === calendar.space_id
              : openSpaces.has(field.space_id)),
        )
        .map((field) => field.field_key),
    );
  }

  /** Someone can only follow an entry they are allowed to see. */
  private async assertWatchers(
    calendar: CalendarRow,
    watcherIds: string[],
  ): Promise<void> {
    if (watcherIds.length === 0) return;

    const unique = [...new Set(watcherIds)];
    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', calendar.organization_id)
      .in('user_id', unique);

    if (error) throw new BadRequestException(error.message);

    const members = new Set(
      ((data ?? []) as Array<{ user_id: string }>).map(
        (member) => member.user_id,
      ),
    );
    const outsiders = unique.filter((id) => !members.has(id));

    if (outsiders.length > 0) {
      throw new BadRequestException(
        `These people are not in this organization: ${outsiders.join(', ')}`,
      );
    }

    if (!calendar.space_id) return;

    const { data: spaceMembers } = await this.client
      .from('space_members')
      .select('user_id')
      .eq('space_id', calendar.space_id)
      .in('user_id', unique);

    const inSpace = new Set(
      ((spaceMembers ?? []) as Array<{ user_id: string }>).map(
        (member) => member.user_id,
      ),
    );
    const cannotSee = unique.filter((id) => !inSpace.has(id));

    if (cannotSee.length > 0) {
      throw new BadRequestException(
        `These people cannot see this calendar: ${cannotSee.join(', ')}`,
      );
    }
  }

  /**
   * Tells each person newly linked to an entry, within this organization, that they were linked.
   * Fire-and-forget: a notification that fails never fails the save.
   */
  private notifyLinkedUsers(
    entry: Record<string, unknown>,
    calendar: CalendarWithAccess,
    before: CalendarEventLinkDto[],
    userId: string,
    organizationId: string,
  ): void {
    const had = new Set(
      before.filter((link) => link.type === 'user').map((link) => link.id),
    );
    const now = ((entry.links as CalendarEventLinkDto[] | null) ?? [])
      .filter((link) => link.type === 'user')
      .map((link) => link.id);

    this.notifyNewPeople(
      entry,
      calendar,
      now,
      had,
      'link',
      userId,
      organizationId,
    );
  }

  /**
   * Tells each person newly added as a follower, within this organization, that they now follow it.
   * Fire-and-forget: a notification that fails never fails the save.
   */
  private notifyFollowers(
    entry: Record<string, unknown>,
    calendar: CalendarWithAccess,
    before: string[],
    userId: string,
    organizationId: string,
  ): void {
    this.notifyNewPeople(
      entry,
      calendar,
      (entry.watcher_ids as string[] | null) ?? [],
      new Set(before),
      'follow',
      userId,
      organizationId,
    );
  }

  /** The shared half: who is new, who is in this organization, then one notification each. */
  private notifyNewPeople(
    entry: Record<string, unknown>,
    calendar: CalendarWithAccess,
    now: string[],
    had: Set<string>,
    kind: 'link' | 'follow',
    userId: string,
    organizationId: string,
  ): void {
    void (async () => {
      try {
        const added = [
          ...new Set(
            now.filter((id) => Boolean(id) && !had.has(id) && id !== userId),
          ),
        ];

        if (added.length === 0) return;

        // Everyone added is told, even without access to the calendar; only members of this
        // organization, so it can never reach someone in another tenant.
        const { data: members, error: membersError } = await this.client
          .from('organization_members')
          .select('user_id')
          .eq('organization_id', organizationId)
          .in('user_id', added);

        if (membersError) throw new Error(membersError.message);

        const inOrganization = new Set(
          ((members ?? []) as Array<{ user_id: string }>).map(
            (member) => member.user_id,
          ),
        );
        const recipients = added.filter((id) => inOrganization.has(id));

        if (recipients.length === 0) return;

        const { data: actor } = await this.client
          .from('users')
          .select('first_name, last_name, email')
          .eq('id', userId)
          .maybeSingle();
        const person = actor as {
          first_name?: string | null;
          last_name?: string | null;
          email?: string | null;
        } | null;
        const actorName =
          [person?.first_name, person?.last_name].filter(Boolean).join(' ') ||
          person?.email ||
          'Someone';
        const entryId = entry.id as string;
        const summary = (entry.summary as string) || 'Untitled entry';

        const { data: inserted, error } = await this.client
          .from('notifications')
          .insert(
            recipients.map((recipientId) => ({
              organization_id: organizationId,
              user_id: recipientId,
              type: kind === 'link' ? 'calendar_link' : 'calendar_follow',
              title:
                kind === 'link'
                  ? `${actorName} linked you to an event`
                  : `${actorName} added you as a follower of an event`,
              body: CalendarEventsService.linkBody(
                entry,
                ((calendar as unknown as { name?: string }).name ?? '') ||
                  'Calendar',
              ),
              is_read: false,
              reference_type: 'calendar_event',
              reference_id: entryId,
              metadata: {
                link: `/calendar?entry=${entryId}`,
                entry_id: entryId,
                entity_name: summary,
                calendar_id: calendar.id,
                ...(kind === 'link'
                  ? { linked_by_user_id: userId, linked_by_name: actorName }
                  : { added_by_user_id: userId, added_by_name: actorName }),
              },
            })),
          )
          .select();

        if (error) throw new Error(error.message);

        for (const notification of (inserted ?? []) as Record<
          string,
          unknown
        >[]) {
          void this.notificationsBroadcast?.broadcastNotification(notification);
        }
      } catch (failure) {
        console.error(
          `[CalendarEventsService.notify ${kind}] failed:`,
          failure instanceof Error ? failure.message : failure,
        );
      }
    })();
  }

  /** Title, when, and where, one per line, in the entry's own time zone. */
  static linkBody(
    entry: Record<string, unknown>,
    calendarName: string,
  ): string {
    const zone = (entry.timezone as string | null) || 'UTC';
    let when = '';

    // An entry whose times cannot be read still gets its title and calendar.
    if (
      entry.is_all_day
        ? !entry.start_date
        : Number.isNaN(Date.parse(entry.starts_at as string))
    ) {
      when = '';
    } else if (entry.is_all_day) {
      const first = entry.start_date as string;

      // The stored end is the day after the last one.
      const last = entry.end_date
        ? new Date(
            Date.parse(`${entry.end_date as string}T00:00:00Z`) - 86_400_000,
          )
            .toISOString()
            .slice(0, 10)
        : first;
      const day = (value: string) =>
        CalendarEventsService.dayLabel(new Date(`${value}T00:00:00Z`), 'UTC');

      when = `${last && last !== first ? `${day(first)} – ${day(last)}` : day(first)} · All day`;
    } else {
      const start = new Date(entry.starts_at as string);
      const parsedEnd = entry.ends_at
        ? new Date(entry.ends_at as string)
        : null;
      const end =
        parsedEnd && !Number.isNaN(parsedEnd.getTime()) ? parsedEnd : null;
      const startDay = CalendarEventsService.dayLabel(start, zone);
      const startTime = CalendarEventsService.clockLabel(start, zone);

      if (!end) {
        when = `${startDay} · ${startTime}`;
      } else {
        const endDay = CalendarEventsService.dayLabel(end, zone);
        const endTime = CalendarEventsService.clockLabel(end, zone);

        when =
          endDay === startDay
            ? `${startDay} · ${startTime} – ${endTime}`
            : `${startDay}, ${startTime} – ${endDay}, ${endTime}`;
      }

      when += ` (${zone})`;
    }

    const where = [`Calendar: ${calendarName}`, entry.location]
      .filter(Boolean)
      .join(' · ');

    return [(entry.summary as string) || 'Untitled entry', when, where]
      .filter(Boolean)
      .join('\n');
  }

  /** "Fri, 3 Oct 2026" in the given zone, falling back to UTC for an unknown one. */
  private static dayLabel(value: Date, zone: string): string {
    const parts = CalendarEventsService.parts(value, zone, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

    return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}`;
  }

  /** "10:00" in the given zone, 24-hour. */
  private static clockLabel(value: Date, zone: string): string {
    const parts = CalendarEventsService.parts(value, zone, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });

    return `${parts.hour}:${parts.minute}`;
  }

  private static parts(
    value: Date,
    zone: string,
    options: Intl.DateTimeFormatOptions,
  ): Record<string, string> {
    let format: Intl.DateTimeFormat;

    try {
      format = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: zone });
    } catch {
      format = new Intl.DateTimeFormat('en-GB', {
        ...options,
        timeZone: 'UTC',
      });
    }

    return Object.fromEntries(
      format.formatToParts(value).map((part) => [part.type, part.value]),
    );
  }

  private assertLinks(links: CalendarEventLinkDto[]): void {
    const seen = new Set<string>();

    for (const link of links) {
      const key = `${link.type}:${link.id}`;

      if (seen.has(key)) {
        throw new BadRequestException(`"${key}" is linked twice`);
      }

      seen.add(key);
    }
  }

  /** Turns the database's time-shape rejection into something a person can act on. */
  private friendlyWriteError(message: string): BadRequestException {
    if (message.includes('calendar_events_time_shape_check')) {
      return new BadRequestException(
        'An entry is either all-day (start_date and end_date, end after start) or timed ' +
          '(starts_at and ends_at, end not before start), never both, and at most a year long.',
      );
    }

    return new BadRequestException(message);
  }

  private async write(
    id: string,
    organizationId: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.client
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .select()
      .single();

    if (result.error) throw new BadRequestException(result.error.message);

    return result.data as Record<string, unknown>;
  }
}
