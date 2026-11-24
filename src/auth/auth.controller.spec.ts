import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { runControllerContractSuite } from '../test/controller-contract.helper';
import { AuthController } from './auth.controller';

runControllerContractSuite({
  controller: AuthController,
  sourceFile: __filename.replace(/\.spec\.ts$/, '.ts'),
  skipDependencyFailurePropagation: ['refreshForBrowser', 'transferSession'],
});

describe('AuthController manual behavior', () => {
  const tokenResult = {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    token_type: 'bearer',
  };
  const body = {
    email: 'user@example.com',
    password: 'Passw0rd!',
    token: '123456',
    code: 'auth-code',
  };
  const user = {
    authUserId: 'auth-user-1',
    userId: 'user-1',
    organizationId: 'org-1',
    email: body.email,
  };

  function setup(configOverrides: Record<string, unknown> = {}) {
    const authService = {
      signup: jest.fn(),
      signin: jest.fn(),
      getTokenMfaState: jest.fn(),
      verifyOtp: jest.fn(),
      refreshToken: jest.fn(),
      resendVerification: jest.fn(),
      forgotPassword: jest.fn(),
      exchangeCodeForSession: jest.fn(),
      signout: jest.fn(),
      updatePassword: jest.fn(),
      getProfile: jest.fn(),
      bootstrap: jest.fn(),
    };
    const mailService = {
      sendSignupOtp: jest.fn(),
      sendVerificationOtp: jest.fn(),
      sendPasswordReset: jest.fn(),
    };
    const configService = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          frontendUrl: 'https://app.test',
          allowedOrigins: ['https://app.test'],
          ...configOverrides,
        };

        return values[key];
      }),
    };
    const domainQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    const funnelQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    // The controller resolves the transfer session's organization from the
    // user's first `organization_members` row (created_at ASC), not from the
    // profile — so that table needs its own builder with .order()/.limit().
    const membershipQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: jest
        .fn()
        .mockResolvedValue({ data: { organization_id: 'org-1' }, error: null }),
    };
    const from = jest.fn((table: string) =>
      table === 'organization_members'
        ? membershipQuery
        : table === 'site_studio_funnels'
          ? funnelQuery
          : domainQuery,
    );
    const authGetUser = jest.fn().mockResolvedValue({
      data: { user: { id: 'auth-user-1' } },
      error: null,
    });
    const supabaseAdmin = {
      getClient: jest.fn().mockReturnValue({
        from,
        auth: { getUser: authGetUser },
      }),
    };
    const res = {
      cookie: jest.fn().mockReturnThis(),
      clearCookie: jest.fn().mockReturnThis(),
      redirect: jest.fn().mockReturnThis(),
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
      type: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };
    const controller = new AuthController(
      authService as any,
      mailService as any,
      configService as any,
      supabaseAdmin as any,
      { stopByToken: jest.fn().mockResolvedValue(undefined) } as any,
    );
    return {
      authService,
      mailService,
      res,
      controller,
      domainQuery,
      funnelQuery,
      membershipQuery,
      authGetUser,
    };
  }

  it('sends the signup OTP when one is returned', async () => {
    const { authService, mailService, controller } = setup();
    authService.signup.mockResolvedValue({ email: body.email, otp: '654321' });

    await expect(controller.signup(body as any)).resolves.toEqual({
      message: 'Email sent successfully!',
      email: body.email,
    });
    expect(mailService.sendSignupOtp).toHaveBeenCalledWith(
      body.email,
      '654321',
    );
  });

  it('maps a signup OTP send failure to 503 email_send_failed instead of a 500', async () => {
    const { authService, mailService, controller } = setup();
    authService.signup.mockResolvedValue({ email: body.email, otp: '654321' });
    const tlsError = Object.assign(
      new Error('unable to verify the first certificate'),
      { code: 'ESOCKET' },
    );
    mailService.sendSignupOtp.mockRejectedValue(tlsError);

    await expect(controller.signup(body as any)).rejects.toMatchObject({
      status: 503,
      response: { code: 'email_send_failed' },
    });
  });

  it('keeps the generic forgot-password success when the reset email fails (anti-enumeration)', async () => {
    const { authService, mailService, controller } = setup();
    authService.forgotPassword.mockResolvedValue({
      resetLink: 'https://app.test/reset?code=x',
      firstName: 'Test',
    });
    mailService.sendPasswordReset.mockRejectedValue(
      Object.assign(new Error('unable to verify the first certificate'), {
        code: 'ESOCKET',
      }),
    );

    await expect(
      controller.forgotPassword({ email: body.email } as any),
    ).resolves.toEqual({ success: true });
  });

  it('keeps the generic resend-verification success when the OTP email fails (anti-enumeration)', async () => {
    const { authService, mailService, controller } = setup();
    authService.resendVerification.mockResolvedValue({ otp: '654321' });
    mailService.sendVerificationOtp.mockRejectedValue(
      Object.assign(new Error('unable to verify the first certificate'), {
        code: 'ESOCKET',
      }),
    );

    await expect(
      controller.resendVerification({ email: body.email } as any),
    ).resolves.toEqual({ message: 'Verification email sent successfully' });
  });

  it('sets auth cookies after signin', async () => {
    const { authService, res, controller } = setup();
    authService.signin.mockResolvedValue(tokenResult);

    await expect(controller.signin(body as any, res as any)).resolves.toBe(
      tokenResult,
    );
    expect(authService.signin).toHaveBeenCalledWith(body.email, body.password);
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      tokenResult.access_token,
      expect.any(Object),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_token',
      tokenResult.refresh_token,
      expect.any(Object),
    );
    expect(res.cookie).not.toHaveBeenCalledWith(
      'mfa_pending',
      expect.anything(),
      expect.any(Object),
    );
  });

  it('sets an MFA pending cookie after signin when MFA is required', async () => {
    const { authService, res, controller } = setup();
    authService.signin.mockResolvedValue({
      ...tokenResult,
      mfaRequired: true,
      currentLevel: 'aal1',
      nextLevel: 'aal2',
    });

    await expect(
      controller.signin(body as any, res as any),
    ).resolves.toMatchObject({
      mfaRequired: true,
    });
    expect(res.cookie).toHaveBeenCalledWith(
      'mfa_pending',
      'true',
      expect.objectContaining({
        httpOnly: true,
        path: '/',
        maxAge: 10 * 60 * 1000,
      }),
    );
  });

  it('uses the refresh token cookie when the body omits refreshToken', async () => {
    const { authService, res, controller } = setup();
    authService.refreshToken.mockResolvedValue(tokenResult);
    authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: false,
      currentLevel: 'aal1',
      nextLevel: 'aal1',
    });

    await expect(
      controller.refreshToken(
        { cookies: { refresh_token: 'cookie-refresh' } } as any,
        {} as any,
        res as any,
      ),
    ).resolves.toBe(tokenResult);
    expect(authService.refreshToken).toHaveBeenCalledWith('cookie-refresh');
    expect(res.cookie).toHaveBeenCalledWith(
      'refresh_token',
      tokenResult.refresh_token,
      expect.any(Object),
    );
  });

  it('uses the refresh token cookie when the body is undefined', async () => {
    const { authService, res, controller } = setup();
    authService.refreshToken.mockResolvedValue(tokenResult);
    authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: false,
      currentLevel: 'aal1',
      nextLevel: 'aal1',
    });

    await expect(
      controller.refreshToken(
        { cookies: { refresh_token: 'cookie-refresh' } } as any,
        undefined as any,
        res as any,
      ),
    ).resolves.toBe(tokenResult);
    expect(authService.refreshToken).toHaveBeenCalledWith('cookie-refresh');
  });

  it('rejects refresh requests without a body or cookie token', async () => {
    const { authService, res, controller } = setup();

    await expect(
      controller.refreshToken({ cookies: {} } as any, {} as any, res as any),
    ).rejects.toThrow(BadRequestException);
    expect(authService.refreshToken).not.toHaveBeenCalled();
  });

  it('sets an MFA pending cookie after refresh when the rotated session still needs step-up', async () => {
    const { authService, res, controller } = setup();
    authService.refreshToken.mockResolvedValue(tokenResult);
    authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: true,
      currentLevel: 'aal1',
      nextLevel: 'aal2',
    });

    await expect(
      controller.refreshToken(
        { cookies: { refresh_token: 'cookie-refresh' } } as any,
        {} as any,
        res as any,
      ),
    ).resolves.toBe(tokenResult);

    expect(authService.getTokenMfaState).toHaveBeenCalledWith(
      tokenResult.access_token,
      { forceMfa: false },
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'mfa_pending',
      'true',
      expect.objectContaining({ path: '/' }),
    );
  });

  it('refreshes browser navigation and redirects back to an allowlisted URL', async () => {
    const { authService, res, controller } = setup();
    authService.refreshToken.mockResolvedValue(tokenResult);
    authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: false,
      currentLevel: 'aal1',
      nextLevel: 'aal1',
    });

    await controller.refreshForBrowser(
      { cookies: { refresh_token: 'cookie-refresh' } } as any,
      'https://app.test/spaces/DEFAULT/tasks',
      res as any,
    );

    expect(authService.refreshToken).toHaveBeenCalledWith('cookie-refresh');
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      tokenResult.access_token,
      expect.any(Object),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://app.test/spaces/DEFAULT/tasks',
    );
  });

  it('redirects browser refresh failures to login with a safe returnUrl', async () => {
    const { authService, res, controller } = setup();

    await controller.refreshForBrowser(
      { cookies: {} } as any,
      'https://evil.test/steal',
      res as any,
    );

    expect(authService.refreshToken).not.toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalledWith(
      'access_token',
      expect.any(Object),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'mfa_pending',
      expect.objectContaining({ path: '/' }),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://app.test/auth/login?returnUrl=https%3A%2F%2Fapp.test',
    );
  });

  it('keeps the cookies and answers 503 when Auth is briefly unavailable (no logout)', async () => {
    const { authService, res, controller } = setup();
    authService.refreshToken.mockRejectedValue(
      new ServiceUnavailableException('down'),
    );

    await controller.refreshForBrowser(
      { cookies: { refresh_token: 'cookie-refresh' } } as any,
      'https://app.test/spaces/DEFAULT/tasks',
      res as any,
    );

    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('transfers an existing cookie session to an allowlisted published URL', async () => {
    const { authService, res, controller } = setup();
    authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: false,
      currentLevel: 'aal2',
      nextLevel: 'aal2',
    });

    await controller.transferSession(
      {
        cookies: {
          access_token: 'cookie-access',
          refresh_token: 'cookie-refresh',
        },
      } as any,
      'https://tenant.app.test/page?x=1',
      res as any,
    );

    expect(authService.getTokenMfaState).toHaveBeenCalledWith('cookie-access', {
      forceMfa: false,
    });
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://tenant.app.test/page?x=1#access_token=cookie-access&type=session',
    );
  });

  it('refreshes during transfer when only the refresh cookie is available', async () => {
    const { authService, res, controller } = setup();
    authService.refreshToken.mockResolvedValue(tokenResult);
    authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: false,
      currentLevel: 'aal2',
      nextLevel: 'aal2',
    });

    await controller.transferSession(
      { cookies: { refresh_token: 'cookie-refresh' } } as any,
      'https://tenant.app.test/page',
      res as any,
    );

    expect(authService.refreshToken).toHaveBeenCalledWith('cookie-refresh');
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      tokenResult.access_token,
      expect.any(Object),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://tenant.app.test/page#access_token=access-token&type=session',
    );
  });

  it('refreshes and retries transfer when the access cookie is stale', async () => {
    const { authService, res, controller } = setup();
    authService.getTokenMfaState
      .mockRejectedValueOnce(new Error('JWT expired'))
      .mockResolvedValueOnce({
        mfaRequired: false,
        currentLevel: 'aal2',
        nextLevel: 'aal2',
      });
    authService.refreshToken.mockResolvedValue(tokenResult);

    await controller.transferSession(
      {
        cookies: {
          access_token: 'stale-access',
          refresh_token: 'cookie-refresh',
        },
      } as any,
      'https://tenant.app.test/page',
      res as any,
    );

    expect(authService.getTokenMfaState).toHaveBeenNthCalledWith(
      1,
      'stale-access',
      { forceMfa: false },
    );
    expect(authService.refreshToken).toHaveBeenCalledWith('cookie-refresh');
    expect(authService.getTokenMfaState).toHaveBeenNthCalledWith(
      2,
      tokenResult.access_token,
      { forceMfa: false },
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      tokenResult.access_token,
      expect.any(Object),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://tenant.app.test/page#access_token=access-token&type=session',
    );
  });

  it('allows verified Site Studio custom-domain transfer return URLs', async () => {
    const {
      authService,
      authGetUser,
      domainQuery,
      membershipQuery,
      res,
      controller,
    } = setup();
    domainQuery.maybeSingle
      .mockResolvedValueOnce({
        data: { id: 'domain-1' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'domain-1' },
        error: null,
      });
    authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: false,
      currentLevel: 'aal2',
      nextLevel: 'aal2',
    });
    authService.getProfile.mockResolvedValue({ id: 'user-1' });
    membershipQuery.maybeSingle.mockResolvedValue({
      data: { organization_id: 'org-1' },
      error: null,
    });

    await controller.transferSession(
      { cookies: { access_token: 'cookie-access' } } as any,
      'https://published.example/page',
      res as any,
    );

    expect(authGetUser).toHaveBeenCalledWith('cookie-access');
    expect(authService.getProfile).toHaveBeenCalledWith('auth-user-1');
    expect(membershipQuery.eq).toHaveBeenCalledWith('user_id', 'user-1');
    expect(domainQuery.eq).toHaveBeenCalledWith('domain', 'published.example');
    expect(domainQuery.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://published.example/page#access_token=cookie-access&type=session',
    );
  });

  function setupPublishedTransfer(
    configOverrides: Record<string, unknown> = {},
  ) {
    const result = setup({
      frontendUrl: 'http://auth.lvh.me:3000',
      appUrl: 'http://app.lvh.me:3000',
      allowedOrigins: ['http://auth.lvh.me:3000'],
      'cookies.domain': '.lvh.me',
      ...configOverrides,
    });
    result.funnelQuery.maybeSingle.mockResolvedValue({
      data: { organization_id: 'amber-org' },
      error: null,
    });
    result.authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: false,
    });
    result.authService.getProfile.mockResolvedValue({ id: 'user-1' });
    // Model a user whose first membership is ABJ. Only an explicit Amber
    // membership filter can authorize this funnel.
    result.membershipQuery.maybeSingle.mockImplementation(() =>
      Promise.resolve({
        data: {
          organization_id: result.membershipQuery.eq.mock.calls.some(
            ([column, value]) =>
              column === 'organization_id' && value === 'amber-org',
          )
            ? 'amber-org'
            : 'abj-org',
        },
        error: null,
      }),
    );
    return result;
  }

  it('transfers to the published funnel using its membership rather than the first organization', async () => {
    const { domainQuery, funnelQuery, membershipQuery, res, controller } =
      setupPublishedTransfer();

    await controller.transferSession(
      { cookies: { access_token: 'cookie-access' } } as any,
      'http://publicservicedesk-zrcou6.lvh.me:3000/service-request?source=login',
      res as any,
    );

    expect(funnelQuery.or).toHaveBeenCalledWith(
      'sub_domain_name.eq.publicservicedesk-zrcou6,preview_subdomain.eq.publicservicedesk-zrcou6',
    );
    expect(funnelQuery.eq).toHaveBeenCalledWith('published', true);
    expect(membershipQuery.eq).toHaveBeenCalledWith(
      'organization_id',
      'amber-org',
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'http://publicservicedesk-zrcou6.lvh.me:3000/service-request?source=login#access_token=cookie-access&type=session',
    );
    expect(domainQuery.maybeSingle).not.toHaveBeenCalled();
  });

  it.each([
    'unknown',
    'unpublished',
    'lookup error',
    'lookup throws',
    'cross organization',
    'membership error',
    'membership throws',
    'session error',
    'profile error',
  ])(
    'rejects published transfer without leaking tokens: %s',
    async (failure) => {
      const {
        controller,
        res,
        funnelQuery,
        membershipQuery,
        authGetUser,
        authService,
      } = setupPublishedTransfer();
      if (failure === 'unknown' || failure === 'unpublished')
        funnelQuery.maybeSingle.mockResolvedValue({ data: null, error: null });
      if (failure === 'lookup error')
        funnelQuery.maybeSingle.mockResolvedValue({
          data: { organization_id: 'amber-org' },
          error: { message: 'failed' },
        });
      if (failure === 'lookup throws')
        funnelQuery.maybeSingle.mockRejectedValue(new Error('failed'));
      if (failure === 'cross organization')
        membershipQuery.maybeSingle.mockResolvedValue({
          data: null,
          error: null,
        });
      if (failure === 'membership error')
        membershipQuery.maybeSingle.mockResolvedValue({
          data: { organization_id: 'amber-org' },
          error: { message: 'failed' },
        });
      if (failure === 'membership throws')
        membershipQuery.maybeSingle.mockRejectedValue(new Error('failed'));
      if (failure === 'session error')
        authGetUser.mockResolvedValue({
          data: null,
          error: { message: 'expired' },
        });
      if (failure === 'profile error')
        authService.getProfile.mockRejectedValue(new Error('failed'));

      await controller.transferSession(
        { cookies: { access_token: 'cookie-access' } } as any,
        'http://publicservicedesk-zrcou6.lvh.me:3000/service-request',
        res as any,
      );

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        'http://auth.lvh.me:3000/auth/login',
      );
      expect(res.redirect).not.toHaveBeenCalledWith(
        302,
        expect.stringContaining('access_token'),
      );
    },
  );

  it.each([
    'http://publicservicedesk-zrcou6.lvh.me:3001/service-request',
    'https://publicservicedesk-zrcou6.lvh.me:3000/service-request',
    'http://nested.publicservicedesk-zrcou6.lvh.me:3000/service-request',
    'http://publicservicedesk-zrcou6.lvh.me.evil.test:3000/service-request',
    'http://bad_label.lvh.me:3000/service-request',
  ])(
    'rejects malformed or mismatched published origin %s',
    async (returnUrl) => {
      const { controller, res, funnelQuery } = setupPublishedTransfer();
      await controller.transferSession(
        { cookies: { access_token: 'cookie-access' } } as any,
        returnUrl,
        res as any,
      );
      expect(funnelQuery.maybeSingle).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(
        302,
        'http://auth.lvh.me:3000/auth/login',
      );
    },
  );

  it('does not infer a serving root from APP_URL on a public suffix', async () => {
    const { controller, res, funnelQuery } = setupPublishedTransfer({
      frontendUrl: 'https://app.co.uk',
      appUrl: 'https://app.co.uk',
      allowedOrigins: ['https://app.co.uk'],
      'cookies.domain': '',
    });
    await controller.transferSession(
      { cookies: { access_token: 'cookie-access' } } as any,
      'https://publicservicedesk-zrcou6.co.uk/service-request',
      res as any,
    );
    expect(funnelQuery.maybeSingle).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://app.co.uk/auth/login',
    );
  });

  it('preserves the published return URL for login when the session is missing', async () => {
    const { controller, res, authGetUser } = setupPublishedTransfer();
    const returnUrl =
      'http://publicservicedesk-zrcou6.lvh.me:3000/service-request';
    await controller.transferSession(
      { cookies: {} } as any,
      returnUrl,
      res as any,
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      `http://auth.lvh.me:3000/auth/login?returnUrl=${encodeURIComponent(returnUrl)}`,
    );
    expect(authGetUser).not.toHaveBeenCalled();
  });

  it('does not transfer a session to another organization custom domain', async () => {
    const { authService, domainQuery, membershipQuery, res, controller } =
      setup();
    domainQuery.maybeSingle
      .mockResolvedValueOnce({
        data: { id: 'domain-1' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: null,
      });
    authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: false,
      currentLevel: 'aal2',
      nextLevel: 'aal2',
    });
    authService.getProfile.mockResolvedValue({ id: 'user-1' });
    membershipQuery.maybeSingle.mockResolvedValue({
      data: { organization_id: 'org-1' },
      error: null,
    });

    await controller.transferSession(
      { cookies: { access_token: 'cookie-access' } } as any,
      'https://published.example/page',
      res as any,
    );

    expect(domainQuery.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://app.test/auth/login',
    );
    expect(res.redirect).not.toHaveBeenCalledWith(
      302,
      expect.stringContaining('#access_token='),
    );
  });

  it('rejects plaintext verified custom-domain transfer return URLs', async () => {
    const { authService, domainQuery, res, controller } = setup();
    domainQuery.maybeSingle.mockResolvedValueOnce({
      data: { id: 'domain-1' },
      error: null,
    });

    await controller.transferSession(
      { cookies: { access_token: 'cookie-access' } } as any,
      'http://published.example/page',
      res as any,
    );

    expect(authService.getTokenMfaState).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://app.test/auth/login',
    );
  });

  it('redirects MFA-required transfer sessions to TOTP verification', async () => {
    const { authService, res, controller } = setup();
    authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: true,
      currentLevel: 'aal1',
      nextLevel: 'aal2',
    });

    await controller.transferSession(
      { cookies: { access_token: 'cookie-access' } } as any,
      'https://tenant.app.test/page',
      res as any,
    );

    expect(res.cookie).toHaveBeenCalledWith(
      'mfa_pending',
      'true',
      expect.objectContaining({ path: '/' }),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://app.test/auth/verify-totp?returnUrl=https%3A%2F%2Ftenant.app.test%2Fpage',
    );
  });

  it('keeps transfer sessions on the TOTP gate when a pending step-up cookie exists', async () => {
    const { authService, res, controller } = setup();
    authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: true,
      currentLevel: 'aal1',
      nextLevel: 'aal2',
    });

    await controller.transferSession(
      {
        cookies: { access_token: 'cookie-access', mfa_pending: 'true' },
      } as any,
      'https://tenant.app.test/page',
      res as any,
    );

    expect(authService.getTokenMfaState).toHaveBeenCalledWith('cookie-access', {
      forceMfa: true,
    });
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://app.test/auth/verify-totp?returnUrl=https%3A%2F%2Ftenant.app.test%2Fpage',
    );
  });

  it('rejects unsafe transfer return URLs without leaking tokens', async () => {
    const { authService, res, controller } = setup();

    await controller.transferSession(
      {
        cookies: {
          access_token: 'cookie-access',
          refresh_token: 'cookie-refresh',
        },
      } as any,
      'https://evil.test/steal',
      res as any,
    );

    expect(authService.getTokenMfaState).not.toHaveBeenCalled();
    expect(authService.refreshToken).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://app.test/auth/login',
    );
  });

  it('resends verification emails only when a local OTP is generated', async () => {
    const { authService, mailService, controller } = setup();
    authService.resendVerification.mockResolvedValue({ otp: '112233' });

    await expect(
      controller.resendVerification({ email: body.email }),
    ).resolves.toEqual({ message: 'Verification email sent successfully' });
    expect(mailService.sendVerificationOtp).toHaveBeenCalledWith(
      body.email,
      '112233',
    );

    authService.resendVerification.mockResolvedValueOnce({});
    await expect(
      controller.resendVerification({ email: body.email }),
    ).rejects.toThrow(BadRequestException);
  });

  it('does not send a second Nodemailer OTP when Supabase already delivered verification', async () => {
    const { authService, mailService, controller } = setup();
    authService.resendVerification.mockResolvedValue({
      deliveredBySupabase: true,
    });

    await expect(
      controller.resendVerification({ email: body.email }),
    ).resolves.toEqual({ message: 'Verification email sent successfully' });
    expect(mailService.sendVerificationOtp).not.toHaveBeenCalled();
  });

  it('clears cookies and passes the current JWT to global signout when everywhere=true', async () => {
    const { authService, res, controller } = setup();

    await expect(
      controller.signout(
        user as any,
        {
          headers: { authorization: 'Bearer header-jwt' },
          cookies: { access_token: 'cookie-jwt' },
        } as any,
        res as any,
        'true',
      ),
    ).resolves.toEqual({
      message: 'Signed out everywhere',
    });
    expect(authService.signout).toHaveBeenCalledWith('cookie-jwt', 'global');
    expect(res.clearCookie).toHaveBeenCalledWith(
      'access_token',
      expect.any(Object),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'refresh_token',
      expect.any(Object),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'mfa_pending',
      expect.objectContaining({ path: '/' }),
    );
  });

  it('falls back to the authorization header JWT when the access cookie is absent', async () => {
    const { authService, res, controller } = setup();

    await controller.signout(
      user as any,
      { headers: { authorization: 'Bearer header-jwt' }, cookies: {} } as any,
      res as any,
    );

    expect(authService.signout).toHaveBeenCalledWith('header-jwt', 'local');
  });

  it('sets mfa_pending after code exchange when the returned session requires TOTP', async () => {
    const { authService, res, controller } = setup();
    authService.exchangeCodeForSession.mockResolvedValue(tokenResult);
    authService.getTokenMfaState.mockResolvedValue({
      mfaRequired: true,
      currentLevel: 'aal1',
      nextLevel: 'aal2',
    });

    await expect(
      controller.exchangeCode({ code: 'auth-code' } as any, res as any),
    ).resolves.toBe(tokenResult);

    expect(authService.getTokenMfaState).toHaveBeenCalledWith(
      tokenResult.access_token,
      { forceMfa: false },
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'mfa_pending',
      'true',
      expect.objectContaining({ path: '/' }),
    );
  });
});
