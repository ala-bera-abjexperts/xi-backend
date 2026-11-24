import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  DockerCommandError,
  DockerDriver,
  networkName,
  proxyConfig,
  proxyFilter,
  proxyUrl,
  spawnProcess,
  type DockerExec,
} from './docker-driver';

const RUN = '11111111-1111-4111-8111-111111111111';
const NETWORK = `xis-tm-run-${RUN}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const TEST_IMAGE = `mcr.example.com/playwright@${DIGEST}`;

interface Call {
  args: string[];
  // Anything past the arguments, which must stay empty: it would reach the Docker client.
  extra: unknown[];
  envFile?: { content: string; mode: number; folderMode: number };
}

describe('DockerDriver', () => {
  let calls: Call[];
  let answers: { code: number; output: string }[];
  let driver: DockerDriver;
  let base: string;
  let envFolder: string;

  const exec = ((args: string[], ...extra: unknown[]) => {
    const flag = args.indexOf('--env-file');
    const path = flag === -1 ? null : args[flag + 1];

    calls.push({
      args,
      extra,
      ...(path
        ? {
            envFile: {
              content: readFileSync(path, 'utf8'),
              mode: statSync(path).mode & 0o777,
              folderMode: statSync(envFolder).mode & 0o777,
            },
          }
        : {}),
    });

    return Promise.resolve(answers.shift() ?? { code: 0, output: '' });
  }) as DockerExec;

  const tests = (overrides: Record<string, unknown> = {}) =>
    driver.runTests({
      runId: RUN,
      image: TEST_IMAGE,
      runFolder: '/runs/one',
      envFolder,
      workDir: null,
      command: 'npm test',
      env: {},
      ...overrides,
    });

  const clone = (overrides: Record<string, unknown> = {}) =>
    driver.cloneRepo({
      runId: RUN,
      image: 'alpine/git:latest',
      runFolder: '/runs/one',
      envFolder,
      repoUrl: 'https://git.example.com/a.git',
      repoRef: 'main',
      ...overrides,
    });

  const proxy = (overrides: Record<string, unknown> = {}) =>
    driver.startProxy({
      runId: RUN,
      image: 'xis-proxy:latest',
      configFolder: '/runs/one-proxy',
      hosts: [],
      ...overrides,
    });

  /** Text of the first call, for checks that something is nowhere in it. */
  const firstCallText = () => calls[0].args.join(' ');

  beforeEach(() => {
    calls = [];
    answers = [];
    base = mkdtempSync(join(tmpdir(), 'docker-driver-'));
    envFolder = join(base, 'env');
    driver = new DockerDriver(exec);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  describe('the run network', () => {
    it('is internal and labelled, so nothing on it reaches outside', async () => {
      await driver.createNetwork(RUN);

      expect(calls[0].args).toEqual([
        'network',
        'create',
        '--internal',
        '--label',
        `xisuite.run=${RUN}`,
        NETWORK,
      ]);
    });

    it('stops the run when it cannot be created', async () => {
      answers.push({ code: 1, output: 'daemon down' });

      await expect(driver.createNetwork(RUN)).rejects.toBeInstanceOf(
        DockerCommandError,
      );
    });

    it('gives the command a time limit', async () => {
      await driver.createNetwork(RUN);

      expect(calls[0].extra[0]).toBeInstanceOf(AbortSignal);
    });

    it('turns a hung Docker into a step error, not an abort', async () => {
      const timeout = jest
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(AbortSignal.abort());
      const hung = new DockerDriver(() =>
        Promise.reject(
          Object.assign(new Error('aborted'), { name: 'AbortError' }),
        ),
      );

      try {
        const error = await hung.createNetwork(RUN).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(DockerCommandError);
        expect(error).toMatchObject({
          step: 'create the run network',
          output: 'Docker did not answer within 30 s',
        });
        expect(timeout).toHaveBeenCalledWith(30_000);
      } finally {
        timeout.mockRestore();
      }
    });

    it('keeps any other failure as it was', async () => {
      const broken = new DockerDriver(() =>
        Promise.reject(new Error('spawn docker ENOENT')),
      );

      await expect(broken.createNetwork(RUN)).rejects.toThrow(
        'spawn docker ENOENT',
      );
    });
  });

  describe('the test container', () => {
    it('ends with the command when no files are selected', async () => {
      await tests();
      await tests({ args: [] });

      for (const { args } of calls) {
        expect(args.slice(-3)).toEqual(['sh', '-c', 'npm test']);
      }
    });

    it('hands selected files over as arguments of the shell', async () => {
      await tests({ command: 'pytest "$@"', args: ['a.py', 'b.py'] });

      expect(calls[0].args.slice(-6)).toEqual([
        'sh',
        '-c',
        'pytest "$@"',
        'sh',
        'a.py',
        'b.py',
      ]);
    });

    it('always has the locked-down flags', async () => {
      await tests();

      expect(calls[0].args).toEqual(
        expect.arrayContaining([
          '--network',
          NETWORK,
          '--user',
          '1000:1000',
          '--cap-drop=ALL',
          '--security-opt',
          'no-new-privileges',
          '--read-only',
          '--tmpfs',
          '/tmp:size=1g,exec',
          '--memory',
          '2g',
          '--cpus',
          '2',
          '--pids-limit',
          '512',
          '--shm-size',
          '1g',
          'HOME=/tmp',
        ]),
      );
    });

    it('mounts only the run folder', async () => {
      await tests();

      const mounts = calls[0].args.filter(
        (_, index) => calls[0].args[index - 1] === '--mount',
      );

      expect(mounts).toEqual(['type=bind,src=/runs/one,dst=/work']);
    });

    it.each([
      '--privileged',
      'docker.sock',
      '--network host',
      '--publish',
      '-p ',
      '--pid=',
      '--pid ',
      '--cap-add',
      '--volume',
    ])('never asks for %s', async (flag) => {
      await tests();

      expect(firstCallText()).not.toContain(flag);
    });

    it('keeps the command as one argument, whatever it holds', async () => {
      const command = 'npm test; rm -rf / && echo "$(whoami)"';

      await tests({ command });

      expect(calls[0].args.slice(-4)).toEqual([
        TEST_IMAGE,
        'sh',
        '-c',
        command,
      ]);
    });

    it('never puts a value of the setting on the command line', async () => {
      await tests({ env: { API_TOKEN: 'secret-value', A: 'plain-value' } });

      expect(firstCallText()).not.toContain('secret-value');
      expect(firstCallText()).not.toContain('plain-value');
      expect(calls[0].envFile?.content).toBe(
        'API_TOKEN=secret-value\nA=plain-value\n',
      );
    });

    it('gives the docker client nothing from the setting', async () => {
      await tests({
        env: { DOCKER_HOST: 'tcp://evil:2375', LD_PRELOAD: '/work/evil.so' },
      });

      expect(calls[0].extra).toEqual([]);
    });

    it('keeps a value exactly as it is, in a file only the worker can read', async () => {
      const value = ` spaced #hash =equals "double" 'single' `;

      await tests({ env: { API_TOKEN: value } });

      expect(calls[0].envFile?.content).toBe(`API_TOKEN=${value}\n`);
      expect(calls[0].envFile?.mode).toBe(0o600);
      expect(calls[0].envFile?.folderMode).toBe(0o700);
    });

    it('removes the file when the tests end', async () => {
      await tests({ env: { A: 'x' } });

      expect(readdirSync(envFolder)).toEqual([]);
    });

    it('removes the file when the docker command fails', async () => {
      const failing = (() =>
        Promise.reject(new Error('docker gone'))) as DockerExec;

      await expect(
        new DockerDriver(failing).runTests({
          runId: RUN,
          image: TEST_IMAGE,
          runFolder: '/runs/one',
          envFolder,
          workDir: null,
          command: 'npm test',
          env: { A: 'x' },
        }),
      ).rejects.toThrow('docker gone');
      expect(readdirSync(envFolder)).toEqual([]);
    });

    it('passes the kill signal to the command, with or without values', async () => {
      const { signal } = new AbortController();

      await tests({ signal });
      await tests({ signal, env: { A: 'x' } });

      expect(calls[0].extra).toEqual([signal]);
      expect(calls[1].extra).toEqual([signal]);
    });

    it('writes no file without values', async () => {
      await tests();

      expect(calls[0].args).not.toContain('--env-file');
      expect(existsSync(envFolder)).toBe(false);
    });

    it.each(['a\nb', 'a\rb', 'a\0b'])(
      'refuses the value %j, which a line-based file cannot hold',
      async (value) => {
        await expect(tests({ env: { A: value } })).rejects.toThrow(
          'The value of A',
        );
        expect(calls).toHaveLength(0);
      },
    );

    it('sets the proxy after the setting, so the setting cannot replace it', async () => {
      await tests({ env: { HTTPS_PROXY: 'http://evil.example.com' } });

      const args = calls[0].args;

      expect(args.indexOf('--env-file')).toBeGreaterThan(-1);
      expect(args.indexOf('--env-file')).toBeLessThan(
        args.indexOf(`HTTPS_PROXY=${proxyUrl(RUN)}`),
      );
    });

    it.each(['A=B', 'A B', '--privileged', '1A', ''])(
      'refuses the variable name %j',
      async (name) => {
        await expect(tests({ env: { [name]: 'x' } })).rejects.toThrow();
        expect(calls).toHaveLength(0);
      },
    );

    it('uses the working folder of the setting', async () => {
      await tests({ workDir: 'apps/web' });

      expect(calls[0].args).toEqual(
        expect.arrayContaining(['--workdir', '/work/apps/web']),
      );
    });

    it('starts in the project folder without one', async () => {
      await tests();

      expect(calls[0].args).toEqual(
        expect.arrayContaining(['--workdir', '/work']),
      );
    });

    it.each(['../up', 'a/../../up', '/etc'])(
      'refuses the working folder %s',
      async (workDir) => {
        await expect(tests({ workDir })).rejects.toThrow();
        expect(calls).toHaveLength(0);
      },
    );

    it.each([
      'mcr.example.com/playwright:latest',
      'playwright',
      `--privileged@${DIGEST}`,
      `a b@${DIGEST}`,
    ])('refuses the image %s, which is not pinned', async (image) => {
      await expect(tests({ image })).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it.each(['/runs/a,src=/etc', 'relative/folder', ''])(
      'refuses the run folder %j',
      async (runFolder) => {
        await expect(tests({ runFolder })).rejects.toThrow();
        expect(calls).toHaveLength(0);
      },
    );

    it.each(['--privileged', 'not-a-run-id', `${RUN};x`, ''])(
      'refuses the run id %j',
      async (runId) => {
        await expect(tests({ runId })).rejects.toThrow();
        expect(calls).toHaveLength(0);
      },
    );

    it('hands back a failing exit code as a normal answer', async () => {
      answers.push({ code: 1, output: '1 test failed' });

      await expect(tests()).resolves.toEqual({
        code: 1,
        output: '1 test failed',
      });
    });
  });

  describe('the proxy', () => {
    it('passes the kill signal to both of its commands', async () => {
      const { signal } = new AbortController();

      await proxy({ signal });

      expect(calls[0].extra).toEqual([signal]);
      expect(calls[1].extra).toEqual([signal]);
    });

    it('has a CPU limit', async () => {
      await proxy();

      expect(calls[0].args).toEqual(expect.arrayContaining(['--cpus', '1']));
    });

    it('sits on the outside network first, then joins the run network', async () => {
      await proxy();

      expect(calls[0].args).toEqual(
        expect.arrayContaining(['--network', 'bridge', '--detach']),
      );
      expect(calls[1].args).toEqual([
        'network',
        'connect',
        NETWORK,
        `${NETWORK}-proxy`,
      ]);
    });

    it('is locked down, publishes no port and reads its settings read-only', async () => {
      await proxy();

      expect(calls[0].args).toEqual(
        expect.arrayContaining([
          '--cap-drop=ALL',
          '--read-only',
          '--mount',
          'type=bind,src=/runs/one-proxy,dst=/etc/xis-proxy,readonly',
        ]),
      );
      expect(firstCallText()).not.toContain('--publish');
      expect(firstCallText()).not.toContain(' -p ');
    });

    it('pins each host to the checked address', async () => {
      await proxy({
        hosts: [
          { host: 'app.example.com', address: '93.184.216.34' },
          { host: 'local.lvh.me', address: 'host-gateway' },
        ],
      });

      expect(calls[0].args).toEqual(
        expect.arrayContaining([
          '--add-host',
          'app.example.com:93.184.216.34',
          '--add-host',
          'local.lvh.me:host-gateway',
        ]),
      );
    });

    it.each([
      [{ host: 'a.example.com', address: 'not-an-address' }],
      [{ host: '--privileged', address: '93.184.216.34' }],
      [{ host: 'a b.com', address: '93.184.216.34' }],
    ])('refuses the host %j', async (host) => {
      await expect(proxy({ hosts: [host] })).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    it('refuses an image name that reads as an option', async () => {
      await expect(proxy({ image: '--privileged' })).rejects.toThrow();
    });

    it('never pulls the built-in proxy image', async () => {
      await proxy({ image: 'xis-tm-runner-proxy:latest' });

      expect(calls[0].args).toEqual(
        expect.arrayContaining(['--pull', 'never']),
      );
    });

    it("still pulls an operator's own proxy image", async () => {
      await proxy();
      await proxy({ image: 'registry.example.com/xis-tm-runner-proxy:latest' });

      expect(calls[0].args).not.toContain('--pull');
      expect(calls[2].args).not.toContain('--pull');
    });

    it('does not connect a proxy that failed to start', async () => {
      answers.push({ code: 125, output: 'no such image' });

      await expect(proxy()).rejects.toMatchObject({ output: 'no such image' });
      expect(calls).toHaveLength(1);
    });

    it('stops the run when the proxy cannot be connected', async () => {
      answers.push({ code: 0, output: '' }, { code: 1, output: 'no network' });

      await expect(proxy()).rejects.toBeInstanceOf(DockerCommandError);
    });
  });

  describe('the proxy host for Maven', () => {
    it('is set on the test and clone containers after the setting', async () => {
      await tests({ env: { XISUITE_PROXY_HOST: 'evil.example.com' } });
      await clone();

      for (const { args } of calls) {
        expect(args).toContain(`XISUITE_PROXY_HOST=${NETWORK}-proxy`);
      }

      expect(calls[0].args.indexOf('--env-file')).toBeLessThan(
        calls[0].args.indexOf(`XISUITE_PROXY_HOST=${NETWORK}-proxy`),
      );
    });
  });

  describe('the clone', () => {
    it('runs on the run network, locked down, through the proxy', async () => {
      await clone();

      expect(calls[0].args).toEqual(
        expect.arrayContaining([
          '--network',
          NETWORK,
          '--user',
          '1000:1000',
          '--cap-drop=ALL',
          '--read-only',
          `HTTPS_PROXY=${proxyUrl(RUN)}`,
          'type=bind,src=/runs/one,dst=/work',
        ]),
      );
    });

    it('ends the options before the address, so it cannot be read as one', async () => {
      await clone();

      expect(calls[0].args.slice(-8)).toEqual([
        'clone',
        '--depth',
        '1',
        '--branch',
        'main',
        '--',
        'https://git.example.com/a.git',
        '/work',
      ]);
    });

    it('takes the default branch without a ref', async () => {
      await clone({ repoRef: null });

      expect(calls[0].args).not.toContain('--branch');
    });

    it('keeps a token off the command line', async () => {
      await clone({ token: 'git-secret' });

      expect(firstCallText()).not.toContain('git-secret');
      expect(calls[0].extra).toEqual([]);
      expect(calls[0].envFile?.content).toBe('GIT_TOKEN=git-secret\n');
      expect(calls[0].envFile?.mode).toBe(0o600);
      expect(readdirSync(envFolder)).toEqual([]);
    });

    it('passes the kill signal to the command', async () => {
      const { signal } = new AbortController();

      await clone({ signal });

      expect(calls[0].extra).toEqual([signal]);
    });

    it('asks for no credentials without a token', async () => {
      await clone();

      expect(firstCallText()).not.toContain('credential.helper');
      expect(calls[0].args).not.toContain('--env-file');
    });

    it.each(['http://git.example.com/a.git', '--upload-pack=x', 'ext::sh'])(
      'refuses the address %s',
      async (repoUrl) => {
        await expect(clone({ repoUrl })).rejects.toThrow();
        expect(calls).toHaveLength(0);
      },
    );

    it.each(['-b', '--upload-pack=x', 'a b', 'a;b'])(
      'refuses the ref %s',
      async (repoRef) => {
        await expect(clone({ repoRef })).rejects.toThrow();
        expect(calls).toHaveLength(0);
      },
    );
  });

  describe('stopping and removing', () => {
    it('stops the containers that do the work', async () => {
      await driver.stop(RUN);

      expect(calls[0].args).toEqual([
        'kill',
        `${NETWORK}-test`,
        `${NETWORK}-clone`,
      ]);
    });

    it('does not mind when they are already gone', async () => {
      answers.push({ code: 1, output: 'No such container' });

      await expect(driver.stop(RUN)).resolves.toBeUndefined();
    });

    it('removes only the containers and network of this run', async () => {
      answers.push(
        { code: 0, output: 'abc\ndef\n' },
        { code: 0, output: '' },
        { code: 0, output: 'net1\n' },
      );

      await driver.remove(RUN);

      expect(calls.map((call) => call.args)).toEqual([
        ['ps', '--all', '--quiet', '--filter', `label=xisuite.run=${RUN}`],
        ['rm', '--force', 'abc', 'def'],
        ['network', 'ls', '--quiet', '--filter', `label=xisuite.run=${RUN}`],
        ['network', 'rm', 'net1'],
      ]);
    });

    it('removes a network left under the old name, found by its label', async () => {
      answers.push({ code: 0, output: '' }, { code: 0, output: 'old1\n' });

      await expect(driver.remove(RUN)).resolves.toBeUndefined();
      expect(calls.map((call) => call.args)).toEqual([
        ['ps', '--all', '--quiet', '--filter', `label=xisuite.run=${RUN}`],
        ['network', 'ls', '--quiet', '--filter', `label=xisuite.run=${RUN}`],
        ['network', 'rm', 'old1'],
      ]);
    });

    it('skips the removal when no container is left, and can run twice', async () => {
      answers.push({ code: 0, output: '' }, { code: 0, output: '' });

      await expect(driver.remove(RUN)).resolves.toBeUndefined();
      expect(calls.map((call) => call.args[0])).toEqual(['ps', 'network']);
    });

    it('gives its commands a time limit', async () => {
      answers.push({ code: 0, output: 'abc\n' });

      await driver.remove(RUN);
      await driver.stop(RUN);
      await driver.labelledRunIds();

      for (const call of calls) {
        expect(call.extra[0]).toBeInstanceOf(AbortSignal);
      }
    });

    it('never reads an error text as container ids', async () => {
      answers.push({ code: 1, output: 'Cannot connect to the Docker daemon' });

      await expect(driver.remove(RUN)).rejects.toBeInstanceOf(
        DockerCommandError,
      );
      expect(calls.map((call) => call.args[0])).toEqual(['ps']);
    });

    it('rejects when a container could not be removed, after trying the network', async () => {
      answers.push(
        { code: 0, output: 'abc\n' },
        { code: 1, output: 'container is in use' },
        { code: 0, output: '' },
      );

      await expect(driver.remove(RUN)).rejects.toBeInstanceOf(
        DockerCommandError,
      );
      expect(calls.map((call) => call.args[0])).toEqual([
        'ps',
        'rm',
        'network',
      ]);
    });

    it('rejects when the network could not be removed', async () => {
      answers.push(
        { code: 0, output: '' },
        { code: 0, output: 'net1\n' },
        { code: 1, output: 'network has active endpoints' },
      );

      await expect(driver.remove(RUN)).rejects.toBeInstanceOf(
        DockerCommandError,
      );
    });

    it('does not mind a container that went in the meantime', async () => {
      answers.push(
        { code: 0, output: 'abc\n' },
        { code: 1, output: 'Error: No such container: abc' },
      );

      await expect(driver.remove(RUN)).resolves.toBeUndefined();
    });

    it('knows whether Docker answers', async () => {
      await expect(driver.isAvailable()).resolves.toBe(true);

      answers.push({ code: 1, output: 'Cannot connect' });
      await expect(driver.isAvailable()).resolves.toBe(false);

      const broken = new DockerDriver(() =>
        Promise.reject(new Error('no docker')),
      );

      await expect(broken.isAvailable()).resolves.toBe(false);
    });

    it('lists runs from containers and networks, once each, ignoring anything odd', async () => {
      answers.push(
        { code: 0, output: `${RUN}\n--privileged\n` },
        { code: 0, output: `${RUN}\n` },
      );

      await expect(driver.labelledRunIds()).resolves.toEqual([RUN]);
      expect(calls[0].args).toContain('label=xisuite.run');
      expect(calls[1].args.slice(0, 2)).toEqual(['network', 'ls']);
    });

    it('lists nothing when Docker does not answer', async () => {
      answers.push(
        { code: 1, output: `${RUN}\n` },
        { code: 1, output: 'daemon down' },
      );

      await expect(driver.labelledRunIds()).resolves.toEqual([]);
    });

    it('refuses a bad run id before touching anything', async () => {
      await expect(driver.remove('--all')).rejects.toThrow();
      await expect(driver.stop('--all')).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });
  });

  describe('output while tests run', () => {
    const recording = () => {
      const seen: unknown[][] = [];

      driver = new DockerDriver((...args: unknown[]) => {
        seen.push(args);

        return Promise.resolve({ code: 0, output: '' });
      });

      return seen;
    };

    it('hands the output receiver to the docker command', async () => {
      const seen = recording();
      const onOutput = jest.fn();

      await tests({ onOutput });

      expect(seen[0][2]).toBe(onOutput);
    });

    it('passes nothing extra when no one is listening', async () => {
      const seen = recording();

      await tests();

      expect(seen[0]).toHaveLength(1);
    });
  });

  describe('built-in test images', () => {
    it('runs the Node.js image from its Docker file and never pulls it', async () => {
      await tests({ image: 'xis-tm-runner-node:latest' });

      expect(firstCallText()).toContain('--pull never');
      expect(firstCallText()).toContain('xis-tm-runner-node:latest');
    });

    it('still lets Docker fetch a pinned image as before', async () => {
      await tests();

      expect(firstCallText()).not.toContain('--pull');
    });

    it('still refuses any other image that is not pinned', async () => {
      await expect(tests({ image: 'someone/other:latest' })).rejects.toThrow(
        'pinned by digest',
      );
    });
  });
});

