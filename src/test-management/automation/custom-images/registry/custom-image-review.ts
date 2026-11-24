import { createHash } from 'crypto';
import { isIP } from 'net';

import { stripIllegalXml } from '../../../../backup/engine/writers/xml.writer';
import {
  SafeGetError,
  safeHttpsGet,
  type SafeGetResult,
} from '../shared/https/safe-https-get';
import { USER_IMAGE_FRAMEWORKS } from '../shared/inputs/custom-image-inputs';

export type UserImageErrorCode =
  | 'IMAGE_REF_INVALID'
  | 'REGISTRY_NOT_ALLOWED'
  | 'REGISTRY_UNREACHABLE'
  | 'REGISTRY_RATE_LIMITED'
  | 'IMAGE_NOT_PUBLIC'
  | 'DIGEST_MISMATCH'
  | 'UNSUPPORTED_MANIFEST'
  | 'IMAGE_PLATFORM_MISSING';

export class UserImageError extends Error {
  constructor(
    readonly code: UserImageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type UserImageFindingCode =
  | 'IMAGE_LABELS_MISSING'
  | 'IMAGE_BAD_LABELS'
  | 'IMAGE_HAS_VOLUMES'
  | 'IMAGE_TOO_MANY_LAYERS'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_WRONG_PLATFORM';

export interface UserImageFinding {
  code: UserImageFindingCode;
  detail: string;
}

export interface UserImageRef {
  registry: string;
  repository: string;
  digest: string;
  imageRef: string;
}

export interface RegistryReview {
  runRef: string;
  platform: string;
  language: string | null;
  testFramework: string | null;
  // What the image's own settings point to, for an image without labels.
  hints: { language: string | null; testFramework: string | null };
  // Unknown for an old schema 1 image until the runner has downloaded it.
  sizeBytes: number | null;
  findings: UserImageFinding[];
}

export interface Schema1Layer {
  digest: string;
  // An empty step that Docker never kept as a layer.
  throwaway: boolean;
  history: Record<string, unknown>;
}

export interface Schema1Image {
  config: Record<string, unknown>;
  // Oldest first, as in a current image.
  layers: Schema1Layer[];
}

export const LABEL_LANGUAGE = 'xisuite.language';
export const LABEL_FRAMEWORK = 'xisuite.test-framework';

const DOCKER_HUB = 'docker.io';
const DOCKER_HUB_ALIASES = new Set([
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
]);
const DOCKER_HUB_API = 'registry-1.docker.io';
const HOST_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/;
export const REPOSITORY_PATTERN =
  /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const TAG_PATTERN = /:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const LABEL_VALUE = /^[a-z0-9][a-z0-9.+_-]{0,49}$/;
const FORBIDDEN_LABEL_PREFIXES = [
  'com.docker.compose.',
  'com.supabase.',
  'xisuite.',
];
const MAX_REF_LENGTH = 512;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_LAYERS = 100;
const REVIEW_DEADLINE_MS = 20_000;
const DEFAULT_MAX_GB = 5;

const INDEX_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const MANIFEST_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
// Old Docker format that Docker itself no longer downloads.
export const SCHEMA1_TYPES = new Set([
  'application/vnd.docker.distribution.manifest.v1+prettyjws',
  'application/vnd.docker.distribution.manifest.v1+json',
]);
const ACCEPT = [...INDEX_TYPES, ...MANIFEST_TYPES].join(', ');

type Get = typeof safeHttpsGet;
type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hubHost(host: string): string {
  return DOCKER_HUB_ALIASES.has(host) ? DOCKER_HUB : host;
}

function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '');

  return (
    name === 'localhost' || name.endsWith('.localhost') || isIP(name) !== 0
  );
}

function invalid(message: string): UserImageError {
  return new UserImageError('IMAGE_REF_INVALID', message);
}

