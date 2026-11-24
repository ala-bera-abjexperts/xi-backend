/**
 * @fileoverview The on-disk format for an encrypted backup archive, and the streams that write and
 * read it.
 * @module src/backup/crypto/archive-cipher
 *
 * An archive holds the whole tenant: users, roles, memberships and every uploaded file. Until this
 * existed it was written to an external SFTP server in the clear, even for a scheme with
 * `encrypt_archive: true`.
 *
 * ## Why the stream is framed rather than one long GCM stream
 *
 * A single GCM tag covers the entire ciphertext, so it cannot be checked until the last byte has
 * been read. A reader would therefore have to either buffer a multi-gigabyte archive before
 * trusting any of it, or emit unverified plaintext and hope the tag matches later — the classic
 * release-unverified-plaintext problem. Framing makes every megabyte independently authenticated,
 * so a restore can stream and still refuse the first corrupt byte it meets.
 *
 * Three attacks that framing alone does NOT stop are closed by the AAD:
 *
 *   - **Reordering / replay.** The frame counter is authenticated, so frame 7 cannot be presented
 *     as frame 3.
 *   - **Truncation.** The last frame is the only one flagged `final`, and a reader that reaches
 *     end-of-stream without seeing it fails. Chopping the tail off an archive is detected.
 *   - **Splicing between archives.** Every frame authenticates a hash of this archive's header, and
 *     the header carries a random salt and nonce prefix. Frames from a different archive — even one
 *     made from the same passphrase — will not verify.
 *
 * ## Keys
 *
 * A fresh 32-byte data key (DEK) is generated per run and never reused. It is wrapped with a key
 * derived from the scheme's archive passphrase by scrypt, and the wrapped form is written into the
 * archive header AND recorded on `backup_runs`. Putting it in the header is deliberate: an archive
 * plus its passphrase is enough to restore, with no access to this database. If the wrapped key
 * lived only in the run row, deleting that row would render every archive it produced permanently
 * unreadable.
 *
 * The passphrase is the only thing that can open an archive. The server-wide AI_ENCRYPTION_SECRET
 * protects the passphrase *at rest in this database*; it is not what protects the archive.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
} from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/** File signature. Present so a truncated or wrong file fails immediately and by name. */
export const ARCHIVE_MAGIC = Buffer.from('XIBAK1', 'ascii');

export const ARCHIVE_FORMAT_VERSION = 1;

/** Plaintext bytes per frame. 20 bytes of overhead per MiB — 0.002%. */
export const FRAME_PLAINTEXT_BYTES = 1024 * 1024;

export const ARCHIVE_CIPHER_ALGO = 'aes-256-gcm';

const KEY_BYTES = 32;
const TAG_BYTES = 16;
const IV_BYTES = 12;
const NONCE_PREFIX_BYTES = 4;
const COUNTER_BYTES = 8;
const SALT_BYTES = 16;

/** uint32 payload length + uint8 final flag. */
const FRAME_HEADER_BYTES = 5;

/** magic + version byte + uint32 header length. */
const PREAMBLE_BYTES = ARCHIVE_MAGIC.length + 1 + 4;

/** A header is a few hundred bytes; this only stops a hostile file forcing a huge allocation. */
const MAX_HEADER_BYTES = 64 * 1024;

/** Likewise for frames: a declared length above this is rejected before anything is allocated. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/**
 * scrypt cost. ~100 ms and 32 MiB per derivation on a normal server — deliberately slow, because
 * the passphrase is the only thing standing between a stolen archive and the whole tenant.
 *
 * Node's default `maxmem` is exactly 32 MiB and these parameters need 128·N·r of it, so the limit
 * must be raised explicitly or scrypt throws.
 */
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;
const SCRYPT_MAXMEM = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2;

/** Anything wrong with the format, the key, or an authentication tag. */
export class ArchiveCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveCipherError';
  }
}

/** A DEK sealed by the passphrase-derived key. Base64 throughout — it lands in JSON and in text
 * columns. */
export interface WrappedDek {
  wrapped: string;
  iv: string;
  tag: string;
}

export interface ArchiveKdfParams {
  N: number;
  r: number;
  p: number;
  /** Base64. Random per archive, so two archives from one passphrase share no derived key. */
  salt: string;
}

/**
 * The plaintext preamble of an archive. It carries no secret: the DEK inside it is wrapped, and the
 * salt and nonce prefix are public inputs by design.
 */
