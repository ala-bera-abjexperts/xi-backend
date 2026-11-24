import { createHash } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'zlib';

import type {
  Schema1Image,
  UserImageRef,
} from '../../../test-management/automation/custom-images/registry/custom-image-review';
import type {
  SafeStreamOptions,
  SafeStreamResult,
} from '../../../test-management/automation/custom-images/shared/https/safe-https-stream';
import {
  CLEAN_TAR,
  hasRoomForUpload,
  uploadFolder,
} from '../image-file/load/load-upload';
import { TAR_END, tarFile } from '../image-file/tar/clean-tar';
import { readImageFile } from '../image-file/tar/image-tar';
import { convertSchema1 } from './schema1-image';

jest.mock('../image-file/load/load-upload', () => ({
  ...jest.requireActual<typeof import('../image-file/load/load-upload')>(
    '../image-file/load/load-upload',
  ),
  hasRoomForUpload: jest.fn(),
  uploadFolder: jest.fn(),
}));

const room = hasRoomForUpload as unknown as jest.Mock;
const folderFor = uploadFolder as unknown as jest.Mock;

const sha = (bytes: Buffer) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** A layer as a registry keeps it: a gzipped tar, and the plain tar Docker counts. */
function layer(text: string) {
  const plain = Buffer.concat([
    tarFile('file.txt', Buffer.from(text)),
    TAR_END,
  ]);
  const blob = gzipSync(plain);

  return { blob, digest: sha(blob), diffId: sha(plain) };
}

const ref: UserImageRef = {
  registry: 'docker.io',
  repository: 'training/webapp',
  digest: `sha256:${'a'.repeat(64)}`,
  imageRef: `docker.io/training/webapp@sha256:${'a'.repeat(64)}`,
};

const base = layer('base');
const top = layer('top');
const empty = layer('');

function oldImage(): Schema1Image {
  return {
    config: {
      os: 'linux',
      architecture: 'amd64',
      config: { Env: ['PYTHON_VERSION=2.7'] },
      created: '2015-01-01T00:00:00Z',
    },
    layers: [
      { digest: base.digest, throwaway: false, history: { created: 'a' } },
      // The same layer twice, as old images often have.
      { digest: base.digest, throwaway: false, history: { created: 'b' } },
      { digest: empty.digest, throwaway: true, history: { created: 'c' } },
      {
        digest: top.digest,
        throwaway: false,
        history: {
          created: 'd',
          container_config: { Cmd: ['/bin/sh', '-c', 'run'] },
        },
      },
    ],
  };
}

/** A registry that wants a token first, then serves the layers it holds. */
function registry(blobs: Record<string, Buffer>) {
  const asked: { url: string; method: string; auth?: string }[] = [];
  const stream = jest.fn(
    async (
      url: string,
      headers: Record<string, string>,
      options: SafeStreamOptions,
    ): Promise<SafeStreamResult> => {
      asked.push({ url, method: options.method, auth: headers.authorization });

      if (!headers.authorization) {
        return {
          status: 401,
          headers: { 'www-authenticate': 'Bearer realm="https://auth"' },
          bytes: 0,
        };
      }

      const body = blobs[url.slice(url.lastIndexOf('/') + 1)];

      if (!body) return { status: 404, headers: {}, bytes: 0 };

      if (options.method === 'GET') {
        for (let at = 0; at < body.length; at += 7) {
          await options.onData?.(body.subarray(at, at + 7));
        }
      }

      return {
        status: 200,
        headers: { 'content-length': String(body.length) },
        bytes: options.method === 'GET' ? body.length : 0,
      };
    },
  );
  const pullToken = jest.fn().mockResolvedValue('token');

  return { stream, pullToken, asked };
}

async function* fileChunks(path: string): AsyncGenerator<Buffer> {
  for await (const chunk of createReadStream(path)) yield chunk as Buffer;
}

