/**
 * @fileoverview Who may do what with a calendar — the gate every calendar endpoint goes through.
 *
 * The order inside `decide()` is the security contract: the tenant, then the space and its state,
 * then membership, then who runs the space, then the organization, then ownership, then the share
 * list, and only then the calendar's own visibility. Each step is checked here, including the ones
 * that must refuse BEFORE a later step could have granted.
 */
import { ForbiddenException } from '@nestjs/common';
import type { CalendarRow } from './calendar-access.service';
import { CalendarAccessService } from './calendar-access.service';
import { CalendarPrincipalsService } from './calendar-principals.service';
import type { ISpaceBaseGrant } from '../permissions/models/space-permissions.model';
import { SPACE_ROLE_BASE_PERMISSIONS } from '../permissions/models/space-permissions.model';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('CalendarAccessService', () => {
  let service: CalendarAccessService;
  let mockFrom: jest.Mock;
  let resolveSpaceBaseGrant: jest.Mock;
  let resolvePrincipals: jest.Mock;
  let queued: Map<string, Record<string, unknown>[]>;

  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';
  const USER = 'user-1';
  const OTHER_USER = 'user-2';
  const SPACE = 'space-1';
  const OTHER_SPACE = 'space-2';

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
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

  /** Queues one response per expected `from(table)` call, so an unexpected extra query fails loudly. */
  function queue(table: string, resolved: { data: unknown; error: unknown }) {
    const chain = buildChain(resolved);
    const list = queued.get(table) ?? [];

    list.push(chain);
    queued.set(table, list);

    return chain;
  }

  function spaceRow(overrides: Record<string, unknown> = {}) {
    return {
      id: SPACE,
      organization_id: ORG,
      is_active: true,
      is_archived: false,
      deleting_at: null,
      ...overrides,
    };
  }

  /**
   * A resolved space grant, with the base permissions the role really carries.
   *
   * Taken from the shipped presets rather than written out here, so a calendar test cannot pass
   * against a permission set no role actually has.
   */
  function grant(overrides: Partial<ISpaceBaseGrant> = {}): ISpaceBaseGrant {
    const spaceRole =
      overrides.spaceRole === undefined ? 'member' : overrides.spaceRole;

    return {
      isAdmin: false,
      isMember: true,
      spaceRole,
      explicit: {},
      basePermissions: SPACE_ROLE_BASE_PERMISSIONS[spaceRole ?? ''] ?? {},
      ...overrides,
    };
  }

  function calendar(overrides: Record<string, unknown> = {}): CalendarRow {
    return {
      id: 'cal-1',
      organization_id: ORG,
      space_id: null,
      owner_id: OTHER_USER,
      visibility: 'private',
      shares: [],
      ...overrides,
    } as CalendarRow;
  }

  /** The caller's standing in the organization; every decision reads it once. */
  function principals(overrides: Record<string, unknown> = {}) {
    resolvePrincipals.mockResolvedValue({
      userId: USER,
      isOrgAdmin: false,
      isOrgMember: true,
      ...overrides,
    });
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

    resolveSpaceBaseGrant = jest.fn();
    resolvePrincipals = jest.fn();

    // The common-box lookup reads calendars on every decision; unless a case queues rules, nobody is named
    const noRules = {
      select: () => noRules,
      eq: () => noRules,
      order: () => Promise.resolve({ data: [], error: null }),
    };
    const supa = {
      // getClient: () => ({ from: mockFrom }),
      getClient: () => ({
        from: (table: string) =>
          table === 'calendars' && !queued.get('calendars')?.length
            ? noRules
            : mockFrom(table),
      }),
    } as unknown as SupabaseAdminService;

    const permissions = {
      resolveSpaceBaseGrant,
    } as unknown as PermissionsService;

    const principalsService = {
      resolve: resolvePrincipals,
    } as unknown as CalendarPrincipalsService;

    service = new CalendarAccessService(supa, permissions, principalsService);
    principals();
  });

  describe('a calendar outside any space', () => {
    it('gives its owner everything', async () => {
      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({ owner_id: USER }),
      );

      expect(decision.access).toBe('manage');
      expect(decision.source).toBe('owner');
      expect(decision.permissions.manage).toBe(true);
    });

    it('keeps the common boxes an admin set, even on a calendar the person owns', async () => {
      const rules = {
        select: () => rules,
        eq: () => rules,
        order: () =>
          Promise.resolve({
            data: [
              {
                shares: [
                  {
                    target_type: 'user',
                    target_id: USER,
                    permissions: {
                      tabs: {
                        calendar: true,
                        integrations: false,
                        sharing: false,
                      },
                      integrations: { view: false },
                      sharing: { view: false },
                    },
                  },
                ],
              },
            ],
            error: null,
          }),
      };

      queued.set('calendars', [rules]);

      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({ owner_id: USER }),
      );

      expect(decision.access).toBe('manage');
      expect(decision.permissions.manage).toBe(true);
      expect(decision.permissions.events.create).toBe(true);
      expect(decision.permissions.tabs.sharing).toBe(false);
      expect(decision.permissions.tabs.integrations).toBe(false);
      expect(decision.permissions.integrations.view).toBe(false);
      // "See who else has access" is answered per calendar now; the owner holds it on their own calendar
      // expect(decision.permissions.sharing.view).toBe(false);
      expect(decision.permissions.sharing.view).toBe(true);
    });

    it('gives a member nobody configured full rights on their own calendar but no common boxes beyond the Calendar tab', async () => {
      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({ owner_id: USER }),
      );

      expect(decision.permissions.manage).toBe(true);
      expect(decision.permissions.events.create).toBe(true);
      expect(decision.permissions.calendar.delete).toBe(true);
      expect(decision.permissions.tabs.calendar).toBe(true);
      expect(decision.permissions.tabs.sharing).toBe(false);
      expect(decision.permissions.tabs.integrations).toBe(false);
      expect(decision.permissions.integrations.view).toBe(false);
      expect(decision.permissions.sharing.view).toBe(false);
      expect(decision.permissions.sharing.add).toBe(false);
      expect(decision.permissions.sharing.manage).toBe(false);
    });

    it('follows a rule the org owner set for the owner on their own calendar', async () => {
      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({
          owner_id: USER,
          shares: [
            {
              target_type: 'user',
              target_id: USER,
              permissions: {
                events: {
                  own: { read: true },
                  others: { read: true },
                  create: true,
                },
                calendar: { edit: true, delete: false },
                manage: true,
              },
            },
          ],
        }),
      );

      expect(decision.source).toBe('owner');
      expect(decision.permissions.events.create).toBe(true);
      expect(decision.permissions.calendar.edit).toBe(true);
      expect(decision.permissions.calendar.delete).toBe(false);
    });

    it('leaves the organization owner uncapped whatever a rule says', async () => {
      principals({ isOrgAdmin: true, isOrgOwner: true });

      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({ owner_id: USER }),
      );

      expect(decision.permissions.tabs.sharing).toBe(true);
      expect(decision.permissions.integrations.view).toBe(true);
    });

    it('caps an organization admin by the common boxes, like anyone else', async () => {
      principals({ isOrgAdmin: true });

      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({ owner_id: USER }),
      );

      // Nobody configured them, so the Calendar tab alone
      expect(decision.permissions.tabs.calendar).toBe(true);
      expect(decision.permissions.tabs.sharing).toBe(false);
      expect(decision.permissions.integrations.view).toBe(false);
    });

    it('refuses a private one to everybody else', async () => {
      const decision = await service.resolveDecision(USER, ORG, calendar());

      expect(decision.access).toBe('none');
      expect(decision.source).toBe('none');
    });

    it('does not open an organization-wide calendar to someone no rule names', async () => {
      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({ visibility: 'organization' }),
      );

      // Visibility grants nothing any more; only the share list does
      expect(decision.access).toBe('none');
      expect(decision.source).toBe('none');
    });

    it('refuses a calendar belonging to another tenant, whoever asks', async () => {
      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({ organization_id: OTHER_ORG, owner_id: USER }),
      );

      expect(decision.access).toBe('none');
    });

    it('gives the organization owner everything, and an admin nothing without a share', async () => {
      principals({ isOrgAdmin: true, isOrgOwner: true });

      const decision = await service.resolveDecision(USER, ORG, calendar());

      expect(decision.access).toBe('manage');
      expect(decision.source).toBe('org_admin');

      principals({ isOrgAdmin: true });

      const admin = await service.resolveDecision(USER, ORG, calendar());

      expect(admin.access).toBe('none');
    });

    it('stops granting to someone who has left the organization', async () => {
      // Their users row survives, so the share would still match on id alone.
      principals({ isOrgMember: false });

      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({
          shares: [{ target_type: 'user', target_id: USER, level: 'manage' }],
        }),
      );

      expect(decision.access).toBe('none');
    });
  });

  describe('a calendar inside a space', () => {
    function withSpace(
      spaceOverrides: Record<string, unknown> = {},
      grantValue: ISpaceBaseGrant | null = grant(),
    ) {
      queue('spaces', { data: [spaceRow(spaceOverrides)], error: null });
      resolveSpaceBaseGrant.mockResolvedValue(grantValue);
    }

    it('refuses someone who is not a member, even when a share names them', async () => {
      // Membership is checked before the share list on purpose: leaving a space removes access.
      withSpace({}, grant({ isMember: false, spaceRole: null }));

      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({
          space_id: SPACE,
          shares: [{ target_type: 'user', target_id: USER, level: 'manage' }],
        }),
      );

      expect(decision.access).toBe('none');
    });

    it('refuses when the space belongs to another tenant, without asking for a grant', async () => {
      queue('spaces', {
        data: [spaceRow({ organization_id: OTHER_ORG })],
        error: null,
      });

      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({ space_id: SPACE, owner_id: USER }),
      );

      expect(decision.access).toBe('none');
      expect(resolveSpaceBaseGrant).not.toHaveBeenCalled();
    });

    it('refuses when the space is on its way out', async () => {
      queue('spaces', {
        data: [spaceRow({ deleting_at: '2026-09-28T00:00:00.000Z' })],
        error: null,
      });

      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({ space_id: SPACE, owner_id: USER }),
      );

      expect(decision.access).toBe('none');
    });

    it('does not let the space owner in by role', async () => {
      withSpace({}, grant({ spaceRole: 'owner' }));

      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({ space_id: SPACE }),
      );

      expect(decision.access).toBe('none');
      expect(decision.source).toBe('none');
    });

    it('does not let a space admin in by role, space-wide or private', async () => {
      withSpace({}, grant({ spaceRole: 'admin' }));

      const shared = await service.resolveDecision(
        USER,
        ORG,
        calendar({ space_id: SPACE, visibility: 'space' }),
      );

      expect(shared.access).toBe('none');

      withSpace({}, grant({ spaceRole: 'admin' }));

      const priv = await service.resolveDecision(
        USER,
        ORG,
        calendar({ space_id: SPACE, visibility: 'private' }),
      );

      expect(priv.access).toBe('none');
    });

    it('does not show a member a space-wide calendar without a share', async () => {
      withSpace({}, grant({ spaceRole: 'member' }));

      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({ space_id: SPACE, visibility: 'space' }),
      );

      expect(decision.access).toBe('none');
      expect(decision.source).toBe('none');
    });

    it('caps everyone at reading in an archived space', async () => {
      withSpace({ is_archived: true }, grant({ spaceRole: 'member' }));

      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({
          space_id: SPACE,
          shares: [{ target_type: 'user', target_id: USER, level: 'manage' }],
        }),
      );

      expect(decision.access).toBe('view');
      expect(decision.permissions.manage).toBe(false);
      expect(decision.permissions.events.own_update).toBe(false);
    });

    it('caps a share by what the space itself allows', async () => {
      // A viewer may only view calendars, so a manage share cannot lift them past reading.
      withSpace({}, grant({ spaceRole: 'viewer' }));

      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({
          space_id: SPACE,
          shares: [{ target_type: 'user', target_id: USER, level: 'manage' }],
        }),
      );

      expect(decision.permissions.manage).toBe(false);
      expect(decision.permissions.events.create).toBe(false);
      expect(decision.permissions.events.others_read).toBe(true);
    });

    it('refuses outright when the space does not allow the calendar module at all', async () => {
      withSpace(
        {},
        grant({ spaceRole: 'member', basePermissions: {}, explicit: {} }),
      );

      const decision = await service.resolveDecision(
        USER,
        ORG,
        calendar({
          space_id: SPACE,
          shares: [{ target_type: 'user', target_id: USER, level: 'manage' }],
        }),
      );

      expect(decision.access).toBe('none');
    });
  });

  describe('the share list', () => {
    function shared(shares: unknown[], role = 'member') {
      queue('spaces', { data: [spaceRow()], error: null });
      resolveSpaceBaseGrant.mockResolvedValue(grant({ spaceRole: role }));

      return service.resolveDecision(
        USER,
        ORG,
        calendar({ space_id: SPACE, shares }),
      );
    }

    it('matches a rule naming this person', async () => {
      const decision = await shared([
        { target_type: 'user', target_id: USER, level: 'edit' },
      ]);

      expect(decision.source).toBe('user_share');
      expect(decision.permissions.events.create).toBe(true);
    });

    it('ignores a rule naming somebody else', async () => {
      const decision = await shared([
        { target_type: 'user', target_id: OTHER_USER, level: 'manage' },
      ]);

      expect(decision.access).toBe('none');
    });

    it('matches a rule naming the space role this person holds', async () => {
      const decision = await shared(
        [{ target_type: 'base_role', base_role: 'member', level: 'edit' }],
        'member',
      );

      expect(decision.source).toBe('base_role_share');
      expect(decision.permissions.events.create).toBe(true);
    });

    it('ignores a role rule for a role this person does not hold', async () => {
      const decision = await shared(
        [{ target_type: 'base_role', base_role: 'admin', level: 'manage' }],
        'member',
      );

      expect(decision.access).toBe('none');
    });

    it('matches a rule naming the calendar own space', async () => {
      const decision = await shared([
        { target_type: 'space', target_id: SPACE, level: 'edit' },
      ]);

      expect(decision.source).toBe('space_share');
    });

    it('ignores a rule naming a different space', async () => {
      const decision = await shared([
        { target_type: 'space', target_id: OTHER_SPACE, level: 'manage' },
      ]);

      expect(decision.access).toBe('none');
    });

    it('adds several matching rules together rather than taking only the strongest', async () => {
      const decision = await shared([
        {
          target_type: 'user',
          target_id: USER,
          permissions: { events: { own: { read: true } } },
        },
        {
          target_type: 'base_role',
          base_role: 'member',
          permissions: { task_events: { read: true } },
        },
      ]);

      expect(decision.permissions.events.own_read).toBe(true);
      expect(decision.permissions.task_events.read).toBe(true);
    });

    it('reads a rule carrying the matrix flag by flag', async () => {
      const decision = await shared([
        {
          target_type: 'user',
          target_id: USER,
          permissions: {
            events: { create: true, others: { read: true } },
            sync: { read: true },
          },
        },
      ]);

      expect(decision.permissions.events.create).toBe(true);
      expect(decision.permissions.events.others_read).toBe(true);
      expect(decision.permissions.events.others_update).toBe(false);
      expect(decision.permissions.sync.read).toBe(true);
      expect(decision.permissions.sync.manage).toBe(false);
    });

    it('skips a rule shaped in a way nobody recognises', async () => {
      const decision = await shared([
        { target_type: 'group', target_id: USER, level: 'manage' },
        { target_type: undefined, level: 'manage' },
      ]);

      expect(decision.access).toBe('none');
    });
  });

  describe('resolveMany', () => {
    it('reads the spaces table once however many calendars share a space', async () => {
      queue('spaces', { data: [spaceRow()], error: null });
      resolveSpaceBaseGrant.mockResolvedValue(grant({ spaceRole: 'owner' }));

      const levels = await service.resolveMany(USER, ORG, [
        calendar({ id: 'a', space_id: SPACE }),
        calendar({ id: 'b', space_id: SPACE }),
        calendar({ id: 'c', space_id: SPACE }),
      ]);

      expect(levels.get('a')).toBe('manage');
      expect(levels.get('c')).toBe('manage');
      expect(mockFrom).toHaveBeenCalledTimes(1);
    });

    it('answers for a calendar with no space without touching the spaces table', async () => {
      const levels = await service.resolveMany(USER, ORG, [
        calendar({ id: 'a', owner_id: USER }),
      ]);

      expect(levels.get('a')).toBe('manage');
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it('keeps the whole matrix when asked for decisions', async () => {
      const decisions = await service.resolveManyDecisions(USER, ORG, [
        calendar({ id: 'a', owner_id: USER }),
      ]);

      expect(decisions.get('a')?.permissions.manage).toBe(true);
    });

    it('says whether a share names this person, and whether that share lets them manage', async () => {
      const decisions = await service.resolveManyDecisions(USER, ORG, [
        calendar({
          id: 'viewed',
          owner_id: OTHER_USER,
          shares: [{ target_type: 'user', target_id: USER, level: 'view' }],
        }),
        calendar({
          id: 'managed',
          owner_id: OTHER_USER,
          shares: [{ target_type: 'user', target_id: USER, level: 'manage' }],
        }),
        calendar({
          id: 'theirs',
          owner_id: OTHER_USER,
          shares: [
            { target_type: 'user', target_id: OTHER_USER, level: 'manage' },
          ],
        }),
        calendar({ id: 'own', owner_id: USER }),
      ]);

      const flags = (id: string) => [
        decisions.get(id)?.sharedWithMe,
        decisions.get(id)?.sharedWithManage,
      ];

      expect(flags('viewed')).toEqual([true, false]);
      expect(flags('managed')).toEqual([true, true]);
      expect(flags('theirs')).toEqual([false, false]);

      // Owning a calendar is not a share of it.
      expect(flags('own')).toEqual([false, false]);
    });
  });

  describe('asserting a level', () => {
    it('lets through what reaches the level asked for', () => {
      expect(() => service.assert('manage', 'edit')).not.toThrow();
      expect(() => service.assert('edit', 'edit')).not.toThrow();
    });

    it('refuses what falls short, saying both levels', () => {
      expect(() => service.assert('view', 'edit')).toThrow(ForbiddenException);
      expect(() => service.assert('view', 'edit')).toThrow(/view/);
    });
  });

  describe('asserting one action', () => {
    it('lets a granted action through', () => {
      expect(() => service.assertAllowed(true, 'do the thing')).not.toThrow();
    });

    it('refuses a missing one, naming what was attempted', () => {
      expect(() => service.assertAllowed(false, 'delete entries')).toThrow(
        /delete entries/,
      );
    });
  });

  describe('creating a calendar in a space', () => {
    it('needs the space Manage calendars permission', async () => {
      queue('spaces', { data: [spaceRow()], error: null });
      resolveSpaceBaseGrant.mockResolvedValue(grant({ spaceRole: 'member' }));

      await expect(
        service.assertCanCreateInSpace(USER, ORG, SPACE),
      ).rejects.toThrow(/Manage calendars/);
    });

    it('lets an owner through, who holds it by default', async () => {
      queue('spaces', { data: [spaceRow()], error: null });
      resolveSpaceBaseGrant.mockResolvedValue(grant({ spaceRole: 'owner' }));

      await expect(
        service.assertCanCreateInSpace(USER, ORG, SPACE),
      ).resolves.toBeUndefined();
    });

    it('lets a member through once the space grants it explicitly', async () => {
      queue('spaces', { data: [spaceRow()], error: null });
      resolveSpaceBaseGrant.mockResolvedValue(
        grant({ spaceRole: 'member', explicit: { manage_calendars: true } }),
      );

      await expect(
        service.assertCanCreateInSpace(USER, ORG, SPACE),
      ).resolves.toBeUndefined();
    });

    it('refuses an archived space, whoever asks', async () => {
      queue('spaces', { data: [spaceRow({ is_archived: true })], error: null });
      resolveSpaceBaseGrant.mockResolvedValue(grant({ spaceRole: 'owner' }));

      await expect(
        service.assertCanCreateInSpace(USER, ORG, SPACE),
      ).rejects.toThrow(/no longer accepts/);
    });

    it('refuses a space that is not in this organization', async () => {
      queue('spaces', {
        data: [spaceRow({ organization_id: OTHER_ORG })],
        error: null,
      });

      await expect(
        service.assertCanCreateInSpace(USER, ORG, SPACE),
      ).rejects.toThrow(/not found in this organization/);
    });
  });

  describe('reading the tickets of a space', () => {
    it('follows the space own view_tasks permission', async () => {
      queue('spaces', { data: [spaceRow()], error: null });
      resolveSpaceBaseGrant.mockResolvedValue(grant({ spaceRole: 'member' }));

      await expect(service.canReadSpaceTickets(USER, ORG, SPACE)).resolves.toBe(
        true,
      );
    });

    it('is false for a space this person cannot reach', async () => {
      queue('spaces', { data: [], error: null });

      await expect(service.canReadSpaceTickets(USER, ORG, SPACE)).resolves.toBe(
        false,
      );
    });

    it('refuses to add a ticket source the person could not read', async () => {
      queue('spaces', { data: [], error: null });

      await expect(
        service.assertCanReadSpaceTickets(USER, ORG, SPACE),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
