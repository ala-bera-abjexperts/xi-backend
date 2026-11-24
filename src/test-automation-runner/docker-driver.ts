import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile } from 'fs/promises';
import { isIP } from 'net';
import { join } from 'path';

import { isBuiltInRunnerImage } from '../test-management/automation/automation-inputs';
import { MAX_LOG_BYTES } from './mask-log';

const RUN_ID_PATTERN = /^[0-9a-f-]{36}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const PINNED_IMAGE_PATTERN = /^[^\s-][^\s]*@sha256:[0-9a-f]{64}$/;
// A user's uploaded image, tagged here by its config digest once the worker checked the file.
export const UPLOADED_IMAGE_PATTERN = /^xis-tm-upload:[0-9a-f]{64}$/;
const OPERATOR_IMAGE_PATTERN = /^[^\s-][^\s]*$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const REF_PATTERN = /^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}$/;

// So a hung Docker command can't linger.
const DOCKER_COMMAND_MS = 30_000;

// What a killed command leaves behind: 128 + SIGKILL.
const KILLED_CODE = 137;

// Docker's words for something that is already gone.
const ALREADY_GONE = /no such|not found/i;

export const PROXY_PORT = 8888;

export const BUILT_IN_PROXY_IMAGE = 'xis-tm-runner-proxy:latest';

// What the worker's own process may hand to the docker command; its database keys must stay out.
const CLIENT_ENV_NAMES = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
];

// Every container of a run gets these; never the Docker socket, --privileged, host networking or a published port.
const HARDENED_FLAGS = [
  '--cap-drop=ALL',
  '--security-opt',
  'no-new-privileges',
  '--read-only',
];

export interface DockerResult {
  code: number;
  output: string;
}

export type DockerExec = (
  args: string[],
  signal?: AbortSignal,
  onOutput?: (chunk: Buffer) => void,
) => Promise<DockerResult>;

export class DockerCommandError extends Error {
  constructor(
    readonly step: string,
    readonly output: string,
  ) {
    super(`Docker could not ${step}`);
  }
}

/** Runs a program without a shell, so every value stays one argument. Only the end of a long output is kept. */
export function spawnProcess(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  maxOutputBytes = MAX_LOG_BYTES,
  signal?: AbortSignal,
  onOutput?: (chunk: Buffer) => void,
): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(signal ? { signal, killSignal: 'SIGKILL' as const } : {}),
    });
    let output = Buffer.alloc(0);

    const keep = (chunk: Buffer) => {
      onOutput?.(chunk);
      output = Buffer.concat([output, chunk]);

      if (output.length > maxOutputBytes * 2) {
        output = output.subarray(output.length - maxOutputBytes);
      }
    };

    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    const collected = (code: number): DockerResult => ({
      code,
      output: output
        .subarray(Math.max(output.length - maxOutputBytes, 0))
        .toString('utf8'),
    });

    child.on('error', (error) => {
      // Someone listening to the output wants what there is; close may never come if something still holds the pipes.
      if (onOutput && error.name === 'AbortError') {
        child.stdout.destroy();
        child.stderr.destroy();
        resolve(collected(KILLED_CODE));

        return;
      }

      reject(error);
    });
    child.on('close', (code) => resolve(collected(code ?? 1)));
  });
}

export function runDocker(
  args: string[],
  signal?: AbortSignal,
  onOutput?: (chunk: Buffer) => void,
): Promise<DockerResult> {
  const clientEnv: NodeJS.ProcessEnv = {};

  for (const name of CLIENT_ENV_NAMES) {
    if (process.env[name]) clientEnv[name] = process.env[name];
  }

  return spawnProcess('docker', args, clientEnv, undefined, signal, onOutput);
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('Invalid run id');
}

function assertPinnedImage(image: string): void {
  if (UPLOADED_IMAGE_PATTERN.test(image)) return;

  if (!PINNED_IMAGE_PATTERN.test(image) && !isBuiltInRunnerImage(image)) {
    throw new Error('A test image must be pinned by digest');
  }
}

function assertOperatorImage(image: string): void {
  if (!OPERATOR_IMAGE_PATTERN.test(image)) {
    throw new Error('Invalid image name');
  }
}

/** A comma would start another option of --mount. */
function bindMount(source: string, target: string, readOnly = false): string[] {
  if (!source.startsWith('/') || source.includes(',')) {
    throw new Error('Invalid folder for a container');
  }

  const options = [`type=bind`, `src=${source}`, `dst=${target}`];

  return ['--mount', [...options, ...(readOnly ? ['readonly'] : [])].join(',')];
}

