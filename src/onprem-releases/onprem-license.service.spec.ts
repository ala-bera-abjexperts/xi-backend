/**
 * @fileoverview Issuer tests: who an on-prem artifact is signed for, and how a
 * pending install activates.
 * @module onprem-releases/onprem-license.service.spec
 */

import { generateKeyPairSync } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { EntitlementsService } from '../licensing/entitlements.service';
import { verifyLicenseArtifact } from '../licensing/artifact/license-artifact.crypto';
import { SUPER_ADMIN_KEY } from '../auth/decorators/require-super-admin.decorator';
import {
  generateInstanceKeypair,
  signLicenseRequest,
} from '../licensing/artifact/license-request';
import {
  normalizeSigningKeyPem,
  OnpremLicenseService,
} from './onprem-license.service';
import { OnpremReleasesController } from './onprem-releases.controller';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PRIVATE_PEM = privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();
const TRUSTED = {
  test: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString(
    'base64',
  ),
};

const PARTNER_ORG = 'partner-org';
const CUSTOMER_ORG = 'customer-org';

type InstallRow = Record<string, unknown>;

function buildClient(install: InstallRow | null) {
  const updates: Array<{ patch: Record<string, unknown>; filters: string[] }> =
    [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

  const from = jest.fn((table: string) => {
    const filters: string[] = [];
    const chain: Record<string, unknown> = {};
    chain.select = jest.fn(() => chain);
    for (const m of ['or', 'limit', 'is']) chain[m] = jest.fn(() => chain);
    chain.insert = jest.fn((row: Record<string, unknown>) => {
      inserts.push({ table, row });

      return Promise.resolve({ data: null, error: null });
    });
    chain.update = jest.fn((patch: Record<string, unknown>) => {
      updates.push({ patch, filters });

      return chain;
    });
    chain.eq = jest.fn((col: string, val: unknown) => {
      filters.push(`${col}=${String(val)}`);

      return chain;
    });
    chain.maybeSingle = jest.fn(() =>
      Promise.resolve({ data: install, error: null }),
    );
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve);

    return chain;
  });

  return { client: { from }, updates, inserts };
}

function buildService(install: InstallRow | null, grandfathered = false) {
  const { client, updates, inserts } = buildClient(install);
  const entitlements = {
    getEffectiveEntitlements: jest.fn().mockResolvedValue({
      grandfathered,
      licenseStatus: 'active',
    }),
  };
  jest.spyOn(EntitlementsService, 'toSnapshot').mockReturnValue({
    features: { module_tasks: true },
    limits: { limit_users: 25 },
  } as never);
  const config = {
    get: jest.fn((key: string) =>
      key === 'onPremLicense.signingKeyPem' ? PRIVATE_PEM : 'test',
    ),
  };
  const service = new OnpremLicenseService(
    { getClient: () => client } as never,
    entitlements as never,
    config as never,
  );

  return { service, entitlements, updates, inserts };
}

function decode(envelope: unknown) {
  const result = verifyLicenseArtifact(envelope, {
    now: new Date(),
    trustedKeys: TRUSTED,
  });
  if (!result.ok) throw new Error(`verify failed: ${result.reason}`);

  return result.payload;
}

const baseInstall = (over: InstallRow = {}): InstallRow => ({
  id: 'inst-1',
  organization_id: PARTNER_ORG,
  organization_license_id: 'lic-1',
  status: 'active',
  mode: 'connected',
  instance_fingerprint: null,
  metadata: null,
  organization_licenses: {
    organization_id: CUSTOMER_ORG,
    deployment_type: 'onprem',
  },
  ...over,
});

const req = {
  activationCode: 'code-123456',
  nonce: 'nonce-abcdefghijklmnop',
  release: '1.2.0',
  hostInfo: null,
};

describe('OnpremLicenseService.issue', () => {
  afterEach(() => jest.restoreAllMocks());

  it('signs the CUSTOMER org entitlements, not the partner org', async () => {
    const { service, entitlements } = buildService(baseInstall());

    const payload = decode(await service.issue(req));

    expect(entitlements.getEffectiveEntitlements).toHaveBeenCalledWith(
      CUSTOMER_ORG,
    );
    expect(entitlements.getEffectiveEntitlements).not.toHaveBeenCalledWith(
      PARTNER_ORG,
    );
    expect(payload.organizationId).toBe(CUSTOMER_ORG);
    expect(payload.status).toBe('active');
    expect(payload.limits).toEqual({ limit_users: 25 });
  });

  it('activates a pending install on its first successful check-in', async () => {
    const { service, updates } = buildService(
      baseInstall({ status: 'pending' }),
    );

    const payload = decode(await service.issue(req));

    expect(payload.status).toBe('active');
    const activation = updates.find((u) => u.patch.status === 'active');
    expect(activation).toBeDefined();
    expect(activation?.filters).toEqual(
      expect.arrayContaining(['id=inst-1', 'status=pending']),
    );
  });

  it('does not activate a pending install whose customer is unlicensed', async () => {
    const { service, updates } = buildService(
      baseInstall({ status: 'pending' }),
      true,
    );

    const payload = decode(await service.issue(req));

    expect(payload.status).toBe('locked');
    expect(updates.find((u) => u.patch.status === 'active')).toBeUndefined();
  });

  it('locks an install whose licence row is missing', async () => {
    const { service, entitlements } = buildService(
      baseInstall({ organization_licenses: null }),
    );

    const payload = decode(await service.issue(req));

    expect(payload.status).toBe('locked');
    expect(payload.features).toEqual({});
    expect(entitlements.getEffectiveEntitlements).not.toHaveBeenCalled();
  });

  it('locks a deactivated install even with a live licence', async () => {
    const { service } = buildService(baseInstall({ status: 'inactive' }));

    expect(decode(await service.issue(req)).status).toBe('locked');
  });
});

