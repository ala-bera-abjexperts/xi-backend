/**
 * @fileoverview The GitLab half of the org-level Git integrations: OAuth sign-in (one credential
 * row per authorization, shared by every group connected with it), group connections, project
 * webhooks, token refresh under a lease, health checks and the per-repository webhook receiver.
 *
 * The admin client bypasses RLS, so every `git_credentials` query filters on `organization_id`,
 * except the hourly sweep of never-attached credentials in {@link checkHealth}.
 * @module src/git-integrations/gitlab/gitlab-integration.service
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  createState,
  readState,
} from '../../calendar/integrations/calendar-oauth.state';
import { assertPublicHttpUrl } from '../../common/security/ssrf-guard';
import { decryptApiKey, encryptApiKey } from '../../lib/crypto/encryption';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  GitCredentialTokens,
  storedTokens,
  type IGitCredentialRow,
  type IStoredTokens,
} from '../git-credential-tokens';
import { GitIntegrationsService } from '../git-integrations.service';
import { GitServersService, isAppComplete } from '../git-servers.service';
import {
  GitPullRequestsService,
  MAX_PUSH_COMMITS,
} from '../git-pull-requests.service';
import type {
  GitAttentionReason,
  IGitActor,
  IGitApp,
  IGitConnectionRow,
  IGitProviderAdapter,
  IGitRepositoryRow,
  IProviderBranch,
  IProviderBuild,
  IProviderCommit,
  IProviderPullRequest,
  IProviderRepository,
  IProviderReview,
} from '../git-integrations.types';
import {
  branchFromRef,
  buildStateFromGitlab,
  extractTaskKeys,
  integrationsPageUrl,
  isRepositoryLive,
  parseStateProviderTag,
  stateProviderTag,
} from '../git-integrations.util';
import {
  GitlabApiError,
  GitlabClient,
  type IGitlabTokens,
} from './gitlab.client';

const CREDENTIALS = 'git_credentials';

/** Credentials from a sign-in that never became a connection are swept after this. */
const UNATTACHED_TTL_MS = 60 * 60 * 1000;

/** GitLab's Maintainer role: the minimum that may manage project webhooks. */
const MAINTAINER_ACCESS_LEVEL = 40;

const SWEEP_CHUNK = 100;
const GROUP_PAGES = 5;
const PROJECT_PAGES = 50;

export type { IGitCredentialRow };

interface IGitlabGroup {
  id: number;
  full_path: string;
  name: string;
  avatar_url: string | null;
  web_url: string | null;
  kind?: string;
}

interface IGitlabProject {
  id: number;
  path_with_namespace: string;
  web_url: string | null;
  default_branch: string | null;
  visibility: string;
  archived: boolean;
}

/** A merge request in the REST API (v4). */
interface IGitlabMergeRequest {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  web_url: string;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  source_branch: string | null;
  target_branch: string | null;
  author: { id: number; username: string; avatar_url?: string | null } | null;
  created_at: string | null;
  updated_at: string;
  merged_at?: string | null;
  closed_at?: string | null;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  /** Ticket 7: the head commit of the source branch. */
  sha?: string | null;
}

/** A merge request in a "Merge Request Hook" payload (author by id only; dates may be "YYYY-MM-DD hh:mm:ss UTC"). */
interface IGitlabMergeRequestHook {
  object_kind?: string;
  user?: { id?: number; username?: string; avatar_url?: string | null };
  /** Every reviewer with their review state (ticket 5); absent on older GitLab versions. */
  reviewers?: IGitlabReviewer[];
  object_attributes?: {
    id: number;
    iid: number;
    title: string;
    description?: string | null;
    url: string;
    state: string;
    action?: string;
    draft?: boolean;
    work_in_progress?: boolean;
    source_branch?: string | null;
    target_branch?: string | null;
    source_project_id?: number;
    target_project_id?: number;
    source?: { path_with_namespace?: string } | null;
    author_id?: number;
    created_at?: string | null;
    updated_at?: string | null;
    merged_at?: string | null;
    closed_at?: string | null;
    merge_commit_sha?: string | null;
    squash_commit_sha?: string | null;
    /** Ticket 7: the head commit. */
    last_commit?: { id?: string } | null;
  };
}

/** Pipeline hook (ticket 7): sent whenever a pipeline's status changes. No updated_at. */
interface IGitlabPipelineHook {
  object_kind?: string;
  /** Ticket 8: who triggered the pipeline. */
  user?: { id?: number; username?: string };
  object_attributes?: {
    id?: number;
    name?: string | null;
    ref?: string | null;
    tag?: boolean;
    sha?: string;
    status?: string;
    created_at?: string | null;
    finished_at?: string | null;
    url?: string | null;
  };
  /** Set for merge request pipelines, whose `ref` is `refs/merge-requests/<iid>/head`. */
  merge_request?: { iid?: number; source_branch?: string | null } | null;
}

/** A pipeline of the pipelines API (ticket 7). */
interface IGitlabApiPipeline {
  id: number;
  name?: string | null;
  ref?: string | null;
  sha: string;
  status: string;
  web_url?: string | null;
  created_at: string;
  updated_at?: string | null;
}

/**
 * A GitLab pipeline, normalised (ticket 7). Merge request pipelines run on `refs/merge-requests/<iid>/head`,
 * so their branch is the merge request's source branch. Retries keep the pipeline id (attempt stays 1) and
 * the last delivery wins.
 */
export function buildFromGitlabPipeline(
  pipeline: {
    id: number;
    name?: string | null;
    ref?: string | null;
    sha: string;
    status: string;
    url?: string | null;
    createdAt?: string | null;
    finishedAt?: string | null;
    updatedAt?: string | null;
  },
  repositoryWebUrl: string | null,
  sourceBranch: string | null,
): IProviderBuild | null {
  const url =
    pipeline.url ??
    (repositoryWebUrl
      ? `${repositoryWebUrl.replace(/\/$/, '')}/-/pipelines/${pipeline.id}`
      : null);

  if (!pipeline.id || !pipeline.sha || !url) return null;

  const ref = pipeline.ref ?? null;
  const state = buildStateFromGitlab(pipeline.status);

  return {
    externalId: String(pipeline.id),
    workflowKey: 'pipeline',
    name: pipeline.name || 'Pipeline',
    headBranch: ref?.startsWith('refs/merge-requests/')
      ? sourceBranch
      : (branchFromRef(ref) ?? sourceBranch),
    headRepoFullName: null,
    headSha: pipeline.sha,
    state,
    attempt: 1,
    url,
    startedAt: null,
    completedAt:
      state === 'queued' || state === 'running'
        ? null
        : isoOrNull(pipeline.finishedAt),
    createdAt: isoOrNull(pipeline.createdAt) ?? new Date().toISOString(),
    updatedAt: isoOrNull(pipeline.updatedAt),
  };
}

/** Ticket 6: the commits a merged merge request landed as (a merge commit, a squash commit, or both). */
function mergeCommitShasOf(
  state: IProviderPullRequest['state'],
  mr: { merge_commit_sha?: string | null; squash_commit_sha?: string | null },
): string[] {
  if (state !== 'merged') return [];

  return [mr.merge_commit_sha, mr.squash_commit_sha].filter(
    (sha): sha is string => Boolean(sha),
  );
}

/** Merge request hook actions that can change state, draft flag, branch, title, description or approvals. */
const MERGE_REQUEST_ACTIONS = new Set([
  'open',
  'reopen',
  'update',
  'close',
  'merge',
  'approval',
  'approved',
  'unapproval',
  'unapproved',
]);

