/**
 * @fileoverview Seals and opens the encrypted credential bundles held by backup targets and schemes.
 * @module src/backup/services/backup-secrets.service
 *
 * Reuses lib/crypto/encryption verbatim (AES-256-GCM, AI_ENCRYPTION_SECRET as 64-hex). A second
 * crypto implementation would be a second thing to get wrong and a second key-rotation story.
 *
 * ⚠ ONE server-wide AI_ENCRYPTION_SECRET protects AI provider keys, automation OAuth tokens, webhook
 * secrets AND these credentials. If it is rotated, decryptApiKey throws on the GCM tag — but the
 * sibling helper unpackStoredSecret CATCHES that and returns null, so elsewhere in the codebase a
 * rotated key looks like "present but broken" hours later. key_fingerprint makes the failure loud at
 * read time instead: a mismatch is reported to the UI rather than surfacing as a null password
 * mid-upload.
 */

import { createHash } from 'crypto';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { decryptApiKey, encryptApiKey } from '../../lib/crypto/encryption';
import type { BackupTargetSecret } from '../types/backup-target-secret.type';

/** The encrypted trio plus the fingerprint of the key that produced it. */
export interface SealedSecret {
  secret_encrypted: string;
  secret_iv: string;
  secret_tag: string;
  key_fingerprint: string;
}

/** The same trio under the column names backup_schemes uses for its archive passphrase (the KEK). */
/** A sealed service-role key, in the column names `restore_destinations` uses. */
export interface SealedServiceKey {
  secret_encrypted: string;
  secret_iv: string;
  secret_tag: string;
  key_fingerprint: string;
}

/** The stored half of the above, as read back from a row. */
export interface StoredServiceKeyRow {
  secret_encrypted: string | null;
  secret_iv: string | null;
  secret_tag: string | null;
  key_fingerprint: string | null;
}

export interface SealedPassphrase {
  archive_passphrase_encrypted: string;
  archive_passphrase_iv: string;
  archive_passphrase_tag: string;
  key_fingerprint: string;
}

/** Shape of any row carrying a target-style trio. */
export interface StoredSecretRow {
  secret_encrypted: string | null;
  secret_iv: string | null;
  secret_tag: string | null;
  key_fingerprint: string | null;
}

/** Shape of a backup_schemes row carrying the archive passphrase trio. */
export interface StoredPassphraseRow {
  archive_passphrase_encrypted: string | null;
  archive_passphrase_iv: string | null;
  archive_passphrase_tag: string | null;
  key_fingerprint: string | null;
}

@Injectable()
export class BackupSecretsService {
  private readonly logger = new Logger(BackupSecretsService.name);

  /**
   * Encrypts one credential bundle into the target trio.
   *
   * @throws InternalServerErrorException when AI_ENCRYPTION_SECRET is missing or malformed —
   *   getEncryptionKey() throws a plain Error, which would otherwise surface as an opaque 500.
   */
  sealTargetSecret(secret: BackupTargetSecret): SealedSecret {
    const { encrypted, iv, tag } = this.encrypt(JSON.stringify(secret));

    return {
      secret_encrypted: encrypted,
      secret_iv: iv,
      secret_tag: tag,
      key_fingerprint: this.fingerprintKey(),
    };
  }

  /** Encrypts an archive passphrase (the scheme KEK) into the backup_schemes column names. */
  sealSchemePassphrase(passphrase: string): SealedPassphrase {
    const { encrypted, iv, tag } = this.encrypt(passphrase);

    return {
      archive_passphrase_encrypted: encrypted,
      archive_passphrase_iv: iv,
      archive_passphrase_tag: tag,
      key_fingerprint: this.fingerprintKey(),
    };
  }

