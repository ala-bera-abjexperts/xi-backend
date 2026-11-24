import { existsSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { SupabaseAdminService } from '../../../../supabase/supabase-admin.service';
import { ImageFileError, type ImageFile } from '../../image-file/tar/image-tar';
import {
  hasRoomForUpload,
  loadUploadedImage,
  LoadMachineProblem,
  readUploadedImage,
  uploadFolder,
} from '../../image-file/load/load-upload';
import type { ScanResult } from '../scanner/custom-image-scanner';
import {
  CustomImageReviewer,
  type LeasedCustomImage,
} from './custom-image-reviewer';

jest.mock('../../image-file/load/load-upload', () => ({
  ...jest.requireActual<typeof import('../../image-file/load/load-upload')>(
    '../../image-file/load/load-upload',
  ),
  hasRoomForUpload: jest.fn(),
  readUploadedImage: jest.fn(),
  loadUploadedImage: jest.fn(),
  uploadFolder: jest.fn(),
}));

const ORG = 'org-1';
const WORKER = 'host-1-review-1';
const HEX = 'e'.repeat(64);
const DIGEST = `sha256:${HEX}`;
const TAG = `xis-tm-upload:${HEX}`;
const LAYER = `sha256:${'1'.repeat(64)}`;

const room = hasRoomForUpload as unknown as jest.Mock;
const read = readUploadedImage as unknown as jest.Mock;
const load = loadUploadedImage as unknown as jest.Mock;
const folderFor = uploadFolder as unknown as jest.Mock;

interface Call {
  ops: [string, unknown[]][];
}

const patchOf = (call: Call) =>
  call.ops.find(([op]) => op === 'update')?.[1][0] as
    | Record<string, unknown>
    | undefined;

function leased(overrides: Partial<LeasedCustomImage> = {}): LeasedCustomImage {
  return {
    id: 'image-1',
    organization_id: ORG,
    registry: 'upload',
    attempts: 1,
    run_ref: null as unknown as string,
    platform: 'linux/amd64',
    language: 'python',
    test_framework: 'pytest',
    pulled_by_runner: false,
    digest: DIGEST,
    size_bytes: 1000,
    ...overrides,
  };
}

function fileOf(config: Record<string, unknown> = {}): ImageFile {
  return {
    configDigest: DIGEST,
    config: {
      os: 'linux',
      architecture: 'amd64',
      config: { Labels: {} },
      rootfs: { diff_ids: [LAYER] },
      ...config,
    },
    diffIds: [LAYER],
    configBytes: 100,
    layerBytes: [1000],
    unpackedBytes: 2000,
  };
}

const scanOf = (overrides: Partial<ScanResult> = {}): ScanResult => ({
  scanner: 'trivy',
  packages: new Set(['pytest']),
  systemPackages: new Set(),
  critical: 0,
  high: 0,
  secrets: [],
  ...overrides,
});

describe('CustomImageReviewer with an uploaded image', () => {
  const saved = {
    platform: process.env.TM_RUNNER_PLATFORM,
    scanner: process.env.TM_RUNNER_SCANNER,
  };
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
    patchOf(calls.find((call) => patchOf(call)?.checked_at !== undefined)!);

  beforeEach(async () => {
    process.env.TM_RUNNER_PLATFORM = 'linux/amd64';
    delete process.env.TM_RUNNER_SCANNER;
    calls = [];
    folder = await mkdtemp(join(tmpdir(), 'upload-'));
    rpc = jest.fn().mockResolvedValue({ data: [leased()], error: null });
    docker = {
      platform: jest.fn().mockResolvedValue('linux/amd64'),
      imagePresent: jest.fn(),
      pullAnonymous: jest.fn(),
      inspectImage: jest.fn(),
      removeImage: jest.fn().mockResolvedValue(undefined),
      removeScannerLeftovers: jest.fn(),
    };
    scan = jest.fn().mockResolvedValue(scanOf());
    room.mockReset().mockResolvedValue(true);
    read.mockReset().mockResolvedValue(fileOf());
    load.mockReset().mockResolvedValue(undefined);
    folderFor.mockReset().mockResolvedValue(folder);
  });

  afterAll(() => {
    for (const [name, value] of [
      ['TM_RUNNER_PLATFORM', saved.platform],
      ['TM_RUNNER_SCANNER', saved.scanner],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('reads, scans and loads the file, approves it and removes the loaded image', async () => {
    await expect(reviewer().processNext(WORKER)).resolves.toBe(true);

    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      { organization_id: ORG, digest: DIGEST },
      folder,
      expect.any(AbortSignal),
      expect.any(Function),
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
      worker_id: null,
    });
    expect(docker.removeImage).toHaveBeenCalledWith(TAG);
    expect(docker.pullAnonymous).not.toHaveBeenCalled();
    expect(existsSync(folder)).toBe(false);

    const sharedCheck = calls.find((call) =>
      call.ops.some(([op]) => op === 'not'),
    )!;

    expect(sharedCheck.ops).toContainEqual(['eq', ['digest', DIGEST]]);
  });

  it('refuses a file whose labels, volumes or platform break the rules, without loading it', async () => {
    read.mockResolvedValue(
      fileOf({
        architecture: 'arm64',
        config: {
          Labels: {
            'xisuite.language': 'ruby',
            'xisuite.test-framework': 'rspec',
          },
          Volumes: { '/data': {} },
        },
      }),
    );

    await reviewer().processNext(WORKER);

    const saved = finalSave()!;

    expect(saved.status).toBe('refused');
    expect(
      (saved.findings as { code: string }[]).map((item) => item.code),
    ).toEqual([
      'IMAGE_WRONG_PLATFORM',
      'IMAGE_HAS_VOLUMES',
      'IMAGE_BAD_LABELS',
    ]);
    expect(scan).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('refuses for good when the file itself is wrong or gone', async () => {
    read.mockRejectedValueOnce(
      new ImageFileError('UPLOAD_MISSING', 'The uploaded file is gone'),
    );

    await reviewer().processNext(WORKER);

    expect(finalSave()).toMatchObject({
      status: 'refused',
      error_code: 'UPLOAD_MISSING',
      findings: [
        { code: 'UPLOAD_MISSING', detail: 'The uploaded file is gone' },
      ],
    });
    expect(existsSync(folder)).toBe(false);
  });

  it('refuses when Docker holds other layers, and the name is removed', async () => {
    load.mockRejectedValueOnce(
      new ImageFileError('DIGEST_MISMATCH', 'other layers'),
    );

    await reviewer().processNext(WORKER);

    expect(finalSave()).toMatchObject({ error_code: 'DIGEST_MISMATCH' });
  });

  it('hands the image back on a machine problem and tries later on others', async () => {
    load.mockRejectedValueOnce(
      new LoadMachineProblem('no space left on device'),
    );
    await reviewer().processNext(WORKER);
    expect(calls.some((call) => patchOf(call)?.attempts === 0)).toBe(true);
    expect(finalSave).toThrow();

    calls = [];
    read.mockRejectedValueOnce(new Error('connection reset'));
    await reviewer().processNext(WORKER);
    expect(
      calls.some(
        (call) =>
          patchOf(call)?.lease_until && patchOf(call)?.attempts === undefined,
      ),
    ).toBe(true);
  });

  it('approves a clean uploaded file, even without a scanner', async () => {
    const withoutScan = new CustomImageReviewer(
      docker as never,
      { getClient: () => ({ rpc, from }) } as unknown as SupabaseAdminService,
      null,
    );

    await withoutScan.processNext(WORKER);

    expect(finalSave()).toMatchObject({ status: 'approved' });
    expect(load).toHaveBeenCalled();
  });
});
