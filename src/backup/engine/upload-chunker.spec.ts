/**
 * @fileoverview The chunker may move chunk boundaries and nothing else.
 * @module src/backup/engine/upload-chunker.spec
 *
 * This sits in the middle of the archive stream, downstream of encryption. If it ever altered,
 * dropped or reordered a byte, every backup taken afterwards would be unrestorable and nothing
 * would say so until someone tried to restore one. So the tests are mostly about identity: same
 * bytes, same order, same digest — only the boundaries differ.
 */

import { createHash, randomBytes } from 'crypto';
import { PassThrough, Readable } from 'stream';

import {
  ArchiveDecryptStream,
  ArchiveEncryptStream,
  buildArchiveHeader,
  newDataKey,
} from '../crypto/archive-cipher';
import { UPLOAD_CHUNK_BYTES, UploadChunker } from './upload-chunker';

/** Feeds the given buffers through a chunker and collects what comes out the other side. */
async function through(inputs: Buffer[]): Promise<Buffer[]> {
  const chunker = new UploadChunker();
  const source = new PassThrough();
  const out: Buffer[] = [];

  chunker.on('data', (chunk: Buffer) => out.push(chunk));

  const done = new Promise<void>((resolve, reject) => {
    chunker.on('end', resolve);
    chunker.on('error', reject);
  });

  source.pipe(chunker);

  for (const input of inputs) {
    source.write(input);
  }

  source.end();

  await done;

  return out;
}

/** Deterministic bytes, so a reordering shows up as a digest mismatch rather than by luck. */
function pattern(size: number, seed: number): Buffer {
  const buf = Buffer.allocUnsafe(size);

  for (let i = 0; i < size; i += 1) {
    buf[i] = (i * 31 + seed * 17) % 251;
  }

  return buf;
}

const sha = (chunks: Buffer[]): string =>
  createHash('sha256').update(Buffer.concat(chunks)).digest('hex');

describe('UploadChunker', () => {
  it('splits chunks that are too large for one SFTP write', async () => {
    // The real case: an encrypted archive arrives as ~1 MiB cipher frames, and anything over
    // _maxWriteLen is split by ssh2 one serial round trip at a time.
    const input = [pattern(1024 * 1024, 1)];
    const out = await through(input);

    expect(out.length).toBeGreaterThan(1);
    expect(Math.max(...out.map((c) => c.length))).toBeLessThanOrEqual(
      UPLOAD_CHUNK_BYTES,
    );
  });

  it('coalesces chunks that are too small to be worth a request', async () => {
    // The `compression: 'none'` case: archiver stores rather than deflates, so per-row writes reach
    // the socket unchanged. Without coalescing a 2 MB buffer would mean thousands of tiny requests.
    const input = Array.from({ length: 500 }, (_, i) => pattern(200, i));
    const out = await through(input);

    expect(out.length).toBeLessThan(input.length);
    expect(out[0].length).toBe(UPLOAD_CHUNK_BYTES);
  });

  it('emits exactly the bytes it was given, in order', async () => {
    // The one that matters. Boundaries move; content does not.
    const input = [
      pattern(1024 * 1024, 2),
      pattern(17, 3),
      pattern(64 * 1024, 4),
      pattern(1, 5),
    ];

    const out = await through(input);

    expect(Buffer.concat(out).equals(Buffer.concat(input))).toBe(true);
    expect(sha(out)).toBe(sha(input));
  });

  it('flushes the remainder rather than dropping it', async () => {
    // Without _flush the archive is short by up to UPLOAD_CHUNK_BYTES - 1. The worker's byte-count
    // check would fail the run, so this would not corrupt anything — it would break every backup.
    const size = UPLOAD_CHUNK_BYTES + 7;
    const out = await through([pattern(size, 6)]);

    expect(Buffer.concat(out).length).toBe(size);
    expect(out[out.length - 1].length).toBe(7);
  });

  it('passes through a stream smaller than one chunk', async () => {
    const out = await through([pattern(10, 7)]);

    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(10);
  });

  it('emits nothing for an empty stream', async () => {
    // `_flush` must not push a zero-length buffer: an empty push ends a readable stream early.
    expect(await through([])).toHaveLength(0);
  });

  it('never emits a chunk larger than one SFTP write, whatever the input shape', async () => {
    // Ragged sizes on purpose — the boundary arithmetic is where an off-by-one would hide.
    const sizes = [
      1,
      UPLOAD_CHUNK_BYTES - 1,
      UPLOAD_CHUNK_BYTES,
      UPLOAD_CHUNK_BYTES + 1,
      3,
      999_999,
    ];
    const input = sizes.map((size, i) => pattern(size, i));

    const out = await through(input);

    for (const chunk of out) {
      expect(chunk.length).toBeLessThanOrEqual(UPLOAD_CHUNK_BYTES);
      expect(chunk.length).toBeGreaterThan(0);
    }

    expect(Buffer.concat(out).equals(Buffer.concat(input))).toBe(true);
  });

  it('stays at or below ssh2 non-OpenSSH _maxWriteLen', () => {
    // 34_000 - 2_048. Exceeding it would put us back to serial splitting on a non-OpenSSH server,
    // which is the failure this whole file exists to remove.
    expect(UPLOAD_CHUNK_BYTES).toBeLessThanOrEqual(34_000 - 2_048);
  });
});