/** Registries users may take their own images from, from TM_RUNNER_USER_REGISTRIES ("docker.io,ghcr.io"). */
export function userImageRegistries(
  raw = process.env.TM_RUNNER_USER_REGISTRIES,
): string[] {
  const hosts = (raw ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => HOST_PATTERN.test(host) && !isLocalHost(host))
    .map(hubHost);

  return [...new Set(hosts)];
}

/** The chip type of the runner machine, from TM_RUNNER_PLATFORM; the API and the worker must use the same value. */
export function runnerPlatform(raw = process.env.TM_RUNNER_PLATFORM): string {
  return raw === 'linux/arm64' ? 'linux/arm64' : 'linux/amd64';
}

export function maxUserImageBytes(
  raw = process.env.TM_RUNNER_USER_IMAGE_MAX_GB,
): number {
  const gb = Number(raw);
  const usable =
    Number.isInteger(gb) && gb >= 1 && gb <= 50 ? gb : DEFAULT_MAX_GB;

  return usable * 1024 ** 3;
}

/** Reads an image address such as ghcr.io/team/tests@sha256:…; only images pinned by digest are accepted. */
export function parseUserImageRef(
  raw: string,
  registries: string[] = userImageRegistries(),
): UserImageRef {
  const value = raw.trim();
  const at = value.lastIndexOf('@');

  if (value.length > MAX_REF_LENGTH || at < 1) {
    throw invalid('Give the image with its digest, for example name@sha256:…');
  }

  const digest = value.slice(at + 1);

  if (!DIGEST_PATTERN.test(digest)) {
    throw invalid(
      'The digest must be sha256: followed by 64 lowercase hex characters',
    );
  }

  const parts = value.slice(0, at).split('/');
  const first = parts[0];
  const hasHost =
    parts.length > 1 &&
    (first.includes('.') || first.includes(':') || first === 'localhost');
  const host = hasHost ? hubHost(first.toLowerCase()) : DOCKER_HUB;

  // A tag next to the digest is dropped; the digest decides which image runs.
  const path = (hasHost ? parts.slice(1) : parts)
    .join('/')
    .replace(TAG_PATTERN, '');

  if (!HOST_PATTERN.test(host) || isLocalHost(host)) {
    throw invalid('The registry must be a public host name');
  }

  if (!REPOSITORY_PATTERN.test(path)) {
    throw invalid('An image name uses lowercase letters, digits and . _ - /');
  }

  const repository =
    host === DOCKER_HUB && !path.includes('/') ? `library/${path}` : path;
  const imageRef = `${host}/${repository}@${digest}`;

  if (imageRef.length > MAX_REF_LENGTH)
    throw invalid('The image address is too long');

  if (!registries.includes(host)) {
    throw new UserImageError(
      'REGISTRY_NOT_ALLOWED',
      `Images from ${host} aren't allowed on this server`,
    );
  }

  return { registry: host, repository, digest, imageRef };
}

function readJson(body: Buffer): Json {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Json;
    }
  } catch {
    // Reported below.
  }

  throw new UserImageError(
    'UNSUPPORTED_MANIFEST',
    'The registry sent something that is not an image description',
  );
}

function mediaTypeOf(document: Json, answer: SafeGetResult): string {
  if (typeof document.mediaType === 'string') return document.mediaType;

  return String(answer.headers['content-type'] ?? '')
    .split(';')[0]
    .trim();
}

/** The signed part of an old schema 1 description, which its digest names; null for any other answer. */
function signedPayload(body: Buffer): Buffer | null {
  let document: unknown;

  try {
    document = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }

  if (
    !isRecord(document) ||
    document.schemaVersion !== 1 ||
    !Array.isArray(document.signatures)
  ) {
    return null;
  }

  const damaged = new UserImageError(
    'DIGEST_MISMATCH',
    'The old image description has a damaged signature',
  );
  const first: unknown = document.signatures[0];
  let header: unknown;

  try {
    header =
      isRecord(first) && typeof first.protected === 'string'
        ? JSON.parse(Buffer.from(first.protected, 'base64url').toString('utf8'))
        : null;
  } catch {
    throw damaged;
  }

  const length = isRecord(header) ? header.formatLength : undefined;
  const tail = isRecord(header) ? header.formatTail : undefined;

  if (
    typeof length !== 'number' ||
    !Number.isInteger(length) ||
    length < 1 ||
    length > body.length ||
    typeof tail !== 'string'
  ) {
    throw damaged;
  }

  return Buffer.concat([
    body.subarray(0, length),
    Buffer.from(tail, 'base64url'),
  ]);
}