/** Values go in a private file, so none of them can change how the Docker client itself behaves. */
async function writeEnvFile(
  folder: string,
  env: Record<string, string>,
): Promise<string> {
  const lines = Object.entries(env).map(([name, value]) => {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error('Invalid variable name');
    }

    if (/[\r\n\0]/.test(value)) {
      throw new Error(`The value of ${name} cannot be written on one line`);
    }

    return `${name}=${value}\n`;
  });

  await mkdir(folder, { recursive: true, mode: 0o700 });

  const path = join(folder, `${randomUUID()}.env`);

  await writeFile(path, lines.join(''), { mode: 0o600, flag: 'wx' });

  return path;
}

function hostFlags(hosts: { host: string; address: string }[]): string[] {
  return hosts.flatMap(({ host, address }) => {
    if (!HOST_PATTERN.test(host)) throw new Error('Invalid host name');
    if (address !== 'host-gateway' && !isIP(address)) {
      throw new Error('Invalid host address');
    }

    return ['--add-host', `${host}:${address}`];
  });
}

/** The proxy's settings: no Allow line, because only containers of this run's network can reach it. */
export function proxyConfig(ports: number[]): string {
  const connectPorts = [...new Set([443, ...ports])].sort((a, b) => a - b);

  return [
    `Port ${PROXY_PORT}`,
    'Timeout 600',
    'MaxClients 50',
    'LogLevel Info',
    'Filter "/etc/xis-proxy/filter"',
    'FilterURLs On',
    'FilterType ere',
    'FilterDefaultDeny Yes',
    ...connectPorts.map((port) => `ConnectPort ${port}`),
    '',
  ].join('\n');
}

/** One rule per host and port, so example.com never also allows example.com.evil.net or another port. */
export function proxyFilter(hosts: string[]): string {
  return [
    ...new Set(
      hosts.map((host) => {
        const [name, port] = host.toLowerCase().split(':');

        if (!HOST_PATTERN.test(name) || (port && !/^\d{1,5}$/.test(port))) {
          throw new Error('Invalid host name');
        }

        const escaped = name.replace(/\./g, '\\.');

        // Without a port only the normal web ports are open.
        return port
          ? `^(https?://)?${escaped}:${port}(/|$)`
          : `^(https?://)?${escaped}(:443)?(/|$)`;
      }),
    ),
    '',
  ].join('\n');
}

export function networkName(runId: string): string {
  return `xis-tm-run-${runId}`;
}

export function proxyUrl(runId: string): string {
  return `http://${networkName(runId)}-proxy:${PROXY_PORT}`;
}

export interface StartProxyOptions {
  runId: string;
  image: string;
  // Holds the tinyproxy.conf and filter files; mounted read-only.
  configFolder: string;
  hosts: { host: string; address: string }[];
  // Kills the docker command itself, for one that ignores a stop.
  signal?: AbortSignal;
}

export interface CloneOptions {
  runId: string;
  image: string;
  // The empty folder the project goes into.
  runFolder: string;
  // Holds the token file while it runs; no container may mount it.
  envFolder: string;
  repoUrl: string;
  repoRef: string | null;
  // Sent as the password when the repository needs one.
  token?: string;
  // Kills the docker command itself, for one that ignores a stop.
  signal?: AbortSignal;
}

export interface RunTestsOptions {
  runId: string;
  image: string;
  runFolder: string;
  // Holds the value file while it runs; no container may mount it.
  envFolder: string;
  workDir: string | null;
  command: string;
  // Variables and secrets of the setting.
  env: Record<string, string>;
  // Become "$@" in the command, so they are never read as shell text.
  args?: string[];
  // Kills the docker command itself, for one that ignores a stop.
  signal?: AbortSignal;
  // Receives the output while the tests are still running.
  onOutput?: (chunk: Buffer) => void;
  // A user's own image: no start program of its own, no health check, never pulled here.
  userImage?: boolean;
  // A stronger sandbox for a user's own image, such as runsc.
  runtime?: string | null;
}

/** The only code that talks to Docker. The worker uses it; the API never does. */
export class DockerDriver {
  constructor(private readonly exec: DockerExec = runDocker) {}

  async createNetwork(runId: string): Promise<void> {
    assertRunId(runId);

    const step = 'create the run network';
    const signal = AbortSignal.timeout(DOCKER_COMMAND_MS);

    try {
      await this.must(
        step,
        [
          'network',
          'create',
          '--internal',
          '--label',
          `xisuite.run=${runId}`,
          networkName(runId),
        ],
        signal,
      );
    } catch (error) {
      // A hung Docker ends the run as a start failure, not as an unexpected problem.
      if (signal.aborted) {
        throw new DockerCommandError(
          step,
          `Docker did not answer within ${DOCKER_COMMAND_MS / 1000} s`,
        );
      }

      throw error;
    }
  }

