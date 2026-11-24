/**
 * @fileoverview GitHub half of the org-level Git integration: the App install / user-authorization
 * connect flow (signed `pick` token, nothing stored), repository sync, the App webhook (fanned out
 * to every XISUITE organization holding the installation) and the health check.
 *
 * Tenant isolation: an installation is only ever attached after the signed-in admin proved, with a
 * user OAuth token, that they can reach it. Every write goes through the core service, which scopes
 * by the connection's organization.
 * @module src/git-integrations/github/github-integration.service
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  createState,
  readState,
} from '../../calendar/integrations/calendar-oauth.state';
import { GitIntegrationsService } from '../git-integrations.service';
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
  buildStateFromGithub,
  buildStateFromGithubStatus,
  extractTaskKeys,
  integrationsPageUrl,
  isRepositoryLive,
  missingGithubPermissions,
  parseStateProviderTag,
  readToken,
  signToken,
  stateProviderTag,
} from '../git-integrations.util';
import { GitServersService, isAppComplete } from '../git-servers.service';
import {
  GithubApiError,
  GithubAppClient,
  githubAuthorizeUrl,
  githubInstallUrl,
  type IGithubCheckRun,
  type IGithubCommitStatus,
  type IGithubCompareCommit,
  type IGithubInstallation,
  type IGithubPermissions,
  type IGithubWorkflowRun,
  type IGithubPullRequest,
  type IGithubReview,
} from './github-app.client';

interface IPickEntry {
  id: number;
  accountId: number;
  login: string;
  type: string;
  avatarUrl: string | null;
  url: string | null;
}

interface IPickPayload {
  u: string;
  o: string;
  r?: string;
  /** The organization's own server (ticket 11); absent for the built-in App. */
  s?: string;
  i: IPickEntry[];
}

export interface IGithubPickDto {
  installations: {
    /** A string, as POST github/connections expects it back (GitHub ids can outgrow JS-safe numbers). */
    id: string;
    login: string;
    type: string;
    avatarUrl: string | null;
    alreadyConnected: boolean;
  }[];
  installUrl: string;
}

interface IWebhookRepo {
  id: number;
  full_name: string;
  html_url?: string;
  default_branch?: string | null;
  private?: boolean;
  archived?: boolean;
}

interface IWebhookPayload {
  action?: string;
  installation?: { id?: number };
  repositories_added?: IWebhookRepo[];
  repositories_removed?: IWebhookRepo[];
  repository?: IWebhookRepo;
  pull_request?: IGithubPullRequest;
  // pull_request_review (ticket 5)
  review?: IGithubReview;
  // create / delete / push (ticket 5)
  ref?: string;
  ref_type?: string;
  deleted?: boolean;
  head_commit?: { timestamp?: string } | null;
  // workflow_run (ticket 7)
  workflow_run?: IGithubWorkflowRun;
  // check_run: any CI app's check (GitHub Actions jobs are skipped, workflow_run covers them)
  check_run?: IGithubCheckRun;
  // status: a commit status; the payload IS the status (id, sha, context, state, ...)
  id?: number;
  sha?: string;
  context?: string;
  state?: string;
  target_url?: string | null;
  created_at?: string;
  updated_at?: string | null;
  branches?: { name: string }[];
  // push commits (ticket 6)
  before?: string;
  after?: string;
  commits?: IGithubPushCommit[];
  // ticket 8: who caused the event; a live delivery may move task status
  sender?: { id?: number; login?: string } | null;
}

/** Ticket 8: the webhook's sender, passed as the actor so only live events move task status. */
function actorOf(payload: IWebhookPayload): IGitActor {
  const sender = payload.sender;

  return {
    externalId: sender?.id != null ? String(sender.id) : null,
    login: sender?.login ?? null,
  };
}

/** A commit in a push payload: no parents, and `timestamp` is not documented as author or committer date. */
interface IGithubPushCommit {
  id: string;
  message: string;
  timestamp?: string;
  url: string;
  author?: { name?: string; email?: string; username?: string } | null;
}

const ZERO_SHA = /^0+$/;

/** Ticket 7: every workflow_run action changes the run's state. */
const WORKFLOW_RUN_ACTIONS = new Set(['requested', 'in_progress', 'completed']);

/** Ticket 7: the first import reads builds of at most this many open pull requests per repository. */
const IMPORT_BUILDS_LIMIT = 50;

/** A GitHub Actions run, normalised (ticket 7). A run from a fork keeps the fork's name. */
export function buildFromGithubRun(
  run: IGithubWorkflowRun,
  repositoryFullName: string,
): IProviderBuild {
  const headRepo = run.head_repository?.full_name ?? null;

  return {
    externalId: String(run.id),
    workflowKey: String(run.workflow_id),
    name: run.name || 'Workflow',
    headBranch: run.head_branch || null,
    headRepoFullName:
      headRepo && headRepo.toLowerCase() !== repositoryFullName.toLowerCase()
        ? headRepo
        : null,
    headSha: run.head_sha,
    state: buildStateFromGithub(run.status, run.conclusion),
    attempt: run.run_attempt ?? 1,
    url: run.html_url,
    startedAt: run.run_started_at ?? null,
    completedAt: run.status === 'completed' ? (run.updated_at ?? null) : null,
    createdAt: run.created_at,
    updatedAt: run.updated_at ?? null,
  };
}

/** Every `check_run` action that can change a check's state (`requested_action` changes nothing). */
const CHECK_RUN_ACTIONS = new Set(['created', 'completed', 'rerequested']);

/** GitHub Actions jobs are check runs too; their workflow_run is already the build. */
const ACTIONS_APP_SLUG = 'github-actions';

/** A short stable key (`external_id` / `workflow_key` allow 64 characters). */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

/**
 * A check run of another CI app (CircleCI, Jenkins, Buildkite ...), normalised; null for GitHub Actions jobs.
 * A re-run is a new check run with the same app and name, so it lands under the same workflow key.
 */
