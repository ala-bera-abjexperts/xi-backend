import { ForbiddenException } from '@nestjs/common';
// OauthService (injected for the redirect allowlist) imports ESM-only jose.
jest.mock('jose', () => ({}));
jest.mock('@node-saml/node-saml', () => ({
  ...jest.requireActual<object>('@node-saml/node-saml'),
  SAML: jest.fn(),
}));

import { ConflictException } from '@nestjs/common';
import {
  SAML,
  ValidateInResponseTo,
  type SamlConfig,
} from '@node-saml/node-saml';
import { SamlController } from './saml.controller';
import { SamlLoginError, SamlService } from './saml.service';

const ORG = 'org-1';
const CONN = '11111111-1111-4111-8111-111111111111';
const REQ = '_req-1';
const REDIRECT = 'https://app.test/home';

type Call = { table: string; ops: [string, unknown[]][] };
type DbResult = { data?: unknown; error?: unknown } | undefined;

const has = (call: Call, op: string) => call.ops.some(([name]) => name === op);

/** Chainable Supabase stand-in: every call is recorded, `await` asks `handler`. */
function fakeClient(handler: (call: Call) => DbResult) {
  const calls: Call[] = [];
  const from = jest.fn((table: string) => {
    const call: Call = { table, ops: [] };
    const builder: unknown = new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === 'then'
            ? (resolve: (v: unknown) => void) =>
                resolve({ data: null, error: null, ...handler(call) })
            : (...args: unknown[]) => {
                call.ops.push([String(prop), args]);

                return builder;
              },
      },
    );

    calls.push(call);

    return builder;
  });

  return { from, calls };
}

function jwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
}

function profileFor(subjectIds: unknown[] = [REQ], overrides = {}) {
  return {
    issuer: 'https://idp.test/entity',
    nameID: 'Ann@Acme.test',
    nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    inResponseTo: REQ,
    getAssertion: () => ({
      Assertion: {
        Subject: [
          {
            SubjectConfirmation: subjectIds.map((id) => ({
              SubjectConfirmationData: [
                { $: id === undefined ? {} : { InResponseTo: id } },
              ],
            })),
          },
        ],
      },
    }),
    ...overrides,
  };
}

