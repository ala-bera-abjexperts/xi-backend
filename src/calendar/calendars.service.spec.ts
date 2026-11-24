/**
 * @fileoverview The calendar API itself: listing, reading one, creating, and changing who it is
 * shared with.
 *
 * Every route here goes through `CalendarAccessService`, which is stubbed so these tests are about
 * what the API does with an answer rather than about how the answer is reached — that is covered in
 * `calendar-access.service.spec.ts`.
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type {
  CalendarAccess,
  CalendarRow,
  CalendarShare,
} from './calendar-access.service';
import { CalendarAccessService } from './calendar-access.service';
import { CalendarAuditService } from './calendar-audit.service';
import { CalendarsService } from './calendars.service';
import { allPermissions, noPermissions } from './calendar-permissions.model';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('CalendarsService', () => {
  let service: CalendarsService;
  let mockFrom: jest.Mock;
  let queued: Map<string, Record<string, unknown>[]>;
  let resolveDecision: jest.Mock;
  let resolveManyDecisions: jest.Mock;
  let assertCanCreateInSpace: jest.Mock;
  let assertAllowed: jest.Mock;
  let sharesChanged: jest.Mock;
  let mockRpc: jest.Mock;
  let canReadSpaceTickets: jest.Mock;

  const ORG = 'org-1';
  const USER = 'user-1';
  const OTHER_USER = 'user-2';
  const SPACE = 'space-1';
  const OTHER_SPACE = 'space-2';
  const CAL = 'cal-1';

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.or = jest.fn().mockImplementation(self);
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

  function calendar(overrides: Record<string, unknown> = {}): CalendarRow {
    return {
      id: CAL,
      organization_id: ORG,
      space_id: null,
      owner_id: USER,
      visibility: 'private',
      shares: [],
      feeds: [],
      field_settings: [],
      ...overrides,
    } as CalendarRow;
  }

  /** The decision the gate hands back, built from a level so the cases stay about the level. */
  function decisionOf(
    level: CalendarAccess,
    calendarFlags: { edit?: boolean; delete?: boolean } = {},
  ) {
    const writes = level === 'edit' || level === 'manage';
    const permissions = level === 'manage' ? allPermissions() : noPermissions();

    if (level !== 'manage' && level !== 'none') {
      permissions.events.own_read = true;
      permissions.events.others_read = true;
      permissions.task_events.read = true;
      permissions.sync.read = true;
    }

    if (level === 'edit') {
      permissions.events.create = true;
      permissions.events.own_update = true;
      permissions.events.others_update = true;
      permissions.task_events.update = true;
    }

    // The calendar object has its own two flags, granted apart from the level.
    if (calendarFlags.edit) permissions.calendar.edit = true;
    if (calendarFlags.delete) permissions.calendar.delete = true;

    return {
      access: level,
      source: level === 'none' ? 'none' : 'owner',
      rights: {
        create_entries: writes,
        edit_entries: writes,
        delete_entries: writes,
        manage: level === 'manage',
      },
      permissions,
    };
  }

  function withAccess(
    level: CalendarAccess,
    calendarFlags: { edit?: boolean; delete?: boolean } = {},
  ) {
    resolveDecision.mockResolvedValue(decisionOf(level, calendarFlags));
  }

  /** The real ranking, so "not enough access" really is decided the way the gate decides it. */
  const realAssert = new CalendarAccessService(
    undefined as never,
    undefined as never,
    undefined as never,
  ).assert.bind(null as never);

  beforeEach(() => {
    queued = new Map();
    mockFrom = jest.fn((table: string) => {
      const list = queued.get(table);

      if (!list || list.length === 0) {
        throw new Error(`unexpected from('${table}')`);
      }

      return list.shift();
    });

    resolveDecision = jest.fn();
    resolveManyDecisions = jest.fn();
    assertCanCreateInSpace = jest.fn().mockResolvedValue(undefined);
    assertAllowed = jest.fn((allowed: boolean, what: string) => {
      if (!allowed) throw new ForbiddenException(what);
    });
    sharesChanged = jest.fn();

    mockRpc = jest.fn().mockResolvedValue({ data: [], error: null });
    canReadSpaceTickets = jest.fn().mockResolvedValue(true);

    const supa = {
      getClient: () => ({ from: mockFrom, rpc: mockRpc }),
    } as unknown as SupabaseAdminService;

    const access = {
      resolveDecision,
      resolveManyDecisions,
      assertCanCreateInSpace,
      assertCanCreateCalendars: jest.fn().mockResolvedValue(undefined),
      assertAllowed,
      assert: (level: CalendarAccess, needed: CalendarAccess) =>
        realAssert(level, needed),
      isOrgAdmin: jest.fn().mockResolvedValue(true),
      assertCanReadSpaceTickets: jest.fn().mockResolvedValue(undefined),
      assertLinkableSpace: jest.fn().mockResolvedValue(undefined),
      canReadSpaceTickets,
    } as unknown as CalendarAccessService;

    const audit = {
      sharesChanged,
      calendar: jest.fn(),
    } as unknown as CalendarAuditService;

    service = new CalendarsService(supa, access, audit);
  });

  describe('the module switch', () => {
    it('passes when the organization has the module on', async () => {
      queue('organization_modules', {
        data: { is_enabled: true },
        error: null,
      });

      await expect(service.assertModuleEnabled(ORG)).resolves.toBeUndefined();
    });

    it('refuses when it is off, so turning it off takes effect at once', async () => {
      queue('organization_modules', {
        data: { is_enabled: false },
        error: null,
      });

      await expect(service.assertModuleEnabled(ORG)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses when the organization has no row for it at all', async () => {
      queue('organization_modules', { data: null, error: null });

      await expect(service.assertModuleEnabled(ORG)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('listing', () => {
    it('drops the calendars this person cannot reach and keeps the rest', async () => {
      queue('calendars', {
        data: [
          calendar({ id: 'a' }),
          calendar({ id: 'b' }),
          calendar({ id: 'c' }),
        ],
        error: null,
      });

      resolveManyDecisions.mockResolvedValue(
        new Map([
          ['a', decisionOf('manage')],
          ['b', decisionOf('none')],
          ['c', decisionOf('view')],
        ]),
      );

      const result = await service.listVisible(USER, ORG);

      expect(result.map((row) => row.id)).toEqual(['a', 'c']);
    });

    it('hands back the matrix beside the level, which is what the screens gate on', async () => {
      queue('calendars', { data: [calendar({ id: 'a' })], error: null });
      resolveManyDecisions.mockResolvedValue(
        new Map([['a', decisionOf('manage')]]),
      );

      const [row] = await service.listVisible(USER, ORG);

      expect(row.permissions.manage).toBe(true);
      expect(row.access).toBe('manage');
    });

    it('calls a calendar mine when I own it, made it, or it is shared for me to manage', async () => {
      queue('calendars', {
        data: [
          calendar({ id: 'owned', owner_id: USER }),
          calendar({ id: 'made', owner_id: 'user-9', created_by: USER }),
          calendar({ id: 'managed', owner_id: 'user-9' }),
          calendar({ id: 'viewed', owner_id: 'user-9' }),
          calendar({ id: 'admin-reach', owner_id: 'user-9' }),
        ],
        error: null,
      });
      // Every answer carries both flags, as the list pass sets them.
      const decided = (
        level: CalendarAccess,
        sharedWithMe = false,
        sharedWithManage = false,
      ) => ({ ...decisionOf(level), sharedWithMe, sharedWithManage });

      resolveManyDecisions.mockResolvedValue(
        new Map([
          ['owned', decided('manage')],
          ['made', decided('view')],
          ['managed', decided('manage', true, true)],
          ['viewed', decided('view', true, false)],

          // An admin may manage it, yet nobody shared it with them.
          ['admin-reach', decided('manage')],
        ]),
      );

      const result = await service.listVisible(USER, ORG);

      expect(
        Object.fromEntries(result.map((row) => [row.id, row.is_mine])),
      ).toEqual({
        owned: true,
        made: true,
        managed: true,
        viewed: false,
        'admin-reach': false,
      });
    });

    it('treats a calendar missing from the answer as unreachable, never as open', async () => {
      queue('calendars', { data: [calendar({ id: 'a' })], error: null });
      resolveManyDecisions.mockResolvedValue(new Map());

      await expect(service.listVisible(USER, ORG)).resolves.toEqual([]);
    });

    it('reads only this organization', async () => {
      const chain = queue('calendars', { data: [], error: null });

      resolveManyDecisions.mockResolvedValue(new Map());
      await service.listVisible(USER, ORG);

      expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
    });
  });

  describe('reading one', () => {
    it('says not found, never forbidden, when there is no access at all', async () => {
      // A private calendar must not confirm its own existence.
      queue('calendars', { data: calendar(), error: null });
      withAccess('none');

      await expect(service.getForUser(CAL, USER, ORG)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('says forbidden when there is some access but not enough', async () => {
      queue('calendars', { data: calendar(), error: null });
      withAccess('view');

      await expect(
        service.getForUser(CAL, USER, ORG, 'manage'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('says not found when the row is not in this organization', async () => {
      queue('calendars', { data: null, error: null });

      await expect(service.getForUser(CAL, USER, ORG)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the row with its level and matrix', async () => {
      queue('calendars', { data: calendar(), error: null });
      withAccess('manage');

      const row = await service.getForUser(CAL, USER, ORG);

      expect(row.access).toBe('manage');
      expect(row.permissions.manage).toBe(true);
    });
  });

  describe('creating', () => {
    it('checks the space before writing anything', async () => {
      queue('calendars', { data: calendar(), error: null });

      await service.create(
        { name: 'Team', space_id: SPACE } as never,
        USER,
        ORG,
      );

      expect(assertCanCreateInSpace).toHaveBeenCalledWith(USER, ORG, SPACE);
    });

    it('does not ask about a space for a personal calendar', async () => {
      queue('calendars', { data: calendar(), error: null });

      await service.create({ name: 'Mine' } as never, USER, ORG);

      expect(assertCanCreateInSpace).not.toHaveBeenCalled();
    });

    it('stamps the caller as owner and the calendar into their organization', async () => {
      const chain = queue('calendars', { data: calendar(), error: null });

      await service.create({ name: 'Mine' } as never, USER, ORG);

      const row = (chain.insert as jest.Mock).mock.calls[0][0];

      expect(row.owner_id).toBe(USER);
      expect(row.organization_id).toBe(ORG);
    });

    it('defaults a space calendar to space-wide and a personal one to private', async () => {
      const spaceChain = queue('calendars', { data: calendar(), error: null });

      await service.create({ name: 'A', space_id: SPACE } as never, USER, ORG);
      expect((spaceChain.insert as jest.Mock).mock.calls[0][0].visibility).toBe(
        'space',
      );

      const ownChain = queue('calendars', { data: calendar(), error: null });

      await service.create({ name: 'B' } as never, USER, ORG);
      expect((ownChain.insert as jest.Mock).mock.calls[0][0].visibility).toBe(
        'private',
      );
    });

    it('holds a share named at creation to the same rules as editing one', async () => {
      queue('calendars', { data: calendar(), error: null });
      queue('organization_members', {
        data: [{ user_id: OTHER_USER }],
        error: null,
      });

      await expect(
        service.create(
          {
            name: 'Mine',
            shares: [
              { target_type: 'user', target_id: OTHER_USER, level: 'view' },
            ],
          } as never,
          USER,
          ORG,
        ),
      ).resolves.toBeDefined();
    });

    it('refuses a share naming somebody outside the organization', async () => {
      queue('organization_members', { data: [], error: null });

      await expect(
        service.create(
          {
            name: 'Mine',
            shares: [
              { target_type: 'user', target_id: OTHER_USER, level: 'view' },
            ],
          } as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('changing who it is shared with', () => {
    function shareable(current: CalendarRow = calendar()) {
      queue('calendars', { data: current, error: null });
      withAccess('manage');
    }

    it('needs manage, not edit', async () => {
      queue('calendars', { data: calendar(), error: null });
      withAccess('edit');

      await expect(service.setShares(CAL, [], USER, ORG)).rejects.toThrow(
        ForbiddenException,
      );
    });

    /** A member (not the org owner) who holds only the sharing boxes named here. */
    function sharer(flags: { add?: boolean; manage?: boolean }) {
      (
        service as unknown as { access: { isOrgAdmin: jest.Mock } }
      ).access.isOrgAdmin.mockResolvedValue(false);

      const decision = decisionOf('edit');

      decision.permissions.tabs.sharing = true;
      decision.permissions.sharing = {
        view: false,
        add: flags.add === true,
        manage: flags.manage === true,
      };
      resolveDecision.mockResolvedValue(decision);
    }

    it('lets "Add people" add someone without the Manage level', async () => {
      queue('calendars', { data: calendar({ shares: [] }), error: null });
      sharer({ add: true });
      queue('organization_members', {
        data: [{ user_id: OTHER_USER }],
        error: null,
      });
      // the common answers lookup, then the spread lookup
      queue('calendars', { data: [], error: null });
      queue('calendars', { data: [], error: null });

      const write = queue('calendars', { data: calendar(), error: null });

      await service.setShares(
        CAL,
        [
          { target_type: 'user', target_id: OTHER_USER, level: 'view' },
        ] as never,
        USER,
        ORG,
      );

      expect(write.update).toHaveBeenCalled();
    });

    it('refuses "Add people" alone when a rule already there changes', async () => {
      queue('calendars', {
        data: calendar({
          shares: [
            { target_type: 'user', target_id: OTHER_USER, level: 'view' },
          ],
        }),
        error: null,
      });
      sharer({ add: true });

      await expect(
        service.setShares(
          CAL,
          [
            { target_type: 'user', target_id: OTHER_USER, level: 'edit' },
          ] as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(/change other people's access/);
    });

    it('refuses a member with no "Add people" when someone new is added', async () => {
      queue('calendars', { data: calendar({ shares: [] }), error: null });
      sharer({ manage: true });

      await expect(
        service.setShares(
          CAL,
          [
            { target_type: 'user', target_id: OTHER_USER, level: 'view' },
          ] as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(/change who this calendar is shared with/);
    });

    it('puts back the common boxes a member sends for someone they add', async () => {
      queue('calendars', { data: calendar({ shares: [] }), error: null });
      sharer({ add: true });
      queue('organization_members', {
        data: [{ user_id: OTHER_USER }],
        error: null,
      });
      // the common answers lookup finds nothing for this person, then the spread lookup
      queue('calendars', { data: [], error: null });
      queue('calendars', { data: [], error: null });

      const write = queue('calendars', { data: calendar(), error: null });

      await service.setShares(
        CAL,
        [
          {
            target_type: 'user',
            target_id: OTHER_USER,
            permissions: {
              events: { own: { read: true }, create: true },
              tabs: { calendar: true, integrations: true, sharing: true },
              sharing: { view: true, add: true, manage: true },
            },
          },
        ] as never,
        USER,
        ORG,
      );

      const [stored] = (write.update as jest.Mock).mock.calls[0][0].shares;

      expect(stored.permissions.events.create).toBe(true);
      expect(stored.permissions.tabs).toEqual({
        calendar: true,
        integrations: false,
        sharing: false,
        tickets: false,
      });
      // Both sharing boxes belong to this calendar; only "Manage permissions" is cleared
      expect(stored.permissions.sharing).toEqual({
        view: true,
        add: true,
        manage: false,
      });
    });

    it('refuses a member changing a rule, whatever box they hold', async () => {
      queue('calendars', {
        data: calendar({
          shares: [
            { target_type: 'user', target_id: OTHER_USER, level: 'view' },
          ],
        }),
        error: null,
      });
      sharer({ add: true, manage: true });

      await expect(
        service.setShares(CAL, [] as never, USER, ORG),
      ).rejects.toThrow(/change other people's access/);
    });

    it('refuses a save from someone holding neither sharing box', async () => {
      queue('calendars', { data: calendar({ shares: [] }), error: null });
      sharer({});

      await expect(service.setShares(CAL, [], USER, ORG)).rejects.toThrow(
        /change who this calendar is shared with/,
      );
    });

    it('replaces the whole list and records the change', async () => {
      shareable(
        calendar({ shares: [{ target_type: 'user', target_id: 'old' }] }),
      );
      queue('organization_members', {
        data: [{ user_id: OTHER_USER }],
        error: null,
      });
      queue('calendars', { data: calendar(), error: null });

      const shares = [
        { target_type: 'user', target_id: OTHER_USER, level: 'view' },
      ];

      await service.setShares(CAL, shares as never, USER, ORG);

      expect(sharesChanged).toHaveBeenCalledWith(
        ORG,
        USER,
        CAL,
        [{ target_type: 'user', target_id: 'old' }],
        [{ ...shares[0], granted_by: USER, granted_at: expect.any(String) }],
      );
    });

    it('clears the list when given an empty array', async () => {
      shareable(
        calendar({ shares: [{ target_type: 'user', target_id: 'old' }] }),
      );

      const write = queue('calendars', { data: calendar(), error: null });

      await service.setShares(CAL, [], USER, ORG);

      expect((write.update as jest.Mock).mock.calls[0][0].shares).toEqual([]);
    });

    it('refuses the same principal twice', async () => {
      shareable();

      await expect(
        service.setShares(
          CAL,
          [
            { target_type: 'user', target_id: OTHER_USER, level: 'view' },
            { target_type: 'user', target_id: OTHER_USER, level: 'manage' },
          ] as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(/already on the sharing list/);
    });

    it('refuses a space role on a calendar that belongs to no space', async () => {
      shareable(calendar({ space_id: null }));

      await expect(
        service.setShares(
          CAL,
          [
            { target_type: 'base_role', base_role: 'member', level: 'view' },
          ] as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(/belongs to a space/);
    });

    it('refuses sharing with a space other than its own', async () => {
      shareable(calendar({ space_id: SPACE }));

      await expect(
        service.setShares(
          CAL,
          [
            { target_type: 'space', target_id: OTHER_SPACE, level: 'view' },
          ] as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(/its own space/);
    });

    it('accepts sharing with its own space', async () => {
      shareable(calendar({ space_id: SPACE }));
      queue('calendars', { data: calendar(), error: null });

      await expect(
        service.setShares(
          CAL,
          [{ target_type: 'space', target_id: SPACE, level: 'view' }] as never,
          USER,
          ORG,
        ),
      ).resolves.toBeDefined();
    });

    it('refuses a person who is not in this organization', async () => {
      shareable();
      queue('organization_members', { data: [], error: null });

      await expect(
        service.setShares(
          CAL,
          [
            { target_type: 'user', target_id: OTHER_USER, level: 'view' },
          ] as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('stores a rule carrying the full matrix as it was given', async () => {
      shareable();
      queue('organization_members', {
        data: [{ user_id: OTHER_USER }],
        error: null,
      });

      const write = queue('calendars', { data: calendar(), error: null });

      const shares = [
        {
          target_type: 'user',
          target_id: OTHER_USER,
          level: 'view',
          permissions: {
            events: { own: { read: true } },
            task_events: { read: true },
          },
        },
      ];

      await service.setShares(CAL, shares as never, USER, ORG);

      expect((write.update as jest.Mock).mock.calls[0][0].shares).toEqual([
        { ...shares[0], granted_by: USER, granted_at: expect.any(String) },
      ]);
    });

    it('keeps the earlier stamp on a rule that did not change', async () => {
      const kept = {
        target_type: 'user',
        target_id: OTHER_USER,
        level: 'view',
        granted_by: 'granter-1',
        granted_at: '2026-10-01T10:00:00.000Z',
      };

      shareable(calendar({ shares: [kept] }));
      queue('organization_members', {
        data: [{ user_id: OTHER_USER }],
        error: null,
      });

      const write = queue('calendars', { data: calendar(), error: null });

      await service.setShares(
        CAL,
        [
          { target_type: 'user', target_id: OTHER_USER, level: 'view' },
        ] as never,
        USER,
        ORG,
      );

      expect((write.update as jest.Mock).mock.calls[0][0].shares).toEqual([
        kept,
      ]);
    });

    it('stamps the caller on a changed rule and ignores a stamp the client sent', async () => {
      shareable(
        calendar({
          shares: [
            {
              target_type: 'user',
              target_id: OTHER_USER,
              level: 'view',
              granted_by: 'granter-1',
              granted_at: '2026-10-01T10:00:00.000Z',
            },
          ],
        }),
      );
      queue('organization_members', {
        data: [{ user_id: OTHER_USER }],
        error: null,
      });

      const write = queue('calendars', { data: calendar(), error: null });

      await service.setShares(
        CAL,
        [
          {
            target_type: 'user',
            target_id: OTHER_USER,
            level: 'edit',
            granted_by: 'forged',
            granted_at: '2000-01-01T00:00:00.000Z',
          },
        ] as never,
        USER,
        ORG,
      );

      const [stored] = (write.update as jest.Mock).mock.calls[0][0].shares;

      expect(stored.granted_by).toBe(USER);
      expect(stored.granted_at).not.toBe('2000-01-01T00:00:00.000Z');
    });

    describe('module answers follow the person across calendars', () => {
      const OTHER_CAL = 'cal-2';
      const LOCKED_CAL = 'cal-3';
      const perCalendar = { events: { own: { read: true } } };

      function rule(tabs: Record<string, boolean>, extra = {}) {
        return {
          target_type: 'user',
          target_id: OTHER_USER,
          level: 'view',
          permissions: { ...perCalendar, ...extra, tabs },
        };
      }

      /** The share list a queued update was given, typed so the checks stay checked. */
      function sharesWritten(chain: Record<string, unknown>): CalendarShare[] {
        const update = chain.update as jest.Mock<
          unknown,
          [{ shares: CalendarShare[] }]
        >;

        return update.mock.calls[0][0].shares;
      }

      function member() {
        queue('organization_members', {
          data: [{ user_id: OTHER_USER }],
          error: null,
        });
      }

      function othersAre(rows: CalendarRow[], manage: string[]) {
        queue('calendars', { data: rows, error: null });
        resolveManyDecisions.mockResolvedValue(
          new Map(
            rows.map((row) => [
              row.id,
              decisionOf(manage.includes(row.id) ? 'manage' : 'view'),
            ]),
          ),
        );
      }

      it('copies a changed tab onto the same person elsewhere, keeping that calendar’s own flags', async () => {
        shareable(calendar({ shares: [rule({ integrations: true })] }));
        member();

        const elsewhere = {
          ...rule({ integrations: true }),
          permissions: {
            events: { create: true },
            tabs: { integrations: true },
          },
        };

        othersAre(
          [calendar({ id: OTHER_CAL, shares: [elsewhere] })],
          [OTHER_CAL],
        );
        queue('calendars', { data: calendar(), error: null });

        const spread = queue('calendars', { data: calendar(), error: null });

        await service.setShares(
          CAL,
          [rule({ integrations: false })] as never,
          USER,
          ORG,
        );

        expect(sharesWritten(spread)[0].permissions).toEqual({
          events: { create: true },
          tabs: { integrations: false },
        });
        expect(sharesChanged).toHaveBeenCalledTimes(2);
      });

      it('leaves a calendar the caller cannot manage alone', async () => {
        shareable(calendar({ shares: [rule({ integrations: true })] }));
        member();
        othersAre(
          [
            calendar({
              id: LOCKED_CAL,
              shares: [rule({ integrations: true })],
            }),
          ],
          [],
        );
        queue('calendars', { data: calendar(), error: null });

        await service.setShares(
          CAL,
          [rule({ integrations: false })] as never,
          USER,
          ORG,
        );

        // Nothing left queued was used, so no second write happened.
        expect(sharesChanged).toHaveBeenCalledTimes(1);
      });

      it('never adds the person to a calendar they were not on', async () => {
        shareable(calendar({ shares: [rule({ integrations: true })] }));
        member();
        othersAre([calendar({ id: OTHER_CAL, shares: [] })], [OTHER_CAL]);
        queue('calendars', { data: calendar(), error: null });

        await service.setShares(
          CAL,
          [rule({ integrations: false })] as never,
          USER,
          ORG,
        );

        expect(sharesChanged).toHaveBeenCalledTimes(1);
      });

      it('upgrades a level-only rule elsewhere without losing what that level allowed', async () => {
        shareable(calendar({ shares: [rule({ settings: true })] }));
        member();
        othersAre(
          [
            calendar({
              id: OTHER_CAL,
              shares: [
                { target_type: 'user', target_id: OTHER_USER, level: 'edit' },
              ],
            }),
          ],
          [OTHER_CAL],
        );
        queue('calendars', { data: calendar(), error: null });

        const spread = queue('calendars', { data: calendar(), error: null });

        await service.setShares(
          CAL,
          [rule({ sharing: false })] as never,
          USER,
          ORG,
        );

        const permissions = sharesWritten(spread)[0].permissions;

        expect(permissions?.tabs).toEqual({ sharing: false });
        expect(permissions?.events?.create).toBe(true);

        // Changing and deleting the calendar stay with that calendar, so its level answer is kept.
        expect(permissions?.calendar).toEqual({ edit: true, delete: false });
      });

      it('gives a newly added person the module answers they already hold', async () => {
        shareable(calendar({ shares: [] }));
        member();
        othersAre(
          [
            calendar({
              id: OTHER_CAL,
              shares: [rule({ sharing: false }, { sharing: { view: true } })],
            }),
          ],
          [OTHER_CAL],
        );

        const write = queue('calendars', { data: calendar(), error: null });

        await service.setShares(
          CAL,
          [rule({ sharing: true })] as never,
          USER,
          ORG,
        );

        const stored = sharesWritten(write)[0].permissions;

        expect(stored?.tabs).toEqual({ sharing: false });
        // The sharing boxes are per calendar now, so a new rule keeps its own instead of adopting them
        // expect(stored?.sharing).toEqual({ view: true });
        expect(stored?.sharing).toBeUndefined();
        expect(stored?.events).toEqual(perCalendar.events);
      });

      it('keeps delete, change and manage with their own calendar', async () => {
        const before = {
          calendar: { edit: false, delete: false },
          manage: false,
        };
        const after = { calendar: { edit: true, delete: true }, manage: true };

        shareable(calendar({ shares: [rule({ calendar: true }, before)] }));
        member();
        othersAre(
          [
            calendar({
              id: OTHER_CAL,
              shares: [rule({ calendar: true }, before)],
            }),
          ],
          [OTHER_CAL],
        );
        queue('calendars', { data: calendar(), error: null });

        const spread = queue('calendars', { data: calendar(), error: null });

        await service.setShares(
          CAL,
          [rule({ calendar: true }, after)] as never,
          USER,
          ORG,
        );

        // Only per-calendar answers changed, so no other calendar is written.
        expect(spread.update).not.toHaveBeenCalled();
      });

      it('copies adding and removing ticket dates, but not viewing them', async () => {
        shareable(
          calendar({
            shares: [rule({ calendar: true }, { task_events: { read: true } })],
          }),
        );
        member();
        othersAre(
          [
            calendar({
              id: OTHER_CAL,
              shares: [
                rule({ calendar: true }, { task_events: { read: false } }),
              ],
            }),
          ],
          [OTHER_CAL],
        );
        queue('calendars', { data: calendar(), error: null });

        const spread = queue('calendars', { data: calendar(), error: null });

        await service.setShares(
          CAL,
          [
            rule(
              { calendar: true },
              { task_events: { read: true, update: true, delete: true } },
            ),
          ] as never,
          USER,
          ORG,
        );

        expect(sharesWritten(spread)[0].permissions?.task_events).toEqual({
          read: false,
          update: true,
          delete: true,
        });
      });

      it('writes nowhere else when the module answers did not change', async () => {
        shareable(calendar({ shares: [rule({ integrations: true })] }));
        member();
        othersAre(
          [
            calendar({
              id: OTHER_CAL,
              shares: [rule({ integrations: false })],
            }),
          ],
          [OTHER_CAL],
        );
        queue('calendars', { data: calendar(), error: null });

        await service.setShares(
          CAL,
          [rule({ integrations: true })] as never,
          USER,
          ORG,
        );

        expect(sharesChanged).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('changing a calendar', () => {
    it('needs edit and the change-calendar flag to rename it', async () => {
      queue('calendars', { data: calendar(), error: null });
      withAccess('edit', { edit: true });

      const write = queue('calendars', { data: calendar(), error: null });

      await service.update(CAL, { name: 'Renamed' } as never, USER, ORG);

      expect((write.update as jest.Mock).mock.calls[0][0].name).toBe('Renamed');
    });

    it('refuses a rename to an editor without the change-calendar flag', async () => {
      queue('calendars', { data: calendar(), error: null });
      withAccess('edit');

      await expect(
        service.update(CAL, { name: 'Renamed' } as never, USER, ORG),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses a rename to somebody who may only look', async () => {
      queue('calendars', { data: calendar(), error: null });
      withAccess('view');

      await expect(
        service.update(CAL, { name: 'Renamed' } as never, USER, ORG),
      ).rejects.toThrow(ForbiddenException);
    });

    it('needs manage to change who can see it', async () => {
      queue('calendars', {
        data: calendar({ visibility: 'private' }),
        error: null,
      });
      withAccess('edit');

      await expect(
        service.update(CAL, { visibility: 'organization' } as never, USER, ORG),
      ).rejects.toThrow(ForbiddenException);
    });

    it('does not ask for manage when the visibility is unchanged', async () => {
      queue('calendars', {
        data: calendar({ visibility: 'private' }),
        error: null,
      });
      withAccess('edit', { edit: true });
      queue('calendars', { data: calendar(), error: null });

      await expect(
        service.update(CAL, { visibility: 'private' } as never, USER, ORG),
      ).resolves.toBeDefined();
    });

    it('records who made the change', async () => {
      queue('calendars', { data: calendar(), error: null });
      withAccess('manage');

      const write = queue('calendars', { data: calendar(), error: null });

      await service.update(CAL, { name: 'X' } as never, USER, ORG);

      expect((write.update as jest.Mock).mock.calls[0][0].updated_by).toBe(
        USER,
      );
    });
  });

  describe('moving a calendar between spaces', () => {
    it('needs manage, and the right to create one where it lands', async () => {
      queue('calendars', { data: calendar({ space_id: null }), error: null });
      withAccess('manage');
      queue('custom_fields', { data: [], error: null });
      queue('calendars', { data: calendar(), error: null });

      await service.update(CAL, { space_id: SPACE } as never, USER, ORG);

      expect(assertCanCreateInSpace).toHaveBeenCalledWith(USER, ORG, SPACE);
    });

    it('refuses the move to somebody who may only edit it', async () => {
      queue('calendars', { data: calendar({ space_id: null }), error: null });
      withAccess('edit');

      await expect(
        service.update(CAL, { space_id: SPACE } as never, USER, ORG),
      ).rejects.toThrow(ForbiddenException);
    });

    it('asks nothing of a space when it moves out to become personal', async () => {
      queue('calendars', { data: calendar({ space_id: SPACE }), error: null });
      withAccess('manage');
      queue('custom_fields', { data: [], error: null });
      queue('calendars', { data: calendar(), error: null });

      await service.update(CAL, { space_id: null } as never, USER, ORG);

      expect(assertCanCreateInSpace).not.toHaveBeenCalled();
    });

    it('drops an organization-wide calendar to private when it moves into a space', async () => {
      // Otherwise the move would quietly show it to people it was never meant to include.
      queue('calendars', {
        data: calendar({ space_id: null, visibility: 'organization' }),
        error: null,
      });
      withAccess('manage');
      queue('custom_fields', { data: [], error: null });

      const write = queue('calendars', { data: calendar(), error: null });

      await service.update(CAL, { space_id: SPACE } as never, USER, ORG);

      expect((write.update as jest.Mock).mock.calls[0][0].visibility).toBe(
        'private',
      );
    });

    it('drops a space-wide calendar to private when it becomes personal', async () => {
      queue('calendars', {
        data: calendar({ space_id: SPACE, visibility: 'space' }),
        error: null,
      });
      withAccess('manage');
      queue('custom_fields', { data: [], error: null });

      const write = queue('calendars', { data: calendar(), error: null });

      await service.update(CAL, { space_id: null } as never, USER, ORG);

      expect((write.update as jest.Mock).mock.calls[0][0].visibility).toBe(
        'private',
      );
    });

    it('does not touch the visibility when it still fits', async () => {
      queue('calendars', {
        data: calendar({ space_id: SPACE, visibility: 'private' }),
        error: null,
      });
      withAccess('manage');
      queue('custom_fields', { data: [], error: null });

      const write = queue('calendars', { data: calendar(), error: null });

      await service.update(CAL, { space_id: OTHER_SPACE } as never, USER, ORG);

      expect(
        (write.update as jest.Mock).mock.calls[0][0].visibility,
      ).toBeUndefined();
    });
  });

  describe('deleting a calendar', () => {
    it('needs the delete-calendar flag', async () => {
      queue('calendars', { data: calendar(), error: null });
      withAccess('edit');

      await expect(service.remove(CAL, USER, ORG)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('lets an editor holding the delete-calendar flag remove it', async () => {
      queue('calendars', { data: calendar(), error: null });
      withAccess('edit', { delete: true });
      queue('calendars', { data: null, error: null });

      await expect(service.remove(CAL, USER, ORG)).resolves.toEqual({
        success: true,
      });
    });

    it('scopes the delete to this organization as well as the id', async () => {
      queue('calendars', { data: calendar(), error: null });
      withAccess('manage');

      const chain = queue('calendars', { data: null, error: null });

      await expect(service.remove(CAL, USER, ORG)).resolves.toEqual({
        success: true,
      });
      expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
    });

    it('turns a database refusal into a bad request', async () => {
      queue('calendars', { data: calendar(), error: null });
      withAccess('manage');
      queue('calendars', {
        data: null,
        error: { message: 'still referenced' },
      });

      await expect(service.remove(CAL, USER, ORG)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('ticket sources', () => {
    it('needs the ticket-dates permission, not managing the calendar', async () => {
      queue('calendars', { data: calendar({ feeds: [] }), error: null });

      const decision = decisionOf('edit');

      decision.permissions.task_events.update = false;
      resolveDecision.mockResolvedValue(decision);

      await expect(
        service.setFeeds(
          CAL,
          [{ space_id: SPACE, date_field: 'due_date' }] as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('asks for the remove permission when the list gets shorter', async () => {
      queue('calendars', {
        data: calendar({
          feeds: [{ space_id: SPACE }, { space_id: OTHER_SPACE }],
        }),
        error: null,
      });

      const decision = decisionOf('edit');

      decision.permissions.task_events.update = true;
      decision.permissions.task_events.delete = false;
      resolveDecision.mockResolvedValue(decision);

      await expect(service.setFeeds(CAL, [], USER, ORG)).rejects.toThrow(
        /remove ticket dates/,
      );
    });

    it('stamps linked_at on a new source and keeps it on an existing one', async () => {
      queue('calendars', {
        data: calendar({
          feeds: [
            {
              id: 'f-old',
              space_id: SPACE,
              date_field: 'due_date',
              linked_at: '2026-10-01T10:00:00.000Z',
            },
          ],
        }),
        error: null,
      });

      const decision = decisionOf('edit');

      decision.permissions.task_events.update = true;
      decision.permissions.tickets.link = true;
      decision.permissions.task_events.form = true;
      resolveDecision.mockResolvedValue(decision);

      const write = queue('calendars', { data: calendar(), error: null });

      await service.setFeeds(
        CAL,
        [
          {
            id: 'f-old',
            space_id: SPACE,
            date_field: 'start_date',
            linked_at: '2000-01-01T00:00:00.000Z',
          },
          { space_id: OTHER_SPACE, date_field: 'due_date' },
        ] as never,
        USER,
        ORG,
      );

      const stored = (write.update as jest.Mock).mock.calls[0][0].feeds;

      expect(stored[0].linked_at).toBe('2026-10-01T10:00:00.000Z');
      expect(stored[1].linked_at).not.toBe('2000-01-01T00:00:00.000Z');
      expect(typeof stored[1].linked_at).toBe('string');
    });

    it('keeps left-out tickets on a whole-space source only', async () => {
      queue('calendars', {
        data: calendar({
          feeds: [{ id: 'f-space', space_id: SPACE, date_field: 'due_date' }],
        }),
        error: null,
      });

      const decision = decisionOf('edit');

      decision.permissions.task_events.update = true;
      decision.permissions.task_events.delete = true;
      decision.permissions.tickets.delete = true;
      resolveDecision.mockResolvedValue(decision);

      const write = queue('calendars', { data: calendar(), error: null });

      await service.setFeeds(
        CAL,
        [
          {
            id: 'f-space',
            space_id: SPACE,
            date_field: 'due_date',
            excluded_task_ids: ['t-1', 't-1'],
          },
          {
            space_id: OTHER_SPACE,
            task_id: 't-9',
            date_field: 'due_date',
            excluded_task_ids: ['t-2'],
          },
        ] as never,
        USER,
        ORG,
      );

      const stored = (write.update as jest.Mock).mock.calls[0][0].feeds;

      expect(stored[0].excluded_task_ids).toEqual(['t-1']);
      expect(stored[1].excluded_task_ids).toEqual([]);
    });

    it('asks for the remove permission when a ticket is left out of a space', async () => {
      queue('calendars', {
        data: calendar({
          feeds: [{ id: 'f-space', space_id: SPACE, date_field: 'due_date' }],
        }),
        error: null,
      });

      const decision = decisionOf('edit');

      decision.permissions.task_events.update = true;
      decision.permissions.task_events.delete = false;
      resolveDecision.mockResolvedValue(decision);

      await expect(
        service.setFeeds(
          CAL,
          [
            {
              id: 'f-space',
              space_id: SPACE,
              date_field: 'due_date',
              excluded_task_ids: ['t-1'],
            },
          ] as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(/remove ticket dates/);
    });

    it('refuses the same ticket twice on one calendar', async () => {
      queue('calendars', { data: calendar({ feeds: [] }), error: null });

      const decision = decisionOf('edit');

      decision.permissions.task_events.update = true;
      decision.permissions.tickets.link = true;
      decision.permissions.task_events.form = true;
      resolveDecision.mockResolvedValue(decision);

      await expect(
        service.setFeeds(
          CAL,
          [
            { space_id: SPACE, task_id: 't-1', date_field: 'due_date' },
            { space_id: SPACE, task_id: 't-1', date_field: 'start_date' },
          ] as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(/already linked/);
    });

    it('refuses a single ticket inside a space linked whole, unless it is left out there', async () => {
      const decision = decisionOf('edit');

      decision.permissions.task_events.update = true;
      decision.permissions.tickets.link = true;
      decision.permissions.task_events.form = true;
      resolveDecision.mockResolvedValue(decision);

      queue('calendars', { data: calendar({ feeds: [] }), error: null });

      await expect(
        service.setFeeds(
          CAL,
          [
            { space_id: SPACE, date_field: 'due_date' },
            { space_id: SPACE, task_id: 't-1', date_field: 'due_date' },
          ] as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(/already linked/);

      queue('calendars', { data: calendar({ feeds: [] }), error: null });
      queue('calendars', { data: calendar(), error: null });

      await expect(
        service.setFeeds(
          CAL,
          [
            {
              space_id: SPACE,
              date_field: 'due_date',
              excluded_task_ids: ['t-1'],
            },
            { space_id: SPACE, task_id: 't-1', date_field: 'due_date' },
          ] as never,
          USER,
          ORG,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('tickets offered and listed for linking', () => {
    it('offers unlinked tickets only to someone who may put ticket dates on the calendar', async () => {
      queue('calendars', { data: calendar({ feeds: [] }), error: null });

      const decision = decisionOf('edit');

      decision.permissions.task_events.update = false;
      resolveDecision.mockResolvedValue(decision);

      await expect(
        service.listLinkableTickets(CAL, USER, ORG, { space_ids: SPACE }),
      ).rejects.toThrow(/put ticket dates/);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('asks the database for one page of unlinked tickets of the readable spaces, in this org', async () => {
      queue('calendars', { data: calendar({ feeds: [] }), error: null });

      const decision = decisionOf('edit');

      decision.permissions.task_events.update = true;
      decision.permissions.tickets.form = true;
      decision.permissions.task_events.form = true;
      resolveDecision.mockResolvedValue(decision);
      mockRpc.mockResolvedValue({
        data: [{ task_id: 't-1', space_id: SPACE, total: 51 }],
        error: null,
      });

      const res = await service.listLinkableTickets(CAL, USER, ORG, {
        space_ids: SPACE,
        page: 2,
        pageSize: 50,
      });

      expect(mockRpc).toHaveBeenCalledWith('calendar_linkable_ticket_ids', {
        p_org: ORG,
        p_calendar: CAL,
        p_space_ids: [SPACE],
        p_search: null,
        p_offset: 50,
        p_limit: 50,
      });
      expect(res).toEqual({
        items: [{ task_id: 't-1', space_id: SPACE }],
        page: 2,
        hasMore: false,
        total: 51,
      });
    });

    it('lists linked tickets of readable spaces only, and keeps links to deleted tickets removable', async () => {
      queue('calendars', {
        data: calendar({
          feeds: [
            { id: 'f-space', space_id: SPACE, date_field: 'due_date' },
            { id: 'f-other', space_id: OTHER_SPACE, date_field: 'due_date' },
            {
              id: 'f-gone',
              space_id: SPACE,
              task_id: 't-gone',
              date_field: 'due_date',
            },
          ],
        }),
        error: null,
      });
      resolveDecision.mockResolvedValue(decisionOf('view'));
      queue('tasks', { data: [], error: null });
      canReadSpaceTickets.mockImplementation(
        (_user: string, _org: string, spaceId: string) =>
          Promise.resolve(spaceId === SPACE),
      );

      const res = await service.listTicketLinks(CAL, USER, ORG, {});

      expect(mockRpc).toHaveBeenCalledWith(
        'calendar_linked_ticket_ids',
        expect.objectContaining({
          p_org: ORG,
          p_calendar: CAL,
          p_space_ids: [SPACE],
        }),
      );
      expect(res.unavailable).toEqual([
        { feed_id: 'f-gone', task_id: 't-gone' },
      ]);
      expect(res.total).toBe(0);
    });
  });

  describe('the fields an entry may carry', () => {
    it('needs manage to change them', async () => {
      queue('calendars', { data: calendar(), error: null });
      withAccess('edit');

      await expect(
        service.setFieldSettings(CAL, [], USER, ORG),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses a field that cannot be used where the calendar lives', async () => {
      queue('calendars', { data: calendar({ space_id: SPACE }), error: null });
      withAccess('manage');
      queue('custom_fields', { data: [], error: null });

      await expect(
        service.setFieldSettings(
          CAL,
          [{ field_id: 'field-1' }] as never,
          USER,
          ORG,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('stores the ones that can', async () => {
      queue('calendars', { data: calendar(), error: null });
      withAccess('manage');
      queue('custom_fields', { data: [{ id: 'field-1' }], error: null });

      const write = queue('calendars', { data: calendar(), error: null });

      await service.setFieldSettings(
        CAL,
        [{ field_id: 'field-1', required: true }] as never,
        USER,
        ORG,
      );

      expect(
        (write.update as jest.Mock).mock.calls[0][0].field_settings,
      ).toEqual([{ field_id: 'field-1', required: true }]);
    });
  });

  describe('the leaver-cleanup routes', () => {
    it('lists nothing to somebody who is not an organization admin', async () => {
      const access = (
        service as unknown as { access: { isOrgAdmin: jest.Mock } }
      ).access;

      access.isOrgAdmin.mockResolvedValue(false);

      await expect(service.listOwnerless(ORG, USER)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('keeps a calendar whose owner has left, and one with no owner at all', async () => {
      queue('calendars', {
        data: [
          { id: 'a', name: 'Left behind', owner_id: 'gone', space_id: null },
          { id: 'b', name: 'Still here', owner_id: USER, space_id: null },
          { id: 'c', name: 'Never owned', owner_id: null, space_id: null },
        ],
        error: null,
      });
      queue('organization_members', { data: [{ user_id: USER }], error: null });

      const result = await service.listOwnerless(ORG, USER);

      expect(result.map((row) => row.id)).toEqual(['a', 'c']);
    });

    it('asks about no members when nothing has an owner', async () => {
      queue('calendars', {
        data: [
          { id: 'c', name: 'Never owned', owner_id: null, space_id: null },
        ],
        error: null,
      });

      const result = await service.listOwnerless(ORG, USER);

      expect(result).toHaveLength(1);
      expect(mockFrom).not.toHaveBeenCalledWith('organization_members');
    });

    it('hands back only the three fields the screen needs', async () => {
      queue('calendars', {
        data: [{ id: 'a', name: 'X', owner_id: null, space_id: SPACE }],
        error: null,
      });

      const [row] = await service.listOwnerless(ORG, USER);

      expect(Object.keys(row).sort()).toEqual(['id', 'name', 'owner_id']);
    });

    it('needs an organization admin to delete one', async () => {
      const access = (
        service as unknown as { access: { isOrgAdmin: jest.Mock } }
      ).access;

      access.isOrgAdmin.mockResolvedValue(false);

      await expect(service.removeOwnerless(CAL, ORG, USER)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses to delete a calendar that still has an owner', async () => {
      // Otherwise the cleanup route would be a way around the ordinary delete gate.
      queue('calendars', {
        data: [{ id: CAL, name: 'Owned', owner_id: USER, space_id: null }],
        error: null,
      });
      queue('organization_members', { data: [{ user_id: USER }], error: null });

      await expect(service.removeOwnerless(CAL, ORG, USER)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('deletes one whose owner has gone', async () => {
      queue('calendars', {
        data: [
          { id: CAL, name: 'Left behind', owner_id: 'gone', space_id: null },
        ],
        error: null,
      });
      queue('organization_members', { data: [], error: null });

      const chain = queue('calendars', { data: null, error: null });

      await expect(service.removeOwnerless(CAL, ORG, USER)).resolves.toEqual({
        success: true,
      });
      expect(chain.eq).toHaveBeenCalledWith('organization_id', ORG);
    });
  });
});
