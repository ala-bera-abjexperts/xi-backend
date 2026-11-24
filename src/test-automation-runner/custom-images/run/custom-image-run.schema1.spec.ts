import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import {
  fetchSchema1Manifest,
  UserImageError,
  type Schema1Image,
} from '../../../test-management/automation/custom-images/registry/custom-image-review';
import { ImageFileError } from '../image-file/tar/image-tar';
import {
  loadUploadedImage,
  uploadFolder,
} from '../image-file/load/load-upload';
import { convertSchema1 } from '../legacy/schema1-image';
import { customImageForRun } from './custom-image-run';

jest.mock('../image-file/load/load-upload', () => ({
  ...jest.requireActual<typeof import('../image-file/load/load-upload')>(
    '../image-file/load/load-upload',
  ),
  loadUploadedImage: jest.fn(),
  uploadFolder: jest.fn(),
}));
jest.mock('../legacy/schema1-image', () => ({ convertSchema1: jest.fn() }));
jest.mock(
  '../../../test-management/automation/custom-images/registry/custom-image-review',
  () => ({
    ...jest.requireActual<
      typeof import('../../../test-management/automation/custom-images/registry/custom-image-review')
    >(
      '../../../test-management/automation/custom-images/registry/custom-image-review',
    ),
    fetchSchema1Manifest: jest.fn(),
  }),
);

const ORG = 'org-1';
const HEX = 'b'.repeat(64);
const REF = `docker.io/training/webapp@sha256:${HEX}`;
const TAG = `xis-tm-upload:${HEX}`;
const OLD_FORMAT_PULL =
  '[DEPRECATION NOTICE] Docker Image Format v1 and Docker Image manifest version 2, schema 1 support has been removed.';

const load = loadUploadedImage as unknown as jest.Mock;
const folderFor = uploadFolder as unknown as jest.Mock;
const convert = convertSchema1 as unknown as jest.Mock;
const lookup = fetchSchema1Manifest as unknown as jest.Mock;

const oldImage: Schema1Image = {
  config: { os: 'linux', architecture: 'amd64' },
  layers: [
    { digest: `sha256:${'1'.repeat(64)}`, throwaway: false, history: {} },
  ],
};

type Client = ReturnType<SupabaseAdminService['getClient']>;

describe('customImageForRun with an old schema 1 image', () => {
  const saved = {
    registries: process.env.TM_RUNNER_USER_REGISTRIES,
    platform: process.env.TM_RUNNER_PLATFORM,
  };
  let updates: unknown[];
  let docker: Record<string, jest.Mock>;
  let present: Set<string>;

  const client = {
    from: () => {
      const chain: Record<string, unknown> = {};

      for (const op of ['select', 'eq', 'maybeSingle']) {
        chain[op] = () => chain;
      }

      chain.update = (patch: unknown) => {
        updates.push(patch);

        return chain;
      };
      chain.then = (done: (value: unknown) => unknown) =>
        Promise.resolve({
          data: { status: 'approved', run_ref: REF, registry: 'docker.io' },
          error: null,
        }).then(done);

      return chain;
    },
  } as unknown as Client;

  const run = () =>
    customImageForRun(
      client,
      {
        organization_id: ORG,
        config_snapshot: {
          user_image_id: 'image-1',
          run_ref: REF,
          platform: 'linux/amd64',
        },
      },
      new AbortController().signal,
      docker as never,
    );

  beforeEach(() => {
    process.env.TM_RUNNER_USER_REGISTRIES = 'docker.io';
    process.env.TM_RUNNER_PLATFORM = 'linux/amd64';
    updates = [];
    present = new Set();
    docker = {
      hasRuntime: jest.fn().mockResolvedValue(true),
      imagePresent: jest.fn((ref: string) => Promise.resolve(present.has(ref))),
      pullAnonymous: jest
        .fn()
        .mockResolvedValue({ code: 1, output: OLD_FORMAT_PULL }),
    };
    folderFor
      .mockReset()
      .mockImplementation(() => mkdtemp(join(tmpdir(), 'upload-')));
    convert.mockReset().mockResolvedValue({ diffIds: [] });
    load.mockReset().mockImplementation(() => {
      present.add(TAG);

      return Promise.resolve();
    });
    lookup.mockReset().mockResolvedValue(oldImage);
  });

  afterEach(() => {
    for (const [name, value] of [
      ['TM_RUNNER_USER_REGISTRIES', saved.registries],
      ['TM_RUNNER_PLATFORM', saved.platform],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('runs the converted copy when it is already here, without a download', async () => {
    present.add(TAG);

    await expect(run()).resolves.toEqual({
      image: { key: 'own-image', image: TAG },
    });
    expect(docker.pullAnonymous).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });

  it('converts and loads it when Docker refuses the old format, then runs it', async () => {
    await expect(run()).resolves.toEqual({
      image: { key: 'own-image', image: TAG },
    });
    const [input] = convert.mock.calls[0] as [
      { ref: { repository: string }; image: Schema1Image },
    ];

    expect(input.ref.repository).toBe('training/webapp');
    expect(input.image).toBe(oldImage);
    expect(load).toHaveBeenCalledWith(
      docker,
      expect.any(String),
      { diffIds: [] },
      TAG,
      expect.any(AbortSignal),
    );
    expect(updates).toEqual([{ pulled_by_runner: true }]);
  });

  it('shares one conversion between two runs at once', async () => {
    const [first, second] = await Promise.all([run(), run()]);

    expect(first).toEqual(second);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it('keeps the current answer for an image that is not in the old format, and for a rate limit', async () => {
    lookup.mockResolvedValue(null);
    await expect(run()).resolves.toMatchObject({ code: 'IMAGE_PULL_FAILED' });

    lookup.mockClear();
    docker.pullAnonymous.mockResolvedValue({
      code: 1,
      output: 'toomanyrequests: rate limit',
    });
    await expect(run()).resolves.toMatchObject({
      code: 'REGISTRY_RATE_LIMITED',
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });

  it('says why a conversion failed', async () => {
    convert.mockRejectedValueOnce(
      new UserImageError('IMAGE_NOT_PUBLIC', 'A layer was not found'),
    );
    await expect(run()).resolves.toMatchObject({ code: 'IMAGE_PULL_FAILED' });

    convert.mockRejectedValueOnce(
      new ImageFileError('DIGEST_MISMATCH', 'A layer has another digest'),
    );
    await expect(run()).resolves.toMatchObject({ code: 'IMAGE_PULL_FAILED' });

    convert.mockRejectedValueOnce(new Error('Docker could not load'));
    await expect(run()).resolves.toMatchObject({ code: 'RUNNER_FAILED' });
    expect(updates).toEqual([]);
  });
});
