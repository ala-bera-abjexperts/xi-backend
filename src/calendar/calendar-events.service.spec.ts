/**
 * @fileoverview The calendar entries API.
 *
 * A calendar holds three different things and each is granted on its own: entries this person wrote,
 * entries somebody else wrote, and copies pulled in from a connected calendar. These tests are mostly
 * about that distinction — which flag a route asks for, and what the list is allowed to hand back.
 */
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { CalendarRow } from './calendar-access.service';
import { CalendarAccessService } from './calendar-access.service';
import { CalendarEventsService } from './calendar-events.service';
import type { CalendarWithAccess } from './calendars.service';
import { CalendarsService } from './calendars.service';
import type { CalendarPermissions } from './calendar-permissions.model';
import { allPermissions, noPermissions } from './calendar-permissions.model';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { CalendarAuditService } from './calendar-audit.service';
import { CalendarSyncService } from './integrations/calendar-sync.service';

describe('CalendarEventsService', () => {
  let service: CalendarEventsService;
  let mockFrom: jest.Mock;
  let queued: Map<string, Record<string, unknown>[]>;
  let getCalendar: jest.Mock;
  let listVisible: jest.Mock;

  const ORG = 'org-1';
  const USER = 'user-1';
  const OTHER_USER = 'user-2';
  const CAL = 'cal-1';
  const EVENT = 'event-1';

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
    chain.gte = jest.fn().mockImplementation(self);
    chain.lte = jest.fn().mockImplementation(self);
    chain.lt = jest.fn().mockImplementation(self);
    chain.gt = jest.fn().mockImplementation(self);
    chain.neq = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);

    return chain;
  }

  function queue(table: string, resolved: { data: unknown; error: unknown }) {
    const chain = buildChain(resolved);
    const list = queued.get(table) ?? [];

    list.push(chain);
    queued.set(table, list);

    return chain;
  }

  function calendarRow(overrides: Record<string, unknown> = {}): CalendarRow {
    return {
      id: CAL,
      organization_id: ORG,
      space_id: null,
      owner_id: USER,
      visibility: 'private',
      default_timezone: 'UTC',
      shares: [],
      feeds: [],
      field_settings: [],
      ...overrides,
    } as CalendarRow;
  }

  /** The calendar the service reads, with whichever flags a case wants to withhold. */
  function useCalendar(
    permissions: Partial<CalendarPermissions> = {},
    overrides: Record<string, unknown> = {},
  ) {
    const resolved: CalendarPermissions = {
      ...allPermissions(),
      ...permissions,
    };

    getCalendar.mockResolvedValue({
      ...calendarRow(overrides),
      access: 'manage',
      rights: {
        create_entries: true,
        edit_entries: true,
        delete_entries: true,
        manage: true,
      },
      permissions: resolved,
    } as CalendarWithAccess);

    return resolved;
  }

  function event(overrides: Record<string, unknown> = {}) {
    return {
      id: EVENT,
      organization_id: ORG,
      calendar_id: CAL,
      summary: 'Stand-up',
      created_by: USER,
      external_id: null,
      sync_read_only: false,
      custom_field_values: {},
      watcher_ids: [],
      links: [],
      deleted_at: null,
      updated_at: '2026-09-25T10:00:00.000Z',
      ...overrides,
    };
  }

  /** A visible calendar for the list endpoint, with the flags a case cares about. */
  function visible(permissions: Partial<CalendarPermissions> = {}) {
    return {
      ...calendarRow(),
      access: 'manage',
      rights: {
        create_entries: true,
        edit_entries: true,
        delete_entries: true,
        manage: true,
      },
      permissions: { ...allPermissions(), ...permissions },
    } as CalendarWithAccess;
  }

  beforeEach(() => {
    queued = new Map();
    mockFrom = jest.fn((table: string) => {
      const list = queued.get(table);

      if (!list || list.length === 0) {
        throw new Error(`unexpected from('${table}')`);
      }

      return list.shift();
    });

    getCalendar = jest.fn();
    listVisible = jest.fn();

    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    const calendars = {
      getForUser: getCalendar,
      listVisible,
    } as unknown as CalendarsService;

    const access = {
      canReadSpaceTickets: jest.fn().mockResolvedValue(true),

      // Every space these cases link is an open space with Tasks on
      linkableSpaces: jest.fn().mockResolvedValue([
        { id: 'space-1', key: 'NEW', name: 'New' },
        { id: 'space-2', key: 'TWO', name: 'Two' },
      ]),

      // The real rule, so a withheld flag really does stop the route under test.
      assertAllowed: (allowed: boolean, what: string) => {
        if (!allowed) throw new ForbiddenException(what);
      },
    } as unknown as CalendarAccessService;

    // Audit writes are fire-and-forget; these tests are about the entries, not the log.
    const audit = {
      sharesChanged: jest.fn(),
      calendar: jest.fn(),
      entry: jest.fn(),
      integration: jest.fn(),
    } as unknown as CalendarAuditService;

    // Sending out to a provider is the sync service's job; here it only has to be callable.
    const sync = { pushSoon: jest.fn() } as unknown as CalendarSyncService;

    service = new CalendarEventsService(supa, calendars, access, audit, sync);
  });

  describe('listing — what a reader is allowed to see', () => {
    function withEvents(
      rows: Record<string, unknown>[],
      calendar: CalendarWithAccess,
    ) {
      listVisible.mockResolvedValue([calendar]);
      queue('calendar_events', { data: rows, error: null });
    }

    const range = {
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T00:00:00.000Z',
    };

    it('keeps everything when every read flag is granted', async () => {
      withEvents(
        [
          event({ id: 'mine' }),
          event({ id: 'theirs', created_by: OTHER_USER }),
        ],
        visible(),
      );

      const result = await service.list(range as never, USER, ORG);

      expect(result.map((row) => row.id)).toEqual(['mine', 'theirs']);
    });

    it('hides entries somebody else wrote when that flag is missing', async () => {
      const events = allPermissions().events;

      events.others_read = false;

      withEvents(
        [
          event({ id: 'mine' }),
          event({ id: 'theirs', created_by: OTHER_USER }),
        ],
        visible({ events }),
      );

      const result = await service.list(range as never, USER, ORG);

      expect(result.map((row) => row.id)).toEqual(['mine']);
    });

    it('hides this person own entries when only others are granted', async () => {
      const events = allPermissions().events;

      events.own_read = false;

      withEvents(
        [
          event({ id: 'mine' }),
          event({ id: 'theirs', created_by: OTHER_USER }),
        ],
        visible({ events }),
      );

      const result = await service.list(range as never, USER, ORG);

      expect(result.map((row) => row.id)).toEqual(['theirs']);
    });

    it('hides copies brought in from a connected calendar when sync reading is missing', async () => {
      const sync = allPermissions().sync;

      sync.read = false;

      withEvents(
        [
          event({ id: 'local' }),
          event({ id: 'imported', external_id: 'g-1', created_by: null }),
        ],
        visible({ sync }),
      );

      const result = await service.list(range as never, USER, ORG);

      expect(result.map((row) => row.id)).toEqual(['local']);
    });

    it('treats an entry the provider marked read-only as a synced one', async () => {
      const sync = allPermissions().sync;

      sync.read = false;

      withEvents(
        [event({ id: 'imported', sync_read_only: true, created_by: null })],
        visible({ sync }),
      );

      await expect(service.list(range as never, USER, ORG)).resolves.toEqual(
        [],
      );
    });

    it('marks an entry read-only when it may be seen but not changed', async () => {
      const events = allPermissions().events;

      events.own_update = false;

      withEvents([event({ id: 'mine' })], visible({ events }));

      const [row] = await service.list(range as never, USER, ORG);

      expect(row.read_only).toBe(true);
    });

    it('leaves an entry editable when it may be changed', async () => {
      withEvents([event({ id: 'mine' })], visible());

      const [row] = await service.list(range as never, USER, ORG);

      expect(row.read_only).toBeUndefined();
    });

    it('returns nothing, and asks for nothing, when no calendar is visible', async () => {
      listVisible.mockResolvedValue([]);

      await expect(service.list(range as never, USER, ORG)).resolves.toEqual(
        [],
      );
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  describe('reading one entry', () => {
    it('refuses by saying not found, so a hidden entry is not reachable by its id', async () => {
      const events = allPermissions().events;

      events.others_read = false;

      queue('calendar_events', {
        data: event({ created_by: OTHER_USER }),
        error: null,
      });
      useCalendar({ events });

      await expect(service.getForUser(EVENT, USER, ORG)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('says not found when the entry does not exist', async () => {
      queue('calendar_events', { data: null, error: null });

      await expect(service.getForUser(EVENT, USER, ORG)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('marks it read-only when it may be read but not changed', async () => {
      const events = allPermissions().events;

      events.own_update = false;

      queue('calendar_events', { data: event(), error: null });
      useCalendar({ events });

      const row = await service.getForUser(EVENT, USER, ORG);

      expect(row.read_only).toBe(true);
    });
  });

  describe('creating an entry', () => {
    it('needs the create flag', async () => {
      const events = noPermissions().events;

      useCalendar({ events });

      await expect(
        service.create({ calendar_id: CAL, summary: 'A' } as never, USER, ORG),
      ).rejects.toThrow(ForbiddenException);
    });

    it('needs only "Add entries" on a calendar that mirrors an outside one, not the sync create flag', async () => {
      const sync = allPermissions().sync;

      sync.create = false;

      useCalendar({ sync }, { sync_account_id: 'acc-1' });

      const chain = queue('calendar_events', { data: event(), error: null });

      await service.create(
        { calendar_id: CAL, summary: 'A' } as never,
        USER,
        ORG,
      );

      expect(chain.insert).toHaveBeenCalled();
    });

    it('writes the entry into the calendar it was checked against', async () => {
      useCalendar();

      const chain = queue('calendar_events', { data: event(), error: null });

      await service.create(
        { calendar_id: 'whatever-the-client-said', summary: 'A' } as never,
        USER,
        ORG,
      );

      const row = (chain.insert as jest.Mock).mock.calls[0][0];

      expect(row.calendar_id).toBe(CAL);
      expect(row.organization_id).toBe(ORG);
    });
  });

  describe('changing an entry', () => {
    it('asks for the own-entries flag for something this person wrote', async () => {
      const events = allPermissions().events;

      events.own_update = false;

      queue('calendar_events', { data: event(), error: null });
      useCalendar({ events });

      await expect(
        service.update(EVENT, { summary: 'B' } as never, USER, ORG),
      ).rejects.toThrow(/your own entries/);
    });

    it('asks for the others flag for something somebody else wrote', async () => {
      const events = allPermissions().events;

      events.others_update = false;

      queue('calendar_events', {
        data: event({ created_by: OTHER_USER }),
        error: null,
      });
      useCalendar({ events });

      await expect(
        service.update(EVENT, { summary: 'B' } as never, USER, ORG),
      ).rejects.toThrow(/somebody else/);
    });

    it('follows the entries flags, not the sync ones, for a copy brought in from a connected calendar', async () => {
      const sync = allPermissions().sync;

      sync.update = false;

      queue('calendar_events', {
        data: event({ external_id: 'g-1' }),
        error: null,
      });
      useCalendar({ sync });

      const chain = queue('calendar_events', { data: event(), error: null });

      await service.update(EVENT, { summary: 'B' } as never, USER, ORG);

      expect(chain.update).toHaveBeenCalledWith(
        expect.objectContaining({ summary: 'B' }),
      );
    });

    it('lets an allowed change through and records who made it', async () => {
      queue('calendar_events', { data: event(), error: null });
      useCalendar();

      const chain = queue('calendar_events', { data: event(), error: null });

      await service.update(EVENT, { summary: 'B' } as never, USER, ORG);

      const patch = (chain.update as jest.Mock).mock.calls[0][0];

      expect(patch.summary).toBe('B');
      expect(patch.updated_by).toBe(USER);
    });
  });

  describe('deleting an entry', () => {
    it('is granted separately from changing one', async () => {
      const events = allPermissions().events;

      events.own_delete = false;

      queue('calendar_events', { data: event(), error: null });
      useCalendar({ events });

      await expect(service.remove(EVENT, USER, ORG)).rejects.toThrow(
        /delete your own entries/,
      );
    });

    it('is a soft delete, so the removal can still reach an outside calendar', async () => {
      queue('calendar_events', { data: event(), error: null });
      useCalendar();

      const chain = queue('calendar_events', { data: null, error: null });

      await service.remove(EVENT, USER, ORG);

      expect((chain.update as jest.Mock).mock.calls[0][0].deleted_at).toEqual(
        expect.any(String),
      );
    });
  });

  describe('ticket dates shown on a calendar', () => {
    const WINDOW = { from: '2026-09-01', to: '2026-09-30' };

    /** A calendar carrying ticket sources, with the flags a case wants to withhold. */
    function withFeeds(
      feeds: Array<Record<string, unknown>>,
      permissions: Partial<CalendarPermissions> = {},
    ) {
      listVisible.mockResolvedValue([
        { ...visible(permissions), feeds, default_timezone: 'UTC' },
      ]);
      queue('calendar_events', { data: [], error: null });
    }

    const task = (overrides: Record<string, unknown> = {}) => ({
      id: 'task-1',
      key: 'NEW-1',
      summary: 'Ship it',
      status: 'open',
      priority: 'high',
      space_id: 'space-1',
      due_date: '2026-09-15T09:00:00.000Z',
      start_date: null,
      end_date: null,
      ...overrides,
    });

    it('contributes nothing when the calendar has no sources', async () => {
      withFeeds([]);

      await expect(service.list(WINDOW as never, USER, ORG)).resolves.toEqual(
        [],
      );
    });

    it('ignores a source with no space or no date field', async () => {
      withFeeds([{ id: 'f-1' }, { id: 'f-2', space_id: 'space-1' }]);

      await expect(service.list(WINDOW as never, USER, ORG)).resolves.toEqual(
        [],
      );
    });

    it('shows a ticket as a whole-day entry that cannot be edited', async () => {
      withFeeds([{ id: 'f-1', space_id: 'space-1', date_field: 'due_date' }]);
      queue('spaces', { data: [{ id: 'space-1', key: 'NEW' }], error: null });
      queue('tasks', { data: [task()], error: null });

      const [item] = await service.list(WINDOW as never, USER, ORG);

      expect(item.read_only).toBe(true);
      expect(item.is_all_day).toBe(true);
      expect(item.source).toBe('feed');
      expect(item.summary).toBe('NEW-1 Ship it');
      expect((item.ticket as Record<string, unknown>).key).toBe('NEW-1');
    });

    it('leaves out a ticket excluded from a whole-space source', async () => {
      withFeeds([
        {
          id: 'f-1',
          space_id: 'space-1',
          date_field: 'due_date',
          excluded_task_ids: ['task-1'],
        },
      ]);
      queue('spaces', { data: [{ id: 'space-1', key: 'NEW' }], error: null });
      queue('tasks', {
        data: [task(), task({ id: 'task-2', key: 'NEW-2' })],
        error: null,
      });

      const items = await service.list(WINDOW as never, USER, ORG);

      expect(items.map((item) => (item.ticket as { key: string }).key)).toEqual(
        ['NEW-2'],
      );
    });

    it('links the item back to the ticket it came from', async () => {
      withFeeds([{ id: 'f-1', space_id: 'space-1', date_field: 'due_date' }]);
      queue('spaces', { data: [{ id: 'space-1', key: 'NEW' }], error: null });
      queue('tasks', { data: [task()], error: null });

      const [item] = await service.list(WINDOW as never, USER, ORG);

      expect(item.links).toEqual([{ type: 'task', id: 'task-1' }]);
    });

    it('shows nothing from a space that can no longer be linked', async () => {
      // An archived space, or one with Tasks off, puts nothing on a calendar.
      const access = (
        service as unknown as { access: { linkableSpaces: jest.Mock } }
      ).access;

      access.linkableSpaces.mockResolvedValue([]);
      withFeeds([{ id: 'f-1', space_id: 'space-1', date_field: 'due_date' }]);

      await expect(service.list(WINDOW as never, USER, ORG)).resolves.toEqual(
        [],
      );
    });

    it('asks about each space once, however many sources point at it', async () => {
      const access = (
        service as unknown as { access: { linkableSpaces: jest.Mock } }
      ).access;

      withFeeds([
        { id: 'f-1', space_id: 'space-1', date_field: 'due_date' },
        { id: 'f-2', space_id: 'space-1', date_field: 'start_date' },
      ]);
      queue('spaces', { data: [{ id: 'space-1', key: 'NEW' }], error: null });
      queue('tasks', { data: [], error: null });
      queue('tasks', { data: [], error: null });

      await service.list(WINDOW as never, USER, ORG);

      expect(access.linkableSpaces).toHaveBeenCalledTimes(1);
    });

    it('places a ticket on a calendar once, however many sources match it', async () => {
      withFeeds([
        { id: 'f-1', space_id: 'space-1', date_field: 'due_date' },
        { id: 'f-2', space_id: 'space-1', date_field: 'due_date' },
      ]);
      queue('spaces', { data: [{ id: 'space-1', key: 'NEW' }], error: null });
      queue('tasks', { data: [task()], error: null });

      const items = await service.list(WINDOW as never, USER, ORG);

      expect(items).toHaveLength(1);
    });

    it('skips a ticket whose date on that field is empty', async () => {
      withFeeds([{ id: 'f-1', space_id: 'space-1', date_field: 'start_date' }]);
      queue('spaces', { data: [{ id: 'space-1', key: 'NEW' }], error: null });
      queue('tasks', { data: [task({ start_date: null })], error: null });

      await expect(service.list(WINDOW as never, USER, ORG)).resolves.toEqual(
        [],
      );
    });

    it('narrows to one ticket when the source names one', async () => {
      withFeeds([
        {
          id: 'f-1',
          space_id: 'space-1',
          date_field: 'due_date',
          task_id: 'task-1',
        },
      ]);
      queue('spaces', { data: [{ id: 'space-1', key: 'NEW' }], error: null });

      const tasks = queue('tasks', { data: [task()], error: null });

      await service.list(WINDOW as never, USER, ORG);

      expect(tasks.eq).toHaveBeenCalledWith('id', 'task-1');
    });

    it('keeps a pinned source apart from a whole-space one on the same field', async () => {
      // Sharing a query would let the pinned source pick up the rest of the space.
      withFeeds([
        { id: 'f-1', space_id: 'space-1', date_field: 'due_date' },
        {
          id: 'f-2',
          space_id: 'space-1',
          date_field: 'due_date',
          task_id: 'task-9',
        },
      ]);
      queue('spaces', { data: [{ id: 'space-1', key: 'NEW' }], error: null });
      queue('tasks', { data: [], error: null });
      queue('tasks', { data: [], error: null });

      await service.list(WINDOW as never, USER, ORG);

      expect(mockFrom).toHaveBeenCalledWith('tasks');
    });

    it('is left out entirely when ticket dates may not be read', async () => {
      const task_events = allPermissions().task_events;

      task_events.read = false;

      withFeeds([{ id: 'f-1', space_id: 'space-1', date_field: 'due_date' }], {
        task_events,
      });

      await expect(service.list(WINDOW as never, USER, ORG)).resolves.toEqual(
        [],
      );
    });

    it('turns a ticket query failure into a bad request', async () => {
      withFeeds([{ id: 'f-1', space_id: 'space-1', date_field: 'due_date' }]);
      queue('spaces', { data: [{ id: 'space-1', key: 'NEW' }], error: null });
      queue('tasks', { data: null, error: { message: 'tasks gone' } });

      await expect(service.list(WINDOW as never, USER, ORG)).rejects.toThrow(
        /tasks gone/,
      );
    });
  });

  describe('the date window a list may ask for', () => {
    const list = (query: Record<string, unknown>) => {
      listVisible.mockResolvedValue([visible()]);

      return service.list(query as never, USER, ORG);
    };

    it('refuses a window that is not made of dates', async () => {
      await expect(list({ from: 'not-a-date', to: 'x' })).rejects.toThrow(
        /must be dates/,
      );
    });

    it('refuses a window that runs backwards', async () => {
      await expect(
        list({ from: '2026-09-30', to: '2026-09-01' }),
      ).rejects.toThrow(/not be before/);
    });

    it('refuses a window nobody could be looking at', async () => {
      // Without a cap one request could ask for every entry the organization has ever had.
      await expect(
        list({ from: '2020-01-01', to: '2026-01-01' }),
      ).rejects.toThrow(/at most/);
    });

    it('defaults to a month either side of today when none is given', async () => {
      queue('calendar_events', { data: [], error: null });

      await expect(list({})).resolves.toEqual([]);
    });
  });

  describe('a meeting and its link', () => {
    it('refuses a meeting with no link', async () => {
      useCalendar();

      await expect(
        service.create(
          { calendar_id: CAL, summary: 'A', meeting_provider: 'zoom' } as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(/needs its link/);
    });

    it('refuses a link with no meeting', async () => {
      useCalendar();

      await expect(
        service.create(
          {
            calendar_id: CAL,
            summary: 'A',
            meeting_url: 'https://z.test/1',
          } as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(/needs a meeting/);
    });

    it('accepts the pair', async () => {
      useCalendar();
      queue('calendar_events', { data: event(), error: null });

      await expect(
        service.create(
          {
            calendar_id: CAL,
            summary: 'A',
            meeting_provider: 'zoom',
            meeting_url: 'https://zoom.us/j/123456789',
          } as never,
          USER,
          ORG,
        ),
      ).resolves.toBeDefined();
    });

    it('judges an edit on what the entry becomes, not on what the request carries', async () => {
      // Sending only the provider, on an entry that already has a link, must stay valid.
      queue('calendar_events', {
        data: event({
          meeting_url: 'https://z.test/1',
          meeting_provider: null,
        }),
        error: null,
      });
      useCalendar();
      queue('calendar_events', { data: event(), error: null });

      await expect(
        service.update(EVENT, { meeting_provider: 'zoom' } as never, USER, ORG),
      ).resolves.toBeDefined();
    });
  });

  describe('the time zone an entry is kept in', () => {
    it('refuses one that does not exist', async () => {
      useCalendar();

      await expect(
        service.create(
          { calendar_id: CAL, summary: 'A', timezone: 'Mars/Olympus' } as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(/is not a time zone/);
    });

    it('keeps the one the payload names', async () => {
      useCalendar();

      const chain = queue('calendar_events', { data: event(), error: null });

      await service.create(
        { calendar_id: CAL, summary: 'A', timezone: 'Europe/Berlin' } as never,
        USER,
        ORG,
      );

      expect((chain.insert as jest.Mock).mock.calls[0][0].timezone).toBe(
        'Europe/Berlin',
      );
    });

    it('falls back to the calendar own when the payload names none', async () => {
      useCalendar({}, { default_timezone: 'Asia/Kolkata' });

      const chain = queue('calendar_events', { data: event(), error: null });

      await service.create(
        { calendar_id: CAL, summary: 'A' } as never,
        USER,
        ORG,
      );

      expect((chain.insert as jest.Mock).mock.calls[0][0].timezone).toBe(
        'Asia/Kolkata',
      );
    });
  });

  describe('what an entry is linked to', () => {
    it('refuses the same link twice', async () => {
      useCalendar();

      await expect(
        service.create(
          {
            calendar_id: CAL,
            summary: 'A',
            links: [
              { type: 'task', id: 't-1' },
              { type: 'task', id: 't-1' },
            ],
          } as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(/linked twice/);
    });

    it('allows the same id under two different kinds of link', async () => {
      useCalendar();
      queue('calendar_events', { data: event(), error: null });

      await expect(
        service.create(
          {
            calendar_id: CAL,
            summary: 'A',
            links: [
              { type: 'task', id: 'same' },
              { type: 'process', id: 'same' },
            ],
          } as never,
          USER,
          ORG,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('who may be set as a watcher', () => {
    const create = (watcher_ids: string[]) =>
      service.create(
        { calendar_id: CAL, summary: 'A', watcher_ids } as never,
        USER,
        ORG,
      );

    it('asks nothing when there are none', async () => {
      useCalendar();
      queue('calendar_events', { data: event(), error: null });

      await expect(create([])).resolves.toBeDefined();
    });

    it('refuses somebody outside the organization, naming them', async () => {
      useCalendar();
      queue('organization_members', { data: [], error: null });

      await expect(create(['stranger'])).rejects.toThrow(
        /not in this organization/,
      );
    });

    it('accepts an organization member on a personal calendar', async () => {
      useCalendar();
      queue('organization_members', {
        data: [{ user_id: 'w-1' }],
        error: null,
      });
      queue('calendar_events', { data: event(), error: null });

      await expect(create(['w-1'])).resolves.toBeDefined();
    });

    it('also requires space membership on a space calendar', async () => {
      // A watcher who cannot open the calendar would be told about something they cannot see.
      useCalendar({}, { space_id: 'space-1' });
      queue('organization_members', {
        data: [{ user_id: 'w-1' }],
        error: null,
      });
      queue('space_members', { data: [], error: null });

      await expect(create(['w-1'])).rejects.toThrow(/cannot see this calendar/);
    });

    it('accepts a space member on a space calendar', async () => {
      useCalendar({}, { space_id: 'space-1' });
      queue('organization_members', {
        data: [{ user_id: 'w-1' }],
        error: null,
      });
      queue('space_members', { data: [{ user_id: 'w-1' }], error: null });
      queue('calendar_events', { data: event(), error: null });

      await expect(create(['w-1'])).resolves.toBeDefined();
    });

    it('asks about each person once even when named twice', async () => {
      useCalendar();

      const members = queue('organization_members', {
        data: [{ user_id: 'w-1' }],
        error: null,
      });

      queue('calendar_events', { data: event(), error: null });

      await create(['w-1', 'w-1']);

      expect(members.in).toHaveBeenCalledWith('user_id', ['w-1']);
    });

    it('fails closed when the membership lookup errors', async () => {
      useCalendar();
      queue('organization_members', { data: null, error: { message: 'down' } });

      await expect(create(['w-1'])).rejects.toThrow(/down/);
    });
  });

  describe('the custom fields a calendar shows', () => {
    const field = (overrides: Record<string, unknown> = {}) => ({
      id: 'field-1',
      field_key: 'client',
      is_active: true,
      is_deleted: false,
      ...overrides,
    });

    const create = (custom_field_values: Record<string, unknown>) =>
      service.create(
        { calendar_id: CAL, summary: 'A', custom_field_values } as never,
        USER,
        ORG,
      );

    it('asks nothing when the calendar shows none and none are sent', async () => {
      useCalendar();
      queue('calendar_events', { data: event(), error: null });

      await expect(create({})).resolves.toBeDefined();
    });

    it('refuses a value for a field the calendar does not show', async () => {
      useCalendar({}, { field_settings: [] });
      queue('custom_fields', { data: [], error: null });

      // The second look, for a live field in the calendar's scope, finds nothing either.
      queue('custom_fields', { data: [], error: null });

      await expect(create({ nope: 'x' })).rejects.toThrow(
        /not shown on this calendar/,
      );
    });

    it('accepts a live org-level field the calendar does not list', async () => {
      useCalendar({}, { field_settings: [] });
      queue('custom_fields', { data: [], error: null });
      queue('custom_fields', {
        data: [
          {
            field_key: 'client',
            space_id: null,
            is_active: true,
            is_deleted: false,
            deleted_at: null,
          },
        ],
        error: null,
      });
      queue('calendar_events', { data: event(), error: null });

      await expect(create({ client: 'ACME' })).resolves.toBeDefined();
    });

    it('still refuses a deleted field the calendar does not list', async () => {
      useCalendar({}, { field_settings: [] });
      queue('custom_fields', { data: [], error: null });
      queue('custom_fields', {
        data: [
          {
            field_key: 'client',
            space_id: null,
            is_active: true,
            is_deleted: true,
            deleted_at: null,
          },
        ],
        error: null,
      });

      await expect(create({ client: 'ACME' })).rejects.toThrow(
        /not shown on this calendar/,
      );
    });

    it('accepts a value for a field it does show', async () => {
      useCalendar({}, { field_settings: [{ field_id: 'field-1' }] });
      queue('custom_fields', { data: [field()], error: null });
      queue('calendar_events', { data: event(), error: null });

      await expect(create({ client: 'ACME' })).resolves.toBeDefined();
    });

    it('refuses an empty required field', async () => {
      useCalendar(
        {},
        { field_settings: [{ field_id: 'field-1', required: true }] },
      );
      queue('custom_fields', { data: [field()], error: null });

      await expect(create({})).rejects.toThrow(/"client" is required/);
    });

    it.each([
      ['an empty string', ''],
      ['an empty list', []],
    ])('treats %s as missing', async (_name, value) => {
      useCalendar(
        {},
        { field_settings: [{ field_id: 'field-1', required: true }] },
      );
      queue('custom_fields', { data: [field()], error: null });

      await expect(create({ client: value })).rejects.toThrow(/is required/);
    });

    it('accepts false as a filled-in value', async () => {
      useCalendar(
        {},
        { field_settings: [{ field_id: 'field-1', required: true }] },
      );
      queue('custom_fields', {
        data: [field({ field_key: 'billable' })],
        error: null,
      });
      queue('calendar_events', { data: event(), error: null });

      await expect(create({ billable: false })).resolves.toBeDefined();
    });

    it.each([
      ['switched off', { is_active: false }],
      ['deleted', { is_deleted: true }],
    ])('lets a required field that was %s through', async (_name, state) => {
      // A field nobody can fill in any more must not hold every new entry back.
      useCalendar(
        {},
        { field_settings: [{ field_id: 'field-1', required: true }] },
      );
      queue('custom_fields', { data: [field(state)], error: null });
      queue('calendar_events', { data: event(), error: null });

      await expect(create({})).resolves.toBeDefined();
    });

    it('turns a field lookup failure into a bad request', async () => {
      useCalendar({}, { field_settings: [{ field_id: 'field-1' }] });
      queue('custom_fields', { data: null, error: { message: 'fields gone' } });

      await expect(create({})).rejects.toThrow(/fields gone/);
    });
  });

  describe('watchers and links', () => {
    it('follow the same rule as changing the entry', async () => {
      const events = allPermissions().events;

      events.own_update = false;

      queue('calendar_events', { data: event(), error: null });
      useCalendar({ events });

      await expect(service.setWatchers(EVENT, [], USER, ORG)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
  describe('a whole-day entry on a day already gone', () => {
    const dayIn = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

    it('is refused when it starts before today', async () => {
      await expect(
        service.assertNoPastWholeDay(
          { is_all_day: true, start_date: dayIn(-2), timezone: 'UTC' },
          'user-1',
          'org-1',
        ),
      ).rejects.toThrow(/cannot start before today/);
    });

    it('is allowed from today onwards', async () => {
      await expect(
        service.assertNoPastWholeDay(
          { is_all_day: true, start_date: dayIn(1), timezone: 'UTC' },
          'user-1',
          'org-1',
        ),
      ).resolves.toBeUndefined();
    });

    it('leaves a timed entry alone', async () => {
      await expect(
        service.assertNoPastWholeDay(
          { is_all_day: false, start_date: dayIn(-2) },
          'user-1',
          'org-1',
        ),
      ).resolves.toBeUndefined();
    });

    it('lets an entry being changed keep its own earlier first day', async () => {
      jest.spyOn(service, 'getForUser').mockResolvedValue({
        is_all_day: true,
        start_date: dayIn(-5),
        timezone: 'UTC',
      });

      await expect(
        service.assertNoPastWholeDay(
          { start_date: dayIn(-5) },
          'user-1',
          'org-1',
          'event-1',
        ),
      ).resolves.toBeUndefined();
    });

    it('still refuses moving an entry to a different past day', async () => {
      jest.spyOn(service, 'getForUser').mockResolvedValue({
        is_all_day: true,
        start_date: dayIn(-5),
        timezone: 'UTC',
      });

      await expect(
        service.assertNoPastWholeDay(
          { start_date: dayIn(-7) },
          'user-1',
          'org-1',
          'event-1',
        ),
      ).rejects.toThrow(/cannot start before today/);
    });
  });
  describe('a timed entry in the past or ending too soon', () => {
    const at = (minutes: number) =>
      new Date(Date.now() + minutes * 60_000).toISOString();

    it('is refused when it starts in the past', async () => {
      await expect(
        service.assertNoPastTime(
          { is_all_day: false, starts_at: at(-60), ends_at: at(60) },
          'user-1',
          'org-1',
        ),
      ).rejects.toThrow(/cannot start in the past/);
    });

    it('allows a start a moment ago, within the grace', async () => {
      await expect(
        service.assertNoPastTime(
          { is_all_day: false, starts_at: at(-1), ends_at: at(30) },
          'user-1',
          'org-1',
        ),
      ).resolves.toBeUndefined();
    });

    it('is refused when it ends at or before its start', async () => {
      const start = at(60);

      await expect(
        service.assertNoPastTime(
          { is_all_day: false, starts_at: start, ends_at: start },
          'user-1',
          'org-1',
        ),
      ).rejects.toThrow(/end after it starts/);
    });

    it('leaves a whole-day entry alone', async () => {
      await expect(
        service.assertNoPastTime(
          { is_all_day: true, starts_at: at(-600), ends_at: at(-500) },
          'user-1',
          'org-1',
        ),
      ).resolves.toBeUndefined();
    });

    it('lets an entry being changed keep its own earlier start', async () => {
      const stored = at(-600);

      jest.spyOn(service, 'getForUser').mockResolvedValue({
        is_all_day: false,
        starts_at: stored,
        ends_at: at(-540),
      });

      await expect(
        service.assertNoPastTime(
          { starts_at: stored, ends_at: at(-500) },
          'user-1',
          'org-1',
          'event-1',
        ),
      ).resolves.toBeUndefined();
    });

    it('still refuses moving an entry to a different past time', async () => {
      jest.spyOn(service, 'getForUser').mockResolvedValue({
        is_all_day: false,
        starts_at: at(-600),
        ends_at: at(-540),
      });

      await expect(
        service.assertNoPastTime(
          { starts_at: at(-900) },
          'user-1',
          'org-1',
          'event-1',
        ),
      ).rejects.toThrow(/cannot start in the past/);
    });

    it('checks a new end against the stored start', async () => {
      jest.spyOn(service, 'getForUser').mockResolvedValue({
        is_all_day: false,
        starts_at: at(60),
        ends_at: at(120),
      });

      await expect(
        service.assertNoPastTime(
          { ends_at: at(30) },
          'user-1',
          'org-1',
          'event-1',
        ),
      ).rejects.toThrow(/end after it starts/);
    });
  });

  describe('telling people they were linked to an entry', () => {
    const OTHER = 'user-3';
    let broadcast: jest.Mock;
    let notifier: CalendarEventsService;

    // The notification runs after the save returns, so give it a few turns to finish.
    const settle = async () => {
      for (let turn = 0; turn < 6; turn++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    };

    const notify = (
      entry: Record<string, unknown>,
      before: Array<{ type: string; id: string }>,
    ) =>
      (
        notifier as unknown as {
          notifyLinkedUsers: (
            entry: Record<string, unknown>,
            calendar: CalendarWithAccess,
            before: Array<{ type: string; id: string }>,
            userId: string,
            organizationId: string,
          ) => void;
        }
      ).notifyLinkedUsers(entry, visible(), before, USER, ORG);

    beforeEach(() => {
      broadcast = jest.fn().mockResolvedValue(undefined);
      notifier = new CalendarEventsService(
        {
          getClient: () => ({ from: mockFrom }),
        } as unknown as SupabaseAdminService,
        { getForUser: getCalendar } as unknown as CalendarsService,
        {} as CalendarAccessService,
        {} as CalendarAuditService,
        {} as CalendarSyncService,
        { broadcastNotification: broadcast } as never,
      );
      getCalendar.mockResolvedValue(visible());
    });

    it('notifies each newly linked person in the organization, and links to the entry', async () => {
      queue('organization_members', {
        data: [{ user_id: OTHER_USER }, { user_id: OTHER }],
        error: null,
      });
      queue('users', {
        data: { first_name: 'Prince', last_name: 'Jadiya', email: null },
        error: null,
      });
      const written = queue('notifications', {
        data: [{ id: 'n-1' }, { id: 'n-2' }],
        error: null,
      });

      notify(
        event({
          links: [
            { type: 'user', id: OTHER_USER },
            { type: 'user', id: OTHER },
          ],
          is_all_day: false,
          starts_at: '2026-10-03T10:00:00.000Z',
          ends_at: '2026-10-03T11:00:00.000Z',
          timezone: 'UTC',
        }),
        [],
      );
      await settle();

      const rows = (
        written.insert as jest.Mock<unknown, [Array<Record<string, unknown>>]>
      ).mock.calls[0][0];

      expect(rows.map((row) => row.user_id)).toEqual([OTHER_USER, OTHER]);
      expect(rows[0]).toMatchObject({
        type: 'calendar_link',
        reference_type: 'calendar_event',
        reference_id: EVENT,
        title: 'Prince Jadiya linked you to an event',
        metadata: expect.objectContaining({
          link: `/calendar?entry=${EVENT}`,
        }) as unknown,
      });
      expect(broadcast).toHaveBeenCalledTimes(2);
    });

    it('tells nobody about themselves, people already linked, or links that are not people', async () => {
      notify(
        event({
          links: [
            { type: 'user', id: USER },
            { type: 'user', id: OTHER_USER },
            { type: 'task', id: 'task-1' },
          ],
        }),
        [{ type: 'user', id: OTHER_USER }],
      );
      await settle();

      expect(mockFrom).not.toHaveBeenCalled();
      expect(getCalendar).not.toHaveBeenCalled();
    });

    it('still notifies someone who cannot see the calendar', async () => {
      getCalendar.mockRejectedValue(
        new NotFoundException('Calendar not found'),
      );
      queue('organization_members', {
        data: [{ user_id: OTHER_USER }],
        error: null,
      });
      queue('users', { data: null, error: null });
      const written = queue('notifications', {
        data: [{ id: 'n-1' }],
        error: null,
      });

      notify(event({ links: [{ type: 'user', id: OTHER_USER }] }), []);
      await settle();

      const rows = (
        written.insert as jest.Mock<unknown, [Array<Record<string, unknown>>]>
      ).mock.calls[0][0];

      expect(rows.map((row) => row.user_id)).toEqual([OTHER_USER]);
      expect(broadcast).toHaveBeenCalledTimes(1);
    });

    it('never reaches someone outside this organization', async () => {
      queue('organization_members', { data: [], error: null });

      notify(event({ links: [{ type: 'user', id: 'stranger' }] }), []);
      await settle();

      expect(mockFrom).toHaveBeenCalledTimes(1);
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('never lets a failed notification surface as an error', async () => {
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});

      queue('organization_members', {
        data: [{ user_id: OTHER_USER }],
        error: null,
      });
      queue('users', { data: null, error: null });
      queue('notifications', {
        data: null,
        error: { message: 'insert failed' },
      });

      expect(() =>
        notify(event({ links: [{ type: 'user', id: OTHER_USER }] }), []),
      ).not.toThrow();
      await settle();

      expect(broadcast).not.toHaveBeenCalled();
      expect(quiet).toHaveBeenCalled();
      quiet.mockRestore();
    });

    it('writes a timed entry on one day with its zone, calendar and place', () => {
      expect(
        CalendarEventsService.linkBody(
          {
            summary: 'Team sync',
            is_all_day: false,
            starts_at: '2026-10-03T04:30:00.000Z',
            ends_at: '2026-10-03T05:30:00.000Z',
            timezone: 'Asia/Kolkata',
            location: 'Room 4',
          },
          'Team Calendar',
        ),
      ).toBe(
        'Team sync\nSat, 3 Oct 2026 · 10:00 – 11:00 (Asia/Kolkata)\nCalendar: Team Calendar · Room 4',
      );
    });

    it('writes a whole-day entry by its first and last day', () => {
      expect(
        CalendarEventsService.linkBody(
          {
            summary: 'Offsite',
            is_all_day: true,
            start_date: '2026-10-03',
            end_date: '2026-10-05',
          },
          'Team Calendar',
        ),
      ).toBe(
        'Offsite\nSat, 3 Oct 2026 – Sun, 4 Oct 2026 · All day\nCalendar: Team Calendar',
      );
    });

    it('falls back to UTC for a zone it does not know', () => {
      expect(
        CalendarEventsService.linkBody(
          {
            summary: 'Call',
            is_all_day: false,
            starts_at: '2026-10-03T10:00:00.000Z',
            ends_at: '2026-10-04T01:00:00.000Z',
            timezone: 'Not/AZone',
          },
          'Team Calendar',
        ),
      ).toBe(
        'Call\nSat, 3 Oct 2026, 10:00 – Sun, 4 Oct 2026, 01:00 (Not/AZone)\nCalendar: Team Calendar',
      );
    });

    describe('followers', () => {
      const follow = (entry: Record<string, unknown>, before: string[]) =>
        (
          notifier as unknown as {
            notifyFollowers: (
              entry: Record<string, unknown>,
              calendar: CalendarWithAccess,
              before: string[],
              userId: string,
              organizationId: string,
            ) => void;
          }
        ).notifyFollowers(entry, visible(), before, USER, ORG);

      it('tells each new follower they now follow the entry, and links to it', async () => {
        queue('organization_members', {
          data: [{ user_id: OTHER_USER }],
          error: null,
        });
        queue('users', {
          data: { first_name: 'Prince', last_name: 'Jadiya', email: null },
          error: null,
        });
        const written = queue('notifications', {
          data: [{ id: 'n-1' }],
          error: null,
        });

        follow(event({ watcher_ids: [OTHER_USER] }), []);
        await settle();

        const rows = (
          written.insert as jest.Mock<unknown, [Array<Record<string, unknown>>]>
        ).mock.calls[0][0];

        expect(rows[0]).toMatchObject({
          user_id: OTHER_USER,
          type: 'calendar_follow',
          title: 'Prince Jadiya added you as a follower of an event',
          reference_type: 'calendar_event',
          metadata: expect.objectContaining({
            link: `/calendar?entry=${EVENT}`,
            added_by_user_id: USER,
          }) as unknown,
        });
        expect(broadcast).toHaveBeenCalledTimes(1);
      });

      it('during an edit, tells only the follower who was just added', async () => {
        queue('organization_members', {
          data: [{ user_id: OTHER }],
          error: null,
        });
        queue('users', { data: null, error: null });
        const written = queue('notifications', {
          data: [{ id: 'n-1' }],
          error: null,
        });

        follow(event({ watcher_ids: [OTHER_USER, OTHER] }), [OTHER_USER]);
        await settle();

        const rows = (
          written.insert as jest.Mock<unknown, [Array<Record<string, unknown>>]>
        ).mock.calls[0][0];

        expect(rows.map((row) => row.user_id)).toEqual([OTHER]);
      });

      it('tells nobody about following their own entry', async () => {
        follow(event({ watcher_ids: [USER] }), []);
        await settle();

        expect(mockFrom).not.toHaveBeenCalled();
      });
    });
  });

  describe('your own entries in one calendar cannot overlap', () => {
    it('refuses a timed entry that overlaps one of yours in the same calendar', async () => {
      const read = queue('calendar_events', {
        data: [
          {
            id: 'other',
            summary: 'Stand-up',
            is_all_day: false,
            starts_at: '2026-10-15T03:30:00.000Z',
            ends_at: '2026-10-15T04:30:00.000Z',
            timezone: 'Asia/Calcutta',
          },
        ],
        error: null,
      });

      await expect(
        service.assertNoOwnClash(
          {
            calendar_id: CAL,
            is_all_day: false,
            starts_at: '2026-10-15T04:00:00.000Z',
            ends_at: '2026-10-15T05:00:00.000Z',
          },
          USER,
          ORG,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      // Same calendar, the caller's own entries, made here, still standing.
      expect(read.eq).toHaveBeenCalledWith('calendar_id', CAL);
      expect(read.eq).toHaveBeenCalledWith('created_by', USER);
      expect(read.eq).toHaveBeenCalledWith('source', 'local');
      expect(read.lt).toHaveBeenCalledWith(
        'starts_at',
        '2026-10-15T05:00:00.000Z',
      );
      expect(read.gt).toHaveBeenCalledWith(
        'ends_at',
        '2026-10-15T04:00:00.000Z',
      );
    });

    it('names the clash in the entry own time zone', async () => {
      queue('calendar_events', {
        data: [
          {
            id: 'other',
            summary: 'Stand-up',
            is_all_day: false,
            starts_at: '2026-10-15T03:30:00.000Z',
            ends_at: '2026-10-15T04:30:00.000Z',
            timezone: 'Asia/Calcutta',
          },
        ],
        error: null,
      });

      await expect(
        service.assertNoOwnClash(
          {
            calendar_id: CAL,
            starts_at: '2026-10-15T04:00:00.000Z',
            ends_at: '2026-10-15T05:00:00.000Z',
          },
          USER,
          ORG,
        ),
      ).rejects.toThrow(
        'You already have "Stand-up" in this calendar at that time (Thu, 15 Oct 2026 · 09:00 – 10:00).',
      );
    });

    it('allows the time when nothing of yours overlaps in that calendar', async () => {
      queue('calendar_events', { data: [], error: null });

      await expect(
        service.assertNoOwnClash(
          {
            calendar_id: CAL,
            starts_at: '2026-10-15T04:00:00.000Z',
            ends_at: '2026-10-15T05:00:00.000Z',
          },
          USER,
          ORG,
        ),
      ).resolves.toBeUndefined();
    });

    it('compares whole days by date, the stored end being the day after', async () => {
      const read = queue('calendar_events', { data: [], error: null });

      await service.assertNoOwnClash(
        {
          calendar_id: CAL,
          is_all_day: true,
          start_date: '2026-10-15',
          end_date: '2026-10-17',
        },
        USER,
        ORG,
      );

      expect(read.eq).toHaveBeenCalledWith('is_all_day', true);
      expect(read.lt).toHaveBeenCalledWith('start_date', '2026-10-17');
      expect(read.gt).toHaveBeenCalledWith('end_date', '2026-10-15');
    });

    it('checks an edit against its own calendar and leaves the entry itself out', async () => {
      jest.spyOn(service, 'getForUser').mockResolvedValue({
        id: EVENT,
        calendar_id: CAL,
        is_all_day: false,
        starts_at: '2026-10-15T03:30:00.000Z',
        ends_at: '2026-10-15T04:30:00.000Z',
      });
      const read = queue('calendar_events', { data: [], error: null });

      await service.assertNoOwnClash(
        { ends_at: '2026-10-15T05:00:00.000Z' },
        USER,
        ORG,
        EVENT,
      );

      expect(read.eq).toHaveBeenCalledWith('calendar_id', CAL);
      expect(read.neq).toHaveBeenCalledWith('id', EVENT);
    });

    it('does not look at all when an edit leaves the time alone', async () => {
      const spy = jest.spyOn(service, 'getForUser');

      await service.assertNoOwnClash({}, USER, ORG, EVENT);

      expect(spy).not.toHaveBeenCalled();
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });
});