export interface ArchiveHeader {
  alg: typeof ARCHIVE_CIPHER_ALGO;
  kdf: 'scrypt';
  kdf_params: ArchiveKdfParams;
  frame_size: number;
  /** Base64, 4 bytes. Prepended to the frame counter to form each 12-byte IV. */
  nonce_prefix: string;
  dek: WrappedDek;
  /**
   * Fingerprint of the server key that encrypted the passphrase *in the database*. Recorded for
   * diagnosis only — it is not needed to decrypt, and an archive stays readable with the passphrase
   * alone after a server-key rotation.
   */
  key_fingerprint: string | null;
  created_at: string;
}

/**
 * Derives the key-encryption key from an archive passphrase.
 *
 * The passphrase is normalised NFKC first: the same characters typed on two keyboards can arrive as
 * different byte sequences (composed vs decomposed accents), which would silently derive a
 * different key and make the archive unopenable by the person who set the passphrase.
 */
export function deriveArchiveKek(
  passphrase: string,
  salt: Buffer,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase.normalize('NFKC'),
      salt,
      KEY_BYTES,
      { ...SCRYPT_PARAMS, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Seals a data key with the passphrase-derived key. */
export function wrapDek(dek: Buffer, kek: Buffer): WrappedDek {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ARCHIVE_CIPHER_ALGO, kek, iv);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);

  return {
    wrapped: wrapped.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Opens a sealed data key.
 *
 * @throws ArchiveCipherError when the passphrase is wrong or the wrapped key was altered. GCM
 *   cannot tell those apart, and neither should the message — a distinguishable error would let
 *   someone confirm a guessed passphrase against a tampered file.
 */
export function unwrapDek(sealed: WrappedDek, kek: Buffer): Buffer {
  try {
    const decipher = createDecipheriv(
      ARCHIVE_CIPHER_ALGO,
      kek,
      Buffer.from(sealed.iv, 'base64'),
    );

    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));

    const dek = Buffer.concat([
      decipher.update(Buffer.from(sealed.wrapped, 'base64')),
      decipher.final(),
    ]);

    if (dek.length !== KEY_BYTES) {
      throw new Error('unexpected key length');
    }

    return dek;
  } catch {
    throw new ArchiveCipherError(
      'The archive key could not be opened. The passphrase is wrong, or the archive has been altered.',
    );
  }
}

export interface BuildHeaderOptions {
  dek: Buffer;
  kek: Buffer;
  salt: Buffer;
  keyFingerprint?: string | null;
  frameSize?: number;
  noncePrefix?: Buffer;
  createdAt?: Date;
}

/** Assembles the header for a new archive, wrapping the DEK on the way. */
export function buildArchiveHeader(options: BuildHeaderOptions): ArchiveHeader {
  const noncePrefix = options.noncePrefix ?? randomBytes(NONCE_PREFIX_BYTES);

  if (noncePrefix.length !== NONCE_PREFIX_BYTES) {
    throw new ArchiveCipherError('The nonce prefix must be 4 bytes.');
  }

  return {
    alg: ARCHIVE_CIPHER_ALGO,
    kdf: 'scrypt',
    kdf_params: { ...SCRYPT_PARAMS, salt: options.salt.toString('base64') },
    frame_size: options.frameSize ?? FRAME_PLAINTEXT_BYTES,
    nonce_prefix: noncePrefix.toString('base64'),
    dek: wrapDek(options.dek, options.kek),
    key_fingerprint: options.keyFingerprint ?? null,
    created_at: (options.createdAt ?? new Date()).toISOString(),
  };
}

/** A fresh salt for a new archive. */
export function newArchiveSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/** A fresh data key for a new archive. Never reused across runs. */
export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** magic ‖ version ‖ uint32 length ‖ UTF-8 JSON. */
export function encodeArchiveHeader(header: ArchiveHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');

  if (json.length > MAX_HEADER_BYTES) {
    throw new ArchiveCipherError('The archive header is implausibly large.');
  }

  const preamble = Buffer.allocUnsafe(PREAMBLE_BYTES);

  ARCHIVE_MAGIC.copy(preamble, 0);
  preamble.writeUInt8(ARCHIVE_FORMAT_VERSION, ARCHIVE_MAGIC.length);
  preamble.writeUInt32BE(json.length, ARCHIVE_MAGIC.length + 1);

  return Buffer.concat([preamble, json]);
}

