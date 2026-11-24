import { cp, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join } from 'path';

import {
  PINNED_IMAGE_PATTERN,
  runDocker,
  UPLOADED_IMAGE_PATTERN,
  type DockerExec,
  type DockerResult,
} from '../../docker-driver';

// So a hung Docker command can't linger.
const DOCKER_COMMAND_MS = 30_000;
const PLATFORM_PATTERN = /^linux\/(amd64|arm64)$/;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
// An image id, or a name Docker printed; never something read as an option.
const LOADED_IMAGE = /^[^\s-][^\s]*$/;
const LOADED = /^Loaded image(?: ID)?: (\S+)\r?$/gm;

// Every scanner container carries it, so the clean-up can find the ones a stopped worker left.
export const SCANNER_LABEL = 'xisuite.scanner=1';

export const RATE_LIMITED = /toomanyrequests|rate limit/i;

// This machine could not pull at all; the image itself may be fine.
const MACHINE_PROBLEM =
  /no space left on device|cannot connect to the docker daemon|is the docker daemon running|\bcontext\b[^\n]*(not found|does not exist)|i\/o timeout/i;

// The registry said no to this image.
const REGISTRY_REFUSED = /manifest unknown|not found|unauthorized|denied/i;

export type PullFailure = 'rate_limited' | 'machine' | 'refused' | 'unknown';

/** Why a pull failed, from Docker's output. */
export function pullFailure(output: string): PullFailure {
  if (RATE_LIMITED.test(output)) return 'rate_limited';
  if (MACHINE_PROBLEM.test(output)) return 'machine';

  return REGISTRY_REFUSED.test(output) ? 'refused' : 'unknown';
}

export interface CustomImageDetails {
  repoDigests: string[];
  os: string;
  architecture: string;
  labels: Record<string, string>;
  volumes: string[];
  size: number;
}

function assertPinned(image: string): void {
  if (
    !PINNED_IMAGE_PATTERN.test(image) &&
    !UPLOADED_IMAGE_PATTERN.test(image)
  ) {
    throw new Error('A custom image must be pinned by digest');
  }
}

function dockerConfigDir(): string {
  return (
    process.env.DOCKER_CONFIG || join(process.env.HOME || homedir(), '.docker')
  );
}

/**
 * Fills an empty client settings folder with this machine's Docker context only, so the pull
 * reaches the same Docker but sends none of its logins.
 */
export async function contextOnlyConfig(
  folder: string,
  source = dockerConfigDir(),
): Promise<void> {
  let current: unknown;

  try {
    current = (
      JSON.parse(await readFile(join(source, 'config.json'), 'utf8')) as {
        currentContext?: unknown;
      }
    ).currentContext;
  } catch {
    current = undefined;
  }

  if (typeof current === 'string' && current) {
    await writeFile(
      join(folder, 'config.json'),
      JSON.stringify({ currentContext: current }),
      { mode: 0o600 },
    );
  }

  // Context endpoints and their certificates; a missing folder means the default context.
  await cp(join(source, 'contexts'), join(folder, 'contexts'), {
    recursive: true,
  }).catch(() => undefined);
}

/** The Docker commands for users' own images: find, pull, read and remove them, never start them. */
export class CustomImageDocker {
  constructor(private readonly exec: DockerExec = runDocker) {}

  /** Whether an image is on this machine already. */
  async imagePresent(image: string): Promise<boolean> {
    assertPinned(image);

    const { code } = await this.exec(
      ['image', 'inspect', '--format', '{{.Id}}', image],
      AbortSignal.timeout(DOCKER_COMMAND_MS),
    );

    return code === 0;
  }

  /** Pulls without any login of this machine, through the same Docker context. */
  async pullAnonymous(
    image: string,
    platform: string,
    signal: AbortSignal,
    onOutput?: (chunk: Buffer) => void,
  ): Promise<DockerResult> {
    assertPinned(image);

    if (!PLATFORM_PATTERN.test(platform)) throw new Error('Invalid platform');

    const config = await mkdtemp(join(tmpdir(), 'xis-pull-'));

    try {
      await contextOnlyConfig(config);

      // Without --quiet Docker reports each part of the image, which the check shows as progress.
      const args = [
        '--config',
        config,
        'pull',
        ...(onOutput ? [] : ['--quiet']),
        '--platform',
        platform,
        image,
      ];

      return onOutput
        ? await this.exec(args, signal, onOutput)
        : await this.exec(args, signal);
    } finally {
      await rm(config, { recursive: true, force: true });
    }
  }

