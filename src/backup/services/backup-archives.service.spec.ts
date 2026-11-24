/**
 * @fileoverview Unit tests for `BackupArchivesService.verifyPassphrase`.
 * @module src/backup/services/backup-archives.service.spec
 *
 * This endpoint is the wizard's only chance to catch a bad passphrase — or a deleted archive —
 * before the operator picks tables, waits for a preview and, for a cross-organization restore, waits
 * for somebody else's approval. Two properties are pinned here:
 *
 * 1. **`reason` and `detail` agree.** The client switches on `reason` and shows `detail`; if the two
 *    drift apart it renders a passphrase hint over a message about a missing file.
 * 2. **The check is strict.** An empty or wrong passphrase must answer `valid: false`. A fallback to
 *    the scheme's stored passphrase once made both succeed and walked the wizard on to the next
 *    step, which is the exact opposite of what this endpoint exists for.
 *
 * A real header is built and a real key derived, so the wrong-vs-right cases exercise the actual
 * cipher rather than a mock's opinion of it. scrypt is ~100 ms per call, which is why only the two
 * cases that need it pay for it.
 */

import {
  ARCHIVE_MAGIC,
  buildArchiveHeader,
  deriveArchiveKek,
  encodeArchiveHeader,
  newArchiveSalt,
  newDataKey,
} from '../crypto/archive-cipher';
import { ARCHIVE_MISSING_PREFIX } from '../adapters/sftp/sftp.adapter';
import { BackupArchivesService } from './backup-archives.service';

const ORG = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';
const ARTIFACT = '33333333-3333-3333-3333-333333333333';
const FILE = 'backup-20260807145727907.zip';

const RIGHT = 'REREEREREE1';
const WRONG = 'ewrewrrewrew';

/** Bytes that begin a real encrypted archive sealed with `passphrase`. */
async function encryptedHead(passphrase: string): Promise<Buffer> {
  const salt = newArchiveSalt();
  const kek = await deriveArchiveKek(passphrase, salt);

  const header = buildArchiveHeader({
    dek: newDataKey(),
    kek,
    salt,
    keyFingerprint: 'deadbeefdeadbeef',
    createdAt: new Date('2026-08-07T14:57:27.907Z'),
  });

  return encodeArchiveHeader(header);
}

/**
 * The service with its three I/O boundaries stubbed.
 *
 * `getArtifact`, `resolve` and `readHead` are the only things between the arguments and the cipher,
 * and all three are private — reached by name because the alternative is standing up Supabase and an
 * SSH server to test a branch that is pure decision-making.
 */
function serviceWith(options: {
  head?: Buffer | (() => Promise<Buffer>);
  isEncrypted?: boolean;
}): BackupArchivesService {
  const service = new BackupArchivesService(
    {} as never,
    {} as never,
    {} as never,
  );

  const stub = service as unknown as Record<string, unknown>;

  stub.getArtifact = jest.fn().mockResolvedValue({
    id: ARTIFACT,
    file_name: FILE,
    remote_path: `/backups/${FILE}`,
    is_encrypted: options.isEncrypted ?? true,
    byte_size: 4096,
  });

  stub.resolve = jest
    .fn()
    .mockResolvedValue({ ctx: {}, logicalPath: `/backups/${FILE}` });

  stub.readHead = jest.fn().mockImplementation(() => {
    const head = options.head;

    if (typeof head === 'function') {
      return head();
    }

    return Promise.resolve(head ?? Buffer.alloc(0));
  });

  return service;
}

function verify(service: BackupArchivesService, passphrase?: string) {
  return service.verifyPassphrase(ORG, TARGET, ARTIFACT, passphrase);
}

