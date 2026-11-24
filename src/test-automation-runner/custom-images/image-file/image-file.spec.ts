import { createHash } from 'crypto';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'zlib';

import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { DockerDriver, type DockerExec } from '../../docker-driver';
import { CustomImageDocker } from '../docker/custom-image-docker';
import { TryLater } from '../review/scanner/custom-image-scanner';
import { TAR_END, tarFile } from './tar/clean-tar';
import { ImageFileError, readImageFile, type ImageFile } from './tar/image-tar';
import {
  CLEAN_TAR,
  loadUploadedImage,
  LoadMachineProblem,
  readUploadedImage,
  uploadRunTag,
} from './load/load-upload';

type Json = Record<string, unknown>;

const sha = (content: Buffer) =>
  createHash('sha256').update(content).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const tar = (files: [string, Buffer][]) =>
  Buffer.concat([...files.map(([name, body]) => tarFile(name, body)), TAR_END]);

const LAYER = tar([['hello.txt', Buffer.from('hi')]]);
const LAYER_HEX = sha(LAYER);

function configOf(overrides: Json = {}): Buffer {
  return json({
    architecture: 'amd64',
    os: 'linux',
    config: { Labels: { 'xisuite.language': 'python' } },
    rootfs: { type: 'layers', diff_ids: [`sha256:${LAYER_HEX}`] },
    ...overrides,
  });
}

const CONFIG = configOf();
const CONFIG_HEX = sha(CONFIG);
const DIGEST = `sha256:${CONFIG_HEX}`;

function ociFile(
  options: {
    config?: Buffer;
    manifest?: Json[];
    extraIndex?: Json[];
    layer?: Buffer;
  } = {},
): Buffer {
  const config = options.config ?? CONFIG;
  const configHex = sha(config);
  const image = json({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: `sha256:${configHex}`, size: config.length },
    layers: [{ digest: `sha256:${LAYER_HEX}`, size: LAYER.length }],
  });
  const imageHex = sha(image);

  return tar([
    [`blobs/sha256/${LAYER_HEX}`, options.layer ?? LAYER],
    [`blobs/sha256/${configHex}`, config],
    [`blobs/sha256/${imageHex}`, image],
    [
      'index.json',
      json({
        schemaVersion: 2,
        manifests: [
          {
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            digest: `sha256:${imageHex}`,
            annotations: {
              'io.containerd.image.name':
                'docker.io/library/xis-tm-runner-node:latest',
              'org.opencontainers.image.ref.name': 'latest',
              'org.example.kept': 'yes',
            },
          },
          {
            digest: `sha256:${'d'.repeat(64)}`,
            annotations: {
              'vnd.docker.reference.type': 'attestation-manifest',
            },
          },
          ...(options.extraIndex ?? []),
        ],
      }),
    ],
    [
      'manifest.json',
      json(
        options.manifest ?? [
          {
            Config: `blobs/sha256/${configHex}`,
            RepoTags: ['xis-tm-runner-node:latest'],
            Layers: [`blobs/sha256/${LAYER_HEX}`],
          },
        ],
      ),
    ],
    ['oci-layout', json({ imageLayoutVersion: '1.0.0' })],
    ['repositories', json({ 'xis-tm-runner-node': { latest: LAYER_HEX } })],
  ]);
}

/** The old layout, with a second layer stored as a link to the first. */
function classicFile(): Buffer {
  const config = configOf({
    rootfs: {
      type: 'layers',
      diff_ids: [`sha256:${LAYER_HEX}`, `sha256:${LAYER_HEX}`],
    },
  });
  const configHex = sha(config);
  const link = tarFile('b1/layer.tar', Buffer.alloc(0));

  // A symlink header: type 2 with its target.
  link.write('2', 156, 'ascii');
  link.write('../a1/layer.tar', 157, 'ascii');
  link.write(' '.repeat(8), 148, 'ascii');
  link.write(
    `${link
      .subarray(0, 512)
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0')}\0 `,
    148,
    'ascii',
  );

  return Buffer.concat([
    tarFile('a1/layer.tar', LAYER),
    tarFile('a1/json', json({ id: 'a1' })),
    link,
    tarFile(`${configHex}.json`, config),
    tarFile(
      'manifest.json',
      json([
        {
          Config: `${configHex}.json`,
          RepoTags: ['tests:latest'],
          Layers: ['a1/layer.tar', 'b1/layer.tar'],
        },
      ]),
    ),
    tarFile('repositories', json({ tests: { latest: 'a1' } })),
    TAR_END,
  ]);
}

async function* chunks(file: Buffer, size = 4096): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < file.length; offset += size) {
    yield await Promise.resolve(file.subarray(offset, offset + size));
  }
}

