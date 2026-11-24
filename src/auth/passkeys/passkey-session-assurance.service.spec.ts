import { PasskeySessionAssuranceService } from './passkey-session-assurance.service';

describe('PasskeySessionAssuranceService', () => {
  const input = {
    accessToken: 'header.payload.signature',
    authUserId: 'auth-user-1',
    sessionId: 'session-1',
  };

  function setup(
    options: {
      claims?: Record<string, unknown>;
      claimsError?: { message: string } | null;
      assurance?: Record<string, unknown> | null;
      assuranceError?: { message: string } | null;
      passkeyError?: { message: string } | null;
    } = {},
  ) {
    const assuranceQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data:
          options.assurance === undefined
            ? { session_id: input.sessionId }
            : options.assurance,
        error: options.assuranceError ?? null,
      }),
    };
    const listPasskeys = jest.fn().mockResolvedValue({
      data: [{ id: 'passkey-1' }, { id: 'passkey-2' }],
      error: options.passkeyError ?? null,
    });
    const client = {
      auth: {
        getClaims: jest.fn().mockResolvedValue({
          data: {
            claims: options.claims ?? {
              sub: input.authUserId,
              session_id: input.sessionId,
              amr: [{ method: 'passkey', timestamp: 1 }],
            },
          },
          error: options.claimsError ?? null,
        }),
        admin: { passkey: { listPasskeys } },
      },
      from: jest.fn().mockReturnValue(assuranceQuery),
    };
    const service = new PasskeySessionAssuranceService({
      getClient: jest.fn().mockReturnValue(client),
    } as never);

    return { service, assuranceQuery, listPasskeys };
  }

  it('requires signed passkey claims and matching low-risk assurance state', async () => {
    const { service, assuranceQuery } = setup();

    await expect(service.isSessionAssured(input)).resolves.toBe(true);
    expect(assuranceQuery.eq).toHaveBeenCalledWith('risk_level', 'low');
    expect(assuranceQuery.eq).toHaveBeenCalledWith('step_up_required', false);
  });

  it('fails closed before the database lookup when signed claims do not match', async () => {
    const { service, assuranceQuery } = setup({
      claims: {
        sub: input.authUserId,
        session_id: input.sessionId,
        amr: [{ method: 'password', timestamp: 1 }],
      },
    });

    await expect(service.isSessionAssured(input)).resolves.toBe(false);
    expect(assuranceQuery.select).not.toHaveBeenCalled();
  });

  it('fails closed when the assurance store is unavailable', async () => {
    const { service } = setup({
      assurance: null,
      assuranceError: { message: 'database unavailable' },
    });

    await expect(service.isSessionAssured(input)).resolves.toBe(false);
  });

  it('counts Supabase-owned passkeys without mirroring credential data', async () => {
    const { service, listPasskeys } = setup();

    await expect(service.countVerifiedPasskeys(input.authUserId)).resolves.toBe(
      2,
    );
    expect(listPasskeys).toHaveBeenCalledWith({ userId: input.authUserId });
  });

  it('fails closed when signed-claim verification fails or assurance is absent', async () => {
    const claimsFailure = setup({
      claimsError: { message: 'invalid signature' },
    });
    await expect(claimsFailure.service.isSessionAssured(input)).resolves.toBe(
      false,
    );
    expect(claimsFailure.assuranceQuery.select).not.toHaveBeenCalled();

    const missingAssurance = setup({ assurance: null });
    await expect(
      missingAssurance.service.isSessionAssured(input),
    ).resolves.toBe(false);
  });

  it('does not accept a client-style string AMR as passkey assurance', async () => {
    const { service, assuranceQuery } = setup({
      claims: {
        sub: input.authUserId,
        session_id: input.sessionId,
        amr: ['passkey'],
      },
    });

    await expect(service.isSessionAssured(input)).resolves.toBe(false);
    expect(assuranceQuery.select).not.toHaveBeenCalled();
  });

  it('propagates passkey count failures instead of treating them as zero', async () => {
    const { service } = setup({
      passkeyError: { message: 'admin API unavailable' },
    });

    await expect(
      service.countVerifiedPasskeys(input.authUserId),
    ).rejects.toThrow('Passkey count failed: admin API unavailable');
  });

  it('revokes active trusted devices and records a password-change event', async () => {
    const trustedDevices = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockResolvedValue({ error: null }),
    };
    const securityEvents = {
      insert: jest.fn().mockResolvedValue({ error: null }),
    };
    const client = {
      from: jest.fn((table: string) =>
        table === 'auth_trusted_devices' ? trustedDevices : securityEvents,
      ),
    };
    const service = new PasskeySessionAssuranceService({
      getClient: jest.fn().mockReturnValue(client),
    } as never);

    await expect(
      service.revokeTrustedDevices(input.authUserId),
    ).resolves.toBeUndefined();
    const [[revocation]] = trustedDevices.update.mock.calls as unknown as Array<
      [{ revoked_at: string; updated_at: string }]
    >;
    expect(typeof revocation.revoked_at).toBe('string');
    expect(typeof revocation.updated_at).toBe('string');
    expect(trustedDevices.eq).toHaveBeenCalledWith(
      'auth_user_id',
      input.authUserId,
    );
    expect(trustedDevices.is).toHaveBeenCalledWith('revoked_at', null);
    expect(securityEvents.insert).toHaveBeenCalledWith({
      auth_user_id: input.authUserId,
      event_type: 'trusted_device_revoked',
      authentication_method: 'password',
      reason_codes: ['password_changed'],
      metadata: {},
    });
  });

  it('fails password changes closed when trusted-device revocation fails', async () => {
    const trustedDevices = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockResolvedValue({
        error: { message: 'database unavailable' },
      }),
    };
    const client = { from: jest.fn().mockReturnValue(trustedDevices) };
    const service = new PasskeySessionAssuranceService({
      getClient: jest.fn().mockReturnValue(client),
    } as never);

    await expect(
      service.revokeTrustedDevices(input.authUserId),
    ).rejects.toThrow('Trusted-device revocation failed: database unavailable');
  });
});
