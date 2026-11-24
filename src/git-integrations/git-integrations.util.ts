/**
 * @fileoverview Small helpers shared by the GitHub and GitLab connect flows: a signed short-lived
 * token for data that must survive a redirect without being stored, the OAuth `state` provider tag,
 * and the address the browser is sent back to.
 * @module src/git-integrations/git-integrations.util
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';

import { secret } from '../calendar/integrations/calendar-oauth.state';
import { isAllowedConfiguredOrSubdomainOrigin } from '../common/cors/site-studio-cors.util';
import type {
  GitBuildState,
  GitProvider,
  GitPullRequestDisplayState,
  GitPullRequestState,
  GitReviewState,
  IGitBuildDto,
  IGitBuildSummaryDto,
  IGitConnectionRow,
  IGitRepositoryRow,
} from './git-integrations.types';
import type { GitDevelopmentEvent } from '../workflow-engine/handlers/triggers/git-development-event.trigger';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const AZURE_DEVOPS_HOST = 'dev.azure.com';

/**
 * Whether a real secret signs OAuth states and tokens. The shared calendar `secret()` falls back
 * to a hardcoded literal when none is configured, which would let anyone forge a connect state;
 * the Git flows refuse to run in that case.
 */
export function hasStateSecret(): boolean {
  // Same precedence as the shared secret(): empty values are skipped, the first real one is used.
  return !!(
    process.env.CALENDAR_STATE_SECRET ||
    process.env.AI_ENCRYPTION_SECRET ||
    process.env.JWT_SECRET
  );
}

/** @throws {BadRequestException} 'not_configured' when no real signing secret is set. */
export function assertStateSecret(): void {
  if (!hasStateSecret()) throw new BadRequestException('not_configured');
}

function sign(body: string): string {
  if (!hasStateSecret())
    throw new Error('No state signing secret is configured');

  // Domain-separated from the calendar state, which shares the secret.
  return createHmac('sha256', secret())
    .update(`git:${body}`)
    .digest('base64url');
}

/** Signs `payload` so it can travel through the browser and be trusted when it comes back. */
export function signToken(payload: unknown, ttlMs = DEFAULT_TTL_MS): string {
  const body = Buffer.from(
    JSON.stringify({ d: payload, e: Date.now() + ttlMs }),
  ).toString('base64url');

  return `${body}.${sign(body)}`;
}

/** Null when the token was tampered with, is malformed, or has expired. */
export function readToken<T>(token: string | undefined): T | null {
  if (!token) return null;

  const [body, signature] = token.split('.');

  if (!body || !signature) return null;

  const expected = sign(body);

  if (
    expected.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      d: T;
      e: number;
    };

    return parsed.e && parsed.e >= Date.now() ? parsed.d : null;
  } catch {
    return null;
  }
}

/**
 * The PKCE verifier of one sign-in. Derived from the signed state with the server's secret, so nothing has to
 * be stored between the redirect and the callback, and seeing the state does not reveal it.
 */
export function pkceVerifier(state: string): string {
  return sign(`pkce:${state}`);
}

/**
 * The `provider` value carried in the OAuth state: `git:<provider>`, or `git:<provider>@<serverId>` for an
 * organization's own server (ticket 11), each optionally followed by `:<connectionId>` when reconnecting.
 * The `git:` prefix keeps calendar callbacks from accepting it.
 */
