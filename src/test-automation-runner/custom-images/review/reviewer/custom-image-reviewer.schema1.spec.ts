import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { SupabaseAdminService } from '../../../../supabase/supabase-admin.service';
import {
  fetchSchema1Manifest,
  UserImageError,
  type Schema1Image,
} from '../../../../test-management/automation/custom-images/registry/custom-image-review';
import { ImageFileError, type ImageFile } from '../../image-file/tar/image-tar';
import {
  loadUploadedImage,
  uploadFolder,
} from '../../image-file/load/load-upload';
import { convertSchema1 } from '../../legacy/schema1-image';
import type { ScanResult } from '../scanner/custom-image-scanner';
import {
  CustomImageReviewer,
  type LeasedCustomImage,
} from './custom-image-reviewer';

jest.mock('../../image-file/load/load-upload', () => ({
  ...jest.requireActual<typeof import('../../image-file/load/load-upload')>(
    '../../image-file/load/load-upload',
  ),
  loadUploadedImage: jest.fn(),
  uploadFolder: jest.fn(),
}));
jest.mock('../../legacy/schema1-image', () => ({
  convertSchema1: jest.fn(),
}));
jest.mock(
  '../../../../test-management/automation/custom-images/registry/custom-image-review',
  () => ({
    ...jest.requireActual<
      typeof import('../../../../test-management/automation/custom-images/registry/custom-image-review')
    >(
      '../../../../test-management/automation/custom-images/registry/custom-image-review',
    ),
    fetchSchema1Manifest: jest.fn(),
  }),
);

const ORG = 'org-1';
const WORKER = 'host-1-review-1';
const HEX = 'a'.repeat(64);
const RUN_REF = `docker.io/training/webapp@sha256:${HEX}`;
const TAG = `xis-tm-upload:${HEX}`;
const LAYER = `sha256:${'1'.repeat(64)}`;
// What Docker 29 prints for an image in the old format.
const OLD_FORMAT_PULL =
  '[DEPRECATION NOTICE] Docker Image Format v1 and Docker Image manifest version 2, schema 1 support has been removed.';

const load = loadUploadedImage as unknown as jest.Mock;
const folderFor = uploadFolder as unknown as jest.Mock;
const convert = convertSchema1 as unknown as jest.Mock;
const lookup = fetchSchema1Manifest as unknown as jest.Mock;

interface Call {
  ops: [string, unknown[]][];
}

const patchOf = (call: Call) =>
  call.ops.find(([op]) => op === 'update')?.[1][0] as
    | Record<string, unknown>
    | undefined;

function leased(): LeasedCustomImage {
  return {
    id: 'image-1',
    organization_id: ORG,
    registry: 'docker.io',
    attempts: 1,
    run_ref: RUN_REF,
    platform: 'linux/amd64',
    language: 'python',
    test_framework: 'pytest',
    pulled_by_runner: false,
    digest: `sha256:${HEX}`,
    size_bytes: null,
  };
}

const oldImage: Schema1Image = {
  config: { os: 'linux', architecture: 'amd64' },
  layers: [{ digest: LAYER, throwaway: false, history: {} }],
};

function fileOf(config: Record<string, unknown> = {}): ImageFile {
  return {
    configDigest: `sha256:${'c'.repeat(64)}`,
    config: {
      os: 'linux',
      architecture: 'amd64',
      config: {},
      rootfs: { diff_ids: [LAYER] },
      ...config,
    },
    diffIds: [LAYER],
    configBytes: 100,
    layerBytes: [1000],
    unpackedBytes: 2000,
  };
}

const scanOf = (): ScanResult => ({
  scanner: 'trivy',
  packages: new Set(['pytest']),
  systemPackages: new Set(),
  critical: 0,
  high: 0,
  secrets: [],
});

