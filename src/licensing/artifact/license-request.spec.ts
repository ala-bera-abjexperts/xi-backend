/**
 * @fileoverview Request files are written by the box and trusted by the cloud
 * only as far as their own signature goes. Tests from the attacker's side.
 */

import {
  generateInstanceKeypair,
  signLicenseRequest,
  verifyLicenseRequest,
  type LicenseRequestBody,
} from './license-request';

const NOW = new Date('2026-11-20T12:00:00.000Z');

function body(over: Partial<LicenseRequestBody> = {}): LicenseRequestBody {
  const box = generateInstanceKeypair();

  return {
    v: 1,
    kind: 'license-request',
    installationId: 'inst-1',
    fingerprint: box.fingerprint,
    publicKey: box.publicKey,
    usage: { activeUsers: 7, totalUsers: 9, version: '1.2.0' },
    nonce: 'nonce-abcdefghijklmnop',
    createdAt: NOW.toISOString(),
    release: '1.2.0',
    ...over,
  };
}

describe('licence request files', () => {
  it('round-trips a genuine request', () => {
    const box = generateInstanceKeypair();
    const env = signLicenseRequest(
      body({ fingerprint: box.fingerprint, publicKey: box.publicKey }),
      box.privatePem,
    );

    const result = verifyLicenseRequest(env, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.usage.activeUsers).toBe(7);
  });

  it('rejects an edited request (usage lowered after signing)', () => {
    const box = generateInstanceKeypair();
    const env = signLicenseRequest(
      body({ fingerprint: box.fingerprint, publicKey: box.publicKey }),
      box.privatePem,
    );
    const tampered = JSON.parse(
      Buffer.from(env.enc, 'base64url').toString('utf8'),
    ) as LicenseRequestBody;
    tampered.usage.activeUsers = 1;

    expect(
      verifyLicenseRequest(
        {
          ...env,
          enc: Buffer.from(JSON.stringify(tampered)).toString('base64url'),
        },
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a request claiming another box fingerprint', () => {
    const box = generateInstanceKeypair();
    const other = generateInstanceKeypair();
    const env = signLicenseRequest(
      body({ fingerprint: other.fingerprint, publicKey: box.publicKey }),
      box.privatePem,
    );

    expect(verifyLicenseRequest(env, NOW)).toEqual({
      ok: false,
      reason: 'fingerprint_mismatch',
    });
  });

  it('rejects a stale request', () => {
    const box = generateInstanceKeypair();
    const env = signLicenseRequest(
      body({
        fingerprint: box.fingerprint,
        publicKey: box.publicKey,
        createdAt: '2026-09-01T00:00:00.000Z',
      }),
      box.privatePem,
    );

    expect(verifyLicenseRequest(env, NOW)).toEqual({
      ok: false,
      reason: 'too_old',
    });
  });

  it('rejects garbage without throwing', () => {
    expect(verifyLicenseRequest({ kind: 'license-request' }, NOW).ok).toBe(
      false,
    );
    expect(verifyLicenseRequest('nope', NOW).ok).toBe(false);
  });
});