  async inspectImage(image: string): Promise<CustomImageDetails | null> {
    assertPinned(image);

    const { code, output } = await this.exec(
      ['image', 'inspect', '--format', '{{json .}}', image],
      AbortSignal.timeout(DOCKER_COMMAND_MS),
    );

    if (code !== 0) return null;

    try {
      const details = JSON.parse(output) as {
        RepoDigests?: unknown;
        Os?: unknown;
        Architecture?: unknown;
        Size?: unknown;
        Config?: { Labels?: unknown; Volumes?: unknown } | null;
      };
      const labels = (details.Config?.Labels ?? {}) as Record<string, unknown>;

      return {
        repoDigests: Array.isArray(details.RepoDigests)
          ? details.RepoDigests.filter(
              (item): item is string => typeof item === 'string',
            )
          : [],
        os: typeof details.Os === 'string' ? details.Os : '',
        architecture:
          typeof details.Architecture === 'string' ? details.Architecture : '',
        labels: Object.fromEntries(
          Object.entries(labels).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
        volumes: Object.keys((details.Config?.Volumes ?? {}) as object),
        size: typeof details.Size === 'number' ? details.Size : 0,
      };
    } catch {
      return null;
    }
  }

  /** Loads a checked image file; `loaded` names what Docker says it loaded. */
  async loadImage(
    tarPath: string,
    signal: AbortSignal,
  ): Promise<DockerResult & { loaded: string[] }> {
    if (!isAbsolute(tarPath)) throw new Error('Invalid image file');

    const result = await this.exec(
      ['load', '--quiet', '--input', tarPath],
      signal,
    );

    return {
      ...result,
      loaded: [...result.output.matchAll(LOADED)].map((match) => match[1]),
    };
  }

  /** Gives a loaded image the name of an uploaded image. */
  async tagImage(source: string, target: string): Promise<boolean> {
    if (!LOADED_IMAGE.test(source)) {
      throw new Error('Invalid image to tag');
    }

    if (!UPLOADED_IMAGE_PATTERN.test(target)) {
      throw new Error('Invalid name for an uploaded image');
    }

    const { code } = await this.exec(
      ['tag', source, target],
      AbortSignal.timeout(DOCKER_COMMAND_MS),
    );

    return code === 0;
  }

  /** The layer digests Docker keeps for an image, or null when it can't say. */
  async imageLayers(image: string): Promise<string[] | null> {
    assertPinned(image);

    const { code, output } = await this.exec(
      ['image', 'inspect', '--format', '{{json .RootFS.Layers}}', image],
      AbortSignal.timeout(DOCKER_COMMAND_MS),
    );

    if (code !== 0) return null;

    try {
      const layers: unknown = JSON.parse(output);

      return Array.isArray(layers) &&
        layers.every((layer) => typeof layer === 'string')
        ? layers
        : null;
    } catch {
      return null;
    }
  }

  /** Never forced: an image still in use, or already gone, stays as Docker leaves it. */
  async removeImage(image: string): Promise<void> {
    assertPinned(image);

    await this.exec(
      ['image', 'rm', image],
      AbortSignal.timeout(DOCKER_COMMAND_MS),
    );
  }

  /** Docker's own platform, such as linux/arm64, or null when Docker doesn't answer. */
  async platform(): Promise<string | null> {
    const { code, output } = await this.exec(
      ['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'],
      AbortSignal.timeout(DOCKER_COMMAND_MS),
    );

    return code === 0 ? output.trim() : null;
  }

  async hasRuntime(name: string): Promise<boolean> {
    const { code, output } = await this.exec(
      ['info', '--format', '{{json .Runtimes}}'],
      AbortSignal.timeout(DOCKER_COMMAND_MS),
    );

    if (code !== 0) return false;

    try {
      return Object.hasOwn(JSON.parse(output) as object, name);
    } catch {
      return false;
    }
  }

  /** Scanner containers that are no longer running; a running scan is never touched. */
  async removeScannerLeftovers(): Promise<void> {
    const listed = await this.exec(
      [
        'ps',
        '--all',
        '--quiet',
        '--filter',
        `label=${SCANNER_LABEL}`,
        '--filter',
        'status=created',
        '--filter',
        'status=exited',
        '--filter',
        'status=dead',
      ],
      AbortSignal.timeout(DOCKER_COMMAND_MS),
    );
    const ids =
      listed.code === 0
        ? listed.output.split('\n').filter((id) => CONTAINER_ID.test(id))
        : [];

    if (ids.length > 0) {
      await this.exec(
        ['rm', '--force', ...ids],
        AbortSignal.timeout(DOCKER_COMMAND_MS),
      );
    }
  }
}