export function isSchema1(type: string, document: Json): boolean {
  return SCHEMA1_TYPES.has(type) || document.schemaVersion === 1;
}

/** Reads an old schema 1 description: its layers oldest first, and the settings of its newest step. */
export function readSchema1(manifest: Json): Schema1Image {
  const damaged = () =>
    new UserImageError(
      'UNSUPPORTED_MANIFEST',
      'The old image description is damaged',
    );
  const blobs: unknown[] = Array.isArray(manifest.fsLayers)
    ? manifest.fsLayers
    : [];
  const steps: unknown[] = Array.isArray(manifest.history)
    ? manifest.history
    : [];

  if (blobs.length === 0 || blobs.length !== steps.length) throw damaged();

  const layers = blobs
    .map((entry, index): Schema1Layer => {
      const step = steps[index];
      const digest = isRecord(entry) ? entry.blobSum : undefined;
      const text = isRecord(step) ? step.v1Compatibility : undefined;

      if (
        typeof digest !== 'string' ||
        !DIGEST_PATTERN.test(digest) ||
        typeof text !== 'string'
      ) {
        throw damaged();
      }

      let history: unknown;

      try {
        history = JSON.parse(text);
      } catch {
        throw damaged();
      }

      if (!isRecord(history)) throw damaged();

      return { digest, throwaway: history.throwaway === true, history };
    })
    .reverse();
  const newest = layers[layers.length - 1].history;

  return {
    config: {
      ...newest,
      // Docker treated a missing os as Linux.
      os: typeof newest.os === 'string' && newest.os ? newest.os : 'linux',
      architecture:
        typeof newest.architecture === 'string' && newest.architecture
          ? newest.architecture
          : manifest.architecture,
    },
    layers,
  };
}

function parseChallenge(
  header: string | undefined,
): Record<string, string> | null {
  if (!header || !/^bearer\s/i.test(header)) return null;

  const values: Record<string, string> = {};

  for (const [, name, value] of header.matchAll(/(\w+)="([^"]*)"/g)) {
    values[name.toLowerCase()] = value;
  }

  return values.realm ? values : null;
}

class RegistryClient {
  private token: string | null = null;

  constructor(
    private readonly ref: UserImageRef,
    private readonly get: Get,
    private readonly deadline: number,
  ) {}

  /** Fetches one manifest or blob and checks that its bytes match the digest asked for. */
  async fetch(
    kind: 'manifests' | 'blobs',
    digest: string,
    accept?: string,
  ): Promise<{ answer: SafeGetResult; document: Json }> {
    const host =
      this.ref.registry === DOCKER_HUB ? DOCKER_HUB_API : this.ref.registry;
    const url = `https://${host}/v2/${this.ref.repository}/${kind}/${digest}`;
    let answer = await this.send(url, accept);

    if (answer.status === 401 && this.token === null) {
      this.token = await this.anonymousToken(
        answer.headers['www-authenticate'],
      );
      answer = await this.send(url, accept);
    }

    if (answer.status === 429) {
      throw new UserImageError(
        'REGISTRY_RATE_LIMITED',
        'The registry is limiting downloads right now; try again later',
      );
    }

    if ([401, 403, 404].includes(answer.status)) {
      throw new UserImageError(
        'IMAGE_NOT_PUBLIC',
        'The image was not found, or it is not public',
      );
    }

    if (answer.status !== 200) {
      throw new UserImageError(
        'REGISTRY_UNREACHABLE',
        `The registry answered ${answer.status}`,
      );
    }

    // An old schema 1 description is named by its signed part, without the signatures.
    const named =
      (kind === 'manifests' ? signedPayload(answer.body) : null) ?? answer.body;
    const actual = `sha256:${createHash('sha256').update(named).digest('hex')}`;

    if (actual !== digest) {
      throw new UserImageError(
        'DIGEST_MISMATCH',
        'The registry sent different content than the digest names',
      );
    }

    return { answer, document: readJson(named) };
  }

