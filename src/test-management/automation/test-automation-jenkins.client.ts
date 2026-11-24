import {
  GithubActionsError,
  type GithubJob,
  type GithubJobLog,
} from './test-automation-github.client';
import {
  ciToolFetch,
  decoded,
  readToolJson,
  readToolLog,
  savedHeader,
  tokenSecrets,
  type CiToolAccess,
  type CiToolState,
} from './test-automation-gitlab.client';

const NAME_LIMIT = 255;

export interface JenkinsCi {
  provider: 'jenkins';
  state: CiToolState;
  full_name: string;
  queue_url?: string;
  run_id?: number;
  html_url?: string;
}

/** "folder/job" from a /job/folder/job/job/build address; null for any other address. */
export function jenkinsJobName(ciUrl: string): string | null {
  let path: string;

  try {
    path = new URL(ciUrl).pathname;
  } catch {
    return null;
  }

  if (!/\/job\/[^/]+\/(?:build|buildWithParameters)\/?$/.test(path)) {
    return null;
  }

  const names = [...path.matchAll(/\/job\/([^/]+)/g)].map((found) =>
    decoded(found[1]),
  );

  return names.every((name): name is string => Boolean(name))
    ? names.join('/').slice(0, NAME_LIMIT)
    : null;
}

/** Jenkins' queue item for the build, only on the setting's own host. */
function queueUrl(ciUrl: string, location: string | undefined): string | null {
  if (!location) return null;

  try {
    const target = new URL(location, ciUrl);
    const found = /^(.*\/queue\/item\/\d{1,20})\/?$/.exec(target.pathname);

    return target.protocol === 'https:' &&
      target.origin === new URL(ciUrl).origin &&
      found
      ? `${target.origin}${found[1]}/`
      : null;
  } catch {
    return null;
  }
}

/**
 * What a queued Jenkins build is followed by; null when the address isn't a
 * Jenkins build address or no login to read it with is saved.
 * `connected` says a server connected in Integrations signs the reads in instead.
 */
export function jenkinsStart(
  ciUrl: string,
  stored: Record<string, string>,
  location: string | undefined,
  connected = false,
): JenkinsCi | null {
  const fullName = jenkinsJobName(ciUrl);

  if (!fullName || (!connected && !savedHeader(stored, 'authorization'))) {
    return null;
  }

  const queue = queueUrl(ciUrl, location);

  return queue
    ? {
        provider: 'jenkins',
        state: 'queued',
        full_name: fullName,
        queue_url: queue,
      }
    : { provider: 'jenkins', state: 'untracked', full_name: fullName };
}

/** Read access from a setting's saved login; null without one or when the run was on another host. */
export function jenkinsAccess(
  ciUrl: string,
  stored: Record<string, string>,
  runUrl: string | undefined,
): CiToolAccess | null {
  const token = savedHeader(stored, 'authorization');

  if (!jenkinsJobName(ciUrl) || !token || !runUrl) return null;

  const origin = new URL(ciUrl).origin;

  try {
    if (new URL(runUrl).origin !== origin) return null;
  } catch {
    return null;
  }

  return {
    origin,
    base: origin,
    label: 'Jenkins',
    headers: {
      authorization: token,
      accept: 'application/json',
      'user-agent': 'XISUITE-Test-Management',
    },
    secrets: tokenSecrets(token),
  };
}

interface JenkinsBuild {
  building?: unknown;
  result?: unknown;
  timestamp?: unknown;
  duration?: unknown;
}

const BUILD_STATES = new Map<unknown, CiToolState>([
  ['SUCCESS', 'passed'],
  ['FAILURE', 'failed'],
  ['UNSTABLE', 'failed'],
  ['ABORTED', 'cancelled'],
  ['NOT_BUILT', 'cancelled'],
]);

const CONCLUSIONS = new Map<unknown, string>([
  ['SUCCESS', 'success'],
  ['FAILURE', 'failure'],
  ['UNSTABLE', 'failure'],
  ['ABORTED', 'cancelled'],
  ['NOT_BUILT', 'cancelled'],
]);

