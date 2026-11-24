import { PasskeysController } from './passkeys.controller';

describe('PasskeysController', () => {
  function setup() {
    const service = {
      startRegistration: jest.fn(),
      verifyRegistration: jest.fn(),
      trustCurrentDeviceAfterEnrollment: jest.fn().mockResolvedValue(null),
      startAuthentication: jest.fn(),
      verifyAuthentication: jest.fn(),
      listPasskeys: jest.fn(),
      renamePasskey: jest.fn(),
      deletePasskey: jest.fn(),
      finalizeTrustedDevice: jest.fn(),
      getTrustedDeviceCookieName: jest.fn(() => 'auth_passkey_trusted_device'),
      getPendingTrustedDeviceCookieName: jest.fn(
        () => 'auth_passkey_pending_device',
      ),
      getTrustedDeviceMaxAgeSeconds: jest.fn(() => 90 * 24 * 60 * 60),
      getPendingTrustedDeviceMaxAgeSeconds: jest.fn(() => 10 * 60),
      getAssuranceCookieName: jest.fn(() => 'auth_assurance'),
      getAssuranceCookieMaxAgeSeconds: jest.fn(() => 15 * 60),
    };
    const configService = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          cookies: {
            domain: '.xisuite.cloud',
            secure: true,
            sameSite: 'lax',
            accessMaxAge: 3600,
            refreshMaxAge: 604800,
          },
          'passkeys.origin': 'https://auth.xisuite.cloud',
          'passkeys.countryHeader': 'x-vercel-ip-country',
        };

        return values[key];
      }),
    };
    const controller = new PasskeysController(
      service as never,
      configService as never,
    );
    const res = {
      cookie: jest.fn().mockReturnThis(),
      clearCookie: jest.fn().mockReturnThis(),
    };

    return { controller, service, res };
  }

  /** Minimal successful sign-in result, for tests asserting on inputs only. */
  function signinResultFixture() {
    return {
      tokens: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
      },
      response: {
        mfaRequired: false,
        currentLevel: 'aal1',
        nextLevel: 'aal2',
        authenticationMethod: 'passkey',
        user: {
          id: 'user-1',
          email: 'user@example.com',
          first_name: 'Aisha',
          last_name: 'Khan',
        },
      },
      cookies: {
        trustedDeviceValue: 'trusted-device-token',
        pendingTrustedDeviceValue: null,
        assuranceValue: 'signed-assurance',
      },
    };
  }

  it('writes auth cookies and a trusted-device cookie on low-risk sign-in', async () => {
    const { controller, service, res } = setup();
    service.verifyAuthentication.mockResolvedValue({
      tokens: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
      },
      response: {
        mfaRequired: false,
        currentLevel: 'aal1',
        nextLevel: 'aal2',
        authenticationMethod: 'passkey',
        user: {
          id: 'user-1',
          email: 'user@example.com',
          first_name: 'Aisha',
          last_name: 'Khan',
        },
      },
      cookies: {
        trustedDeviceValue: 'trusted-device-token',
        pendingTrustedDeviceValue: null,
        assuranceValue: 'signed-assurance',
      },
    });

    const result = await controller.verifyAuthentication(
      {
        headers: {
          origin: 'https://auth.xisuite.cloud',
          'user-agent': 'Mozilla/5.0',
        },
        cookies: {},
      } as never,
      {
        challengeId: 'challenge-1',
        credential: {
          id: 'credential-1',
          type: 'public-key',
          response: {
            clientDataJSON:
              'eyJvcmlnaW4iOiJodHRwczovL2F1dGgueGlzdWl0ZS5jbG91ZCIsInR5cGUiOiJ3ZWJhdXRobi5nZXQifQ',
            authenticatorData: 'AAAA',
            signature: 'sig',
          },
        },
      } as never,
      res as never,
    );

    expect(result).toMatchObject({
      mfaRequired: false,
      currentLevel: 'aal1',
      authenticationMethod: 'passkey',
    });
    expect(result).not.toHaveProperty('access_token');
    expect(res.cookie).toHaveBeenCalledWith(
      'access_token',
      'access-token',
      expect.any(Object),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'auth_passkey_trusted_device',
      'trusted-device-token',
      expect.any(Object),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'mfa_pending',
      expect.any(Object),
    );
  });

  it('writes mfa_pending and pending-device cookies on high-risk sign-in', async () => {
    const { controller, service, res } = setup();
    service.verifyAuthentication.mockResolvedValue({
      tokens: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
      },
      response: {
        mfaRequired: true,
        currentLevel: 'aal1',
        nextLevel: 'aal2',
        user: {
          id: 'user-1',
          email: 'user@example.com',
          first_name: 'Aisha',
          last_name: 'Khan',
        },
      },
      cookies: {
        trustedDeviceValue: null,
        pendingTrustedDeviceValue: 'pending-device-state',
        assuranceValue: null,
      },
    });

    await controller.verifyAuthentication(
      {
        headers: {
          origin: 'https://auth.xisuite.cloud',
          'user-agent': 'Mozilla/5.0',
        },
        cookies: {},
      } as never,
      {
        challengeId: 'challenge-1',
        credential: {
          id: 'credential-1',
          type: 'public-key',
          response: {
            clientDataJSON:
              'eyJvcmlnaW4iOiJodHRwczovL2F1dGgueGlzdWl0ZS5jbG91ZCIsInR5cGUiOiJ3ZWJhdXRobi5nZXQifQ',
            authenticatorData: 'AAAA',
            signature: 'sig',
          },
        },
      } as never,
      res as never,
    );

    expect(res.cookie).toHaveBeenCalledWith(
      'mfa_pending',
      'true',
      expect.any(Object),
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'auth_passkey_pending_device',
      'pending-device-state',
      expect.any(Object),
    );
  });

  it('degrades a malformed proxy-owned country header to null instead of blocking sign-in', async () => {
    // A missing country is deliberately neutral, so an unparseable one must be
    // too. Real edges emit values that are not two letters — Vercel sends `T1`
    // for Tor exit nodes — and those users must still be able to log in. We
    // lose the risk signal, we do not lose the account.
    const { controller, service, res } = setup();

    service.verifyAuthentication.mockResolvedValue(signinResultFixture());

    await controller.verifyAuthentication(
      {
        headers: {
          origin: 'https://auth.xisuite.cloud',
          'x-vercel-ip-country': 'T1',
        },
        cookies: {},
      } as never,
      {} as never,
      res as never,
    );

    expect(service.verifyAuthentication).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ countryCode: null }),
    );
  });

  it('rejects passkey management requests from a non-canonical origin', async () => {
    const { controller, service } = setup();

    await expect(
      controller.listPasskeys({
        headers: {
          origin: 'https://tenant.xisuite.cloud',
        },
        cookies: {
          access_token: 'access-token',
        },
      } as never),
    ).rejects.toThrow('Invalid passkey origin');

    expect(service.listPasskeys).not.toHaveBeenCalled();
  });

  it('accepts same-origin passkey management requests via referer fallback', async () => {
    const { controller, service } = setup();
    service.listPasskeys.mockResolvedValue([{ id: 'passkey-1' }]);

    await expect(
      controller.listPasskeys({
        headers: {
          referer: 'https://auth.xisuite.cloud/auth/passkeys/manage',
        },
        cookies: {
          access_token: 'access-token',
        },
      } as never),
    ).resolves.toEqual([{ id: 'passkey-1' }]);
  });

  it('forwards registration options with bearer-token precedence', async () => {
    const { controller, service } = setup();
    service.startRegistration.mockResolvedValue({
      challengeId: 'challenge-1',
    });

    await expect(
      controller.startRegistration({
        headers: {
          origin: 'https://auth.xisuite.cloud',
          authorization: 'Bearer header-token',
        },
        cookies: { access_token: 'cookie-token' },
      } as never),
    ).resolves.toEqual({ challengeId: 'challenge-1' });
    expect(service.startRegistration).toHaveBeenCalledWith(
      'header-token',
      'https://auth.xisuite.cloud',
    );
  });

  it('forwards registration verification using the cookie session', async () => {
    const { controller, service, res } = setup();
    const body = { challengeId: 'challenge-1', credential: {} };
    service.verifyRegistration.mockResolvedValue({ id: 'passkey-1' });
    service.trustCurrentDeviceAfterEnrollment.mockResolvedValue(
      'trusted-device-token',
    );

    await expect(
      controller.verifyRegistration(
        {
          headers: {
            origin: 'https://auth.xisuite.cloud',
            'x-vercel-ip-country': 'IN',
          },
          cookies: {
            access_token: 'cookie-token',
            auth_passkey_trusted_device: 'current-device-token',
          },
        } as never,
        body as never,
        res as never,
      ),
    ).resolves.toEqual({ id: 'passkey-1' });
    expect(service.verifyRegistration).toHaveBeenCalledWith(
      body,
      'cookie-token',
      'https://auth.xisuite.cloud',
    );
    expect(service.trustCurrentDeviceAfterEnrollment).toHaveBeenCalledWith({
      accessToken: 'cookie-token',
      currentTrustedDeviceCookie: 'current-device-token',
      countryCode: 'IN',
    });
    expect(res.cookie).toHaveBeenCalledWith(
      'auth_passkey_trusted_device',
      'trusted-device-token',
      expect.any(Object),
    );
  });

  it('requires an exact Origin header for public authentication options', async () => {
    const { controller, service } = setup();
    service.startAuthentication.mockResolvedValue({
      challengeId: 'challenge-1',
    });

    await expect(
      controller.startAuthentication({
        headers: { origin: 'https://auth.xisuite.cloud' },
      } as never),
    ).resolves.toEqual({ challengeId: 'challenge-1' });
    expect(service.startAuthentication).toHaveBeenCalledWith(
      'https://auth.xisuite.cloud',
    );

    service.startAuthentication.mockRejectedValueOnce(
      new Error('Passkey origin mismatch'),
    );
    await expect(
      controller.startAuthentication({
        headers: { referer: 'https://auth.xisuite.cloud/login' },
      } as never),
    ).rejects.toThrow('Passkey origin mismatch');
  });

  it('passes normalized proxy country and trusted-device state to verification', async () => {
    const { controller, service, res } = setup();
    service.verifyAuthentication.mockResolvedValue({
      tokens: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
      },
      response: { mfaRequired: false },
      cookies: {
        trustedDeviceValue: null,
        pendingTrustedDeviceValue: null,
        assuranceValue: null,
      },
    });

    await controller.verifyAuthentication(
      {
        headers: {
          origin: 'https://auth.xisuite.cloud',
          'x-vercel-ip-country': ' in ',
        },
        cookies: {
          auth_passkey_trusted_device: 'trusted-device-token',
          auth_passkey_pending_device: 'pending-device-state',
        },
      } as never,
      { challengeId: 'challenge-1' } as never,
      res as never,
    );

    expect(service.verifyAuthentication).toHaveBeenCalledWith(
      { challengeId: 'challenge-1' },
      {
        origin: 'https://auth.xisuite.cloud',
        trustedDeviceCookie: 'trusted-device-token',
        pendingTrustedDeviceCookie: 'pending-device-state',
        countryCode: 'IN',
      },
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'auth_passkey_trusted_device',
      expect.objectContaining({ path: '/' }),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      'auth_assurance',
      expect.objectContaining({ path: '/' }),
    );
  });

  it('finalizes trusted-device state and rotates passkey cookies', async () => {
    const { controller, service, res } = setup();
    service.finalizeTrustedDevice.mockResolvedValue({
      trustedDeviceValue: 'trusted-device-token',
      pendingTrustedDeviceValue: 'pending-state-for-the-other-account',
      assuranceValue: 'signed-assurance',
    });

    await expect(
      controller.finalizeTrustedDevice(
        {
          headers: { origin: 'https://auth.xisuite.cloud' },
          cookies: {
            access_token: 'aal2-token',
            auth_passkey_pending_device: 'pending-state',
            auth_passkey_trusted_device: 'trusted-device-map',
          },
        } as never,
        res as never,
      ),
    ).resolves.toEqual({ success: true });
    expect(service.finalizeTrustedDevice).toHaveBeenCalledWith(
      'aal2-token',
      'pending-state',
      'trusted-device-map',
    );
    expect(res.cookie).toHaveBeenCalledWith(
      'auth_passkey_trusted_device',
      'trusted-device-token',
      expect.any(Object),
    );
    // The other account's pending step-up survives this account's finalize.
    expect(res.cookie).toHaveBeenCalledWith(
      'auth_passkey_pending_device',
      'pending-state-for-the-other-account',
      expect.any(Object),
    );
  });

  it('forwards rename and delete operations and returns a stable delete shape', async () => {
    const { controller, service } = setup();
    const request = {
      headers: { origin: 'https://auth.xisuite.cloud' },
      cookies: { access_token: 'access-token' },
    } as never;
    service.renamePasskey.mockResolvedValue({ id: 'passkey-1' });
    service.deletePasskey.mockResolvedValue(undefined);

    await expect(
      controller.renamePasskey(request, 'passkey-1', {
        friendlyName: 'Work key',
      }),
    ).resolves.toEqual({ id: 'passkey-1' });
    expect(service.renamePasskey).toHaveBeenCalledWith(
      'access-token',
      'passkey-1',
      'Work key',
    );

    await expect(
      controller.deletePasskey(request, 'passkey-1'),
    ).resolves.toEqual({ success: true });
    expect(service.deletePasskey).toHaveBeenCalledWith(
      'access-token',
      'passkey-1',
    );
  });

  it('rejects missing sessions, malformed referers, and array country headers', async () => {
    const { controller, service, res } = setup();

    await expect(
      controller.listPasskeys({
        headers: { origin: 'https://auth.xisuite.cloud' },
        cookies: {},
      } as never),
    ).rejects.toThrow('access_token missing');

    await expect(
      controller.listPasskeys({
        headers: { referer: 'not a url' },
        cookies: { access_token: 'access-token' },
      } as never),
    ).rejects.toThrow('Invalid passkey origin');

    // A duplicated country header is untrustworthy, but it must degrade to null
    // rather than block sign-in — same rationale as a malformed value.
    service.verifyAuthentication.mockResolvedValue(signinResultFixture());

    await controller.verifyAuthentication(
      {
        headers: {
          origin: 'https://auth.xisuite.cloud',
          'x-vercel-ip-country': ['IN'],
        },
        cookies: {},
      } as never,
      {} as never,
      res as never,
    );

    expect(service.verifyAuthentication).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ countryCode: null }),
    );
  });
});