describe('instance binding, usage and offline licences', () => {
  afterEach(() => jest.restoreAllMocks());

  const box = generateInstanceKeypair();
  const identity = { fingerprint: box.fingerprint, publicKey: box.publicKey };

  it('binds the first box that checks in (trust on first use) and records usage', async () => {
    const { service, updates, inserts } = buildService(baseInstall());

    const payload = decode(
      await service.issue({
        ...req,
        ...identity,
        usage: { activeUsers: 12, totalUsers: 15, version: '1.2.0' },
      }),
    );

    expect(payload.fingerprint).toBe(box.fingerprint);
    expect(
      updates.find((u) => u.patch.instance_fingerprint === box.fingerprint),
    ).toBeDefined();
    await new Promise((r) => setImmediate(r));
    expect(inserts).toContainEqual(
      expect.objectContaining({
        table: 'onprem_usage_reports',
        row: expect.objectContaining({
          active_users: 12,
          source: 'poll',
        }) as unknown,
      }),
    );
  });

  it('a second box using the same code gets a licence bound to the FIRST box', async () => {
    const intruder = generateInstanceKeypair();
    const { service, updates, inserts } = buildService(
      baseInstall({ instance_fingerprint: box.fingerprint }),
    );

    const payload = decode(
      await service.issue({
        ...req,
        fingerprint: intruder.fingerprint,
        publicKey: intruder.publicKey,
        usage: { activeUsers: 999, totalUsers: 999, version: '9.9.9' },
      }),
    );

    // The intruder's box refuses it (fingerprint_mismatch on the box side).
    expect(payload.fingerprint).toBe(box.fingerprint);

    // ...and it must not overwrite the real server's check-in or usage.
    await new Promise((r) => setImmediate(r));
    expect(updates.find((u) => 'last_heartbeat_at' in u.patch)).toBeUndefined();
    expect(
      inserts.find((i) => i.table === 'onprem_usage_reports'),
    ).toBeUndefined();
  });

  it('ignores an identity whose key does not hash to the claimed fingerprint', async () => {
    const other = generateInstanceKeypair();
    const { service, updates } = buildService(baseInstall());

    await service.issue({
      ...req,
      fingerprint: box.fingerprint,
      publicKey: other.publicKey,
    });

    expect(
      updates.find((u) => 'instance_fingerprint' in u.patch),
    ).toBeUndefined();
  });

  it('answers an air-gapped request file with a 90-day licence for that box and nonce', async () => {
    const { service, inserts } = buildService(
      baseInstall({ mode: 'airgapped' }),
    );
    const request = signLicenseRequest(
      {
        v: 1,
        kind: 'license-request',
        installationId: null,
        ...identity,
        usage: { activeUsers: 3, totalUsers: 4, version: '1.2.0' },
        nonce: 'offline-nonce-1234567890',
        createdAt: new Date().toISOString(),
        release: '1.2.0',
      },
      box.privatePem,
    );

    const payload = decode(
      await service.issueOffline({ id: 'inst-1' }, request),
    );

    expect(payload.nonce).toBe('offline-nonce-1234567890');
    expect(payload.fingerprint).toBe(box.fingerprint);
    const days =
      (Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)) /
      86_400_000;
    expect(Math.round(days)).toBe(90);
    expect(inserts).toContainEqual(
      expect.objectContaining({
        table: 'onprem_usage_reports',
        row: expect.objectContaining({
          source: 'offline',
          active_users: 3,
        }) as unknown,
      }),
    );
  });

  it('refuses an offline request from a box other than the bound one', async () => {
    const intruder = generateInstanceKeypair();
    const { service } = buildService(
      baseInstall({ instance_fingerprint: box.fingerprint }),
    );
    const request = signLicenseRequest(
      {
        v: 1,
        kind: 'license-request',
        installationId: null,
        fingerprint: intruder.fingerprint,
        publicKey: intruder.publicKey,
        usage: { activeUsers: 1, totalUsers: 1, version: null },
        nonce: 'offline-nonce-1234567890',
        createdAt: new Date().toISOString(),
        release: null,
      },
      intruder.privatePem,
    );

    await expect(
      service.issueOffline({ id: 'inst-1' }, request),
    ).rejects.toThrow(/bound to a different box/);
  });
});

describe('OnpremReleasesController.publish', () => {
  it('is restricted to platform super admins', () => {
    const reflector = new Reflector();

    const publish = Object.getOwnPropertyDescriptor(
      OnpremReleasesController.prototype,
      'publish',
    )?.value as () => unknown;

    expect(reflector.get(SUPER_ADMIN_KEY, publish)).toBe(true);
  });
});

describe('signing key as delivered by secret stores', () => {
  const gen = generateKeyPairSync;
  const pem = gen('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const body = pem
    .split('\n')
    .filter((l) => l && !l.startsWith('-----'))
    .join('');

  it.each([
    ['plain PEM', pem],
    ['escaped \\n on one line', pem.replace(/\n/g, '\\n')],
    ['wrapped in quotes', `"${pem.replace(/\n/g, '\\n')}"`],
    ['base64 body only', body],
  ])('accepts %s', (_label, raw) => {
    expect(normalizeSigningKeyPem(raw)).toBe(pem);
  });

  it('rejects garbage and non-Ed25519 keys instead of throwing', () => {
    const rsa = gen('rsa', { modulusLength: 1024 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();

    expect(normalizeSigningKeyPem('not a key')).toBeNull();
    expect(normalizeSigningKeyPem(rsa)).toBeNull();
  });
});