  private async send(url: string, accept?: string): Promise<SafeGetResult> {
    const headers: Record<string, string> = {};

    if (accept) headers.accept = accept;
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    try {
      return await this.get(url, headers, {
        maxBytes: MAX_JSON_BYTES,
        deadlineMs: this.deadline - Date.now(),
      });
    } catch (error) {
      if (error instanceof SafeGetError) {
        throw new UserImageError(
          'REGISTRY_UNREACHABLE',
          error.failure === 'TIMEOUT'
            ? 'The registry took too long to answer'
            : 'The registry could not be reached safely',
        );
      }

      throw error;
    }
  }

  /** A pull token from a registry's sign-in challenge, for downloads made outside this client. */
  pullToken(header: string | undefined): Promise<string> {
    return this.anonymousToken(header);
  }

  /** Public images still need a token on most registries; it is fetched without any login. */
  private async anonymousToken(header: string | undefined): Promise<string> {
    const challenge = parseChallenge(header);

    if (!challenge) {
      throw new UserImageError('IMAGE_NOT_PUBLIC', 'The image is not public');
    }

    let realm: URL;

    try {
      realm = new URL(challenge.realm);
    } catch {
      throw new UserImageError(
        'REGISTRY_UNREACHABLE',
        'The registry sent a broken sign-in address',
      );
    }

    if (challenge.service) realm.searchParams.set('service', challenge.service);
    realm.searchParams.set(
      'scope',
      challenge.scope ?? `repository:${this.ref.repository}:pull`,
    );

    const answer = await this.send(realm.toString());

    if (answer.status !== 200) {
      throw new UserImageError('IMAGE_NOT_PUBLIC', 'The image is not public');
    }

    const body = readJson(answer.body);
    const token = body.token ?? body.access_token;

    if (typeof token !== 'string' || !token) {
      throw new UserImageError('IMAGE_NOT_PUBLIC', 'The image is not public');
    }

    return token;
  }
}

/** Picks the entry of a multi-platform image that this runner can run; attestations and unknown entries are skipped. */
function pickPlatform(index: Json, platform: string): string {
  const entries = Array.isArray(index.manifests)
    ? index.manifests.filter(isRecord)
    : [];
  const [os, architecture] = platform.split('/');

  for (const entry of entries) {
    const target = isRecord(entry.platform) ? entry.platform : undefined;
    const annotations = isRecord(entry.annotations)
      ? entry.annotations
      : undefined;

    if (annotations?.['vnd.docker.reference.type'] === 'attestation-manifest')
      continue;

    if (
      typeof entry.mediaType === 'string' &&
      MANIFEST_TYPES.has(entry.mediaType) &&
      typeof entry.digest === 'string' &&
      DIGEST_PATTERN.test(entry.digest) &&
      target?.os === os &&
      target?.architecture === architecture
    ) {
      return entry.digest;
    }
  }

  throw new UserImageError(
    'IMAGE_PLATFORM_MISSING',
    `The image has no version for ${platform}, the chip type of this server`,
  );
}

// Every run mounts its own disk here, so a volume the image declares at these paths is never created.
const RUN_MOUNTS = new Set(['/tmp', '/work']);

/** Text read from inside an image, safe to store and show: no control characters, at most 300 characters. */
export function findingDetail(value: string): string {
  return stripIllegalXml(value).slice(0, 300);
}

