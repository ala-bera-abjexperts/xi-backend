import { createHash, type Hash } from 'crypto';
import { posix } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';

import { maxUserImageBytes } from '../../../../test-management/automation/custom-images/registry/custom-image-review';
import {
  cleanIndex,
  cleanManifest,
  isAttestation,
  NAMING_FILES,
  TAR_END,
  tarFile,
} from './clean-tar';

type Json = Record<string, unknown>;

export type ImageFileErrorCode =
  | 'IMAGE_FILE_INVALID'
  | 'IMAGE_FILE_NOT_ONE'
  | 'DIGEST_MISMATCH'
  | 'IMAGE_TOO_LARGE'
  | 'UPLOAD_MISSING';

/** Something wrong with the uploaded file itself, so checking it again gives the same answer. */
export class ImageFileError extends Error {
  constructor(
    readonly code: ImageFileErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What a docker save file holds, read without unpacking it. */
export interface ImageFile {
  configDigest: string;
  config: Json;
  diffIds: string[];
  configBytes: number;
  layerBytes: number[];
  unpackedBytes: number;
}

const BLOCK = 512;
// Image descriptions and settings are small; layers are not kept in memory.
const KEEP_MAX = 1024 * 1024;
const KEPT_TOTAL_MAX = 32 * 1024 * 1024;
const EXTENDED_MAX = 64 * 1024;
const BLOB = /^blobs\/sha256\/([0-9a-f]{64})$/;
const CLASSIC_CONFIG = /^([0-9a-f]{64})\.json$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REGULAR = new Set(['0', '7']);
const LINKS = new Set(['1', '2']);
const KNOWN_TYPES = new Set(['0', '7', '5', '1', '2']);

const invalid = (message: string) =>
  new ImageFileError('IMAGE_FILE_INVALID', message);
const notOne = () =>
  new ImageFileError(
    'IMAGE_FILE_NOT_ONE',
    'The file must hold exactly one image',
  );

interface Entry {
  type: string;
  size: number;
  link: string;
}

type Current =
  | { kind: 'extended'; type: string; chunks: Buffer[] }
  | {
      kind: 'file';
      name: string;
      keep: boolean;
      hash: Hash | null;
      expected: string | null;
      chunks: Buffer[] | null;
    };

interface Pending {
  path?: string;
  link?: string;
  size?: number;
  raw: Buffer[];
}

function asBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parse(content: Buffer, name: string): unknown {
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    throw invalid(`${name} in the file is not valid JSON`);
  }
}

function parseObject(content: Buffer, name: string): Json {
  const value = parse(content, name);

  if (!isObject(value)) throw invalid(`${name} in the file is not valid`);

  return value;
}

function text(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);

  return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

function headerNumber(block: Buffer, start: number, length: number): number {
  // Base-256, for sizes larger than octal digits hold.
  if (block[start] & 0x80) {
    let value = block[start] & 0x7f;

    for (let i = 1; i < length; i++) value = value * 256 + block[start + i];

    return value;
  }

  const digits = text(block, start, length).trim();

  if (!/^[0-7]*$/.test(digits)) {
    throw invalid('A part of the file has a broken header');
  }

  return digits ? parseInt(digits, 8) : 0;
}

function checksumMatches(block: Buffer): boolean {
  let sum = 0;

  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i];

  return headerNumber(block, 148, 8) === sum;
}

function cleanName(raw: string): string {
  const name = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '');

  if (!name || name.startsWith('/') || name.split('/').includes('..')) {
    throw invalid('A part of the file has an unsafe name');
  }

  return name;
}

function paxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;

  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = Number(data.subarray(offset, space).toString('ascii'));

    if (
      space === -1 ||
      !Number.isInteger(length) ||
      length <= 0 ||
      offset + length > data.length
    ) {
      throw invalid('A part of the file has a broken header');
    }

    const record = data
      .subarray(space + 1, offset + length - 1)
      .toString('utf8');
    const equals = record.indexOf('=');

    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);

    offset += length;
  }

  return records;
}

/** Reads a tar stream piece by piece; what the cleaned copy gets is collected for the caller to write. */
class TarReader {
  private header = Buffer.alloc(0);
  private current: Current | null = null;
  private remaining = 0;
  private padding = 0;
  private pending: Pending = { raw: [] };
  private zeroBlocks = 0;
  private ended = false;
  private seen = 0;
  private keptBytes = 0;
  private output: Buffer[] = [];
  private readonly entries = new Map<string, Entry>();
  private readonly kept = new Map<string, Buffer>();
  private readonly naming = new Map<string, Buffer>();