describe('CustomImageReviewer with an old schema 1 image', () => {
  const saved = process.env.TM_RUNNER_PLATFORM;
  let calls: Call[];
  let rpc: jest.Mock;
  let docker: Record<string, jest.Mock>;
  let scan: jest.Mock;
  let folder: string;

  const from = () => {
    const call: Call = { ops: [] };
    const chain: Record<string, unknown> = {};

    calls.push(call);

    for (const op of [
      'select',
      'update',
      'eq',
      'neq',
      'in',
      'not',
      'limit',
      'maybeSingle',
    ]) {
      chain[op] = (...args: unknown[]) => {
        call.ops.push([op, args]);

        return chain;
      };
    }

    chain.then = (done: (value: unknown) => unknown) =>
      Promise.resolve({ data: { id: 'image-1' }, error: null, count: 0 }).then(
        done,
      );

    return chain;
  };

  const reviewer = () =>
    new CustomImageReviewer(
      docker as never,
      { getClient: () => ({ rpc, from }) } as unknown as SupabaseAdminService,
      scan,
    );
  const finalSave = () =>
    calls
      .map(patchOf)
      .find((patch) => patch?.checked_at !== undefined && 'status' in patch);

  beforeEach(async () => {
    process.env.TM_RUNNER_PLATFORM = 'linux/amd64';
    calls = [];
    folder = await mkdtemp(join(tmpdir(), 'upload-'));
    rpc = jest.fn().mockResolvedValue({ data: [leased()], error: null });
    docker = {
      platform: jest.fn().mockResolvedValue('linux/amd64'),
      // Only the converted copy is ever on this machine.
      imagePresent: jest.fn((ref: string) => Promise.resolve(ref === TAG)),
      pullAnonymous: jest
        .fn()
        .mockResolvedValue({ code: 1, output: OLD_FORMAT_PULL }),
      inspectImage: jest.fn(),
      removeImage: jest.fn().mockResolvedValue(undefined),
      removeScannerLeftovers: jest.fn(),
    };
    scan = jest.fn().mockResolvedValue(scanOf());
    load.mockReset().mockResolvedValue(undefined);
    folderFor.mockReset().mockResolvedValue(folder);
    convert.mockReset().mockResolvedValue(fileOf());
    lookup.mockReset().mockResolvedValue(oldImage);
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.TM_RUNNER_PLATFORM;
    else process.env.TM_RUNNER_PLATFORM = saved;
  });

  it('converts the image after Docker refuses it, scans and loads it, approves it and removes the copy', async () => {
    await expect(reviewer().processNext(WORKER)).resolves.toBe(true);

    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({
        registry: 'docker.io',
        repository: 'training/webapp',
        digest: `sha256:${HEX}`,
      }),
    );
    expect(convert).toHaveBeenCalledWith(
      expect.objectContaining({ image: oldImage, folder }),
    );
    expect(scan).toHaveBeenCalledWith(
      TAG,
      expect.any(AbortSignal),
      expect.any(Function),
      folder,
    );
    expect(load).toHaveBeenCalledWith(
      docker,
      folder,
      fileOf(),
      TAG,
      expect.any(AbortSignal),
    );
    expect(finalSave()).toMatchObject({
      status: 'approved',
      error_code: null,
      size_bytes: 1100,
    });
    expect(docker.inspectImage).not.toHaveBeenCalled();
    expect(docker.removeImage).toHaveBeenCalledWith(TAG);
  });

  it('keeps the current answer when the image is not in the old format', async () => {
    lookup.mockResolvedValue(null);

    await reviewer().processNext(WORKER);

    expect(convert).not.toHaveBeenCalled();
    expect(finalSave()?.status).toBeUndefined();
  });

  it('does not look at the format when the machine itself could not pull', async () => {
    docker.pullAnonymous.mockResolvedValue({
      code: 1,
      output: 'no space left on device',
    });

    await reviewer().processNext(WORKER);

    expect(lookup).not.toHaveBeenCalled();
    expect(convert).not.toHaveBeenCalled();
  });

  it('refuses an image whose layers are gone or damaged, and never loads it', async () => {
    convert.mockRejectedValueOnce(
      new UserImageError('IMAGE_NOT_PUBLIC', 'A layer was not found'),
    );
    await reviewer().processNext(WORKER);
    expect(finalSave()).toMatchObject({
      status: 'refused',
      error_code: 'IMAGE_PULL_FAILED',
    });

    calls = [];
    convert.mockRejectedValueOnce(
      new ImageFileError('DIGEST_MISMATCH', 'A layer has another digest'),
    );
    await reviewer().processNext(WORKER);
    expect(finalSave()).toMatchObject({
      status: 'refused',
      error_code: 'DIGEST_MISMATCH',
    });
    expect(load).not.toHaveBeenCalled();
  });

  it('refuses a converted image for another chip type before it reaches Docker', async () => {
    convert.mockResolvedValue(fileOf({ architecture: 'arm64' }));

    await reviewer().processNext(WORKER);

    expect(finalSave()).toMatchObject({
      status: 'refused',
      error_code: 'IMAGE_WRONG_PLATFORM',
    });
    expect(scan).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});
