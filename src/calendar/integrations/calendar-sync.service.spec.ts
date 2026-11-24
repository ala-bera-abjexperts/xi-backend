/**
 * @fileoverview Linking a calendar to an outside one, and bringing changes in.
 *
 * Two things matter here beyond the happy path: a run spends the account owner's stored credential,
 * so it may not be driven by somebody who merely shares the calendar; and an import must be able to
 * run twice without doubling anything.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CalendarAccessService } from '../calendar-access.service';
import { CalendarsService } from '../calendars.service';
import type { CalendarWithAccess } from '../calendars.service';
import { allPermissions } from '../calendar-permissions.model';
import { CalendarAccountsService } from './calendar-accounts.service';
import type { CalendarAccountRow } from './calendar-accounts.service';
import { CalendarProvidersService } from './calendar-providers.service';
import { CalendarSyncService } from './calendar-sync.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { CalendarAuditService } from '../calendar-audit.service';
import { ProviderConflictError } from './calendar-provider';

describe('CalendarSyncService', () => {
  let service: CalendarSyncService;
  let mockFrom: jest.Mock;
  let queued: Map<string, Record<string, unknown>[]>;
  let getCalendar: jest.Mock;
  let getOwned: jest.Mock;

  const ORG = 'org-1';
  const USER = 'user-1';
  const CAL = 'cal-1';
  const ACCOUNT = 'acc-1';

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
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

  /** Every connection box off: each route now takes only its own flag, `sync.manage` no longer counts. */
  const NO_CONNECTION = {
    view: false,
    create: false,
    update: false,
    delete: false,
    stop_sync: false,
  };

  /** The calendar the service reads, with the sync flags a case wants to withhold. */
  function useCalendar(
    syncOverrides: Partial<ReturnType<typeof allPermissions>['sync']> = {},
    overrides: Record<string, unknown> = {},
    integrationsOverrides: Partial<
      ReturnType<typeof allPermissions>['integrations']
    > = {},
  ) {
    const permissions = allPermissions();

    permissions.sync = { ...permissions.sync, ...syncOverrides };
    permissions.integrations = {
      ...permissions.integrations,
      ...integrationsOverrides,
    };

    getCalendar.mockResolvedValue({
      id: CAL,
      organization_id: ORG,
      space_id: null,
      owner_id: USER,
      visibility: 'private',
      shares: [],
      access: 'manage',
      rights: {
        create_entries: true,
        edit_entries: true,
        delete_entries: true,
        manage: true,
      },
      permissions,
      ...overrides,
    } as unknown as CalendarWithAccess);
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
    getOwned = jest.fn().mockResolvedValue({ id: ACCOUNT, provider: 'google' });

    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    const calendars = {
      getForUser: getCalendar,
    } as unknown as CalendarsService;

    const access = {
      assertAllowed: (allowed: boolean, what: string) => {
        if (!allowed) throw new ForbiddenException(what);
      },
    } as unknown as CalendarAccessService;

    const accounts = {
      getOwned,
      getById: jest.fn(),
      tokens: jest.fn(),
      markNeedsReconnect: jest.fn(),
      storeRefreshed: jest.fn(),
    } as unknown as CalendarAccountsService;

    const providers = {
      get: jest.fn(),
      isLinkBased: jest.fn().mockReturnValue(false),
    } as unknown as CalendarProvidersService;

    // Audit writes are fire-and-forget; these tests are about the sync, not the log.
    const audit = {
      sharesChanged: jest.fn(),
      calendar: jest.fn(),
      entry: jest.fn(),
      integration: jest.fn(),
    } as unknown as CalendarAuditService;

    service = new CalendarSyncService(
      supa,
      calendars,
      access,
      accounts,
      providers,
      audit,
    );
  });

  describe('linking', () => {
    it('needs the permission to manage the connection', async () => {
      useCalendar({ manage: false }, {}, NO_CONNECTION);

      await expect(
        service.link(
          CAL,
          { account_id: ACCOUNT, external_calendar_id: 'primary' },
          USER,
          ORG,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('requires the account to be the caller own', async () => {
      // Otherwise linking would point a calendar at somebody else's stored credential.
      useCalendar();
      getOwned.mockRejectedValue(new BadRequestException('not yours'));

      await expect(
        service.link(
          CAL,
          { account_id: ACCOUNT, external_calendar_id: 'primary' },
          USER,
          ORG,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('stores the link and asks for a first pass straight away', async () => {
      useCalendar();

      const chain = queue('calendars', { data: {}, error: null });

      await service.link(
        CAL,
        { account_id: ACCOUNT, external_calendar_id: 'primary' },
        USER,
        ORG,
      );

      const patch = (chain.update as jest.Mock).mock.calls[0][0];

      expect(patch.sync_account_id).toBe(ACCOUNT);
      expect(patch.sync_external_calendar_id).toBe('primary');
      expect(patch.sync_next_attempt_at).toEqual(expect.any(String));
    });

    it('queues the calendar own entries to go out when linked export-only', async () => {
      useCalendar();
      queue('calendars', { data: {}, error: null });

      const events = queue('calendar_events', { data: null, error: null });

      await service.link(
        CAL,
        {
          account_id: ACCOUNT,
          external_calendar_id: 'primary',
          direction: 'export',
        },
        USER,
        ORG,
      );

      expect(events.update).toHaveBeenCalledWith({ sync_pending: true });
      expect(events.eq).toHaveBeenCalledWith('calendar_id', CAL);
      expect(events.is).toHaveBeenCalledWith('external_id', null);
      expect(events.is).toHaveBeenCalledWith('deleted_at', null);
    });

    it('leaves entries alone when linked import-only', async () => {
      useCalendar();
      queue('calendars', { data: {}, error: null });

      // from('calendar_events') would throw here, as nothing is queued for it
      await service.link(
        CAL,
        {
          account_id: ACCOUNT,
          external_calendar_id: 'primary',
          direction: 'import',
        },
        USER,
        ORG,
      );

      expect(mockFrom).not.toHaveBeenCalledWith('calendar_events');
    });

    it('explains the clash when that outside calendar is already linked here', async () => {
      useCalendar();
      queue('calendars', {
        data: null,
        error: { code: '23505', message: 'dup' },
      });

      await expect(
        service.link(
          CAL,
          { account_id: ACCOUNT, external_calendar_id: 'primary' },
          USER,
          ORG,
        ),
      ).rejects.toThrow(/already linked/);
    });
  });

  describe('unlinking', () => {
    it('needs the same permission as linking', async () => {
      useCalendar({ manage: false }, {}, NO_CONNECTION);

      await expect(service.unlink(CAL, USER, ORG)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('keeps the entries already brought in, so nothing disappears from anyone view', async () => {
      useCalendar();

      const chain = queue('calendars', { data: {}, error: null });

      await service.unlink(CAL, USER, ORG);

      const patch = (chain.update as jest.Mock).mock.calls[0][0];

      expect(patch.sync_account_id).toBeNull();
      expect(patch).not.toHaveProperty('events');
    });
  });

  describe('running a sync now', () => {
    it('needs the permission to manage the connection, not merely to edit entries', async () => {
      useCalendar(
        { manage: false },
        { sync_account_id: ACCOUNT },
        NO_CONNECTION,
      );

      await expect(service.runNow(CAL, USER, ORG)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses when the calendar is not linked to anything', async () => {
      useCalendar();

      await expect(service.runNow(CAL, USER, ORG)).rejects.toThrow(
        /not linked/,
      );
    });

    it('refuses to drive an account that is not the caller own', async () => {
      useCalendar(
        {},
        {
          sync_account_id: ACCOUNT,
          sync_external_calendar_id: 'primary',
        },
      );
      getOwned.mockRejectedValue(new BadRequestException('not yours'));

      await expect(service.runNow(CAL, USER, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('export-only sends changes out and brings nothing in', async () => {
      useCalendar(
        {},
        {
          sync_account_id: ACCOUNT,
          sync_external_calendar_id: 'primary',
          sync_direction: 'export',
        },
      );

      const push = jest
        .spyOn(service, 'pushPending')
        .mockResolvedValue({ exported: 2, conflicts: 0 });
      const pull = jest.spyOn(service, 'importInto');

      const result = await service.runNow(CAL, USER, ORG);

      expect(push).toHaveBeenCalledTimes(1);
      expect(pull).not.toHaveBeenCalled();
      expect(result).toMatchObject({ exported: 2, imported: 0, removed: 0 });
    });

    it('import-only brings changes in and sends nothing out', async () => {
      useCalendar(
        {},
        {
          sync_account_id: ACCOUNT,
          sync_external_calendar_id: 'primary',
          sync_direction: 'import',
        },
      );

      const push = jest.spyOn(service, 'pushPending');
      const pull = jest
        .spyOn(service, 'importInto')
        .mockResolvedValue({ imported: 3, removed: 0, reset: false });

      const result = await service.runNow(CAL, USER, ORG);

      expect(push).not.toHaveBeenCalled();
      expect(pull).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ imported: 3, exported: 0 });
    });
  });
  describe('sending local changes out', () => {
    const write = {
      createEvent: jest.fn(),
      updateEvent: jest.fn(),
      deleteEvent: jest.fn(),
    };
    let sender: CalendarSyncService;

    const calendarRow = { id: CAL, sync_external_calendar_id: 'primary' };
    const googleAccount = {
      id: ACCOUNT,
      provider: 'google',
    } as unknown as CalendarAccountRow;

    const entry = (overrides: Record<string, unknown> = {}) => ({
      id: 'ev-1',
      summary: 'Standup',
      description: null,
      location: null,
      is_all_day: false,
      starts_at: '2026-10-05T09:00:00.000Z',
      ends_at: '2026-10-05T09:30:00.000Z',
      start_date: null,
      end_date: null,
      timezone: 'Asia/Kolkata',
      external_id: null,
      external_etag: null,
      deleted_at: null,
      ...overrides,
    });

    beforeEach(() => {
      Object.values(write).forEach((fn) => fn.mockReset());

      const accounts = {
        tokens: jest.fn().mockReturnValue({
          accessToken: 'token',
          refreshToken: null,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      } as unknown as CalendarAccountsService;

      const providers = {
        get: jest.fn().mockReturnValue(write),
        isLinkBased: jest.fn().mockReturnValue(false),
      } as unknown as CalendarProvidersService;

      const audit = {
        integration: jest.fn(),
      } as unknown as CalendarAuditService;

      sender = new CalendarSyncService(
        {
          getClient: () => ({ from: mockFrom }),
        } as unknown as SupabaseAdminService,
        {} as CalendarsService,
        {} as CalendarAccessService,
        accounts,
        providers,
        audit,
      );
    });

    it('creates an entry that has never been out, and keeps the id the provider gave it', async () => {
      queue('calendar_events', { data: [entry()], error: null });
      const settled = queue('calendar_events', { data: null, error: null });

      write.createEvent.mockResolvedValue({ external_id: 'g-1', etag: '"v1"' });

      await expect(
        sender.pushPending(calendarRow, googleAccount),
      ).resolves.toEqual({
        exported: 1,
        conflicts: 0,
      });
      expect(write.createEvent).toHaveBeenCalledWith(
        'token',
        'primary',
        expect.objectContaining({
          summary: 'Standup',
          timezone: 'Asia/Kolkata',
          is_all_day: false,
        }),
      );
      expect(settled.update).toHaveBeenCalledWith({
        sync_pending: false,
        external_id: 'g-1',
        external_etag: '"v1"',
      });
    });

    it('updates an entry already out, guarded by the version last read', async () => {
      queue('calendar_events', {
        data: [entry({ external_id: 'g-1', external_etag: '"v1"' })],
        error: null,
      });
      const settled = queue('calendar_events', { data: null, error: null });

      write.updateEvent.mockResolvedValue({ external_id: 'g-1', etag: '"v2"' });

      await sender.pushPending(calendarRow, googleAccount);

      expect(write.updateEvent).toHaveBeenCalledWith(
        'token',
        'primary',
        'g-1',
        expect.any(Object),
        '"v1"',
      );
      expect(settled.update).toHaveBeenCalledWith({
        sync_pending: false,
        external_etag: '"v2"',
      });
    });

    it('sends a local delete as a delete', async () => {
      queue('calendar_events', {
        data: [
          entry({ external_id: 'g-1', deleted_at: '2026-10-02T10:00:00.000Z' }),
        ],
        error: null,
      });
      queue('calendar_events', { data: null, error: null });

      await sender.pushPending(calendarRow, googleAccount);

      expect(write.deleteEvent).toHaveBeenCalledWith('token', 'primary', 'g-1');
    });

    it('settles a delete that never went out without calling the provider', async () => {
      queue('calendar_events', {
        data: [entry({ deleted_at: '2026-10-02T10:00:00.000Z' })],
        error: null,
      });
      const settled = queue('calendar_events', { data: null, error: null });

      await sender.pushPending(calendarRow, googleAccount);

      expect(write.deleteEvent).not.toHaveBeenCalled();
      expect(settled.update).toHaveBeenCalledWith({ sync_pending: false });
    });

    it('never overwrites a newer version at the provider: it records a conflict instead', async () => {
      queue('calendar_events', {
        data: [entry({ external_id: 'g-1', external_etag: '"v1"' })],
        error: null,
      });
      const settled = queue('calendar_events', { data: null, error: null });

      write.updateEvent.mockRejectedValue(
        new ProviderConflictError('Changed in Google Calendar'),
      );

      await expect(
        sender.pushPending(calendarRow, googleAccount),
      ).resolves.toEqual({
        exported: 0,
        conflicts: 1,
      });
      expect(settled.update).toHaveBeenCalledWith(
        expect.objectContaining({
          sync_pending: false,
          sync_conflict: expect.objectContaining({
            reason: 'Changed in Google Calendar',
          }),
        }),
      );
    });

    it('leaves an entry pending when the provider fails for another reason, so the next run retries', async () => {
      queue('calendar_events', { data: [entry()], error: null });
      write.createEvent.mockRejectedValue(new Error('network down'));

      // No settle is queued: if the entry were marked sent, the mock would throw on the extra write.
      await expect(
        sender.pushPending(calendarRow, googleAccount),
      ).resolves.toEqual({
        exported: 0,
        conflicts: 0,
      });
    });

    it('sends nothing to a provider that cannot be written to', async () => {
      const readOnly = new CalendarSyncService(
        {
          getClient: () => ({ from: mockFrom }),
        } as unknown as SupabaseAdminService,
        {} as CalendarsService,
        {} as CalendarAccessService,
        {} as CalendarAccountsService,
        {
          get: jest.fn().mockReturnValue({}),
        } as unknown as CalendarProvidersService,
        {} as CalendarAuditService,
      );

      // Nothing is queued: reading the pending entries at all would throw.
      await expect(
        readOnly.pushPending(calendarRow, {
          id: 'acc-2',
          provider: 'ics',
        } as unknown as CalendarAccountRow),
      ).resolves.toEqual({ exported: 0, conflicts: 0 });
    });
  });
});
