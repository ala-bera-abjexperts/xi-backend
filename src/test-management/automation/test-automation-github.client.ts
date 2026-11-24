import { assertPublicHttpUrl } from '../../common/security/ssrf-guard';
import {
  isWorkflowFileName,
  WORKFLOW_CONTENT_BYTES,
} from './automation-inputs';

const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const LOG_TIMEOUT_MS = 30_000;

// Only the end of a log is shown; reading stops here even if the log goes on.
const LOG_TAIL_BYTES = 256 * 1024;
const LOG_MAX_READ_BYTES = 20 * 1024 * 1024;
const LOG_TEXT_LIMIT = 255;

// No file name in them: the push webhook reads commit messages for task keys.
const WORKFLOW_COMMIT_MESSAGE = 'Add workflow file for Test Management';
const WORKFLOW_UPDATE_MESSAGE = 'Update workflow file for Test Management';

export interface GithubAccess {
  apiUrl: string;
  fullName: string;
  token: string;
}

export interface GithubRun {
  status: string;
  conclusion: string | null;
  head_sha?: unknown;
  head_branch?: unknown;
  run_attempt?: unknown;
  event?: unknown;
}

/** What a run was started from, only in shapes that are safe to show. */
export interface GithubRunOrigin {
  head_sha?: string;
  head_branch?: string;
  run_attempt?: number;
  event?: string;
}

export interface GithubJobLog {
  text: string;
  truncated: boolean;
  bytes: number;
}

export interface GithubArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
}

export interface GithubJobStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface GithubJob {
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  steps: GithubJobStep[];
}

export class GithubActionsError extends Error {
  // Permanent: trying again can't help, such as a file over the limit.
  constructor(
    readonly status: number | null,
    message: string,
    readonly permanent = false,
  ) {
    super(message);
  }
}

export function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'XISUITE-Test-Management',
  };
}

async function call(
  access: GithubAccess,
  path: string,
  method: 'GET' | 'POST',
): Promise<Response> {
  try {
    return await fetch(
      `${access.apiUrl}/repos/${access.fullName}/actions/${path}`,
      {
        method,
        headers: githubHeaders(access.token),
        redirect: 'manual',
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      },
    );
  } catch {
    throw new GithubActionsError(null, 'GitHub could not be reached');
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new GithubActionsError(
      response.status,
      `GitHub answered ${response.status}`,
    );
  }

  return (await response.json()) as T;
}

const shortText = (value: unknown): string | undefined =>
  typeof value === 'string' && value
    ? value.slice(0, LOG_TEXT_LIMIT)
    : undefined;

export function runOrigin(run: GithubRun): GithubRunOrigin {
  const origin: GithubRunOrigin = {};
  const branch = shortText(run.head_branch);
  const event = shortText(run.event);

  if (typeof run.head_sha === 'string' && /^[0-9a-f]{40}$/.test(run.head_sha)) {
    origin.head_sha = run.head_sha;
  }

  if (branch) origin.head_branch = branch;
  if (event) origin.event = event;

  if (
    typeof run.run_attempt === 'number' &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0
  ) {
    origin.run_attempt = run.run_attempt;
  }

  return origin;
}

export async function getRun(
  access: GithubAccess,
  runId: number,
): Promise<GithubRun> {
  return readJson<GithubRun>(await call(access, `runs/${runId}`, 'GET'));
}

/** False when GitHub says the run can't be cancelled any more, because it already ended. */
export async function cancelRun(
  access: GithubAccess,
  runId: number,
): Promise<boolean> {
  const response = await call(access, `runs/${runId}/cancel`, 'POST');

  if (response.status === 409) return false;
  if (response.ok) return true;

  throw new GithubActionsError(
    response.status,
    `GitHub answered ${response.status}`,
  );
}

export async function listArtifacts(
  access: GithubAccess,
  runId: number,
): Promise<GithubArtifact[]> {
  const { artifacts } = await readJson<{ artifacts?: GithubArtifact[] }>(
    await call(access, `runs/${runId}/artifacts?per_page=100`, 'GET'),
  );

  return artifacts ?? [];
}

/** Jobs and steps of a run, at most 100, with only the fields a page shows. */
export async function listRunJobs(
  access: GithubAccess,
  runId: number,
): Promise<GithubJob[]> {
  const { jobs } = await readJson<{
    jobs?: (Omit<GithubJob, 'id'> & { id: number })[];
  }>(await call(access, `runs/${runId}/jobs?per_page=100`, 'GET'));

  return (jobs ?? []).map((job) => ({
    id: String(job.id),
    name: job.name,
    status: job.status,
    conclusion: job.conclusion ?? null,
    started_at: job.started_at ?? null,
    completed_at: job.completed_at ?? null,
    html_url: job.html_url?.startsWith('https://') ? job.html_url : null,
    steps: (job.steps ?? []).map((step) => ({
      number: step.number,
      name: step.name,
      status: step.status,
      conclusion: step.conclusion ?? null,
      started_at: step.started_at ?? null,
      completed_at: step.completed_at ?? null,
    })),
  }));
}

