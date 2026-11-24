import type { IncomingMessage } from 'http';
import { request } from 'https';
import { Readable } from 'stream';

import { assertPublicHttpUrl } from '../../common/security/ssrf-guard';
import { publicOnlyLookup } from './safe-https-request';
import {
  cleanJobLog,
  GithubActionsError,
  readLimited,
  readTail,
  type GithubJob,
  type GithubJobLog,
} from './test-automation-github.client';

// Field values a page shows are kept short.
const TEXT_LIMIT = 255;
const API_TIMEOUT_MS = 15_000;
const LOG_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

export type CiToolState =
  | 'untracked'
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled';

export interface GitlabCi {
  provider: 'gitlab';
  state: CiToolState;
  full_name: string;
  run_id?: number;
  html_url?: string;
  head_sha?: string;
  head_branch?: string;
  project_id?: number;
}

/** The value of a saved header, whatever case its name was saved in. */
export function savedHeader(
  stored: Record<string, string>,
  name: string,
): string | null {
  const found = Object.entries(stored).find(
    ([key, value]) => key.toLowerCase() === name && value.trim(),
  );

  return found ? found[1].trim() : null;
}

// Any spelling of the name counts, so a blank saved token still keeps the connection out.
export const hasPrivateToken = (stored: Record<string, string>): boolean =>
  Object.keys(stored).some((name) => name.toLowerCase() === 'private-token');

/**
 * The API root and numeric project of the "create pipeline" address saved for a project connected
 * in Integrations; null for any other address, trigger addresses included.
 */
export function gitlabPipelineAddress(
  ciUrl: string,
): { base: string; projectId: string } | null {
  try {
    const url = new URL(ciUrl);
    const match = /^(.*\/api\/v4)\/projects\/(\d{1,15})\/pipeline$/.exec(
      url.pathname,
    );

    if (
      url.protocol !== 'https:' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !match
    ) {
      return null;
    }

    return { base: `${url.origin}${match[1]}`, projectId: match[2] };
  } catch {
    return null;
  }
}

/** The API root and project of a GitLab "create pipeline" or "trigger pipeline" address. */
export function gitlabProject(
  ciUrl: string,
): { base: string; project: string } | null {
  try {
    const url = new URL(ciUrl);
    const match =
      /^(.*\/api\/v4)\/projects\/([^/]+)\/(?:trigger\/)?pipeline\/?$/.exec(
        url.pathname,
      );

    return match
      ? { base: `${url.origin}${match[1]}`, project: match[2] }
      : null;
  } catch {
    return null;
  }
}

export function decoded(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

export const isCommitSha = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);

export const shortText = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value.slice(0, TEXT_LIMIT) : undefined;

/**
 * Only the top-level fields at the start of a reply cut at 2 KB, so an id inside
 * a nested object such as "user" is never taken for the pipeline's.
 */
function startFields(answer: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(answer);

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    const nested = answer.indexOf('{', 1);
    const head = nested > 0 ? answer.slice(0, nested) : answer;
    const fields: Record<string, unknown> = {};

    for (const name of ['id', 'project_id']) {
      const found = new RegExp(`"${name}"\\s*:\\s*(\\d{1,15})\\s*[,}]`).exec(
        head,
      );

      if (found) fields[name] = Number(found[1]);
    }

    for (const name of ['web_url', 'sha', 'ref']) {
      const found = new RegExp(
        `"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`,
      ).exec(head);

      try {
        if (found) fields[name] = JSON.parse(`"${found[1]}"`) as string;
      } catch {
        // A broken escape leaves the field out.
      }
    }

    return fields;
  }
}

const positiveId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * What a started GitLab pipeline is followed by; null when the address isn't
 * GitLab's or no token to read it with is saved, so the run stays "sent".
 * A start through the GitLab connection is read later with that connection.
 */
