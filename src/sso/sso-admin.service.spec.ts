import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SsoAdminService } from './sso-admin.service';

type Result = { data: unknown; error: unknown };

/** Throwaway self-signed EC certificate (CN=idp.test), base64 DER only. */
const CERT_BODY =
  'MIIBfDCCASGgAwIBAgIURvxTGBiqAMmRbEIJmXcSV5FMOYQwCgYIKoZIzj0EAwIwEzERMA8GA1UEAwwIaWRwLnRlc3QwHhcNMjYwOTEyMjMwMjE1WhcNMzYwOTA5MjMwMjE1WjATMREwDwYDVQQDDAhpZHAudGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABKp/yp04JINx1y3idtsCQRU9MUrXr4knJ2gtEnHSx10Hhn8D6pe0e9JL1UrkEnRj7uswcqdm7/ieBniE1laQ+2yjUzBRMB0GA1UdDgQWBBSRXbIYn1cqbT8XyPVU3g4Gm3iIaTAfBgNVHSMEGDAWgBSRXbIYn1cqbT8XyPVU3g4Gm3iIaTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQCavgw3I0XgsMB/C4+lMHJcPfcqIcyFQpQIlTT9uuqhZwIhAIb8bLJ9QcuGdrQ5+bj/qEZFf7V+JKrIVouSXL3jI6kI';

/** Chainable Supabase query stub that resolves to `result`. */
function query(result: Result = { data: null, error: null }) {
  const q: Record<string, jest.Mock> & {
    then: (resolve: (r: Result) => unknown) => Promise<unknown>;
  } = {
    then: (resolve) => Promise.resolve(result).then(resolve),
  } as never;

  for (const method of [
    'select',
    'insert',
    'update',
    'upsert',
    'delete',
    'eq',
    'is',
    'not',
    'in',
    'order',
  ]) {
    q[method] = jest.fn(() => q);
  }

  q.single = jest.fn(() => Promise.resolve(result));
  q.maybeSingle = jest.fn(() => Promise.resolve(result));

  return q;
}

const ok = (data: unknown) => query({ data, error: null });

/** First argument of a mock's first call, typed for assertions. */
const firstArg = <T>(mock: jest.Mock): T => (mock.mock.calls as T[][])[0][0];

/** Stubs the service's private DNS lookup seam. */
const stubTxt = (service: SsoAdminService) =>
  jest.spyOn(
    service as unknown as { resolveTxt: (name: string) => Promise<string[][]> },
    'resolveTxt',
  );

function actor(role: 'owner' | 'admin' | 'member' | 'viewer'): RequestUser {
  return {
    authUserId: 'auth-1',
    userId: 'user-1',
    email: 'admin@example.com',
    organizationId: 'org-1',
    memberships: [
      { organizationId: 'org-1', organizationSlug: 'org', role },
      { organizationId: 'org-2', organizationSlug: 'other', role: 'owner' },
    ],
  };
}

const connectionRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'conn-1',
  display_name: 'Entra',
  idp_entity_id: 'https://sts.windows.net/t/',
  idp_sso_url: 'https://login.microsoftonline.com/t/saml2',
  idp_certs: ['pem'],
  is_enabled: true,
  jit_enabled: false,
  trust_updated_by: 'user-1',
  created_at: '2026-09-13T00:00:00Z',
  updated_at: '2026-09-13T00:00:00Z',
  ...overrides,
});

function make() {
  const queues: Record<string, ReturnType<typeof query>[]> = {};
  const client = {
    from: jest.fn((table: string) => queues[table]?.shift() ?? query()),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'publicApiUrl' ? 'https://api.test/api/v1' : undefined,
    ),
  };
  const accounts = { isCurrentOwner: jest.fn().mockResolvedValue(true) };
  const auditLogs = { logSystemAction: jest.fn().mockResolvedValue(undefined) };
  const entitlements = {
    getEffectiveEntitlements: jest.fn().mockResolvedValue({ has: () => true }),
  };
  const service = new SsoAdminService(
    { getClient: () => client } as never,
    config as never,
    accounts as never,
    auditLogs as never,
    entitlements as never,
  );
  const enqueue = (table: string, ...builders: ReturnType<typeof query>[]) => {
    queues[table] = [...(queues[table] ?? []), ...builders];
  };

  return { service, client, accounts, auditLogs, entitlements, enqueue };
}