function setup(
  opts: {
    connection?: Record<string, unknown>;
    db?: (call: Call) => DbResult;
  } = {},
) {
  const connection = {
    id: CONN,
    organization_id: ORG,
    idp_entity_id: 'https://idp.test/entity',
    idp_sso_url: 'https://idp.test/sso',
    idp_certs: ['PEM'],
    is_enabled: true,
    jit_enabled: false,
    trust_updated_by: 'owner-user',
    ...opts.connection,
  };
  const user = {
    id: 'user-1',
    email: 'ann@acme.test',
    auth_user_id: 'auth-1',
    is_active: true,
  };
  const db = fakeClient((call) => {
    const override = opts.db?.(call);

    if (override) return override;
    if (call.table === 'sso_connections') return { data: connection };
    if (call.table === 'saml_requests' && has(call, 'delete')) {
      return { data: has(call, 'select') ? [{ redirect_to: REDIRECT }] : null };
    }
    if (call.table === 'scim_links') {
      return { data: has(call, 'maybeSingle') ? null : [] };
    }
    if (call.table === 'sso_session_bindings' && has(call, 'select')) {
      return { data: [] };
    }

    return {};
  });
  const admin = {
    getUserById: jest.fn().mockResolvedValue({
      data: { user: { id: 'auth-1', email: 'ann@acme.test' } },
      error: null,
    }),
    generateLink: jest.fn().mockResolvedValue({
      data: {
        user: { id: 'auth-1' },
        properties: { hashed_token: 'hash', verification_type: 'magiclink' },
      },
      error: null,
    }),
    signOut: jest.fn().mockResolvedValue({ error: null }),
  };
  const verifyOtp = jest.fn().mockResolvedValue({
    data: {
      session: {
        access_token: jwt({ session_id: 'sess-1' }),
        refresh_token: 'refresh',
        expires_in: 3600,
      },
    },
    error: null,
  });
  const supabaseAdmin = {
    getClient: () => ({ from: db.from, auth: { admin } }),
    createAuthClient: () => ({ auth: { verifyOtp } }),
  };
  const config: Record<string, unknown> = {
    sessionSigningSecret: 'x'.repeat(32),
    frontendUrl: 'https://auth.app.test/',
    publicApiUrl: 'https://auth.app.test/api/v1',
  };
  const configService = { get: jest.fn((key: string) => config[key]) };
  const accounts = {
    normalizeEmail: jest.fn((e: string) => e.trim().toLowerCase()),
    emailDomain: jest.fn((e: string) => e.split('@')[1] ?? null),
    findUserByEmail: jest.fn().mockResolvedValue(user),
    isDomainBoundToConnection: jest.fn().mockResolvedValue(true),
    getMemberRole: jest.fn().mockResolvedValue('member'),
    isCurrentOwner: jest.fn().mockResolvedValue(true),
    ensureAuthUser: jest.fn().mockResolvedValue('auth-1'),
    createAccount: jest.fn(),
    attachMember: jest.fn().mockResolvedValue(undefined),
    assertSeatForNewMember: jest.fn().mockResolvedValue(undefined),
  };
  const usersService = { getUserById: jest.fn().mockResolvedValue(user) };
  const oauthService = { frontendAllowlist: () => ['https://app.test'] };
  const onPremiseTenant = {
    ensureDefaultMembership: jest.fn().mockResolvedValue(null),
  };
  const auditLogs = { logSystemAction: jest.fn().mockResolvedValue(undefined) };
  const samlOptions: SamlConfig[] = [];
  const saml = {
    getAuthorizeUrlAsync: jest.fn(),
    validatePostResponseAsync: jest
      .fn()
      .mockResolvedValue({ profile: profileFor(), loggedOut: false }),
    generateServiceProviderMetadata: jest.fn().mockReturnValue('<xml/>'),
  };

  (SAML as unknown as jest.Mock).mockImplementation((options: SamlConfig) => {
    samlOptions.push(options);

    return saml;
  });

  const service = new SamlService(
    supabaseAdmin as any,
    configService as any,
    accounts as any,
    usersService as any,
    oauthService as any,
    onPremiseTenant as any,
    auditLogs as any,
  );
  const acs = (cookie: string = service.signRequestId(REQ)) =>
    service.completeLogin(CONN, 'PHNhbWxwOlJlc3BvbnNlLz4=', cookie);

  return {
    service,
    db,
    admin,
    verifyOtp,
    accounts,
    usersService,
    auditLogs,
    saml,
    samlOptions,
    acs,
    user,
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(SamlLoginError);
  await promise.catch((err: SamlLoginError) => expect(err.code).toBe(code));
}

describe('SamlService', () => {
  describe('login start', () => {
    it('builds node-saml from the connection with strict request checks', async () => {
      const { service, saml, samlOptions, db } = setup();

      saml.getAuthorizeUrlAsync.mockImplementation(async () => {
        await samlOptions[0].cacheProvider!.saveAsync(REQ, '2026-09-13T00:00Z');

        return 'https://idp.test/sso?SAMLRequest=x';
      });

      const result = await service.startLogin(CONN, 'https://evil.test/x');
      const base = `https://auth.app.test/api/v1/auth/saml/${CONN}`;

      expect(samlOptions[0]).toMatchObject({
        entryPoint: 'https://idp.test/sso',
        issuer: `${base}/metadata`,
        audience: `${base}/metadata`,
        callbackUrl: `${base}/acs`,
        idpCert: ['PEM'],
        idpIssuer: 'https://idp.test/entity',
        wantAssertionsSigned: true,
        wantAuthnResponseSigned: false,
        validateInResponseTo: ValidateInResponseTo.always,
        requestIdExpirationPeriodMs: 600000,
        acceptedClockSkewMs: 180000,
        disableRequestedAuthnContext: true,
      });
      expect(result).toEqual({
        url: 'https://idp.test/sso?SAMLRequest=x',
        requestCookie: service.signRequestId(REQ),
      });

      const insert = db.calls.find((c) => has(c, 'insert'))!;

      // An unlisted redirectTo falls back to FRONTEND_URL.
      expect(insert.ops[0][1][0]).toMatchObject({
        id: REQ,
        organization_id: ORG,
        connection_id: CONN,
        redirect_to: 'https://auth.app.test',
      });
    });

    it('refuses a disabled connection', async () => {
      const { service } = setup({ connection: { is_enabled: false } });

      await expectCode(
        service.startLogin(CONN, REDIRECT),
        'sso_connection_disabled',
      );
    });
  });

  describe('request cache provider', () => {
    it('reads only unexpired rows of this connection and never deletes on remove', async () => {
      const { service, samlOptions, db } = setup();

      await service.metadata(CONN);

      const cache = samlOptions[0].cacheProvider!;
      const before = db.calls.length;

      await expect(cache.removeAsync(REQ)).resolves.toBe(REQ);
      expect(db.calls).toHaveLength(before);

      await cache.getAsync(REQ);
      const read = db.calls[db.calls.length - 1];

      expect(read.table).toBe('saml_requests');
      expect(read.ops).toEqual(
        expect.arrayContaining([
          ['eq', ['id', REQ]],
          ['eq', ['connection_id', CONN]],
          ['eq', ['organization_id', ORG]],
          ['gt', ['expires_at', expect.any(String)]],
        ]),
      );
      expect(has(read, 'delete')).toBe(false);
    });
  });

  describe('ACS refusals', () => {
    it('rejects an issuer mismatch', async () => {
      const t = setup();

      t.saml.validatePostResponseAsync.mockResolvedValue({
        profile: profileFor([REQ], { issuer: 'https://rogue.test' }),
        loggedOut: false,
      });

      await expectCode(t.acs(), 'sso_assertion_invalid');
      expect(t.admin.generateLink).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', [undefined]],
      ['mismatched', ['_other']],
    ])('rejects a %s subject InResponseTo', async (_label, subjectIds) => {
      const t = setup();

      t.saml.validatePostResponseAsync.mockResolvedValue({
        profile: profileFor(subjectIds),
        loggedOut: false,
      });

      await expectCode(t.acs(), 'sso_assertion_invalid');
    });

    it('rejects a missing or foreign request cookie', async () => {
      const t = setup();

      await expectCode(t.acs('deadbeef'), 'sso_assertion_invalid');
      await expectCode(t.acs(''), 'sso_assertion_invalid');
      expect(t.admin.generateLink).not.toHaveBeenCalled();
    });

    it('rejects an already consumed or expired request', async () => {
      const t = setup({
        db: (call) =>
          call.table === 'saml_requests' && has(call, 'delete')
            ? { data: [] }
            : undefined,
      });

      await expectCode(t.acs(), 'sso_assertion_invalid');
      expect(t.accounts.findUserByEmail).not.toHaveBeenCalled();
    });

    it('refuses an account whose domain is not bound to this connection', async () => {
      const t = setup();

      t.accounts.isDomainBoundToConnection.mockResolvedValue(false);

      await expectCode(t.acs(), 'sso_no_workspace_access');
      expect(t.admin.generateLink).not.toHaveBeenCalled();
    });

    it('refuses an owner when the trust material was not set by an owner', async () => {
      const t = setup();

      t.accounts.getMemberRole.mockResolvedValue('owner');
      t.accounts.isCurrentOwner.mockResolvedValue(false);

      await expectCode(t.acs(), 'sso_no_workspace_access');
      expect(t.accounts.isCurrentOwner).toHaveBeenCalledWith(ORG, 'owner-user');
      expect(t.auditLogs.logSystemAction).toHaveBeenCalledWith(
        ORG,
        'sso_connection',
        CONN,
        'update',
        expect.objectContaining({ event: 'sso_owner_login_blocked' }),
      );
    });

    it('refuses an owner matched by a SCIM user_name whose email differs from the assertion', async () => {
      const t = setup({
        db: (call) =>
          call.table === 'scim_links' && !has(call, 'maybeSingle')
            ? {
                data: [
                  { local_user_id: 'owner-1', user_name: 'ann@acme.test' },
                ],
              }
            : undefined,
      });

      t.usersService.getUserById.mockResolvedValue({
        ...t.user,
        id: 'owner-1',
        email: 'boss@acme.test',
      });
      t.accounts.getMemberRole.mockResolvedValue('owner');

      await expectCode(t.acs(), 'sso_no_workspace_access');
      expect(t.usersService.getUserById).toHaveBeenCalledWith('owner-1');
      expect(t.auditLogs.logSystemAction).toHaveBeenCalledWith(
        ORG,
        'sso_connection',
        CONN,
        'update',
        expect.objectContaining({
          event: 'sso_owner_login_blocked',
          reason: 'assertion_email_mismatch',
          user_id: 'owner-1',
        }),
      );
      expect(t.admin.generateLink).not.toHaveBeenCalled();
    });

    it('refuses a SCIM-deactivated account with no membership', async () => {
      const t = setup({
        connection: { jit_enabled: true },
        db: (call) =>
          call.table === 'scim_links' && has(call, 'maybeSingle')
            ? { data: { is_active: false, deleted_at: null } }
            : undefined,
      });

      t.accounts.getMemberRole.mockResolvedValue(null);

      await expectCode(t.acs(), 'sso_account_inactive');
      expect(t.accounts.attachMember).not.toHaveBeenCalled();
    });

    it('refuses a non-member when JIT is off', async () => {
      const t = setup();

      t.accounts.getMemberRole.mockResolvedValue(null);

      await expectCode(t.acs(), 'sso_no_workspace_access');
      expect(t.accounts.attachMember).not.toHaveBeenCalled();
    });

    it('maps an email_exists conflict to no workspace access', async () => {
      const t = setup();

      t.accounts.ensureAuthUser.mockRejectedValue(
        new ConflictException('account_conflict'),
      );

      await expectCode(t.acs(), 'sso_no_workspace_access');
    });
  });

  describe('ACS success', () => {
    it('lets an owner in when the asserted email matches and an owner vouched', async () => {
      const t = setup();

      t.accounts.getMemberRole.mockResolvedValue('owner');

      await expect(t.acs()).resolves.toMatchObject({ organizationId: ORG });
      expect(t.admin.generateLink).toHaveBeenCalled();
      expect(t.auditLogs.logSystemAction).not.toHaveBeenCalled();
    });

    it('attaches a non-member as member when JIT is on', async () => {
      const t = setup({ connection: { jit_enabled: true } });

      t.accounts.getMemberRole.mockResolvedValue(null);

      const result = await t.acs();

      expect(t.accounts.attachMember).toHaveBeenCalledWith(
        ORG,
        'user-1',
        'ann@acme.test',
        'member',
      );
      expect(result).toMatchObject({
        redirectTo: REDIRECT,
        organizationId: ORG,
      });
    });

    it('creates the account with JIT when none exists and the domain is bound', async () => {
      const t = setup({ connection: { jit_enabled: true } });
      const created = { ...t.user, id: 'user-new' };

      t.accounts.findUserByEmail.mockResolvedValue(null);
      t.accounts.createAccount.mockResolvedValue(created);

      await t.acs();

      expect(t.accounts.createAccount).toHaveBeenCalledWith(
        'ann@acme.test',
        expect.any(Object),
      );
      expect(t.accounts.attachMember).toHaveBeenCalledWith(
        ORG,
        'user-new',
        'ann@acme.test',
      );
    });

    it('refuses a JIT login when the workspace has no seat left, before creating an account', async () => {
      const t = setup({ connection: { jit_enabled: true } });

      t.accounts.findUserByEmail.mockResolvedValue(null);
      t.accounts.assertSeatForNewMember.mockRejectedValue(
        new ForbiddenException({ code: 'LIMIT_EXCEEDED', message: 'full' }),
      );

      await expect(t.acs()).rejects.toMatchObject({ code: 'sso_seat_limit' });
      expect(t.accounts.createAccount).not.toHaveBeenCalled();
    });

    it('binds the session and copies the user’s other live bindings', async () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const t = setup({
        db: (call) =>
          call.table === 'sso_session_bindings' && has(call, 'select')
            ? {
                data: [
                  {
                    organization_id: 'org-2',
                    connection_id: 'conn-2',
                    expires_at: future,
                  },
                ],
              }
            : undefined,
      });

      await t.acs();

      const upserts = t.db.calls.filter(
        (c) => c.table === 'sso_session_bindings' && has(c, 'upsert'),
      );

      expect(upserts[0].ops[0][1][0]).toMatchObject({
        session_id: 'sess-1',
        organization_id: ORG,
        connection_id: CONN,
        auth_user_id: 'auth-1',
      });
      expect(upserts[1].ops[0][1]).toEqual([
        [
          {
            organization_id: 'org-2',
            connection_id: 'conn-2',
            expires_at: future,
            session_id: 'sess-1',
            auth_user_id: 'auth-1',
          },
        ],
        { onConflict: 'session_id,organization_id', ignoreDuplicates: true },
      ]);
    });

    it('revokes the new session when binding fails', async () => {
      const t = setup({
        db: (call) =>
          call.table === 'sso_session_bindings' && has(call, 'upsert')
            ? { error: { message: 'boom' } }
            : undefined,
      });

      await expectCode(t.acs(), 'sso_assertion_invalid');
      expect(t.admin.signOut).toHaveBeenCalledWith(expect.any(String), 'local');
    });
  });

  describe('session minting', () => {
    it('fails when the magic link resolves to a different auth user', async () => {
      const t = setup();

      t.admin.generateLink.mockResolvedValue({
        data: {
          user: { id: 'someone-else' },
          properties: { hashed_token: 'h' },
        },
        error: null,
      });

      await expectCode(t.acs(), 'sso_assertion_invalid');
      expect(t.admin.generateLink).toHaveBeenCalledWith({
        type: 'magiclink',
        email: 'ann@acme.test',
      });
      expect(t.verifyOtp).not.toHaveBeenCalled();
    });
  });
});