export function gitlabStart(
  ciUrl: string,
  stored: Record<string, string>,
  answer: string,
  connected = false,
): GitlabCi | null {
  const api = gitlabProject(ciUrl);

  if (!api || (!connected && !savedHeader(stored, 'private-token'))) {
    return null;
  }

  const segment = decoded(api.project);

  if (segment === null) return null;

  const fields = startFields(answer);
  const projectId = /^\d{1,15}$/.test(segment)
    ? Number(segment)
    : fields.project_id;
  const origin = new URL(ciUrl).origin;
  let page: URL | null = null;

  try {
    page = typeof fields.web_url === 'string' ? new URL(fields.web_url) : null;
  } catch {
    page = null;
  }

  const at = page?.pathname.indexOf('/-/pipelines/') ?? -1;
  const fullName = page && at > 0 ? decoded(page.pathname.slice(1, at)) : null;

  if (
    !page ||
    page.protocol !== 'https:' ||
    page.origin !== origin ||
    !fullName ||
    !positiveId(fields.id) ||
    !positiveId(projectId)
  ) {
    return {
      provider: 'gitlab',
      state: 'untracked',
      full_name: segment.slice(0, TEXT_LIMIT),
    };
  }

  const branch = shortText(fields.ref);

  return {
    provider: 'gitlab',
    state: 'queued',
    full_name: fullName.slice(0, TEXT_LIMIT),
    run_id: fields.id,
    html_url: page.href,
    ...(isCommitSha(fields.sha) && { head_sha: fields.sha }),
    ...(branch && { head_branch: branch }),
    project_id: projectId,
  };
}

/** How a GitLab or Jenkins server is read: its host, and the one saved header that signs in. */
export interface CiToolAccess {
  origin: string;
  base: string;
  label: string;
  headers: Record<string, string>;
  secrets: string[];
}

// A tool may echo only the token of "Basic <token>", so the bare part is hidden too.
export function tokenSecrets(value: string): string[] {
  const bare = /^\S+\s+(\S{8,})$/.exec(value)?.[1];

  return bare ? [value, bare] : [value];
}

function toResponse(incoming: IncomingMessage): Response {
  const code = incoming.statusCode ?? 0;
  const status = code >= 200 && code <= 599 ? code : 502;
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }

  if ([204, 205, 304].includes(status)) {
    incoming.resume();

    return new Response(null, { status, headers });
  }

  return new Response(
    Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>,
    { status, headers },
  );
}

/**
 * One call to the CI tool's own host only, with its public address checked when the
 * socket connects; redirects are answers, never followed. The time limit covers the
 * reading of the body too.
 */
export async function ciToolFetch(
  access: CiToolAccess,
  url: string,
  method: 'GET' | 'POST',
  timeoutMs = API_TIMEOUT_MS,
): Promise<Response> {
  let target: URL;

  try {
    target = new URL(url);
  } catch {
    throw new GithubActionsError(null, 'The CI address is not valid', true);
  }

  if (target.origin !== access.origin) {
    throw new GithubActionsError(
      null,
      `The address is not on the ${access.label} host of the setting`,
      true,
    );
  }

  try {
    await assertPublicHttpUrl(target.href);
  } catch {
    // DNS can fail for a moment, so this is tried again.
    throw new GithubActionsError(null, `${access.label} is not a public host`);
  }

  return new Promise((resolve, reject) => {
    try {
      const outgoing = request(
        target,
        {
          method,
          headers: {
            ...access.headers,
            ...(method === 'POST' && { 'content-length': '0' }),
          },
          lookup: publicOnlyLookup,
          signal: AbortSignal.timeout(timeoutMs),
        },
        (incoming) => resolve(toResponse(incoming)),
      );

      outgoing.on('error', () =>
        reject(
          new GithubActionsError(null, `${access.label} could not be reached`),
        ),
      );
      outgoing.end();
    } catch {
      reject(
        new GithubActionsError(null, `${access.label} could not be reached`),
      );
    }
  });
}