describe('SsoAdminService', () => {
  describe('owner/admin gate', () => {
    it.each(['member', 'viewer'] as const)(
      'refuses a %s (e.g. a custom-role holder of can_edit_settings) before any query',
      async (role) => {
        const { service, client } = make();

        await expect(
          service.listConnections(actor(role)),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.createScimToken(actor(role), { label: 'Entra' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(client.from).not.toHaveBeenCalled();
      },
    );

    it('refuses a caller with no active organization', async () => {
      const { service } = make();

      await expect(
        service.getSettings({ ...actor('owner'), organizationId: '' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets an admin list connections, scoped to the org, with SP URLs', async () => {
      const { service, enqueue, accounts } = make();
      const list = ok([connectionRow()]);
      enqueue('sso_connections', list);
      accounts.isCurrentOwner.mockResolvedValue(false);

      const [connection] = await service.listConnections(actor('admin'));

      expect(list.eq).toHaveBeenCalledWith('organization_id', 'org-1');
      expect(accounts.isCurrentOwner).toHaveBeenCalledWith('org-1', 'user-1');
      expect(connection).toMatchObject({
        id: 'conn-1',
        owner_trusted: false,
        sp_entity_id: 'https://api.test/api/v1/auth/saml/conn-1/metadata',
        acs_url: 'https://api.test/api/v1/auth/saml/conn-1/acs',
        metadata_url: 'https://api.test/api/v1/auth/saml/conn-1/metadata',
      });
    });
  });

  describe('connections', () => {
    it('sets trust_updated_by on create and stores certificates as PEM', async () => {
      const { service, enqueue, auditLogs } = make();
      const insert = ok(connectionRow());
      enqueue('sso_connections', insert);

      await service.createConnection(actor('admin'), {
        display_name: ' Entra ',
        idp_entity_id: 'https://sts.windows.net/t/',
        idp_sso_url: 'https://login.microsoftonline.com/t/saml2',
        idp_certs: [CERT_BODY],
      });

      const payload = firstArg<{ idp_certs: string[] }>(insert.insert);
      expect(payload).toMatchObject({
        organization_id: 'org-1',
        display_name: 'Entra',
        created_by: 'user-1',
        updated_by: 'user-1',
        trust_updated_by: 'user-1',
        is_enabled: false,
      });
      expect(payload.idp_certs[0]).toMatch(
        /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----$/,
      );
      expect(
        JSON.stringify(auditLogs.logSystemAction.mock.calls),
      ).not.toContain(CERT_BODY.slice(0, 40));
    });

    it('rejects an invalid certificate with 400 before writing', async () => {
      const { service, client } = make();

      await expect(
        service.createConnection(actor('owner'), {
          display_name: 'Entra',
          idp_entity_id: 'x',
          idp_sso_url: 'https://idp.test/sso',
          idp_certs: ['not a certificate'],
        }),
      ).rejects.toThrow(new BadRequestException('invalid_certificate'));
      expect(client.from).not.toHaveBeenCalled();
    });

    it('does not touch trust_updated_by on a display_name-only change', async () => {
      const { service, enqueue } = make();
      const update = ok(connectionRow());
      enqueue('sso_connections', ok(connectionRow()), update);

      await service.updateConnection(actor('admin'), 'conn-1', {
        display_name: 'Renamed',
      });

      expect(update.update).toHaveBeenCalledWith({
        display_name: 'Renamed',
        updated_by: 'user-1',
      });
      expect(update.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    });

    it('sets trust_updated_by when certificates change', async () => {
      const { service, enqueue } = make();
      const update = ok(connectionRow());
      enqueue('sso_connections', ok(connectionRow()), update);

      await service.updateConnection(actor('admin'), 'conn-1', {
        idp_certs: [CERT_BODY],
      });

      expect(firstArg<object>(update.update)).toMatchObject({
        trust_updated_by: 'user-1',
        updated_by: 'user-1',
      });
    });

    it('keeps an owner vouch when an admin re-saves unchanged trust material', async () => {
      const { service, enqueue } = make();
      const update = ok(connectionRow({ trust_updated_by: 'owner-1' }));
      enqueue(
        'sso_connections',
        ok(connectionRow({ trust_updated_by: 'owner-1' })),
        update,
      );

      await service.updateConnection(actor('admin'), 'conn-1', {
        idp_entity_id: 'https://sts.windows.net/t/',
        idp_sso_url: 'https://login.microsoftonline.com/t/saml2',
        is_enabled: true,
      });

      expect(firstArg<object>(update.update)).not.toHaveProperty(
        'trust_updated_by',
      );
    });

    it('lets an owner vouch by re-saving unchanged trust material', async () => {
      const { service, enqueue } = make();
      const update = ok(connectionRow());
      enqueue(
        'sso_connections',
        ok(connectionRow({ trust_updated_by: 'admin-9' })),
        update,
      );

      await service.updateConnection(actor('owner'), 'conn-1', {
        idp_entity_id: 'https://sts.windows.net/t/',
        idp_sso_url: 'https://login.microsoftonline.com/t/saml2',
      });

      expect(firstArg<object>(update.update)).toMatchObject({
        trust_updated_by: 'user-1',
      });
    });

    it('lets an unentitled org only disable a connection (read-only grace)', async () => {
      const { service, enqueue, entitlements, client } = make();
      entitlements.getEffectiveEntitlements.mockResolvedValue({
        has: () => false,
      });

      await expect(
        service.updateConnection(actor('admin'), 'conn-1', {
          display_name: 'Renamed',
        }),
      ).rejects.toMatchObject({
        response: { code: 'FEATURE_NOT_ENTITLED' },
      });
      await expect(
        service.updateConnection(actor('admin'), 'conn-1', {
          is_enabled: false,
          display_name: 'Renamed',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(client.from).not.toHaveBeenCalled();

      const update = ok(connectionRow({ is_enabled: false }));
      enqueue('sso_connections', ok(connectionRow()), update);

      await expect(
        service.updateConnection(actor('admin'), 'conn-1', {
          is_enabled: false,
        }),
      ).resolves.toMatchObject({ is_enabled: false });
      expect(update.update).toHaveBeenCalledWith({
        is_enabled: false,
        updated_by: 'user-1',
      });
    });

    it('refuses deleting the last enabled connection while Require SSO is on', async () => {
      const { service, enqueue } = make();
      const del = query();
      enqueue(
        'sso_connections',
        ok(connectionRow()),
        ok([{ id: 'conn-1' }]),
        del,
      );
      enqueue('sso_organization_settings', ok({ require_sso: true }));
      enqueue('sso_domains', ok([{ id: 'd1', connection_id: 'conn-1' }]));

      await expect(
        service.deleteConnection(actor('owner'), 'conn-1'),
      ).rejects.toThrow(new ConflictException('require_sso_last_connection'));
      expect(del.delete).not.toHaveBeenCalled();
    });

    it('allows deleting it when another enabled connection still has a bound domain', async () => {
      const { service, enqueue } = make();
      const del = query();
      enqueue(
        'sso_connections',
        ok(connectionRow()),
        ok([{ id: 'conn-1' }, { id: 'conn-2' }]),
        del,
      );
      enqueue('sso_organization_settings', ok({ require_sso: true }));
      enqueue('sso_domains', ok([{ id: 'd2', connection_id: 'conn-2' }]));

      await expect(
        service.deleteConnection(actor('owner'), 'conn-1'),
      ).resolves.toEqual({ id: 'conn-1' });
      expect(del.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    });
  });

  describe('domains', () => {
    const domainRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'd1',
      domain: 'example.com',
      connection_id: 'conn-1',
      verification_token: 'abc123',
      verified_at: null,
      created_at: '2026-09-13T00:00:00Z',
      ...overrides,
    });

    it('refuses to verify an unbound domain', async () => {
      const { service, enqueue } = make();
      enqueue('sso_domains', ok(domainRow({ connection_id: null })));

      await expect(service.verifyDomain(actor('admin'), 'd1')).rejects.toThrow(
        new BadRequestException('domain_not_bound'),
      );
    });

    it('verifies when the TXT record carries the token', async () => {
      const { service, enqueue } = make();
      const update = ok(domainRow({ verified_at: '2026-09-13T01:00:00Z' }));
      enqueue('sso_domains', ok(domainRow()), update);
      const resolveTxt = stubTxt(service).mockResolvedValue([
        ['v=spf1 -all'],
        ['xisuite-sso=', 'abc123'],
      ]);

      const result = await service.verifyDomain(actor('admin'), 'd1');

      expect(resolveTxt).toHaveBeenCalledWith('_xisuite-sso.example.com');
      expect(
        firstArg<{ verified_at: string }>(update.update).verified_at,
      ).toEqual(expect.any(String));
      expect(result).toMatchObject({
        verified_at: '2026-09-13T01:00:00Z',
        txt_record_name: '_xisuite-sso.example.com',
        txt_record_value: 'xisuite-sso=abc123',
      });
    });

    it('fails verification when the TXT record is missing', async () => {
      const { service, enqueue } = make();
      enqueue('sso_domains', ok(domainRow()));
      stubTxt(service).mockRejectedValue(new Error('ENOTFOUND'));

      await expect(service.verifyDomain(actor('admin'), 'd1')).rejects.toThrow(
        new BadRequestException('domain_verification_failed'),
      );
    });

    it('maps a domain verified by another workspace to 409', async () => {
      const { service, enqueue } = make();
      enqueue(
        'sso_domains',
        ok(domainRow()),
        query({ data: null, error: { code: '23505', message: 'dup' } }),
      );
      stubTxt(service).mockResolvedValue([['xisuite-sso=abc123']]);

      await expect(service.verifyDomain(actor('admin'), 'd1')).rejects.toThrow(
        new ConflictException('domain_verified_elsewhere'),
      );
    });

    it('normalises and validates the domain on add', async () => {
      const { service, enqueue } = make();
      const insert = ok(domainRow());
      enqueue('sso_domains', insert);

      await service.addDomain(actor('admin'), { domain: ' Example.COM. ' });

      const payload = firstArg<{ verification_token: string }>(insert.insert);
      expect(payload).toMatchObject({
        organization_id: 'org-1',
        domain: 'example.com',
        connection_id: null,
      });
      expect(payload.verification_token).toMatch(/^[0-9a-f]{32}$/);
      await expect(
        service.addDomain(actor('admin'), { domain: 'localhost' }),
      ).rejects.toThrow(new BadRequestException('invalid_domain'));
    });
  });

  describe('SCIM tokens', () => {
    it('returns the plaintext once and stores only its sha256 hash', async () => {
      const { service, enqueue, auditLogs } = make();
      const insert = ok({
        id: 't1',
        label: 'Entra',
        token_prefix: 'xis_scim_abc',
        created_at: '2026-09-13T00:00:00Z',
        last_used_at: null,
        revoked_at: null,
        creator: {
          id: 'user-1',
          email: 'a@example.com',
          first_name: 'A',
          last_name: 'B',
        },
      });
      enqueue('scim_tokens', insert);

      const { token, scim_token } = await service.createScimToken(
        actor('owner'),
        { label: 'Entra' },
      );
      const payload = firstArg<{ token_hash: string; token_prefix: string }>(
        insert.insert,
      );

      expect(token).toMatch(/^xis_scim_[A-Za-z0-9_-]{43}$/);
      expect(payload.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(payload.token_hash).toBe(
        createHash('sha256').update(token).digest('hex'),
      );
      expect(payload.token_prefix).toBe(token.slice(0, 12));
      expect(JSON.stringify(payload)).not.toContain(token);
      expect(
        JSON.stringify(auditLogs.logSystemAction.mock.calls),
      ).not.toContain(token);
      expect(JSON.stringify(scim_token)).not.toContain(token);
    });
  });

  describe('settings', () => {
    it('refuses switching Require SSO on without a bound, verified domain', async () => {
      const { service, enqueue } = make();
      enqueue('sso_connections', ok([{ id: 'conn-1' }]));
      enqueue('sso_domains', ok([{ id: 'd1', connection_id: null }]));

      await expect(
        service.updateSettings(actor('owner'), { require_sso: true }),
      ).rejects.toThrow(new ConflictException('require_sso_not_ready'));
    });

    it('refuses switching it on when not entitled, but always allows switching off', async () => {
      const { service, entitlements, enqueue } = make();
      entitlements.getEffectiveEntitlements.mockResolvedValue({
        has: () => false,
      });
      const upsert = query();
      enqueue('sso_organization_settings', upsert);

      await expect(
        service.updateSettings(actor('owner'), { require_sso: true }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.updateSettings(actor('owner'), { require_sso: false }),
      ).resolves.toEqual({
        require_sso: false,
        scim_base_url: 'https://api.test/api/v1/scim/v2',
      });
      expect(upsert.upsert).toHaveBeenCalledWith(
        { organization_id: 'org-1', require_sso: false, updated_by: 'user-1' },
        { onConflict: 'organization_id' },
      );
    });
  });
});
