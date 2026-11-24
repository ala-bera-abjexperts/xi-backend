import {
  SafeGetError,
  safeHttpsGet,
  type SafeGetResult,
} from '../shared/https/safe-https-get';
import { stripIllegalXml } from '../../../../backup/engine/writers/xml.writer';
import {
  isRecord,
  REPOSITORY_PATTERN,
  SCHEMA1_TYPES,
} from '../registry/custom-image-review';

const HUB = 'https://hub.docker.com';
const MAX_BYTES = 1024 * 1024;
const DEADLINE_MS = 10_000;
const CACHE_MS = 5 * 60_000;
const CACHE_ENTRIES = 200;
const DESCRIPTION_LENGTH = 200;
const UPDATED_LENGTH = 40;
const SEARCH_RESULTS = 10;
const TAGS_PAGE = 100;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const PLATFORM = /^[a-z0-9]{1,20}\/[a-z0-9]{1,20}$/;
const OTHER_TAGS_MAX = 20;
const HUB_HOSTS = new Set([
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
]);

export type DockerHubErrorCode =
  | 'DOCKER_HUB_UNREACHABLE'
  | 'REGISTRY_RATE_LIMITED';

export class DockerHubError extends Error {
  constructor(
    readonly code: DockerHubErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What a user typed or pasted, read as a Docker Hub image. */
export interface HubInput {
  repository: string;
  tag?: string;
  digest?: string;
}

export interface DockerHubRepository {
  repository: string;
  official: boolean;
  description: string;
  pulls: number;
}

export interface DockerHubTag {
  tag: string;
  digest: string;
  updated: string | null;
  size: number | null;
}

export interface DockerHubOtherTag {
  tag: string;
  platforms: string[];
  // Docker Hub gave no digest, os or architecture for it; without it the reason is another chip type.
  reason?: 'missing_details';
}

export interface DockerHubTags {
  tags: DockerHubTag[];
  more: boolean;
  // Versions built only for other chip types, and this server's own, so the user sees why they can't be picked.
  other_platforms?: DockerHubOtherTag[];
  platform?: string;
}

type Get = (url: string) => Promise<SafeGetResult>;
type Json = Record<string, unknown>;

const hubGet: Get = (url) =>
  safeHttpsGet(
    url,
    { accept: 'application/json' },
    { maxBytes: MAX_BYTES, deadlineMs: DEADLINE_MS },
  );

const cache = new Map<string, { at: number; value: unknown }>();

/** Forgets every cached answer; for tests. */
export function resetDockerHubCache(): void {
  cache.clear();
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);

  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;

  cache.delete(key);

  const value = await load();

  // The oldest answer makes room, so the cache never grows past its limit.
  if (cache.size >= CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value as string);
  }

  cache.set(key, { at: Date.now(), value });

  return value;
}

/** Owner and name as Docker Hub's API wants them; official images belong to "library". */
function hubPath(repository: string): [string, string] {
  const parts = repository.split('/');

  return parts.length === 1 ? ['library', parts[0]] : [parts[0], parts[1]];
}

