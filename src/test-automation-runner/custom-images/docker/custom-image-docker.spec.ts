import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  DockerDriver,
  type DockerExec,
  type DockerResult,
} from '../../docker-driver';
import {
  contextOnlyConfig,
  CustomImageDocker,
  pullFailure,
  SCANNER_LABEL,
} from './custom-image-docker';

const REF = `ghcr.io/team/tests@sha256:${'b'.repeat(64)}`;
const RUN_ID = '11111111-2222-3333-4444-555555555555';

type ExecMock = jest.Mock<Promise<DockerResult>, Parameters<DockerExec>>;

const execMock = (): ExecMock =>
  jest.fn<Promise<DockerResult>, Parameters<DockerExec>>();

describe('pullFailure', () => {
  it('blames the machine for a full disk, a missing Docker or context, and timeouts', () => {
    expect(pullFailure('write /var/lib: no space left on device')).toBe(
      'machine',
    );
    expect(
      pullFailure(
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      ),
    ).toBe('machine');
    expect(
      pullFailure('context "colima": context not found: open meta.json'),
    ).toBe('machine');
    expect(pullFailure('dial tcp: lookup ghcr.io: i/o timeout')).toBe(
      'machine',
    );
  });

  it('refuses only what the registry refused', () => {
    expect(pullFailure('manifest unknown')).toBe('refused');
    expect(pullFailure('Error response from daemon: not found')).toBe(
      'refused',
    );
    expect(pullFailure('unauthorized: authentication required')).toBe(
      'refused',
    );
    expect(pullFailure('pull access denied for x')).toBe('refused');
  });

  it('keeps rate limits and anything else apart', () => {
    expect(pullFailure('toomanyrequests: You have reached')).toBe(
      'rate_limited',
    );
    expect(pullFailure('unexpected EOF')).toBe('unknown');
  });
});

describe('contextOnlyConfig', () => {
  let source: string;
  let target: string;

  beforeEach(async () => {
    source = await mkdtemp(join(tmpdir(), 'xis-test-src-'));
    target = await mkdtemp(join(tmpdir(), 'xis-test-dst-'));
  });

  afterEach(async () => {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  });

  it('keeps the chosen context and its endpoints but no login', async () => {
    await writeFile(
      join(source, 'config.json'),
      JSON.stringify({
        auths: { 'ghcr.io': { auth: 'c2VjcmV0' } },
        credsStore: 'desktop',
        currentContext: 'colima',
      }),
    );
    await mkdir(join(source, 'contexts', 'meta', 'abc'), { recursive: true });
    await writeFile(
      join(source, 'contexts', 'meta', 'abc', 'meta.json'),
      '{"Name":"colima"}',
    );

    await contextOnlyConfig(target, source);

    const written = await readFile(join(target, 'config.json'), 'utf8');

    expect(JSON.parse(written)).toEqual({ currentContext: 'colima' });
    expect(written).not.toContain('c2VjcmV0');
    expect(
      existsSync(join(target, 'contexts', 'meta', 'abc', 'meta.json')),
    ).toBe(true);
  });

  it('leaves the folder empty when this machine uses the default context', async () => {
    await contextOnlyConfig(target, source);

    expect(existsSync(join(target, 'config.json'))).toBe(false);
    expect(existsSync(join(target, 'contexts'))).toBe(false);
  });

  it('ignores a settings file it cannot read', async () => {
    await writeFile(join(source, 'config.json'), '{not json');

    await expect(contextOnlyConfig(target, source)).resolves.toBeUndefined();
    expect(existsSync(join(target, 'config.json'))).toBe(false);
  });
});

