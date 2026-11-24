/**
 * @fileoverview Tests the one property that matters here: this service never quietly declines to
 * encrypt.
 * @module src/backup/services/backup-archive-cipher.service.spec
 *
 * The format is covered by crypto/archive-cipher.spec.ts. What is checked here is the decision:
 * given a scheme row, does an archive get sealed, refused, or written in the clear — and is the
 * clear case reachable ONLY by an explicit `encrypt_archive: false`.
 */

import { InternalServerErrorException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ArchiveDecryptStream,
  ArchiveEncryptStream,
  deriveArchiveKek,
  unwrapDek,
} from '../crypto/archive-cipher';
import {
  BackupArchiveCipherService,
  type ArchiveEncryptionRow,
} from './backup-archive-cipher.service';
import { BackupSecretsService } from './backup-secrets.service';

const PASSPHRASE = 'the operator wrote this down somewhere safe';

const ENCRYPTING_SCHEME: ArchiveEncryptionRow = {
  encrypt_archive: true,
  archive_passphrase_encrypted: 'ciphertext',
  archive_passphrase_iv: 'iv',
  archive_passphrase_tag: 'tag',
  key_fingerprint: '0ca8aedaf7be6ceb',
};

describe('BackupArchiveCipherService', () => {
  let service: BackupArchiveCipherService;
  let openSchemePassphrase: jest.Mock;

  beforeEach(async () => {
    openSchemePassphrase = jest.fn().mockReturnValue(PASSPHRASE);

    const moduleRef = await Test.createTestingModule({
      providers: [
        BackupArchiveCipherService,
        { provide: BackupSecretsService, useValue: { openSchemePassphrase } },
      ],
    }).compile();

    service = moduleRef.get(BackupArchiveCipherService);
  });

  it('builds a cipher when the scheme asks for encryption', async () => {
    const encryptor = await service.createEncryptor(ENCRYPTING_SCHEME);

    expect(encryptor).not.toBeNull();
    expect(encryptor?.stream).toBeInstanceOf(ArchiveEncryptStream);
  });

  it('returns null only for an explicit encrypt_archive: false', async () => {
    const encryptor = await service.createEncryptor({
      ...ENCRYPTING_SCHEME,
      encrypt_archive: false,
    });

    expect(encryptor).toBeNull();
    // The passphrase is not even opened — an unencrypted scheme need not have one.
    expect(openSchemePassphrase).not.toHaveBeenCalled();
  });

  it('fails the run rather than falling back to plaintext when the passphrase cannot be read', async () => {
    // This is the case that matters. A server-key rotation makes the passphrase unreadable; if
    // that degraded to "write it unencrypted", the whole tenant would land on an external server
    // in the clear and the run would report success.
    openSchemePassphrase.mockImplementation(() => {
      throw new InternalServerErrorException('key rotated');
    });

    await expect(service.createEncryptor(ENCRYPTING_SCHEME)).rejects.toThrow(
      InternalServerErrorException,
    );
  });

  it('produces the exact columns backup_runs reserves for the key', async () => {
    const encryptor = await service.createEncryptor(ENCRYPTING_SCHEME);

    expect(Object.keys(encryptor?.runKey ?? {}).sort()).toEqual([
      'dek_iv',
      'dek_tag',
      'dek_wrapped',
      'key_fingerprint',
    ]);
    expect(encryptor?.runKey.key_fingerprint).toBe('0ca8aedaf7be6ceb');
    // Satisfies backup_artifacts_encryption_check, which requires a non-null nonce.
    expect(Buffer.from(encryptor?.noncePrefix ?? '', 'base64')).toHaveLength(4);
  });

  it('mints a different key and salt for every run', async () => {
    const first = await service.createEncryptor(ENCRYPTING_SCHEME);
    const second = await service.createEncryptor(ENCRYPTING_SCHEME);

    // Same passphrase, different wrapped key: one leaked archive cannot open the next one.
    expect(first?.runKey.dek_wrapped).not.toEqual(second?.runKey.dek_wrapped);
    expect(first?.noncePrefix).not.toEqual(second?.noncePrefix);
  });

  it('seals an archive the stored passphrase can reopen', async () => {
    const encryptor = await service.createEncryptor(ENCRYPTING_SCHEME);
    const plain = Buffer.from('rows that must not be readable on the server');
    const out: Buffer[] = [];

    encryptor!.stream.on('data', (chunk: Buffer) => out.push(chunk));
    encryptor!.stream.end(plain);
    await new Promise((resolve) => encryptor!.stream.on('end', resolve));

    const sealed = Buffer.concat(out);

    expect(sealed).not.toContain(plain);

    // The run row's wrapped key opens with the same passphrase the scheme stores — proving the
    // recorded columns and the archive agree.
    const decryptor = new ArchiveDecryptStream(async (header) =>
      unwrapDek(
        {
          wrapped: encryptor!.runKey.dek_wrapped,
          iv: encryptor!.runKey.dek_iv,
          tag: encryptor!.runKey.dek_tag,
        },
        await deriveArchiveKek(
          PASSPHRASE,
          Buffer.from(header.kdf_params.salt, 'base64'),
        ),
      ),
    );

    const opened: Buffer[] = [];

    decryptor.on('data', (chunk: Buffer) => opened.push(chunk));
    decryptor.end(sealed);
    await new Promise((resolve) => decryptor.on('end', resolve));

    expect(Buffer.concat(opened)).toEqual(plain);
  });
});