/**
 * The additional authenticated data for one frame.
 *
 * `prefix` is sha256 of the encoded header, which binds the frame to this archive; the counter
 * binds it to its position; the flag marks the end of the stream.
 */
function frameAad(prefix: Buffer, counter: bigint, final: boolean): Buffer {
  const aad = Buffer.allocUnsafe(prefix.length + COUNTER_BYTES + 1);

  prefix.copy(aad, 0);
  aad.writeBigUInt64BE(counter, prefix.length);
  aad.writeUInt8(final ? 1 : 0, prefix.length + COUNTER_BYTES);

  return aad;
}

/** IV = 4-byte per-archive prefix ‖ 8-byte frame counter. Unique for every frame under one key. */
function frameIv(noncePrefix: Buffer, counter: bigint): Buffer {
  const iv = Buffer.allocUnsafe(IV_BYTES);

  noncePrefix.copy(iv, 0);
  iv.writeBigUInt64BE(counter, NONCE_PREFIX_BYTES);

  return iv;
}

export interface EncryptStreamOptions {
  dek: Buffer;
  header: ArchiveHeader;
}

/**
 * Encrypts a byte stream into the framed format.
 *
 * Placed last in the pipeline, after compression: ciphertext does not compress, so encrypting
 * before the zip would inflate every archive to its raw size.
 */
export class ArchiveEncryptStream extends Transform {
  private readonly dek: Buffer;
  private readonly headerBytes: Buffer;
  private readonly aadPrefix: Buffer;
  private readonly noncePrefix: Buffer;
  private readonly frameSize: number;

  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private counter = 0n;
  private headerWritten = false;

  constructor(options: EncryptStreamOptions) {
    super();

    if (options.dek.length !== KEY_BYTES) {
      throw new ArchiveCipherError('The data key must be 32 bytes.');
    }

    this.dek = options.dek;
    this.headerBytes = encodeArchiveHeader(options.header);
    this.aadPrefix = createHash('sha256').update(this.headerBytes).digest();
    this.noncePrefix = Buffer.from(options.header.nonce_prefix, 'base64');
    this.frameSize = options.header.frame_size;

    if (this.frameSize < 1 || this.frameSize > MAX_FRAME_BYTES) {
      throw new ArchiveCipherError('The frame size is out of range.');
    }
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      this.writeHeaderOnce();
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;

      while (this.pendingBytes >= this.frameSize) {
        this.emitFrame(this.takeBytes(this.frameSize), false);
      }

      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      // An empty archive still gets a header and one final frame, so it is a valid file rather
      // than zero bytes that no reader can distinguish from a failed upload.
      this.writeHeaderOnce();
      this.emitFrame(this.takeBytes(this.pendingBytes), true);
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }

  private writeHeaderOnce(): void {
    if (!this.headerWritten) {
      this.headerWritten = true;
      this.push(this.headerBytes);
    }
  }

  private emitFrame(plain: Buffer, final: boolean): void {
    const cipher = createCipheriv(
      ARCHIVE_CIPHER_ALGO,
      this.dek,
      frameIv(this.noncePrefix, this.counter),
    );

    cipher.setAAD(frameAad(this.aadPrefix, this.counter, final));

    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    const head = Buffer.allocUnsafe(FRAME_HEADER_BYTES);

    head.writeUInt32BE(body.length, 0);
    head.writeUInt8(final ? 1 : 0, 4);

    this.push(Buffer.concat([head, body, cipher.getAuthTag()]));
    this.counter += 1n;
  }

  /** Pulls exactly `n` bytes out of the pending chunks without concatenating the whole backlog. */
  private takeBytes(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;

    while (filled < n) {
      const head = this.pending[0];
      const need = n - filled;

      if (head.length <= need) {
        head.copy(out, filled);
        filled += head.length;
        this.pending.shift();
      } else {
        head.copy(out, filled, 0, need);
        this.pending[0] = head.subarray(need);
        filled = n;
      }
    }

    this.pendingBytes -= n;

    return out;
  }
}

export interface ParsedArchiveHeader {
  header: ArchiveHeader;
  /** The encoded preamble + JSON, hashed into every frame's AAD. */
  headerBytes: Buffer;
  /** Bytes consumed from the front of the input. */
  consumed: number;
}