async function readWithCopy(
  file: Buffer,
  size?: number,
): Promise<{ result: ImageFile; copy: Buffer }> {
  const pieces: Buffer[] = [];
  const result = await readImageFile(chunks(file, size), (chunk) => {
    pieces.push(Buffer.from(chunk));

    return Promise.resolve();
  });

  return { result, copy: Buffer.concat(pieces) };
}

/** The files inside a plain tar, for checking the cleaned copy. */
function entriesOf(file: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 512 <= file.length && file[offset] !== 0) {
    const header = file.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii'), 8);

    entries.set(name, file.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return entries;
}

const refusal = (code: string) =>
  expect.objectContaining({ code }) as unknown as ImageFileError;

describe('readImageFile', () => {
  it('reads an OCI docker save file and writes a copy without image names', async () => {
    const { result, copy } = await readWithCopy(ociFile(), 7);

    expect(result).toMatchObject({
      configDigest: DIGEST,
      diffIds: [`sha256:${LAYER_HEX}`],
      layerBytes: [LAYER.length],
      configBytes: CONFIG.length,
    });

    const entries = entriesOf(copy);

    expect(entries.has('repositories')).toBe(false);
    expect(entries.get(`blobs/sha256/${LAYER_HEX}`)).toEqual(LAYER);
    expect(JSON.parse(entries.get('manifest.json')!.toString())).toEqual([
      {
        Config: `blobs/sha256/${CONFIG_HEX}`,
        Layers: [`blobs/sha256/${LAYER_HEX}`],
      },
    ]);

    const index = JSON.parse(entries.get('index.json')!.toString()) as {
      manifests: Json[];
    };

    expect(index.manifests).toHaveLength(1);
    expect(index.manifests[0].annotations).toEqual({
      'org.example.kept': 'yes',
    });

    // The copy is itself a valid file of the same image.
    await expect(readImageFile(chunks(copy))).resolves.toMatchObject({
      configDigest: DIGEST,
    });
  });

  it('reads a gzipped file', async () => {
    await expect(
      readImageFile(chunks(gzipSync(ociFile()), 100)),
    ).resolves.toMatchObject({ configDigest: DIGEST });
  });

  it('reads a Docker Desktop file whose attestation names only its image', async () => {
    await expect(
      readImageFile(
        chunks(
          ociFile({
            extraIndex: [
              {
                digest: `sha256:${'e'.repeat(64)}`,
                annotations: { 'io.containerd.manifest.subject': DIGEST },
              },
            ],
          }),
        ),
      ),
    ).resolves.toMatchObject({ configDigest: DIGEST });
  });

  it('reads the classic layout, with a layer stored as a link', async () => {
    const { result, copy } = await readWithCopy(classicFile());

    expect(result.layerBytes).toEqual([LAYER.length, LAYER.length]);
    expect(entriesOf(copy).has('repositories')).toBe(false);
    expect(
      JSON.parse(entriesOf(copy).get('manifest.json')!.toString()),
    ).toEqual([
      {
        Config: expect.any(String) as string,
        Layers: ['a1/layer.tar', 'b1/layer.tar'],
      },
    ]);
  });

  it('refuses a file without manifest.json', async () => {
    await expect(
      readImageFile(chunks(tar([['hello.txt', Buffer.from('hi')]]))),
    ).rejects.toEqual(refusal('IMAGE_FILE_INVALID'));
  });

  it('refuses a file with more than one image', async () => {
    const entry = {
      Config: `blobs/sha256/${CONFIG_HEX}`,
      Layers: [`blobs/sha256/${LAYER_HEX}`],
    };

    await expect(
      readImageFile(chunks(ociFile({ manifest: [entry, entry] }))),
    ).rejects.toEqual(refusal('IMAGE_FILE_NOT_ONE'));
    await expect(
      readImageFile(
        chunks(
          ociFile({
            extraIndex: [{ digest: `sha256:${'e'.repeat(64)}` }],
          }),
        ),
      ),
    ).rejects.toEqual(refusal('IMAGE_FILE_NOT_ONE'));
  });

  it('refuses a blob whose content does not match its digest', async () => {
    const changed = Buffer.from(LAYER);

    changed[600] = 0x41;

    await expect(
      readImageFile(chunks(ociFile({ layer: changed }))),
    ).rejects.toEqual(refusal('DIGEST_MISMATCH'));
  });

  it('refuses when manifest.json and index.json name different images', async () => {
    const other = configOf({ os: 'windows' });

    await expect(
      readImageFile(
        chunks(
          Buffer.concat([
            ociFile().subarray(0, -1024),
            tarFile(`blobs/sha256/${sha(other)}`, other),
            TAR_END,
          ]),
        ),
      ),
    ).resolves.toBeDefined();

    // manifest.json points at another settings file than the image in index.json.
    const file = ociFile({
      manifest: [
        {
          Config: `blobs/sha256/${sha(other)}`,
          Layers: [`blobs/sha256/${LAYER_HEX}`],
        },
      ],
    });

    await expect(
      readImageFile(
        chunks(
          Buffer.concat([
            file.subarray(0, -1024),
            tarFile(`blobs/sha256/${sha(other)}`, other),
            TAR_END,
          ]),
        ),
      ),
    ).rejects.toEqual(refusal('IMAGE_FILE_INVALID'));
  });

  it('refuses a file that is too large unpacked, or cut short', async () => {
    await expect(
      readImageFile(chunks(ociFile()), undefined, 1024),
    ).rejects.toEqual(refusal('IMAGE_TOO_LARGE'));
    await expect(
      readImageFile(chunks(ociFile().subarray(0, 3000))),
    ).rejects.toEqual(refusal('IMAGE_FILE_INVALID'));
  });

  it('refuses names that leave the archive', async () => {
    await expect(
      readImageFile(chunks(tar([['../evil', Buffer.from('x')]]))),
    ).rejects.toEqual(refusal('IMAGE_FILE_INVALID'));
  });
});

describe('uploaded image files', () => {
  let folder: string;

  const clientWith = (answer: { data: unknown; error: unknown }) => {
    const download = jest.fn(() => ({
      asStream: () => Promise.resolve(answer),
    }));
    const storage = { from: jest.fn(() => ({ download })) };

    return {
      client: { storage } as unknown as ReturnType<
        SupabaseAdminService['getClient']
      >,
      storage,
      download,
    };
  };

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'xis-upload-test-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('streams the stored file into a cleaned copy and checks its digest', async () => {
    const file = ociFile();
    const { client, storage, download } = clientWith({
      data: new Blob([new Uint8Array(file)]).stream(),
      error: null,
    });
    const seen: number[] = [];

    await expect(
      readUploadedImage(
        client,
        { organization_id: 'org-1', digest: DIGEST },
        folder,
        new AbortController().signal,
        (bytes) => seen.push(bytes),
      ),
    ).resolves.toMatchObject({ configDigest: DIGEST });
    expect(storage.from).toHaveBeenCalledWith('test-automation-images');
    expect(download).toHaveBeenCalledWith(
      `org-1/${CONFIG_HEX}`,
      {},
      { signal: expect.any(AbortSignal) as AbortSignal },
    );
    expect(seen.at(-1)).toBe(file.length);

    const copy = await readFile(join(folder, CLEAN_TAR));

    expect(entriesOf(copy).has('repositories')).toBe(false);
  });

  it('refuses a file of another image than the row names', async () => {
    const { client } = clientWith({
      data: new Blob([new Uint8Array(ociFile())]).stream(),
      error: null,
    });

    await expect(
      readUploadedImage(
        client,
        { organization_id: 'org-1', digest: `sha256:${'f'.repeat(64)}` },
        folder,
        new AbortController().signal,
      ),
    ).rejects.toEqual(refusal('DIGEST_MISMATCH'));
  });

  it('says when the stored file is gone, and tries later on other errors', async () => {
    const gone = clientWith({
      data: null,
      error: { message: 'Object not found', statusCode: '404' },
    });
    const down = clientWith({ data: null, error: { message: 'timeout' } });
    const image = { organization_id: 'org-1', digest: DIGEST };
    const { signal } = new AbortController();

    await expect(
      readUploadedImage(gone.client, image, folder, signal),
    ).rejects.toEqual(refusal('UPLOAD_MISSING'));
    await expect(
      readUploadedImage(down.client, image, folder, signal),
    ).rejects.toBeInstanceOf(TryLater);
  });

  describe('loadUploadedImage', () => {
    const tag = uploadRunTag(DIGEST);
    const file = { diffIds: [`sha256:${LAYER_HEX}`] } as ImageFile;
    let docker: Record<string, jest.Mock>;

    beforeEach(() => {
      docker = {
        loadImage: jest.fn().mockResolvedValue({
          code: 0,
          output: '',
          loaded: [`sha256:${'1'.repeat(64)}`],
        }),
        tagImage: jest.fn().mockResolvedValue(true),
        imageLayers: jest.fn().mockResolvedValue([`sha256:${LAYER_HEX}`]),
        removeImage: jest.fn().mockResolvedValue(undefined),
      };
    });

    const load = () =>
      loadUploadedImage(
        docker as never,
        folder,
        file,
        tag,
        new AbortController().signal,
      );

    it('loads, names and checks the layers', async () => {
      await expect(load()).resolves.toBeUndefined();
      expect(docker.loadImage).toHaveBeenCalledWith(
        join(folder, CLEAN_TAR),
        expect.any(AbortSignal),
      );
      expect(docker.tagImage).toHaveBeenCalledWith(
        `sha256:${'1'.repeat(64)}`,
        `xis-tm-upload:${CONFIG_HEX}`,
      );
      expect(docker.removeImage).not.toHaveBeenCalled();
    });

    it('removes the name again when Docker holds other layers', async () => {
      docker.imageLayers.mockResolvedValue([`sha256:${'2'.repeat(64)}`]);

      await expect(load()).rejects.toEqual(refusal('DIGEST_MISMATCH'));
      expect(docker.removeImage).toHaveBeenCalledWith(tag);
    });

    it('refuses more than one loaded image and hands back machine problems', async () => {
      docker.loadImage.mockResolvedValueOnce({
        code: 0,
        output: '',
        loaded: ['a', 'b'],
      });
      await expect(load()).rejects.toEqual(refusal('IMAGE_FILE_NOT_ONE'));

      docker.loadImage.mockResolvedValueOnce({
        code: 1,
        output: 'no space left on device',
        loaded: [],
      });
      await expect(load()).rejects.toBeInstanceOf(LoadMachineProblem);
      expect(docker.tagImage).not.toHaveBeenCalled();
    });
  });
});