  constructor(
    private readonly maxBytes: number,
    private readonly cleaning: boolean,
  ) {}

  push(chunk: Buffer): void {
    this.seen += chunk.length;

    if (this.seen > this.maxBytes) {
      throw new ImageFileError(
        'IMAGE_TOO_LARGE',
        `The image is larger than ${Math.floor(this.maxBytes / 1024 ** 3)} GB unpacked`,
      );
    }

    let offset = 0;

    // Whatever follows the end of the archive is only padding.
    while (offset < chunk.length && !this.ended) {
      if (this.remaining > 0) {
        const piece = chunk.subarray(
          offset,
          offset + Math.min(this.remaining, chunk.length - offset),
        );

        this.data(piece);
        this.remaining -= piece.length;
        offset += piece.length;

        if (this.remaining === 0 && this.padding === 0) this.finishEntry();
      } else if (this.padding > 0) {
        const piece = chunk.subarray(
          offset,
          offset + Math.min(this.padding, chunk.length - offset),
        );

        this.raw(piece);
        this.padding -= piece.length;
        offset += piece.length;

        if (this.padding === 0) this.finishEntry();
      } else {
        const piece = chunk.subarray(
          offset,
          offset + Math.min(BLOCK - this.header.length, chunk.length - offset),
        );

        this.header = Buffer.concat([this.header, piece]);
        offset += piece.length;

        if (this.header.length === BLOCK) {
          const block = this.header;

          this.header = Buffer.alloc(0);
          this.onHeader(block);
        }
      }
    }
  }

  /** The pieces of the cleaned copy read since the last call. */
  take(): Buffer[] {
    const pieces = this.output;

    this.output = [];

    return pieces;
  }

  finish(): {
    file: ImageFile;
    manifest: Json[];
    index: Json | null;
  } {
    if (!this.ended) throw invalid('The file ends too early; upload it again');

    const manifestText = this.naming.get('manifest.json');

    if (!manifestText) {
      throw invalid(
        'The file has no manifest.json, so it is not from docker save',
      );
    }

    const manifest = parse(manifestText, 'manifest.json');

    if (!Array.isArray(manifest) || manifest.length !== 1) throw notOne();

    const entry: unknown = manifest[0];

    if (
      !isObject(entry) ||
      typeof entry.Config !== 'string' ||
      !Array.isArray(entry.Layers) ||
      !entry.Layers.every((layer) => typeof layer === 'string')
    ) {
      throw invalid('manifest.json in the file is not valid');
    }

    const configName = cleanName(entry.Config);
    const layers = entry.Layers.map(cleanName);
    const configHex =
      BLOB.exec(configName)?.[1] ?? CLASSIC_CONFIG.exec(configName)?.[1];
    const configText = configHex ? this.kept.get(configName) : undefined;

    if (!configHex || !configText) {
      throw invalid('The image settings named in manifest.json are missing');
    }

    const configDigest = `sha256:${configHex}`;
    const config = parseObject(configText, 'The image settings');
    const rootfs = isObject(config.rootfs) ? config.rootfs : {};
    const diffIds = Array.isArray(rootfs.diff_ids)
      ? rootfs.diff_ids.filter(
          (id): id is string => typeof id === 'string' && DIGEST.test(id),
        )
      : [];

    if (
      !Array.isArray(rootfs.diff_ids) ||
      diffIds.length !== rootfs.diff_ids.length ||
      diffIds.length !== layers.length
    ) {
      throw invalid('The image settings do not match its layers');
    }

    const layerBytes = layers.map((name) => this.layerSize(name));
    const indexText = this.naming.get('index.json');
    let index: Json | null = null;

    if (indexText) {
      const document = parseObject(indexText, 'index.json');

      index = cleanIndex(
        document,
        this.imageEntry(document, configDigest, layers.length),
      );
    }

    return {
      file: {
        configDigest,
        config,
        diffIds,
        configBytes: configText.length,
        layerBytes,
        unpackedBytes: this.seen,
      },
      manifest: cleanManifest(entry),
      index,
    };
  }