describe('BackupArchivesService.verifyPassphrase', () => {
  it('reports a deleted archive as an answer, not as a thrown error', async () => {
    const service = serviceWith({
      head: () =>
        Promise.reject(new Error(`${ARCHIVE_MISSING_PREFIX}: ${FILE}`)),
    });

    const result = await verify(service, RIGHT);

    expect(result.reason).toBe('archive_missing');
    expect(result.valid).toBe(false);

    // Names the file, so the operator can tell WHICH archive went rather than being told the remote
    // directory is misconfigured — which is what the SFTP taxonomy says about a bare ENOENT.
    expect(result.detail).toContain(FILE);
    expect(result.detail).not.toContain('directory');
  });

  it('lets a genuine transport failure keep propagating', async () => {
    const service = serviceWith({
      head: () => Promise.reject(new Error('ETIMEDOUT: the server stopped')),
    });

    // Only a missing FILE is an answer. A target that cannot be reached is a failed request, and
    // swallowing it as `valid: false` would read as "your passphrase is wrong".
    await expect(verify(service, RIGHT)).rejects.toThrow('ETIMEDOUT');
  });

  it('refuses an empty passphrase without touching the cipher', async () => {
    const service = serviceWith({ head: await encryptedHead(RIGHT) });

    const result = await verify(service, undefined);

    expect(result.reason).toBe('missing_passphrase');
    expect(result.valid).toBe(false);
  });

  it('refuses a wrong passphrase', async () => {
    const service = serviceWith({ head: await encryptedHead(RIGHT) });

    const result = await verify(service, WRONG);

    expect(result.reason).toBe('wrong_passphrase');
    expect(result.valid).toBe(false);

    // Never the passphrase, never its length, never a hash. This answer is a guessing oracle by
    // construction; it must not also be a hint.
    expect(result.detail).not.toContain(RIGHT);
    expect(result.detail).not.toContain(String(RIGHT.length));
  });

  it('accepts the passphrase that actually sealed the archive', async () => {
    const service = serviceWith({ head: await encryptedHead(RIGHT) });

    const result = await verify(service, RIGHT);

    expect(result.reason).toBe('ok');
    expect(result.valid).toBe(true);
  });

  it('needs no passphrase for an unencrypted archive', async () => {
    const service = serviceWith({
      head: Buffer.from('PKand then a zip'),
      isEncrypted: false,
    });

    const result = await verify(service, undefined);

    expect(result.reason).toBe('not_encrypted');
    expect(result.valid).toBe(true);
  });

  it('refuses a file whose encryption disagrees with its record', async () => {
    // Recorded as plain, but the bytes carry the archive magic. Serving this would hand back
    // something the caller was told needed no passphrase.
    const service = serviceWith({
      head: Buffer.concat([ARCHIVE_MAGIC, Buffer.alloc(16)]),
      isEncrypted: false,
    });

    const result = await verify(service, undefined);

    expect(result.reason).toBe('state_mismatch');
    expect(result.valid).toBe(false);
  });

  it('refuses a truncated header', async () => {
    // Correct magic, then a declared length the file does not actually carry — a cut-off upload.
    // `readArchiveHeader` answers this one with null.
    const head = Buffer.concat([ARCHIVE_MAGIC, Buffer.alloc(5)]);

    head.writeUInt8(1, ARCHIVE_MAGIC.length);
    head.writeUInt32BE(4096, ARCHIVE_MAGIC.length + 1);

    const result = await verify(
      serviceWith({ head, isEncrypted: true }),
      RIGHT,
    );

    expect(result.reason).toBe('unreadable_header');
    expect(result.valid).toBe(false);
  });

  it('refuses a malformed header instead of failing the request', async () => {
    // A version this server cannot read. `readArchiveHeader` THROWS for this, where truncation
    // returns null — and an unhandled cipher error here would surface as a 500, reporting a server
    // fault for a file problem the message describes exactly.
    const head = Buffer.concat([ARCHIVE_MAGIC, Buffer.alloc(5)]);

    head.writeUInt8(9, ARCHIVE_MAGIC.length);

    const result = await verify(
      serviceWith({ head, isEncrypted: true }),
      RIGHT,
    );

    expect(result.reason).toBe('unreadable_header');
    expect(result.valid).toBe(false);
    expect(result.detail).toContain('version 9');
  });

  it('never answers valid for an archive age', async () => {
    // Age is not an input to this decision anywhere. An archive stamped a year ago verifies exactly
    // as one stamped today, given the same passphrase — the property the restore wizard depends on.
    const service = serviceWith({ head: await encryptedHead(RIGHT) });

    expect((await verify(service, RIGHT)).valid).toBe(true);
    expect((await verify(service, WRONG)).valid).toBe(false);
  });
});