/** A reviewer in a merge request hook or the reviewers API: `state` is the review state there. */
interface IGitlabReviewer {
  id?: number;
  username?: string;
  user?: { id: number; username: string };
  state?: string;
}

/** Push hook (ticket 5): branch created (`before` zeros), deleted (`after` zeros) or pushed. */
interface IGitlabPushHook {
  object_kind?: string;
  ref?: string;
  before?: string;
  after?: string;
  /** Ticket 6: only the newest 20 commits are listed; this is the real number. */
  total_commits_count?: number;
  commits?: IGitlabHookCommit[];
  /** Ticket 8: the pusher (a push hook has no `user` object). */
  user_id?: number;
  user_username?: string;
}

/**
 * Ticket 8: the hook's user, passed as the actor so only live events move task status. Merge request
 * and pipeline hooks carry a `user` object, a push hook top-level `user_id` / `user_username`.
 */
function actorOf(hook: {
  user?: { id?: number; username?: string };
  user_id?: number;
  user_username?: string;
}): IGitActor {
  const id = hook.user?.id ?? hook.user_id;

  return {
    externalId: id != null ? String(id) : null,
    login: hook.user?.username ?? hook.user_username ?? null,
  };
}

/** A commit in a push hook: `timestamp` is the committer date; no username, no parents. */
interface IGitlabHookCommit {
  id?: string;
  message?: string;
  timestamp?: string;
  url?: string;
  author?: { name?: string; email?: string } | null;
}

/** A commit of the repository compare API (ticket 6). */
interface IGitlabApiCommit {
  id: string;
  message?: string;
  title?: string;
  web_url?: string;
  author_name?: string | null;
  author_email?: string | null;
  authored_date?: string | null;
  committed_date?: string | null;
}

/** A push-hook commit, normalised; the committer date stands in for the author date (fallback only). */
export function commitFromHook(
  commit: IGitlabHookCommit,
): IProviderCommit | null {
  if (!commit.id || !commit.url) return null;

  const at = isoOrNull(commit.timestamp);

  return {
    sha: commit.id,
    message: commit.message ?? '',
    url: commit.url,
    authorName: commit.author?.name ?? null,
    authorEmail: commit.author?.email ?? null,
    authorLogin: null,
    authoredAt: at,
    committedAt: at ?? new Date().toISOString(),
  };
}

/** A compare-API commit, normalised (real author and committer dates). */
export function commitFromApi(
  commit: IGitlabApiCommit,
  repositoryWebUrl: string | null,
): IProviderCommit | null {
  const url =
    commit.web_url ??
    (repositoryWebUrl
      ? `${repositoryWebUrl.replace(/\/$/, '')}/-/commit/${commit.id}`
      : null);

  if (!commit.id || !url) return null;

  return {
    sha: commit.id,
    message: commit.message ?? commit.title ?? '',
    url,
    authorName: commit.author_name ?? null,
    authorEmail: commit.author_email ?? null,
    authorLogin: null,
    authoredAt: isoOrNull(commit.authored_date),
    committedAt:
      isoOrNull(commit.committed_date) ??
      isoOrNull(commit.authored_date) ??
      new Date().toISOString(),
  };
}

const ZERO_SHA = /^0+$/;

/**
 * Each person's current verdict on a merge request: reviewers who requested changes or approved, plus
 * everyone who approved without being a reviewer (GitLab lets any eligible member approve).
 * GitLab's `requested_changes` becomes `changes_requested`.
 */
export function reviewsFromGitlab(
  reviewers: IGitlabReviewer[],
  approvedBy: { user?: { id: number; username: string } }[],
): IProviderReview[] {
  const verdicts = new Map<string, IProviderReview>();

  for (const entry of approvedBy) {
    if (!entry.user) continue;

    verdicts.set(String(entry.user.id), {
      reviewerId: String(entry.user.id),
      login: entry.user.username,
      state: 'approved',
      submittedAt: null,
    });
  }

  for (const reviewer of reviewers) {
    const id = reviewer.user?.id ?? reviewer.id;
    const state =
      reviewer.state === 'requested_changes'
        ? 'changes_requested'
        : reviewer.state === 'approved'
          ? 'approved'
          : null;

    if (id == null || !state) continue;

    verdicts.set(String(id), {
      reviewerId: String(id),
      login: reviewer.user?.username ?? reviewer.username ?? null,
      state,
      submittedAt: null,
    });
  }

  return [...verdicts.values()];
}

/** First-connection import: at most this many pages of 100 per list. */
const BACKFILL_PAGES = 10;

/** ponytail: the first import reads reviews of at most this many open merge requests per repository. */
const IMPORT_REVIEWS_LIMIT = 50;

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;

  const time = Date.parse(value);

  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** GitLab `opened` / `locked` are open; `merged` and `closed` map directly. */
function stateOf(state: string): IProviderPullRequest['state'] {
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'closed';

  return 'open';
}

/** The provider-neutral shape of a merge request read from the REST API. */
export function mergeRequestFromApi(
  mr: IGitlabMergeRequest,
): IProviderPullRequest {
  return {
    number: mr.iid,
    externalId: String(mr.id),
    title: mr.title,
    url: mr.web_url,
    state: stateOf(mr.state),
    isDraft: Boolean(mr.draft ?? mr.work_in_progress),
    sourceBranch: mr.source_branch ?? null,
    targetBranch: mr.target_branch ?? null,
    // ponytail: the API names a fork only by project id; its path would cost one more call.
    headRepoFullName: null,
    author: mr.author
      ? {
          externalId: String(mr.author.id),
          login: mr.author.username,
          avatarUrl: mr.author.avatar_url ?? null,
        }
      : null,
    openedAt: isoOrNull(mr.created_at),
    closedAt: isoOrNull(mr.closed_at),
    mergedAt: isoOrNull(mr.merged_at),
    updatedAt: isoOrNull(mr.updated_at) ?? new Date().toISOString(),
    body: mr.description ?? null,
    mergeCommitShas: mergeCommitShasOf(stateOf(mr.state), mr),
    headSha: mr.sha ?? null,
  };
}

/** The provider-neutral shape of a merge request from a webhook; null when it is not one. */
export function mergeRequestFromHook(
  payload: IGitlabMergeRequestHook,
): IProviderPullRequest | null {
  const mr = payload.object_attributes;

  if (payload.object_kind !== 'merge_request' || !mr?.iid || !mr.url)
    return null;

  const state = stateOf(mr.state);
  const updatedAt = isoOrNull(mr.updated_at) ?? new Date().toISOString();
  const isAuthor = mr.author_id != null && payload.user?.id === mr.author_id;

  return {
    number: mr.iid,
    externalId: String(mr.id),
    title: mr.title ?? '',
    url: mr.url,
    state,
    isDraft: Boolean(mr.draft ?? mr.work_in_progress),
    sourceBranch: mr.source_branch ?? null,
    targetBranch: mr.target_branch ?? null,
    headRepoFullName:
      mr.source_project_id &&
      mr.target_project_id &&
      mr.source_project_id !== mr.target_project_id
        ? (mr.source?.path_with_namespace ?? null)
        : null,
    author:
      mr.author_id != null
        ? {
            externalId: String(mr.author_id),
            login: isAuthor ? (payload.user?.username ?? null) : null,
            avatarUrl: isAuthor ? (payload.user?.avatar_url ?? null) : null,
          }
        : null,
    openedAt: isoOrNull(mr.created_at),
    closedAt:
      isoOrNull(mr.closed_at) ?? (state === 'closed' ? updatedAt : null),
    mergedAt:
      isoOrNull(mr.merged_at) ?? (state === 'merged' ? updatedAt : null),
    updatedAt,
    body: mr.description ?? null,
    mergeCommitShas: mergeCommitShasOf(state, mr),
    headSha: mr.last_commit?.id ?? null,
  };
}

