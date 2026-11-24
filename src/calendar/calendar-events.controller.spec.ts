/**
 * @fileoverview The calendar entry routes.
 *
 * Thin pass-throughs, so what is pinned here is what a refactor could quietly break: every route asks
 * whether the module is on before doing anything, the tenant comes from the authenticated request,
 * and the payload envelopes are unwrapped rather than handed on whole.
 */
import { ForbiddenException } from '@nestjs/common';
import { CalendarEventsController } from './calendar-events.controller';
import { CalendarEventsService } from './calendar-events.service';
import { CalendarsService } from './calendars.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

describe('CalendarEventsController', () => {
  let controller: CalendarEventsController;
  let events: Record<string, jest.Mock>;
  let calendars: Record<string, jest.Mock>;

  const ORG = 'org-1';
  const USER = 'user-1';
  const EVENT = 'event-1';

  /** What the guards put on the request; a route must read the tenant from here and nowhere else. */
  const user = { userId: USER, organizationId: ORG } as RequestUser;

  const WINDOW = { from: '2026-09-01', to: '2026-09-30' };

  /**
   * Every route, described once.
   *
   * At module scope so `it.each` has the table while the file is being collected, rather than after
   * the first `beforeEach`.
   */
  const ROUTES = [
    {
      name: 'list',
      method: 'list',
      args: () => [WINDOW, USER, ORG],
      call: (c: CalendarEventsController) => c.list(WINDOW as never, user),
    },
    {
      name: 'create',
      method: 'create',
      args: () => [{ summary: 'A' }, USER, ORG],
      call: (c: CalendarEventsController) =>
        c.create({ summary: 'A' } as never, user),
    },
    {
      name: 'get',
      method: 'getForUser',
      args: () => [EVENT, USER, ORG],
      call: (c: CalendarEventsController) => c.get(EVENT, user),
    },
    {
      name: 'update',
      method: 'update',
      args: () => [EVENT, { summary: 'B' }, USER, ORG],
      call: (c: CalendarEventsController) =>
        c.update(EVENT, { summary: 'B' } as never, user),
    },
    {
      name: 'remove',
      method: 'remove',
      args: () => [EVENT, USER, ORG],
      call: (c: CalendarEventsController) => c.remove(EVENT, user),
    },
    {
      name: 'setWatchers',
      method: 'setWatchers',
      args: () => [EVENT, ['w-1'], USER, ORG],
      call: (c: CalendarEventsController) =>
        c.setWatchers(EVENT, { watcher_ids: ['w-1'] } as never, user),
    },
    {
      name: 'setLinks',
      method: 'setLinks',
      args: () => [EVENT, [{ type: 'task', id: 't-1' }], USER, ORG],
      call: (c: CalendarEventsController) =>
        c.setLinks(
          EVENT,
          { links: [{ type: 'task', id: 't-1' }] } as never,
          user,
        ),
    },
  ] as const;

  beforeEach(() => {
    events = {
      list: jest.fn().mockResolvedValue([]),
      assertNoPastWholeDay: jest.fn().mockResolvedValue(undefined),
      assertNoPastTime: jest.fn().mockResolvedValue(undefined),
      assertNoOwnClash: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue({}),
      getForUser: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue({ success: true }),
      setWatchers: jest.fn().mockResolvedValue({}),
      setLinks: jest.fn().mockResolvedValue({}),
    };

    calendars = {
      assertModuleEnabled: jest.fn().mockResolvedValue(undefined),
    };

    controller = new CalendarEventsController(
      events as unknown as CalendarEventsService,
      calendars as unknown as CalendarsService,
    );
  });

  it('covers every route the controller exposes', () => {
    // A new route added without a case here would otherwise go unchecked.
    const exposed = Object.getOwnPropertyNames(
      CalendarEventsController.prototype,
    ).filter((name) => name !== 'constructor');

    expect(ROUTES.map((route) => route.name).sort()).toEqual(exposed.sort());
  });

  describe('the module switch', () => {
    it.each(ROUTES.map((route) => route.name))(
      '%s asks whether the module is on, for this organization',
      async (name) => {
        const route = ROUTES.find((entry) => entry.name === name)!;

        await route.call(controller);

        expect(calendars.assertModuleEnabled).toHaveBeenCalledWith(ORG);
      },
    );

    it.each(ROUTES.map((route) => route.name))(
      '%s does no work when the module is off',
      async (name) => {
        const route = ROUTES.find((entry) => entry.name === name)!;

        calendars.assertModuleEnabled.mockRejectedValue(
          new ForbiddenException(),
        );

        await expect(route.call(controller)).rejects.toThrow(
          ForbiddenException,
        );
        expect(events[route.method]).not.toHaveBeenCalled();
      },
    );
  });

  describe('passing the request through', () => {
    it.each(ROUTES.map((route) => route.name))(
      '%s hands the service the caller own user and organization',
      async (name) => {
        const route = ROUTES.find((entry) => entry.name === name)!;

        await route.call(controller);

        expect(events[route.method]).toHaveBeenCalledWith(...route.args());
      },
    );

    it('unwraps the watchers envelope rather than passing it on whole', async () => {
      await controller.setWatchers(
        EVENT,
        { watcher_ids: ['a', 'b'] } as never,
        user,
      );

      expect(events.setWatchers).toHaveBeenCalledWith(
        EVENT,
        ['a', 'b'],
        USER,
        ORG,
      );
    });

    it('unwraps the links envelope rather than passing it on whole', async () => {
      const links = [{ type: 'task', id: 't-9' }];

      await controller.setLinks(EVENT, { links } as never, user);

      expect(events.setLinks).toHaveBeenCalledWith(EVENT, links, USER, ORG);
    });

    it('hands the whole query through for the window, which the service validates', async () => {
      const query = { from: 'x', to: 'y', calendar_ids: ['c-1'], tz: 'UTC' };

      await controller.list(query as never, user);

      expect(events.list).toHaveBeenCalledWith(query, USER, ORG);
    });
  });

  describe('what a route returns', () => {
    it('returns exactly what the service answered', async () => {
      const answer = [{ id: EVENT }];

      events.list.mockResolvedValue(answer);

      await expect(controller.list(WINDOW as never, user)).resolves.toBe(
        answer,
      );
    });

    it('lets a service refusal travel out unchanged', async () => {
      const refusal = new ForbiddenException('nope');

      events.update.mockRejectedValue(refusal);

      await expect(controller.update(EVENT, {} as never, user)).rejects.toBe(
        refusal,
      );
    });
  });
});