  /**
   * Decrypts a stored target bundle. Never reachable from a controller — only an adapter that is
   * about to open a connection should call this.
   */
  openTargetSecret(row: StoredSecretRow): BackupTargetSecret {
    if (!row.secret_encrypted || !row.secret_iv || !row.secret_tag) {
      throw new InternalServerErrorException(
        'This target has no stored credentials — enter them before using it',
      );
    }

    if (row.key_fingerprint && row.key_fingerprint !== this.fingerprintKey()) {
      throw new InternalServerErrorException(
        'This target was encrypted with a different server key. Re-enter its credentials.',
      );
    }

    try {
      return JSON.parse(
        decryptApiKey(row.secret_encrypted, row.secret_iv, row.secret_tag),
      ) as BackupTargetSecret;
    } catch (err) {
      // Never log the ciphertext or any part of the plaintext — only why it failed.
      this.logger.error(
        `Target secret decryption failed: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException(
        'Failed to decrypt the target credentials — re-enter them',
      );
    }
  }

  /**
   * Decrypts a scheme's archive passphrase. Only the backup engine, immediately before sealing an
   * archive, has any business calling this — it must never reach a controller or a response.
   *
   * Failure is always fatal to the run: a scheme that asks for encryption and cannot produce its
   * passphrase must not quietly write the tenant's data out in the clear.
   */
  /**
   * Seals a destination's service-role key.
   *
   * Its own method rather than a reuse of `sealTargetSecret`, which seals an SFTP credential
   * OBJECT: a service-role key is a bare string, and round-tripping it through that shape would
   * store a JSON wrapper nothing reads. Same cipher, same fingerprint, different columns — the ones
   * `backup_targets` already uses.
   */
  sealServiceKey(serviceKey: string): SealedServiceKey {
    const { encrypted, iv, tag } = this.encrypt(serviceKey);

    return {
      secret_encrypted: encrypted,
      secret_iv: iv,
      secret_tag: tag,
      key_fingerprint: this.fingerprintKey(),
    };
  }

  /**
   * Opens a destination's service-role key.
   *
   * @throws InternalServerErrorException when the server key has rotated since it was sealed. Said
   *   plainly, because the fix is to re-enter the key rather than to retry.
   */
  openServiceKey(row: StoredServiceKeyRow): string {
    if (!row.secret_encrypted || !row.secret_iv || !row.secret_tag) {
      throw new InternalServerErrorException(
        'This destination has no stored service key. Enter it again before restoring to it.',
      );
    }

    if (row.key_fingerprint && row.key_fingerprint !== this.fingerprintKey()) {
      throw new InternalServerErrorException(
        'This destination was sealed with a different server key. Enter its service key again.',
      );
    }

    try {
      return decryptApiKey(row.secret_encrypted, row.secret_iv, row.secret_tag);
    } catch (err) {
      this.logger.error(
        `Destination service key decryption failed: ${(err as Error).message}`,
      );

      throw new InternalServerErrorException(
        "Failed to decrypt this destination's service key — enter it again.",
      );
    }
  }

  openSchemePassphrase(row: StoredPassphraseRow): string {
    if (
      !row.archive_passphrase_encrypted ||
      !row.archive_passphrase_iv ||
      !row.archive_passphrase_tag
    ) {
      throw new InternalServerErrorException(
        'This scheme is set to encrypt its archives but has no stored passphrase. Set one before running a backup.',
      );
    }

    if (row.key_fingerprint && row.key_fingerprint !== this.fingerprintKey()) {
      throw new InternalServerErrorException(
        'The archive passphrase was encrypted with a different server key. Set the passphrase again before running a backup.',
      );
    }

    try {
      return decryptApiKey(
        row.archive_passphrase_encrypted,
        row.archive_passphrase_iv,
        row.archive_passphrase_tag,
      );
    } catch (err) {
      this.logger.error(
        `Archive passphrase decryption failed: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException(
        'Failed to decrypt the archive passphrase — set it again on the scheme',
      );
    }
  }

  /**
   * sha256(AI_ENCRYPTION_SECRET) truncated to 16 hex chars. Same scheme the boot diagnostics use to
   * fingerprint the JWT secret, so the two are comparable by eye in logs.
   */
  fingerprintKey(): string {
    const secret = process.env.AI_ENCRYPTION_SECRET ?? '';

    return createHash('sha256').update(secret).digest('hex').slice(0, 16);
  }

  /** True when the row was encrypted by the key this process is currently holding. */
  fingerprintMatchesServer(storedFingerprint: string | null): boolean {
    if (!storedFingerprint) {
      return true;
    }

    return storedFingerprint === this.fingerprintKey();
  }

  /**
   * Display form of a stored secret: first 4 and last 2 characters of the CIPHERTEXT, never the
   * plaintext. Enough for a human to tell two credentials apart, useless to an attacker.
   */
  maskSecret(cipherText: string | null): string {
    if (!cipherText) {
      return '';
    }

    if (cipherText.length <= 6) {
      return '••••••••';
    }

    return `${cipherText.slice(0, 4)}••••••••${cipherText.slice(-2)}`;
  }

  private encrypt(plainText: string): {
    encrypted: string;
    iv: string;
    tag: string;
  } {
    try {
      return encryptApiKey(plainText);
    } catch (err) {
      // getEncryptionKey() throws a plain Error when AI_ENCRYPTION_SECRET is absent or not 64-hex.
      this.logger.error(`Encryption unavailable: ${(err as Error).message}`);
      throw new InternalServerErrorException(
        'Server encryption is not configured — credentials cannot be stored',
      );
    }
  }
}
