import { createHash } from 'crypto';
import { once } from 'events';
import { createReadStream, createWriteStream } from 'fs';
import { open, rm } from 'fs/promises';
import { join } from 'path';
import type { Readable } from 'stream';
import { finished, pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';

import {
  anonymousPullToken,
  isRecord,
  maxUserImageBytes,
  registryBlobUrl,
  UserImageError,
  type Schema1Image,
  type Schema1Layer,
  type UserImageRef,
} from '../../../test-management/automation/custom-images/registry/custom-image-review';
import { SafeGetError } from '../../../test-management/automation/custom-images/shared/https/safe-https-get';
import {
  safeHttpsStream,
  type SafeStreamOptions,
  type SafeStreamResult,
} from '../../../test-management/automation/custom-images/shared/https/safe-https-stream';
import {
  CLEAN_TAR,
  hasRoomForUpload,
  LoadMachineProblem,
  uploadFolder,
} from '../image-file/load/load-upload';
import {
  TAR_END,
  TAR_MAX_FILE_BYTES,
  tarFile,
  tarHeader,
  tarPadding,
} from '../image-file/tar/clean-tar';
import {
  ImageFileError,
  readImageFile,
  type ImageFile,
} from '../image-file/tar/image-tar';
import { TryLater } from '../review/scanner/custom-image-scanner';

const HEAD_DEADLINE_MS = 30_000;
const LAYER_DEADLINE_MS = 15 * 60_000;

export interface ConvertSchema1Input {
  ref: UserImageRef;
  image: Schema1Image;
  // The cleaned image file is written here, under CLEAN_TAR, as for an upload.
  folder: string;
  signal: AbortSignal;
  onBytes?: (done: number, total: number) => void;
  stream?: typeof safeHttpsStream;
  pullToken?: typeof anonymousPullToken;
}

interface Downloaded {
  path: string;
  gzip: boolean;
  diffId: string;
  size: number;
}

const hexOf = (digest: string) => digest.replace(/^sha256:/, '');

const tooLarge = () =>
  new ImageFileError(
    'IMAGE_TOO_LARGE',
    'The image is larger than this server allows',
  );

/** Layer downloads with the registry's anonymous token, asked for again when it runs out. */
class LayerAccess {
  private token: string | null = null;

  constructor(
    private readonly ref: UserImageRef,
    private readonly stream: typeof safeHttpsStream,
    private readonly pullToken: typeof anonymousPullToken,
  ) {}

  async request(
    digest: string,
    options: SafeStreamOptions,
  ): Promise<SafeStreamResult> {
    const url = registryBlobUrl(this.ref, digest);
    let answer = await this.send(url, options);

    if (answer.status === 401) {
      this.token = await this.pullToken(
        this.ref,
        answer.headers['www-authenticate'],
      );
      answer = await this.send(url, options);
    }

    if (answer.status === 429) {
      throw new TryLater('The registry is limiting downloads');
    }

    if ([401, 403, 404].includes(answer.status)) {
      throw new UserImageError(
        'IMAGE_NOT_PUBLIC',
        'A layer of the image was not found, or it is not public',
      );
    }

    if (answer.status !== 200) {
      throw new TryLater(`The registry answered ${answer.status}`);
    }

    return answer;
  }

  private async send(
    url: string,
    options: SafeStreamOptions,
  ): Promise<SafeStreamResult> {
    try {
      return await this.stream(
        url,
        this.token ? { authorization: `Bearer ${this.token}` } : {},
        options,
      );
    } catch (error) {
      if (error instanceof SafeGetError) {
        if (error.failure === 'TOO_LARGE') throw tooLarge();

        throw new TryLater(
          `A layer could not be downloaded (${error.failure})`,
        );
      }

      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
        throw new LoadMachineProblem('Not enough free disk for the image');
      }

      throw error;
    }
  }
}

async function startsWithGzip(path: string): Promise<boolean> {
  const handle = await open(path, 'r');

  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(2), 0, 2, 0);

    return bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

/** The plain tar of a downloaded layer; gzip may hold several members, which gunzip reads one after another. */
function layerContent(path: string, gzip: boolean): AsyncIterable<Buffer> {
  const source = createReadStream(path);

  if (!gzip) return source as Readable & AsyncIterable<Buffer>;

  const gunzip = createGunzip();

  // The read of gunzip meets the same error.
  pipeline(source, gunzip).catch(() => undefined);

  return gunzip as Readable & AsyncIterable<Buffer>;
}

/** Size and digest of a layer as Docker counts it: the plain tar, not the download. */
async function measure(
  path: string,
  room: number,
): Promise<Omit<Downloaded, 'path'>> {
  const gzip = await startsWithGzip(path);
  const hash = createHash('sha256');
  let size = 0;

  try {
    for await (const chunk of layerContent(path, gzip)) {
      size += chunk.length;

      // A small download can unpack to a huge layer.
      if (size > room || size > TAR_MAX_FILE_BYTES) throw tooLarge();

      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof ImageFileError) throw error;

    throw new ImageFileError(
      'IMAGE_FILE_INVALID',
      'A layer of the image is damaged',
    );
  }

  return { gzip, diffId: `sha256:${hash.digest('hex')}`, size };
}

function commandOf(history: Record<string, unknown>): string {
  const settings = isRecord(history.container_config)
    ? history.container_config
    : {};

  return Array.isArray(settings.Cmd)
    ? settings.Cmd.filter((part): part is string => typeof part === 'string')
        .join(' ')
        .slice(0, 4096)
    : '';
}

