/**
 * @fileoverview Where a provider sign-in sends the person back to.
 */
import type { Response } from 'express';

import type { CalendarAccountsService } from './calendar-accounts.service';
import { CalendarOauthController } from './calendar-oauth.controller';
import { createState, readState } from './calendar-oauth.state';
import type { CalendarProvidersService } from './calendar-providers.service';

describe('CalendarOauthController', () => {
  const TENANT = 'https://abj-experts.lvh.me:3000';
  const savedFrontend = process.env.FRONTEND_URL;

  let redirect: jest.Mock;
  let save: jest.Mock;
  let controller: CalendarOauthController;

  const res = () => ({ redirect }) as unknown as Response;

  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://auth.lvh.me:3000';
    redirect = jest.fn();
    save = jest.fn().mockResolvedValue({});

    const api = {
      exchangeCode: jest.fn().mockResolvedValue({
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: null,
        scope: null,
      }),
      identity: jest
        .fn()
        .mockResolvedValue({ id: 'ext-1', email: 'person@example.test' }),
    };

    controller = new CalendarOauthController(
      { save } as unknown as CalendarAccountsService,
      {
        get: jest.fn().mockReturnValue(api),
      } as unknown as CalendarProvidersService,
    );
  });

  afterAll(() => {
    process.env.FRONTEND_URL = savedFrontend;
  });

  it.each(['google', 'microsoft', 'calendly'])(
    'returns %s to the tenant the sign-in started from',
    async (provider) => {
      const state = createState('user-1', 'org-1', provider, TENANT);

      await controller.callback(provider, 'code', state, undefined, res());

      expect(save).toHaveBeenCalled();
      expect(redirect).toHaveBeenCalledWith(
        `${TENANT}/calendar/integrations?connected=${provider}`,
      );
    },
  );

  it('keeps the configured default when the state carries no address', async () => {
    const state = createState('user-1', 'org-1', 'google');

    await controller.callback('google', 'code', state, undefined, res());

    expect(redirect).toHaveBeenCalledWith(
      'https://auth.lvh.me:3000/calendar/integrations?connected=google',
    );
  });

  it('sends a refusal at the provider back to the tenant too', async () => {
    const state = createState('user-1', 'org-1', 'google', TENANT);

    await controller.callback(
      'google',
      undefined,
      state,
      'access_denied',
      res(),
    );

    expect(save).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(
      `${TENANT}/calendar/integrations?connected=google&error=access_denied`,
    );
  });

  it('falls back to the default when the state is missing or forged', async () => {
    await controller.callback(
      'google',
      'code',
      'forged.value',
      undefined,
      res(),
    );

    expect(save).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith(
      'https://auth.lvh.me:3000/calendar/integrations?connected=google&error=expired',
    );
  });

  it('a state keeps only the origin of a web address', () => {
    expect(
      readState(createState('u', 'o', 'google', `${TENANT}/calendar/x?y=1`))
        ?.returnTo,
    ).toBe(TENANT);
    expect(
      readState(createState('u', 'o', 'google', 'javascript:alert(1)'))
        ?.returnTo,
    ).toBeUndefined();
  });
});