/** Volumes the image declares that a run would leave behind on the machine. */
export function volumesLeftBehind(paths: string[]): string[] {
  return paths.filter(
    (path) => !RUN_MOUNTS.has(path.replace(/\/+$/, '') || '/'),
  );
}

/** Language and framework named by the image's settings: NAME_VERSION variables and its start program, such as python3. */
export function imageHints(settings: Json): RegistryReview['hints'] {
  const env: unknown[] = Array.isArray(settings.Env) ? settings.Env : [];
  const start = [settings.Entrypoint, settings.Cmd]
    .map((part): unknown => (Array.isArray(part) ? part[0] : undefined))
    .filter((part): part is string => typeof part === 'string');
  const words = new Set([
    ...env
      .filter((item): item is string => typeof item === 'string')
      .map((item) => /^([A-Za-z0-9]+)_VERSION=/.exec(item)?.[1].toLowerCase()),
    ...start.map((program) =>
      (program.split('/').pop() ?? '').toLowerCase().replace(/[0-9.]+$/, ''),
    ),
  ]);
  const framework = Object.keys(USER_IMAGE_FRAMEWORKS).find((name) =>
    words.has(name),
  );

  if (framework) {
    return {
      language: USER_IMAGE_FRAMEWORKS[framework].language,
      testFramework: framework,
    };
  }

  const language = Object.values(USER_IMAGE_FRAMEWORKS).find((item) =>
    words.has(item.language),
  )?.language;

  return { language: language ?? null, testFramework: null };
}

export function checkImage(
  manifest: Json,
  config: Json,
  platform: string,
  maxBytes: number,
): Omit<RegistryReview, 'runRef' | 'platform'> {
  const findings: UserImageFinding[] = [];
  const layers = Array.isArray(manifest.layers)
    ? manifest.layers.filter(isRecord)
    : [];
  const configBlob = isRecord(manifest.config) ? manifest.config : {};
  const sizeBytes = [configBlob, ...layers].reduce(
    (total, blob) =>
      total + (typeof blob.size === 'number' && blob.size > 0 ? blob.size : 0),
    0,
  );

  if (layers.length > MAX_LAYERS) {
    findings.push({
      code: 'IMAGE_TOO_MANY_LAYERS',
      detail: `${layers.length} layers, at most ${MAX_LAYERS}`,
    });
  }

  if (sizeBytes > maxBytes) {
    findings.push({
      code: 'IMAGE_TOO_LARGE',
      detail: `${Math.ceil(sizeBytes / 1024 ** 2)} MB`,
    });
  }

  if (`${String(config.os)}/${String(config.architecture)}` !== platform) {
    findings.push({
      code: 'IMAGE_WRONG_PLATFORM',
      detail: findingDetail(
        `${String(config.os)}/${String(config.architecture)}`,
      ),
    });
  }

  const settings = (config.config ?? {}) as Json;
  const labels = (settings.Labels ?? {}) as Record<string, unknown>;
  const volumes = (settings.Volumes ?? {}) as Record<string, unknown>;
  const language = labels[LABEL_LANGUAGE];
  const testFramework = labels[LABEL_FRAMEWORK];

  const labelled = language !== undefined || testFramework !== undefined;

  // Labels are optional; when given, both must be there and well formed.
  if (
    labelled &&
    (typeof language !== 'string' ||
      typeof testFramework !== 'string' ||
      !LABEL_VALUE.test(language) ||
      !LABEL_VALUE.test(testFramework))
  ) {
    findings.push({
      code: 'IMAGE_BAD_LABELS',
      detail: 'The language and framework labels must be short lowercase names',
    });
  }

  const forbidden = Object.keys(labels).filter(
    (name) =>
      name !== LABEL_LANGUAGE &&
      name !== LABEL_FRAMEWORK &&
      FORBIDDEN_LABEL_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );

  if (forbidden.length > 0) {
    findings.push({
      code: 'IMAGE_BAD_LABELS',
      detail: findingDetail(forbidden.slice(0, 5).join(', ')),
    });
  }

  const leftBehind = volumesLeftBehind(Object.keys(volumes));

  if (leftBehind.length > 0) {
    findings.push({
      code: 'IMAGE_HAS_VOLUMES',
      detail: findingDetail(leftBehind.slice(0, 5).join(', ')),
    });
  }

  return {
    language: typeof language === 'string' ? language : null,
    testFramework: typeof testFramework === 'string' ? testFramework : null,
    hints: imageHints(settings),
    sizeBytes,
    findings,
  };
}

