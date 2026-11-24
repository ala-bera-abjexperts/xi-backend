/**
 * @fileoverview Ed25519 signing and verification for the licence artifact.
 * @module licensing/artifact/license-artifact.crypto
 *
 * Author: Prince Jadiya
 *
 * THE PUBLIC KEY IS COMPILED IN, NOT READ FROM THE ENVIRONMENT.
 * This is the single most important decision in the whole licensing mechanism.
 * The on-prem customer controls their own environment files, so a public key
 * supplied via env could simply be replaced with one whose private half they
 * hold, letting them mint their own licences. A compiled constant can only be
 * changed by shipping a new image, which is the vendor's to control.
 *
 * Keys are held in a map by `kid` so a key can be rotated by shipping a release
 * that trusts both the old and the new one, rather than needing a flag day.
 *
 * Only the SIGNING half needs a private key, and only the SaaS side ever signs.
 * On-prem images never carry a private key at all.
 */

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type {
  LicenseArtifactEnvelope,
  LicenseArtifactPayload,
  LicenseArtifactVerification,
} from './license-artifact.types';

/**
 * Domain separation prefix. The signature covers `SIGN_PREFIX + enc`, so a
 * signature is bound to the fact that it authorises a licence and cannot be
 * lifted onto another artifact type that happens to encode the same bytes.
 */
export const SIGN_PREFIX = 'license/';

/**
 * Trusted verification keys, by `kid`. SPKI DER, base64.
 *
 * Only real vendor keys belong here, never a test key: a key whose private
 * half is in git history would fail OPEN. An unknown kid fails `unknown_key`.
 *
 * To add one (e.g. for rotation, keeping the old kid until every box has
 * moved on): node scripts/generate-onprem-license-key.mjs <file> v2
 * Keep the private half in the SaaS secret store only. It must never appear in
 * this repository, in an image, or in any customer-facing artefact.
 */
export const TRUSTED_PUBLIC_KEYS: Readonly<Record<string, string>> =
  Object.freeze({
    // Production key, generated 2026-11-24. Private half: SaaS secret store
    // (ONPREM_LICENSE_SIGNING_KEY, ONPREM_LICENSE_SIGNING_KEY_ID=v1) only.
    v1: 'MCowBQYDK2VwAyEAjSCdbCRwIhXOArG9hwhRlgeesJzRFg/RCRXDMUkgPgY=',
  });

/**
 * How far the box's clock may run BEHIND the vendor's before a freshly issued
 * artifact counts as `not_yet_valid`. NTP-less customer servers drift by
 * minutes; a forward-set clock is still caught as `expired` / clock tamper.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

/** base64url encode without padding, so the artifact is URL and file safe. */
function b64u(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function unb64u(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));

  return Buffer.from(
    input.replace(/-/g, '+').replace(/_/g, '/') + pad,
    'base64',
  );
}

/**
 * Signs a payload. SaaS side only.
 *
 * @param privateKeyPem PKCS#8 PEM for the Ed25519 signing key, from the SaaS
 *   secret store. Never hard-coded and never shipped to a customer.
 */
export function signLicenseArtifact(
  payload: LicenseArtifactPayload,
  privateKeyPem: string,
  kid: string,
): LicenseArtifactEnvelope {
  const enc = b64u(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const key = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(SIGN_PREFIX + enc, 'utf-8'), key);

  return { enc, sig: b64u(signature), alg: 'base64+ed25519', kid };
}

/**
 * Verifies an artifact and returns its payload, or a machine-readable reason.
 *
 * Never throws: a malformed artifact from a hostile or broken source is an
 * expected input here, not an exceptional one, and a throw on the poll path
 * would be indistinguishable from a transport failure.
 *
 * Order matters. Signature is checked BEFORE any field is trusted, because
 * `expiresAt` and `nonce` are themselves attacker-supplied until proven signed.
 *
 * @param now Injected so time-dependent behaviour is testable and so the caller
 *   can apply its own clock-tamper policy before calling.
 * @param expectedNonce When provided, the payload's nonce must match exactly.
 *   Pass null for a manually imported artifact, which has no request to echo.
 * @param trustedKeys Override for tests. Defaults to the compiled-in set.
 */
export function verifyLicenseArtifact(
  envelope: unknown,
  opts: {
    now: Date;
    expectedNonce?: string | null;
    trustedKeys?: Readonly<Record<string, string>>;
  },
): LicenseArtifactVerification {
  const keys = opts.trustedKeys ?? TRUSTED_PUBLIC_KEYS;

  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    typeof (envelope as LicenseArtifactEnvelope).enc !== 'string' ||
    typeof (envelope as LicenseArtifactEnvelope).sig !== 'string' ||
    typeof (envelope as LicenseArtifactEnvelope).kid !== 'string'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const { enc, sig, alg, kid } = envelope as LicenseArtifactEnvelope;

  if (alg !== 'base64+ed25519') {
    return { ok: false, reason: 'unknown_algorithm' };
  }

  const publicKeyB64 = keys[kid];

  if (!publicKeyB64) return { ok: false, reason: 'unknown_key' };

  let signatureValid = false;

  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });

    signatureValid = verify(
      null,
      Buffer.from(SIGN_PREFIX + enc, 'utf-8'),
      key,
      unb64u(sig),
    );
  } catch {
    // A malformed key or signature is a rejection, not a crash.
    return { ok: false, reason: 'bad_signature' };
  }

  if (!signatureValid) return { ok: false, reason: 'bad_signature' };

  let payload: LicenseArtifactPayload;

  try {
    payload = JSON.parse(
      unb64u(enc).toString('utf-8'),
    ) as LicenseArtifactPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (
    payload?.v !== 1 ||
    typeof payload.installationId !== 'string' ||
    typeof payload.issuedAt !== 'string' ||
    typeof payload.expiresAt !== 'string'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const issued = Date.parse(payload.issuedAt);
  const expires = Date.parse(payload.expiresAt);

  if (Number.isNaN(issued) || Number.isNaN(expires)) {
    return { ok: false, reason: 'malformed' };
  }

  const nowMs = opts.now.getTime();

  // Checked in this order so a clock set far forward reports `expired` rather
  // than the more confusing `not_yet_valid`.
  if (nowMs > expires) return { ok: false, reason: 'expired' };
  if (nowMs < issued - CLOCK_SKEW_TOLERANCE_MS) {
    return { ok: false, reason: 'not_yet_valid' };
  }

  // Replay defence. Only meaningful on the poll path, where we generated the
  // nonce moments ago; a manual import legitimately has none.
  if (opts.expectedNonce != null && payload.nonce !== opts.expectedNonce) {
    return { ok: false, reason: 'nonce_mismatch' };
  }

  return { ok: true, payload };
}