describe('proxy settings', () => {
  it('denies everything that is not listed', () => {
    const config = proxyConfig([]);

    expect(config).toContain('FilterDefaultDeny Yes');
    expect(config).toContain('FilterType ere');
    expect(config).toContain('Filter "/etc/xis-proxy/filter"');
  });

  it('checks the whole address, because a host-only check ignores plain HTTP ports', () => {
    expect(proxyConfig([])).toContain('FilterURLs On');
  });

  it('has no Allow line and runs as its own user', () => {
    const config = proxyConfig([]);

    expect(config).not.toContain('Allow');
    expect(config).not.toMatch(/^User /m);
  });

  it('opens 443 and the asked ports once each, in order', () => {
    expect(
      proxyConfig([8443, 443, 3000, 8443])
        .split('\n')
        .filter((line) => line.startsWith('ConnectPort')),
    ).toEqual(['ConnectPort 443', 'ConnectPort 3000', 'ConnectPort 8443']);
  });

  it('matches whole host names, with dots taken literally', () => {
    const rule = new RegExp(proxyFilter(['app.example.com']).trim());

    // The proxy sees host:port for CONNECT and the full address for plain HTTP.
    expect(rule.test('app.example.com:443')).toBe(true);
    expect(rule.test('http://app.example.com/x')).toBe(true);
    expect(rule.test('https://app.example.com/x')).toBe(true);
    expect(rule.test('app.example.com.evil.net:443')).toBe(false);
    expect(rule.test('http://app.example.com.evil.net/')).toBe(false);
    expect(rule.test('http://app.example.com@evil.net/')).toBe(false);
    expect(rule.test('http://evil-app.example.com/')).toBe(false);
    expect(rule.test('http://appxexample.com/')).toBe(false);
  });

  it('opens only the normal web ports for a host without a port', () => {
    const rule = new RegExp(proxyFilter(['app.example.com']).trim());

    expect(rule.test('http://app.example.com:54321/')).toBe(false);
    expect(rule.test('app.example.com:8443')).toBe(false);
  });

  it('opens only the listed port for a host with one', () => {
    const rule = new RegExp(proxyFilter(['app.example.com:3002']).trim());

    expect(rule.test('app.example.com:3002')).toBe(true);
    expect(rule.test('http://app.example.com:3002/x')).toBe(true);
    expect(rule.test('http://app.example.com:54321/')).toBe(false);
    expect(rule.test('http://app.example.com/')).toBe(false);
    expect(rule.test('http://app.example.com:30021/')).toBe(false);
  });

  it('lower-cases and removes repeats, keeping each port its own rule', () => {
    expect(
      proxyFilter([
        'App.Example.com:8443',
        'app.example.com:8443',
        'b.example.com',
      ]),
    ).toBe(
      '^(https?://)?app\\.example\\.com:8443(/|$)\n^(https?://)?b\\.example\\.com(:443)?(/|$)\n',
    );
  });

  it.each(['a.com:abc', 'a.com:1|.*', 'a.com:123456'])(
    'refuses the port in %s',
    (host) => {
      expect(() => proxyFilter([host])).toThrow();
    },
  );

  it('allows nothing without hosts', () => {
    expect(proxyFilter([])).toBe('');
  });

  it.each(['a b.com', '(.*)', 'a.com$|.*', '-x'])(
    'refuses %s, which could widen the rule',
    (host) => {
      expect(() => proxyFilter([host])).toThrow();
    },
  );
});

