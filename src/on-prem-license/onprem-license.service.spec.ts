/**
 * @fileoverview Proves the on-premise lock actually locks, and that it reaches
 * the entitlements resolver.
 * @module on-prem-license/onprem-license.service.spec
 *
 * Author: Prince Jadiya
 */

import { generateKeyPairSync } from 'node:crypto';
import { signLicenseArtifact } from '../licensing/artifact/license-artifact.crypto';
import type { LicenseArtifactPayload } from '../licensing/artifact/license-artifact.types';
import { EntitlementsService } from '../licensing/entitlements.service';
import type { LicensingRepository } from '../licensing/licensing.repository';
import { generateInstanceKeypair } from '../licensing/artifact/license-request';
import { GRACE_MS, OnpremLicenseStateService } from './onprem-license.service';
import type { OnpremLicenseStateRepository } from './onprem-license-state.repository';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PRIVATE_PEM = privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();
const PUBLIC_DER_B64 = (
  publicKey.export({ type: 'spki', format: 'der' }) as Buffer
).toString('base64');

const NOW = new Date('2026-08-06T12:00:00.000Z');

/** This box's identity, as stored in its own database. */
const BOX = generateInstanceKeypair();
const BOX_ROW = {
  instance_private_key: BOX.privatePem,
  instance_public_key: BOX.publicKey,
};

function artifact(over: Partial<LicenseArtifactPayload> = {}) {
  const payload: LicenseArtifactPayload = {
    v: 1,
    installationId: 'inst-1',
    organizationId: 'org-1',
    planKey: 'pro',
    status: 'active',
    features: { module_site_studio: true },
    limits: {},
    issuedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-20T00:00:00.000Z',
    nonce: null,
    release: '1.1.31',
    fingerprint: BOX.fingerprint,
    ...over,
  };

  return signLicenseArtifact(payload, PRIVATE_PEM, 'v1');
}

/** Minimal state-repo double; only what evaluate() touches. */
function repoWith(row: Record<string, unknown> | null) {
  return {
    get: jest
      .fn()
      .mockResolvedValue(row === null ? null : { ...BOX_ROW, ...row }),
    patch: jest.fn().mockResolvedValue(undefined),
    observeClock: jest
      .fn()
      .mockResolvedValue({ woundBack: false, violations: 0 }),
  };
}

/**
 * The real verifier, captured ONCE before any spy exists.
 *
 * `jest.requireActual` returns the same cached module object that `jest.spyOn`
 * mutates, so calling it from inside the mock would re-enter the mock and blow
 * the stack. Capturing the reference up front is what breaks that cycle.
 */
const cryptoModule = jest.requireActual<
  typeof import('../licensing/artifact/license-artifact.crypto')
>('../licensing/artifact/license-artifact.crypto');
const realVerify = cryptoModule.verifyLicenseArtifact;

function build(
  row: Record<string, unknown> | null,
  env: Record<string, string> = {},
) {
  const repo = repoWith(row);
  const config = { get: jest.fn((key: string) => env[key] ?? '') };
  const svc = new OnpremLicenseStateService(
    repo as unknown as OnpremLicenseStateRepository,
    config as never,
  );

  // Sign with this test's throwaway key and trust only that, so no test ever
  // depends on (or could weaken) the compiled-in production key.
  jest
    .spyOn(cryptoModule, 'verifyLicenseArtifact')
    .mockImplementation((env, opts) =>
      realVerify(env, { ...opts, trustedKeys: { v1: PUBLIC_DER_B64 } }),
    );

  return { svc, repo };
}

afterEach(() => jest.restoreAllMocks());

const DAY = 24 * 60 * 60 * 1000;