export async function readToolJson<T>(
  access: CiToolAccess,
  url: string,
): Promise<T> {
  const response = await ciToolFetch(access, url, 'GET');

  if (!response.ok) {
    await response.body?.cancel();

    throw new GithubActionsError(
      response.status,
      `${access.label} answered ${response.status}`,
    );
  }

  try {
    return JSON.parse(
      (await readLimited(response, MAX_JSON_BYTES)).toString('utf8'),
    ) as T;
  } catch (error) {
    if (error instanceof GithubActionsError) throw error;

    throw new GithubActionsError(
      null,
      `${access.label} sent an answer that could not be read`,
    );
  }
}

/** The end of a log, with the saved token hidden. */
export async function readToolLog(
  access: CiToolAccess,
  url: string,
): Promise<GithubJobLog> {
  const response = await ciToolFetch(access, url, 'GET', LOG_TIMEOUT_MS);

  if (!response.ok) {
    await response.body?.cancel();

    throw new GithubActionsError(
      response.status,
      `${access.label} answered ${response.status}`,
    );
  }

  try {
    const { tail, bytes, complete } = await readTail(response);
    const cutStart = bytes > tail.length;

    return {
      text: cleanJobLog(tail, cutStart, !complete, access.secrets),
      truncated: cutStart || !complete,
      bytes,
    };
  } catch {
    throw new GithubActionsError(null, 'The log could not be downloaded');
  }
}

/** Read access from a setting's saved headers; null without a token or when the run was on another host. */
export function gitlabAccess(
  ciUrl: string,
  stored: Record<string, string>,
  runUrl: string | undefined,
): CiToolAccess | null {
  const api = gitlabProject(ciUrl);
  const token = savedHeader(stored, 'private-token');

  if (!api || !token || !runUrl) return null;

  const origin = new URL(ciUrl).origin;

  try {
    if (new URL(runUrl).origin !== origin) return null;
  } catch {
    return null;
  }

  return {
    origin,
    base: api.base,
    label: 'GitLab',
    headers: {
      'private-token': token,
      accept: 'application/json',
      'user-agent': 'XISUITE-Test-Management',
    },
    secrets: tokenSecrets(token),
  };
}

/** Access with a token of the GitLab account connected in Integrations, only to that server's own host. */
export function gitlabBearerAccess(base: string, token: string): CiToolAccess {
  const authorization = `Bearer ${token}`;

  return {
    origin: new URL(base).origin,
    base,
    label: 'GitLab',
    headers: {
      authorization,
      accept: 'application/json',
      'user-agent': 'XISUITE-Test-Management',
    },
    secrets: tokenSecrets(authorization),
  };
}

const PIPELINE_STATES = new Map<unknown, CiToolState>([
  ['created', 'queued'],
  ['waiting_for_resource', 'queued'],
  ['preparing', 'queued'],
  ['pending', 'queued'],
  ['scheduled', 'queued'],
  ['manual', 'queued'],
  ['running', 'running'],
  ['success', 'passed'],
  ['failed', 'failed'],
  ['canceled', 'cancelled'],
  ['canceling', 'cancelled'],
  ['skipped', 'passed'],
]);

export interface GitlabPipeline {
  state: CiToolState;
  head_sha?: string;
  head_branch?: string;
}

export async function getPipeline(
  access: CiToolAccess,
  projectId: number,
  pipelineId: number,
): Promise<GitlabPipeline> {
  const pipeline = await readToolJson<{
    status?: unknown;
    sha?: unknown;
    ref?: unknown;
  }>(access, `${access.base}/projects/${projectId}/pipelines/${pipelineId}`);
  const branch = shortText(pipeline.ref);

  return {
    // An unknown status is waited on, up to the 24 hour limit.
    state: PIPELINE_STATES.get(pipeline.status) ?? 'queued',
    ...(isCommitSha(pipeline.sha) && { head_sha: pipeline.sha }),
    ...(branch && { head_branch: branch }),
  };
}