  private onHeader(block: Buffer): void {
    if (block.every((byte) => byte === 0)) {
      this.zeroBlocks += 1;
      this.ended = this.zeroBlocks === 2;

      return;
    }

    if (
      this.zeroBlocks > 0 ||
      !text(block, 257, 6).startsWith('ustar') ||
      !checksumMatches(block)
    ) {
      throw invalid('This is not a docker save file, or it is damaged');
    }

    const type = block[156] === 0 ? '0' : String.fromCharCode(block[156]);
    let size = headerNumber(block, 124, 12);

    if (type === 'x' || type === 'g' || type === 'L') {
      if (size > EXTENDED_MAX)
        throw invalid('A part of the file has a broken header');

      this.current = { kind: 'extended', type, chunks: [] };
      this.raw(block);
      this.begin(size);

      return;
    }

    if (!KNOWN_TYPES.has(type)) {
      throw invalid('The file holds something other than files and folders');
    }

    const prefix = text(block, 345, 155);
    const base = text(block, 0, 100);
    const name = cleanName(
      this.pending.path ?? (prefix ? `${prefix}/${base}` : base),
    );
    const link = this.pending.link ?? text(block, 157, 100);

    if (this.pending.size !== undefined) size = this.pending.size;

    if (LINKS.has(type)) {
      const target = posix.normalize(
        type === '2' ? posix.join(posix.dirname(name), link) : link,
      );

      if (target.startsWith('/') || target.split('/')[0] === '..') {
        throw invalid('A link in the file points outside it');
      }
    }

    if (this.entries.has(name)) throw invalid('The file holds a name twice');

    const regular = REGULAR.has(type);
    const keep = !NAMING_FILES.has(name);
    const digest = regular
      ? (BLOB.exec(name)?.[1] ?? CLASSIC_CONFIG.exec(name)?.[1] ?? null)
      : null;

    if (NAMING_FILES.has(name) && (!regular || size > KEEP_MAX)) {
      throw invalid(`${name} in the file is not valid`);
    }

    this.entries.set(name, { type, size: regular ? size : 0, link });

    if (this.cleaning && keep) this.output.push(...this.pending.raw, block);

    this.pending = { raw: [] };
    this.current = {
      kind: 'file',
      name,
      keep,
      hash: digest ? createHash('sha256') : null,
      expected: digest,
      chunks: regular && size <= KEEP_MAX ? [] : null,
    };
    this.begin(size);
  }

  private begin(size: number): void {
    this.remaining = size;
    this.padding = (BLOCK - (size % BLOCK)) % BLOCK;

    if (size === 0) this.finishEntry();
  }

  private data(piece: Buffer): void {
    const current = this.current!;

    if (current.kind === 'extended') {
      current.chunks.push(Buffer.from(piece));
      this.raw(piece);

      return;
    }

    current.hash?.update(piece);
    current.chunks?.push(piece);
    if (this.cleaning && current.keep) this.output.push(piece);
  }

  /** Header and padding bytes; an extended header waits for the entry it belongs to. */
  private raw(piece: Buffer): void {
    const current = this.current!;

    if (!this.cleaning) return;

    if (current.kind === 'extended') this.pending.raw.push(Buffer.from(piece));
    else if (current.keep) this.output.push(piece);
  }

  private finishEntry(): void {
    const current = this.current!;

    this.current = null;

    if (current.kind === 'extended') {
      const data = Buffer.concat(current.chunks);

      if (current.type === 'L') {
        this.pending.path = data.toString('utf8').replace(/\0+$/, '');
      } else if (current.type === 'x') {
        const records = paxRecords(data);

        if (records.path) this.pending.path = records.path;
        if (records.linkpath) this.pending.link = records.linkpath;

        if (records.size !== undefined) {
          const size = Number(records.size);

          if (!Number.isSafeInteger(size) || size < 0) {
            throw invalid('A part of the file has a broken header');
          }

          this.pending.size = size;
        }
      }

      return;
    }

    if (current.hash && current.hash.digest('hex') !== current.expected) {
      throw new ImageFileError(
        'DIGEST_MISMATCH',
        `${current.name} in the file does not match its digest`,
      );
    }

    if (!current.chunks) return;

    const content = Buffer.concat(current.chunks);

    if (NAMING_FILES.has(current.name)) {
      this.naming.set(current.name, content);
    } else if (content[0] === 0x7b) {
      this.keptBytes += content.length;

      if (this.keptBytes > KEPT_TOTAL_MAX) {
        throw invalid('The file holds too many small files');
      }

      this.kept.set(current.name, content);
    }
  }