function cleanRepository(raw: string): string | null {
  const repository = raw.toLowerCase().replace(/^library\//, '');

  if (repository.split('/').length > 2) return null;

  return REPOSITORY_PATTERN.test(repository) ? repository : null;
}

/**
 * Reads a Docker Hub image from a page link (hub.docker.com/r/…, /_/…, /layers/…), a copied "docker pull" command,
 * owner/name[:tag], name[:tag] or name@sha256:…; null for anything else, including other registries.
 */
export function readHubInput(raw: string): HubInput | null {
  let text = raw.trim();

  if (/^docker\s+pull\s+/i.test(text)) {
    const words = text.split(/\s+/);

    text = words[words.length - 1];
  }

  if (/^(https?:\/\/)?(www\.)?hub\.docker\.com\//i.test(text)) {
    const link = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const [kind, first, second, third] = link.pathname
      .split('/')
      .filter(Boolean);
    let repository: string | null = null;
    let tag: string | undefined;

    if (kind === '_' && first) repository = cleanRepository(first);
    if ((kind === 'r' || kind === 'layers') && first && second) {
      repository = cleanRepository(`${first}/${second}`);
    }
    if (kind === 'layers' && third && TAG.test(third)) tag = third;

    return repository ? { repository, ...(tag ? { tag } : {}) } : null;
  }

  if (text.length === 0 || /\s/.test(text)) return null;

  let digest: string | undefined;
  const at = text.indexOf('@');

  if (at !== -1) {
    digest = text.slice(at + 1).toLowerCase();
    text = text.slice(0, at);

    if (!DIGEST.test(digest)) return null;
  }

  const parts = text.split('/');

  if (parts.length > 1 && HUB_HOSTS.has(parts[0].toLowerCase())) {
    parts.shift();
  } else if (parts.length > 1 && /[.:]/.test(parts[0])) {
    // Another registry, such as ghcr.io.
    return null;
  }

  const [last, tag] = parts[parts.length - 1].split(':');

  if (tag !== undefined && !TAG.test(tag)) return null;

  parts[parts.length - 1] = last;

  const repository = cleanRepository(parts.join('/'));

  if (!repository) return null;

  return {
    repository,
    ...(tag ? { tag } : {}),
    ...(digest ? { digest } : {}),
  };
}

async function hubJson(url: string, get: Get): Promise<Json | null> {
  let answer: SafeGetResult;

  try {
    answer = await get(url);
  } catch (error) {
    if (error instanceof SafeGetError) {
      throw new DockerHubError(
        'DOCKER_HUB_UNREACHABLE',
        'Docker Hub could not be reached',
      );
    }

    throw error;
  }

  if (answer.status === 404) return null;

  if (answer.status === 429) {
    throw new DockerHubError(
      'REGISTRY_RATE_LIMITED',
      'Docker Hub is limiting requests right now; try again later',
    );
  }

  if (answer.status < 200 || answer.status > 299) {
    throw new DockerHubError(
      'DOCKER_HUB_UNREACHABLE',
      `Docker Hub answered ${answer.status}`,
    );
  }

  try {
    const body: unknown = JSON.parse(answer.body.toString('utf8'));

    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Json;
    }
  } catch {
    // Treated below like any other answer that isn't a JSON object.
  }

  throw new DockerHubError(
    'DOCKER_HUB_UNREACHABLE',
    'Docker Hub sent an answer that could not be read',
  );
}

