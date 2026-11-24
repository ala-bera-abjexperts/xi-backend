/**
 * @fileoverview Small pure helpers for talking to a Jenkins server: address rules, sign-in header and
 * reading the job list.
 * @module src/ci-servers/jenkins-api
 */

import { normalizeServerUrl } from '../git-integrations/git-server-address.util';

export const JOBS_TREE =
  'jobs[name,url,_class,property[parameterDefinitions[name]],jobs[name,url,_class,property[parameterDefinitions[name]]]]';

export type JenkinsJobKind = 'job' | 'folder' | 'multibranch';

export interface IJenkinsJob {
  name: string;
  url: string;
  kind: JenkinsJobKind;
  has_parameters: boolean;
}

interface IRawJob {
  name?: unknown;
  url?: unknown;
  _class?: unknown;
  property?: unknown;
  jobs?: unknown;
}

/**
 * `https://CI.Example.com:8443/jenkins/` → `https://ci.example.com:8443/jenkins`.
 * Returns null for anything that is not a plain https address without a query, hash or user name.
 */
export function normalizeJenkinsUrl(raw: string): string | null {
  const text = String(raw ?? '').trim();

  // The shared normaliser drops a query or hash silently; here they are refused.
  if (/[?#]/.test(text)) return null;

  try {
    return normalizeServerUrl(text, false).baseUrl;
  } catch {
    return null;
  }
}

/** Whether `url` is a job address on the server at `baseUrl` (host compared without case). */
export function isJobUrlOf(baseUrl: string, url: string): boolean {
  let target: URL;

  try {
    target = new URL(url);
  } catch {
    return false;
  }

  return `${target.protocol}//${target.host}${target.pathname}`.startsWith(
    `${baseUrl}/job/`,
  );
}

export function basicAuthorization(username: string, token: string): string {
  return `Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}`;
}

function kindOf(job: IRawJob): JenkinsJobKind {
  const type = typeof job._class === 'string' ? job._class : '';

  if (type.includes('MultiBranch')) return 'multibranch';
  if (type.includes('Folder') || Array.isArray(job.jobs)) return 'folder';

  return 'job';
}

function hasParameters(job: IRawJob): boolean {
  if (!Array.isArray(job.property)) return false;

  return job.property.some((property: unknown) => {
    const definitions =
      property && typeof property === 'object'
        ? (property as { parameterDefinitions?: unknown }).parameterDefinitions
        : undefined;

    return Array.isArray(definitions) && definitions.length > 0;
  });
}

function rawJobs(value: unknown): IRawJob[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is IRawJob => !!entry && typeof entry === 'object',
      )
    : [];
}

/** Flat list of jobs and folders two levels deep; entries whose address is not on the server are dropped. */
export function flattenJobs(baseUrl: string, answer: unknown): IJenkinsJob[] {
  const top =
    answer && typeof answer === 'object'
      ? rawJobs((answer as { jobs?: unknown }).jobs)
      : [];
  const result: IJenkinsJob[] = [];

  const add = (job: IRawJob, prefix: string) => {
    if (typeof job.name !== 'string' || typeof job.url !== 'string') return;
    if (!isJobUrlOf(baseUrl, job.url)) return;

    result.push({
      name: `${prefix}${job.name}`,
      url: job.url,
      kind: kindOf(job),
      has_parameters: hasParameters(job),
    });
  };

  for (const job of top) {
    add(job, '');

    if (typeof job.name !== 'string') continue;

    for (const child of rawJobs(job.jobs)) add(child, `${job.name}/`);
  }

  return result;
}