describe('convertSchema1', () => {
  let folder: string;
  let blobFolders: string[];

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'convert-'));
    blobFolders = [];
    room.mockReset().mockResolvedValue(true);
    folderFor.mockReset().mockImplementation(async () => {
      const made = await mkdtemp(join(tmpdir(), 'upload-'));

      blobFolders.push(made);

      return made;
    });
  });

  it('downloads each stored layer once, builds the image file and removes the downloads', async () => {
    const { stream, pullToken, asked } = registry({
      [base.digest]: base.blob,
      [top.digest]: top.blob,
    });

    const file = await convertSchema1({
      ref,
      image: oldImage(),
      folder,
      signal: new AbortController().signal,
      stream,
      pullToken,
    });

    // Docker kept the repeated layer twice and the empty step not at all.
    expect(file.diffIds).toEqual([base.diffId, base.diffId, top.diffId]);
    expect(file.config).toMatchObject({
      os: 'linux',
      architecture: 'amd64',
      config: { Env: ['PYTHON_VERSION=2.7'] },
      rootfs: { type: 'layers', diff_ids: file.diffIds },
    });
    expect(
      (file.config.history as Record<string, unknown>[]).map(
        (step) => step.empty_layer ?? false,
      ),
    ).toEqual([false, false, true, false]);
    expect((file.config.history as Record<string, unknown>[])[3]).toMatchObject(
      {
        created_by: '/bin/sh -c run',
      },
    );
    expect(asked.some((call) => call.url.endsWith(empty.digest))).toBe(false);
    expect(asked.filter((call) => call.method === 'GET')).toHaveLength(2);
    expect(asked[0].url).toBe(
      `https://registry-1.docker.io/v2/training/webapp/blobs/${base.digest}`,
    );
    expect(pullToken).toHaveBeenCalledTimes(1);

    // The cleaned file reads back as the same image.
    const again = await readImageFile(fileChunks(join(folder, CLEAN_TAR)));

    expect(again.configDigest).toBe(file.configDigest);
    expect(again.diffIds).toEqual(file.diffIds);
    expect(blobFolders.some((made) => existsSync(made))).toBe(false);
  });

  it('gives the same image every time', async () => {
    const blobs = { [base.digest]: base.blob, [top.digest]: top.blob };
    const first = await convertSchema1({
      ref,
      image: oldImage(),
      folder,
      signal: new AbortController().signal,
      ...registry(blobs),
    });
    const second = await convertSchema1({
      ref,
      image: oldImage(),
      folder: await mkdtemp(join(tmpdir(), 'convert-')),
      signal: new AbortController().signal,
      ...registry(blobs),
    });

    expect(second.configDigest).toBe(first.configDigest);
  });

  it('refuses a layer with another digest, a missing layer and an image of empty steps only', async () => {
    const signal = new AbortController().signal;

    await expect(
      convertSchema1({
        ref,
        image: oldImage(),
        folder,
        signal,
        ...registry({ [base.digest]: top.blob, [top.digest]: top.blob }),
      }),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });

    await expect(
      convertSchema1({
        ref,
        image: oldImage(),
        folder: await mkdtemp(join(tmpdir(), 'convert-')),
        signal,
        ...registry({ [base.digest]: base.blob }),
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_NOT_PUBLIC' });

    await expect(
      convertSchema1({
        ref,
        image: {
          ...oldImage(),
          layers: [{ digest: empty.digest, throwaway: true, history: {} }],
        },
        folder,
        signal,
        ...registry({}),
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_FILE_INVALID' });
  });

  it('hands the image back when the disk has no room, before downloading anything', async () => {
    const { stream, pullToken, asked } = registry({
      [base.digest]: base.blob,
      [top.digest]: top.blob,
    });

    room.mockResolvedValue(false);

    await expect(
      convertSchema1({
        ref,
        image: oldImage(),
        folder,
        signal: new AbortController().signal,
        stream,
        pullToken,
      }),
    ).rejects.toThrow('Not enough free disk');
    expect(asked.some((call) => call.method === 'GET')).toBe(false);
  });

  it('stops when the check is stopped', async () => {
    const controller = new AbortController();

    controller.abort();

    await expect(
      convertSchema1({
        ref,
        image: oldImage(),
        folder,
        signal: controller.signal,
        ...registry({}),
      }),
    ).rejects.toThrow();
  });
});