/** The settings file of the current format, in a fixed key order, so the same image always gets the same digest. */
export function schema1Config(
  image: Schema1Image,
  diffIds: string[],
): Record<string, unknown> {
  const top = image.config;

  return {
    architecture: top.architecture,
    config: isRecord(top.config) ? top.config : {},
    container: top.container,
    container_config: top.container_config,
    created: top.created,
    docker_version: top.docker_version,
    history: image.layers.map((layer: Schema1Layer) => ({
      created: layer.history.created,
      ...(typeof layer.history.author === 'string' && {
        author: layer.history.author,
      }),
      created_by: commandOf(layer.history),
      ...(layer.throwaway && { empty_layer: true }),
    })),
    os: top.os,
    rootfs: { type: 'layers', diff_ids: diffIds },
  };
}

/**
 * Downloads an old schema 1 image layer by layer, checks every digest, and writes it as a docker save file in
 * `folder`, which is then read like an uploaded file.
 */
export async function convertSchema1(
  input: ConvertSchema1Input,
): Promise<ImageFile> {
  const { image, folder, signal } = input;
  const max = maxUserImageBytes();
  const access = new LayerAccess(
    input.ref,
    input.stream ?? safeHttpsStream,
    input.pullToken ?? anonymousPullToken,
  );
  const stored = image.layers.filter((layer) => !layer.throwaway);

  if (stored.length === 0) {
    throw new ImageFileError('IMAGE_FILE_INVALID', 'The image has no layers');
  }

  const unique = [...new Set(stored.map((layer) => layer.digest))];
  let total = 0;

  for (const digest of unique) {
    signal.throwIfAborted();

    const head = await access.request(digest, {
      method: 'HEAD',
      maxBytes: 0,
      deadlineMs: HEAD_DEADLINE_MS,
      signal,
    });
    const length = Number(head.headers['content-length']);

    if (Number.isSafeInteger(length) && length > 0) total += length;
  }

  if (total > max) throw tooLarge();

  if (!(await hasRoomForUpload(total))) {
    throw new LoadMachineProblem('Not enough free disk for the image');
  }

  const blobs = await uploadFolder();

  try {
    const downloaded = new Map<string, Downloaded>();
    let done = 0;
    let unpacked = 0;

    for (const digest of unique) {
      signal.throwIfAborted();

      const path = join(blobs, `${hexOf(digest)}.blob`);
      const out = createWriteStream(path, { flags: 'wx', mode: 0o600 });
      const hash = createHash('sha256');
      const state: { failure: Error | null } = { failure: null };

      out.on('error', (failure) => {
        state.failure = failure;
      });

      try {
        await access.request(digest, {
          method: 'GET',
          maxBytes: Math.max(max - done, 0),
          deadlineMs: LAYER_DEADLINE_MS,
          signal,
          onData: async (chunk) => {
            if (state.failure) throw state.failure;

            hash.update(chunk);
            done += chunk.length;
            input.onBytes?.(done, total);

            if (!out.write(chunk)) await once(out, 'drain');
          },
        });
      } finally {
        out.end();
        await finished(out).catch(() => undefined);
      }

      if (state.failure) {
        throw (state.failure as NodeJS.ErrnoException).code === 'ENOSPC'
          ? new LoadMachineProblem('Not enough free disk for the image')
          : state.failure;
      }

      if (`sha256:${hash.digest('hex')}` !== digest) {
        throw new ImageFileError(
          'DIGEST_MISMATCH',
          'A layer of the image has another digest than its description names',
        );
      }

      const layer = await measure(path, max - unpacked);

      unpacked += layer.size;
      downloaded.set(digest, { path, ...layer });
    }

    if (!(await hasRoomForUpload(unpacked))) {
      throw new LoadMachineProblem('Not enough free disk for the image');
    }

    const layerOf = (digest: string): Downloaded => {
      const layer = downloaded.get(digest);

      if (!layer) throw new Error(`Layer ${digest} was not downloaded`);

      return layer;
    };
    const names = stored.map(
      (layer) => `${hexOf(layerOf(layer.digest).diffId)}/layer.tar`,
    );
    const configBytes = Buffer.from(
      JSON.stringify(
        schema1Config(
          image,
          stored.map((layer) => layerOf(layer.digest).diffId),
        ),
      ),
    );
    const configName = `${createHash('sha256').update(configBytes).digest('hex')}.json`;

    async function* imageTar(): AsyncGenerator<Buffer> {
      const written = new Set<string>();

      for (const [index, layer] of stored.entries()) {
        const name = names[index];

        // The same layer twice is kept once, as docker save does.
        if (written.has(name)) continue;

        written.add(name);
        signal.throwIfAborted();

        const file = layerOf(layer.digest);
        let size = 0;

        yield tarHeader(name, file.size);

        for await (const chunk of layerContent(file.path, file.gzip)) {
          size += chunk.length;

          if (size > file.size) break;

          yield chunk;
        }

        if (size !== file.size) {
          throw new ImageFileError(
            'IMAGE_FILE_INVALID',
            'A layer of the image changed while it was converted',
          );
        }

        yield tarPadding(file.size);
      }

      yield tarFile(configName, configBytes);
      yield tarFile(
        'manifest.json',
        Buffer.from(
          JSON.stringify([{ Config: configName, RepoTags: [], Layers: names }]),
        ),
      );
      yield TAR_END;
    }

    const out = createWriteStream(join(folder, CLEAN_TAR), {
      flags: 'wx',
      mode: 0o600,
    });
    const state: { failure: Error | null } = { failure: null };

    out.on('error', (failure) => {
      state.failure = failure;
    });

    try {
      const file = await readImageFile(
        imageTar(),
        async (chunk) => {
          if (state.failure) throw state.failure;
          if (!out.write(chunk)) await once(out, 'drain');
        },
        max,
      );

      out.end();
      await finished(out);

      return file;
    } finally {
      out.destroy();
    }
  } finally {
    await rm(blobs, { recursive: true, force: true });
  }
}