describe('on-premise licence state', () => {
  it('is entitled (and writable) on a valid licence issued for this box', async () => {
    const { svc } = build({ artifact: artifact(), expires_at: null });

    await expect(svc.evaluate(NOW)).resolves.toMatchObject({
      entitled: true,
      readOnly: false,
      reason: null,
      provisional: false,
    });
  });

  it('refuses a genuine licence issued for ANOTHER box (fingerprint binding)', async () => {
    const other = generateInstanceKeypair();
    const { svc } = build({
      artifact: artifact({ fingerprint: other.fingerprint }),
    });

    await expect(svc.evaluate(NOW)).resolves.toMatchObject({
      provisional: true,
      reason: 'fingerprint_mismatch',
      payload: null,
    });
  });

  it('refuses a licence for a different installation once bound', async () => {
    const { svc } = build({
      artifact: artifact({ installationId: 'inst-OTHER' }),
      installation_id: 'inst-1',
    });

    await expect(svc.evaluate(NOW)).resolves.toMatchObject({
      reason: 'installation_mismatch',
    });
  });

  it("accepts the cloud tenant's licence although the box's own ON_PREMISE_ORG_ID differs", async () => {
    // The artifact names the customer's CLOUD org; the box's local org was
    // created independently and never shares its id.
    const { svc } = build(
      {
        artifact: artifact({ organizationId: 'cloud-org' }),
        installation_id: 'inst-1',
      },
      { 'onPrem.orgId': 'local-box-org' },
    );

    await expect(svc.evaluate(NOW)).resolves.toMatchObject({
      entitled: true,
      readOnly: false,
      reason: null,
    });
  });

  it('after expiry keeps the licence features for 14 days, then goes read-only', async () => {
    const expired = {
      artifact: artifact({ expiresAt: '2026-08-10T00:00:00.000Z' }),
      expires_at: '2026-08-10T00:00:00.000Z',
    };

    const inGrace = build(expired);
    const s1 = await inGrace.svc.evaluate(new Date('2026-08-15T00:00:00.000Z'));
    expect(s1).toMatchObject({
      entitled: true,
      readOnly: false,
      provisional: true,
      reason: 'artifact_expired',
    });
    // The grace started at the licence's expiry, not "now".
    expect(s1.graceEndsAt).toBe(
      new Date(Date.parse('2026-08-10T00:00:00.000Z') + GRACE_MS).toISOString(),
    );
    expect(OnpremLicenseStateService.snapshotOf(s1.payload)).toEqual({
      features: { module_site_studio: true },
      limits: {},
    });

    const past = build(expired);
    await expect(
      past.svc.evaluate(new Date('2026-08-25T00:00:00.000Z')),
    ).resolves.toMatchObject({ entitled: false, readOnly: true });
  });

  it('a box that never got a licence is NOT unlimited forever: grace, then read-only', async () => {
    const fresh = build(null);
    await expect(fresh.svc.evaluate(NOW)).resolves.toMatchObject({
      entitled: true,
      provisional: true,
      reason: 'never_checked_in',
    });
    // The grace start is persisted, so a restart cannot reset it.
    expect(fresh.repo.patch).toHaveBeenCalledWith({
      grace_started_at: NOW.toISOString(),
    });

    const old = build({
      grace_started_at: new Date(NOW.getTime() - 15 * DAY).toISOString(),
    });
    await expect(old.svc.evaluate(NOW)).resolves.toMatchObject({
      entitled: false,
      readOnly: true,
    });
  });

  it('a vendor lock is read-only at once (no grace)', async () => {
    const { svc } = build({
      artifact: artifact({ status: 'locked', features: {} }),
    });

    await expect(svc.evaluate(NOW)).resolves.toMatchObject({
      entitled: false,
      readOnly: true,
      reason: 'vendor_locked',
    });
  });

  it('an unrecognised activation code runs on grace (setup typo), not locked', async () => {
    const { svc } = build({ artifact: artifact({ status: 'unknown' }) });

    await expect(svc.evaluate(NOW)).resolves.toMatchObject({
      entitled: true,
      provisional: true,
      reason: 'unknown_installation',
    });
  });

  it('a sustained wound-back clock makes the box read-only; one blip does not', async () => {
    const { svc, repo } = build({ artifact: artifact() });

    repo.observeClock.mockResolvedValue({ woundBack: true, violations: 1 });
    await expect(svc.evaluate(NOW)).resolves.toMatchObject({ entitled: true });

    repo.observeClock.mockResolvedValue({ woundBack: true, violations: 3 });
    await expect(svc.evaluate(NOW)).resolves.toMatchObject({
      entitled: false,
      readOnly: true,
      reason: 'clock_tampered',
    });
  });

  it('creates and stores an identity keypair on first use', async () => {
    const repo = repoWith(null);
    repo.get.mockResolvedValue(null);
    const svc = new OnpremLicenseStateService(
      repo as unknown as OnpremLicenseStateRepository,
      { get: () => '' } as never,
    );

    const id = await svc.identity(null);

    expect(id.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.patch).toHaveBeenCalledWith(
      expect.objectContaining({ instance_public_key: id.publicKey }),
    );
  });

  it('polls fast while not on a valid licence and near expiry, daily otherwise', async () => {
    const locked = build({ artifact: artifact({ status: 'locked' }) });
    await expect(locked.svc.needsFastCadence(NOW)).resolves.toBe(true);

    const nearExpiry = build({
      artifact: artifact({ expiresAt: '2026-08-06T18:00:00.000Z' }),
    });
    await expect(nearExpiry.svc.needsFastCadence(NOW)).resolves.toBe(true);

    const healthy = build({ artifact: artifact() });
    await expect(healthy.svc.needsFastCadence(NOW)).resolves.toBe(false);
  });
});

