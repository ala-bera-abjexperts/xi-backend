/**
 * @fileoverview The calendar routes.
 *
 * A controller here is a thin pass-through, so what is worth pinning down is the part a refactor
 * could quietly break: every route checks the module is switched on BEFORE doing anything, and the
 * organization and user come from the authenticated request, never from the path, body or query.
 */
import { ForbiddenException } from '@nestjs/common';
import { CalendarsController } from './calendars.controller';
import { CalendarsService } from './calendars.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

describe('CalendarsController', () => {
  let controller: CalendarsController;
  let service: jest.Mocked<
    Pick<
      CalendarsService,
      | 'assertModuleEnabled'
      | 'listVisible'
      | 'listOwnerless'
      | 'canCreateCalendars'
      | 'removeOwnerless'
      | 'create'
      | 'getForUser'
      | 'update'
      | 'remove'
      | 'setShares'
      | 'setFeeds'
      | 'setFieldSettings'
      | 'listLinkableTickets'
      | 'listTicketLinks'
    >
  >;

  const ORG = 'org-1';
  const USER = 'user-1';
  const CAL = 'cal-1';

  /** What the guards put on the request; a route must read the tenant from here and nowhere else. */
  const user = { userId: USER, organizationId: ORG } as RequestUser;

  /**
   * Every route, described once.
   *
   * Declared at module scope so `it.each` has the table while the file is being collected, not after
   * the first `beforeEach` has run.
   */
  const ROUTES = [
    {
      name: 'list',
      method: 'listVisible',
      args: () => [USER, ORG],
      call: (c: CalendarsController) => c.list(user),
    },
    {
      name: 'canCreate',
      method: 'canCreateCalendars',
      args: () => [USER, ORG],
      call: (c: CalendarsController) => c.canCreate(user),
    },
    {
      name: 'ownerless',
      method: 'listOwnerless',
      args: () => [ORG, USER],
      call: (c: CalendarsController) => c.ownerless(user),
    },
    {
      name: 'removeOwnerless',
      method: 'removeOwnerless',
      args: () => [CAL, ORG, USER],
      call: (c: CalendarsController) => c.removeOwnerless(CAL, user),
    },
    {
      name: 'create',
      method: 'create',
      args: () => [{ name: 'A' }, USER, ORG],
      call: (c: CalendarsController) => c.create({ name: 'A' } as never, user),
    },
    {
      name: 'get',
      method: 'getForUser',
      args: () => [CAL, USER, ORG],
      call: (c: CalendarsController) => c.get(CAL, user),
    },
    {
      name: 'update',
      method: 'update',
      args: () => [CAL, { name: 'B' }, USER, ORG],
      call: (c: CalendarsController) =>
        c.update(CAL, { name: 'B' } as never, user),
    },
    {
      name: 'remove',
      method: 'remove',
      args: () => [CAL, USER, ORG],
      call: (c: CalendarsController) => c.remove(CAL, user),
    },
    {
      name: 'setShares',
      method: 'setShares',
      args: () => [CAL, [], USER, ORG],
      call: (c: CalendarsController) =>
        c.setShares(CAL, { shares: [] } as never, user),
    },
    {
      name: 'setFeeds',
      method: 'setFeeds',
      args: () => [CAL, [], USER, ORG],
      call: (c: CalendarsController) =>
        c.setFeeds(CAL, { feeds: [] } as never, user),
    },
    {
      name: 'linkableTickets',
      method: 'listLinkableTickets',
      args: () => [CAL, USER, ORG, { space_ids: 'space-1' }],
      call: (c: CalendarsController) =>
        c.linkableTickets(CAL, { space_ids: 'space-1' } as never, user),
    },
    {
      name: 'ticketLinks',
      method: 'listTicketLinks',
      args: () => [CAL, USER, ORG, {}],
      call: (c: CalendarsController) => c.ticketLinks(CAL, {} as never, user),
    },
    {
      name: 'setFields',
      method: 'setFieldSettings',
      args: () => [CAL, [], USER, ORG],
      call: (c: CalendarsController) =>
        c.setFields(CAL, { fields: [] } as never, user),
    },
  ] as const;

  beforeEach(() => {
    service = {
      assertModuleEnabled: jest.fn().mockResolvedValue(undefined),
      listVisible: jest.fn().mockResolvedValue([]),
      canCreateCalendars: jest.fn().mockResolvedValue(true),
      listOwnerless: jest.fn().mockResolvedValue([]),
      removeOwnerless: jest.fn().mockResolvedValue({ success: true }),
      create: jest.fn().mockResolvedValue({}),
      getForUser: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue({ success: true }),
      setShares: jest.fn().mockResolvedValue({}),
      setFeeds: jest.fn().mockResolvedValue({}),
      setFieldSettings: jest.fn().mockResolvedValue({}),
      listLinkableTickets: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listTicketLinks: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    } as never;

    controller = new CalendarsController(
      service as unknown as CalendarsService,
    );
  });

  it('covers every route the controller exposes', () => {
    // A new route added without a case here would otherwise go unchecked.
    const exposed = Object.getOwnPropertyNames(
      CalendarsController.prototype,
    ).filter((name) => name !== 'constructor');

    expect(ROUTES.map((route) => route.name).sort()).toEqual(exposed.sort());
  });

  describe('the module switch', () => {
    it.each(ROUTES.map((route) => route.name))(
      '%s asks whether the module is on, for this organization',
      async (name) => {
        const route = ROUTES.find((entry) => entry.name === name)!;

        await route.call(controller);

        expect(service.assertModuleEnabled).toHaveBeenCalledWith(ORG);
      },
    );

    it.each(ROUTES.map((route) => route.name))(
      '%s does no work when the module is off',
      async (name) => {
        const route = ROUTES.find((entry) => entry.name === name)!;

        service.assertModuleEnabled.mockRejectedValue(new ForbiddenException());

        await expect(route.call(controller)).rejects.toThrow(
          ForbiddenException,
        );
        expect(service[route.method]).not.toHaveBeenCalled();
      },
    );
  });

  describe('passing the request through', () => {
    it.each(ROUTES.map((route) => route.name))(
      '%s hands the service the caller own user and organization',
      async (name) => {
        const route = ROUTES.find((entry) => entry.name === name)!;

        await route.call(controller);

        expect(service[route.method]).toHaveBeenCalledWith(...route.args());
      },
    );

    it('never lets a body decide the organization', async () => {
      // The tenant comes from the token; a payload naming another one must be ignored.
      await controller.create(
        { name: 'A', organization_id: 'org-elsewhere' } as never,
        user,
      );

      expect(service.create).toHaveBeenCalledWith(
        expect.objectContaining({ organization_id: 'org-elsewhere' }),
        USER,
        ORG,
      );
    });

    it('unwraps the shares payload rather than passing the envelope on', async () => {
      const shares = [
        { target_type: 'user', target_id: 'someone', level: 'view' },
      ];

      await controller.setShares(CAL, { shares } as never, user);

      expect(service.setShares).toHaveBeenCalledWith(CAL, shares, USER, ORG);
    });
  });

  describe('what a route returns', () => {
    it('returns exactly what the service answered', async () => {
      const answer = [{ id: CAL }];

      service.listVisible.mockResolvedValue(answer as never);

      await expect(controller.list(user)).resolves.toBe(answer);
    });

    it('lets a service refusal travel out unchanged', async () => {
      const refusal = new ForbiddenException('nope');

      service.getForUser.mockRejectedValue(refusal);

      await expect(controller.get(CAL, user)).rejects.toBe(refusal);
    });
  });
});