function buildState(build: JenkinsBuild): CiToolState {
  if (build.building === true) return 'running';
  if (typeof build.result !== 'string') return 'queued';

  return BUILD_STATES.get(build.result) ?? 'failed';
}

const readBuild = (access: CiToolAccess, buildUrl: string) =>
  readToolJson<JenkinsBuild>(
    access,
    `${buildUrl}api/json?tree=building,result,timestamp,duration`,
  );

/** A build address Jenkins gave, kept only when it is on the setting's own host. */
function sameHostBuild(access: CiToolAccess, raw: unknown): string {
  try {
    const url = new URL(typeof raw === 'string' ? raw : '');

    if (url.protocol === 'https:' && url.origin === access.origin) {
      return `${url.origin}${url.pathname.replace(/\/?$/, '/')}`;
    }
  } catch {
    // Falls through to the refusal below.
  }

  throw new GithubActionsError(
    null,
    'Jenkins named a build that is not on the host of the setting',
    true,
  );
}

/** The state now, and the build's number and address once it has left the queue. */
export async function jenkinsProgress(
  access: CiToolAccess,
  ci: { run_id?: number; html_url?: string; queue_url?: string },
): Promise<{ state: CiToolState; run_id?: number; html_url?: string }> {
  if (ci.run_id && ci.html_url) {
    return { state: buildState(await readBuild(access, ci.html_url)) };
  }

  if (!ci.queue_url) return { state: 'queued' };

  const item = await readToolJson<{
    cancelled?: unknown;
    executable?: { number?: unknown; url?: unknown } | null;
  }>(
    access,
    `${ci.queue_url}api/json?tree=cancelled,executable%5Bnumber,url%5D`,
  );

  if (item.cancelled === true) return { state: 'cancelled' };

  const number = item.executable?.number;

  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    return { state: 'queued' };
  }

  const buildUrl = sameHostBuild(access, item.executable?.url);

  return {
    state: buildState(await readBuild(access, buildUrl)),
    run_id: number,
    html_url: buildUrl,
  };
}

const isoOrNull = (value: number): string | null =>
  Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;

/** The build as the only job, in the shape GitHub's jobs are shown in. */
export async function jenkinsBuildJob(
  access: CiToolAccess,
  name: string,
  number: number,
  buildUrl: string,
): Promise<GithubJob> {
  const build = await readBuild(access, buildUrl);
  const done = build.building !== true && typeof build.result === 'string';
  const started = typeof build.timestamp === 'number' ? build.timestamp : 0;
  const duration = typeof build.duration === 'number' ? build.duration : 0;

  return {
    id: String(number),
    name,
    status:
      build.building === true ? 'in_progress' : done ? 'completed' : 'queued',
    conclusion: done ? (CONCLUSIONS.get(build.result) ?? 'failure') : null,
    started_at: isoOrNull(started),
    completed_at: done && started ? isoOrNull(started + duration) : null,
    html_url: buildUrl,
    steps: [],
  };
}

export function readConsole(
  access: CiToolAccess,
  buildUrl: string,
): Promise<GithubJobLog> {
  return readToolLog(access, `${buildUrl}consoleText`);
}

async function post(access: CiToolAccess, url: string): Promise<void> {
  const response = await ciToolFetch(access, url, 'POST');

  await response.body?.cancel();

  // Jenkins answers a stop with a redirect, which is not followed.
  if (response.status >= 400) {
    throw new GithubActionsError(
      response.status,
      `Jenkins answered ${response.status}`,
    );
  }
}

export function stopBuild(
  access: CiToolAccess,
  buildUrl: string,
): Promise<void> {
  return post(access, `${buildUrl}stop`);
}

export async function cancelQueueItem(
  access: CiToolAccess,
  queueUrl: string,
): Promise<void> {
  const found = /^(.*\/)queue\/item\/(\d{1,20})\/$/.exec(queueUrl);

  if (!found) {
    throw new GithubActionsError(null, 'The queue item is not valid', true);
  }

  await post(access, `${found[1]}queue/cancelItem?id=${found[2]}`);
}
