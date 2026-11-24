/**
 * @fileoverview Round-trip and tamper tests for the encrypted archive format.
 * @module src/backup/crypto/archive-cipher.spec
 *
 * The tamper cases are the point of this file. A cipher that only ever round-trips clean data would
 * pass a test suite and still hand back a silently modified database on restore.
 *
 * Most tests supply the data key directly rather than deriving one, because scrypt is deliberately
 * ~100 ms per call and this suite would otherwise spend a minute in the KDF. Derivation itself is
 * covered separately.
 */

import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ARCHIVE_MAGIC,
  ArchiveCipherError,
  ArchiveDecryptStream,
  ArchiveEncryptStream,
  buildArchiveHeader,
  deriveArchiveKek,
  newArchiveSalt,
  newDataKey,
  passphraseResolver,
  unwrapDek,
  wrapDek,
  type ArchiveHeader,
} from './archive-cipher';

/** Small frames keep the multi-frame tests fast while exercising the same code paths. */
const FRAME = 64;

function headerFor(dek: Buffer, frameSize = FRAME): ArchiveHeader {
  return buildArchiveHeader({
    dek,
    // The header only ever holds the WRAPPED key, so any 32-byte KEK works for a format test.
    kek: Buffer.alloc(32, 7),
    salt: Buffer.alloc(16, 1),
    frameSize,
    keyFingerprint: 'deadbeefdeadbeef',
    createdAt: new Date('2026-08-04T10:00:00.000Z'),
  });
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks);
}

async function encrypt(
  plain: Buffer,
  dek: Buffer,
  header: ArchiveHeader,
): Promise<Buffer> {
  const encryptor = new ArchiveEncryptStream({ dek, header });

  Readable.from([plain]).pipe(encryptor);

  return collect(encryptor);
}

function decrypt(cipherText: Buffer, dek: Buffer): Promise<Buffer> {
  const decryptor = new ArchiveDecryptStream(() => Promise.resolve(dek));

  Readable.from([cipherText]).pipe(decryptor);

  return collect(decryptor);
}

describe('archive round trip', () => {
  it('returns exactly what was encrypted', async () => {
    const dek = newDataKey();
    const plain = Buffer.from('the whole tenant lives in here');

    const sealed = await encrypt(plain, dek, headerFor(dek));

    expect(sealed.subarray(0, 6)).toEqual(ARCHIVE_MAGIC);
    expect(sealed).not.toContain(plain);
    await expect(decrypt(sealed, dek)).resolves.toEqual(plain);
  });

  it('survives many frames, including a partial last one', async () => {
    const dek = newDataKey();
    // 5 whole frames plus a remainder, so both the loop and the flush path are exercised.
    const plain = randomBytes(FRAME * 5 + 17);

    const sealed = await encrypt(plain, dek, headerFor(dek));

    await expect(decrypt(sealed, dek)).resolves.toEqual(plain);
  });

  it('survives a payload that is an exact multiple of the frame size', async () => {
    const dek = newDataKey();
    const plain = randomBytes(FRAME * 3);

    const sealed = await encrypt(plain, dek, headerFor(dek));

    await expect(decrypt(sealed, dek)).resolves.toEqual(plain);
  });

  it('produces a readable file for an empty archive rather than zero bytes', async () => {
    const dek = newDataKey();

    const sealed = await encrypt(Buffer.alloc(0), dek, headerFor(dek));

    expect(sealed.length).toBeGreaterThan(0);
    await expect(decrypt(sealed, dek)).resolves.toEqual(Buffer.alloc(0));
  });

  it('reassembles data that arrives split across arbitrary chunk boundaries', async () => {
    const dek = newDataKey();
    const plain = randomBytes(FRAME * 2 + 5);
    const sealed = await encrypt(plain, dek, headerFor(dek));

    // One byte at a time: the header, the frame headers and the tags all straddle chunks.
    const decryptor = new ArchiveDecryptStream(() => Promise.resolve(dek));
    const source = Readable.from(
      (function* () {
        for (const byte of sealed) {
          yield Buffer.from([byte]);
        }
      })(),
    );

    source.pipe(decryptor);

    await expect(collect(decryptor)).resolves.toEqual(plain);
  });
});