export function buildFromGithubCheckRun(
  run: IGithubCheckRun,
): IProviderBuild | null {
  if (run.app?.slug === ACTIONS_APP_SLUG) return null;

  const url = run.html_url || run.details_url;

  if (!url || !run.head_sha) return null;

  return {
    externalId: `check:${run.id}`,
    workflowKey: `check:${shortHash(`${run.app?.id ?? ''}:${run.name}`)}`,
    name: run.name || 'Check',
    headBranch: run.check_suite?.head_branch || null,
    headRepoFullName: null,
    headSha: run.head_sha,
    state: buildStateFromGithub(run.status, run.conclusion),
    attempt: 1,
    url,
    startedAt: run.started_at ?? null,
    completedAt: run.status === 'completed' ? (run.completed_at ?? null) : null,
    createdAt: run.started_at ?? new Date().toISOString(),
    updatedAt: run.completed_at ?? run.started_at ?? null,
  };
}

/**
 * A commit status, normalised: one build per (commit, context), so a new status of that context replaces
 * the shown one. Ordered by time only (`phase: 0`): a re-run goes from failure back to pending.
 * Of the branches whose head is the commit, the one naming a task wins, else the only one.
 */
export function buildFromGithubStatus(
  status: IGithubCommitStatus & { sha: string; branches?: { name: string }[] },
  repositoryWebUrl: string | null,
): IProviderBuild | null {
  if (!status.sha || !status.context) return null;

  const branches = (status.branches ?? []).map((branch) => branch.name);
  const branch =
    branches.find((name) => extractTaskKeys(name).length > 0) ??
    (branches.length === 1 ? branches[0] : null);
  const url =
    status.target_url ||
    (repositoryWebUrl ? `${repositoryWebUrl}/commit/${status.sha}` : null);

  if (!url) return null;

  return {
    externalId: `status:${shortHash(`${status.sha.toLowerCase()}:${status.context}`)}`,
    workflowKey: `status:${shortHash(status.context)}`,
    name: status.context,
    headBranch: branch,
    headRepoFullName: null,
    headSha: status.sha,
    state: buildStateFromGithubStatus(status.state),
    attempt: 1,
    url,
    startedAt: null,
    completedAt:
      status.state === 'pending'
        ? null
        : (status.updated_at ?? status.created_at),
    createdAt: status.created_at,
    updatedAt: status.updated_at ?? status.created_at,
    phase: 0,
  };
}

/** Compare pages read per push for author dates (ticket 6): up to 1000 commits. */
const COMPARE_PAGES = 10;

/**
 * A pushed commit, normalised. The compare API's entry (when it could be read) supplies the real author
 * and committer dates; otherwise the payload's timestamp stands in for both.
 */
export function toProviderCommit(
  commit: IGithubPushCommit,
  details: IGithubCompareCommit | undefined,
): IProviderCommit {
  const fallback = commit.timestamp ?? null;

  return {
    sha: commit.id,
    message: commit.message,
    url: commit.url,
    authorName: details?.commit.author?.name ?? commit.author?.name ?? null,
    authorEmail: details?.commit.author?.email ?? commit.author?.email ?? null,
    authorLogin: details?.author?.login ?? commit.author?.username ?? null,
    authoredAt: details?.commit.author?.date ?? fallback,
    committedAt:
      details?.commit.committer?.date ?? fallback ?? new Date().toISOString(),
  };
}

const REPOSITORY_PATCH_ACTIONS = new Set([
  'renamed',
  'transferred',
  'edited',
  'privatized',
  'publicized',
  'archived',
  'unarchived',
]);

/** Pull request actions that can change state, draft flag, branch, title or description. */
const PULL_REQUEST_ACTIONS = new Set([
  'opened',
  'reopened',
  'edited',
  'closed',
  'synchronize',
  'ready_for_review',
  'converted_to_draft',
]);

/** First-connection import: at most this many pages of 100 per state. */
const BACKFILL_PAGES = 10;

/** Reviews read per pull request (manual link, import). */
const REVIEW_PAGES = 3;

/** ponytail: the first import reads reviews of at most this many open pull requests per repository. */
const IMPORT_REVIEWS_LIMIT = 50;

const REVIEW_ACTIONS = new Set(['submitted', 'edited', 'dismissed']);

const VERDICTS = new Set(['approved', 'changes_requested', 'dismissed']);

/**
 * Each reviewer's latest verdict from a pull request's reviews (REST, oldest first). Comments and
 * pending reviews never change a verdict; a dismissed review clears it.
 */
export function reviewsFromGithub(reviews: IGithubReview[]): IProviderReview[] {
  const latest = new Map<string, IProviderReview>();

  for (const review of reviews) {
    const state = review.state.toLowerCase();

    if (!review.user || !VERDICTS.has(state)) continue;

    latest.set(String(review.user.id), {
      reviewerId: String(review.user.id),
      login: review.user.login,
      state: state as IProviderReview['state'],
      submittedAt: review.submitted_at,
    });
  }

  return [...latest.values()];
}

/** The provider-neutral shape of a GitHub pull request (webhook payload and REST API are the same). */
export function toProviderPullRequest(
  pr: IGithubPullRequest,
): IProviderPullRequest {
  const head = pr.head?.repo?.full_name ?? null;

  return {
    number: pr.number,
    externalId: String(pr.id),
    title: pr.title,
    url: pr.html_url,
    state:
      pr.merged_at || pr.merged
        ? 'merged'
        : pr.state === 'closed'
          ? 'closed'
          : 'open',
    isDraft: Boolean(pr.draft),
    sourceBranch: pr.head?.ref ?? null,
    targetBranch: pr.base?.ref ?? null,
    headRepoFullName: head && head !== pr.base?.repo?.full_name ? head : null,
    author: pr.user
      ? {
          externalId: String(pr.user.id),
          login: pr.user.login,
          avatarUrl: pr.user.avatar_url ?? null,
          type: pr.user.type ?? null,
        }
      : null,
    openedAt: pr.created_at ?? null,
    closedAt: pr.closed_at ?? null,
    mergedAt: pr.merged_at ?? null,
    updatedAt: pr.updated_at,
    body: pr.body ?? null,
    headSha: pr.head?.sha ?? null,
    // While open, merge_commit_sha is GitHub's test merge, not something that lands.
    mergeCommitShas:
      (pr.merged_at || pr.merged) && pr.merge_commit_sha
        ? [pr.merge_commit_sha]
        : [],
  };
}

