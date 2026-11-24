/**
 * @fileoverview Short-lived access tokens for Test Management API keys, issued by
 * POST /test-management/authenticate. A token is encrypted (AES-256-GCM), so it
 * shows nothing about its key; only its sha256 hash is stored, in
 * test_management_api_tokens, and every request checks it there.
 * @module src/auth/tm-access-token
 */

import { createHash, randomBytes } from 'crypto';

import {
  packSecretForStorage,
  unpackStoredSecret,
} from '../lib/crypto/encryption';

export const TM_ACCESS_TOKEN_PREFIX = 'xis_tm_at_';
export const TM_ACCESS_TOKEN_TTL_SECONDS = 3600;

// The encrypted part always starts like this; real API keys never contain a colon.
const ENCRYPTED_PREFIX = 'encv1:';

export interface TmAccessToken {
  keyId: string;
  // Unix seconds.
  expires: number;
}

/**
 * @param {string} keyId - Id of the API key
 * @param {number} expires - Expiry in Unix seconds
 * @returns {string} The encrypted token
 * @throws {Error} When AI_ENCRYPTION_SECRET is missing or invalid
 */
export function issueTmAccessToken(keyId: string, expires: number): string {
  const payload = JSON.stringify({
    k: keyId,
    e: expires,
    n: randomBytes(16).toString('hex'),
  });

  return `${TM_ACCESS_TOKEN_PREFIX}${packSecretForStorage(payload)}`;
}

/**
 * True for anything shaped like an access token, readable or not.
 * @param {string} token - The bearer token
 * @returns {boolean} Whether the token claims to be an access token
 */
export function isTmAccessToken(token: string): boolean {
  return token.startsWith(`${TM_ACCESS_TOKEN_PREFIX}${ENCRYPTED_PREFIX}`);
}

/**
 * @param {string} token - The bearer token
 * @returns {TmAccessToken | null} Its key and expiry, or null when it is not an access token or does not decrypt
 */
export function readTmAccessToken(token: string): TmAccessToken | null {
  if (!isTmAccessToken(token)) return null;

  const plain = unpackStoredSecret(token.slice(TM_ACCESS_TOKEN_PREFIX.length));

  if (!plain) return null;

  try {
    const payload = JSON.parse(plain) as { k?: unknown; e?: unknown };

    return typeof payload.k === 'string' &&
      typeof payload.e === 'number' &&
      Number.isInteger(payload.e)
      ? { keyId: payload.k, expires: payload.e }
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} token - The access token
 * @returns {string} The sha256 hash stored for it
 */
export function tmAccessTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