/**
 * Reads the header from the front of a buffer.
 *
 * Exported because a passphrase has to be checked BEFORE an archive is streamed anywhere. A
 * download that only discovered a wrong passphrase mid-stream would already have sent a 200 and
 * part of a file, leaving the caller with something truncated that looks valid.
 *
 * `ArchiveDecryptStream` uses this too, so there is exactly one parser. A second copy would be free
 * to drift, and a header parser that disagrees with the writer produces archives nothing can open.
 *
 * @returns null when more bytes are needed — never an error, because a short read is normal.
 * @throws ArchiveCipherError when the bytes present are not a readable header.
 */
export function readArchiveHeader(buffer: Buffer): ParsedArchiveHeader | null {
  if (buffer.length < PREAMBLE_BYTES) {
    return null;
  }

  if (!buffer.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)) {
    throw new ArchiveCipherError(
      'This file is not an encrypted backup archive.',
    );
  }

  const version = buffer.readUInt8(ARCHIVE_MAGIC.length);

  if (version !== ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveCipherError(
      `This archive uses format version ${version}, which this server cannot read.`,
    );
  }

  const length = buffer.readUInt32BE(ARCHIVE_MAGIC.length + 1);

  if (length > MAX_HEADER_BYTES) {
    throw new ArchiveCipherError('The archive header is implausibly large.');
  }

  if (buffer.length < PREAMBLE_BYTES + length) {
    return null;
  }

  const headerBytes = buffer.subarray(0, PREAMBLE_BYTES + length);

  return {
    header: parseArchiveHeaderJson(
      headerBytes.subarray(PREAMBLE_BYTES).toString('utf8'),
    ),
    headerBytes,
    consumed: PREAMBLE_BYTES + length,
  };
}

/** Validates the decoded header. Every field the frame loop relies on is checked here, once. */
function parseArchiveHeaderJson(json: string): ArchiveHeader {
  let header: ArchiveHeader;

  try {
    header = JSON.parse(json) as ArchiveHeader;
  } catch {
    throw new ArchiveCipherError('The archive header is not readable.');
  }

  if (header.alg !== ARCHIVE_CIPHER_ALGO || header.kdf !== 'scrypt') {
    throw new ArchiveCipherError(
      'The archive uses an algorithm this server does not support.',
    );
  }

  if (
    !header.dek?.wrapped ||
    !header.dek.iv ||
    !header.dek.tag ||
    !header.kdf_params?.salt
  ) {
    throw new ArchiveCipherError('The archive header is incomplete.');
  }

  if (
    !Number.isInteger(header.frame_size) ||
    header.frame_size < 1 ||
    header.frame_size > MAX_FRAME_BYTES
  ) {
    throw new ArchiveCipherError('The archive frame size is out of range.');
  }

  if (
    Buffer.from(header.nonce_prefix ?? '', 'base64').length !==
    NONCE_PREFIX_BYTES
  ) {
    throw new ArchiveCipherError('The archive nonce prefix is malformed.');
  }

  return header;
}

/**
 * Opens the data key in an already-read header with a passphrase.
 *
 * The whole download check in one call: derive the KEK from the header's own salt, then unwrap.
 * Returns the key so the caller can hand it straight to `ArchiveDecryptStream` without paying for
 * a second scrypt derivation.
 *
 * @throws ArchiveCipherError when the passphrase is wrong or the archive was altered.
 */
export async function openArchiveKey(
  header: ArchiveHeader,
  passphrase: string,
): Promise<Buffer> {
  const kek = await deriveArchiveKek(
    passphrase,
    Buffer.from(header.kdf_params.salt, 'base64'),
  );

  return unwrapDek(header.dek, kek);
}

/**
 * True when these bytes begin an encrypted archive.
 *
 * Used to cross-check `backup_artifacts.is_encrypted` against the file itself: if the two disagree,
 * something is wrong with the record and serving the file anyway would hand back something the
 * caller cannot open.
 */
export function looksEncrypted(buffer: Buffer): boolean {
  return (
    buffer.length >= ARCHIVE_MAGIC.length &&
    buffer.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)
  );
}

/**
 * Supplies the data key once the header — and therefore the salt — has been read.
 *
 * A callback rather than a constructor argument because the KDF salt lives in the file being read,
 * so the key cannot be known before the stream starts.
 */
export type ArchiveKeyResolver = (header: ArchiveHeader) => Promise<Buffer>;