async function workflowFolder(
  access: GithubAccess,
  method: 'GET' | 'PUT',
  file = '',
  body?: string,
): Promise<Response> {
  const path = file ? `/${encodeURIComponent(file)}` : '';

  try {
    return await fetch(
      `${access.apiUrl}/repos/${access.fullName}/contents/.github/workflows${path}`,
      {
        method,
        headers: {
          ...githubHeaders(access.token),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      },
    );
  } catch {
    throw new GithubActionsError(null, 'GitHub could not be reached');
  }
}

/** Only files a setting could be saved with. No ref, so GitHub uses its real default branch. */
export async function listWorkflowFiles(
  access: GithubAccess,
): Promise<string[]> {
  const response = await workflowFolder(access, 'GET');

  if (response.status === 404) return [];

  const items = await readJson<unknown>(response);

  if (!Array.isArray(items)) return [];

  return (items as { name: string; type: string }[])
    .filter((item) => item.type === 'file' && isWorkflowFileName(item.name))
    .map((item) => item.name)
    .sort();
}

/** A file on the default branch; 'unreadable' when it is too long for the editor or isn't text. */
export async function readWorkflowFile(
  access: GithubAccess,
  file: string,
): Promise<{ content: string; sha: string } | 'unreadable' | null> {
  const response = await workflowFolder(access, 'GET', file);

  if (response.status === 404) return null;

  const item = await readJson<{
    type?: string;
    size?: number;
    encoding?: string;
    content?: string;
    sha?: string;
  }>(response);

  if (item.type !== 'file' || !item.sha) return null;

  if ((item.size ?? 0) > WORKFLOW_CONTENT_BYTES || item.encoding !== 'base64') {
    return 'unreadable';
  }

  const bytes = Buffer.from(item.content ?? '', 'base64');
  const content = bytes.toString('utf8');

  if (!Buffer.from(content, 'utf8').equals(bytes)) return 'unreadable';

  return { content, sha: item.sha };
}

/**
 * Commits a new file to the default branch. Sending no sha makes GitHub refuse a file that already
 * exists, so this can never overwrite one.
 */
export async function createWorkflowFile(
  access: GithubAccess,
  file: string,
  content: string,
): Promise<'created' | 'exists'> {
  const response = await workflowFolder(
    access,
    'PUT',
    file,
    JSON.stringify({
      message: WORKFLOW_COMMIT_MESSAGE,
      content: Buffer.from(content, 'utf8').toString('base64'),
    }),
  );

  if (response.ok) return 'created';

  const answer = response.status === 422 ? await response.text() : '';

  if (answer.includes('sha')) return 'exists';

  throw new GithubActionsError(
    response.status,
    `GitHub answered ${response.status}`,
  );
}

/** Commits to the default branch only if the file is still the version that was read. */
export async function updateWorkflowFile(
  access: GithubAccess,
  file: string,
  content: string,
  sha: string,
): Promise<'updated' | 'changed'> {
  const response = await workflowFolder(
    access,
    'PUT',
    file,
    JSON.stringify({
      message: WORKFLOW_UPDATE_MESSAGE,
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha,
    }),
  );

  if (response.ok) return 'updated';

  const answer = response.status === 422 ? await response.text() : '';

  if (response.status === 409 || answer.includes('sha')) return 'changed';

  throw new GithubActionsError(
    response.status,
    `GitHub answered ${response.status}`,
  );
}

export async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0);

  if (declared > maxBytes || !response.body) {
    throw new GithubActionsError(null, 'The artifact is too large', true);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    size += value.length;

    // The stated length can be wrong, so what really arrives is counted too.
    if (size > maxBytes) {
      await reader.cancel();

      throw new GithubActionsError(null, 'The artifact is too large', true);
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

/** GitHub answers with a short-lived storage address, which gets no token. */
export async function downloadArtifact(
  access: GithubAccess,
  artifactId: number,
  maxBytes: number,
): Promise<Buffer> {
  const pointer = await call(access, `artifacts/${artifactId}/zip`, 'GET');
  const location = pointer.headers.get('location');

  if (pointer.status < 300 || pointer.status >= 400 || !location) {
    throw new GithubActionsError(
      pointer.status,
      `GitHub answered ${pointer.status}`,
    );
  }

  try {
    await assertPublicHttpUrl(location);
  } catch {
    throw new GithubActionsError(
      null,
      'The artifact address is not public',
      true,
    );
  }

  let file: Response;

  try {
    file = await fetch(location, {
      redirect: 'error',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new GithubActionsError(null, 'The artifact could not be downloaded');
  }

  if (!file.ok) {
    throw new GithubActionsError(
      file.status,
      `The artifact download answered ${file.status}`,
    );
  }

  return readLimited(file, maxBytes);
}

/** Keeps only the last bytes while reading, and stops at a hard limit, so a huge log never fills memory. */
export async function readTail(
  response: Response,
): Promise<{ tail: Buffer; bytes: number; complete: boolean }> {
  if (!response.body)
    return { tail: Buffer.alloc(0), bytes: 0, complete: true };

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let kept = 0;
  let bytes = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    bytes += value.length;
    kept += value.length;
    chunks.push(Buffer.from(value));

    while (chunks.length > 1 && kept - chunks[0].length >= LOG_TAIL_BYTES) {
      kept -= chunks.shift()?.length ?? 0;
    }

    if (bytes >= LOG_MAX_READ_BYTES) {
      await reader.cancel();

      return {
        tail: Buffer.concat(chunks).subarray(-LOG_TAIL_BYTES),
        bytes,
        complete: false,
      };
    }
  }

  return {
    tail: Buffer.concat(chunks).subarray(-LOG_TAIL_BYTES),
    bytes,
    complete: true,
  };
}

/** Drops the bytes of a character cut in half at either end. */
function wholeCharacters(
  buffer: Buffer,
  cutStart: boolean,
  cutEnd: boolean,
): Buffer {
  let start = 0;
  let end = buffer.length;

  while (
    cutStart &&
    start < 3 &&
    start < end &&
    (buffer[start] & 0xc0) === 0x80
  ) {
    start += 1;
  }

  for (let back = 1; cutEnd && back <= 3 && end - back >= start; back += 1) {
    const byte = buffer[end - back];

    if ((byte & 0xc0) === 0x80) continue;

    const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;

    if (size > back) end -= back;

    break;
  }

  return buffer.subarray(start, end);
}

// Colour and cursor codes of a terminal, which a page can't show.
const TERMINAL_CODES =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** Plain text of the end of a log: terminal codes and control characters out, secrets hidden. */
export function cleanJobLog(
  tail: Buffer,
  cutStart: boolean,
  cutEnd: boolean,
  secrets: string[],
): string {
  const text = wholeCharacters(tail, cutStart, cutEnd)
    .toString('utf8')
    .replace(TERMINAL_CODES, '')
    .replace(/\r\n?/g, '\n');
  const plain = [...text]
    .filter((char) => {
      const code = char.charCodeAt(0);

      return (
        char === '\n' ||
        char === '\t' ||
        !(code < 0x20 || (code >= 0x7f && code <= 0x9f))
      );
    })
    .join('');

  return secrets
    .filter((secret) => secret.length >= 4)
    .reduce((out, secret) => out.split(secret).join('***'), plain);
}

/** GitHub answers with a short-lived storage address for the log, which gets no token. */
export async function readJobLog(
  access: GithubAccess,
  jobId: string,
): Promise<GithubJobLog> {
  const pointer = await call(access, `jobs/${jobId}/logs`, 'GET');
  const location = pointer.headers.get('location');

  if (pointer.status < 300 || pointer.status >= 400 || !location) {
    throw new GithubActionsError(
      pointer.status,
      `GitHub answered ${pointer.status}`,
    );
  }

  try {
    await assertPublicHttpUrl(location);
  } catch {
    throw new GithubActionsError(null, 'The log address is not public', true);
  }

  try {
    const file = await fetch(location, {
      redirect: 'error',
      signal: AbortSignal.timeout(LOG_TIMEOUT_MS),
    });

    if (!file.ok) {
      throw new GithubActionsError(
        file.status,
        `The log download answered ${file.status}`,
      );
    }

    const { tail, bytes, complete } = await readTail(file);
    const cutStart = bytes > tail.length;

    return {
      text: cleanJobLog(tail, cutStart, !complete, [access.token]),
      truncated: cutStart || !complete,
      bytes,
    };
  } catch (error) {
    if (error instanceof GithubActionsError) throw error;

    throw new GithubActionsError(null, 'The log could not be downloaded');
  }
}

/**
 * Saves a repository Actions variable: updates it, or creates it when it does not exist yet.
 * Returns GitHub's answer status; the value is never logged or echoed.
 */
export async function putRepositoryVariable(
  access: GithubAccess,
  name: string,
  value: string,
): Promise<number> {
  const base = `${access.apiUrl}/repos/${access.fullName}/actions/variables`;

  const request = (url: string, method: 'PATCH' | 'POST') =>
    fetch(url, {
      method,
      headers: {
        ...githubHeaders(access.token),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name, value }),
      redirect: 'manual',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

  try {
    const updated = await request(
      `${base}/${encodeURIComponent(name)}`,
      'PATCH',
    );

    if (updated.status !== 404) return updated.status;

    return (await request(base, 'POST')).status;
  } catch {
    throw new GithubActionsError(null, 'GitHub could not be reached');
  }
}