describe('the signed licence drives the entitlements resolver', () => {
  const licensingRepo = {
    getLiveLicenses: jest.fn().mockResolvedValue([]),
    getLatestInactiveLicense: jest.fn().mockResolvedValue(null),
    isCreatedBeforeGrandfatherCutoff: jest.fn().mockResolvedValue(true),
    listPlanFeatures: jest.fn().mockResolvedValue([]),
    listOverrides: jest.fn().mockResolvedValue([]),
    listOverridesForLicenses: jest.fn().mockResolvedValue([]),
    listDistinctPlanFeatureKeys: jest.fn().mockResolvedValue([]),
  };
  const make = () =>
    new EntitlementsService(licensingRepo as unknown as LicensingRepository);

  it('grants exactly what the signed licence grants, ignoring local rows', async () => {
    const svc = make();
    svc.registerOnPremGate(() =>
      Promise.resolve({
        entitled: true,
        readOnly: false,
        snapshot: {
          features: { module_tasks: true, module_wiki: false },
          limits: { limit_users: 40 },
        },
      }),
    );

    const ent = await svc.getEffectiveEntitlements('org-1');

    expect(ent.grandfathered).toBe(false);
    expect(ent.has('module_tasks')).toBe(true);
    expect(ent.has('module_wiki')).toBe(false);
    expect(ent.has('module_site_studio')).toBe(false);
    expect(ent.getLimit('limit_users')).toBe(40);
    expect(licensingRepo.getLiveLicenses).not.toHaveBeenCalled();
  });

  it('drops to the free tier when no licence ever verified and the grace is over', async () => {
    const svc = make();
    svc.registerOnPremGate(() =>
      Promise.resolve({ entitled: false, readOnly: true, snapshot: null }),
    );

    const ent = await svc.getEffectiveEntitlements('org-1');

    expect(ent.grandfathered).toBe(false);
    expect(ent.licenseStatus).toBe('expired');
    expect(ent.has('module_site_studio')).toBe(false);
    expect(ent.getLimit('limit_users')).toBe(5);
  });

  it('leaves SaaS untouched when no gate is registered', async () => {
    const ent = await make().getEffectiveEntitlements('org-2');

    expect(ent.grandfathered).toBe(true);
    expect(ent.has('module_site_studio')).toBe(true);
  });
});
