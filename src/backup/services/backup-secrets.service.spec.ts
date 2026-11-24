/**
 * @fileoverview Unit tests for BackupSecretsService — seal/open round-trip, the key-fingerprint
 * guard that makes a rotated server key loud instead of silent, and secret masking.
 * @module src/backup/services/backup-secrets.service.spec
 */

import { InternalServerErrorException } from '@nestjs/common';
import { BackupSecretsService } from './backup-secrets.service';
import type { BackupTargetSecret } from '../types/backup-target-secret.type';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

describe('BackupSecretsService', () => {
  let service: BackupSecretsService;
  const originalKey = process.env.AI_ENCRYPTION_SECRET;

  beforeEach(() => {
    process.env.AI_ENCRYPTION_SECRET = KEY_A;
    service = new BackupSecretsService();
  });

  afterAll(() => {
    process.env.AI_ENCRYPTION_SECRET = originalKey;
  });

  it('round-trips a credential bundle', () => {
    const secret: BackupTargetSecret = {
      auth_method: 'sftp_password',
      password: 'hunter2',
    };

    const sealed = service.sealTargetSecret(secret);

    expect(sealed.secret_encrypted).toBeTruthy();
    expect(sealed.secret_iv).toBeTruthy();
    expect(sealed.secret_tag).toBeTruthy();
    expect(sealed.key_fingerprint).toHaveLength(16);

    expect(service.openTargetSecret(sealed)).toEqual(secret);
  });

  it('never stores the plaintext in the ciphertext', () => {
    const sealed = service.sealTargetSecret({
      auth_method: 'sftp_password',
      password: 'super-secret-value',
    });

    expect(sealed.secret_encrypted).not.toContain('super-secret-value');
  });

  it('refuses to open a bundle sealed with a different server key', () => {
    const sealed = service.sealTargetSecret({
      auth_method: 'sftp_password',
      password: 'hunter2',
    });

    // Simulate an AI_ENCRYPTION_SECRET rotation between write and read.
    process.env.AI_ENCRYPTION_SECRET = KEY_B;

    expect(() => service.openTargetSecret(sealed)).toThrow(
      InternalServerErrorException,
    );
  });

  it('reports a fingerprint mismatch without throwing, for the list projection', () => {
    const stored = service.fingerprintKey();

    process.env.AI_ENCRYPTION_SECRET = KEY_B;

    expect(service.fingerprintMatchesServer(stored)).toBe(false);
    expect(service.fingerprintMatchesServer(null)).toBe(true);
  });

  it('refuses to open a target with no stored credentials', () => {
    expect(() =>
      service.openTargetSecret({
        secret_encrypted: null,
        secret_iv: null,
        secret_tag: null,
        key_fingerprint: null,
      }),
    ).toThrow(InternalServerErrorException);
  });

  it('masks the ciphertext rather than revealing it', () => {
    expect(service.maskSecret(null)).toBe('');
    expect(service.maskSecret('abc')).toBe('••••••••');
    expect(service.maskSecret('abcdef1234567890')).toBe('abcd••••••••90');
  });

  it('seals a scheme passphrase into the scheme column names', () => {
    const sealed = service.sealSchemePassphrase('correct horse battery');

    expect(Object.keys(sealed).sort()).toEqual([
      'archive_passphrase_encrypted',
      'archive_passphrase_iv',
      'archive_passphrase_tag',
      'key_fingerprint',
    ]);
  });
});
