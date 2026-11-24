import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { PasskeysService } from './passkeys.service';

type RiskResult = {
  level: string;
  reasons: string[];
  trustedDeviceId: string | null;
  trustedDeviceValue: string | null;
  pendingTrustedDeviceValue: string | null;
};

/** Decodes the payload half of any `${base64url(json)}.${hmac}` cookie value. */
function readSignedPayload(value: string | null): Record<string, unknown> {
  const [body] = (value ?? '').split('.');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function hashTrustedDeviceToken(token: string): string {
  return createHmac('sha256', 'x'.repeat(32)).update(token).digest('base64url');
}

function evaluateRisk(
  service: PasskeysService,
  input: Record<string, unknown>,
): Promise<RiskResult> {
  return (
    service as unknown as {
      evaluateRisk(input: Record<string, unknown>): Promise<RiskResult>;
    }
  ).evaluateRisk(input);
}

describe('PasskeysService', () => {
  function createAccessToken(
    amr: Array<{ method: string; timestamp: number }>,
  ) {
    return [
      'header',
      Buffer.from(JSON.stringify({ aal: 'aal1', amr }), 'utf8').toString(
        'base64url',
      ),
      'sig',
    ].join('.');
  }

  function createManagementToken(
    amr: Array<{ method: string; timestamp: number }> = [
      { method: 'totp', timestamp: Math.floor(Date.now() / 1000) },
    ],
  ) {
    return [
      'header',
      Buffer.from(
        JSON.stringify({
          sub: 'auth-user-1',
          session_id: 'session-1',
          exp: Math.floor(Date.now() / 1000) + 3600,
          aal: 'aal2',
          amr,
        }),
        'utf8',
      ).toString('base64url'),
      'sig',
    ].join('.');
  }

  function registrationCredential(flags = 0x05) {
    const authData = new Uint8Array(37);
    authData[32] = flags;
    return {
      id: 'credential-1',
      type: 'public-key' as const,
      response: {
        clientDataJSON: Buffer.from(
          JSON.stringify({
            type: 'webauthn.create',
            origin: 'https://auth.xisuite.cloud',
            crossOrigin: false,
          }),
        ).toString('base64url'),
        attestationObject: Buffer.concat([
          Buffer.from([0xa3, 0x63]),
          Buffer.from('fmt'),
          Buffer.from([0x64]),
          Buffer.from('none'),
          Buffer.from([0x67]),
          Buffer.from('attStmt'),
          Buffer.from([0xa0, 0x68]),
          Buffer.from('authData'),
          Buffer.from([0x58, authData.length]),
          Buffer.from(authData),
        ]).toString('base64url'),
      },
    };
  }

  function createService() {
    const getClient = jest.fn();
    const supabaseAdmin = { getClient };
    const usersService = { getUserByAuthUserId: jest.fn() };
    const configService = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          'passkeys.enabled': true,
          'passkeys.origin': 'https://auth.xisuite.cloud',
          'passkeys.trustedDeviceSecret': 'x'.repeat(32),
          'passkeys.trustedDeviceTtlDays': 90,
          'passkeys.recentTotpSeconds': 600,
          'passkeys.maxPerUser': 10,
          'supabase.url': 'https://project.supabase.co',
          'supabase.anonKey': 'anon-key',
        };
        return values[key];
      }),
    };
    const onPremiseTenant = { ensureDefaultMembership: jest.fn() };
    const mailService = {
      sendNotification: jest.fn().mockResolvedValue(undefined),
    };
    const sessionAssurance = {
      isSessionAssured: jest.fn().mockResolvedValue(false),
      countVerifiedPasskeys: jest.fn().mockResolvedValue(0),
    };

    const service = new PasskeysService(
      supabaseAdmin as never,
      usersService as never,
      configService as ConfigService,
      onPremiseTenant as never,
      mailService as never,
      sessionAssurance as never,
    );

    return {
      service,
      getClient,
      usersService,
      mailService,
      sessionAssurance,
    };
  }

  it('starts registration only for the configured origin', async () => {
    const { service } = createService();
    jest
      .spyOn(service as never, 'assertVerifiedTotpEnrollment')
      .mockResolvedValue({ id: 'auth-user-1' } as never);
    jest
      .spyOn(service as never, 'assertRecentTotp')
      .mockImplementation(() => {});
    jest.spyOn(service as never, 'gotrueRequest').mockResolvedValue({
      challenge_id: 'challenge-1',
      options: { rp: { id: 'xisuite.cloud' } },
      expires_at: 123,
    });

    await expect(
      service.startRegistration('jwt-token', 'https://auth.xisuite.cloud'),
    ).resolves.toMatchObject({ challengeId: 'challenge-1' });

    await expect(
      service.startRegistration('jwt-token', 'https://evil.example'),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects passkey enrollment until a verified TOTP factor exists', async () => {
    const { service } = createService();
    jest.spyOn(service as never, 'publicPasskeyClient').mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: { user: { id: 'auth-user-1', factors: [] } },
          error: null,
        }),
      },
    } as never);

    const error = await service
      .startRegistration('jwt-token', 'https://auth.xisuite.cloud')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'totp_enrollment_required',
    });
  });

  it('skips TOTP for a single-account user on a recognized trusted device', async () => {
    const { service, getClient, usersService } = createService();
    const trustedDeviceToken = 'trusted-device-token';
    const trustedDeviceCookie = service.signTrustedDeviceCookie({
      'auth-user-1': trustedDeviceToken,
    });
    const accessToken = createAccessToken([
      { method: 'passkey', timestamp: Math.floor(Date.now() / 1000) },
    ]);
    jest.spyOn(service as never, 'publicPasskeyClient').mockReturnValue({
      auth: {
        passkey: {
          verifyAuthentication: jest.fn().mockResolvedValue({
            data: {
              session: {
                access_token: accessToken,
                refresh_token: 'refresh-token',
                expires_in: 3600,
                token_type: 'bearer',
              },
              user: {
                id: 'auth-user-1',
                email: 'user@example.com',
              },
            },
            error: null,
          }),
        },
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'auth-user-1',
              factors: [{ factor_type: 'totp', status: 'verified' }],
            },
          },
          error: null,
        }),
      },
    } as never);
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-1',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        amr: [{ method: 'passkey', timestamp: Math.floor(Date.now() / 1000) }],
      });
    usersService.getUserByAuthUserId.mockResolvedValue({
      id: 'public-user-1',
      email: 'user@example.com',
      first_name: 'Aisha',
      last_name: 'Khan',
    });

    const trustedLookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: 'trusted-device-1', country_code: 'IN' },
        error: null,
      }),
    };
    const trustedUpdate = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    const memberships: {
      select: jest.Mock;
      eq: jest.Mock;
      order: jest.Mock;
    } = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn(),
    };
    memberships.order
      .mockImplementationOnce(() => memberships)
      .mockResolvedValueOnce({
        data: [
          {
            role: 'owner',
            organizations: {
              id: 'org-1',
              slug: 'ambertech',
              name: 'Ambertech',
              is_active: true,
            },
          },
        ],
        error: null,
      });
    const assurance = {
      upsert: jest.fn().mockResolvedValue({ error: null }),
    };
    const securityEvents = {
      insert: jest.fn().mockResolvedValue({ error: null }),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      limit: jest
        .fn()
        .mockResolvedValue({ data: [{ id: 'evt-1' }], error: null }),
    };

    getClient.mockReturnValue({
      from: jest.fn((table: string) => {
        if (table === 'auth_trusted_devices') {
          return trustedLookup.select.mock.calls.length === 0
            ? trustedLookup
            : trustedUpdate;
        }
        if (table === 'organization_members') return memberships;
        if (table === 'auth_session_assurance') return assurance;
        if (table === 'auth_security_events') return securityEvents;
        throw new Error(`Unexpected table ${table}`);
      }),
    });

    const result = await service.verifyAuthentication(
      {
        challengeId: 'challenge-1',
        credential: {
          id: 'credential-1',
          type: 'public-key',
          response: {
            clientDataJSON: Buffer.from(
              JSON.stringify({
                type: 'webauthn.get',
                origin: 'https://auth.xisuite.cloud',
                crossOrigin: false,
              }),
            ).toString('base64url'),
            authenticatorData: Buffer.from(
              new Uint8Array(Object.assign(new Uint8Array(37), { 32: 0x05 })),
            ).toString('base64url'),
            signature: 'signature',
          },
        },
      },
      {
        origin: 'https://auth.xisuite.cloud',
        countryCode: 'IN',
        trustedDeviceCookie,
      },
    );

    expect(result.response.mfaRequired).toBe(false);
    expect(result.response.currentLevel).toBe('aal1');
    expect(result.response.defaultOrganization).toMatchObject({
      slug: 'ambertech',
    });
    expect(readSignedPayload(result.cookies.trustedDeviceValue)).toEqual({
      'auth-user-1': trustedDeviceToken,
    });
    // Deterministic membership order: created_at, then a stable tiebreaker.
    expect(memberships.order).toHaveBeenNthCalledWith(1, 'created_at', {
      ascending: true,
    });
    expect(memberships.order).toHaveBeenNthCalledWith(2, 'organization_id', {
      ascending: true,
    });
  });

  it('keeps unknown-device passkey logins pending MFA', async () => {
    const { service, getClient, usersService, mailService } = createService();
    const accessToken = createAccessToken([
      { method: 'passkey', timestamp: Math.floor(Date.now() / 1000) },
    ]);
    jest.spyOn(service as never, 'publicPasskeyClient').mockReturnValue({
      auth: {
        passkey: {
          verifyAuthentication: jest.fn().mockResolvedValue({
            data: {
              session: {
                access_token: accessToken,
                refresh_token: 'refresh-token',
                expires_in: 3600,
                token_type: 'bearer',
              },
              user: { id: 'auth-user-1', email: 'user@example.com' },
            },
            error: null,
          }),
        },
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'auth-user-1',
              factors: [{ factor_type: 'totp', status: 'verified' }],
            },
          },
          error: null,
        }),
      },
    } as never);
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-1',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        amr: [{ method: 'passkey', timestamp: Math.floor(Date.now() / 1000) }],
      });
    usersService.getUserByAuthUserId.mockResolvedValue({
      id: 'public-user-1',
      email: 'user@example.com',
      first_name: 'Aisha',
      last_name: 'Khan',
    });

    const trustedLookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    const memberships: {
      select: jest.Mock;
      eq: jest.Mock;
      order: jest.Mock;
    } = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn(),
    };
    memberships.order
      .mockImplementationOnce(() => memberships)
      .mockResolvedValueOnce({ data: [], error: null });
    const assurance = { upsert: jest.fn().mockResolvedValue({ error: null }) };
    const securityEvents = {
      insert: jest.fn().mockResolvedValue({ error: null }),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      limit: jest
        .fn()
        .mockResolvedValue({ data: [{ id: 'evt-1' }], error: null }),
    };

    getClient.mockReturnValue({
      from: jest.fn((table: string) => {
        if (table === 'auth_trusted_devices') return trustedLookup;
        if (table === 'organization_members') return memberships;
        if (table === 'auth_session_assurance') return assurance;
        if (table === 'auth_security_events') return securityEvents;
        throw new Error(`Unexpected table ${table}`);
      }),
    });

    const result = await service.verifyAuthentication(
      {
        challengeId: 'challenge-1',
        credential: {
          id: 'credential-1',
          type: 'public-key',
          response: {
            clientDataJSON: Buffer.from(
              JSON.stringify({
                type: 'webauthn.get',
                origin: 'https://auth.xisuite.cloud',
                crossOrigin: false,
              }),
            ).toString('base64url'),
            authenticatorData: Buffer.from(
              new Uint8Array(Object.assign(new Uint8Array(37), { 32: 0x05 })),
            ).toString('base64url'),
            signature: 'signature',
          },
        },
      },
      {
        origin: 'https://auth.xisuite.cloud',
        countryCode: 'US',
      },
    );

    expect(result.response.mfaRequired).toBe(true);
    expect(result.response.currentLevel).toBe('aal1');
    expect(result.cookies.pendingTrustedDeviceValue).toBeTruthy();
    expect(mailService.sendNotification).toHaveBeenCalled();
    const [[email, notification]] = mailService.sendNotification.mock
      .calls as unknown as Array<[string, { body: string }]>;
    expect(email).toBe('user@example.com');
    expect(notification.body).toContain(
      'A passkey sign-in requires your MFA app code before access is granted.',
    );
    expect(notification.body).not.toContain('Country: US');
  });

  it('rejects registration verification when UV is missing', async () => {
    const { service } = createService();
    jest
      .spyOn(service as never, 'assertVerifiedTotpEnrollment')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as never, 'assertRecentTotp')
      .mockImplementation(() => {});

    await expect(
      service.verifyRegistration(
        {
          challengeId: 'challenge-1',
          friendlyName: 'Work laptop',
          credential: {
            id: 'credential-1',
            type: 'public-key',
            response: {
              clientDataJSON: Buffer.from(
                JSON.stringify({
                  type: 'webauthn.create',
                  origin: 'https://auth.xisuite.cloud',
                }),
              ).toString('base64url'),
              attestationObject: Buffer.from([
                0xa3,
                0x63,
                0x66,
                0x6d,
                0x74,
                0x64,
                0x6e,
                0x6f,
                0x6e,
                0x65,
                0x67,
                0x61,
                0x74,
                0x74,
                0x53,
                0x74,
                0x6d,
                0x74,
                0xa0,
                0x68,
                0x61,
                0x75,
                0x74,
                0x68,
                0x44,
                0x61,
                0x74,
                0x61,
                0x58,
                0x25,
                ...new Uint8Array(
                  Object.assign(new Uint8Array(37), { 32: 0x01 }),
                ),
              ]).toString('base64url'),
            },
          },
        },
        'jwt-token',
        'https://auth.xisuite.cloud',
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('requires aal2 before finalizing a trusted device', async () => {
    const { service } = createService();
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-1',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        aal: 'aal1',
        amr: [{ method: 'passkey', timestamp: Math.floor(Date.now() / 1000) }],
      });

    await expect(
      service.finalizeTrustedDevice(
        'aal1-passkey-token',
        service.signPendingTrustedDeviceCookie({
          authUserId: 'auth-user-1',
          publicUserId: 'public-user-1',
          sessionId: 'session-1',
          token: 'trusted-device-token',
          countryCode: 'IN',
          issuedAt: Date.now(),
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('binds trusted-device finalization to the stepped-up passkey session', async () => {
    const { service, getClient } = createService();
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-1',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        aal: 'aal2',
        amr: [
          { method: 'passkey', timestamp: Math.floor(Date.now() / 1000) },
          { method: 'totp', timestamp: Math.floor(Date.now() / 1000) },
        ],
      });

    const trustedLookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      maybeSingle: jest
        .fn()
        .mockResolvedValue({ data: { id: 'trusted-device-1' }, error: null }),
    };
    const trustedUpdate = {
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    const assuranceUpdate = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest
        .fn()
        .mockResolvedValue({ data: { session_id: 'session-1' }, error: null }),
    };
    const securityEvents = {
      insert: jest.fn().mockResolvedValue({ error: null }),
    };

    getClient.mockReturnValue({
      from: jest.fn((table: string) => {
        if (table === 'auth_trusted_devices') {
          return trustedLookup.select.mock.calls.length === 0
            ? trustedLookup
            : { ...trustedLookup, ...trustedUpdate };
        }
        if (table === 'auth_session_assurance') return assuranceUpdate;
        if (table === 'auth_security_events') return securityEvents;
        throw new Error(`Unexpected table ${table}`);
      }),
    });

    const pending = service.signPendingTrustedDeviceCookie({
      authUserId: 'auth-user-1',
      publicUserId: 'public-user-1',
      sessionId: 'session-1',
      token: 'trusted-device-token-that-is-long-enough',
      countryCode: 'IN',
      issuedAt: Date.now(),
    });

    const finalized = await service.finalizeTrustedDevice(
      'aal2-token',
      pending,
    );
    expect(readSignedPayload(finalized.trustedDeviceValue)).toEqual({
      'auth-user-1': 'trusted-device-token-that-is-long-enough',
    });
    expect(finalized.pendingTrustedDeviceValue).toBeNull();
    expect(typeof finalized.assuranceValue).toBe('string');
    expect(trustedLookup.select).toHaveBeenCalledWith('id');
    expect(assuranceUpdate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        risk_level: 'low',
        risk_reasons: [],
        step_up_required: false,
      }),
    );
  });

  it('refreshes an existing trusted device after a successful country-change step-up', async () => {
    const { service, getClient } = createService();
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-1',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        aal: 'aal2',
        amr: [
          { method: 'passkey', timestamp: Math.floor(Date.now() / 1000) },
          { method: 'totp', timestamp: Math.floor(Date.now() / 1000) },
        ],
      });

    const trustedLookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest
        .fn()
        .mockResolvedValue({ data: { id: 'trusted-device-1' }, error: null }),
      update: jest.fn().mockReturnThis(),
    };
    const trustedUpdate = {
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    const assuranceUpdate = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest
        .fn()
        .mockResolvedValue({ data: { session_id: 'session-1' }, error: null }),
    };
    const securityEvents = {
      insert: jest.fn().mockResolvedValue({ error: null }),
    };

    getClient.mockReturnValue({
      from: jest.fn((table: string) => {
        if (table === 'auth_trusted_devices') {
          return trustedLookup.select.mock.calls.length === 0
            ? trustedLookup
            : { ...trustedLookup, ...trustedUpdate };
        }
        if (table === 'auth_session_assurance') return assuranceUpdate;
        if (table === 'auth_security_events') return securityEvents;
        throw new Error(`Unexpected table ${table}`);
      }),
    });

    const pending = service.signPendingTrustedDeviceCookie({
      authUserId: 'auth-user-1',
      publicUserId: 'public-user-1',
      sessionId: 'session-1',
      token: 'trusted-device-token-that-is-long-enough',
      countryCode: 'US',
      issuedAt: Date.now(),
    });

    const finalized = await service.finalizeTrustedDevice(
      'aal2-token',
      pending,
    );
    expect(readSignedPayload(finalized.trustedDeviceValue)).toEqual({
      'auth-user-1': 'trusted-device-token-that-is-long-enough',
    });

    expect(trustedLookup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        country_code: 'US',
        revoked_at: null,
      }),
    );
    expect(trustedUpdate.eq).toHaveBeenCalledWith('id', 'trusted-device-1');
  });

  it('requires recent TOTP for rename operations', async () => {
    const { service } = createService();
    jest
      .spyOn(service as never, 'assertVerifiedTotpEnrollment')
      .mockResolvedValue(undefined);
    jest.spyOn(service as never, 'getRequiredTokenPayload').mockReturnValue({
      sub: 'auth-user-1',
      session_id: 'session-1',
      exp: Math.floor(Date.now() / 1000) + 3600,
      amr: [
        { method: 'totp', timestamp: Math.floor(Date.now() / 1000) - 7200 },
      ],
    });
    await expect(
      service.renamePasskey('header.payload.sig', 'passkey-id', 'Work key'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('starts authentication and maps the Supabase options response', async () => {
    const { service } = createService();
    const startAuthentication = jest.fn().mockResolvedValue({
      data: {
        challenge_id: 'challenge-1',
        options: { challenge: 'challenge', userVerification: 'required' },
        expires_at: 123,
      },
      error: null,
    });
    jest.spyOn(service as never, 'publicPasskeyClient').mockReturnValue({
      auth: { passkey: { startAuthentication } },
    } as never);

    await expect(
      service.startAuthentication('https://auth.xisuite.cloud'),
    ).resolves.toEqual({
      challengeId: 'challenge-1',
      options: { challenge: 'challenge', userVerification: 'required' },
      expiresAt: 123,
    });
    expect(startAuthentication).toHaveBeenCalledTimes(1);
  });

  it('trusts the enrollment browser with an opaque server-generated token', async () => {
    const { service, getClient } = createService();
    const accessToken = createManagementToken();
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-1',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        aal: 'aal2',
        amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }],
      });
    const devices = {
      insert: jest.fn().mockResolvedValue({ error: null }),
    };
    getClient.mockReturnValue({ from: jest.fn().mockReturnValue(devices) });

    const trustedDeviceCookie = await service.trustCurrentDeviceAfterEnrollment(
      {
        accessToken,
        countryCode: 'in',
      },
    );

    expect(trustedDeviceCookie).toEqual(expect.any(String));
    const trustedDeviceToken = readSignedPayload(trustedDeviceCookie)[
      'auth-user-1'
    ] as string;
    expect(trustedDeviceToken).toHaveLength(43);
    const [[insertedDevice]] = devices.insert.mock.calls as unknown as Array<
      [
        {
          auth_user_id: string;
          country_code: string;
          token_hmac: string;
        },
      ]
    >;
    expect(insertedDevice).toMatchObject({
      auth_user_id: 'auth-user-1',
      country_code: 'IN',
    });
    expect(typeof insertedDevice.token_hmac).toBe('string');
    expect(insertedDevice.token_hmac).not.toBe(trustedDeviceToken);
  });

  it('refreshes an existing enrollment device and binds the update to its user', async () => {
    const { service, getClient } = createService();
    const accessToken = createManagementToken();
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-1',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        aal: 'aal2',
        amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }],
      });
    const lookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: 'trusted-device-1', country_code: 'IN' },
        error: null,
      }),
    };
    const update = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      error: null,
    };
    getClient.mockReturnValue({
      from: jest.fn().mockReturnValueOnce(lookup).mockReturnValueOnce(update),
    });

    const refreshed = await service.trustCurrentDeviceAfterEnrollment({
      accessToken,
      currentTrustedDeviceCookie: service.signTrustedDeviceCookie({
        'auth-user-0': 'another-account-token',
        'auth-user-1': 'existing-trusted-device-token',
      }),
      countryCode: null,
    });

    // The other account's slot survives an enrollment on the same browser.
    expect(readSignedPayload(refreshed)).toEqual({
      'auth-user-0': 'another-account-token',
      'auth-user-1': 'existing-trusted-device-token',
    });
    expect(update.eq).toHaveBeenNthCalledWith(1, 'id', 'trusted-device-1');
    expect(update.eq).toHaveBeenNthCalledWith(2, 'auth_user_id', 'auth-user-1');
  });

  it('fails post-enrollment trust closed without undoing registration', async () => {
    const { service, getClient } = createService();
    const accessToken = createManagementToken();
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-1',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        aal: 'aal2',
        amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }],
      });
    getClient.mockReturnValue({
      from: jest.fn().mockReturnValue({
        insert: jest.fn().mockResolvedValue({
          error: { message: 'database unavailable' },
        }),
      }),
    });

    await expect(
      service.trustCurrentDeviceAfterEnrollment({
        accessToken,
        countryCode: 'IN',
      }),
    ).resolves.toBeNull();

    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValueOnce({
        sub: 'auth-user-1',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        aal: 'aal1',
        amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }],
      });
    await expect(
      service.trustCurrentDeviceAfterEnrollment({ accessToken }),
    ).resolves.toBeNull();
  });

  it('rejects authentication option failures and disabled passkeys', async () => {
    const { service } = createService();
    jest.spyOn(service as never, 'publicPasskeyClient').mockReturnValue({
      auth: {
        passkey: {
          startAuthentication: jest.fn().mockResolvedValue({
            data: null,
            error: { message: 'challenge unavailable' },
          }),
        },
      },
    } as never);

    await expect(
      service.startAuthentication('https://auth.xisuite.cloud'),
    ).rejects.toThrow('challenge unavailable');

    const configService = (
      service as unknown as {
        configService: { get: jest.Mock };
      }
    ).configService;
    configService.get.mockImplementation((key: string) =>
      key === 'passkeys.enabled' ? false : undefined,
    );
    await expect(
      service.startAuthentication('https://auth.xisuite.cloud'),
    ).rejects.toThrow('Passkeys are disabled');
  });

  it('registers and labels a passkey after verified recent TOTP', async () => {
    const { service, getClient } = createService();
    const accessToken = createManagementToken();
    jest.spyOn(service as never, 'publicPasskeyClient').mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'auth-user-1',
              factors: [{ factor_type: 'totp', status: 'verified' }],
            },
          },
          error: null,
        }),
      },
    } as never);
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-1',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
    const gotrueRequest = jest
      .spyOn(service as never, 'gotrueRequest')
      .mockResolvedValueOnce({
        id: 'passkey-1',
        friendly_name: null,
        created_at: '2026-08-11T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        id: 'passkey-1',
        friendly_name: 'Work laptop',
        created_at: '2026-08-11T00:00:00.000Z',
      });
    const events = { insert: jest.fn().mockResolvedValue({ error: null }) };
    getClient.mockReturnValue({
      from: jest.fn().mockReturnValue(events),
    });

    await expect(
      service.verifyRegistration(
        {
          challengeId: 'challenge-1',
          friendlyName: '  Work laptop  ',
          credential: registrationCredential(),
        },
        accessToken,
        'https://auth.xisuite.cloud',
      ),
    ).resolves.toEqual({
      id: 'passkey-1',
      friendlyName: 'Work laptop',
      createdAt: '2026-08-11T00:00:00.000Z',
      partialSuccess: false,
      warning: null,
    });
    expect(gotrueRequest).toHaveBeenNthCalledWith(
      2,
      'PATCH',
      '/passkeys/passkey-1',
      accessToken,
      { friendly_name: 'Work laptop' },
    );
    expect(events.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'passkey_enrolled',
        device_label: 'Work laptop',
      }),
    );
  });

  it('preserves registration when its optional label update fails', async () => {
    const { service, getClient } = createService();
    const accessToken = createManagementToken();
    jest
      .spyOn(service as never, 'assertVerifiedTotpEnrollment')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-1',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
    jest
      .spyOn(service as never, 'gotrueRequest')
      .mockResolvedValueOnce({
        id: 'passkey-1',
        created_at: '2026-08-11T00:00:00.000Z',
      })
      .mockRejectedValueOnce(
        new BadRequestException({
          message: 'Label is already in use',
          code: 'duplicate_label',
        }),
      );
    getClient.mockReturnValue({
      from: jest.fn().mockReturnValue({
        insert: jest.fn().mockResolvedValue({ error: null }),
      }),
    });

    await expect(
      service.verifyRegistration(
        {
          challengeId: 'challenge-1',
          friendlyName: 'Duplicate',
          credential: registrationCredential(),
        },
        accessToken,
        'https://auth.xisuite.cloud',
      ),
    ).resolves.toMatchObject({
      id: 'passkey-1',
      friendlyName: null,
      partialSuccess: true,
      warning: 'Label is already in use',
    });
  });

  it('lists, renames, and deletes passkeys without exposing credential data', async () => {
    const { service, getClient } = createService();
    const accessToken = createManagementToken();
    jest
      .spyOn(service as never, 'assertVerifiedTotpEnrollment')
      .mockResolvedValue(undefined);
    const gotrueRequest = jest
      .spyOn(service as never, 'gotrueRequest')
      .mockResolvedValueOnce([
        {
          id: 'passkey-1',
          friendly_name: 'Work key',
          created_at: '2026-08-11T00:00:00.000Z',
          last_used_at: '2026-08-11T01:00:00.000Z',
          public_key: 'must-not-leak',
        },
      ])
      .mockResolvedValueOnce({
        id: 'passkey-1',
        friendly_name: 'Renamed key',
        created_at: '2026-08-11T00:00:00.000Z',
      })
      .mockResolvedValueOnce([
        {
          id: 'passkey-1',
          friendly_name: 'Renamed key',
          created_at: '2026-08-11T00:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce(null);
    const events = { insert: jest.fn().mockResolvedValue({ error: null }) };
    getClient.mockReturnValue({ from: jest.fn().mockReturnValue(events) });

    const listed = await service.listPasskeys(accessToken);
    expect(listed).toEqual([
      {
        id: 'passkey-1',
        friendlyName: 'Work key',
        createdAt: '2026-08-11T00:00:00.000Z',
        lastUsedAt: '2026-08-11T01:00:00.000Z',
      },
    ]);
    expect(listed[0]).not.toHaveProperty('public_key');

    await expect(
      service.renamePasskey(accessToken, 'passkey-1', '  Renamed key  '),
    ).resolves.toEqual({
      id: 'passkey-1',
      friendlyName: 'Renamed key',
      createdAt: '2026-08-11T00:00:00.000Z',
      lastUsedAt: null,
    });

    await expect(
      service.deletePasskey(accessToken, 'passkey-1'),
    ).resolves.toBeUndefined();
    expect(gotrueRequest).toHaveBeenLastCalledWith(
      'DELETE',
      '/passkeys/passkey-1',
      accessToken,
      undefined,
      false,
    );
    expect(events.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'passkey_deleted',
        device_label: 'Renamed key',
      }),
    );
  });

  it('fails device risk closed when the trusted-device store update fails', async () => {
    const { service, getClient } = createService();
    const lookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: 'trusted-device-1', country_code: 'IN' },
        error: null,
      }),
    };
    const update = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({
        error: { message: 'risk store unavailable' },
      }),
    };
    getClient.mockReturnValue({
      from: jest.fn().mockReturnValueOnce(lookup).mockReturnValueOnce(update),
    });

    const risk = await evaluateRisk(service, {
      authUserId: 'auth-user-1',
      publicUserId: 'public-user-1',
      sessionId: 'session-1',
      countryCode: 'IN',
      trustedDeviceCookie: service.signTrustedDeviceCookie({
        'auth-user-1': 'trusted-device-token',
      }),
    });
    expect(risk).toMatchObject({
      level: 'high',
      reasons: ['risk_store_failure'],
    });
    expect(typeof risk.pendingTrustedDeviceValue).toBe('string');
  });

  it('requires location step-up without rotating a recognized device token', async () => {
    const { service, getClient } = createService();
    const lookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: 'trusted-device-1', country_code: 'IN' },
        error: null,
      }),
    };
    getClient.mockReturnValue({ from: jest.fn().mockReturnValue(lookup) });

    const risk = await evaluateRisk(service, {
      authUserId: 'auth-user-1',
      publicUserId: 'public-user-1',
      sessionId: 'session-1',
      countryCode: 'US',
      trustedDeviceCookie: service.signTrustedDeviceCookie({
        'auth-user-1': 'trusted-device-token',
      }),
    });
    expect(risk).toMatchObject({
      level: 'high',
      reasons: ['unrecognized_location'],
      trustedDeviceId: 'trusted-device-1',
    });
    expect(typeof risk.pendingTrustedDeviceValue).toBe('string');
  });

  it('rejects tampered, expired, and cross-session trusted-device state', async () => {
    const { service } = createService();
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-1',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        aal: 'aal2',
        amr: [{ method: 'passkey', timestamp: 1 }],
      });

    await expect(
      service.finalizeTrustedDevice('aal2-token', 'tampered.value'),
    ).rejects.toThrow('Invalid trusted device state');

    const expired = service.signPendingTrustedDeviceCookie({
      authUserId: 'auth-user-1',
      publicUserId: 'public-user-1',
      sessionId: 'session-1',
      token: 'trusted-device-token-that-is-long-enough',
      countryCode: 'IN',
      issuedAt: Date.now() - 11 * 60 * 1000,
    });
    await expect(
      service.finalizeTrustedDevice('aal2-token', expired),
    ).rejects.toThrow('Trusted device state expired');

    const crossSession = service.signPendingTrustedDeviceCookie({
      authUserId: 'auth-user-1',
      publicUserId: 'public-user-1',
      sessionId: 'different-session',
      token: 'trusted-device-token-that-is-long-enough',
      countryCode: 'IN',
      issuedAt: Date.now(),
    });
    await expect(
      service.finalizeTrustedDevice('aal2-token', crossSession),
    ).rejects.toThrow('Trusted device does not belong to this user');
  });

  it('preserves Supabase passkey error codes and handles no-content deletes', async () => {
    const { service } = createService();
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ id: 'passkey-1' }),
      } as never)
      .mockResolvedValueOnce({ ok: true } as never)
      .mockResolvedValueOnce({
        ok: false,
        json: jest.fn().mockResolvedValue({
          message: 'Challenge expired',
          error_code: 'webauthn_challenge_expired',
        }),
      } as never)
      .mockResolvedValueOnce({
        ok: false,
        json: jest.fn().mockRejectedValue(new Error('invalid JSON')),
      } as never);
    const gateway = service as unknown as {
      gotrueRequest<T>(
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        path: string,
        accessToken?: string,
        body?: unknown,
        expectJson?: boolean,
      ): Promise<T>;
    };

    await expect(
      gateway.gotrueRequest<{ id: string }>(
        'PATCH',
        '/passkeys/passkey-1',
        'access-token',
        { friendly_name: 'Work key' },
      ),
    ).resolves.toEqual({ id: 'passkey-1' });
    const [[requestUrl, requestInit]] = fetchSpy.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    expect(requestUrl).toBe(
      'https://project.supabase.co/auth/v1/passkeys/passkey-1',
    );
    expect(requestInit).toMatchObject({
      method: 'PATCH',
      headers: {
        apikey: 'anon-key',
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ friendly_name: 'Work key' }),
    });

    await expect(
      gateway.gotrueRequest<null>(
        'DELETE',
        '/passkeys/passkey-1',
        'access-token',
        undefined,
        false,
      ),
    ).resolves.toBeNull();

    await expect(
      gateway.gotrueRequest('POST', '/passkeys/registration/verify'),
    ).rejects.toMatchObject({
      response: {
        message: 'Challenge expired',
        code: 'webauthn_challenge_expired',
      },
    });
    await expect(
      gateway.gotrueRequest('GET', '/passkeys', 'access-token'),
    ).rejects.toMatchObject({
      response: {
        message: 'Passkey request failed',
        code: 'passkey_request_failed',
      },
    });
  });

  it('reports a failed assurance write instead of throwing or signing out', async () => {
    // Regression: this used to throw, which took passkey login down completely
    // during a PostgREST schema-cache outage (PGRST205) while enrollment kept
    // working. The assertion is already verified by this point, so a database
    // fault is OUR problem. Returning false makes the caller demand a TOTP
    // step-up, which is what isSessionAssured concludes anyway when no row
    // exists -- strictly more conservative than the success path, never less.
    const { service, getClient } = createService();
    const assurance = {
      upsert: jest.fn().mockResolvedValue({
        error: { message: 'database unavailable', code: 'PGRST205' },
      }),
    };

    getClient.mockReturnValue({ from: jest.fn().mockReturnValue(assurance) });

    const signOut = jest.fn().mockResolvedValue({ error: null });

    const persisted = await (
      service as unknown as {
        persistSessionAssurance(
          client: unknown,
          input: Record<string, unknown>,
        ): Promise<boolean>;
      }
    ).persistSessionAssurance(
      { auth: { signOut } },
      {
        sessionId: 'session-1',
        authUserId: 'auth-user-1',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        risk: {
          level: 'low',
          reasons: [],
          trustedDeviceId: 'trusted-device-1',
        },
        countryCode: 'IN',
      },
    );

    expect(persisted).toBe(false);
    // The login is being completed, so the session must NOT be torn down.
    expect(signOut).not.toHaveBeenCalled();
  });

  it('reports a successful assurance write', async () => {
    const { service, getClient } = createService();
    const assurance = { upsert: jest.fn().mockResolvedValue({ error: null }) };

    getClient.mockReturnValue({ from: jest.fn().mockReturnValue(assurance) });

    const persisted = await (
      service as unknown as {
        persistSessionAssurance(
          client: unknown,
          input: Record<string, unknown>,
        ): Promise<boolean>;
      }
    ).persistSessionAssurance(
      { auth: { signOut: jest.fn() } },
      {
        sessionId: 'session-1',
        authUserId: 'auth-user-1',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        risk: {
          level: 'low',
          reasons: [],
          trustedDeviceId: 'trusted-device-1',
        },
        countryCode: 'IN',
      },
    );

    expect(persisted).toBe(true);
  });

  it('revokes the session server-side and swallows sign-out failures', async () => {
    const { service } = createService();
    const signOut = jest.fn().mockRejectedValue(new Error('gotrue offline'));

    await expect(
      (
        service as unknown as {
          bestEffortSignOut(client: unknown): Promise<void>;
        }
      ).bestEffortSignOut({ auth: { signOut } }),
    ).resolves.toBeUndefined();
    expect(signOut).toHaveBeenCalledWith({ scope: 'global' });
  });

  it('trusts each account in its own slot of a shared browser cookie', async () => {
    const { service, getClient } = createService();
    const lookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: 'trusted-device-2', country_code: 'IN' },
        error: null,
      }),
    };
    const update = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    getClient.mockReturnValue({
      from: jest.fn().mockReturnValueOnce(lookup).mockReturnValueOnce(update),
    });

    const risk = await evaluateRisk(service, {
      authUserId: 'auth-user-2',
      publicUserId: 'public-user-2',
      sessionId: 'session-2',
      countryCode: 'IN',
      trustedDeviceCookie: service.signTrustedDeviceCookie({
        'auth-user-1': 'token-for-account-one',
        'auth-user-2': 'token-for-account-two',
      }),
    });

    expect(risk).toMatchObject({ level: 'low', reasons: [] });
    expect(lookup.eq).toHaveBeenCalledWith('auth_user_id', 'auth-user-2');
    expect(lookup.eq).toHaveBeenCalledWith(
      'token_hmac',
      hashTrustedDeviceToken('token-for-account-two'),
    );
    expect(readSignedPayload(risk.trustedDeviceValue)).toEqual({
      'auth-user-1': 'token-for-account-one',
      'auth-user-2': 'token-for-account-two',
    });
  });

  it('keeps the other account trusted while this one steps up', async () => {
    const { service, getClient } = createService();
    const lookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    getClient.mockReturnValue({ from: jest.fn().mockReturnValue(lookup) });

    const risk = await evaluateRisk(service, {
      authUserId: 'auth-user-2',
      publicUserId: 'public-user-2',
      sessionId: 'session-2',
      countryCode: 'IN',
      trustedDeviceCookie: service.signTrustedDeviceCookie({
        'auth-user-1': 'token-for-account-one',
      }),
    });

    expect(risk).toMatchObject({
      level: 'high',
      reasons: ['unrecognized_device'],
    });
    expect(readSignedPayload(risk.trustedDeviceValue)).toEqual({
      'auth-user-1': 'token-for-account-one',
    });
  });

  it('treats a legacy single-token cookie as an empty map without throwing', async () => {
    const { service, getClient } = createService();
    const lookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: 'trusted-device-1', country_code: 'IN' },
        error: null,
      }),
    };
    getClient.mockReturnValue({ from: jest.fn().mockReturnValue(lookup) });

    const risk = await evaluateRisk(service, {
      authUserId: 'auth-user-1',
      publicUserId: 'public-user-1',
      sessionId: 'session-1',
      countryCode: 'IN',
      trustedDeviceCookie: 'legacy-single-raw-token',
    });

    expect(risk).toMatchObject({
      level: 'high',
      reasons: ['unrecognized_device'],
      trustedDeviceValue: null,
    });
    expect(lookup.maybeSingle).not.toHaveBeenCalled();
  });

  it('caps the trusted-device map and evicts the oldest account', async () => {
    const { service, getClient } = createService();
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-new',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        aal: 'aal2',
        amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }],
      });
    getClient.mockReturnValue({
      from: jest.fn().mockReturnValue({
        insert: jest.fn().mockResolvedValue({ error: null }),
      }),
    });

    const cookie = await service.trustCurrentDeviceAfterEnrollment({
      accessToken: createManagementToken(),
      currentTrustedDeviceCookie: service.signTrustedDeviceCookie({
        'auth-user-1': 'token-1',
        'auth-user-2': 'token-2',
        'auth-user-3': 'token-3',
        'auth-user-4': 'token-4',
        'auth-user-5': 'token-5',
      }),
      countryCode: 'IN',
    });

    // Cap is 3: the two most recent existing slots survive alongside the new
    // one, oldest first out. Lowered from 5 because a 5-slot map made the
    // response header block large enough for nginx to reject the whole reply
    // with `upstream sent too big header` — a 502 on an otherwise successful
    // sign-in. If this cap is ever raised, measure the Set-Cookie total first.
    const map = readSignedPayload(cookie);

    expect(Object.keys(map)).toEqual([
      'auth-user-4',
      'auth-user-5',
      'auth-user-new',
    ]);
  });

  it('merges pending step-up state per account instead of clobbering it', async () => {
    const { service, getClient } = createService();
    const lookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    getClient.mockReturnValue({ from: jest.fn().mockReturnValue(lookup) });

    const pendingForAccountOne = service.signPendingTrustedDeviceCookie({
      authUserId: 'auth-user-1',
      publicUserId: 'public-user-1',
      sessionId: 'session-1',
      token: 'trusted-device-token-that-is-long-enough',
      countryCode: 'IN',
      issuedAt: Date.now(),
    });

    const risk = await evaluateRisk(service, {
      authUserId: 'auth-user-2',
      publicUserId: 'public-user-2',
      sessionId: 'session-2',
      countryCode: 'IN',
      pendingTrustedDeviceCookie: pendingForAccountOne,
    });

    expect(
      Object.keys(readSignedPayload(risk.pendingTrustedDeviceValue)),
    ).toEqual(['auth-user-1', 'auth-user-2']);
  });

  it('finalizes one account and leaves the other account pending state intact', async () => {
    const { service, getClient } = createService();
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-2',
        session_id: 'session-2',
        exp: Math.floor(Date.now() / 1000) + 3600,
        aal: 'aal2',
        amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }],
      });

    const trustedLookup = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      insert: jest.fn().mockReturnThis(),
      single: jest
        .fn()
        .mockResolvedValue({ data: { id: 'trusted-device-2' }, error: null }),
    };
    const assuranceUpdate = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest
        .fn()
        .mockResolvedValue({ data: { session_id: 'session-2' }, error: null }),
    };
    getClient.mockReturnValue({
      from: jest.fn((table: string) => {
        if (table === 'auth_trusted_devices') return trustedLookup;
        if (table === 'auth_session_assurance') return assuranceUpdate;
        return { insert: jest.fn().mockResolvedValue({ error: null }) };
      }),
    });

    const pendingOne = service.signPendingTrustedDeviceCookie({
      authUserId: 'auth-user-1',
      publicUserId: 'public-user-1',
      sessionId: 'session-1',
      token: 'account-one-token-that-is-long-enough',
      countryCode: 'IN',
      issuedAt: Date.now(),
    });
    const pendingBoth = service.signPendingTrustedDeviceCookie(
      {
        authUserId: 'auth-user-2',
        publicUserId: 'public-user-2',
        sessionId: 'session-2',
        token: 'account-two-token-that-is-long-enough',
        countryCode: 'IN',
        issuedAt: Date.now(),
      },
      pendingOne,
    );

    const finalized = await service.finalizeTrustedDevice(
      'aal2-token',
      pendingBoth,
      service.signTrustedDeviceCookie({ 'auth-user-1': 'account-one-live' }),
    );

    expect(readSignedPayload(finalized.trustedDeviceValue)).toEqual({
      'auth-user-1': 'account-one-live',
      'auth-user-2': 'account-two-token-that-is-long-enough',
    });
    expect(
      Object.keys(readSignedPayload(finalized.pendingTrustedDeviceValue)),
    ).toEqual(['auth-user-1']);
  });

  it('revokes the trusted-device row this browser just superseded', async () => {
    const { service, getClient } = createService();
    jest
      .spyOn(service as never, 'getRequiredVerifiedTokenPayload')
      .mockResolvedValue({
        sub: 'auth-user-1',
        session_id: 'session-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
        aal: 'aal2',
        amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }],
      });

    const revoke = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockResolvedValue({ error: null }),
    };
    const trustedDevices = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      insert: jest.fn().mockReturnThis(),
      single: jest
        .fn()
        .mockResolvedValue({ data: { id: 'trusted-device-new' }, error: null }),
      update: revoke.update,
    };
    const assuranceUpdate = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      maybeSingle: jest
        .fn()
        .mockResolvedValue({ data: { session_id: 'session-1' }, error: null }),
    };
    revoke.update.mockReturnValue(revoke);
    getClient.mockReturnValue({
      from: jest.fn((table: string) => {
        if (table === 'auth_trusted_devices') return trustedDevices;
        if (table === 'auth_session_assurance') return assuranceUpdate;
        return { insert: jest.fn().mockResolvedValue({ error: null }) };
      }),
    });

    await service.finalizeTrustedDevice(
      'aal2-token',
      service.signPendingTrustedDeviceCookie({
        authUserId: 'auth-user-1',
        publicUserId: 'public-user-1',
        sessionId: 'session-1',
        token: 'replacement-token-that-is-long-enough',
        countryCode: 'IN',
        issuedAt: Date.now(),
      }),
      service.signTrustedDeviceCookie({ 'auth-user-1': 'superseded-token' }),
    );

    const [[revokePatch]] = revoke.update.mock.calls as unknown as Array<
      [{ revoked_at?: string }]
    >;
    expect(typeof revokePatch.revoked_at).toBe('string');
    expect(revoke.eq).toHaveBeenCalledWith(
      'token_hmac',
      hashTrustedDeviceToken('superseded-token'),
    );
  });

  it('enforces the server-side passkey cap before starting registration', async () => {
    const { service, sessionAssurance } = createService();
    jest.spyOn(service as never, 'publicPasskeyClient').mockReturnValue({
      auth: {
        getUser: jest.fn().mockResolvedValue({
          data: {
            user: {
              id: 'auth-user-1',
              factors: [{ factor_type: 'totp', status: 'verified' }],
            },
          },
          error: null,
        }),
      },
    } as never);
    jest
      .spyOn(service as never, 'assertRecentTotp')
      .mockImplementation(() => {});
    sessionAssurance.countVerifiedPasskeys.mockResolvedValue(10);

    const error = await service
      .startRegistration('jwt-token', 'https://auth.xisuite.cloud')
      .catch((caught: unknown) => caught);

    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'too_many_passkeys',
    });
    expect(sessionAssurance.countVerifiedPasskeys).toHaveBeenCalledWith(
      'auth-user-1',
    );
  });

  it('rejects missing pending state and forged passkey AMR claims', async () => {
    const { service } = createService();

    await expect(
      service.finalizeTrustedDevice('aal2-token', undefined),
    ).rejects.toThrow('Pending trusted device missing');
    expect(() =>
      (
        service as unknown as {
          assertPasskeyAmr(payload: Record<string, unknown>): void;
        }
      ).assertPasskeyAmr({
        amr: [{ method: 'password', timestamp: 1 }],
      }),
    ).toThrow('Session is not passkey-authenticated');
  });

  it('never blocks or breaks bootstrap, even when the preflight probe fails', async () => {
    // Regression: the boot preflight was `async onModuleInit`, which Nest AWAITS.
    // Three Supabase round trips therefore sat on the bootstrap critical path,
    // so an unreachable database meant the app never started listening and the
    // proxy 502'd EVERY endpoint - password and OAuth login included. A
    // diagnostic must never be able to take the service down.
    const { service, getClient } = createService();

    getClient.mockImplementation(() => {
      throw new Error('supabase unreachable');
    });

    // Must return synchronously (undefined, not a promise) so Nest cannot await it.
    expect(service.onModuleInit()).toBeUndefined();

    // And the rejection must be contained, not surface as an unhandled rejection.
    await new Promise((resolve) => setImmediate(resolve));
    expect(getClient).toHaveBeenCalled();
  });
});
