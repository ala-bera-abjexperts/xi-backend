import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { SupabaseAdminService } from '../../../../supabase/supabase-admin.service';
import type { DockerExec } from '../../../docker-driver';
import type { CustomImageDetails } from '../../docker/custom-image-docker';
import {
  configuredScanner,
  CustomImageReviewer,
  downloadProgress,
  type LeasedCustomImage,
} from './custom-image-reviewer';
import {
  dockerTrivyScanner,
  readScan,
  scannerImage,
  type ScanResult,
} from '../scanner/custom-image-scanner';

const ORG = 'org-1';
const WORKER = 'host-1-review-1';
const REF = `ghcr.io/team/tests@sha256:${'b'.repeat(64)}`;
const TRIVY = `aquasec/trivy@sha256:${'c'.repeat(64)}`;

interface Answer {
  data?: unknown;
  error?: { code?: string; message: string } | null;
  count?: number;
}

interface Call {
  table: string;
  ops: [string, unknown[]][];
}

const opOf = (call: Call, name: string) =>
  call.ops.filter(([op]) => op === name).map(([, args]) => args);
const patchOf = (call: Call) =>
  opOf(call, 'update')[0]?.[0] as Record<string, unknown> | undefined;

function leased(overrides: Partial<LeasedCustomImage> = {}): LeasedCustomImage {
  return {
    id: 'image-1',
    organization_id: ORG,
    registry: 'ghcr.io',
    attempts: 1,
    run_ref: REF,
    platform: 'linux/amd64',
    language: 'python',
    test_framework: 'pytest',
    pulled_by_runner: false,
    ...overrides,
  };
}

function details(
  overrides: Partial<CustomImageDetails> = {},
): CustomImageDetails {
  return {
    repoDigests: [REF],
    os: 'linux',
    architecture: 'amd64',
    labels: {},
    volumes: [],
    size: 1000,
    ...overrides,
  };
}

function scanOf(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    scanner: TRIVY,
    packages: new Set(['pytest']),
    systemPackages: new Set(['bash']),
    critical: 0,
    high: 0,
    secrets: [],
    ...overrides,
  };
}