/** Builds a resolver that derives the key from a passphrase using the archive's own parameters. */
export function passphraseResolver(passphrase: string): ArchiveKeyResolver {
  return async (header) => {
    const kek = await deriveArchiveKek(
      passphrase,
      Buffer.from(header.kdf_params.salt, 'base64'),
    );

    return unwrapDek(header.dek, kek);
  };
}

/**
 * Decrypts and authenticates the framed format.
 *
 * Nothing is emitted before its frame's tag has verified, so a corrupt archive fails at the first
 * bad megabyte instead of after a full download.
 */
export class ArchiveDecryptStream extends Transform {
  private readonly resolveKey: ArchiveKeyResolver;

  private buffer: Buffer = Buffer.alloc(0);
  private header: ArchiveHeader | null = null;
  private dek: Buffer | null = null;
  private aadPrefix: Buffer = Buffer.alloc(0);
  private noncePrefix: Buffer = Buffer.alloc(0);
  private counter = 0n;
  private sawFinal = false;

  constructor(resolveKey: ArchiveKeyResolver) {
    super();
    this.resolveKey = resolveKey;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.consume(chunk).then(
      () => callback(),
      (err: unknown) => callback(err as Error),
    );
  }

  override _flush(callback: TransformCallback): void {
    if (!this.sawFinal) {
      callback(
        new ArchiveCipherError(
          'The archive ends before its final frame — it is truncated or incomplete.',
        ),
      );

      return;
    }

    callback();
  }

  private async consume(chunk: Buffer): Promise<void> {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    if (!this.dek) {
      const parsed = this.tryReadHeader();

      if (!parsed) {
        return;
      }

      this.dek = await this.resolveKey(parsed);

      if (this.dek.length !== KEY_BYTES) {
        throw new ArchiveCipherError('The resolved data key is not 32 bytes.');
      }
    }

    this.readFrames();
  }

  /** Returns the header once enough bytes have arrived, otherwise null. */
  private tryReadHeader(): ArchiveHeader | null {
    const parsed = readArchiveHeader(this.buffer);

    if (!parsed) {
      return null;
    }

    // Hashed over the encoded bytes, so any edit to the header — including one that still parses
    // as valid JSON — invalidates every frame.
    this.aadPrefix = createHash('sha256').update(parsed.headerBytes).digest();
    this.noncePrefix = Buffer.from(parsed.header.nonce_prefix, 'base64');
    this.header = parsed.header;
    this.buffer = this.buffer.subarray(parsed.consumed);

    return parsed.header;
  }

  private readFrames(): void {
    const header = this.header;
    const dek = this.dek;

    if (!header || !dek) {
      return;
    }

    for (;;) {
      if (this.buffer.length < FRAME_HEADER_BYTES) {
        return;
      }

      const length = this.buffer.readUInt32BE(0);
      const final = this.buffer.readUInt8(4) === 1;

      if (length > header.frame_size) {
        throw new ArchiveCipherError(
          'A frame declares more bytes than the archive allows.',
        );
      }

      const total = FRAME_HEADER_BYTES + length + TAG_BYTES;

      if (this.buffer.length < total) {
        return;
      }

      if (this.sawFinal) {
        throw new ArchiveCipherError(
          'The archive continues past its final frame — it has been altered.',
        );
      }

      const body = this.buffer.subarray(FRAME_HEADER_BYTES, total - TAG_BYTES);
      const tag = this.buffer.subarray(total - TAG_BYTES, total);

      this.push(this.openFrame(dek, body, tag, final));

      this.buffer = this.buffer.subarray(total);
      this.counter += 1n;
      this.sawFinal = final;
    }
  }

  private openFrame(
    dek: Buffer,
    body: Buffer,
    tag: Buffer,
    final: boolean,
  ): Buffer {
    try {
      const decipher = createDecipheriv(
        ARCHIVE_CIPHER_ALGO,
        dek,
        frameIv(this.noncePrefix, this.counter),
      );

      decipher.setAAD(frameAad(this.aadPrefix, this.counter, final));
      decipher.setAuthTag(tag);

      // decipher.final() is what verifies the tag, so the concat below never yields unverified
      // plaintext: if the frame was altered it throws before anything is returned.
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch (err) {
      if (err instanceof ArchiveCipherError) {
        throw err;
      }

      throw new ArchiveCipherError(
        `Frame ${this.counter} failed its integrity check. The archive has been altered or corrupted.`,
      );
    }
  }
}
