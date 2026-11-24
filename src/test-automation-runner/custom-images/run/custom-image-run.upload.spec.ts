import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { ImageFileError } from '../image-file/tar/image-tar';
import {
  LoadMachineProblem,
  prepareUploadedImage,
} from '../image-file/load/load-upload';
import { customImageForRun } from './custom-image-run';

jest.mock('../image-file/load/load-upload', () => ({
  ...jest.requireActual<typeof import('../image-file/load/load-upload')>(
    '../image-file/load/load-upload',
  ),
  prepareUploadedImage: jest.fn(),
}));

const ORG = 'org-1';
const HEX = 'c'.repeat(64);
const TAG = `xis-tm-upload:${HEX}`;
const prepare = prepareUploadedImage as unknown as jest.Mock;

type Client = ReturnType<SupabaseAdminService['getClient']>;

describe('customImageForRun with an uploaded image', () => {
  const saved = {
    uploads: process.env.TM_RUNNER_IMAGE_UPLOADS,
    registries: process.env.TM_RUNNER_USER_REGISTRIES,
    platform: process.env.TM_RUNNER_PLATFORM,
  };
  let row: Record<string, unknown> | null;
  let updates: unknown[][];
  let docker: Record<string, jest.Mock>;

  const client = {
    from: () => {
      const chain: Record<string, unknown> = {};

      for (const op of ['select', 'eq', 'maybeSingle']) {
        chain[op] = () => chain;
      }

      chain.update = (...args: unknown[]) => {
        updates.push(args);

        return chain;
      };
      chain.then = (done: (value: unknown) => unknown) =>
        Promise.resolve({ data: row, error: null }).then(done);

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
          run_ref: null,
          platform: 'linux/amd64',
        },
      },
      new AbortController().signal,
      docker as never,
    );

  beforeEach(() => {
    process.env.TM_RUNNER_IMAGE_UPLOADS = '1';
    delete process.env.TM_RUNNER_USER_REGISTRIES;
    process.env.TM_RUNNER_PLATFORM = 'linux/amd64';
    updates = [];
    row = {
      status: 'approved',
      run_ref: null,
      registry: 'upload',
      digest: `sha256:${HEX}`,
      size_bytes: 1000,
    };
    docker = {
      hasRuntime: jest.fn().mockResolvedValue(true),
      imagePresent: jest.fn().mockResolvedValue(true),
      pullAnonymous: jest.fn(),
    };
    prepare.mockReset();
    prepare.mockResolvedValue(TAG);
  });

  afterAll(() => {
    for (const [name, value] of [
      ['TM_RUNNER_IMAGE_UPLOADS', saved.uploads],
      ['TM_RUNNER_USER_REGISTRIES', saved.registries],
      ['TM_RUNNER_PLATFORM', saved.platform],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('runs the loaded image by its digest name, never pulled', async () => {
    await expect(run()).resolves.toEqual({
      image: { key: 'own-image', image: TAG },
    });
    expect(docker.imagePresent).toHaveBeenCalledWith(TAG);
    expect(prepare).not.toHaveBeenCalled();
    expect(docker.pullAnonymous).not.toHaveBeenCalled();
  });

  it('loads it again from its file when it is not here, and marks it for the clean-up', async () => {
    docker.imagePresent.mockResolvedValue(false);

    await expect(run()).resolves.toEqual({
      image: { key: 'own-image', image: TAG },
    });
    expect(prepare).toHaveBeenCalledWith(
      client,
      docker,
      { organization_id: ORG, digest: `sha256:${HEX}`, size_bytes: 1000 },
      expect.any(AbortSignal),
    );
    expect(updates).toEqual([[{ pulled_by_runner: true }]]);
  });

  it('says when the file is gone, the file is wrong or the machine cannot load it', async () => {
    docker.imagePresent.mockResolvedValue(false);

    prepare.mockRejectedValueOnce(new ImageFileError('UPLOAD_MISSING', 'gone'));
    await expect(run()).resolves.toMatchObject({ code: 'UPLOAD_MISSING' });

    prepare.mockRejectedValueOnce(new ImageFileError('DIGEST_MISMATCH', 'x'));
    await expect(run()).resolves.toMatchObject({ code: 'DIGEST_MISMATCH' });

    prepare.mockRejectedValueOnce(new LoadMachineProblem('no space'));
    await expect(run()).resolves.toMatchObject({ code: 'RUNNER_FAILED' });
    expect(updates).toEqual([]);
  });

  it('refuses while uploads are off, or when the image is not approved', async () => {
    delete process.env.TM_RUNNER_IMAGE_UPLOADS;
    await expect(run()).resolves.toMatchObject({ code: 'IMAGE_NOT_APPROVED' });

    process.env.TM_RUNNER_IMAGE_UPLOADS = '1';
    row = { ...row, status: 'blocked' };
    await expect(run()).resolves.toMatchObject({ code: 'IMAGE_BLOCKED' });
    expect(docker.imagePresent).not.toHaveBeenCalled();
  });
});
