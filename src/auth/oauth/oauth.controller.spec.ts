jest.mock('jose', () => ({
  SignJWT: jest.fn().mockImplementation(() => ({
    setProtectedHeader: jest.fn().mockReturnThis(),
    setIssuedAt: jest.fn().mockReturnThis(),
    setExpirationTime: jest.fn().mockReturnThis(),
    sign: jest.fn().mockResolvedValue('signed-state'),
  })),
  jwtVerify: jest.fn().mockResolvedValue({ payload: {} }),
}));

import { BadRequestException } from '@nestjs/common';
import { runControllerContractSuite } from '../../test/controller-contract.helper';
import { OauthController } from './oauth.controller';
import { OAUTH_STATE_COOKIE } from './oauth.service';

runControllerContractSuite({
  controller: OauthController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
  // `callback` is a browser-facing redirect endpoint: it deliberately never
  // rethrows, bouncing the user to the frontend login page with an ?error=
  // instead of dead-ending them on a raw JSON 400/401 at the API host. The
  // generic propagation contract does not apply — the failure path is asserted
  // explicitly in 'redirects to the login page when the code exchange fails'.
  skipDependencyFailurePropagation: ['callback'],
});

describe('OauthController manual behavior', () => {
  const tokens = {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
  };

  function setup() {
    const oauthService = {
      beginAuthorize: jest.fn(),
      completeCallback: jest.fn(),
      silentRedirectFor: jest.fn().mockResolvedValue(null),
    };
    const authService = {
      getTokenMfaState: jest.fn(),
    };
    const configService = { get: jest.fn() };
    // Default: SaaS (cloud) deployment — isOnPremise false.
    const authProviders = {
      isOnPremise: false,
      getAvailableProvidersForOnPremise: jest.fn().mockResolvedValue([]),
    };
    const res = {
      cookie: jest.fn().mockReturnThis(),
      clearCookie: jest.fn().mockReturnThis(),
      redirect: jest.fn().mockReturnThis(),
    };
    const controller = new OauthController(
      oauthService as any,
      configService as any,
      authProviders as any,
      authService as any,
    );
    return { controller, oauthService, authService, authProviders, res };
  }

  it('returns only Azure for the login page in the SaaS build', async () => {
    const { controller } = setup();

    // Cloud (isOnPremise=false): Azure only, never Keycloak.
    await expect(controller.providers()).resolves.toEqual({
      providers: ['azure'],
    });
  });

  it('returns the enabled provider set on-premise', async () => {
    const { controller, authProviders } = setup();

    authProviders.isOnPremise = true;
    authProviders.getAvailableProvidersForOnPremise.mockResolvedValue([
      'azure',
      'keycloak',
    ]);

    await expect(controller.providers()).resolves.toEqual({
      providers: ['azure', 'keycloak'],
    });
  });

  it('rejects unsupported providers and missing redirect targets', async () => {
    const { controller, oauthService, res } = setup();

    await expect(
      controller.authorize(
        'twitter',
        'https://app.test',
        undefined,
        res as any,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.authorize('azure', '', undefined, res as any),
    ).rejects.toThrow(BadRequestException);
    expect(oauthService.beginAuthorize).not.toHaveBeenCalled();
  });

  it('sets the state cookie and redirects to the provider authorize URL', async () => {
    const { controller, oauthService, res } = setup();
    oauthService.beginAuthorize.mockResolvedValue({
      authorizeUrl: 'https://provider.test/auth',
      state: 'signed-state',
    });

    await controller.authorize(
      'azure',
      'https://app.test/home',
      undefined,
      res as any,
    );

    expect(oauthService.beginAuthorize).toHaveBeenCalledWith(
      'azure',
      'https://app.test/home',
      { silent: false },
    );
    expect(res.cookie).toHaveBeenCalledWith(
      OAUTH_STATE_COOKIE,
      'signed-state',
      expect.objectContaining({
        httpOnly: true,
        path: '/api/v1/auth/oauth/callback',
      }),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://provider.test/auth',
    );
  });

  it('rejects Keycloak in the SaaS build (on-premise only)', async () => {
    const { controller, oauthService, res } = setup(); // isOnPremise=false

    await expect(
      controller.authorize(
        'keycloak',
        'https://app.test/home',
        undefined,
        res as any,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(oauthService.beginAuthorize).not.toHaveBeenCalled();
  });

  it('rejects a configurable provider that is not enabled on-premise', async () => {
    const { controller, oauthService, authProviders, res } = setup();
    authProviders.isOnPremise = true;
    authProviders.getAvailableProvidersForOnPremise.mockResolvedValue([]);

    await expect(
      controller.authorize(
        'keycloak',
        'https://app.test/home',
        undefined,
        res as any,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(oauthService.beginAuthorize).not.toHaveBeenCalled();
  });

  it('allows an enabled provider on-premise', async () => {
    const { controller, oauthService, authProviders, res } = setup();
    authProviders.isOnPremise = true;
    authProviders.getAvailableProvidersForOnPremise.mockResolvedValue([
      'keycloak',
    ]);
    oauthService.beginAuthorize.mockResolvedValue({
      authorizeUrl: 'https://kc.test/auth',
      state: 'signed-state',
    });

    await controller.authorize(
      'keycloak',
      'https://app.test/home',
      undefined,
      res as any,
    );

    expect(oauthService.beginAuthorize).toHaveBeenCalledWith(
      'keycloak',
      'https://app.test/home',
      { silent: false },
    );
  });

  it('requires both code and state cookie on callback', async () => {
    const { controller, oauthService, res } = setup();
    // The missing code/state guard still raises BadRequestException internally,
    // but callback() never rethrows to the browser: it clears the one-time
    // state cookie and bounces to the login page carrying the guard's message.
    const loginUrl = `http://localhost:3000/auth/login?error=${encodeURIComponent(
      'OAuth callback missing code or state cookie',
    )}`;

    await controller.callback({ cookies: {} } as any, 'code-1', res as any);
    expect(res.redirect).toHaveBeenCalledWith(302, loginUrl);

    res.redirect.mockClear();
    await controller.callback(
      { cookies: { [OAUTH_STATE_COOKIE]: 'state-1' } } as any,
      '',
      res as any,
    );
    expect(res.redirect).toHaveBeenCalledWith(302, loginUrl);

    // The one-time state cookie is cleared on the failure path too.
    expect(res.clearCookie).toHaveBeenCalledWith(
      OAUTH_STATE_COOKIE,
      expect.objectContaining({ path: '/api/v1/auth/oauth/callback' }),
    );
    // The exchange is never attempted without both halves of the handshake.
    expect(oauthService.completeCallback).not.toHaveBeenCalled();
  });

  it('starts a silent attempt for prompt=none and rejects any other prompt', async () => {
    const { controller, oauthService, res } = setup();
    oauthService.beginAuthorize.mockResolvedValue({
      authorizeUrl: 'https://provider.test/auth',
      state: 'signed-state',
    });

    await controller.authorize(
      'azure',
      'https://app.test/home',
      'none',
      res as any,
    );
    expect(oauthService.beginAuthorize).toHaveBeenCalledWith(
      'azure',
      'https://app.test/home',
      { silent: true },
    );

    oauthService.beginAuthorize.mockClear();
    await expect(
      controller.authorize(
        'azure',
        'https://app.test/home',
        'login',
        res as any,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(oauthService.beginAuthorize).not.toHaveBeenCalled();
  });

  it('returns a silent attempt with no provider session to the login page without an error', async () => {
    const { controller, oauthService, res } = setup();
    oauthService.silentRedirectFor.mockResolvedValue('https://app.test/home');

    await controller.callback(
      { cookies: { [OAUTH_STATE_COOKIE]: 'silent-state' } } as any,
      undefined as any,
      res as any,
    );

    expect(oauthService.silentRedirectFor).toHaveBeenCalledWith('silent-state');
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      `http://localhost:3000/auth/login?returnUrl=${encodeURIComponent(
        'https://app.test/home',
      )}#`,
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      OAUTH_STATE_COOKIE,
      expect.objectContaining({ path: '/api/v1/auth/oauth/callback' }),
    );
    expect(oauthService.completeCallback).not.toHaveBeenCalled();
  });

  it('redirects to the login page when the code exchange fails', async () => {
    const { controller, oauthService, res } = setup();
    oauthService.completeCallback.mockRejectedValue(
      new BadRequestException('Invalid authorization code'),
    );

    await controller.callback(
      { cookies: { [OAUTH_STATE_COOKIE]: 'state-1' } } as any,
      'code-1',
      res as any,
    );

    // An HttpException's message is surfaced verbatim for Login.tsx to render.
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      `http://localhost:3000/auth/login?error=${encodeURIComponent(
        'Invalid authorization code',
      )}`,
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      OAUTH_STATE_COOKIE,
      expect.objectContaining({ path: '/api/v1/auth/oauth/callback' }),
    );
    // A failed exchange must never set auth cookies.
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('redirects with a generic message when the failure is not an HttpException', async () => {
    const { controller, oauthService, res } = setup();
    oauthService.completeCallback.mockRejectedValue(
      new Error('socket hang up'),
    );

    await controller.callback(
      { cookies: { [OAUTH_STATE_COOKIE]: 'state-1' } } as any,
      'code-1',
      res as any,
    );

    // Non-HttpException internals are not leaked to the browser.
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      `http://localhost:3000/auth/login?error=${encodeURIComponent(
        'Sign-in failed. Please try again.',
      )}`,
    );
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('clears state, sets auth cookies, and redirects after callback', async () => {
    const { controller, oauthService, authService, res } = setup();
    oauthService.completeCallback.mockResolvedValue({
      tokens,
      redirectTo: 'https://app.test/home',
    });
    authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: false,
      currentLevel: 'aal1',
      nextLevel: 'aal1',
    });

    await controller.callback(
      { cookies: { [OAUTH_STATE_COOKIE]: 'state-1' } } as any,
      'code-1',
      res as any,
    );

    expect(oauthService.completeCallback).toHaveBeenCalledWith(
      'code-1',
      'state-1',
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      OAUTH_STATE_COOKIE,
      expect.objectContaining({ path: '/api/v1/auth/oauth/callback' }),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      tokens.access_token,
      expect.any(Object),
    );
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://app.test/home');
  });

  it('sets mfa_pending and redirects to TOTP when callback tokens still require step-up', async () => {
    const { controller, oauthService, authService, res } = setup();
    oauthService.completeCallback.mockResolvedValue({
      tokens,
      redirectTo: 'https://app.test/home',
    });
    authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: true,
      currentLevel: 'aal1',
      nextLevel: 'aal2',
    });

    await controller.callback(
      { cookies: { [OAUTH_STATE_COOKIE]: 'state-1' } } as any,
      'code-1',
      res as any,
    );

    expect(authService.getTokenMfaState).toHaveBeenCalledWith(
      tokens.access_token,
      { forceMfa: false },
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'mfa_pending',
      'true',
      expect.objectContaining({ path: '/' }),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'http://localhost:3000/auth/verify-totp?returnUrl=https%3A%2F%2Fapp.test%2Fhome',
    );
  });
});