export function stateProviderTag(
  provider: GitProvider,
  connectionId?: string,
  serverId?: string | null,
): string {
  const base = serverId ? `git:${provider}@${serverId}` : `git:${provider}`;

  return connectionId ? `${base}:${connectionId}` : base;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export function parseStateProviderTag(tag: string): {
  provider: GitProvider;
  connectionId: string | null;
  serverId?: string;
} | null {
  const match = new RegExp(
    `^git:(github|gitlab|azure_devops)(?:@(${UUID}))?(?::([0-9a-f-]{36}))?$`,
  ).exec(tag);

  return match
    ? {
        provider: match[1] as GitProvider,
        connectionId: match[3] ?? null,
        ...(match[2] && { serverId: match[2] }),
      }
    : null;
}

/** Where a personal-account link flow returns to: a fixed page, never a URL. */
export type GitIdentityReturnPage = 'profile' | 'integrations';

/**
 * The OAuth state tag of a personal-account link: `git:<provider>[@<serverId>]:identity:<page>`.
 * Deliberately NOT accepted by {@link parseStateProviderTag}, so the organization connect handlers
 * reject it.
 */
export function identityStateTag(
  provider: GitProvider,
  page: GitIdentityReturnPage,
  serverId?: string | null,
): string {
  return `git:${provider}${serverId ? `@${serverId}` : ''}:identity:${page}`;
}

export function parseIdentityStateTag(tag: string): {
  provider: GitProvider;
  page: GitIdentityReturnPage;
  serverId?: string;
} | null {
  const match = new RegExp(
    `^git:(github|gitlab|azure_devops)(?:@(${UUID}))?:identity:(profile|integrations)$`,
  ).exec(tag);

  return match
    ? {
        provider: match[1] as GitProvider,
        page: match[3] as GitIdentityReturnPage,
        ...(match[2] && { serverId: match[2] }),
      }
    : null;
}

/** The page a personal-account link flow comes back to, with the given query parameters. */
export function identityReturnUrl(
  returnTo: string | undefined,
  provider: GitProvider,
  page: GitIdentityReturnPage,
  params: Record<string, string> = {},
): string {
  if (page === 'integrations')
    return integrationsPageUrl(returnTo, provider, params);

  const query = new URLSearchParams({ tab: 'connectedAccounts', ...params });

  query.set('tab', 'connectedAccounts');

  return `${safeReturnOrigin(returnTo)}/user-profile?${query.toString()}`;
}

function configuredOrigins(): string[] {
  return (
    process.env.ALLOWED_ORIGINS ||
    process.env.FRONTEND_URL ||
    'http://localhost:3000'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * The origin to send the admin back to: the tenant they started from when it is one of ours
 * (a configured origin or a subdomain of one), otherwise the default frontend. Never an
 * arbitrary address, so the callback cannot be used as an open redirect.
 */
export function safeReturnOrigin(returnTo: string | undefined): string {
  const fallback = (
    process.env.FRONTEND_URL ||
    process.env.APP_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '');

  if (!returnTo) return fallback;

  try {
    const origin = new URL(returnTo).origin;

    return isAllowedConfiguredOrSubdomainOrigin(origin, configuredOrigins())
      ? origin
      : fallback;
  } catch {
    return fallback;
  }
}

/** Tenant Configuration > Integrations > <provider>, with the given query parameters. */
export function integrationsPageUrl(
  returnTo: string | undefined,
  provider: GitProvider,
  params: Record<string, string> = {},
): string {
  const query = new URLSearchParams({
    tab: 'integrations',
    integration: provider,
    ...params,
  });

  // Callers' params must never redirect to a different tab or provider.
  query.set('tab', 'integrations');
  query.set('integration', provider);

  return `${safeReturnOrigin(returnTo)}/tenant-config?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Pull requests (ticket 4)
// ---------------------------------------------------------------------------

/**
 * A task key inside free text: `<SPACEKEY>-T<n>` (space keys are 2-8 letters/digits) or `TASK-<n>`
 * (tasks without a space). Whole keys only: not preceded by a letter or digit, and not followed by
 * another digit, so `XE-T6560` never yields `XE-T656`. `_`, `/`, `-` and spaces all delimit.
 */
const TASK_KEY_IN_TEXT =
  /(?<![A-Za-z0-9])([A-Za-z0-9]{1,8}-T\d+|TASK-\d+)(?!\d)/gi;

/** ponytail: caps against hostile or huge descriptions; raise if a real pull request needs more. */
const MAX_SCANNED_CHARS = 64 * 1024;
export const MAX_TASK_KEYS = 50;

/** Every distinct task key (upper case) in the given texts, in order of first appearance. */
export function extractTaskKeys(
  ...texts: (string | null | undefined)[]
): string[] {
  const keys = new Set<string>();

  for (const text of texts) {
    if (!text) continue;

    for (const match of text
      .slice(0, MAX_SCANNED_CHARS)
      .matchAll(TASK_KEY_IN_TEXT)) {
      keys.add(match[1].toUpperCase());

      if (keys.size >= MAX_TASK_KEYS) return [...keys];
    }
  }

  return [...keys];
}

export interface IParsedPullRequestUrl {
  provider: GitProvider;
  host: string;
  /** `owner/repo` (GitHub), the project's full path (GitLab) or `organization/project/repository` (Azure DevOps). */
  fullName: string;
  number: number;
}

const GITHUB_PULL_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/;
const GITLAB_MERGE_REQUEST_PATH =
  /^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/.*)?$/;
/** The organization is in the host (`<org>.visualstudio.com`) or the path (`dev.azure.com/<org>`); see below. */
const AZURE_PULL_PATH =
  /^\/(?:([^/]+)\/)?_git\/([^/]+)\/pullrequest\/(\d+)(?:\/.*)?$/i;
const AZURE_LEGACY_HOST = /^([a-z0-9-]+)\.visualstudio\.com$/;
const MAX_PR_NUMBER = 2_147_483_647;

/**
 * `dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>` and `<org>.visualstudio.com/[DefaultCollection/]
 * <project>/_git/<repo>/pullrequest/<id>`, both normalised to one host and name. The project may be left out when
 * the repository has the project's name.
 */
function parseAzurePullRequestPath(
  host: string,
  pathname: string,
): IParsedPullRequestUrl | null {
  const legacy = AZURE_LEGACY_HOST.exec(host);
  const segments = pathname.split('/');
  let organization: string | undefined;
  let rest: string;

  if (legacy) {
    organization = legacy[1];
    rest = pathname.replace(/^\/DefaultCollection(?=\/)/i, '');
  } else {
    organization = segments[1];
    rest = `/${segments.slice(2).join('/')}`;
  }

  const match = AZURE_PULL_PATH.exec(rest);

  if (!organization || !match) return null;

  const number = Number(match[3]);

  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_PR_NUMBER)
    return null;

  try {
    const repository = decodeURIComponent(match[2]);
    const project = match[1] ? decodeURIComponent(match[1]) : repository;

    return {
      provider: 'azure_devops',
      host: AZURE_DEVOPS_HOST,
      fullName: `${decodeURIComponent(organization)}/${project}/${repository}`,
      number,
    };
  } catch {
    return null;
  }
}

/**
 * A pasted pull request / merge request address, e.g. `https://github.com/o/r/pull/12/files` or
 * `https://gitlab.com/group/sub/project/-/merge_requests/7#note_1`. Null when it is neither.
 */
export function parsePullRequestUrl(
  input: string,
): IParsedPullRequestUrl | null {
  let url: URL;

  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.host.toLowerCase().replace(/^www\./, '');

  // By host, and first: the paths below say nothing about the host.
  if (host === AZURE_DEVOPS_HOST || AZURE_LEGACY_HOST.test(host))
    return parseAzurePullRequestPath(host, url.pathname);

  const github = GITHUB_PULL_PATH.exec(url.pathname);
  const gitlab = github ? null : GITLAB_MERGE_REQUEST_PATH.exec(url.pathname);

  if (!github && !gitlab) return null;

  let fullName: string;

  try {
    fullName = github
      ? `${decodeURIComponent(github[1])}/${decodeURIComponent(github[2])}`
      : decodeURIComponent(gitlab![1]);
  } catch {
    return null;
  }

  const number = Number(github ? github[3] : gitlab![2]);

  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_PR_NUMBER)
    return null;

  return { provider: github ? 'github' : 'gitlab', host, fullName, number };
}

/** Whether events for this repository are processed: connection not disconnected, repository enabled and still granted. */
export function isRepositoryLive(
  connection: Pick<IGitConnectionRow, 'status'>,
  repository: Pick<IGitRepositoryRow, 'is_enabled' | 'removed_at'>,
): boolean {
  return (
    connection.status !== 'disconnected' &&
    repository.is_enabled &&
    !repository.removed_at
  );
}

// ---------------------------------------------------------------------------
// Development panel (ticket 5)
// ---------------------------------------------------------------------------

/** What a pull request row shows: merged and closed win, then draft, then the reviewers' verdict. */
export function displayStateOf(pr: {
  state: GitPullRequestState;
  isDraft: boolean;
  reviewState: GitReviewState | null;
}): GitPullRequestDisplayState {
  if (pr.state !== 'open') return pr.state;
  if (pr.isDraft) return 'draft';

  return pr.reviewState ?? 'open';
}

const STATE_GROUP: Record<GitPullRequestState, number> = {
  open: 0,
  merged: 1,
  closed: 2,
};

/** Panel order: open (incl. draft and reviewed) first, then merged, then closed; newest first in each group. */
export function comparePullRequests(
  a: { state: GitPullRequestState; updatedAt: string },
  b: { state: GitPullRequestState; updatedAt: string },
): number {
  return (
    STATE_GROUP[a.state] - STATE_GROUP[b.state] ||
    b.updatedAt.localeCompare(a.updatedAt)
  );
}

/** `refs/heads/feature/x` → `feature/x`; null for tags and other refs. A bare name is returned as is. */
export function branchFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (ref.startsWith('refs/heads/'))
    return ref.slice('refs/heads/'.length) || null;
  if (ref.startsWith('refs/')) return null;

  return ref;
}

/** The provider page of a branch, from the repository's web address. */
export function branchUrl(
  provider: GitProvider,
  repositoryWebUrl: string | null,
  name: string,
): string | null {
  if (!repositoryWebUrl) return null;

  if (provider === 'azure_devops')
    return `${repositoryWebUrl.replace(/\/$/, '')}?version=GB${encodeURIComponent(name)}`;

  const path = name.split('/').map(encodeURIComponent).join('/');

  return `${repositoryWebUrl.replace(/\/$/, '')}/${provider === 'gitlab' ? '-/tree' : 'tree'}/${path}`;
}

// ---------------------------------------------------------------------------
// Commits (ticket 6)
// ---------------------------------------------------------------------------

const KEY_PATTERN = String.raw`(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,8}-T\d+|TASK-\d+)(?!\d)`;

/**
 * GitHub's closing words followed by one key or a list: "Fixes XE-T1", "closes: XE-T1, XE-T2 and XE-T3".
 * "Part of" / "Refs" and any other mention only link.
 */
const CLOSING_PHRASE = new RegExp(
  String.raw`(?<![A-Za-z0-9])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?:\s*:\s*|\s+)(${KEY_PATTERN}(?:\s*(?:,|&|\band\b)\s*${KEY_PATTERN})*)`,
  'gi',
);

/** `git revert`'s default message: reverting a "Fixes" commit must not resolve the task again. */
const REVERT_MESSAGE = /^Revert\s+"|This reverts commit [0-9a-f]{7,}/i;

/** The keys a commit message closes (upper case, distinct). None for revert commits. */
export function extractClosingKeys(
  message: string | null | undefined,
): string[] {
  if (!message || REVERT_MESSAGE.test(message)) return [];

  return extractTaskKeys(
    ...[...message.slice(0, MAX_SCANNED_CHARS).matchAll(CLOSING_PHRASE)].map(
      (match) => match[1],
    ),
  );
}

const MAX_COMMIT_TITLE = 300;

/** The first line of a commit message, at most 300 characters; the body is never stored. */
export function commitTitle(message: string | null | undefined): string {
  return (message ?? '').split(/\r?\n/, 1)[0].trim().slice(0, MAX_COMMIT_TITLE);
}

/**
 * One change across rebase, amend and cherry-pick: the author email and author date survive all three,
 * the sha and committer date do not. Without an email (or a date) only the sha identifies the commit.
 * The email is only ever hashed, never stored.
 */
export function changeIdOf(
  authorEmail: string | null | undefined,
  authoredAt: string | null | undefined,
  sha: string,
): string {
  const time = authoredAt ? Date.parse(authoredAt) : NaN;
  const email = authorEmail?.trim().toLowerCase();

  if (!email || Number.isNaN(time)) return `sha:${sha.toLowerCase()}`;

  return createHash('sha256')
    .update(`${email}|${new Date(time).toISOString()}`)
    .digest('hex');
}

/** The provider's commit search for a task key in one repository ("and 450 more"). */
export function commitSearchUrl(
  provider: GitProvider,
  repositoryWebUrl: string | null,
  fullName: string,
  key: string,
): string | null {
  if (!repositoryWebUrl) return null;

  // Azure Repos has no public address for a commit search by text: its commit list instead.
  if (provider === 'azure_devops')
    return `${repositoryWebUrl.replace(/\/$/, '')}/commits`;

  if (provider === 'gitlab')
    return `${repositoryWebUrl.replace(/\/$/, '')}/-/search?${new URLSearchParams({ search: key, scope: 'commits' }).toString()}`;

  let origin: string;

  try {
    origin = new URL(repositoryWebUrl).origin;
  } catch {
    return null;
  }

  return `${origin}/search?${new URLSearchParams({ q: `repo:${fullName} ${key}`, type: 'commits' }).toString()}`;
}

// ---------------------------------------------------------------------------
// Builds (ticket 7)
// ---------------------------------------------------------------------------

/**
 * A GitHub Actions run's state. Not yet completed: running once `in_progress`, else queued. Completed:
 * success / neutral pass; failure, timed_out, startup_failure fail; cancelled / stale (superseded)
 * cancel; skipped skips. `action_required` (a fork's run waiting for approval) and anything unknown are
 * still waiting, so queued.
 */
export function buildStateFromGithub(
  status: string | null | undefined,
  conclusion: string | null | undefined,
): GitBuildState {
  if (status !== 'completed')
    return status === 'in_progress' ? 'running' : 'queued';

  switch (conclusion) {
    case 'success':
    case 'neutral':
      return 'passed';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failed';
    case 'cancelled':
    case 'stale':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      return 'queued';
  }
}

/** A commit status (`pending` / `success` / `failure` / `error`) as a build state. */
export function buildStateFromGithubStatus(
  state: string | null | undefined,
): GitBuildState {
  switch (state) {
    case 'success':
      return 'passed';
    case 'failure':
    case 'error':
      return 'failed';
    default:
      return 'running';
  }
}

const GITHUB_PERMISSION_LEVEL: Record<string, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

/**
 * Account (user) permissions: each user grants them while authorizing, never on the installation, so they
 * are never part of an installation's grant. ponytail: GitHub's documented list; a new account permission
 * would show as pending until added here.
 */
const GITHUB_ACCOUNT_PERMISSIONS = new Set([
  'blocking',
  'codespaces_user_secrets',
  'copilot_editor_context',
  'copilot_messages',
  'email_addresses',
  'followers',
  'git_ssh_keys',
  'gpg_keys',
  'interaction_limits',
  'knowledge_bases',
  'plan',
  'profile',
  'starring',
  'watching',
]);

/** Organization permissions do not exist on an installation on a personal account. */
function isGithubOrganizationPermission(name: string): boolean {
  return (
    name === 'members' ||
    name === 'team_discussions' ||
    name.startsWith('organization_')
  );
}

/**
 * The App permissions an installation has not (fully) granted yet: GitHub keeps the old grant until the
 * account owner approves the App's new request. Unknown levels count as granted, so they never flag;
 * permissions the account type cannot grant are skipped.
 */
export function missingGithubPermissions(
  required: Record<string, string> | null | undefined,
  granted: Record<string, string> | null | undefined,
  accountType: string | null | undefined,
): string[] {
  return Object.entries(required ?? {})
    .filter(([name]) => !GITHUB_ACCOUNT_PERMISSIONS.has(name))
    .filter(
      ([name]) =>
        accountType === 'Organization' || !isGithubOrganizationPermission(name),
    )
    .filter(([name, level]) => {
      const need = GITHUB_PERMISSION_LEVEL[level] ?? 0;
      const have = GITHUB_PERMISSION_LEVEL[granted?.[name] ?? ''] ?? 0;

      return need > have;
    })
    .map(([name]) => name);
}

/**
 * A GitLab pipeline's state. `manual` / `scheduled` (blocked on a manual job or a delayed job) and every
 * waiting status are queued; `canceling` is already cancelled.
 */
export function buildStateFromGitlab(
  status: string | null | undefined,
): GitBuildState {
  switch (status) {
    case 'running':
    case 'waiting_for_callback':
      return 'running';
    case 'success':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'canceled':
    case 'canceling':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      return 'queued';
  }
}

/** 0 queued, 1 running, 2 finished: the ordering guard of `git_sync_build`. */
export function buildPhaseOf(state: GitBuildState): 0 | 1 | 2 {
  if (state === 'queued') return 0;

  return state === 'running' ? 1 : 2;
}

/** Worst first. Skipped only wins when every build was skipped (a path-filtered workflow is normal). */
const BUILD_STATE_ORDER: GitBuildState[] = [
  'failed',
  'running',
  'queued',
  'cancelled',
  'passed',
  'skipped',
];

/** The combined state of several builds: failed if any failed, else running, queued, cancelled, passed, skipped. */
export function combineBuildStates(
  states: GitBuildState[],
): GitBuildState | null {
  return BUILD_STATE_ORDER.find((state) => states.includes(state)) ?? null;
}

/** A build as `git_task_builds` returns it (migration 20261022120000_git_builds.sql). */
export interface IBuildRow {
  id: string;
  provider: GitProvider;
  workflow_key: string;
  name: string;
  state: GitBuildState;
  url: string;
  attempt: number;
  head_branch: string | null;
  head_sha: string;
  started_at: string | null;
  completed_at: string | null;
  provider_created_at: string;
}

function toBuildDto(row: IBuildRow): IGitBuildDto {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    state: row.state,
    url: row.url,
    attempt: row.attempt,
    branch: row.head_branch,
    shortSha: row.head_sha.slice(0, 7),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.provider_created_at,
  };
}

/**
 * The builds of one commit, combined: the newest run per workflow, their combined state and the run that
 * decided it (its address is what the status icon opens). Null when the commit has no build.
 */
export function summarizeBuilds(
  current: IBuildRow[],
  history: IBuildRow[],
): IGitBuildSummaryDto | null {
  const newest = new Map<string, IBuildRow>();

  for (const row of [...current].sort((a, b) =>
    b.provider_created_at.localeCompare(a.provider_created_at),
  ))
    if (!newest.has(row.workflow_key)) newest.set(row.workflow_key, row);

  const runs = [...newest.values()];
  const state = combineBuildStates(runs.map((run) => run.state));

  if (!state) return null;

  return {
    state,
    url: runs.find((run) => run.state === state)!.url,
    runs: runs.map(toBuildDto),
    history: history.slice(0, 10).map(toBuildDto),
  };
}

// ---------------------------------------------------------------------------
// Ticket 8: development events from state changes
// ---------------------------------------------------------------------------

/**
 * The pull request events one applied sync caused, per linked task. Derived from the stored state before the
 * delivery (null: the pull request is new) and after it, so a redelivered or older event yields nothing.
 * A task linked by this delivery has no "before" for itself: the pull request is new to it.
 * A draft is not "opened"; it becomes `pr_ready_for_review` when marked ready. A reopened pull request is opened.
 */
export function pullRequestEvents(
  change: {
    prevState: GitPullRequestState | null;
    prevDraft: boolean | null;
    state: GitPullRequestState;
    isDraft: boolean;
  },
  tasks: string[],
  newlyLinked: string[],
): Map<GitDevelopmentEvent, string[]> {
  const events = new Map<GitDevelopmentEvent, string[]>();
  const fresh = new Set(newlyLinked);

  for (const task of tasks) {
    const prev = fresh.has(task) ? null : change.prevState;
    const prevDraft = fresh.has(task) ? null : change.prevDraft;
    let event: GitDevelopmentEvent | null = null;

    if (change.state === 'open' && !change.isDraft) {
      if (prev === null || prev === 'closed') event = 'pr_opened';
      else if (prev === 'open' && prevDraft === true)
        event = 'pr_ready_for_review';
    } else if (change.state === 'merged' && prev !== 'merged') {
      event = 'pr_merged';
    } else if (change.state === 'closed' && prev !== 'closed') {
      event = 'pr_closed';
    }

    if (event) events.set(event, [...(events.get(event) ?? []), task]);
  }

  return events;
}

/**
 * The build event a finished run caused for its commit, or null. Only a run that changed to failed / passed
 * counts, and the commit's newest run per workflow decides: failed when any failed (this one included), passed
 * only when all passed. So a passing lint while CI still runs is no event, and the last green run is.
 */
export function buildEvent(
  prevState: GitBuildState | null,
  state: GitBuildState,
  commitRuns: {
    workflow_key: string;
    state: GitBuildState;
    provider_created_at: string;
  }[],
): 'build_failed' | 'build_passed' | null {
  if (prevState === state || (state !== 'failed' && state !== 'passed'))
    return null;

  const newest = new Map<string, GitBuildState>();

  for (const run of [...commitRuns].sort((a, b) =>
    b.provider_created_at.localeCompare(a.provider_created_at),
  ))
    if (!newest.has(run.workflow_key)) newest.set(run.workflow_key, run.state);

  const combined = combineBuildStates([...newest.values()]);

  if (state === 'failed' && combined === 'failed') return 'build_failed';
  if (state === 'passed' && combined === 'passed') return 'build_passed';

  return null;
}

/**
 * The tasks whose space has the Development module switched on (`git_development_task_ids`) and, when a
 * repository is given, has that repository assigned. The one space gate of the Git integration: links
 * are still recorded for the other tasks, but nothing about them is shown, notified or automated.
 */
export async function developmentTaskIds(
  db: SupabaseClient<any, any>,
  organizationId: string,
  taskIds: string[],
  repositoryId?: string,
): Promise<Set<string>> {
  if (!taskIds.length) return new Set();

  const { data, error } = (await db.rpc('git_development_task_ids', {
    p_org: organizationId,
    p_task_ids: [...new Set(taskIds)],
    p_repository_id: repositoryId ?? null,
  })) as { data: string[] | null; error: { message: string } | null };

  if (error) throw new Error(error.message);

  return new Set(data ?? []);
}

/** The subset of `spaceIds` with the Development module switched on (same gate as above, per space). */
export async function developmentSpaceIds(
  db: SupabaseClient<any, any>,
  spaceIds: string[],
): Promise<string[]> {
  if (!spaceIds.length) return [];

  const { data, error } = await db
    .from('space_modules')
    .select('space_id')
    .in('space_id', spaceIds)
    .eq('module_type', 'development')
    .eq('is_enabled', true);

  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<{ space_id: string }>).map(
    (row) => row.space_id,
  );
}

/** The repositories assigned to each space (`git_space_repositories`); a space without any is absent. */
export async function spaceRepositoryIds(
  db: SupabaseClient<any, any>,
  spaceIds: string[],
): Promise<Map<string, Set<string>>> {
  const assigned = new Map<string, Set<string>>();

  if (!spaceIds.length) return assigned;

  const { data, error } = await db
    .from('git_space_repositories')
    .select('space_id, repository_id')
    .in('space_id', [...new Set(spaceIds)]);

  if (error) throw new Error(error.message);

  for (const row of (data ?? []) as Array<{
    space_id: string;
    repository_id: string;
  }>) {
    const set = assigned.get(row.space_id) ?? new Set<string>();

    set.add(row.repository_id);
    assigned.set(row.space_id, set);
  }

  return assigned;
}