  /** The proxy alone sits on both networks, so it is the only way out for the tests. */
  async startProxy(options: StartProxyOptions): Promise<void> {
    assertRunId(options.runId);
    assertOperatorImage(options.image);

    const name = `${networkName(options.runId)}-proxy`;

    await this.must(
      'start the proxy',
      [
        'run',
        '--detach',
        '--name',
        name,
        '--label',
        `xisuite.run=${options.runId}`,
        // Built here, like the test images; an operator's own proxy image is still pulled.
        ...(options.image === BUILT_IN_PROXY_IMAGE ? ['--pull', 'never'] : []),
        '--network',
        'bridge',
        ...HARDENED_FLAGS,
        '--memory',
        '256m',
        '--cpus',
        '1',
        '--pids-limit',
        '128',
        ...hostFlags(options.hosts),
        ...bindMount(options.configFolder, '/etc/xis-proxy', true),
        options.image,
      ],
      options.signal,
    );
    await this.must(
      'connect the proxy',
      ['network', 'connect', networkName(options.runId), name],
      options.signal,
    );
  }

  async cloneRepo(options: CloneOptions): Promise<DockerResult> {
    assertRunId(options.runId);
    assertOperatorImage(options.image);

    if (!options.repoUrl.startsWith('https://')) {
      throw new Error('A repository must use https');
    }

    if (options.repoRef && !REF_PATTERN.test(options.repoRef)) {
      throw new Error('Invalid branch or tag');
    }

    const env: Record<string, string> = options.token
      ? { GIT_TOKEN: options.token }
      : {};
    // The helper runs inside the container and reads the token there, so it never appears in an argument.
    const credentials = options.token
      ? [
          '-c',
          'credential.helper=!f() { echo username=x-access-token; echo "password=$GIT_TOKEN"; }; f',
        ]
      : [];

    return this.execWithEnv(options, env, (envFlags) => [
      ...this.containerFlags(options.runId, 'clone'),
      '--memory',
      '1g',
      '--cpus',
      '1',
      '--pids-limit',
      '256',
      ...envFlags,
      ...this.proxyEnv(options.runId),
      ...bindMount(options.runFolder, '/work'),
      options.image,
      ...credentials,
      'clone',
      '--depth',
      '1',
      ...(options.repoRef ? ['--branch', options.repoRef] : []),
      '--',
      options.repoUrl,
      '/work',
    ]);
  }

  /** The exit code belongs to the tests, so a failing run is a normal answer here, not an error. */
  async runTests(options: RunTestsOptions): Promise<DockerResult> {
    assertRunId(options.runId);
    assertPinnedImage(options.image);

    const workDir = options.workDir ?? '';

    if (workDir.split('/').includes('..') || workDir.startsWith('/')) {
      throw new Error('Invalid working folder');
    }

    return this.execWithEnv(options, options.env, (envFlags) => [
      ...this.containerFlags(options.runId, 'test'),
      // Built here, so a same-named image from a registry can never replace it.
      ...(isBuiltInRunnerImage(options.image) ? ['--pull', 'never'] : []),
      ...(options.userImage
        ? ['--pull', 'never', '--entrypoint', '', '--no-healthcheck']
        : []),
      ...(options.userImage && options.runtime
        ? ['--runtime', options.runtime]
        : []),
      '--memory',
      '2g',
      '--cpus',
      '2',
      '--pids-limit',
      '512',
      '--shm-size',
      '1g',
      ...envFlags,
      // Docker lets these win over the file, so nothing a setting holds can replace the way out.
      ...this.proxyEnv(options.runId),
      ...bindMount(options.runFolder, '/work'),
      '--workdir',
      workDir ? `/work/${workDir}` : '/work',
      options.image,
      'sh',
      '-c',
      options.command,
      ...(options.args?.length ? ['sh', ...options.args] : []),
    ]);
  }

  private async execWithEnv(
    {
      envFolder,
      signal,
      onOutput,
    }: {
      envFolder: string;
      signal?: AbortSignal;
      onOutput?: (chunk: Buffer) => void;
    },
    env: Record<string, string>,
    args: (envFlags: string[]) => string[],
  ): Promise<DockerResult> {
    if (Object.keys(env).length === 0) {
      return this.execStoppable(args([]), signal, onOutput);
    }

    const path = await writeEnvFile(envFolder, env);

    try {
      return await this.execStoppable(
        args(['--env-file', path]),
        signal,
        onOutput,
      );
    } finally {
      await rm(path, { force: true });
    }
  }