/** A date as Docker Hub sends it; anything long or unreadable is left out. */
function updatedOf(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= UPDATED_LENGTH &&
    !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function toRepository(item: Json): DockerHubRepository | null {
  const name =
    typeof item.repo_name === 'string'
      ? item.repo_name
      : typeof item.name === 'string' && typeof item.namespace === 'string'
        ? `${item.namespace}/${item.name}`
        : null;
  const repository = name ? cleanRepository(name) : null;

  if (!repository) return null;

  const description =
    typeof item.short_description === 'string'
      ? item.short_description
      : typeof item.description === 'string'
        ? item.description
        : '';

  return {
    repository,
    official: item.is_official === true || !repository.includes('/'),
    description: stripIllegalXml(description).slice(0, DESCRIPTION_LENGTH),
    pulls: typeof item.pull_count === 'number' ? item.pull_count : 0,
  };
}

/** Images on Docker Hub for what the user typed; a link or owner/name lists that exact image first. */
export async function searchDockerHub(
  text: string,
  get: Get = hubGet,
): Promise<DockerHubRepository[]> {
  const input = readHubInput(text);
  const query = (input?.repository.split('/').pop() ?? text.trim()).slice(
    0,
    100,
  );

  if (query.length < 2) return [];

  return cached(`search:${query}:${input?.repository ?? ''}`, async () => {
    const params = new URLSearchParams({
      query,
      page_size: String(SEARCH_RESULTS),
    });
    const found = await hubJson(
      `${HUB}/v2/search/repositories/?${params.toString()}`,
      get,
    );
    const results = Array.isArray(found?.results)
      ? found.results.filter(isRecord)
      : [];
    const list = results
      .map(toRepository)
      .filter((item): item is DockerHubRepository => item !== null);

    // Only a link, owner/name or a copied command names one exact image worth asking for when the search misses it.
    const named = input !== null && /[/:@]|^docker\s/i.test(text.trim());

    if (named && !list.some((item) => item.repository === input.repository)) {
      const [owner, name] = hubPath(input.repository);
      const exact = await hubJson(
        `${HUB}/v2/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/`,
        get,
      );
      const item = exact ? toRepository(exact) : null;

      if (item) list.unshift({ ...item, repository: input.repository });
    }

    // The image the user named comes first, then Docker Hub's own order; each image once.
    return list
      .filter(
        (item, index) =>
          list.findIndex((other) => other.repository === item.repository) ===
          index,
      )
      .sort(
        (a, b) =>
          Number(b.repository === input?.repository) -
          Number(a.repository === input?.repository),
      );
  });
}

/** Versions of an image that run on this server's chip type, newest first; `more` when typing can find older ones. */
export async function dockerHubTags(
  repository: string,
  platform: string,
  filter = '',
  get: Get = hubGet,
): Promise<DockerHubTags> {
  const input = readHubInput(repository);

  if (!input) return { tags: [], more: false };

  const [os, architecture] = platform.split('/');
  const [owner, name] = hubPath(input.repository);
  const nameFilter = filter.trim().slice(0, 128);

  return cached(
    `tags:${input.repository}:${platform}:${nameFilter}`,
    async () => {
      const params = new URLSearchParams({
        page_size: String(TAGS_PAGE),
        ordering: 'last_updated',
        ...(nameFilter ? { name: nameFilter } : {}),
      });
      const found = await hubJson(
        `${HUB}/v2/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tags/?${params.toString()}`,
        get,
      );

      if (!found) return { tags: [], more: false };

      const results = Array.isArray(found.results)
        ? found.results.filter(isRecord)
        : [];
      const tags: DockerHubTag[] = [];
      const others: DockerHubOtherTag[] = [];

      for (const item of results) {
        const images = Array.isArray(item.images)
          ? item.images.filter(isRecord)
          : [];
        // Docker Hub gives old schema 1 versions no os; they are Linux images.
        const legacy =
          typeof item.media_type === 'string' &&
          SCHEMA1_TYPES.has(item.media_type);
        // The variant (such as v8) doesn't matter; os and architecture decide.
        const match = images.find(
          (image) =>
            (image.os === os ||
              (legacy && image.os === '' && os === 'linux')) &&
            image.architecture === architecture,
        );

        // A version that can't be picked is listed apart, so the user sees why.
        const pinned =
          typeof item.digest === 'string' && DIGEST.test(item.digest);

        if (
          (!match || !pinned) &&
          others.length < OTHER_TAGS_MAX &&
          typeof item.name === 'string' &&
          TAG.test(item.name)
        ) {
          const platforms = [
            ...new Set(
              images
                .map(
                  (image) =>
                    `${image.os === '' && legacy ? 'linux' : String(image.os)}/${String(image.architecture)}`,
                )
                .filter(
                  (value) => PLATFORM.test(value) && !value.includes('unknown'),
                ),
            ),
          ].slice(0, 10);

          // No digest, or no usable os or architecture: Docker Hub left the details out.
          others.push(
            !pinned || platforms.length === 0
              ? { tag: item.name, platforms, reason: 'missing_details' }
              : { tag: item.name, platforms },
          );
        }

        if (
          !match ||
          typeof item.name !== 'string' ||
          !TAG.test(item.name) ||
          typeof item.digest !== 'string' ||
          !DIGEST.test(item.digest)
        ) {
          continue;
        }

        tags.push({
          tag: item.name,
          digest: item.digest,
          updated: updatedOf(item.last_updated),
          size: typeof match.size === 'number' ? match.size : null,
        });
      }

      return {
        tags,
        more: typeof found.next === 'string' && found.next !== '',
        ...(others.length > 0 && { other_platforms: others, platform }),
      };
    },
  );
}