describe('CustomImageDocker', () => {
  const savedConfig = process.env.DOCKER_CONFIG;
  let exec: ExecMock;
  let docker: CustomImageDocker;

  beforeEach(() => {
    // Never the settings of the machine running the tests.
    process.env.DOCKER_CONFIG = join(tmpdir(), 'xis-test-no-docker-config');
    exec = execMock().mockResolvedValue({ code: 0, output: '' });
    docker = new CustomImageDocker(exec);
  });

  afterEach(() => {
    if (savedConfig === undefined) delete process.env.DOCKER_CONFIG;
    else process.env.DOCKER_CONFIG = savedConfig;
  });

  it('pulls through a temporary settings folder that is removed afterwards', async () => {
    let folder = '';

    exec.mockImplementation((args) => {
      folder = args[1];

      return Promise.resolve({ code: 0, output: '' });
    });

    await docker.pullAnonymous(
      REF,
      'linux/amd64',
      new AbortController().signal,
    );

    const args = exec.mock.calls[0][0];

    expect(args[0]).toBe('--config');
    expect(args.slice(2)).toEqual([
      'pull',
      '--quiet',
      '--platform',
      'linux/amd64',
      REF,
    ]);
    expect(existsSync(folder)).toBe(false);
  });

  it('shows the pull progress when someone listens', async () => {
    const onOutput = jest.fn();

    await docker.pullAnonymous(
      REF,
      'linux/arm64',
      new AbortController().signal,
      onOutput,
    );

    expect(exec.mock.calls[0][0]).not.toContain('--quiet');
    expect(exec.mock.calls[0][2]).toBe(onOutput);
  });

  it('never pulls an image that is not pinned, or for another platform', async () => {
    const signal = new AbortController().signal;

    await expect(
      docker.pullAnonymous('ghcr.io/team/tests:latest', 'linux/amd64', signal),
    ).rejects.toThrow('pinned');
    await expect(
      docker.pullAnonymous(REF, 'windows/amd64', signal),
    ).rejects.toThrow('Invalid platform');
    expect(exec).not.toHaveBeenCalled();
  });

  it('reads the image details Docker reports', async () => {
    exec.mockResolvedValue({
      code: 0,
      output: JSON.stringify({
        RepoDigests: [REF, 3],
        Os: 'linux',
        Architecture: 'amd64',
        Size: 1234,
        Config: {
          Labels: { 'xisuite.language': 'python', bad: 1 },
          Volumes: { '/data': {} },
        },
      }),
    });

    await expect(docker.inspectImage(REF)).resolves.toEqual({
      repoDigests: [REF],
      os: 'linux',
      architecture: 'amd64',
      labels: { 'xisuite.language': 'python' },
      volumes: ['/data'],
      size: 1234,
    });
  });

  it('answers null for an image Docker cannot read', async () => {
    exec.mockResolvedValue({ code: 1, output: 'No such image' });

    await expect(docker.inspectImage(REF)).resolves.toBeNull();
  });

  it('removes an image without forcing it', async () => {
    await docker.removeImage(REF);

    expect(exec.mock.calls[0][0]).toEqual(['image', 'rm', REF]);
  });

  it('knows only runtimes Docker lists as its own', async () => {
    exec.mockResolvedValue({ code: 0, output: '{"runc":{},"runsc":{}}' });

    await expect(docker.hasRuntime('runsc')).resolves.toBe(true);
    await expect(docker.hasRuntime('constructor')).resolves.toBe(false);
  });

  it('reads Docker platform, or null when Docker does not answer', async () => {
    exec.mockResolvedValueOnce({ code: 0, output: 'linux/arm64\n' });
    exec.mockResolvedValueOnce({ code: 1, output: 'down' });

    await expect(docker.platform()).resolves.toBe('linux/arm64');
    await expect(docker.platform()).resolves.toBeNull();
  });

  it('removes only scanner containers that stopped', async () => {
    exec.mockResolvedValueOnce({
      code: 0,
      output: 'abcdef123456\nnot an id\n',
    });

    await docker.removeScannerLeftovers();

    const listed = exec.mock.calls[0][0];

    expect(listed).toContain(`label=${SCANNER_LABEL}`);
    expect(listed).not.toContain('status=running');
    expect(exec.mock.calls[1][0]).toEqual(['rm', '--force', 'abcdef123456']);
  });

  it('removes nothing when the list fails', async () => {
    exec.mockResolvedValueOnce({ code: 1, output: 'abcdef123456' });

    await docker.removeScannerLeftovers();

    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('DockerDriver.runTests for a custom image', () => {
  const options = {
    runId: RUN_ID,
    image: REF,
    runFolder: '/tmp/run/project',
    envFolder: '/tmp/run/env',
    workDir: null,
    command: 'pytest',
    env: {},
  };

  it('never pulls it, starts it without its own start program or health check, and in the sandbox', async () => {
    const exec = execMock().mockResolvedValue({ code: 0, output: '' });

    await new DockerDriver(exec).runTests({
      ...options,
      userImage: true,
      runtime: 'runsc',
    });

    const args = exec.mock.calls[0][0];
    const at = args.indexOf('--entrypoint');

    expect(args.slice(at - 2, at + 5)).toEqual([
      '--pull',
      'never',
      '--entrypoint',
      '',
      '--no-healthcheck',
      '--runtime',
      'runsc',
    ]);
  });

  it('adds no sandbox when none is set, and nothing for a normal run', async () => {
    const exec = execMock().mockResolvedValue({ code: 0, output: '' });
    const driver = new DockerDriver(exec);

    await driver.runTests({ ...options, userImage: true, runtime: null });
    await driver.runTests({ ...options, runtime: 'runsc' });

    expect(exec.mock.calls[0][0]).not.toContain('--runtime');
    expect(exec.mock.calls[0][0]).toContain('--no-healthcheck');
    expect(exec.mock.calls[1][0]).not.toContain('--runtime');
    expect(exec.mock.calls[1][0]).not.toContain('--entrypoint');
    expect(exec.mock.calls[1][0]).not.toContain('--pull');
  });
});