  /** Stops what a run is doing. A container that is already gone is not a problem. */
  async stop(runId: string): Promise<void> {
    assertRunId(runId);

    await this.exec(
      ['kill', `${networkName(runId)}-test`, `${networkName(runId)}-clone`],
      AbortSignal.timeout(DOCKER_COMMAND_MS),
    );
  }

  /** Whether Docker answers; while it doesn't, runs stay in the queue instead of failing. */
  async isAvailable(): Promise<boolean> {
    try {
      const { code } = await this.exec(
        ['version', '--format', '{{.Server.Version}}'],
        AbortSignal.timeout(DOCKER_COMMAND_MS),
      );

      return code === 0;
    } catch {
      return false;
    }
  }

  /** Runs that still have containers or a network here, for the sweep. Docker being down counts as none. */
  async labelledRunIds(): Promise<string[]> {
    const format = '{{.Label "xisuite.run"}}';
    const answers = await Promise.all([
      this.exec(
        ['ps', '--all', '--filter', 'label=xisuite.run', '--format', format],
        AbortSignal.timeout(DOCKER_COMMAND_MS),
      ),
      this.exec(
        ['network', 'ls', '--filter', 'label=xisuite.run', '--format', format],
        AbortSignal.timeout(DOCKER_COMMAND_MS),
      ),
    ]);
    const ids = answers
      .filter(({ code }) => code === 0)
      .flatMap(({ output }) => output.split('\n'))
      .filter((id) => RUN_ID_PATTERN.test(id));

    return [...new Set(ids)];
  }

  /**
   * Removes everything a run created; safe to call again, and whatever already went is skipped.
   * Rejects when something is still there, so nobody reports it as removed.
   */
  async remove(runId: string): Promise<void> {
    assertRunId(runId);

    const listed = await this.exec(
      ['ps', '--all', '--quiet', '--filter', `label=xisuite.run=${runId}`],
      AbortSignal.timeout(DOCKER_COMMAND_MS),
    );

    // An error text must never be read as container ids.
    if (listed.code !== 0) {
      throw new DockerCommandError('list the containers', listed.output);
    }

    const containers = listed.output.split('\n').filter(Boolean);
    const left: DockerCommandError[] = [];

    if (containers.length > 0) {
      const removed = await this.exec(
        ['rm', '--force', ...containers],
        AbortSignal.timeout(DOCKER_COMMAND_MS),
      );

      if (removed.code !== 0 && !ALREADY_GONE.test(removed.output)) {
        left.push(
          new DockerCommandError('remove the containers', removed.output),
        );
      }
    }

    // Found by label, so a network named before the rename is removed too.
    const networks = await this.exec(
      ['network', 'ls', '--quiet', '--filter', `label=xisuite.run=${runId}`],
      AbortSignal.timeout(DOCKER_COMMAND_MS),
    );
    const networkIds = networks.output.split('\n').filter(Boolean);

    if (networks.code !== 0) {
      left.push(new DockerCommandError('list the networks', networks.output));
    } else if (networkIds.length > 0) {
      const network = await this.exec(
        ['network', 'rm', ...networkIds],
        AbortSignal.timeout(DOCKER_COMMAND_MS),
      );

      if (network.code !== 0 && !ALREADY_GONE.test(network.output)) {
        left.push(new DockerCommandError('remove the network', network.output));
      }
    }

    if (left.length > 0) throw left[0];
  }

  private containerFlags(runId: string, role: 'clone' | 'test'): string[] {
    return [
      'run',
      '--name',
      `${networkName(runId)}-${role}`,
      '--label',
      `xisuite.run=${runId}`,
      '--network',
      networkName(runId),
      '--user',
      '1000:1000',
      ...HARDENED_FLAGS,
      '--tmpfs',
      '/tmp:size=1g,exec',
      '--env',
      'HOME=/tmp',
    ];
  }

  private proxyEnv(runId: string): string[] {
    const url = proxyUrl(runId);

    return [
      '--env',
      `XISUITE_PROXY=${url}`,
      '--env',
      `HTTP_PROXY=${url}`,
      '--env',
      `HTTPS_PROXY=${url}`,
      '--env',
      `http_proxy=${url}`,
      '--env',
      `https_proxy=${url}`,
      // Maven's settings file reads the proxy host from this.
      '--env',
      `XISUITE_PROXY_HOST=${networkName(runId)}-proxy`,
    ];
  }

  private execStoppable(
    args: string[],
    signal?: AbortSignal,
    onOutput?: (chunk: Buffer) => void,
  ): Promise<DockerResult> {
    if (onOutput) return this.exec(args, signal, onOutput);

    return signal ? this.exec(args, signal) : this.exec(args);
  }

  private async must(
    step: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.execStoppable(args, signal);

    if (result.code !== 0) throw new DockerCommandError(step, result.output);
  }
}
