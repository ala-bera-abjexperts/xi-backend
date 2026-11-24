/**
 * @fileoverview On-prem box identity and the signed "licence request" file.
 * @module licensing/artifact/license-request
 *
 * Each on-prem box owns an Ed25519 keypair, generated on first start and kept
 * in its own database. Its fingerprint (sha256 of the public key) is bound into
 * every licence the cloud issues for it, so a licence file only works on the
 * box it was issued for.
 *
 * Air-gapped boxes cannot call the cloud. Instead they export a request file
 * (identity + usage + a fresh nonce), signed with the box key. An admin uploads
 * it to the cloud, gets a licence file back, and imports that on the box. The
 * nonce makes the answer usable only by the request that asked for it, and the
 * usage numbers reach billing even for offline customers.
 *
 * ponytail: the private key lives in the box's own database, so cloning that
 * database clones the identity. Fingerprinting stops a licence FILE being
 * reused on another box; it does not stop a full database copy. A hardware-
 * bound key (TPM) is the upgrade path if that ever matters.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';

/** Domain separation: a request signature can never pass as anything else. */
export const REQUEST_SIGN_PREFIX = 'license-request/';

/** A request file older than this is refused by the cloud. */
export const REQUEST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface OnpremUsage {
  /** Members whose user account is active. */
  activeUsers: number;
  /** All members, including deactivated accounts. */
  totalUsers: number;
  version: string | null;
}

export interface LicenseRequestBody {
  v: 1;
  kind: 'license-request';
  /** The cloud installation this box is bound to, once known. */
  installationId: string | null;
  fingerprint: string;
  /** base64 SPKI DER of the box key; the cloud checks it hashes to fingerprint. */
  publicKey: string;
  usage: OnpremUsage;
  nonce: string;
  createdAt: string;
  release: string | null;
}

export interface LicenseRequestEnvelope {
  kind: 'license-request';
  enc: string;
  sig: string;
  alg: 'base64+ed25519';
}

export type LicenseRequestRejection =
  | 'malformed'
  | 'bad_signature'
  | 'fingerprint_mismatch'
  | 'too_old'
  | 'from_future';

function b64u(input: Buffer): string {
  return input.toString('base64url');
}

/** sha256 (hex) of a base64 SPKI DER public key. */
export function fingerprintOf(publicKeySpkiB64: string): string {
  return createHash('sha256')
    .update(Buffer.from(publicKeySpkiB64, 'base64'))
    .digest('hex');
}

export function generateInstanceKeypair(): {
  privatePem: string;
  publicKey: string;
  fingerprint: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicB64 = Buffer.from(publicDer).toString('base64');

  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicB64,
    fingerprint: fingerprintOf(publicB64),
  };
}

export function signLicenseRequest(
  body: LicenseRequestBody,
  privatePem: string,
): LicenseRequestEnvelope {
  const enc = b64u(Buffer.from(JSON.stringify(body), 'utf8'));
  const sig = nodeSign(
    null,
    Buffer.from(REQUEST_SIGN_PREFIX + enc, 'utf8'),
    createPrivateKey(privatePem),
  );

  return {
    kind: 'license-request',
    enc,
    sig: b64u(sig),
    alg: 'base64+ed25519',
  };
}

/**
 * Verifies a request file against the public key it carries, checks that key
 * hashes to the claimed fingerprint, and bounds its age. Never throws.
 * Whether that fingerprint belongs to the installation is the caller's call.
 */
export function verifyLicenseRequest(
  envelope: unknown,
  now: Date,
):
  | { ok: true; body: LicenseRequestBody }
  | { ok: false; reason: LicenseRequestRejection } {
  try {
    const env = envelope as Partial<LicenseRequestEnvelope> | null;

    if (
      !env ||
      env.kind !== 'license-request' ||
      env.alg !== 'base64+ed25519' ||
      typeof env.enc !== 'string' ||
      typeof env.sig !== 'string'
    ) {
      return { ok: false, reason: 'malformed' };
    }

    const body = JSON.parse(
      Buffer.from(env.enc, 'base64url').toString('utf8'),
    ) as LicenseRequestBody;

    if (
      body?.v !== 1 ||
      body.kind !== 'license-request' ||
      typeof body.publicKey !== 'string' ||
      typeof body.fingerprint !== 'string' ||
      typeof body.nonce !== 'string' ||
      body.nonce.length < 16 ||
      typeof body.createdAt !== 'string'
    ) {
      return { ok: false, reason: 'malformed' };
    }

    const key = createPublicKey({
      key: Buffer.from(body.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const valid = nodeVerify(
      null,
      Buffer.from(REQUEST_SIGN_PREFIX + env.enc, 'utf8'),
      key,
      Buffer.from(env.sig, 'base64url'),
    );

    if (!valid) return { ok: false, reason: 'bad_signature' };

    if (fingerprintOf(body.publicKey) !== body.fingerprint) {
      return { ok: false, reason: 'fingerprint_mismatch' };
    }

    const created = Date.parse(body.createdAt);

    if (!Number.isFinite(created)) return { ok: false, reason: 'malformed' };
    if (created > now.getTime() + 60 * 60 * 1000) {
      return { ok: false, reason: 'from_future' };
    }
    if (now.getTime() - created > REQUEST_MAX_AGE_MS) {
      return { ok: false, reason: 'too_old' };
    }

    return { ok: true, body };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