  private layerSize(name: string): number {
    const entry = this.entries.get(name);

    // A layer saved twice is stored once, with a link to it.
    const target =
      entry?.type === '2'
        ? this.entries.get(
            posix.normalize(posix.join(posix.dirname(name), entry.link)),
          )
        : entry?.type === '1'
          ? this.entries.get(posix.normalize(entry.link))
          : entry;

    if (!target || !REGULAR.has(target.type)) {
      throw invalid('A layer named in manifest.json is missing');
    }

    return target.size;
  }

  /** The one image entry of index.json; it must describe the same image as manifest.json. */
  private imageEntry(
    index: Json,
    configDigest: string,
    layerCount: number,
  ): Json {
    const entries = (Array.isArray(index.manifests) ? index.manifests : [])
      .filter(isObject)
      .filter((entry) => !isAttestation(entry));
    // An image saved under two names is listed twice.
    const unique = [
      ...new Map(
        entries.map((entry) => [String(entry.digest), entry]),
      ).values(),
    ];

    if (unique.length !== 1) throw notOne();

    const manifests = this.imageManifests(unique, 0);

    if (manifests.length !== 1) throw notOne();

    const config = isObject(manifests[0].config) ? manifests[0].config : {};
    const layers = manifests[0].layers;

    if (
      config.digest !== configDigest ||
      !Array.isArray(layers) ||
      layers.length !== layerCount
    ) {
      throw invalid('index.json and manifest.json describe different images');
    }

    return unique[0];
  }

  private imageManifests(entries: Json[], depth: number): Json[] {
    const found: Json[] = [];

    for (const entry of entries) {
      if (isAttestation(entry)) continue;

      const digest = entry.digest;
      const blob =
        typeof digest === 'string' && DIGEST.test(digest)
          ? this.kept.get(`blobs/sha256/${digest.slice('sha256:'.length)}`)
          : undefined;

      // A multi-platform list names platforms that were never saved; only the saved ones count.
      if (!blob) {
        if (depth === 0)
          throw invalid('An image named in index.json is missing');

        continue;
      }

      const document = parseObject(blob, 'An image description');

      if (!Array.isArray(document.manifests)) {
        found.push(document);
      } else if (depth < 2) {
        found.push(
          ...this.imageManifests(
            document.manifests.filter(isObject),
            depth + 1,
          ),
        );
      } else {
        throw invalid('index.json in the file is not valid');
      }
    }

    return found;
  }
}

/** The tar stream inside, whether the file was gzipped or not. */
async function* unpacked(
  source: AsyncIterable<Buffer | Uint8Array>,
): AsyncGenerator<Buffer> {
  const iterator = source[Symbol.asyncIterator]();

  try {
    let head = Buffer.alloc(0);

    // Two bytes tell a gzip file, so a tiny first piece waits for the next.
    while (head.length < 2) {
      const next = await iterator.next();

      if (next.done) break;

      head = Buffer.concat([head, asBuffer(next.value)]);
    }

    if (head.length === 0) return;

    const rest = async function* (): AsyncGenerator<Buffer> {
      yield head;

      for (;;) {
        const next = await iterator.next();

        if (next.done) return;

        yield asBuffer(next.value);
      }
    };

    if (head[0] !== 0x1f || head[1] !== 0x8b) {
      yield* rest();

      return;
    }

    const gunzip = createGunzip();
    const feeding = pipeline(Readable.from(rest()), gunzip);

    // The read below meets the same error.
    feeding.catch(() => undefined);

    for await (const chunk of gunzip) yield chunk as Buffer;

    await feeding;
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
}

/**
 * Reads a docker save file (.tar or .tar.gz, classic or OCI layout) and checks every blob against its digest.
 * With `write`, a cleaned plain tar goes out in the same pass: every blob unchanged, no image names.
 */
export async function readImageFile(
  source: AsyncIterable<Buffer | Uint8Array>,
  write?: (chunk: Buffer) => Promise<void>,
  maxBytes = maxUserImageBytes(),
): Promise<ImageFile> {
  const reader = new TarReader(maxBytes, write !== undefined);

  for await (const chunk of unpacked(source)) {
    reader.push(chunk);

    if (write) for (const piece of reader.take()) await write(piece);
  }

  const { file, manifest, index } = reader.finish();

  if (write) {
    await write(
      tarFile('manifest.json', Buffer.from(JSON.stringify(manifest))),
    );

    if (index)
      await write(tarFile('index.json', Buffer.from(JSON.stringify(index))));

    await write(TAR_END);
  }

  return file;
}