export interface IGitlabGroupDto {
  id: string;
  fullPath: string;
  name: string;
  avatarUrl: string | null;
  alreadyConnected: boolean;
}

function isAuthFailure(error: unknown): boolean {
  return (
    error instanceof GitlabApiError && [400, 401, 403].includes(error.status)
  );
}

function webhookErrorCode(error: unknown): string {
  if (!(error instanceof GitlabApiError)) return 'failed';
  if (error.status === 403) return 'forbidden';
  if (error.status === 404) return 'not_found';
  if (error.status === 400 || error.status === 422) return 'invalid_url';

  return 'failed';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class GitlabIntegrationService implements IGitProviderAdapter {
  readonly provider = 'gitlab' as const;
  private readonly logger = new Logger(GitlabIntegrationService.name);
  private readonly tokens: GitCredentialTokens;

  /** Wait between re-reads while another request holds the refresh lease. Replaced in tests. */
  delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly core: GitIntegrationsService,
    private readonly client: GitlabClient,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly config: ConfigService,
    private readonly pullRequests: GitPullRequestsService,
    private readonly servers: GitServersService,
  ) {
    this.tokens = new GitCredentialTokens({
      label: 'GitLab',
      logger: this.logger,
      supabaseAdmin,
      core,
      refresh: async (row, refreshToken) =>
        client.refresh(await this.appOf(row), refreshToken, this.redirectUri),
      isRefusal: (error) =>
        error instanceof GitlabApiError &&
        (error.status === 400 || error.status === 401),
      expiredError: () =>
        new GitlabApiError(
          401,
          'GitLab authorization expired',
          'invalid_grant',
        ),
      delay: (ms) => this.delay(ms),
    });
  }

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** The app (built-in or the organization's own server, ticket 11) a credential / connection / repository talks to. */
  private appOf(row: {
    organization_id: string;
    host: string;
  }): Promise<IGitApp> {
    return this.servers.appFor(row.organization_id, 'gitlab', row.host);
  }

  private get publicApiUrl(): string {
    return (this.config.get<string>('publicApiUrl') ?? '').replace(/\/$/, '');
  }

  private get redirectUri(): string {
    return `${this.publicApiUrl}/git-integrations/gitlab/callback`;
  }

  /** The address project webhooks call; only webhooks use it, so sign-in keeps PUBLIC_API_URL. */
  private get webhookBaseUrl(): string {
    return (
      this.config.get<string>('gitWebhookPublicUrl') || this.publicApiUrl
    ).replace(/\/$/, '');
  }

  // Said once per process, not on every health tick.
  private warnedPrivateWebhookUrl = false;

  /** GitLab.com never calls a private or localhost address, so asking it to would only fail again. */
  private async webhookUnreachable(host: string): Promise<boolean> {
    if (host !== 'gitlab.com') return false;

    try {
      await assertPublicHttpUrl(this.webhookBaseUrl);

      return false;
    } catch {
      return true;
    }
  }

  /** The built-in (env) app; own servers carry their own flag (ticket 11). */
  isConfigured(): boolean {
    return this.servers.isBuiltinConfigured('gitlab');
  }

  manageUrl(): string | null {
    return null;
  }

  // ---------------------------------------------------------------------------
  // Connect flow
  // ---------------------------------------------------------------------------

  async connectUrl(
    userId: string,
    organizationId: string,
    returnTo: string | undefined,
    connectionId?: string,
    serverId?: string,
  ): Promise<string> {
    // Reconnect: the connection's own server (its host); new: the chosen server or the built-in app.
    const app = connectionId
      ? await this.appOf(
          await this.core.getConnection(organizationId, connectionId),
        )
      : await this.servers.appForStart(organizationId, 'gitlab', serverId);

    if (!isAppComplete(app)) throw new BadRequestException('not_configured');

    const query = new URLSearchParams({
      client_id: app.clientId ?? '',
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'api',
      state: createState(
        userId,
        organizationId,
        stateProviderTag('gitlab', connectionId, app.serverId),
        returnTo,
      ),
    });

    return `${app.webUrl}/oauth/authorize?${query.toString()}`;
  }

  /** Where to send the browser after GitLab's redirect. Never throws. */
  async handleCallback(input: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<string> {
    const state = readState(input.state);
    const tag = state ? parseStateProviderTag(state.provider) : null;

    if (!state || tag?.provider !== 'gitlab')
      return integrationsPageUrl(undefined, 'gitlab', { error: 'expired' });

    // The page of the server the flow started from (ticket 11).
    const back = (params: Record<string, string>) =>
      integrationsPageUrl(state.returnTo, 'gitlab', {
        ...params,
        ...(tag.serverId && { server: tag.serverId }),
      });
    const { userId, organizationId } = state;

    try {
      if (input.error) return back({ error: input.error.slice(0, 50) });
      if (!input.code) return back({ error: 'expired' });
      if (!(await this.core.isOrgAdmin(organizationId, userId)))
        return back({ error: 'forbidden' });

      // Reconnect: check the connection BEFORE storing anything, so a failed reconnect leaves no
      // stray credential behind. Its host decides the app; otherwise the server in the state does.
      let connection: IGitConnectionRow | null = null;

      if (tag.connectionId) {
        connection = await this.core
          .getConnection(organizationId, tag.connectionId)
          .catch(() => null);

        if (
          !connection ||
          connection.provider !== 'gitlab' ||
          connection.status === 'disconnected'
        ) {
          return back({ error: 'not_found' });
        }
      }

      let app: IGitApp;

      try {
        app = connection
          ? await this.appOf(connection)
          : await this.servers.appForStart(
              organizationId,
              'gitlab',
              tag.serverId,
            );
      } catch (error) {
        this.logger.warn(`GitLab callback app: ${messageOf(error)}`);

        return back({ error: 'not_configured' });
      }

      let tokens: IGitlabTokens;

      try {
        tokens = await this.client.exchangeCode(
          app,
          input.code,
          this.redirectUri,
        );
      } catch (error) {
        this.logger.warn(`GitLab code exchange failed: ${messageOf(error)}`);

        return back({ error: 'exchange_failed' });
      }

      const me = await this.client.api<{ id: number; username: string }>(
        app,
        '/user',
        tokens.accessToken,
      );

      // Reconnect: the new sign-in must maintain the connection's group.
      if (connection?.account_type === 'User') {
        // A personal space can only be renewed by its owner.
        if (
          me.username.toLowerCase() !== connection.account_login.toLowerCase()
        ) {
          return back({ error: 'group_not_accessible' });
        }
      } else if (connection) {
        try {
          await this.client.api(
            app,
            `/groups/${encodeURIComponent(connection.external_account_id)}`,
            tokens.accessToken,
          );
        } catch {
          return back({ error: 'group_not_accessible' });
        }

        if (
          !(await this.isMaintainer(
            app,
            connection.external_account_id,
            String(me.id),
            tokens.accessToken,
          ))
        ) {
          return back({ error: 'maintainer_required' });
        }
      }
      const encrypted = encryptApiKey(
        JSON.stringify({
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
        } satisfies IStoredTokens),
      );
      const { data, error } = await this.db
        .from(CREDENTIALS)
        .insert({
          organization_id: organizationId,
          provider: 'gitlab',
          host: app.host,
          external_user_id: String(me.id),
          external_login: me.username,
          encrypted_secret: encrypted.encrypted,
          encryption_iv: encrypted.iv,
          encryption_tag: encrypted.tag,
          expires_at: tokens.expiresAt,
          created_by: userId,
        })
        .select('id')
        .single();

      if (error || !data)
        throw new Error(error?.message ?? 'credential insert returned nothing');

      const credentialId = (data as { id: string }).id;

      if (!connection) return back({ credential: credentialId });

      await this.core.setCredential(connection, credentialId, userId);

      if (
        connection.credential_id &&
        connection.credential_id !== credentialId
      ) {
        await this.deleteCredentialIfUnused(
          connection.credential_id,
          organizationId,
          connection.id,
        );
      }

      if (connection.status === 'needs_attention') {
        await this.core.setStatus(
          connection,
          'active',
          connection.status_reason as GitAttentionReason | null,
          userId,
        );
      }

      try {
        await this.repairHooks({ ...connection, credential_id: credentialId });
      } catch (repairError) {
        this.logger.warn(
          `GitLab hook repair after reconnect ${connection.id}: ${messageOf(repairError)}`,
        );
      }

      return back({ connected: 'gitlab' });
    } catch (error) {
      this.logger.error(`GitLab callback failed: ${messageOf(error)}`);

      return back({ error: 'failed' });
    }
  }

  /** Groups the signed-in GitLab user maintains, for the picker. */
  async listGroups(
    user: RequestUser,
    credentialId: string,
    search?: string,
  ): Promise<IGitlabGroupDto[]> {
    const credential = await this.loadCredential(user, credentialId);
    const token = await this.getAccessToken(credential);
    const query = new URLSearchParams({
      min_access_level: '40',
      order_by: 'name',
    });

    if (search) query.set('search', search);

    const app = await this.appOf(credential);
    const [groups, connections, personal] = await Promise.all([
      this.client.paginate<IGitlabGroup>(
        app,
        `/groups?${query.toString()}`,
        token,
        GROUP_PAGES,
      ),
      this.core.listConnections(user.organizationId, 'gitlab'),
      this.personalNamespace(app, credential.external_login, token),
    ]);

    // Projects in the user's own space are offered too, but only that user's.
    const own =
      personal &&
      (!search ||
        personal.full_path.toLowerCase().includes(search.toLowerCase()))
        ? [personal]
        : [];
    const connected = new Set(
      connections
        .filter(
          (connection) =>
            connection.status === 'active' &&
            connection.host === credential.host,
        )
        .map((connection) => connection.external_account_id),
    );

    return [...own, ...groups].map((group) => ({
      id: String(group.id),
      fullPath: group.full_path,
      name: group.name,
      avatarUrl: group.avatar_url,
      alreadyConnected: connected.has(String(group.id)),
    }));
  }

  /** @throws {ConflictException} when the group is already connected (409). */
  async connectGroup(
    user: RequestUser,
    credentialId: string,
    groupId: string,
  ): Promise<IGitConnectionRow> {
    const credential = await this.loadCredential(user, credentialId);
    const token = await this.getAccessToken(credential);
    const app = await this.appOf(credential);
    const personal = await this.personalNamespace(
      app,
      credential.external_login,
      token,
    );

    if (personal && String(personal.id) === groupId) {
      return this.saveConnection(
        user,
        credentialId,
        credential.host,
        personal,
        'User',
      );
    }

    let group: IGitlabGroup;

    try {
      group = await this.client.api<IGitlabGroup>(
        app,
        `/groups/${encodeURIComponent(groupId)}`,
        token,
      );
    } catch (error) {
      if (
        error instanceof GitlabApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        throw new NotFoundException('Group not found');
      }

      throw error;
    }

    if (
      !(await this.isMaintainer(
        app,
        groupId,
        credential.external_user_id,
        token,
      ))
    ) {
      throw new ForbiddenException('maintainer_required');
    }

    return this.saveConnection(
      user,
      credentialId,
      credential.host,
      group,
      'Group',
    );
  }

  private async saveConnection(
    user: RequestUser,
    credentialId: string,
    host: string,
    group: IGitlabGroup,
    type: 'Group' | 'User',
  ): Promise<IGitConnectionRow> {
    const { connection } = await this.core.upsertConnection({
      organizationId: user.organizationId,
      provider: 'gitlab',
      host,
      account: {
        externalAccountId: String(group.id),
        installationId: null,
        login: group.full_path,
        name: group.name,
        type,
        avatarUrl: group.avatar_url,
        url: group.web_url,
      },
      credentialId,
      userId: user.userId,
    });

    try {
      await this.refreshRepositories(connection);
    } catch (error) {
      // The connection exists; the repository dialog's refresh retries this.
      this.logger.warn(
        `GitLab initial project sync ${connection.id}: ${messageOf(error)}`,
      );
    }

    return connection;
  }

  // ---------------------------------------------------------------------------
  // Repositories and hooks
  // ---------------------------------------------------------------------------

  async refreshRepositories(connection: IGitConnectionRow): Promise<void> {
    if (!connection.credential_id) {
      await this.core.setStatus(
        connection,
        'needs_attention',
        'authorization_expired',
      );

      throw new Error('GitLab connection has no authorization');
    }

    const token = await this.tokenFor(connection);
    const projects = await this.client.paginate<IGitlabProject>(
      await this.appOf(connection),
      connection.account_type === 'User'
        ? `/users/${encodeURIComponent(connection.account_login)}/projects`
        : `/groups/${encodeURIComponent(connection.external_account_id)}/projects?include_subgroups=true&with_shared=false`,
      token,
      PROJECT_PAGES,
    );

    await this.core.upsertRepositories(
      connection,
      projects.map(
        (project): IProviderRepository => ({
          externalId: String(project.id),
          fullName: project.path_with_namespace,
          webUrl: project.web_url,
          defaultBranch: project.default_branch,
          isPrivate: project.visibility !== 'public',
          isArchived: project.archived,
        }),
      ),
      true,
    );

    await this.repairHooks(connection);
  }

  /** Creates hooks for newly enabled projects and deletes them for disabled ones; each row independent. */
  async applyRepositorySelection(
    connection: IGitConnectionRow,
    enabled: IGitRepositoryRow[],
    disabled: IGitRepositoryRow[],
  ): Promise<void> {
    const toCreate = enabled.filter((row) => !row.webhook_id);
    const toDelete = disabled.filter((row) => row.webhook_id);

    if (!toCreate.length && !toDelete.length) return;

    const token = await this.tokenFor(connection);
    const app = await this.appOf(connection);
    const unreachable =
      toCreate.length > 0 && (await this.webhookUnreachable(connection.host));

    if (unreachable && !this.warnedPrivateWebhookUrl) {
      this.warnedPrivateWebhookUrl = true;
      this.logger.warn(
        `GitLab project webhooks need an address GitLab can reach; set GIT_WEBHOOK_PUBLIC_URL to a public https /api/v1 address (now ${this.webhookBaseUrl})`,
      );
    }

    for (const row of toCreate) {
      if (unreachable) {
        if (row.webhook_error !== 'invalid_url') {
          await this.core.updateRepositoryWebhook(row, {
            webhook_error: 'invalid_url',
          });
        }

        continue;
      }

      const secret = randomBytes(32).toString('hex');

      try {
        const hook = await this.client.api<{ id: number }>(
          app,
          `/projects/${encodeURIComponent(row.external_id)}/hooks`,
          token,
          {
            method: 'POST',
            body: {
              url: `${this.webhookBaseUrl}/git-integrations/gitlab/webhook/${row.id}`,
              token: secret,
              push_events: true,
              merge_requests_events: true,
              pipeline_events: true,
              tag_push_events: false,
              issues_events: false,
              note_events: false,
              job_events: false,
              enable_ssl_verification: true,
            },
          },
        );
        const encrypted = encryptApiKey(secret);

        await this.core.updateRepositoryWebhook(row, {
          webhook_id: String(hook.id),
          webhook_secret_encrypted: encrypted.encrypted,
          webhook_secret_iv: encrypted.iv,
          webhook_secret_tag: encrypted.tag,
          webhook_error: null,
        });
      } catch (error) {
        const code = webhookErrorCode(error);
        const message = `GitLab hook create ${row.full_name}: ${messageOf(error)}`;

        // The same failure on the next tick is no news; a new one is.
        if (code === row.webhook_error) {
          this.logger.debug(message);
        } else {
          this.logger.warn(message);
          await this.core.updateRepositoryWebhook(row, { webhook_error: code });
        }
      }
    }

    for (const row of toDelete) await this.deleteHook(row, token);
  }

  async onDisconnect(connection: IGitConnectionRow): Promise<void> {
    if (!connection.credential_id) return;

    const credential = await this.readCredential(
      connection.credential_id,
      connection.organization_id,
    );
    let token: string | null = null;

    if (credential) {
      try {
        token = await this.getAccessToken(credential);
      } catch (error) {
        this.logger.warn(
          `GitLab disconnect ${connection.id}: no usable token: ${messageOf(error)}`,
        );
      }
    }

    if (token) {
      const rows = await this.core.listRepositories(
        connection.organization_id,
        connection.id,
      );

      for (const row of rows.filter((r) => r.webhook_id))
        await this.deleteHook(row, token);
    }

    await this.deleteCredentialIfUnused(
      connection.credential_id,
      connection.organization_id,
      connection.id,
    );
  }

  /**
   * Revokes (best effort) and deletes a credential once no live connection other than
   * `exceptConnectionId` uses it.
   */
  private async deleteCredentialIfUnused(
    credentialId: string,
    organizationId: string,
    exceptConnectionId: string,
  ): Promise<void> {
    const stillUsed = (
      await this.core.listConnections(organizationId, 'gitlab')
    ).some(
      (other) =>
        other.id !== exceptConnectionId && other.credential_id === credentialId,
    );

    if (stillUsed) return;

    // Re-read: a refresh just now may have rotated the stored token.
    const credential = await this.readCredential(credentialId, organizationId);

    if (!credential) return;

    try {
      await this.client.revoke(
        await this.appOf(credential),
        this.tokensOf(credential).access_token,
      );
    } catch (error) {
      this.logger.warn(`GitLab revoke ${credentialId}: ${messageOf(error)}`);
    }

    const { error } = await this.db
      .from(CREDENTIALS)
      .delete()
      .eq('id', credentialId)
      .eq('organization_id', organizationId);

    if (error)
      this.logger.warn(
        `GitLab credential delete ${credentialId}: ${error.message}`,
      );
  }

  /** The signed-in user's own namespace; null when GitLab doesn't return one. */
  private async personalNamespace(
    app: IGitApp,
    login: string | null,
    token: string,
  ): Promise<IGitlabGroup | null> {
    if (!login) return null;

    try {
      const namespace = await this.client.api<IGitlabGroup>(
        app,
        `/namespaces/${encodeURIComponent(login)}`,
        token,
      );

      return namespace?.kind === 'user' ? namespace : null;
    } catch (error) {
      this.logger.warn(
        `GitLab personal namespace ${login}: ${messageOf(error)}`,
      );

      return null;
    }
  }

  /** Maintainer or above on the group (inherited membership counts). 403/404 = not a member. */
  private async isMaintainer(
    app: IGitApp,
    groupId: string,
    externalUserId: string,
    token: string,
  ): Promise<boolean> {
    try {
      const member = await this.client.api<{ access_level?: number }>(
        app,
        `/groups/${encodeURIComponent(groupId)}/members/all/${encodeURIComponent(externalUserId)}`,
        token,
      );

      return (member.access_level ?? 0) >= MAINTAINER_ACCESS_LEVEL;
    } catch (error) {
      if (
        error instanceof GitlabApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        return false;
      }

      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async fetchPullRequest(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
    number: number,
  ): Promise<IProviderPullRequest> {
    try {
      const token = await this.tokenFor(connection);
      const pr = mergeRequestFromApi(
        await this.client.api<IGitlabMergeRequest>(
          await this.appOf(connection),
          `/projects/${encodeURIComponent(repository.external_id)}/merge_requests/${number}`,
          token,
        ),
      );

      return {
        ...pr,
        reviews: await this.readReviews(token, repository, number),
        builds:
          pr.state === 'open'
            ? await this.pipelinesFor(
                token,
                repository,
                pr.headSha,
                pr.sourceBranch,
              )
            : [],
      };
    } catch (error) {
      if (error instanceof GitlabApiError && error.status === 404)
        throw new NotFoundException('pull_request_not_found');

      throw error;
    }
  }

  async listRecentPullRequests(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
    since: Date,
  ): Promise<IProviderPullRequest[]> {
    const token = await this.tokenFor(connection);
    const app = await this.appOf(connection);
    const base = `/projects/${encodeURIComponent(repository.external_id)}/merge_requests?order_by=updated_at&sort=desc`;
    const [open, recent] = await Promise.all([
      this.client.paginate<IGitlabMergeRequest>(
        app,
        `${base}&state=opened`,
        token,
        BACKFILL_PAGES,
      ),
      this.client.paginate<IGitlabMergeRequest>(
        app,
        `${base}&updated_after=${encodeURIComponent(since.toISOString())}`,
        token,
        BACKFILL_PAGES,
      ),
    ]);
    // Open merge requests updated recently are in both lists.
    const byNumber = new Map([...open, ...recent].map((mr) => [mr.iid, mr]));
    const result = [...byNumber.values()].map(mergeRequestFromApi);

    // Merged and closed merge requests show Merged / Closed whatever the reviews say.
    for (const pr of result
      .filter((p) => p.state === 'open')
      .slice(0, IMPORT_REVIEWS_LIMIT)) {
      pr.reviews = await this.readReviews(token, repository, pr.number);
      pr.builds = await this.pipelinesFor(
        token,
        repository,
        pr.headSha,
        pr.sourceBranch,
      );
    }

    return result;
  }

  async listKeyBranches(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
  ): Promise<IProviderBranch[]> {
    const branches = await this.client.paginate<{
      name: string;
      commit?: { committed_date?: string | null } | null;
    }>(
      await this.appOf(connection),
      `/projects/${encodeURIComponent(repository.external_id)}/repository/branches`,
      await this.tokenFor(connection),
      BACKFILL_PAGES,
    );

    return branches
      .filter((branch) => extractTaskKeys(branch.name).length > 0)
      .map((branch) => ({
        name: branch.name,
        pushedAt: isoOrNull(branch.commit?.committed_date),
      }));
  }

  /**
   * The current verdicts, from the reviewers (the hook's list when given, else the API) and the
   * approvals API. Undefined when GitLab cannot be read, so the stored verdicts stay as they are.
   */
  private async readReviews(
    token: string,
    repository: IGitRepositoryRow,
    iid: number,
    hookReviewers?: IGitlabReviewer[],
  ): Promise<IProviderReview[] | undefined> {
    const base = `/projects/${encodeURIComponent(repository.external_id)}/merge_requests/${iid}`;

    try {
      const app = await this.appOf(repository);
      const [reviewers, approvals] = await Promise.all([
        hookReviewers ??
          this.client.api<IGitlabReviewer[]>(app, `${base}/reviewers`, token),
        this.client.api<{
          approved_by?: { user?: { id: number; username: string } }[];
        }>(app, `${base}/approvals`, token),
      ]);

      return reviewsFromGitlab(reviewers ?? [], approvals?.approved_by ?? []);
    } catch (error) {
      this.logger.warn(
        `GitLab reviews ${repository.id}!${iid}: ${messageOf(error)}`,
      );

      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Server checks (ticket 11): "Test connection" and the health cron
  // ---------------------------------------------------------------------------

  /** Live repositories with a project hook on one host of one organization, in id order. */
  private async hookedRepositories(
    organizationId: string,
    host: string,
    limit: number,
    afterId?: string,
  ): Promise<{ rows: IGitRepositoryRow[]; connections: IGitConnectionRow[] }> {
    const connections = (
      await this.core.listConnections(organizationId, 'gitlab')
    ).filter((connection) => connection.host === host);

    if (!connections.length) return { rows: [], connections };

    let query = this.db
      .from('git_repositories')
      .select('*')
      .eq('organization_id', organizationId)
      .in(
        'connection_id',
        connections.map((connection) => connection.id),
      )
      .eq('is_enabled', true)
      .is('removed_at', null)
      .not('webhook_id', 'is', null)
      .order('id', { ascending: true })
      .limit(limit);

    if (afterId) query = query.gt('id', afterId);

    const { data, error } = await query;

    if (error) throw new InternalServerErrorException(error.message);

    return { rows: (data ?? []) as IGitRepositoryRow[], connections };
  }

  /**
   * Asks GitLab to fire one project hook ("Test" → push events) at XISUITE. GitLab runs it synchronously,
   * so its answer already tells whether the server could reach us; the caller then waits for the
   * delivery itself. Never throws for GitLab errors.
   */
  async testInboundHook(
    organizationId: string,
    host: string,
  ): Promise<{
    result: 'sent' | 'no_project' | 'blocked' | 'failed';
    detail?: string;
    repositoryId?: string;
  }> {
    const { rows, connections } = await this.hookedRepositories(
      organizationId,
      host,
      50,
    );
    // A push test needs a commit: a project with a default branch has one.
    const row = rows.find((repository) => repository.default_branch) ?? rows[0];

    if (!row) return { result: 'no_project' };

    const connection = connections.find((c) => c.id === row.connection_id)!;

    try {
      await this.client.api(
        await this.appOf(row),
        `/projects/${encodeURIComponent(row.external_id)}/hooks/${encodeURIComponent(row.webhook_id ?? '')}/test/push_events`,
        await this.tokenFor(connection),
        { method: 'POST' },
      );

      return { result: 'sent', repositoryId: row.id };
    } catch (error) {
      const detail =
        error instanceof GitlabApiError
          ? `${error.status}: ${error.message}`
          : messageOf(error);

      if (
        error instanceof GitlabApiError &&
        error.status === 422 &&
        /blocked|local network|not allowed/i.test(error.message)
      )
        return { result: 'blocked', detail, repositoryId: row.id };

      return { result: 'failed', detail, repositoryId: row.id };
    }
  }

  // ponytail: per-instance cursor, so each tick checks the next `limit` hooks of a host (round robin);
  // after a restart it starts over, which only delays a check.
  private readonly hookCursor = new Map<string, string>();

  /**
   * Reads `alert_status` of up to `limit` project hooks (GitLab 15.7+). GitLab disables a hook that keeps
   * failing, i.e. when it cannot reach XISUITE: such repositories get `webhook_error = 'disabled_by_gitlab'`
   * (cleared again once the hook is executable). Errors per repository are logged and skipped.
   *
   * `failing` is every hook of the host still recorded as disabled (up to 5, `failingTotal` counts all), not
   * only this tick's batch: with more than `limit` hooks a clean batch must not report the server healthy.
   */
  async checkHookAlerts(
    organizationId: string,
    host: string,
    limit = 25,
  ): Promise<{
    failing: { repositoryId: string; fullName: string; alertStatus: string }[];
    failingTotal: number;
    checked: number;
  }> {
    const key = `${organizationId}:${host}`;
    const { rows, connections } = await this.hookedRepositories(
      organizationId,
      host,
      limit,
      this.hookCursor.get(key),
    );

    if (rows.length < limit) this.hookCursor.delete(key);
    else this.hookCursor.set(key, rows[rows.length - 1].id);

    const failing: {
      repositoryId: string;
      fullName: string;
      alertStatus: string;
    }[] = [];
    let checked = 0;

    for (const row of rows) {
      try {
        const connection = connections.find((c) => c.id === row.connection_id)!;
        const hook = await this.client.api<{ alert_status?: string }>(
          await this.appOf(row),
          `/projects/${encodeURIComponent(row.external_id)}/hooks/${encodeURIComponent(row.webhook_id ?? '')}`,
          await this.tokenFor(connection),
        );
        const alertStatus = hook?.alert_status ?? 'executable';

        checked++;

        if (
          alertStatus === 'disabled' ||
          alertStatus === 'temporarily_disabled'
        ) {
          failing.push({
            repositoryId: row.id,
            fullName: row.full_name,
            alertStatus,
          });

          if (row.webhook_error !== 'disabled_by_gitlab')
            await this.core.updateRepositoryWebhook(row, {
              webhook_error: 'disabled_by_gitlab',
            });
        } else if (row.webhook_error === 'disabled_by_gitlab') {
          await this.core.updateRepositoryWebhook(row, { webhook_error: null });
        }
      } catch (error) {
        if (error instanceof InternalServerErrorException) throw error;
        this.logger.warn(
          `GitLab hook status ${row.full_name}: ${messageOf(error)}`,
        );
      }
    }

    const persisted = await this.disabledHooks(organizationId, host);

    return {
      failing: persisted.rows.map((row) => ({
        repositoryId: row.id,
        fullName: row.full_name,
        // This tick's reading when it has one, else the recorded state.
        alertStatus:
          failing.find((item) => item.repositoryId === row.id)?.alertStatus ??
          'disabled',
      })),
      failingTotal: persisted.total,
      checked,
    };
  }

  /** Hooked repositories of the host whose hook GitLab disabled, as recorded by {@link checkHookAlerts}. */
  private async disabledHooks(
    organizationId: string,
    host: string,
  ): Promise<{ rows: IGitRepositoryRow[]; total: number }> {
    const connections = (
      await this.core.listConnections(organizationId, 'gitlab')
    ).filter((connection) => connection.host === host);

    if (!connections.length) return { rows: [], total: 0 };

    const { data, error, count } = await this.db
      .from('git_repositories')
      .select('*', { count: 'exact' })
      .eq('organization_id', organizationId)
      .in(
        'connection_id',
        connections.map((connection) => connection.id),
      )
      .eq('is_enabled', true)
      .is('removed_at', null)
      .not('webhook_id', 'is', null)
      .eq('webhook_error', 'disabled_by_gitlab')
      .order('full_name', { ascending: true })
      .limit(5);

    if (error) throw new InternalServerErrorException(error.message);

    const rows = (data ?? []) as IGitRepositoryRow[];

    return { rows, total: count ?? rows.length };
  }

  async checkHealth(): Promise<void> {
    await this.sweepUnattachedCredentials();

    const connections = await this.core.listAllLive('gitlab');
    const byCredential = new Map<string, IGitConnectionRow[]>();
    const healthy: IGitConnectionRow[] = [];

    for (const connection of connections) {
      if (!connection.credential_id) {
        await this.core.setStatus(
          connection,
          'needs_attention',
          'authorization_expired',
        );
        continue;
      }

      const key = `${connection.organization_id}:${connection.credential_id}`;

      byCredential.set(key, [...(byCredential.get(key) ?? []), connection]);
    }

    for (const group of byCredential.values()) {
      const [{ credential_id: credentialId, organization_id: organizationId }] =
        group;

      try {
        const credential = await this.readCredential(
          credentialId!,
          organizationId,
        );

        if (!credential || credential.status === 'invalid') {
          for (const connection of group)
            await this.core.setStatus(
              connection,
              'needs_attention',
              'authorization_expired',
            );
          continue;
        }

        // An unresolvable app (server removed, address blocked) is no authorization failure: logged below.
        await this.client.api(
          await this.appOf(credential),
          '/user',
          await this.getAccessToken(credential),
        );

        for (const connection of group) {
          if (
            connection.status === 'needs_attention' &&
            connection.status_reason === 'authorization_expired'
          ) {
            await this.core.setStatus(
              connection,
              'active',
              'authorization_expired',
            );
            healthy.push({
              ...connection,
              status: 'active',
              status_reason: null,
            });
          } else if (connection.status === 'active') {
            healthy.push(connection);
          }
        }
      } catch (error) {
        // 5xx, timeouts and network errors keep the last known status.
        if (!isAuthFailure(error)) {
          this.logger.warn(
            `GitLab health ${credentialId}: ${messageOf(error)}`,
          );
          continue;
        }

        for (const connection of group)
          await this.core.setStatus(
            connection,
            'needs_attention',
            'authorization_expired',
          );
      }
    }

    // ponytail: one project listing per group per 5 minutes (plus a hook POST per enabled project
    // still without a hook, e.g. lacking Maintainer); switch to group hooks / system hooks if that
    // becomes too many calls.
    for (const connection of healthy.filter(
      (c) => c.repository_selection === 'all',
    )) {
      try {
        await this.refreshRepositories(connection);
      } catch (error) {
        this.logger.warn(
          `GitLab project sync ${connection.id}: ${messageOf(error)}`,
        );
      }
    }
  }

  /** The one cross-organization write: sign-ins that never became a connection, any org. */
  private async sweepUnattachedCredentials(): Promise<void> {
    const { data, error } = await this.db
      .from(CREDENTIALS)
      .select('id, organization_id')
      .lt('created_at', new Date(Date.now() - UNATTACHED_TTL_MS).toISOString());

    if (error) {
      this.logger.warn(`GitLab credential sweep: ${error.message}`);

      return;
    }

    const candidates = (data ?? []) as {
      id: string;
      organization_id: string;
    }[];

    // Chunks keep each .in() list well inside PostgREST's URL limit.
    for (let i = 0; i < candidates.length; i += SWEEP_CHUNK) {
      const chunk = candidates.slice(i, i + SWEEP_CHUNK);
      const { data: refs, error: refError } = await this.db
        .from('git_connections')
        .select('credential_id')
        .in(
          'credential_id',
          chunk.map((row) => row.id),
        );

      if (refError) {
        this.logger.warn(`GitLab credential sweep: ${refError.message}`);

        return;
      }

      const referenced = new Set(
        ((refs ?? []) as { credential_id: string }[]).map(
          (row) => row.credential_id,
        ),
      );
      const byOrg = new Map<string, string[]>();

      for (const row of chunk.filter((r) => !referenced.has(r.id))) {
        byOrg.set(row.organization_id, [
          ...(byOrg.get(row.organization_id) ?? []),
          row.id,
        ]);
      }

      for (const [organizationId, ids] of byOrg) {
        const { error: deleteError } = await this.db
          .from(CREDENTIALS)
          .delete()
          .in('id', ids)
          .eq('organization_id', organizationId);

        if (deleteError)
          this.logger.warn(`GitLab credential sweep: ${deleteError.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook receiver
  // ---------------------------------------------------------------------------

  async handleWebhook(input: {
    repositoryId: string;
    token?: string;
    event?: string;
    eventUuid?: string;
    rawBody?: Buffer;
  }): Promise<'ok' | 'unauthorized'> {
    const repository = await this.core.findRepositoryById(input.repositoryId);

    if (
      !repository ||
      repository.provider !== 'gitlab' ||
      !repository.webhook_secret_encrypted ||
      !repository.webhook_secret_iv ||
      !repository.webhook_secret_tag ||
      !input.token
    ) {
      return 'unauthorized';
    }

    let secret: string;

    try {
      secret = decryptApiKey(
        repository.webhook_secret_encrypted,
        repository.webhook_secret_iv,
        repository.webhook_secret_tag,
      );
    } catch {
      return 'unauthorized';
    }

    const given = Buffer.from(input.token);
    const expected = Buffer.from(secret);

    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return 'unauthorized';

    // Ticket 11: proof the server reaches XISUITE, also for a duplicate (GitLab's "Test" button).
    void this.servers.touchWebhookByHost(
      repository.organization_id,
      'gitlab',
      repository.host,
    );

    // Scoped to the hook, so one project's hook cannot suppress another's delivery by reusing a UUID.
    const deliveryId = input.eventUuid
      ? `${repository.id}:${input.eventUuid}`
      : null;

    if (
      deliveryId &&
      !(await this.core.recordDelivery(
        'gitlab',
        deliveryId,
        input.event ?? 'unknown',
      ))
    )
      return 'ok';

    let outcome: string;

    try {
      outcome = await this.processDelivery(repository, input.rawBody);
    } catch (error) {
      this.logger.error(`GitLab webhook ${repository.id}: ${messageOf(error)}`);
      outcome = 'error';
    }

    if (!deliveryId) return 'ok';

    // A failed delivery is forgotten so GitLab's retry is processed instead of skipped as a duplicate.
    if (outcome === 'error')
      await this.core.forgetDelivery('gitlab', deliveryId);
    else await this.core.setDeliveryOutcome('gitlab', deliveryId, outcome);

    return 'ok';
  }

  private async processDelivery(
    repository: IGitRepositoryRow,
    rawBody: Buffer | undefined,
  ): Promise<string> {
    const connection = await this.core.getConnection(
      repository.organization_id,
      repository.connection_id,
    );

    if (!isRepositoryLive(connection, repository)) return 'ignored_disabled';

    let payload: IGitlabMergeRequestHook &
      IGitlabPushHook & {
        project?: { path_with_namespace?: string; web_url?: string };
      };

    try {
      payload = JSON.parse(rawBody?.toString('utf8') ?? '') as typeof payload;
    } catch {
      return 'invalid_payload';
    }

    const project = payload?.project;

    if (
      project?.path_with_namespace &&
      project.path_with_namespace !== repository.full_name
    ) {
      await this.core.patchRepository(connection, repository.external_id, {
        full_name: project.path_with_namespace,
        web_url: project.web_url ?? repository.web_url,
      });
    }

    if (payload?.object_kind === 'merge_request') {
      const action = payload.object_attributes?.action;
      const pr = mergeRequestFromHook(payload);

      // An action-less hook (older GitLab) is treated as an update.
      if (!pr || (action && !MERGE_REQUEST_ACTIONS.has(action)))
        return 'ignored';

      // A token problem must not stop the link itself: the verdicts then stay as stored.
      const reviews = await this.tokenFor(connection)
        .then((token) =>
          this.readReviews(token, repository, pr.number, payload.reviewers),
        )
        .catch((error: unknown) => {
          this.logger.warn(
            `GitLab reviews ${repository.id}: ${messageOf(error)}`,
          );

          return undefined;
        });

      await this.pullRequests.sync(
        repository,
        { ...pr, reviews },
        actorOf(payload),
      );

      return 'processed';
    }

    if (payload?.object_kind === 'push') {
      const name = branchFromRef(payload.ref);

      if (!name) return 'ignored';

      const deleted = ZERO_SHA.test(payload.after ?? '');
      const last = payload.commits?.[payload.commits.length - 1]?.timestamp;

      await this.pullRequests.syncBranch(
        repository,
        name,
        deleted ? null : (isoOrNull(last) ?? new Date().toISOString()),
        deleted,
        actorOf(payload),
      );

      if (!deleted)
        await this.applyCommits(connection, repository, name, payload);

      return 'processed';
    }

    if (payload?.object_kind === 'pipeline') {
      const hook = payload as unknown as IGitlabPipelineHook;
      const attrs = hook.object_attributes;

      if (!attrs?.id || !attrs.sha || attrs.tag) return 'ignored';

      const build = buildFromGitlabPipeline(
        {
          id: attrs.id,
          name: attrs.name,
          ref: attrs.ref,
          sha: attrs.sha,
          status: attrs.status ?? '',
          url: attrs.url,
          createdAt: attrs.created_at,
          finishedAt: attrs.finished_at,
        },
        repository.web_url,
        hook.merge_request?.source_branch ?? null,
      );

      if (!build) return 'ignored';

      await this.pullRequests.syncBuilds(
        repository,
        [build],
        false,
        actorOf(hook),
      );

      return 'processed';
    }

    return 'ignored';
  }

  /** Ticket 7: the latest pipelines of a commit (manual link, first import); none when they cannot be read. */
  private async pipelinesFor(
    token: string,
    repository: IGitRepositoryRow,
    sha: string | null | undefined,
    sourceBranch: string | null,
  ): Promise<IProviderBuild[]> {
    if (!sha) return [];

    try {
      const pipelines = await this.client.api<IGitlabApiPipeline[]>(
        await this.appOf(repository),
        `/projects/${encodeURIComponent(repository.external_id)}/pipelines?${new URLSearchParams({ sha, per_page: '20' }).toString()}`,
        token,
      );

      return (pipelines ?? []).flatMap(
        (pipeline) =>
          buildFromGitlabPipeline(
            {
              id: pipeline.id,
              name: pipeline.name,
              ref: pipeline.ref,
              sha: pipeline.sha,
              status: pipeline.status,
              url: pipeline.web_url,
              createdAt: pipeline.created_at,
              finishedAt: pipeline.updated_at,
              updatedAt: pipeline.updated_at,
            },
            repository.web_url,
            sourceBranch,
          ) ?? [],
      );
    } catch (error) {
      this.logger.warn(
        `GitLab pipelines ${repository.id} ${sha}: ${messageOf(error)}`,
      );

      return [];
    }
  }

  /**
   * Ticket 6: the pushed commits whose message names a task key, when the organization links commits.
   * The hook lists only the newest 20 and carries committer dates, so one compare read supplies every
   * commit with its author date (the change identity across rebase / amend). If that read fails, the
   * hook's commits are linked with their committer date.
   */
  private async applyCommits(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
    branch: string,
    payload: IGitlabPushHook,
  ): Promise<void> {
    const listed = payload.commits ?? [];
    const truncated = (payload.total_commits_count ?? 0) > listed.length;

    if (
      !truncated &&
      !listed.some((commit) => extractTaskKeys(commit.message).length)
    )
      return;
    if (!(await this.pullRequests.commitLinkingEnabled(repository))) return;

    // A new branch has no `before`: compare from the default branch (GitLab lists the same commits).
    const from =
      payload.before && !ZERO_SHA.test(payload.before)
        ? payload.before
        : repository.default_branch;
    let commits = listed.flatMap((commit) => commitFromHook(commit) ?? []);

    if (from && payload.after) {
      try {
        const compare = await this.client.api<{ commits?: IGitlabApiCommit[] }>(
          await this.appOf(connection),
          `/projects/${encodeURIComponent(repository.external_id)}/repository/compare?${new URLSearchParams({ from, to: payload.after }).toString()}`,
          await this.tokenFor(connection),
        );

        commits = (compare?.commits ?? []).flatMap(
          (commit) => commitFromApi(commit, repository.web_url) ?? [],
        );
      } catch (error) {
        this.logger.warn(
          `GitLab compare ${repository.id} ${from}..${payload.after}: ${messageOf(error)}`,
        );
      }
    }

    // ponytail: a push of more than 2048 commits links the newest 2048.
    await this.pullRequests.syncCommits(
      repository,
      branch,
      commits.slice(-MAX_PUSH_COMMITS),
      actorOf(payload),
    );
  }

  // ---------------------------------------------------------------------------
  // Credentials and tokens
  // ---------------------------------------------------------------------------

  /** Only the user who signed in, in the org they signed in for: a credential id in a URL is useless to anyone else. */
  private async loadCredential(
    user: RequestUser,
    credentialId: string,
  ): Promise<IGitCredentialRow> {
    const { data, error } = await this.db
      .from(CREDENTIALS)
      .select('*')
      .eq('id', credentialId)
      .eq('organization_id', user.organizationId)
      .eq('created_by', user.userId)
      .eq('provider', 'gitlab')
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);

    const row = data as IGitCredentialRow | null;

    if (
      !row ||
      row.organization_id !== user.organizationId ||
      row.created_by !== user.userId
    ) {
      throw new NotFoundException('GitLab authorization not found');
    }

    return row;
  }

  private readCredential(
    id: string,
    organizationId: string,
  ): Promise<IGitCredentialRow | null> {
    return this.tokens.read(id, organizationId);
  }

  private async tokenFor(connection: IGitConnectionRow): Promise<string> {
    const credential = connection.credential_id
      ? await this.readCredential(
          connection.credential_id,
          connection.organization_id,
        )
      : null;

    if (!credential) throw new Error('GitLab connection has no authorization');

    return this.getAccessToken(credential);
  }

  private tokensOf(row: IGitCredentialRow): IStoredTokens {
    return storedTokens(row);
  }

  /** An access token that works now (refresh under a lease, shared with Azure DevOps). */
  private getAccessToken(first: IGitCredentialRow): Promise<string> {
    return this.tokens.getAccessToken(first);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Hooks for enabled, still-granted projects that have none yet. */
  private async repairHooks(connection: IGitConnectionRow): Promise<void> {
    const rows = await this.core.listRepositories(
      connection.organization_id,
      connection.id,
    );

    await this.applyRepositorySelection(
      connection,
      rows.filter(
        (row) => row.is_enabled && !row.removed_at && !row.webhook_id,
      ),
      [],
    );
  }

  /** Deletes a project hook (404 = already gone) and clears it from the row; on other errors the row keeps it. */
  private async deleteHook(
    row: IGitRepositoryRow,
    token: string,
  ): Promise<void> {
    try {
      await this.client.api(
        await this.appOf(row),
        `/projects/${encodeURIComponent(row.external_id)}/hooks/${encodeURIComponent(row.webhook_id ?? '')}`,
        token,
        { method: 'DELETE' },
      );
    } catch (error) {
      if (!(error instanceof GitlabApiError && error.status === 404)) {
        this.logger.warn(
          `GitLab hook delete ${row.full_name}: ${messageOf(error)}`,
        );

        return;
      }
    }

    await this.core.updateRepositoryWebhook(row, {
      webhook_id: null,
      webhook_secret_encrypted: null,
      webhook_secret_iv: null,
      webhook_secret_tag: null,
      webhook_error: null,
    });
  }
}
