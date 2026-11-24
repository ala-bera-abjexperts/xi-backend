/**
 * @fileoverview Adversarial tests for licence artifact signing and verification.
 * @module licensing/artifact/license-artifact.crypto.spec
 *
 * Author: Prince Jadiya
 *
 * These are written from the attacker's side, because the threat model is a
 * customer who owns the host, the database, the clock and the network. Each
 * test is a thing such a customer would actually try.
 */

import {
  createPrivateKey,
  generateKeyPairSync,
  sign as nodeSign,
} from 'node:crypto';
import {
  SIGN_PREFIX,
  signLicenseArtifact,
  verifyLicenseArtifact,
} from './license-artifact.crypto';
import type { LicenseArtifactPayload } from './license-artifact.types';

function makeKeypair(): { privatePem: string; publicDerB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicDerB64: (
      publicKey.export({ type: 'spki', format: 'der' }) as Buffer
    ).toString('base64'),
  };
}

const NOW = new Date('2026-08-06T12:00:00.000Z');

function payload(
  over: Partial<LicenseArtifactPayload> = {},
): LicenseArtifactPayload {
  return {
    v: 1,
    installationId: 'inst-1',
    organizationId: 'org-1',
    planKey: 'pro',
    status: 'active',
    features: { module_wiki: true, module_site_studio: true },
    limits: { limit_users: 50 },
    issuedAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-08-20T00:00:00.000Z',
    nonce: 'nonce-abc',
    release: '1.1.31',
    ...over,
  };
}

