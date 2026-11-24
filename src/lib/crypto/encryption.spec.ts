describe('packSecretForStorage / unpackStoredSecret (H7)', () => {
  beforeAll(() => {
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
  });

  // Imported lazily so the env var above is set before getEncryptionKey runs.
  const load = () => require('./encryption') as typeof import('./encryption');

  it('encrypts then round-trips back to the original', () => {
    const { packSecretForStorage, unpackStoredSecret } = load();
    const token = 'refresh_token_ABC-123.xyz/==';
    const packed = packSecretForStorage(token);

    expect(packed.startsWith('encv1:')).toBe(true);
    expect(packed).not.toContain(token); // not plaintext at rest
    expect(unpackStoredSecret(packed)).toBe(token);
  });

  it('passes LEGACY plaintext through unchanged (no data migration needed)', () => {
    const { unpackStoredSecret } = load();

    expect(unpackStoredSecret('legacy_plain_token')).toBe('legacy_plain_token');
  });

  it('returns null for null/empty', () => {
    const { unpackStoredSecret } = load();

    expect(unpackStoredSecret(null)).toBeNull();
    expect(unpackStoredSecret(undefined)).toBeNull();
    expect(unpackStoredSecret('')).toBeNull();
  });

  it('returns null on tampered ciphertext (GCM auth tag)', () => {
    const { packSecretForStorage, unpackStoredSecret } = load();
    const packed = packSecretForStorage('x');

    expect(unpackStoredSecret(packed.slice(0, -2) + 'ff')).toBeNull();
  });
});