/** The first check of a user's image, read from its registry without downloading it to the runner machine. */
export async function reviewImageInRegistry(
  ref: UserImageRef,
  platform = runnerPlatform(),
  maxBytes = maxUserImageBytes(),
  get: Get = safeHttpsGet,
): Promise<RegistryReview> {
  const client = new RegistryClient(ref, get, Date.now() + REVIEW_DEADLINE_MS);
  let manifestDigest = ref.digest;
  let { answer, document: manifest } = await client.fetch(
    'manifests',
    ref.digest,
    ACCEPT,
  );
  let type = mediaTypeOf(manifest, answer);

  if (INDEX_TYPES.has(type)) {
    manifestDigest = pickPlatform(manifest, platform);
    ({ answer, document: manifest } = await client.fetch(
      'manifests',
      manifestDigest,
      ACCEPT,
    ));
    type = mediaTypeOf(manifest, answer);
  }

  // Docker no longer downloads this old format; the runner converts it during its check.
  if (isSchema1(type, manifest)) {
    const old = readSchema1(manifest);
    const stored = old.layers.filter((layer) => !layer.throwaway);

    return {
      runRef: `${ref.registry}/${ref.repository}@${manifestDigest}`,
      platform,
      ...checkImage(
        { layers: stored.map(() => ({ size: 0 })) },
        old.config,
        platform,
        maxBytes,
      ),
      sizeBytes: null,
    };
  }

  if (!MANIFEST_TYPES.has(type)) {
    throw new UserImageError(
      'UNSUPPORTED_MANIFEST',
      'This image format is not supported',
    );
  }

  const configBlob = isRecord(manifest.config) ? manifest.config : undefined;

  if (
    typeof configBlob?.digest !== 'string' ||
    !DIGEST_PATTERN.test(configBlob.digest)
  ) {
    throw new UserImageError(
      'UNSUPPORTED_MANIFEST',
      'The image description has no settings file',
    );
  }

  const { document: config } = await client.fetch('blobs', configBlob.digest);

  return {
    runRef: `${ref.registry}/${ref.repository}@${manifestDigest}`,
    platform,
    ...checkImage(manifest, config, platform, maxBytes),
  };
}

/** Where a layer of the image is downloaded from. */
export function registryBlobUrl(ref: UserImageRef, digest: string): string {
  const host = ref.registry === DOCKER_HUB ? DOCKER_HUB_API : ref.registry;

  return `https://${host}/v2/${ref.repository}/blobs/${digest}`;
}

/** A token for downloading a public image's layers, from the registry's sign-in challenge. */
export function anonymousPullToken(
  ref: UserImageRef,
  challenge: string | undefined,
  get: Get = safeHttpsGet,
): Promise<string> {
  return new RegistryClient(
    ref,
    get,
    Date.now() + REVIEW_DEADLINE_MS,
  ).pullToken(challenge);
}

/** The old schema 1 description of an image, or null when the image uses a current format. */
export async function fetchSchema1Manifest(
  ref: UserImageRef,
  get: Get = safeHttpsGet,
): Promise<Schema1Image | null> {
  const client = new RegistryClient(ref, get, Date.now() + REVIEW_DEADLINE_MS);
  const { answer, document } = await client.fetch(
    'manifests',
    ref.digest,
    ACCEPT,
  );

  return isSchema1(mediaTypeOf(document, answer), document)
    ? readSchema1(document)
    : null;
}