describe('licence artifact crypto', () => {
  const vendor = makeKeypair();
  const trustedKeys = { v1: vendor.publicDerB64 };

  const sign = (p: LicenseArtifactPayload = payload()) =>
    signLicenseArtifact(p, vendor.privatePem, 'v1');

  describe('the happy path', () => {
    it('round-trips a payload unchanged', () => {
      const result = verifyLicenseArtifact(sign(), {
        now: NOW,
        expectedNonce: 'nonce-abc',
        trustedKeys,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload).toEqual(payload());
      }
    });

    it('accepts a manually imported artifact, which has no nonce to echo', () => {
      const result = verifyLicenseArtifact(sign(payload({ nonce: null })), {
        now: NOW,
        expectedNonce: null,
        trustedKeys,
      });

      expect(result.ok).toBe(true);
    });
  });

  describe('tampering', () => {
    it('rejects an edited payload', () => {
      const envelope = sign();
      // Grant ourselves a premium module we did not pay for.
      const forged = JSON.parse(
        Buffer.from(envelope.enc, 'base64url').toString('utf-8'),
      ) as LicenseArtifactPayload;
      forged.features.module_site_studio = true;
      forged.limits.limit_users = 999999;

      const tampered = {
        ...envelope,
        enc: Buffer.from(JSON.stringify(forged)).toString('base64url'),
      };

      expect(
        verifyLicenseArtifact(tampered, { now: NOW, trustedKeys }),
      ).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects an artifact signed by a key we do not trust', () => {
      // The customer generates their own keypair and self-signs.
      const attacker = makeKeypair();
      const forged = signLicenseArtifact(payload(), attacker.privatePem, 'v1');

      expect(verifyLicenseArtifact(forged, { now: NOW, trustedKeys })).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
    });

    it('rejects an unknown key id', () => {
      const envelope = { ...sign(), kid: 'attacker-key' };

      expect(
        verifyLicenseArtifact(envelope, { now: NOW, trustedKeys }),
      ).toEqual({ ok: false, reason: 'unknown_key' });
    });

    it('rejects a signature that omits the domain prefix', () => {
      // Proves the prefix is actually part of the signed message: a signature
      // over `enc` alone must not verify, or it could be transplanted from
      // another artifact type.
      const envelope = sign();
      const bare = signLicenseArtifact(payload(), vendor.privatePem, 'v1');

      // Sign `enc` WITHOUT the `license/` prefix, using the vendor's real key.
      // The signature is therefore cryptographically valid, and must still be
      // rejected purely because the signed message is not domain-separated.
      const withoutPrefix = {
        ...envelope,
        sig: nodeSign(
          null,
          Buffer.from(bare.enc, 'utf-8'),
          createPrivateKey(vendor.privatePem),
        ).toString('base64url'),
      };

      expect(
        verifyLicenseArtifact(withoutPrefix, { now: NOW, trustedKeys }),
      ).toEqual({ ok: false, reason: 'bad_signature' });
      expect(SIGN_PREFIX).toBe('license/');
    });

    it('rejects a downgraded algorithm', () => {
      const envelope = { ...sign(), alg: 'none' as unknown as never };

      expect(
        verifyLicenseArtifact(envelope, { now: NOW, trustedKeys }),
      ).toEqual({ ok: false, reason: 'unknown_algorithm' });
    });
  });

  describe('time', () => {
    it('rejects an artifact past its expiry, which is how offline boxes lock', () => {
      const result = verifyLicenseArtifact(sign(), {
        now: new Date('2026-09-01T00:00:00.000Z'),
        trustedKeys,
      });

      expect(result).toEqual({ ok: false, reason: 'expired' });
    });

    it('rejects an artifact from the future', () => {
      const result = verifyLicenseArtifact(sign(), {
        now: new Date('2026-08-01T00:00:00.000Z'),
        trustedKeys,
      });

      expect(result).toEqual({ ok: false, reason: 'not_yet_valid' });
    });

    it('tolerates a box clock a few minutes behind the vendor, but not more', () => {
      const issuedAt = new Date(NOW.getTime() + 3 * 60_000).toISOString();
      const fresh = sign(payload({ issuedAt }));

      expect(verifyLicenseArtifact(fresh, { now: NOW, trustedKeys }).ok).toBe(
        true,
      );

      const tooFar = sign(
        payload({
          issuedAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
        }),
      );

      expect(verifyLicenseArtifact(tooFar, { now: NOW, trustedKeys })).toEqual({
        ok: false,
        reason: 'not_yet_valid',
      });
    });

    it('winding the clock BACK cannot revive an expired artifact beyond its issue date', () => {
      // Setting the clock back far enough to dodge `expired` lands in
      // `not_yet_valid` instead. There is no window where a stale artifact is
      // accepted, which is what makes the signed window a real bound.
      const old = sign(
        payload({
          issuedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-15T00:00:00.000Z',
        }),
      );

      expect(verifyLicenseArtifact(old, { now: NOW, trustedKeys })).toEqual({
        ok: false,
        reason: 'expired',
      });

      expect(
        verifyLicenseArtifact(old, {
          now: new Date('2025-06-01T00:00:00.000Z'),
          trustedKeys,
        }),
      ).toEqual({ ok: false, reason: 'not_yet_valid' });
    });
  });

  describe('replay', () => {
    it('rejects a captured response replayed against a fresh nonce', () => {
      // The customer points DNS at their own server and re-serves yesterday's
      // valid response. The nonce we just generated will not match.
      const captured = sign(payload({ nonce: 'yesterdays-nonce' }));

      expect(
        verifyLicenseArtifact(captured, {
          now: NOW,
          expectedNonce: 'todays-nonce',
          trustedKeys,
        }),
      ).toEqual({ ok: false, reason: 'nonce_mismatch' });
    });
  });

  describe('malformed input', () => {
    it.each([
      ['null', null],
      ['a string', 'not-an-envelope'],
      ['an empty object', {}],
      ['a missing signature', { enc: 'x', alg: 'base64+ed25519', kid: 'v1' }],
    ])('rejects %s without throwing', (_label, input) => {
      expect(() =>
        verifyLicenseArtifact(input, { now: NOW, trustedKeys }),
      ).not.toThrow();
      expect(verifyLicenseArtifact(input, { now: NOW, trustedKeys }).ok).toBe(
        false,
      );
    });

    it('rejects a validly signed envelope whose payload is not a v1 licence', () => {
      const junk = signLicenseArtifact(
        { hello: 'world' } as unknown as LicenseArtifactPayload,
        vendor.privatePem,
        'v1',
      );

      expect(verifyLicenseArtifact(junk, { now: NOW, trustedKeys })).toEqual({
        ok: false,
        reason: 'malformed',
      });
    });
  });

  describe('fail-closed posture', () => {
    it('rejects everything when no keys are trusted', () => {
      // The compiled key map ships empty until the vendor key is added. That
      // must fail closed, never open.
      expect(
        verifyLicenseArtifact(sign(), { now: NOW, trustedKeys: {} }),
      ).toEqual({ ok: false, reason: 'unknown_key' });
    });
  });
});