describe('CustomImageReviewer', () => {
  const saved = {
    platform: process.env.TM_RUNNER_PLATFORM,
    scanner: process.env.TM_RUNNER_SCANNER,
    nodeEnv: process.env.NODE_ENV,
  };
  let calls: Call[];
  let respond: (call: Call) => Answer;
  let rpc: jest.Mock;
  let docker: Record<string, jest.Mock>;
  let scan: jest.Mock;

  const from = (table: string) => {
    const call: Call = { table, ops: [] };
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

    chain.then = (done: (value: Answer) => unknown) =>
      Promise.resolve({ error: null, ...respond(call) }).then(done);

    return chain;
  };

  const reviewer = (withScan = true) =>
    new CustomImageReviewer(
      docker as never,
      { getClient: () => ({ rpc, from }) } as unknown as SupabaseAdminService,
      withScan ? scan : null,
    );

  const takes = (image: LeasedCustomImage) =>
    rpc.mockResolvedValueOnce({ data: [image], error: null });
  const finalSave = () =>
    calls.find((call) => patchOf(call) && 'checked_at' in patchOf(call)!);
  const removalCheck = () =>
    calls.find(
      (call) => opOf(call, 'not').length > 0 && opOf(call, 'select').length > 0,
    );

  beforeEach(() => {
    process.env.TM_RUNNER_PLATFORM = 'linux/amd64';
    process.env.TM_RUNNER_SCANNER = `docker:${TRIVY}`;
    process.env.NODE_ENV = 'test';
    calls = [];
    respond = (call) =>
      opOf(call, 'maybeSingle').length > 0
        ? { data: { id: 'image-1' } }
        : { data: [], count: 0 };
    rpc = jest.fn().mockResolvedValue({ data: [], error: null });
    docker = {
      imagePresent: jest.fn((image: string) =>
        Promise.resolve(image === TRIVY),
      ),
      pullAnonymous: jest.fn().mockResolvedValue({ code: 0, output: '' }),
      inspectImage: jest.fn().mockResolvedValue(details()),
      removeImage: jest.fn().mockResolvedValue(undefined),
      platform: jest.fn().mockResolvedValue('linux/amd64'),
      removeScannerLeftovers: jest.fn().mockResolvedValue(undefined),
    };
    scan = jest.fn().mockResolvedValue(scanOf());
  });

  afterEach(() => {
    for (const [name, value] of [
      ['TM_RUNNER_PLATFORM', saved.platform],
      ['TM_RUNNER_SCANNER', saved.scanner],
      ['NODE_ENV', saved.nodeEnv],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  describe('readiness', () => {
    it('is ready with the right platform and the scanner image here', async () => {
      await expect(reviewer().readiness()).resolves.toBeNull();
    });

    it('names a platform that differs from TM_RUNNER_PLATFORM', async () => {
      docker.platform.mockResolvedValue('linux/arm64');

      await expect(reviewer().readiness()).resolves.toContain(
        'TM_RUNNER_PLATFORM',
      );
    });

    it('needs the scanner image pinned and on this machine', async () => {
      process.env.TM_RUNNER_SCANNER = 'docker:aquasec/trivy:latest';
      await expect(reviewer().readiness()).resolves.toContain('by digest');

      process.env.TM_RUNNER_SCANNER = '/usr/bin/trivy';
      await expect(reviewer().readiness()).resolves.toContain('by digest');

      process.env.TM_RUNNER_SCANNER = `docker:${TRIVY}`;
      docker.imagePresent.mockResolvedValue(false);
      await expect(reviewer().readiness()).resolves.toContain(
        'not on this machine',
      );
    });

    it('needs a scanner in production only', async () => {
      delete process.env.TM_RUNNER_SCANNER;
      await expect(reviewer(false).readiness()).resolves.toBeNull();

      process.env.NODE_ENV = 'production';
      await expect(reviewer(false).readiness()).resolves.toContain(
        'SCANNER_MISSING',
      );
    });
  });

  describe('processNext', () => {
    it('asks again before every lease and takes nothing while not ready', async () => {
      const checker = reviewer();

      docker.platform.mockResolvedValueOnce('linux/arm64');
      await expect(checker.processNext(WORKER)).resolves.toBe(false);
      expect(rpc).not.toHaveBeenCalled();

      await expect(checker.processNext(WORKER)).resolves.toBe(false);
      expect(rpc).toHaveBeenCalledWith('tm_lease_user_image_review', {
        p_worker_id: WORKER,
        p_lease_seconds: 1800,
      });
      expect(docker.platform).toHaveBeenCalledTimes(2);
    });

    it('stops taking images when the scanner image goes away', async () => {
      const checker = reviewer();

      await checker.processNext(WORKER);
      docker.imagePresent.mockResolvedValue(false);
      await checker.processNext(WORKER);

      expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('answers false when the lease fails', async () => {
      rpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } });

      await expect(reviewer().processNext(WORKER)).resolves.toBe(false);
    });

    it('approves a clean image of a known framework and saves only while it still holds it', async () => {
      takes(leased());

      await expect(reviewer().processNext(WORKER)).resolves.toBe(true);

      const save = finalSave()!;

      expect(patchOf(save)).toMatchObject({
        status: 'approved',
        error_code: null,
        findings: [],
        size_bytes: 1000,
        progress: {},
        worker_id: null,
        lease_until: null,
      });
      expect(opOf(save, 'eq')).toEqual([
        ['id', 'image-1'],
        ['organization_id', ORG],
        ['status', 'checking'],
        ['worker_id', WORKER],
      ]);
      expect(docker.pullAnonymous).toHaveBeenCalledWith(
        REF,
        'linux/amd64',
        expect.any(AbortSignal),
        expect.any(Function),
      );
      expect(docker.removeImage).toHaveBeenCalledWith(REF);
    });

    it('never removes an image that was already on this machine', async () => {
      docker.imagePresent.mockResolvedValue(true);
      takes(leased());

      await reviewer().processNext(WORKER);

      expect(docker.pullAnonymous).not.toHaveBeenCalled();
      expect(docker.removeImage).not.toHaveBeenCalled();
    });

    it('keeps a download another image row still uses and hands the clean-up to it', async () => {
      respond = (call) =>
        opOf(call, 'maybeSingle').length > 0
          ? { data: { id: 'image-1' } }
          : opOf(call, 'select').length > 0
            ? { count: 1 }
            : {};
      takes(leased());

      await reviewer().processNext(WORKER);

      const check = removalCheck()!;

      expect(opOf(check, 'eq')).toEqual([['run_ref', REF]]);
      expect(opOf(check, 'neq')).toEqual([['id', 'image-1']]);
      expect(opOf(check, 'not')).toEqual([
        ['status', 'in', '(refused,blocked)'],
      ]);
      expect(docker.removeImage).not.toHaveBeenCalled();

      const handover = calls.find(
        (call) =>
          patchOf(call)?.pulled_by_runner === true &&
          opOf(call, 'neq').length > 0,
      );

      expect(handover).toBeDefined();
    });

    it('approves a clean image, even with no scanner or a new framework', async () => {
      takes(leased());
      await reviewer(false).processNext(WORKER);
      expect(patchOf(finalSave()!)).toMatchObject({
        status: 'approved',
        scan: { scanner: null },
      });

      for (const framework of ['nightwatch', 'constructor', '__proto__']) {
        calls = [];
        takes(leased({ test_framework: framework }));
        await reviewer().processNext(WORKER);
        expect(patchOf(finalSave()!)?.status).toBe('approved');
      }
    });

    it('refuses what the inspection or the scan finds', async () => {
      docker.inspectImage.mockResolvedValue(
        details({
          architecture: 'arm64',
          labels: { 'com.docker.compose.project': 'x' },
          volumes: ['/data'],
        }),
      );
      scan.mockResolvedValue(
        scanOf({
          packages: new Set(['flask']),
          systemPackages: new Set(['openssh-server']),
          critical: 2,
        }),
      );
      takes(leased());

      await reviewer().processNext(WORKER);

      const patch = patchOf(finalSave()!)!;

      expect(patch.status).toBe('refused');
      expect((patch.findings as { code: string }[]).map((f) => f.code)).toEqual(
        [
          'IMAGE_WRONG_PLATFORM',
          'IMAGE_BAD_LABELS',
          'IMAGE_HAS_VOLUMES',
          'IMAGE_NOT_TEST_IMAGE',
          'IMAGE_FORBIDDEN_SOFTWARE',
          'IMAGE_CRITICAL_VULNERABILITIES',
        ],
      );
    });

    it('stores only clean, short text from inside the image and names the scanner trivy', async () => {
      docker.inspectImage.mockResolvedValue(
        details({
          os: 'linux\u0000',
          labels: { 'xisuite.secret\u001b': 'x' },
          volumes: [`/data${'v'.repeat(400)}`],
        }),
      );
      scan.mockImplementation(
        (_ref: string, _signal: AbortSignal, onOutput: (c: Buffer) => void) => {
          onOutput(
            Buffer.from('\u001b[31mred\u001b[0m lone\u001b bell\u0007\n'),
          );

          return Promise.resolve(
            scanOf({ systemPackages: new Set(['openssh-server']) }),
          );
        },
      );
      takes(leased());

      await reviewer().processNext(WORKER);

      const patch = patchOf(finalSave()!)!;
      const texts = (patch.findings as { detail: string }[]).map(
        (f) => f.detail,
      );
      const logs = calls
        .map(
          (call) => patchOf(call)?.progress as { log?: string[] } | undefined,
        )
        .flatMap((progress) => progress?.log ?? []);

      expect(patch.scan).toMatchObject({ scanner: 'trivy' });
      texts.forEach((detail) => {
        expect(detail.length).toBeLessThanOrEqual(300);
        // eslint-disable-next-line no-control-regex
        expect(detail).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
      });
      expect(logs.some((line) => line.endsWith('red lone bell'))).toBe(true);
      // eslint-disable-next-line no-control-regex
      logs.forEach((line) => expect(line).not.toMatch(/[\u0000-\u001f]/));
    });

    it('refuses an image the registry will not hand out', async () => {
      docker.pullAnonymous.mockResolvedValue({
        code: 1,
        output: 'manifest unknown',
      });
      takes(leased());

      await reviewer().processNext(WORKER);

      expect(patchOf(finalSave()!)).toMatchObject({
        status: 'refused',
        error_code: 'IMAGE_PULL_FAILED',
        progress: {},
      });
    });

    it('hands the image back without a try when this machine could not pull', async () => {
      docker.pullAnonymous.mockResolvedValue({
        code: 1,
        output: 'write /var/lib/docker: no space left on device',
      });
      takes(leased({ attempts: 2 }));

      await reviewer().processNext(WORKER);

      expect(finalSave()).toBeUndefined();

      const back = calls.find((call) => patchOf(call)?.attempts === 1)!;

      expect(patchOf(back)).toMatchObject({ worker_id: null, progress: {} });
      expect(opOf(back, 'eq')).toContainEqual(['worker_id', WORKER]);
      expect(opOf(back, 'eq')).toContainEqual(['status', 'checking']);
    });

    it('tries a rate-limited or broken download again later', async () => {
      for (const output of ['toomanyrequests', 'unexpected EOF']) {
        calls = [];
        docker.pullAnonymous.mockResolvedValue({ code: 1, output });
        takes(leased());

        await reviewer().processNext(WORKER);

        const later = calls.find(
          (call) => patchOf(call) && 'lease_until' in patchOf(call)!,
        )!;

        expect(finalSave()).toBeUndefined();
        expect(patchOf(later)).not.toHaveProperty('attempts');
        expect(patchOf(later)?.progress).toEqual({});
        expect(opOf(later, 'eq')).toContainEqual(['organization_id', ORG]);
      }
    });

    it('tries again later when the scanner fails, and removes its own download', async () => {
      scan.mockRejectedValue(new Error('scanner broke'));
      takes(leased());

      await reviewer().processNext(WORKER);

      expect(finalSave()).toBeUndefined();
      expect(docker.removeImage).toHaveBeenCalledWith(REF);
    });

    it('hands an uploaded image back without using a try while the disk has no room for it', async () => {
      takes(
        leased({
          registry: 'upload',
          attempts: 1,
          size_bytes: Number.MAX_SAFE_INTEGER,
        }),
      );

      await expect(reviewer().processNext(WORKER)).resolves.toBe(true);

      const back = calls.find((call) => patchOf(call)?.attempts === 0)!;

      expect(patchOf(back)).toMatchObject({ worker_id: null });
      expect(Date.parse(patchOf(back)!.lease_until as string)).toBeGreaterThan(
        Date.now(),
      );
      expect(opOf(back, 'eq')).toEqual([
        ['id', 'image-1'],
        ['organization_id', ORG],
        ['status', 'checking'],
        ['worker_id', WORKER],
      ]);
      expect(docker.pullAnonymous).not.toHaveBeenCalled();
      expect(docker.inspectImage).not.toHaveBeenCalled();
    });
  });

  describe('cleanUp', () => {
    it('removes scanner leftovers and downloads of images that may no longer run', async () => {
      respond = (call) =>
        opOf(call, 'limit').length > 0
          ? { data: [{ id: 'image-9', organization_id: ORG, run_ref: REF }] }
          : { count: 0 };

      await reviewer().cleanUp();

      expect(docker.removeScannerLeftovers).toHaveBeenCalled();
      expect(docker.removeImage).toHaveBeenCalledWith(REF);
      expect(
        calls.some(
          (call) =>
            patchOf(call)?.pulled_by_runner === false &&
            opOf(call, 'eq').some(([, value]) => value === 'image-9'),
        ),
      ).toBe(true);
    });

    it('keeps a download while another row of any organisation still uses it', async () => {
      respond = (call) =>
        opOf(call, 'limit').length > 0
          ? { data: [{ id: 'image-9', organization_id: ORG, run_ref: REF }] }
          : { count: 3 };

      await reviewer().cleanUp();

      expect(docker.removeImage).not.toHaveBeenCalled();
      expect(opOf(removalCheck()!, 'eq')).toEqual([['run_ref', REF]]);
    });

    it('keeps a download when it cannot tell who uses it', async () => {
      respond = (call) =>
        opOf(call, 'limit').length > 0
          ? { data: [{ id: 'image-9', organization_id: ORG, run_ref: REF }] }
          : { error: { message: 'down' } };

      await reviewer().cleanUp();

      expect(docker.removeImage).not.toHaveBeenCalled();
    });
  });
});

describe('downloadProgress', () => {
  it('counts the parts Docker reports ready', () => {
    const output = [
      'aaaaaaaaaaaa: Pulling fs layer',
      'bbbbbbbbbbbb: Pulling fs layer',
      'aaaaaaaaaaaa: Pull complete',
    ].join('\n');

    expect(downloadProgress(output)).toEqual({
      done: 1,
      total: 2,
      percent: 37,
    });
    expect(downloadProgress('')).toEqual({ done: 0, total: 0, percent: 5 });
  });
});

describe('scanner setting', () => {
  it('uses only a pinned Trivy image', () => {
    expect(scannerImage(`docker:${TRIVY}`)).toBe(TRIVY);
    expect(scannerImage('/usr/bin/trivy')).toBeNull();
    expect(configuredScanner(`docker:${TRIVY}`)).toEqual(expect.any(Function));
    expect(configuredScanner('docker:aquasec/trivy:latest')).toBeNull();
    expect(configuredScanner(undefined)).toBeNull();
  });
});

describe('dockerTrivyScanner', () => {
  const savedWorkDir = process.env.TM_RUNNER_WORK_DIR;
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'xis-test-work-'));
    process.env.TM_RUNNER_WORK_DIR = workDir;
  });

  afterEach(async () => {
    if (savedWorkDir === undefined) delete process.env.TM_RUNNER_WORK_DIR;
    else process.env.TM_RUNNER_WORK_DIR = savedWorkDir;

    await rm(workDir, { recursive: true, force: true });
  });

  it('labels its container and reads the report it wrote', async () => {
    const exec = jest.fn((args: string[]) => {
      if (args[0] === 'run') {
        const mount = args.find((arg) => arg.endsWith('dst=/scan'))!;
        const folder = /src=([^,]+)/.exec(mount)![1];

        return writeFile(
          `${folder}/scan.json`,
          JSON.stringify({
            Results: [{ Class: 'os-pkgs', Packages: [{ Name: 'Bash' }] }],
          }),
        ).then(() => ({ code: 0, output: '' }));
      }

      return Promise.resolve({ code: 0, output: '' });
    });

    const result = await dockerTrivyScanner(
      TRIVY,
      exec as unknown as DockerExec,
    )(REF, new AbortController().signal);

    const run = exec.mock.calls[1][0];

    expect(exec.mock.calls[0][0].slice(0, 2)).toEqual(['save', '--output']);
    expect(run).toEqual(
      expect.arrayContaining(['--label', 'xisuite.scanner=1', '--rm']),
    );
    expect(run.indexOf(TRIVY)).toBeGreaterThan(run.indexOf('--label'));
    // Only the work folder is shared with the host's Docker.
    expect(run).toContain(
      `type=bind,src=${join(workDir, 'trivy-cache')},dst=/cache`,
    );
    expect(
      run
        .find((arg) => arg.endsWith('dst=/scan'))!
        .startsWith(`type=bind,src=${join(workDir, 'scans')}/`),
    ).toBe(true);
    expect([...result.systemPackages]).toEqual(['bash']);
  });

  it('tries later when the image cannot be handed over', async () => {
    const exec = jest.fn().mockResolvedValue({ code: 1, output: 'no' });

    await expect(
      dockerTrivyScanner(TRIVY, exec as unknown as DockerExec)(
        REF,
        new AbortController().signal,
      ),
    ).rejects.toThrow('could not be handed');
  });
});