/**
 * The claim this whole change rests on.
 *
 * The chunker sits downstream of encryption, so it re-cuts CIPHERTEXT. Reasoning said that is safe —
 * the reader reassembles frames by parsing a length header out of an accumulating buffer, so chunk
 * boundaries were never load-bearing. Reasoning is not evidence, and the failure mode is every
 * backup taken after this change being unrestorable, discovered only when someone needs one.
 *
 * So this is the real topology: the production encryptor, the production chunker, the production
 * decryptor. The frame size is the real 1 MiB, which is exactly the case that matters — one frame
 * leaves the cipher as a single ~1 MiB chunk and reaches the wire as 33 pieces of 31,952 bytes.
 */
describe('re-chunking an encrypted archive', () => {
  const headerFor = (dek: Buffer, frameSize: number) =>
    buildArchiveHeader({
      dek,
      kek: Buffer.alloc(32, 7),
      salt: Buffer.alloc(16, 1),
      frameSize,
      keyFingerprint: 'deadbeefdeadbeef',
      createdAt: new Date('2026-08-10T10:00:00.000Z'),
    });

  async function collect(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks);
  }

  it('decrypts to exactly the original bytes after the chunker has re-cut it', async () => {
    const dek = newDataKey();
    const frameSize = 1024 * 1024;

    // Several whole frames plus a partial one, so both the frame loop and the flush path are
    // crossed by chunk boundaries that fall in the middle of frames, headers and auth tags.
    const plain = randomBytes(frameSize * 3 + 12_345);

    const encryptor = new ArchiveEncryptStream({
      dek,
      header: headerFor(dek, frameSize),
    });
    const chunker = new UploadChunker();
    const decryptor = new ArchiveDecryptStream(() => Promise.resolve(dek));

    Readable.from([plain]).pipe(encryptor).pipe(chunker).pipe(decryptor);

    const restored = await collect(decryptor);

    expect(restored.equals(plain)).toBe(true);
  });

  it('changes the boundaries and nothing else', async () => {
    // Proves the previous test is not passing by accident of the chunker being a no-op: the
    // ciphertext really is arriving in different pieces than the cipher emitted.
    const dek = newDataKey();
    const frameSize = 1024 * 1024;
    const plain = randomBytes(frameSize * 2);

    const sealed = await collect(
      Readable.from([plain]).pipe(
        new ArchiveEncryptStream({ dek, header: headerFor(dek, frameSize) }),
      ),
    );

    const rechunked: Buffer[] = [];
    const chunker = new UploadChunker();

    chunker.on('data', (chunk: Buffer) => rechunked.push(chunk));
    Readable.from([sealed]).pipe(chunker);

    await new Promise((resolve) => chunker.on('end', resolve));

    expect(rechunked.length).toBeGreaterThan(2);
    expect(Math.max(...rechunked.map((c) => c.length))).toBeLessThanOrEqual(
      UPLOAD_CHUNK_BYTES,
    );
    expect(Buffer.concat(rechunked).equals(sealed)).toBe(true);
  });
});