describe('Docker commands for uploaded images', () => {
  const tag = `xis-tm-upload:${'a'.repeat(64)}`;

  it('loads a file, reads what was loaded and names it', async () => {
    const exec = jest.fn().mockResolvedValue({
      code: 0,
      output: `Loaded image ID: sha256:${'b'.repeat(64)}\n`,
    });
    const docker = new CustomImageDocker(exec as unknown as DockerExec);

    await expect(
      docker.loadImage(
        '/work/scans/upload-1/image.tar',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ loaded: [`sha256:${'b'.repeat(64)}`] });
    expect(exec).toHaveBeenCalledWith(
      ['load', '--quiet', '--input', '/work/scans/upload-1/image.tar'],
      expect.any(AbortSignal),
    );

    await expect(
      docker.tagImage(`sha256:${'b'.repeat(64)}`, tag),
    ).resolves.toBe(true);
    await expect(docker.tagImage('--force', tag)).rejects.toThrow();
    await expect(
      docker.tagImage(`sha256:${'b'.repeat(64)}`, 'xis-tm-runner-node:latest'),
    ).rejects.toThrow();
    await expect(
      docker.loadImage('image.tar', new AbortController().signal),
    ).rejects.toThrow();
  });

  it('reads the layers of an uploaded image and accepts its name elsewhere', async () => {
    const exec = jest
      .fn()
      .mockResolvedValue({ code: 0, output: '["sha256:1","sha256:2"]' });
    const docker = new CustomImageDocker(exec as unknown as DockerExec);

    await expect(docker.imageLayers(tag)).resolves.toEqual([
      'sha256:1',
      'sha256:2',
    ]);
    await expect(docker.imagePresent(tag)).resolves.toBe(true);
    await expect(docker.imagePresent('xis-tm-upload:latest')).rejects.toThrow();
  });

  it('lets a test run use an uploaded image, never pulled', async () => {
    const envFolder = await mkdtemp(join(tmpdir(), 'xis-upload-env-'));
    const calls: string[][] = [];
    const exec = ((args: string[]) => {
      calls.push(args);

      return Promise.resolve({ code: 0, output: '' });
    }) as DockerExec;

    try {
      await new DockerDriver(exec).runTests({
        runId: '11111111-1111-4111-8111-111111111111',
        image: tag,
        runFolder: '/runs/one',
        envFolder,
        workDir: null,
        command: 'pytest',
        env: {},
        userImage: true,
      });
    } finally {
      await rm(envFolder, { recursive: true, force: true });
    }

    const run = calls.find((args) => args.includes(tag))!;

    expect(run).toEqual(expect.arrayContaining(['--pull', 'never']));
    await expect(
      new DockerDriver(exec).runTests({
        runId: '11111111-1111-4111-8111-111111111111',
        image: 'xis-tm-upload:latest',
        runFolder: '/runs/one',
        envFolder,
        workDir: null,
        command: 'pytest',
        env: {},
      }),
    ).rejects.toThrow('pinned');
  });

  it('names an uploaded image only by a valid digest', () => {
    expect(uploadRunTag(`sha256:${'a'.repeat(64)}`)).toBe(tag);
    expect(() => uploadRunTag('sha256:xyz')).toThrow(ImageFileError);
  });
});
