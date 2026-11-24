/**
 * @fileoverview Turns a scheme's encryption settings into a stream the engine can pipe through.
 * @module src/backup/services/backup-archive-cipher.service
 *
 * The format itself lives in crypto/archive-cipher.ts and knows nothing about schemes, runs or
 * Nest. This is the seam between the two: it opens the stored passphrase, mints a data key for
 * this run, and hands back both the cipher stream and the columns the run row has to record.
 *
 * It is deliberately fail-closed. Every path that cannot produce a working cipher throws, because
 * the alternative — falling back to a plaintext archive for a scheme that asked for encryption —
 * would ship the whole tenant to an external server in the clear and report success.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ArchiveEncryptStream,
  buildArchiveHeader,
  deriveArchiveKek,
  newArchiveSalt,
  newDataKey,
} from '../crypto/archive-cipher';
import {
  BackupSecretsService,
  type StoredPassphraseRow,
} from './backup-secrets.service';

/** The scheme columns this service needs. Nothing else on the row is read. */
export interface ArchiveEncryptionRow extends StoredPassphraseRow {
  encrypt_archive: boolean;
}

/** Exactly the columns `backup_runs` reserves for the per-run key. */
export interface RunKeyColumns {
  dek_wrapped: string;
  dek_iv: string;
  dek_tag: string;
  key_fingerprint: string | null;
}

export interface ArchiveEncryptor {
  /** Pipe the finished archive through this on its way to the target. */
  stream: ArchiveEncryptStream;

  runKey: RunKeyColumns;

  /** Base64 nonce prefix, recorded on the artifact row. Public, not a secret. */
  noncePrefix: string;
}

@Injectable()
export class BackupArchiveCipherService {
  private readonly logger = new Logger(BackupArchiveCipherService.name);

  constructor(private readonly secrets: BackupSecretsService) {}

  /**
   * Builds the cipher for one run, or returns null when the scheme has encryption switched off.
   *
   * Returning null is the ONLY way this produces an unencrypted archive — every failure throws — so
   * there is exactly one place that decides an archive may be written in the clear.
   *
   * @throws InternalServerErrorException when the passphrase is missing or cannot be decrypted.
   */
  async createEncryptor(
    scheme: ArchiveEncryptionRow,
  ): Promise<ArchiveEncryptor | null> {
    if (!scheme.encrypt_archive) {
      return null;
    }

    const passphrase = this.secrets.openSchemePassphrase(scheme);

    // A fresh salt and a fresh data key per run. Reusing either across runs would mean one
    // compromised archive exposes every other archive made from the same passphrase.
    const salt = newArchiveSalt();
    const dek = newDataKey();
    const kek = await deriveArchiveKek(passphrase, salt);

    const header = buildArchiveHeader({
      dek,
      kek,
      salt,
      keyFingerprint: scheme.key_fingerprint,
    });

    this.logger.log('Archive encryption enabled for this run (aes-256-gcm)');

    return {
      stream: new ArchiveEncryptStream({ dek, header }),
      runKey: {
        dek_wrapped: header.dek.wrapped,
        dek_iv: header.dek.iv,
        dek_tag: header.dek.tag,
        key_fingerprint: header.key_fingerprint,
      },
      noncePrefix: header.nonce_prefix,
    };
  }
}
