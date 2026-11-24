import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const secret = process.env.AI_ENCRYPTION_SECRET;
  if (!secret)
    throw new Error('AI_ENCRYPTION_SECRET environment variable is not set');
  if (secret.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(secret))
    throw new Error(
      'AI_ENCRYPTION_SECRET must be a 64-character hex string (32 bytes)',
    );
  return Buffer.from(secret, 'hex');
}

export function encryptApiKey(plainText: string): {
  encrypted: string;
  iv: string;
  tag: string;
} {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return { encrypted, iv: iv.toString('hex'), tag: tag.toString('hex') };
}

export function decryptApiKey(
  encrypted: string,
  iv: string,
  tag: string,
): string {
  const key = getEncryptionKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// SECURITY (H7): OAuth refresh tokens live inside a connection's `metadata` jsonb.
// Pack them as a single authenticated-encrypted, self-describing string so they
// are never plaintext at rest. iv/tag/encrypted are all hex (no ':'), so a
// colon-delimited layout is unambiguous.
const ENC_PREFIX = 'encv1:';

/** Encrypt a secret for embedding in a JSON/text field. */
// Masked preview of a stored secret ("sk_****9a") so the UI can show WHICH key is saved
// without ever returning the secret itself.
export function hintForSecret(plainText: string): string {
  const len = plainText.length;

  if (len <= 6) return '*'.repeat(len);

  return `${plainText.slice(0, 3)}${'*'.repeat(Math.min(4, len - 5))}${plainText.slice(-2)}`;
}

export function packSecretForStorage(plainText: string): string {
  const { encrypted, iv, tag } = encryptApiKey(plainText);

  return `${ENC_PREFIX}${iv}:${tag}:${encrypted}`;
}

/**
 * Decrypt a value produced by {@link packSecretForStorage}. Transparently
 * returns LEGACY plaintext values (no `encv1:` prefix) unchanged, so connections
 * saved before encryption-at-rest keep refreshing without a data migration.
 */
export function unpackStoredSecret(
  stored: string | null | undefined,
): string | null {
  if (stored == null || stored === '') return null;
  if (!stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext

  const [iv, tag, encrypted] = stored.slice(ENC_PREFIX.length).split(':');

  if (!iv || !tag || !encrypted) return null;

  try {
    return decryptApiKey(encrypted, iv, tag);
  } catch {
    return null;
  }
}