describe('archive tamper resistance', () => {
  const dek = newDataKey();
  let plain: Buffer;
  let sealed: Buffer;

  beforeEach(async () => {
    plain = randomBytes(FRAME * 2 + 9);
    sealed = await encrypt(plain, dek, headerFor(dek));
  });

  it('rejects a single flipped ciphertext byte', async () => {
    const tampered = Buffer.from(sealed);
    const target = tampered.length - 40;

    tampered[target] ^= 0x01;

    await expect(decrypt(tampered, dek)).rejects.toThrow(ArchiveCipherError);
  });

  it('rejects a truncated archive — the final frame is missing', async () => {
    // Exactly the final frame removed. Every remaining frame still authenticates perfectly and
    // decrypts to genuine plaintext; only the absent final flag reveals the loss. This is the case
    // a per-frame tag alone would happily accept.
    const truncated = sealed.subarray(0, sealed.length - tailLength());

    await expect(decrypt(truncated, dek)).rejects.toThrow(
      /truncated or incomplete/,
    );
  });

  it('rejects an archive cut off mid-frame', async () => {
    await expect(
      decrypt(sealed.subarray(0, sealed.length - 8), dek),
    ).rejects.toThrow(/truncated or incomplete/);
  });

  it('rejects a reordered frame', async () => {
    // Frames are fixed size here, so frame N can be lifted whole and put back in the wrong place.
    const headerLength = sealed.length - (frameStride() * 2 + tailLength());
    const first = sealed.subarray(headerLength, headerLength + frameStride());
    const second = sealed.subarray(
      headerLength + frameStride(),
      headerLength + frameStride() * 2,
    );

    const swapped = Buffer.concat([
      sealed.subarray(0, headerLength),
      second,
      first,
      sealed.subarray(headerLength + frameStride() * 2),
    ]);

    await expect(decrypt(swapped, dek)).rejects.toThrow(ArchiveCipherError);
  });

  it('rejects a duplicated final frame', async () => {
    const tail = sealed.subarray(sealed.length - tailLength());
    const extended = Buffer.concat([sealed, tail]);

    await expect(decrypt(extended, dek)).rejects.toThrow(
      /past its final frame/,
    );
  });

  it('rejects an edited header even when it is still valid JSON', async () => {
    // Repointing the header at a different key fingerprint changes nothing cryptographically on
    // its own — it is the AAD binding that has to catch this.
    const text = sealed.toString('latin1');
    const edited = text.replace('deadbeefdeadbeef', 'deadbeefdeadbeee');

    expect(edited).not.toEqual(text);
    await expect(decrypt(Buffer.from(edited, 'latin1'), dek)).rejects.toThrow(
      ArchiveCipherError,
    );
  });

  it('rejects a file that is not an archive at all', async () => {
    await expect(
      decrypt(Buffer.from('PK an ordinary zip'), dek),
    ).rejects.toThrow(/not an encrypted backup archive/);
  });

  it('rejects a format version this server does not know', async () => {
    const future = Buffer.from(sealed);

    future.writeUInt8(99, ARCHIVE_MAGIC.length);

    await expect(decrypt(future, dek)).rejects.toThrow(/format version 99/);
  });

  it('rejects the wrong data key', async () => {
    await expect(decrypt(sealed, newDataKey())).rejects.toThrow(
      ArchiveCipherError,
    );
  });

  /** header(5) + payload(FRAME) + tag(16) for a full frame. */
  function frameStride(): number {
    return 5 + FRAME + 16;
  }

  /** The final frame carries the 9-byte remainder. */
  function tailLength(): number {
    return 5 + 9 + 16;
  }
});

describe('key wrapping', () => {
  it('opens a data key sealed with the same passphrase', async () => {
    const salt = newArchiveSalt();
    const kek = await deriveArchiveKek('correct horse battery staple', salt);
    const dek = newDataKey();

    expect(unwrapDek(wrapDek(dek, kek), kek)).toEqual(dek);
  });

  it('refuses the wrong passphrase', async () => {
    const salt = newArchiveSalt();
    const dek = newDataKey();
    const sealedKey = wrapDek(dek, await deriveArchiveKek('right', salt));
    const wrong = await deriveArchiveKek('wrong', salt);

    expect(() => unwrapDek(sealedKey, wrong)).toThrow(
      /passphrase is wrong, or the archive has been altered/,
    );
  });

  it('derives a different key for the same passphrase under a different salt', async () => {
    const passphrase = 'same words either way';
    const a = await deriveArchiveKek(passphrase, newArchiveSalt());
    const b = await deriveArchiveKek(passphrase, newArchiveSalt());

    expect(a).not.toEqual(b);
  });

  it('normalises the passphrase so the same characters always derive the same key', async () => {
    const salt = newArchiveSalt();
    // "é" composed (U+00E9) vs decomposed (e + U+0301) — identical on screen, different bytes.
    const composed = await deriveArchiveKek('café', salt);
    const decomposed = await deriveArchiveKek('café', salt);

    expect(composed).toEqual(decomposed);
  });

  it('opens an archive end to end with only the passphrase', async () => {
    const passphrase = 'the operator knows this and nothing else';
    const salt = newArchiveSalt();
    const kek = await deriveArchiveKek(passphrase, salt);
    const dek = newDataKey();
    const header = buildArchiveHeader({ dek, kek, salt, frameSize: FRAME });
    const plain = randomBytes(FRAME * 2 + 3);

    const sealed = await encrypt(plain, dek, header);

    // No database, no server key — the archive header carries everything except the passphrase.
    const decryptor = new ArchiveDecryptStream(passphraseResolver(passphrase));

    Readable.from([sealed]).pipe(decryptor);

    await expect(collect(decryptor)).resolves.toEqual(plain);
  });

  it('fails an end-to-end open with the wrong passphrase', async () => {
    const salt = newArchiveSalt();
    const kek = await deriveArchiveKek('opens it', salt);
    const dek = newDataKey();
    const sealed = await encrypt(
      randomBytes(32),
      dek,
      buildArchiveHeader({ dek, kek, salt, frameSize: FRAME }),
    );

    const decryptor = new ArchiveDecryptStream(
      passphraseResolver('does not open it'),
    );

    Readable.from([sealed]).pipe(decryptor);

    await expect(collect(decryptor)).rejects.toThrow(ArchiveCipherError);
  });
});
