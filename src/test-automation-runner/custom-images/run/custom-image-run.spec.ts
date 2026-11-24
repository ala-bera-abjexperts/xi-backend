import type { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import {
  customImageForRun,
  customImageRuntime,
  type CustomImageRun,
} from './custom-image-run';

const ORG = 'org-1';
const REF = `ghcr.io/team/tests@sha256:${'b'.repeat(64)}`;

type Client = ReturnType<SupabaseAdminService['getClient']>;

interface Call {
  table: string;
  ops: [string, unknown[]][];
}

describe('customImageForRun', () => {
  const saved = {
    registries: process.env.TM_RUNNER_USER_REGISTRIES,
    platform: process.env.TM_RUNNER_PLATFORM,
    runtime: process.env.TM_RUNNER_USER_RUNTIME,
  };
  let calls: Call[];
  let row: { status: string; run_ref: string | null } | null;
  let docker: Record<string, jest.Mock>;

  const client = {
    from: (table: string) => {
      const call: Call = { table, ops: [] };
      const chain: Record<string, unknown> = {};

      calls.push(call);

      for (const op of ['select', 'update', 'eq', 'maybeSingle']) {
        chain[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);

          return chain;
        };
      }

      chain.then = (done: (value: unknown) => unknown) =>
        Promise.resolve({ data: row, error: null }).then(done);

      return chain;
    },
  } as unknown as Client;

  const run = (snapshot: CustomImageRun['config_snapshot'] = {}) =>
    customImageForRun(
      client,
      {
        organization_id: ORG,
        config_snapshot: {
          user_image_id: 'image-1',
          run_ref: REF,
          platform: 'linux/amd64',
          ...snapshot,
        },
      },
      new AbortController().signal,
      docker as never,
    );

  beforeEach(() => {
    process.env.TM_RUNNER_USER_REGISTRIES = 'ghcr.io';
    process.env.TM_RUNNER_PLATFORM = 'linux/amd64';
    delete process.env.TM_RUNNER_USER_RUNTIME;
    calls = [];
    row = { status: 'approved', run_ref: REF };
    docker = {
      hasRuntime: jest.fn().mockResolvedValue(true),
      imagePresent: jest.fn().mockResolvedValue(true),
      pullAnonymous: jest.fn().mockResolvedValue({ code: 0, output: '' }),
    };
  });

  afterEach(() => {
    for (const [name, value] of [
      ['TM_RUNNER_USER_REGISTRIES', saved.registries],
      ['TM_RUNNER_PLATFORM', saved.platform],
      ['TM_RUNNER_USER_RUNTIME', saved.runtime],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('runs an approved image that is already here', async () => {
    await expect(run()).resolves.toEqual({
      image: { key: 'own-image', image: REF },
    });
    expect(calls[0].ops).toContainEqual(['eq', ['organization_id', ORG]]);
    expect(docker.pullAnonymous).not.toHaveBeenCalled();
  });

  it('refuses when own images are off or the run names no image', async () => {
    delete process.env.TM_RUNNER_USER_REGISTRIES;
    await expect(run()).resolves.toMatchObject({ code: 'IMAGE_NOT_APPROVED' });

    process.env.TM_RUNNER_USER_REGISTRIES = 'ghcr.io';
    await expect(run({ run_ref: null })).resolves.toMatchObject({
      code: 'IMAGE_NOT_APPROVED',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses an image that is blocked, still checking, gone or changed', async () => {
    row = { status: 'blocked', run_ref: REF };
    await expect(run()).resolves.toMatchObject({ code: 'IMAGE_BLOCKED' });

    row = { status: 'checking', run_ref: REF };
    await expect(run()).resolves.toMatchObject({ code: 'IMAGE_CHECKING' });

    row = null;
    await expect(run()).resolves.toMatchObject({ code: 'IMAGE_NOT_APPROVED' });

    row = { status: 'approved', run_ref: `${REF.slice(0, -1)}c` };
    await expect(run()).resolves.toMatchObject({ code: 'IMAGE_NOT_APPROVED' });
  });

  it('refuses when this machine now has another platform', async () => {
    process.env.TM_RUNNER_PLATFORM = 'linux/arm64';

    await expect(run()).resolves.toMatchObject({
      code: 'IMAGE_PLATFORM_CHANGED',
    });
  });

  it('refuses when the sandbox runtime is missing', async () => {
    process.env.TM_RUNNER_USER_RUNTIME = 'runsc';
    docker.hasRuntime.mockResolvedValue(false);

    await expect(run()).resolves.toMatchObject({ code: 'RUNTIME_MISSING' });
    expect(docker.hasRuntime).toHaveBeenCalledWith('runsc');
  });

  it('downloads a missing image and marks it for the clean-up', async () => {
    docker.imagePresent.mockResolvedValue(false);

    await expect(run()).resolves.toHaveProperty('image');
    expect(docker.pullAnonymous).toHaveBeenCalledWith(
      REF,
      'linux/amd64',
      expect.any(AbortSignal),
    );

    const marked = calls.find((call) =>
      call.ops.some(([op]) => op === 'update'),
    )!;

    expect(marked.ops).toEqual([
      ['update', [{ pulled_by_runner: true }]],
      ['eq', ['id', 'image-1']],
      ['eq', ['organization_id', ORG]],
    ]);
  });

  it('says why a download failed', async () => {
    docker.imagePresent.mockResolvedValue(false);

    for (const [output, code] of [
      ['toomanyrequests', 'REGISTRY_RATE_LIMITED'],
      ['manifest unknown', 'IMAGE_PULL_FAILED'],
      ['no space left on device', 'RUNNER_FAILED'],
    ]) {
      docker.pullAnonymous.mockResolvedValue({ code: 1, output });
      await expect(run()).resolves.toMatchObject({ code });
    }
  });
});

describe('customImageRuntime', () => {
  it('takes only a plain runtime name', () => {
    expect(customImageRuntime('runsc')).toBe('runsc');
    expect(customImageRuntime(' runsc ')).toBe('runsc');
    expect(customImageRuntime('')).toBeNull();
    expect(customImageRuntime(undefined)).toBeNull();
    expect(customImageRuntime('--privileged')).toBeNull();
  });
});