describe('readScan', () => {
  it('keeps package names, severities and secret rules, never secret values', () => {
    const result = readScan(
      JSON.stringify({
        Results: [
          {
            Class: 'lang-pkgs',
            Target: 'app',
            Packages: [{ Name: 'PyTest' }, { Name: 7 }],
            Vulnerabilities: [
              { Severity: 'CRITICAL' },
              { Severity: 'HIGH' },
              { Severity: 'LOW' },
            ],
            Secrets: [{ RuleID: 'aws', Severity: 'HIGH', Match: 'AKIA…' }],
          },
        ],
      }),
      'trivy',
    );

    expect([...result.packages]).toEqual(['pytest']);
    expect(result.systemPackages.size).toBe(0);
    expect(result.critical).toBe(1);
    expect(result.high).toBe(1);
    expect(result.secrets).toEqual([
      { rule: 'aws', severity: 'HIGH', path: 'app' },
    ]);
  });

  it('cleans and cuts the secret rule, severity and path it keeps', () => {
    const result = readScan(
      JSON.stringify({
        Results: [
          {
            Target: `app\u0000${'p'.repeat(400)}`,
            Secrets: [{ RuleID: 'aws\u001b', Severity: 'HIGH\u0007' }],
          },
        ],
      }),
      'trivy',
    );

    expect(result.secrets[0].rule).toBe('aws');
    expect(result.secrets[0].severity).toBe('HIGH');
    expect(result.secrets[0].path).toHaveLength(300);
    expect(result.secrets[0].path.startsWith('appp')).toBe(true);
  });
});