describe('SamlController ACS', () => {
  function controllerSetup(mfaRequired: boolean) {
    const tokens = {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      token_type: 'bearer',
    };
    const samlService = {
      completeLogin: jest.fn().mockResolvedValue({
        tokens,
        redirectTo: REDIRECT,
        organizationId: ORG,
      }),
      frontendUrl: () => 'https://auth.app.test',
      revokeSession: jest.fn().mockResolvedValue(undefined),
    };
    const authService = {
      getTokenMfaState: jest.fn().mockResolvedValue({ mfaRequired }),
    };
    const configService = {
      get: jest.fn((key: string) =>
        key === 'cookies.signingSecret' ? 'y'.repeat(32) : undefined,
      ),
    };
    const res = {
      cookie: jest.fn().mockReturnThis(),
      clearCookie: jest.fn().mockReturnThis(),
      redirect: jest.fn().mockReturnThis(),
    };
    const controller = new SamlController(
      samlService as any,
      authService as any,
      configService as any,
    );
    const req = { cookies: { saml_request: 'cookie' } };

    return { controller, samlService, authService, res, req };
  }

  it('revokes the minted session when a step after minting fails', async () => {
    const { controller, samlService, authService, res, req } =
      controllerSetup(false);

    authService.getTokenMfaState.mockRejectedValue(new Error('boom'));

    await controller.acs(CONN, { SAMLResponse: 'x' }, req as any, res as any);

    expect(samlService.revokeSession).toHaveBeenCalledWith('access');
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://auth.app.test/auth/login?error=sso_assertion_invalid',
    );
  });

  it('sends an MFA-required session to verify-totp', async () => {
    const { controller, res, req } = controllerSetup(true);

    await controller.acs(CONN, { SAMLResponse: 'x' }, req as any, res as any);

    expect(res.clearCookie).toHaveBeenCalledWith(
      'saml_request',
      expect.objectContaining({ path: '/api/v1/auth/saml' }),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      `https://auth.app.test/auth/verify-totp?returnUrl=${encodeURIComponent(REDIRECT)}`,
    );
  });

  it('redirects a refused login to the login page with only the code', async () => {
    const { controller, samlService, res, req } = controllerSetup(false);

    samlService.completeLogin.mockRejectedValue(
      new SamlLoginError('sso_account_inactive'),
    );

    await controller.acs(CONN, { SAMLResponse: 'x' }, req as any, res as any);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://auth.app.test/auth/login?error=sso_account_inactive',
    );
    expect(res.cookie).not.toHaveBeenCalled();
    expect(samlService.revokeSession).not.toHaveBeenCalled();
  });
});