const JOB_STATES = new Map<unknown, [string, string | null]>([
  ['success', ['completed', 'success']],
  ['failed', ['completed', 'failure']],
  ['canceled', ['completed', 'cancelled']],
  ['skipped', ['completed', 'skipped']],
  ['manual', ['completed', 'skipped']],
  ['running', ['in_progress', null]],
]);

interface GitlabJobAnswer {
  id: number;
  name?: unknown;
  status?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  web_url?: unknown;
}

const textOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value ? value.slice(0, TEXT_LIMIT) : null;

/** The jobs of a pipeline, at most 100, in the shape GitHub's jobs are shown in. */
export async function listPipelineJobs(
  access: CiToolAccess,
  projectId: number,
  pipelineId: number,
): Promise<GithubJob[]> {
  const jobs = await readToolJson<unknown>(
    access,
    `${access.base}/projects/${projectId}/pipelines/${pipelineId}/jobs?per_page=100`,
  );

  if (!Array.isArray(jobs)) return [];

  return (jobs as GitlabJobAnswer[])
    .filter((job) => positiveId(job.id))
    .map((job) => {
      const [status, conclusion] = JOB_STATES.get(job.status) ?? [
        'queued',
        null,
      ];
      const page = textOrNull(job.web_url);

      return {
        id: String(job.id),
        name: textOrNull(job.name) ?? String(job.id),
        status,
        conclusion,
        started_at: textOrNull(job.started_at),
        completed_at: textOrNull(job.finished_at),
        html_url: page?.startsWith(`${access.origin}/`) ? page : null,
        steps: [],
      };
    });
}

export function readJobTrace(
  access: CiToolAccess,
  projectId: number,
  jobId: string,
): Promise<GithubJobLog> {
  return readToolLog(
    access,
    `${access.base}/projects/${projectId}/jobs/${jobId}/trace`,
  );
}

/**
 * A job's artifacts zip; null when the job kept none. GitLab may point to object
 * storage instead, which is followed once and gets no token.
 */
export async function downloadJobArtifacts(
  access: CiToolAccess,
  projectId: number,
  jobId: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const url = `${access.base}/projects/${projectId}/jobs/${jobId}/artifacts`;
  let file = await ciToolFetch(
    { ...access, headers: { ...access.headers, accept: '*/*' } },
    url,
    'GET',
    DOWNLOAD_TIMEOUT_MS,
  );

  if (file.status >= 300 && file.status < 400) {
    const location = file.headers.get('location');
    let target: string;

    await file.body?.cancel();

    if (!location) {
      throw new GithubActionsError(
        file.status,
        `${access.label} answered ${file.status}`,
      );
    }

    try {
      target = new URL(location, url).href;
      await assertPublicHttpUrl(target);
    } catch {
      throw new GithubActionsError(
        null,
        'The artifact address is not public',
        true,
      );
    }

    try {
      file = await fetch(target, {
        redirect: 'error',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch {
      throw new GithubActionsError(
        null,
        'The artifact could not be downloaded',
      );
    }
  }

  if (file.status === 404) {
    await file.body?.cancel();

    return null;
  }

  if (!file.ok) {
    await file.body?.cancel();

    throw new GithubActionsError(
      file.status,
      `${access.label} answered ${file.status}`,
    );
  }

  return readLimited(file, maxBytes);
}

export async function cancelPipeline(
  access: CiToolAccess,
  projectId: number,
  pipelineId: number,
): Promise<void> {
  const response = await ciToolFetch(
    access,
    `${access.base}/projects/${projectId}/pipelines/${pipelineId}/cancel`,
    'POST',
  );

  await response.body?.cancel();

  if (!response.ok) {
    throw new GithubActionsError(
      response.status,
      `GitLab answered ${response.status}`,
    );
  }
}
