/**
 * @fileoverview The calendar integration routes: connected accounts, and pointing a calendar at one.
 *
 * Besides the usual pass-through checks, two properties here are security-relevant and easy to lose
 * in a refactor: the routes that attach or detach somebody's own account are marked
 * `@ImpersonationBlocked()`, and a published link is read once before it is stored.
 */
import { ForbiddenException } from '@nestjs/common';
import { IMPERSONATION_BLOCKED_KEY } from '../../auth/decorators/impersonation-blocked.decorator';
import { CalendarsService } from '../calendars.service';
import { CalendarAccountsService } from './calendar-accounts.service';
import { CalendarIntegrationsController } from './calendar-integrations.controller';
import { CalendarProvidersService } from './calendar-providers.service';
import { CalendarSyncService } from './calendar-sync.service';
import { readState } from './calendar-oauth.state';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';

describe('CalendarIntegrationsController', () => {
  let controller: CalendarIntegrationsController;
  let accounts: Record<string, jest.Mock>;
  let sync: Record<string, jest.Mock>;
  let calendars: Record<string, jest.Mock>;
  let providers: Record<string, jest.Mock>;
  let api: Record<string, jest.Mock>;

  const ORG = 'org-1';
  const USER = 'user-1';
  const CAL = 'cal-1';
  const ACCOUNT = 'acc-1';

  const user = { userId: USER, organizationId: ORG } as RequestUser;

  /** Every route, described once, so `it.each` has the table at collection time. */
  const ROUTES = [
    {
      name: 'listAccounts',
      call: (c: CalendarIntegrationsController) => c.listAccounts(user),
      worked: () => accounts.listForUser,
    },
    {
      name: 'connect',
      call: (c: CalendarIntegrationsController) => c.connect('google', user),
      worked: () => providers.get,
    },
    {
      name: 'connectIcs',
      call: (c: CalendarIntegrationsController) =>
        c.connectIcs({ url: 'https://example.test/feed.ics' } as never, user),
      worked: () => accounts.save,
    },
    {
      name: 'disconnect',
      call: (c: CalendarIntegrationsController) => c.disconnect(ACCOUNT, user),
      worked: () => accounts.disconnect,
    },
    {
      name: 'externalCalendars',
      call: (c: CalendarIntegrationsController) =>
        c.externalCalendars(ACCOUNT, user),
      worked: () => sync.listExternalCalendars,
    },
    {
      name: 'link',
      call: (c: CalendarIntegrationsController) =>
        c.link(
          CAL,
          { account_id: ACCOUNT, external_calendar_id: 'primary' } as never,
          user,
        ),
      worked: () => sync.link,
    },
    {
      name: 'unlink',
      call: (c: CalendarIntegrationsController) => c.unlink(CAL, user),
      worked: () => sync.unlink,
    },
    {
      name: 'runNow',
      call: (c: CalendarIntegrationsController) => c.runNow(CAL, user),
      worked: () => sync.runNow,
    },
  ] as const;

  beforeEach(() => {
    api = {
      authorizeUrl: jest
        .fn()
        .mockReturnValue('https://provider.test/authorize'),
      listCalendars: jest
        .fn()
        .mockResolvedValue([{ id: 'primary', name: 'Work' }]),
    };

    accounts = {
      listForUser: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockResolvedValue({}),
      disconnect: jest.fn().mockResolvedValue({ success: true }),
    };

    sync = {
      listExternalCalendars: jest.fn().mockResolvedValue([]),
      link: jest.fn().mockResolvedValue({}),
      unlink: jest.fn().mockResolvedValue({}),
      runNow: jest
        .fn()
        .mockResolvedValue({ imported: 0, removed: 0, reset: false }),
    };

    calendars = { assertModuleEnabled: jest.fn().mockResolvedValue(undefined) };
    providers = { get: jest.fn().mockReturnValue(api) };

    controller = new CalendarIntegrationsController(
      accounts as unknown as CalendarAccountsService,
      sync as unknown as CalendarSyncService,
      calendars as unknown as CalendarsService,
      providers as unknown as CalendarProvidersService,
    );
  });

  it('covers every route the controller exposes', () => {
    const exposed = Object.getOwnPropertyNames(
      CalendarIntegrationsController.prototype,
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
        expect(route.worked()).not.toHaveBeenCalled();
      },
    );
  });

  describe('blocked while impersonating', () => {
    // An administrator acting as somebody else must not attach or detach that person's own account.
    it.each(['connect', 'connectIcs', 'disconnect'])(
      '%s carries the marker',
      (name) => {
        const marker = Reflect.getMetadata(
          IMPERSONATION_BLOCKED_KEY,
          (CalendarIntegrationsController.prototype as never)[name],
        );

        expect(marker).toBe(true);
      },
    );

    it.each(['listAccounts', 'link', 'unlink', 'runNow', 'externalCalendars'])(
      '%s does not, since it touches no credential of its own',
      (name) => {
        const marker = Reflect.getMetadata(
          IMPERSONATION_BLOCKED_KEY,
          (CalendarIntegrationsController.prototype as never)[name],
        );

        expect(marker).toBeUndefined();
      },
    );
  });

  describe('connecting', () => {
    it('answers with the provider own sign-in address', async () => {
      await expect(controller.connect('google', user)).resolves.toEqual({
        url: 'https://provider.test/authorize',
      });
      expect(providers.get).toHaveBeenCalledWith('google');
    });

    it('reads a published link once before storing it', async () => {
      await controller.connectIcs(
        { url: 'https://example.test/feed.ics' } as never,
        user,
      );

      expect(api.listCalendars).toHaveBeenCalledWith(
        'https://example.test/feed.ics',
      );
      expect(accounts.save).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          userId: USER,
          provider: 'ics',
          externalAccountId: 'https://example.test/feed.ics',
        }),
      );
    });

    it('stores nothing when the link answers nothing', async () => {
      api.listCalendars.mockRejectedValue(new Error('404'));

      await expect(
        controller.connectIcs(
          { url: 'https://example.test/gone.ics' } as never,
          user,
        ),
      ).rejects.toThrow();
      expect(accounts.save).not.toHaveBeenCalled();
    });

    it('takes the name from the link when the payload gives none', async () => {
      await controller.connectIcs(
        { url: 'https://example.test/feed.ics' } as never,
        user,
      );

      expect(accounts.save).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Work' }),
      );
    });

    it('prefers the name the payload gives', async () => {
      await controller.connectIcs(
        { url: 'https://example.test/feed.ics', name: 'Mine' } as never,
        user,
      );

      expect(accounts.save).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: 'Mine' }),
      );
    });
  });

  describe('pointing a calendar at an outside one', () => {
    it('passes the calendar, the payload and the caller through', async () => {
      const dto = { account_id: ACCOUNT, external_calendar_id: 'primary' };

      await controller.link(CAL, dto as never, user);

      expect(sync.link).toHaveBeenCalledWith(CAL, dto, USER, ORG);
    });

    it('passes the caller through when stopping and when running now', async () => {
      await controller.unlink(CAL, user);
      await controller.runNow(CAL, user);

      expect(sync.unlink).toHaveBeenCalledWith(CAL, USER, ORG);
      expect(sync.runNow).toHaveBeenCalledWith(CAL, USER, ORG);
    });

    it('lets a refusal from the sync service travel out unchanged', async () => {
      const refusal = new ForbiddenException('nope');

      sync.runNow.mockRejectedValue(refusal);

      await expect(controller.runNow(CAL, user)).rejects.toBe(refusal);
    });
  });

  describe('coming back to the tenant', () => {
    const saved = process.env.APP_URL;

    beforeEach(() => {
      process.env.APP_URL = 'https://app.lvh.me:3000';
    });

    afterAll(() => {
      process.env.APP_URL = saved;
    });

    const signedReturn = () => {
      const state = (api.authorizeUrl as jest.Mock).mock.calls[0][0] as string;

      return readState(state)?.returnTo;
    };

    it('carries the page address when it is on our own domain', async () => {
      await controller.connect(
        'google',
        user,
        undefined,
        'https://abj-experts.lvh.me:3000',
      );

      expect(signedReturn()).toBe('https://abj-experts.lvh.me:3000');
    });

    it('falls back to the request origin when no address is sent', async () => {
      await controller.connect('microsoft', user, {
        headers: { origin: 'https://abj-experts.lvh.me:3000' },
      } as never);

      expect(signedReturn()).toBe('https://abj-experts.lvh.me:3000');
    });

    it.each([
      'https://evil.example.com',
      'https://evil-lvh.me',
      'javascript:alert(1)',
      'not a url',
    ])('drops an address outside our domain: %s', async (address) => {
      await controller.connect('calendly', user, undefined, address);

      expect(signedReturn()).toBeUndefined();
    });
  });
});
