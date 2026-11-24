import { createDecipheriv, createHmac, timingSafeEqual } from 'crypto';

/**
 * Decrypts a webhook secret stored as AES-256-GCM ciphertext.
 * Uses the same AI_ENCRYPTION_SECRET env var as ai-config encryption.
 */
export function decryptWebhookSecret(
  encrypted: string,
  iv: string,
  tag: string,
): string {
  const secret = process.env.AI_ENCRYPTION_SECRET ?? '';
  const key = Buffer.from(secret, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
}

type SignatureAlgorithm =
  | 'bearer'
  | 'hmac-sha256'
  | 'hmac-sha1'
  | 'hmac-sha512';

/**
 * Verifies the incoming webhook request signature against the decrypted secret.
 * Returns true if valid, false if invalid or if verification throws.
 * Never throws — invalid signatures are logged but the webhook is still accepted.
 */
export function verifyWebhookSignature(
  algorithm: SignatureAlgorithm,
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
): boolean {
  try {
    if (algorithm === 'bearer') {
      const authHeader = headers['authorization'] ?? '';
      const provided = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;
      const a = Buffer.from(provided);
      const b = Buffer.from(secret);
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    }

    const hashAlgo =
      algorithm === 'hmac-sha1'
        ? 'sha1'
        : algorithm === 'hmac-sha512'
          ? 'sha512'
          : 'sha256';

    const headerName =
      algorithm === 'hmac-sha1'
        ? 'x-hub-signature'
        : algorithm === 'hmac-sha512'
          ? 'x-hub-signature-512'
          : 'x-hub-signature-256';

    const prefix =
      algorithm === 'hmac-sha1'
        ? 'sha1='
        : algorithm === 'hmac-sha512'
          ? 'sha512='
          : 'sha256=';

    const provided = headers[headerName] ?? '';
    const computed =
      prefix +
      createHmac(hashAlgo, secret).update(rawBody, 'utf8').digest('hex');

    const a = Buffer.from(provided);
    const b = Buffer.from(computed);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