describe('names', () => {
  it('builds every name from the run id', () => {
    expect(networkName(RUN)).toBe(NETWORK);
    expect(proxyUrl(RUN)).toBe(`http://${NETWORK}-proxy:8888`);
  });
});

// These start ordinary programs, not Docker.
describe('spawnProcess', () => {
  it('hands over the output while the program is still running', async () => {
    const received: string[] = [];

    const result = await spawnProcess(
      'sh',
      ['-c', 'echo one; echo two 1>&2'],
      process.env,
      undefined,
      undefined,
      (chunk) => received.push(chunk.toString('utf8')),
    );

    expect(received.join('')).toContain('one');
    expect(received.join('')).toContain('two');
    expect(result.output).toContain('one');
  });

  const env = { PATH: process.env.PATH };

  it('collects both outputs and the exit code', async () => {
    await expect(
      spawnProcess('sh', ['-c', 'echo out; echo err >&2; exit 3'], env),
    ).resolves.toMatchObject({
      code: 3,
      output: expect.stringContaining('out') as string,
    });
  });

  it('really kills a running program when the signal fires', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = spawnProcess(
      'sleep',
      ['30'],
      env,
      undefined,
      controller.signal,
    );

    controller.abort();

    await expect(running).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('hands back what it has when killed, for someone listening to the output', async () => {
    const controller = new AbortController();
    const started = Date.now();
    let heard = false;
    const running = spawnProcess(
      'sh',
      ['-c', 'echo started; sleep 30'],
      env,
      undefined,
      controller.signal,
      () => {
        heard = true;
        setImmediate(() => controller.abort());
      },
    );

    await expect(running).resolves.toMatchObject({
      code: 137,
      output: expect.stringContaining('started') as string,
    });
    expect(heard).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('still fails when the program does not exist, for someone listening', async () => {
    await expect(
      spawnProcess(
        'no-such-program-here',
        [],
        env,
        undefined,
        undefined,
        () => undefined,
      ),
    ).rejects.toThrow();
  });

  it('passes a value as one argument, with no shell to read it', async () => {
    const value = 'a; echo injected $(whoami)';
    const result = await spawnProcess('printf', ['%s', value], env);

    expect(result.output).toBe(value);
  });

  it('gives the program only the environment it was handed', async () => {
    process.env.TM_DRIVER_SPEC_SECRET = 'worker-secret';

    try {
      const result = await spawnProcess('sh', ['-c', 'env'], {
        ...env,
        A: '1',
      });

      expect(result.output).toContain('A=1');
      expect(result.output).not.toContain('worker-secret');
    } finally {
      delete process.env.TM_DRIVER_SPEC_SECRET;
    }
  });

  it('keeps only the end of a long output', async () => {
    const result = await spawnProcess(
      'sh',
      ['-c', 'i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done'],
      env,
      100,
    );

    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(100);
    expect(result.output.trim().endsWith('line1999')).toBe(true);
  });

  it('fails when the program does not exist', async () => {
    await expect(
      spawnProcess('no-such-program-here', [], env),
    ).rejects.toThrow();
  });
});