/**
 * The GitHub web origin of a connection (`https://github.com`, `https://ghe.company.local`), from the
 * account's own page address; the host key as a fallback.
 */
function webOrigin(connection: IGitConnectionRow): string {
  try {
    if (connection.account_url) return new URL(connection.account_url).origin;
  } catch {
    // fall through
  }

  return `https://${connection.host}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class GithubIntegrationService implements IGitProviderAdapter {
  readonly provider = 'github' as const;
  private readonly logger = new Logger(GithubIntegrationService.name);

  constructor(
    private readonly core: GitIntegrationsService,
    private readonly client: GithubAppClient,
    private readonly servers: GitServersService,
    private readonly pullRequests: GitPullRequestsService,
  ) {}

  /** The App serving this connection: the organization's own server for its host, else the built-in App. */
  private app(conn: IGitConnectionRow): Promise<IGitApp> {
    return this.servers.appFor(conn.organization_id, 'github', conn.host);
  }

  private get redirectUri(): string {
    return `${this.servers.publicApiUrl}/git-integrations/github/callback`;
  }

  /** The built-in XISUITE App (own servers carry their own `configured` flag, ticket 11). */
  isConfigured(): boolean {
    return this.servers.isBuiltinConfigured('github');
  }

  /**
   * The App a connect / reconnect starts with: a reconnect follows its connection's host, a new connect
   * uses the organization's server `serverId` or the built-in App.
   */
  private async startApp(
    organizationId: string,
    connectionId?: string,
    serverId?: string | null,
  ): Promise<IGitApp> {
    if (connectionId) {
      const connection = await this.core.getConnection(
        organizationId,
        connectionId,
      );

      return this.app(connection);
    }

    return this.servers.appForStart(organizationId, 'github', serverId);
  }

  async connectUrl(
    userId: string,
    organizationId: string,
    returnTo: string | undefined,
    connectionId?: string,
    serverId?: string,
  ): Promise<string> {
    const app = await this.startApp(organizationId, connectionId, serverId);

    if (!isAppComplete(app)) throw new BadRequestException('not_configured');

    const query = new URLSearchParams({
      client_id: app.clientId!,
      redirect_uri: this.redirectUri,
      state: createState(
        userId,
        organizationId,
        stateProviderTag('github', connectionId, app.serverId),
        returnTo,
      ),
    });

    return `${githubAuthorizeUrl(app)}?${query.toString()}`;
  }

  // ---------------------------------------------------------------------------
  // Connect flow
  // ---------------------------------------------------------------------------

  /** OAuth / install callback. Never throws: every failure becomes an `error=` code on the page URL. */
  async handleCallback(input: {
    code?: string;
    state?: string;
    installationId?: string;
    setupAction?: string;
    error?: string;
  }): Promise<string> {
    const state = readState(input.state);
    const tag = state ? parseStateProviderTag(state.provider) : null;

    // "Redirect on update": the admin changed the installation's repository access on GitHub, outside any
    // XISUITE connect flow (no state). The change itself arrives as an installation_repositories event.
    if (
      (!state || tag?.provider !== 'github') &&
      input.setupAction === 'update'
    )
      return integrationsPageUrl(undefined, 'github');

    if (!state || tag?.provider !== 'github')
      return integrationsPageUrl(undefined, 'github', { error: 'expired' });

    const { userId, organizationId, returnTo } = state;
    const serverId = tag.serverId;
    const done = (params: Record<string, string>) =>
      integrationsPageUrl(returnTo, 'github', {
        ...params,
        ...(serverId && { server: serverId }),
      });

    try {
      if (input.error) return done({ error: input.error.slice(0, 50) });
      if (input.setupAction === 'request')
        return done({ error: 'pending_approval' });
      // An update redirect without a user authorization: nothing to connect, the event carries the change.
      if (!input.code)
        return done(input.setupAction === 'update' ? {} : { error: 'expired' });
      if (!(await this.core.isOrgAdmin(organizationId, userId)))
        return done({ error: 'forbidden' });

      let app: IGitApp;

      try {
        app = await this.servers.appForStart(
          organizationId,
          'github',
          serverId,
        );
      } catch (error) {
        this.logger.warn(
          `GitHub callback server ${serverId}: ${message(error)}`,
        );

        return done({ error: 'not_configured' });
      }

      if (!isAppComplete(app)) return done({ error: 'not_configured' });

      let entries: IPickEntry[];
      let eligible: IPickEntry[];

      try {
        // The user token only proves access; it is dropped at the end of this block.
        const userToken = await this.client.exchangeCode(
          app,
          input.code,
          this.redirectUri,
        );
        const installations = await this.client.listUserInstallations(
          app,
          userToken,
        );
        const appId = Number(app.appId);

        entries = installations
          .filter((inst) => inst.app_id === undefined || inst.app_id === appId)
          .map((inst) => ({
            id: inst.id,
            accountId: inst.account.id,
            login: inst.account.login,
            type: inst.account.type,
            avatarUrl: inst.account.avatar_url ?? null,
            url: inst.account.html_url ?? null,
          }));
        eligible = await this.adminEntries(app, userToken, entries);
      } catch (error) {
        this.logger.warn(`GitHub callback exchange: ${message(error)}`);

        return done({ error: 'exchange_failed' });
      }

      if (input.installationId) {
        const entry = entries.find(
          (e) => String(e.id) === input.installationId,
        );

        if (!entry) return done({ error: 'installation_not_accessible' });
        if (!eligible.includes(entry))
          return done({ error: 'not_account_admin' });

        try {
          await this.connectEntry(app, userId, organizationId, entry);
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;

          // Already connected here: an update of the installation (repository access changed on GitHub)
          // is a success, not an error. Its repository list is refreshed right away.
          if (input.setupAction === 'update') {
            await this.refreshExistingInstallation(
              organizationId,
              app.host,
              String(entry.id),
            );

            return done({});
          }

          return done({ error: 'already_connected' });
        }

        return done({ connected: 'github' });
      }

      return done({
        pick: signToken({
          u: userId,
          o: organizationId,
          r: returnTo,
          ...(app.serverId && { s: app.serverId }),
          i: eligible,
        } satisfies IPickPayload),
      });
    } catch (error) {
      this.logger.error(`GitHub callback: ${message(error)}`);

      return done({ error: 'connect_failed' });
    }
  }

  /**
   * Only accounts the user administers: an active org admin, or the personal account itself.
   * Membership alone would let any member attach the org and see its private repositories.
   */
  private async adminEntries(
    app: IGitApp,
    userToken: string,
    entries: IPickEntry[],
  ): Promise<IPickEntry[]> {
    const githubUserId = entries.some((e) => e.type === 'User')
      ? (await this.client.getUser(app, userToken)).id
      : null;
    const result: IPickEntry[] = [];

    for (const entry of entries) {
      if (entry.type === 'User') {
        if (entry.accountId === githubUserId) result.push(entry);
        continue;
      }

      if (entry.type !== 'Organization') continue;

      try {
        const membership = await this.client.getOrgMembership(
          app,
          userToken,
          entry.login,
        );

        if (membership.state === 'active' && membership.role === 'admin')
          result.push(entry);
      } catch (error) {
        // 403/404 or anything else: not provably an admin.
        this.logger.debug(
          `GitHub membership ${entry.login}: ${message(error)}`,
        );
      }
    }

    return result;
  }

  async getPick(user: RequestUser, token: string): Promise<IGithubPickDto> {
    const payload = await this.readPick(user, token);
    const app = await this.servers.appForStart(
      user.organizationId,
      'github',
      payload.s,
    );
    const connected = await this.connectedAccountIds(
      user.organizationId,
      app.host,
    );
    const state = createState(
      user.userId,
      user.organizationId,
      stateProviderTag('github', undefined, app.serverId),
      payload.r,
    );

    return {
      installations: payload.i.map((e) => ({
        id: String(e.id),
        login: e.login,
        type: e.type,
        avatarUrl: e.avatarUrl,
        alreadyConnected: connected.has(String(e.accountId)),
      })),
      installUrl: `${githubInstallUrl(app)}?state=${encodeURIComponent(state)}`,
    };
  }

  async connectInstallation(
    user: RequestUser,
    token: string,
    installationId: string,
  ): Promise<void> {
    const payload = await this.readPick(user, token);
    const entry = payload.i.find(
      (e) => String(e.id) === String(installationId),
    );

    if (!entry) throw new BadRequestException('installation_not_accessible');

    const app = await this.servers.appForStart(
      user.organizationId,
      'github',
      payload.s,
    );

    await this.connectEntry(app, user.userId, user.organizationId, entry);
  }

  private async readPick(
    user: RequestUser,
    token: string,
  ): Promise<IPickPayload> {
    const payload = readToken<IPickPayload>(token);

    if (
      !payload ||
      payload.u !== user.userId ||
      payload.o !== user.organizationId ||
      !Array.isArray(payload.i)
    ) {
      throw new BadRequestException('expired');
    }

    return payload;
  }

  /** Shared by the direct callback connect and the picker. `entry` comes from a user-authorized list. */
  private async connectEntry(
    app: IGitApp,
    userId: string,
    organizationId: string,
    entry: IPickEntry,
  ): Promise<void> {
    const installation = await this.client.getInstallation(
      app,
      String(entry.id),
    );

    // The installation must still belong to the account the user was authorized for.
    if (installation.account.id !== entry.accountId)
      throw new BadRequestException('installation_mismatch');

    const { connection } = await this.core.upsertConnection({
      organizationId,
      provider: 'github',
      host: app.host,
      account: {
        externalAccountId: String(installation.account.id),
        installationId: String(installation.id),
        login: installation.account.login,
        name: null,
        type: installation.account.type,
        avatarUrl: installation.account.avatar_url ?? null,
        url: installation.account.html_url ?? null,
      },
      userId,
    });

    if (installation.suspended_at)
      await this.core.setStatus(
        connection,
        'needs_attention',
        'suspended',
        userId,
      );

    try {
      await this.refreshRepositories(connection);
    } catch (error) {
      this.logger.warn(
        `Initial repository sync ${connection.id}: ${message(error)}`,
      );
    }
  }

  /** Best effort: re-reads the repositories of this organization's live connection(s) of an installation. */
  private async refreshExistingInstallation(
    organizationId: string,
    host: string,
    installationId: string,
  ): Promise<void> {
    try {
      const connections = await this.core.findLiveByInstallation(
        host,
        installationId,
        organizationId,
      );

      for (const connection of connections)
        await this.refreshRepositories(connection);
    } catch (error) {
      this.logger.warn(
        `GitHub installation update ${installationId}: ${message(error)}`,
      );
    }
  }

  /** Accounts already connected on this GitHub instance (greyed out in the picker). */
  private async connectedAccountIds(
    organizationId: string,
    host: string,
  ): Promise<Set<string>> {
    const connections = await this.core.listConnections(
      organizationId,
      'github',
    );

    return new Set(
      connections
        .filter((c) => c.status === 'active' && c.host === host)
        .map((c) => c.external_account_id),
    );
  }

  // ---------------------------------------------------------------------------
  // Repositories + adapter hooks
  // ---------------------------------------------------------------------------

  async refreshRepositories(connection: IGitConnectionRow): Promise<void> {
    const installationId = connection.installation_id;

    if (!installationId)
      throw new BadRequestException('Connection has no GitHub installation');

    const app = await this.app(connection);

    try {
      await this.client.installationToken(app, installationId);
    } catch (error) {
      if (
        error instanceof GithubApiError &&
        (error.status === 404 || error.status === 401)
      ) {
        await this.core.setStatus(connection, 'needs_attention', 'app_removed');
      }
      throw error;
    }

    const repositories = await this.client.listInstallationRepositories(
      app,
      installationId,
    );

    await this.core.upsertRepositories(
      connection,
      repositories.map(
        (repo): IProviderRepository => ({
          externalId: String(repo.id),
          fullName: repo.full_name,
          webUrl: repo.html_url,
          defaultBranch: repo.default_branch,
          isPrivate: repo.private,
          isArchived: repo.archived,
        }),
      ),
      true,
    );
  }

  /**
   * Full details (default branch, archived) of repositories an `installation_repositories` event added.
   * Never a full sync: a list that lags behind the event must not mark anything removed.
   */
  private async refreshAddedRepositories(
    connection: IGitConnectionRow,
    externalIds: Set<string>,
  ): Promise<void> {
    if (!connection.installation_id || !externalIds.size) return;

    const repositories = await this.client.listInstallationRepositories(
      await this.app(connection),
      connection.installation_id,
    );

    await this.core.upsertRepositories(
      connection,
      repositories
        .filter((repo) => externalIds.has(String(repo.id)))
        .map(
          (repo): IProviderRepository => ({
            externalId: String(repo.id),
            fullName: repo.full_name,
            webUrl: repo.html_url,
            defaultBranch: repo.default_branch,
            isPrivate: repo.private,
            isArchived: repo.archived,
          }),
        ),
      false,
    );
  }

  /** GitHub delivers through the single App webhook; `is_enabled` is read when events are processed. */
  async applyRepositorySelection(
    _connection: IGitConnectionRow,
    _enabled: IGitRepositoryRow[],
    _disabled: IGitRepositoryRow[],
  ): Promise<void> {}

  /** Never uninstalls the App: another XISUITE organization may share the installation. */
  async onDisconnect(_connection: IGitConnectionRow): Promise<void> {}

  manageUrl(connection: IGitConnectionRow): string | null {
    if (!connection.installation_id) return null;

    const origin = webOrigin(connection);

    return connection.account_type === 'Organization'
      ? `${origin}/organizations/${connection.account_login}/settings/installations/${connection.installation_id}`
      : `${origin}/settings/installations/${connection.installation_id}`;
  }

  async fetchPullRequest(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
    number: number,
  ): Promise<IProviderPullRequest> {
    if (!connection.installation_id)
      throw new UnprocessableEntityException('repository_not_connected');

    const app = await this.app(connection);

    try {
      const [pull, reviews] = await Promise.all([
        this.client.getPull(
          app,
          connection.installation_id,
          repository.full_name,
          number,
        ),
        this.client.listReviews(
          app,
          connection.installation_id,
          repository.full_name,
          number,
          REVIEW_PAGES,
        ),
      ]);

      const pr = toProviderPullRequest(pull);

      return {
        ...pr,
        reviews: reviewsFromGithub(reviews),
        builds:
          pr.state === 'open'
            ? await this.buildsFor(
                app,
                connection.installation_id,
                repository,
                pr.headSha,
              )
            : [],
      };
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 404)
        throw new NotFoundException('pull_request_not_found');

      throw error;
    }
  }

  async listRecentPullRequests(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
    since: Date,
  ): Promise<IProviderPullRequest[]> {
    if (!connection.installation_id) return [];

    const app = await this.app(connection);
    const [open, closed] = await Promise.all([
      this.client.listPulls(
        app,
        connection.installation_id,
        repository.full_name,
        'open',
        BACKFILL_PAGES,
      ),
      this.client.listPulls(
        app,
        connection.installation_id,
        repository.full_name,
        'closed',
        BACKFILL_PAGES,
        since,
      ),
    ]);

    const result = [...open, ...closed].map(toProviderPullRequest);

    // Merged and closed pull requests show Merged / Closed whatever the reviews say.
    for (const pr of result
      .filter((p) => p.state === 'open')
      .slice(0, IMPORT_BUILDS_LIMIT))
      pr.builds = await this.buildsFor(
        app,
        connection.installation_id,
        repository,
        pr.headSha,
      );

    for (const pr of result
      .filter((p) => p.state === 'open')
      .slice(0, IMPORT_REVIEWS_LIMIT)) {
      pr.reviews = reviewsFromGithub(
        await this.client.listReviews(
          app,
          connection.installation_id,
          repository.full_name,
          pr.number,
          REVIEW_PAGES,
        ),
      );
    }

    return result;
  }

  async listKeyBranches(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
  ): Promise<IProviderBranch[]> {
    if (!connection.installation_id) return [];

    const branches = await this.client.listBranches(
      await this.app(connection),
      connection.installation_id,
      repository.full_name,
      BACKFILL_PAGES,
    );

    return branches
      .filter((branch) => extractTaskKeys(branch.name).length > 0)
      .map((branch) => ({ name: branch.name, pushedAt: null }));
  }

  /**
   * Runs whether or not the built-in App is configured (ticket 11): own servers are checked with their
   * own App. Installations are grouped per App, because installation ids are only unique per App's
   * GitHub instance. A connection whose App cannot be resolved is skipped, never flagged.
   */
  async checkHealth(): Promise<void> {
    const byInstallation = new Map<
      string,
      { app: IGitApp; installationId: string; conns: IGitConnectionRow[] }
    >();

    for (const conn of await this.core.listAllLive('github')) {
      if (!conn.installation_id) continue;

      let app: IGitApp;

      try {
        app = await this.app(conn);
      } catch (error) {
        this.logger.warn(`GitHub health ${conn.id}: ${message(error)}`);
        continue;
      }

      if (!app.appId || !app.privateKey) continue;

      const key = `${app.serverId ?? 'builtin'}:${conn.installation_id}`;
      const group = byInstallation.get(key);

      if (group) group.conns.push(conn);
      else
        byInstallation.set(key, {
          app,
          installationId: conn.installation_id,
          conns: [conn],
        });
    }

    // The App's own (requested) permissions, read once per App per run; null = unknown, never flags.
    const appPermissions = new Map<string, IGithubPermissions | null>();
    const permissionsOf = async (
      app: IGitApp,
    ): Promise<IGithubPermissions | null> => {
      const key = app.serverId ?? 'builtin';

      if (!appPermissions.has(key)) {
        try {
          appPermissions.set(
            key,
            (await this.client.getApp(app)).permissions ?? null,
          );
        } catch (error) {
          this.logger.warn(`GitHub app permissions ${key}: ${message(error)}`);
          appPermissions.set(key, null);
        }
      }

      return appPermissions.get(key) ?? null;
    };

    for (const { app, installationId, conns } of byInstallation.values()) {
      try {
        let installation: IGithubInstallation;

        try {
          installation = await this.client.getInstallation(app, installationId);
        } catch (error) {
          if (error instanceof GithubApiError && error.status === 404) {
            for (const conn of conns)
              await this.core.setStatus(conn, 'needs_attention', 'app_removed');
          } else {
            // 5xx, timeouts, network: keep the last known status.
            this.logger.warn(
              `GitHub health ${installationId}: ${message(error)}`,
            );
          }
          continue;
        }

        if (installation.suspended_at) {
          for (const conn of conns)
            await this.core.setStatus(conn, 'needs_attention', 'suspended');
          continue;
        }

        // GitHub sends no event when the App asks for more permissions, only when they are accepted.
        const required = await permissionsOf(app);
        const pending =
          required !== null && installation.permissions !== undefined
            ? missingGithubPermissions(
                required,
                installation.permissions,
                installation.account.type,
              ).length > 0
            : null;

        for (const conn of conns) {
          const reason = conn.status_reason as GitAttentionReason | null;

          if (
            conn.status === 'needs_attention' &&
            (reason === 'app_removed' || reason === 'suspended')
          ) {
            await this.core.setStatus(conn, 'active', reason);
          }

          // Conditional writes: flags only an active connection, clears only this reason.
          if (pending === true)
            await this.core.setStatus(
              conn,
              'needs_attention',
              'permissions_pending',
            );
          else if (pending === false && reason === 'permissions_pending')
            await this.core.setStatus(conn, 'active', 'permissions_pending');

          if (installation.account.login !== conn.account_login) {
            await this.core.updateAccountDetails(conn, {
              externalAccountId: conn.external_account_id,
              login: installation.account.login,
              name: conn.account_name,
              type: installation.account.type,
              avatarUrl: installation.account.avatar_url ?? null,
              url: installation.account.html_url ?? null,
            });
          }
        }
      } catch (error) {
        this.logger.warn(`GitHub health ${installationId}: ${message(error)}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook
  // ---------------------------------------------------------------------------

  /**
   * The built-in App's webhook (no `serverId`), or an organization's own App on its server (ticket 11):
   * verified with that server's secret and fanned out to that organization only.
   */
  async handleWebhook(input: {
    event?: string;
    deliveryId?: string;
    signature?: string;
    rawBody: Buffer | undefined;
    serverId?: string;
  }): Promise<'ok' | 'unauthorized'> {
    const { event = '', deliveryId, signature, rawBody, serverId } = input;

    if (!rawBody || !signature) return 'unauthorized';

    let secret: string | undefined;
    let scope: { host: string; organizationId?: string };

    if (serverId) {
      const server = await this.servers.findById(serverId);

      if (!server || server.provider !== 'github') return 'unauthorized';

      secret = this.servers.toApp(server).webhookSecret;
      scope = { host: server.host, organizationId: server.organization_id };
    } else {
      if (!this.isConfigured()) return 'unauthorized';

      secret = this.servers.builtinApp('github').webhookSecret;
      scope = { host: this.servers.builtinHost('github') };
    }

    if (!secret) return 'unauthorized';

    const expected = Buffer.from(
      `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
    );
    const given = Buffer.from(signature);

    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      return 'unauthorized';

    // Proof that the server reaches XISUITE ("Test connection", health), also for ping / ignored events.
    if (serverId) await this.servers.touchWebhook(serverId);

    let payload: IWebhookPayload;

    try {
      payload = JSON.parse(rawBody.toString('utf8')) as IWebhookPayload;
    } catch {
      return 'ok';
    }

    if (
      deliveryId &&
      !(await this.core.recordDelivery('github', deliveryId, event))
    )
      return 'ok';

    let outcome = 'ignored';

    try {
      outcome = await this.dispatch(event, payload, scope);
    } catch (error) {
      outcome = 'error';
      this.logger.error(
        `GitHub webhook ${event}/${deliveryId}: ${message(error)}`,
      );
    }

    if (deliveryId) {
      try {
        // A failed delivery is forgotten so GitHub's redelivery is processed (handlers are idempotent).
        if (outcome === 'error' || outcome === 'partial_error') {
          await this.core.forgetDelivery('github', deliveryId);
        } else {
          await this.core.setDeliveryOutcome('github', deliveryId, outcome);
        }
      } catch (error) {
        this.logger.warn(`setDeliveryOutcome ${deliveryId}: ${message(error)}`);
      }
    }

    return 'ok';
  }

  private async dispatch(
    event: string,
    payload: IWebhookPayload,
    scope: { host: string; organizationId?: string },
  ): Promise<string> {
    const installationId = payload.installation?.id;

    if (!installationId) return 'ignored';
    if (
      ![
        'installation',
        'installation_repositories',
        'repository',
        'pull_request',
        'pull_request_review',
        'create',
        'delete',
        'push',
        'workflow_run',
        'check_run',
        'status',
      ].includes(event)
    )
      return 'ignored';

    const conns = await this.core.findLiveByInstallation(
      scope.host,
      String(installationId),
      scope.organizationId,
    );

    if (!conns.length) return 'no_connection';

    let failures = 0;
    let handled = false;

    // One XISUITE organization's failure must never affect another's.
    for (const conn of conns) {
      try {
        handled = (await this.apply(conn, event, payload)) || handled;
      } catch (error) {
        failures++;
        this.logger.error(
          `GitHub ${event} for connection ${conn.id}: ${message(error)}`,
        );
      }
    }

    if (failures) return failures === conns.length ? 'error' : 'partial_error';

    return handled ? 'processed' : 'ignored';
  }

  /** @returns whether the event/action was one this ticket handles. */
  private async apply(
    conn: IGitConnectionRow,
    event: string,
    payload: IWebhookPayload,
  ): Promise<boolean> {
    const action = payload.action;

    if (event === 'pull_request') return this.applyPullRequest(conn, payload);
    if (event === 'pull_request_review') return this.applyReview(conn, payload);
    if (event === 'create' || event === 'delete' || event === 'push')
      return this.applyBranch(conn, event, payload);
    if (event === 'workflow_run') return this.applyWorkflowRun(conn, payload);
    if (event === 'check_run') return this.applyCheckRun(conn, payload);
    if (event === 'status') return this.applyStatus(conn, payload);

    if (event === 'installation') {
      switch (action) {
        case 'deleted':
          await this.core.setStatus(conn, 'needs_attention', 'app_removed');
          return true;
        case 'suspend':
          await this.core.setStatus(conn, 'needs_attention', 'suspended');
          return true;
        case 'unsuspend':
          await this.core.setStatus(conn, 'active', 'suspended');
          return true;
        case 'new_permissions_accepted':
          await this.core.setStatus(conn, 'active', 'permissions_pending');
          return true;
        default:
          return false;
      }
    }

    if (event === 'installation_repositories') {
      const added = payload.repositories_added ?? [];
      const removed = payload.repositories_removed ?? [];

      if (added.length) {
        // The event lists only id / name / private: default branch and archived state are left as stored
        // (undefined) and read right after from the API.
        await this.core.upsertRepositories(
          conn,
          added.map((repo) => ({
            externalId: String(repo.id),
            fullName: repo.full_name,
            webUrl: `${webOrigin(conn)}/${repo.full_name}`,
            defaultBranch: undefined,
            isPrivate: Boolean(repo.private),
            isArchived: false,
          })),
          false,
        );
      }

      if (removed.length)
        await this.core.markRepositoriesRemoved(
          conn,
          removed.map((repo) => String(repo.id)),
        );

      if (added.length) {
        try {
          await this.refreshAddedRepositories(
            conn,
            new Set(added.map((repo) => String(repo.id))),
          );
        } catch (error) {
          // The rows exist; default branches follow with the next refresh or `repository` event.
          this.logger.warn(
            `GitHub repositories refresh ${conn.id}: ${message(error)}`,
          );
        }
      }

      return added.length > 0 || removed.length > 0;
    }

    // event === 'repository'
    const repo = payload.repository;

    if (!repo || !action) return false;

    if (action === 'deleted') {
      await this.core.patchRepository(conn, String(repo.id), {
        removed_at: new Date().toISOString(),
      });
      return true;
    }

    if (!REPOSITORY_PATCH_ACTIONS.has(action)) return false;

    await this.core.patchRepository(conn, String(repo.id), {
      full_name: repo.full_name,
      web_url: repo.html_url ?? null,
      default_branch: repo.default_branch ?? null,
      is_private: Boolean(repo.private),
      is_archived: Boolean(repo.archived),
    });

    return true;
  }

  /**
   * Links the pull request to the tasks its keys name, in this connection's organization only.
   * A repository that is unknown here, disabled, or no longer granted is skipped (handled, no change).
   */
  private async applyPullRequest(
    conn: IGitConnectionRow,
    payload: IWebhookPayload,
  ): Promise<boolean> {
    const pr = payload.pull_request;
    const repo = payload.repository;

    if (!pr || !repo || !PULL_REQUEST_ACTIONS.has(payload.action ?? ''))
      return false;

    const repository = await this.core.findRepository(conn, String(repo.id));

    if (!repository || !isRepositoryLive(conn, repository)) return true;

    await this.pullRequests.sync(
      repository,
      toProviderPullRequest(pr),
      actorOf(payload),
    );

    return true;
  }

  /** This connection's live repository row for the event, or null (unknown here, disabled, removed). */
  private async liveRepository(
    conn: IGitConnectionRow,
    payload: IWebhookPayload,
  ): Promise<IGitRepositoryRow | null> {
    if (!payload.repository) return null;

    const repository = await this.core.findRepository(
      conn,
      String(payload.repository.id),
    );

    return repository && isRepositoryLive(conn, repository) ? repository : null;
  }

  /** A review was submitted, edited or dismissed: the reviewer's verdict changes (ticket 5). */
  private async applyReview(
    conn: IGitConnectionRow,
    payload: IWebhookPayload,
  ): Promise<boolean> {
    const { review, pull_request: pr } = payload;

    if (!review?.user || !pr || !REVIEW_ACTIONS.has(payload.action ?? ''))
      return false;

    const repository = await this.liveRepository(conn, payload);

    if (!repository) return true;

    await this.pullRequests.recordReview(repository, pr.number, {
      reviewerId: String(review.user.id),
      login: review.user.login,
      state: payload.action === 'dismissed' ? 'dismissed' : review.state,
      submittedAt: review.submitted_at,
    });

    return true;
  }

  /**
   * Branch created, deleted or pushed (ticket 5). Only branches whose name contains a task key are
   * kept; tags and other refs are ignored. `create` carries a bare name, `push` a full ref.
   */
  private async applyBranch(
    conn: IGitConnectionRow,
    event: 'create' | 'delete' | 'push',
    payload: IWebhookPayload,
  ): Promise<boolean> {
    if (event !== 'push' && payload.ref_type !== 'branch') return false;

    const name = branchFromRef(payload.ref);

    if (!name) return false;

    const repository = await this.liveRepository(conn, payload);

    if (!repository) return true;

    const deleted =
      event === 'delete' || (event === 'push' && payload.deleted === true);

    await this.pullRequests.syncBranch(
      repository,
      name,
      deleted
        ? null
        : (payload.head_commit?.timestamp ?? new Date().toISOString()),
      deleted,
      actorOf(payload),
    );

    if (event === 'push' && !deleted)
      await this.applyCommits(conn, repository, name, payload);

    return true;
  }

  /**
   * Ticket 7: an Actions run was requested, started or finished. Whether it is kept (task key in the
   * branch, a known pull request's commit, the default branch, ...) is decided in `git_sync_build`.
   */
  private async applyWorkflowRun(
    conn: IGitConnectionRow,
    payload: IWebhookPayload,
  ): Promise<boolean> {
    const run = payload.workflow_run;

    if (!run || !WORKFLOW_RUN_ACTIONS.has(payload.action ?? '')) return false;

    const repository = await this.liveRepository(conn, payload);

    if (!repository) return true;

    await this.pullRequests.syncBuilds(
      repository,
      [buildFromGithubRun(run, repository.full_name)],
      true,
      actorOf(payload),
    );

    return true;
  }

  /** A check run of another CI app was created, completed or re-requested; kept like an Actions run. */
  private async applyCheckRun(
    conn: IGitConnectionRow,
    payload: IWebhookPayload,
  ): Promise<boolean> {
    const run = payload.check_run;

    if (!run || !CHECK_RUN_ACTIONS.has(payload.action ?? '')) return false;

    const build = buildFromGithubCheckRun(run);

    if (!build) return false;

    const repository = await this.liveRepository(conn, payload);

    if (!repository) return true;

    await this.pullRequests.syncBuilds(
      repository,
      [build],
      true,
      actorOf(payload),
    );

    return true;
  }

  /** A commit status (external CI posting through the statuses API). */
  private async applyStatus(
    conn: IGitConnectionRow,
    payload: IWebhookPayload,
  ): Promise<boolean> {
    if (!payload.sha || !payload.context || !payload.state) return false;

    const repository = await this.liveRepository(conn, payload);

    if (!repository) return true;

    const build = buildFromGithubStatus(
      {
        id: payload.id ?? 0,
        sha: payload.sha,
        context: payload.context,
        state: payload.state,
        target_url: payload.target_url ?? null,
        created_at: payload.created_at ?? new Date().toISOString(),
        updated_at: payload.updated_at ?? null,
        branches: payload.branches,
      },
      repository.web_url,
    );

    if (!build) return false;

    await this.pullRequests.syncBuilds(
      repository,
      [build],
      true,
      actorOf(payload),
    );

    return true;
  }

  /** Ticket 7: the latest runs of a commit (manual link, first import); none when they cannot be read. */
  private async buildsFor(
    app: IGitApp,
    installationId: string,
    repository: IGitRepositoryRow,
    sha: string | null | undefined,
  ): Promise<IProviderBuild[]> {
    if (!sha) return [];

    // Each source on its own: a missing Checks / Commit statuses permission never hides the Actions runs.
    const read = async <T>(what: string, load: () => Promise<T[]>) => {
      try {
        return await load();
      } catch (error) {
        this.logger.warn(
          `GitHub ${what} ${repository.id} ${sha}: ${message(error)}`,
        );

        return [] as T[];
      }
    };

    const [runs, checks, statuses] = await Promise.all([
      read('runs', () =>
        this.client.listRunsForSha(
          app,
          installationId,
          repository.full_name,
          sha,
        ),
      ),
      read('check runs', () =>
        this.client.listCheckRunsForRef(
          app,
          installationId,
          repository.full_name,
          sha,
        ),
      ),
      read('statuses', () =>
        this.client.listStatusesForRef(
          app,
          installationId,
          repository.full_name,
          sha,
        ),
      ),
    ]);

    // The statuses API lists every status, newest first: the first per context is the current one.
    const seen = new Set<string>();
    const latestStatuses = statuses.filter((status) => {
      if (seen.has(status.context)) return false;
      seen.add(status.context);

      return true;
    });

    return [
      ...runs.map((run) => buildFromGithubRun(run, repository.full_name)),
      ...checks.map((check) => buildFromGithubCheckRun(check)),
      ...latestStatuses.map((status) =>
        buildFromGithubStatus({ ...status, sha }, repository.web_url),
      ),
    ].filter((build): build is IProviderBuild => build !== null);
  }

  /**
   * Ticket 6: the pushed commits whose message names a task key, when the organization links commits.
   * Author dates (the change identity across rebase / amend) come from one compare read; if that fails
   * the payload's timestamp is used and the commit is still linked.
   */
  private async applyCommits(
    conn: IGitConnectionRow,
    repository: IGitRepositoryRow,
    branch: string,
    payload: IWebhookPayload,
  ): Promise<void> {
    const commits = (payload.commits ?? []).slice(0, MAX_PUSH_COMMITS);

    if (!commits.some((commit) => extractTaskKeys(commit.message).length))
      return;
    if (!(await this.pullRequests.commitLinkingEnabled(repository))) return;

    const details = await this.compareDetails(conn, repository, payload);

    await this.pullRequests.syncCommits(
      repository,
      branch,
      commits.map((commit) => toProviderCommit(commit, details.get(commit.id))),
      actorOf(payload),
    );
  }

  /** The push's commits from the compare API, by sha; empty when it cannot be read. */
  private async compareDetails(
    conn: IGitConnectionRow,
    repository: IGitRepositoryRow,
    payload: IWebhookPayload,
  ): Promise<Map<string, IGithubCompareCommit>> {
    // A new branch has no `before`: compare from the default branch, as GitHub's own `compare` link does.
    const base =
      payload.before && !ZERO_SHA.test(payload.before)
        ? payload.before
        : repository.default_branch;

    if (!conn.installation_id || !base || !payload.after) return new Map();

    try {
      const commits = await this.client.compareCommits(
        await this.app(conn),
        conn.installation_id,
        repository.full_name,
        base,
        payload.after,
        COMPARE_PAGES,
      );

      return new Map(commits.map((commit) => [commit.sha, commit]));
    } catch (error) {
      this.logger.warn(
        `GitHub compare ${repository.id} ${base}...${payload.after}: ${message(error)}`,
      );

      return new Map();
    }
  }
}
