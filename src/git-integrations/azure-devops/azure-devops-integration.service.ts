/**
 * @fileoverview The Azure DevOps half of the org-level Git integrations: Microsoft Entra sign-in, one
 * connection per Azure DevOps organization, service hook subscriptions per project, health checks and
 * the webhook receiver.
 *
 * A delivery is only a signal. Azure DevOps signs nothing and its pull requests have no "last updated"
 * field, so every event re-reads the pull request, push or build by id from the REST API and stores that.
 * A forged or replayed delivery can therefore only cause a fresh read.
 *
 * Azure stops delivering (probation, then disabled) after answers like 500 or 404, and disables a
 * subscription when its creator leaves the team. The health check compares subscriptions every tick,
 * recreates what is not enabled and resets the repositories' import, which recovers what was missed.
 *
 * The admin client bypasses RLS: every query filters on `organization_id`. The hook id in the webhook URL
 * is the routing key, as the repository id is for GitLab.
 * @module src/git-integrations/azure-devops/azure-devops-integration.service
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import {
  createState,
  readState,
} from '../../calendar/integrations/calendar-oauth.state';
import { decryptApiKey, encryptApiKey } from '../../lib/crypto/encryption';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  encryptedTokens,
  GitCredentialTokens,
  type IGitCredentialRow,
} from '../git-credential-tokens';
import { GitIntegrationsService } from '../git-integrations.service';
import { GitServersService, isAppComplete } from '../git-servers.service';
import {
  GitPullRequestsService,
  MAX_PUSH_COMMITS,
} from '../git-pull-requests.service';
import type {
  GitAttentionReason,
  GitBuildState,
  IGitActor,
  IGitApp,
  IGitConnectionRow,
  IGitProviderAdapter,
  IGitRepositoryRow,
  IProviderAccount,
  IProviderBranch,
  IProviderBuild,
  IProviderCommit,
  IProviderPullRequest,
  IProviderRepository,
  IProviderReview,
} from '../git-integrations.types';
import {
  branchFromRef,
  extractTaskKeys,
  integrationsPageUrl,
  isRepositoryLive,
  parseStateProviderTag,
  pkceVerifier,
  stateProviderTag,
} from '../git-integrations.util';
import {
  AZURE_CONNECT_SCOPE,
  AZURE_DEVOPS_HOST,
  AZURE_DEVOPS_WEB_URL,
  AzureDevopsApiError,
  AzureDevopsClient,
  type IAzureAccount,
} from './azure-devops.client';

const CREDENTIALS = 'git_credentials';
const HOOKS = 'git_azure_project_hooks';
const UNIQUE_VIOLATION = '23505';

/** One subscription per event per project. Nothing else is needed for tasks: comments are not shown. */
export const AZURE_HOOK_EVENTS = [
  'git.push',
  'git.pullrequest.created',
  'git.pullrequest.updated',
  'git.pullrequest.merged',
  'build.complete',
] as const;

/** The REST list cuts a description to 400 characters; a key after that would look removed. */
const LIST_DESCRIPTION_LIMIT = 390;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
/** ponytail: the import reads builds of at most this many open pull requests per repository. */
const IMPORT_BUILDS_LIMIT = 50;

const ZERO_SHA = /^0+$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

interface IAzureIdentity {
  id?: string;
  displayName?: string | null;
  uniqueName?: string | null;
}

export interface IAzureRepository {
  id: string;
  name: string;
  webUrl?: string | null;
  defaultBranch?: string | null;
  isDisabled?: boolean;
  project: { id: string; name: string; visibility?: string | null };
}

export interface IAzureReviewer extends IAzureIdentity {
  vote?: number;
  isContainer?: boolean;
  hasDeclined?: boolean;
}

export interface IAzurePullRequest {
  pullRequestId: number;
  title?: string | null;
  description?: string | null;
  status?: string;
  isDraft?: boolean;
  sourceRefName?: string | null;
  targetRefName?: string | null;
  createdBy?: IAzureIdentity | null;
  closedBy?: IAzureIdentity | null;
  creationDate?: string | null;
  closedDate?: string | null;
  reviewers?: IAzureReviewer[];
  lastMergeSourceCommit?: { commitId?: string } | null;
  lastMergeCommit?: { commitId?: string } | null;
  forkSource?: { repository?: { name?: string } | null } | null;
}

export interface IAzureBuild {
  id: number;
  status?: string;
  result?: string | null;
  queueTime?: string | null;
  startTime?: string | null;
  finishTime?: string | null;
  sourceBranch?: string | null;
  sourceVersion?: string | null;
  definition?: { id?: number; name?: string } | null;
  repository?: { id?: string; type?: string } | null;
  requestedFor?: IAzureIdentity | null;
  /** On a pull request build: `pr.sourceBranch`, `pr.sourceSha`. */
  triggerInfo?: Record<string, string | undefined> | null;
  _links?: { web?: { href?: string } } | null;
}

export interface IAzureCommit {
  commitId?: string;
  comment?: string | null;
  author?: { name?: string; email?: string; date?: string } | null;
  committer?: { date?: string } | null;
}

interface IAzurePush {
  pushId: number;
  date?: string | null;
  pushedBy?: IAzureIdentity | null;
  commits?: IAzureCommit[];
  refUpdates?: { name?: string; newObjectId?: string }[];
}

interface IAzureSubscription {
  id: string;
  eventType?: string;
  status?: string;
  consumerInputs?: { url?: string } | null;
}

interface IHookRow {
  id: string;
  organization_id: string;
  connection_id: string;
  project_external_id: string;
  subscription_ids: Record<string, string>;
  webhook_secret_encrypted: string;
  webhook_secret_iv: string;
  webhook_secret_tag: string;
  error: string | null;
}

export interface IAzureOrganizationDto {
  id: string;
  name: string;
  alreadyConnected: boolean;
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;

  const time = Date.parse(value);

  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof AzureDevopsApiError && error.status === 401;
}

/** Worth Azure's retry (503): rate limit, its own outage, our database, a timeout. A 4xx would answer the same again. */
function isTransient(error: unknown): boolean {
  return !(
    error instanceof AzureDevopsApiError &&
    error.status < 500 &&
    error.status !== 429
  );
}

function hookErrorCode(error: unknown): string {
  if (!(error instanceof AzureDevopsApiError)) return 'failed';
  if (error.status === 401 || error.status === 403) return 'forbidden';
  if (error.status === 404) return 'not_found';
  if (error.status === 400) return 'invalid_url';

  return 'failed';
}

/** `uniqueName` is usually an email; matched case-insensitively, so always stored lower case. */
function loginOf(identity: IAzureIdentity | null | undefined): string | null {
  return identity?.uniqueName?.trim().toLowerCase() || null;
}

function actorOf(identity: IAzureIdentity | null | undefined): IGitActor {
  return { externalId: identity?.id ?? null, login: loginOf(identity) };
}

/** Each person's vote: 10 and 5 approve, -5 and -10 ask for changes. Groups and decliners have no verdict. */
export function reviewsFromAzure(
  reviewers: IAzureReviewer[] | undefined,
): IProviderReview[] {
  return (reviewers ?? []).flatMap((reviewer) => {
    if (!reviewer.id || reviewer.isContainer || reviewer.hasDeclined) return [];

    const vote = reviewer.vote ?? 0;

    if (vote === 0) return [];

    return [
      {
        reviewerId: reviewer.id,
        login: loginOf(reviewer),
        state:
          vote > 0 ? ('approved' as const) : ('changes_requested' as const),
        submittedAt: null,
      },
    ];
  });
}

function stateOf(status: string | undefined): IProviderPullRequest['state'] {
  if (status === 'completed') return 'merged';
  if (status === 'abandoned') return 'closed';

  return 'open';
}

/**
 * The provider-neutral shape of a pull request read from the REST API. Azure has no "last updated" field,
 * and this is a fresh read, so the time of the read is correct and always orders after what is stored.
 * ponytail: two reads at once can store the older one until the next event.
 */
export function pullRequestFromAzure(
  pr: IAzurePullRequest,
  repository: Pick<IGitRepositoryRow, 'web_url' | 'full_name'>,
): IProviderPullRequest {
  const state = stateOf(pr.status);
  const closedAt = state === 'open' ? null : isoOrNull(pr.closedDate);
  const fork = pr.forkSource?.repository?.name ?? null;

  return {
    number: pr.pullRequestId,
    externalId: String(pr.pullRequestId),
    title: pr.title ?? '',
    url: `${webUrlOf(repository)}/pullrequest/${pr.pullRequestId}`,
    state,
    isDraft: Boolean(pr.isDraft),
    sourceBranch: branchFromRef(pr.sourceRefName),
    targetBranch: branchFromRef(pr.targetRefName),
    headRepoFullName: fork,
    author: pr.createdBy?.id
      ? {
          externalId: pr.createdBy.id,
          login: loginOf(pr.createdBy),
          // Azure's image address needs a signed-in Azure session, so it would show as broken here.
          avatarUrl: null,
        }
      : null,
    openedAt: isoOrNull(pr.creationDate),
    closedAt,
    mergedAt: state === 'merged' ? closedAt : null,
    updatedAt: new Date().toISOString(),
    body: pr.description ?? null,
    reviews: reviewsFromAzure(pr.reviewers),
    mergeCommitShas:
      state === 'merged' && pr.lastMergeCommit?.commitId
        ? [pr.lastMergeCommit.commitId]
        : [],
    headSha: pr.lastMergeSourceCommit?.commitId ?? null,
  };
}

export function buildStateFromAzure(
  status: string | null | undefined,
  result: string | null | undefined,
): GitBuildState {
  if (status === 'inProgress' || status === 'cancelling') return 'running';
  if (status !== 'completed') return 'queued';

  switch (result) {
    // The Azure UI shows partial success as a warning, not a failure.
    case 'succeeded':
    case 'partiallySucceeded':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'cancelled';
    default:
      return 'queued';
  }
}

/**
 * A build normalised; null when it cannot be stored. A pull request build runs on `refs/pull/<n>/merge` and a
 * merge commit, so the source branch and head commit come from `triggerInfo` when Azure gives them.
 */
export function buildFromAzure(
  build: IAzureBuild,
  repository: Pick<IGitRepositoryRow, 'web_url' | 'full_name'>,
): IProviderBuild | null {
  const sha = (
    build.triggerInfo?.['pr.sourceSha'] ??
    build.sourceVersion ??
    ''
  ).toLowerCase();
  const definition = build.definition;

  if (!build.id || !SHA.test(sha) || definition?.id == null) return null;

  const state = buildStateFromAzure(build.status, build.result);
  const prBranch = build.triggerInfo?.['pr.sourceBranch'];

  return {
    externalId: String(build.id),
    workflowKey: String(definition.id),
    name: (definition.name || 'Pipeline').slice(0, 200),
    headBranch: branchFromRef(prBranch ?? build.sourceBranch),
    headRepoFullName: null,
    headSha: sha,
    state,
    attempt: 1,
    url:
      build._links?.web?.href ??
      `${webUrlOf(repository).replace(/\/_git\/.*$/, '')}/_build/results?buildId=${build.id}`,
    startedAt: isoOrNull(build.startTime),
    completedAt: state === 'running' ? null : isoOrNull(build.finishTime),
    createdAt:
      isoOrNull(build.queueTime) ??
      isoOrNull(build.startTime) ??
      new Date().toISOString(),
    updatedAt: isoOrNull(build.finishTime),
  };
}

export function commitFromAzure(
  commit: IAzureCommit,
  repository: Pick<IGitRepositoryRow, 'web_url' | 'full_name'>,
): IProviderCommit | null {
  if (!commit.commitId) return null;

  const authoredAt = isoOrNull(commit.author?.date);

  return {
    sha: commit.commitId,
    message: commit.comment ?? '',
    url: `${webUrlOf(repository)}/commit/${commit.commitId}`,
    authorName: commit.author?.name ?? null,
    authorEmail: commit.author?.email ?? null,
    // Azure names a commit's author by name and email only.
    authorLogin: null,
    authoredAt,
    committedAt:
      isoOrNull(commit.committer?.date) ??
      authoredAt ??
      new Date().toISOString(),
  };
}

/** `organization/project/repository`, decoded: names may contain spaces. */
export function repositoryFromAzure(
  organization: string,
  repository: IAzureRepository,
): IProviderRepository {
  return {
    externalId: repository.id,
    fullName: `${organization}/${repository.project.name}/${repository.name}`,
    webUrl: repository.webUrl ?? null,
    defaultBranch: branchFromRef(repository.defaultBranch) ?? null,
    isPrivate: repository.project.visibility !== 'public',
    isArchived: false,
  };
}

function webUrlOf(
  repository: Pick<IGitRepositoryRow, 'web_url' | 'full_name'>,
): string {
  if (repository.web_url) return repository.web_url.replace(/\/$/, '');

  const [organization, project, name] = repository.full_name
    .split('/')
    .map(encodeURIComponent);

  return `${AZURE_DEVOPS_WEB_URL}/${organization}/${project}/_git/${name}`;
}

/** Azure names may not contain `/`, so the project is the middle of `organization/project/repository`. */
function projectOf(repository: Pick<IGitRepositoryRow, 'full_name'>): string {
  return repository.full_name.split('/')[1] ?? '';
}

@Injectable()
export class AzureDevopsIntegrationService implements IGitProviderAdapter {
  readonly provider = 'azure_devops' as const;
  private readonly logger = new Logger(AzureDevopsIntegrationService.name);
  private readonly tokens: GitCredentialTokens;

  /** Wait between re-reads while another request holds the refresh lease. Replaced in tests. */
  delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly core: GitIntegrationsService,
    private readonly client: AzureDevopsClient,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly pullRequests: GitPullRequestsService,
    private readonly servers: GitServersService,
  ) {
    this.tokens = new GitCredentialTokens({
      label: 'Azure DevOps',
      logger: this.logger,
      supabaseAdmin,
      core,
      refresh: (_row, refreshToken) => client.refresh(this.app, refreshToken),
      // Other OAuth errors (Microsoft unavailable, a throttled request) keep the grant.
      isRefusal: (error) =>
        error instanceof AzureDevopsApiError &&
        (error.oauthError === 'invalid_grant' ||
          error.oauthError === 'interaction_required'),
      expiredError: () =>
        new AzureDevopsApiError(
          401,
          'Azure DevOps authorization expired',
          'invalid_grant',
        ),
      delay: (ms) => this.delay(ms),
    });
  }

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** Azure DevOps Server is out of scope: there is one app, from env. */
  private get app(): IGitApp {
    return this.servers.builtinApp('azure_devops');
  }

  private get redirectUri(): string {
    return `${this.servers.publicApiUrl}/git-integrations/azure_devops/callback`;
  }

  isConfigured(): boolean {
    return this.servers.isBuiltinConfigured('azure_devops');
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
  ): Promise<string> {
    if (connectionId)
      await this.core.getConnection(organizationId, connectionId);

    const app = this.app;

    if (!isAppComplete(app)) throw new BadRequestException('not_configured');

    const state = createState(
      userId,
      organizationId,
      stateProviderTag('azure_devops', connectionId),
      returnTo,
    );

    return this.client.authorizeUrl(app, {
      redirectUri: this.redirectUri,
      scope: AZURE_CONNECT_SCOPE,
      state,
      codeVerifier: pkceVerifier(state),
    });
  }

  /** Where to send the browser after Microsoft's redirect. Never throws. */
  async handleCallback(input: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<string> {
    const state = readState(input.state);
    const tag = state ? parseStateProviderTag(state.provider) : null;

    if (!state || !input.state || tag?.provider !== 'azure_devops')
      return integrationsPageUrl(undefined, 'azure_devops', {
        error: 'expired',
      });

    const back = (params: Record<string, string>) =>
      integrationsPageUrl(state.returnTo, 'azure_devops', params);
    const { userId, organizationId } = state;

    try {
      if (input.error) return back({ error: input.error.slice(0, 50) });
      if (!input.code) return back({ error: 'expired' });
      if (!(await this.core.isOrgAdmin(organizationId, userId)))
        return back({ error: 'forbidden' });

      let connection: IGitConnectionRow | null = null;

      if (tag.connectionId) {
        connection = await this.core
          .getConnection(organizationId, tag.connectionId)
          .catch(() => null);

        if (
          !connection ||
          connection.provider !== 'azure_devops' ||
          connection.status === 'disconnected'
        )
          return back({ error: 'not_found' });
      }

      let tokens: Awaited<ReturnType<AzureDevopsClient['exchangeCode']>>;

      try {
        tokens = await this.client.exchangeCode(this.app, {
          code: input.code,
          redirectUri: this.redirectUri,
          scope: AZURE_CONNECT_SCOPE,
          codeVerifier: pkceVerifier(input.state),
        });
      } catch (error) {
        this.logger.warn(
          `Azure DevOps code exchange failed: ${messageOf(error)}`,
        );

        return back({ error: 'exchange_failed' });
      }

      // Without a refresh token the connection would stop working within the hour.
      if (!tokens.refreshToken) {
        this.logger.warn('Azure DevOps sign-in returned no refresh token');

        return back({ error: 'exchange_failed' });
      }

      const profile = await this.client.profile(tokens.accessToken);

      // Reconnect: the new sign-in must reach the connection's organization.
      if (connection) {
        const accounts = await this.client.accounts(
          tokens.accessToken,
          profile.id,
        );

        if (
          !accounts.some(
            (account) => account.accountId === connection?.external_account_id,
          )
        )
          return back({ error: 'organization_not_accessible' });
      }

      const { data, error } = await this.db
        .from(CREDENTIALS)
        .insert({
          organization_id: organizationId,
          provider: 'azure_devops',
          host: AZURE_DEVOPS_HOST,
          external_user_id: profile.id,
          external_login:
            profile.emailAddress?.toLowerCase() ?? profile.displayName ?? null,
          ...encryptedTokens(tokens),
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

      const reconnected = { ...connection, credential_id: credentialId };

      try {
        await this.refreshRepositories(reconnected);
        // Deliveries were ignored while the connection needed attention.
        await this.resetImport(
          reconnected,
          await this.core.listRepositories(organizationId, connection.id),
        );
      } catch (repairError) {
        this.logger.warn(
          `Azure DevOps repair after reconnect ${connection.id}: ${messageOf(repairError)}`,
        );
      }

      return back({ connected: 'azure_devops' });
    } catch (error) {
      this.logger.error(`Azure DevOps callback failed: ${messageOf(error)}`);

      return back({ error: 'failed' });
    }
  }

  /** The organizations of the person who signed in, for the picker. */
  async listOrganizations(
    user: RequestUser,
    credentialId: string,
    search?: string,
  ): Promise<IAzureOrganizationDto[]> {
    const credential = await this.loadCredential(user, credentialId);
    const [accounts, connections] = await Promise.all([
      this.accountsOf(credential),
      this.core.listConnections(user.organizationId, 'azure_devops'),
    ]);
    const connected = new Set(
      connections
        .filter((connection) => connection.status === 'active')
        .map((connection) => connection.external_account_id),
    );
    const needle = search?.trim().toLowerCase();

    return accounts
      .filter(
        (account) =>
          !needle || account.accountName.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.accountName.localeCompare(b.accountName))
      .map((account) => ({
        id: account.accountId,
        name: account.accountName,
        alreadyConnected: connected.has(account.accountId),
      }));
  }

  /** @throws {ConflictException} when the organization is already connected (409). */
  async connectOrganization(
    user: RequestUser,
    credentialId: string,
    accountId: string,
  ): Promise<IGitConnectionRow> {
    const credential = await this.loadCredential(user, credentialId);
    const account = (await this.accountsOf(credential)).find(
      (candidate) => candidate.accountId === accountId,
    );

    if (!account) throw new NotFoundException('organization_not_accessible');

    const { connection, created } = await this.core.upsertConnection({
      organizationId: user.organizationId,
      provider: 'azure_devops',
      host: AZURE_DEVOPS_HOST,
      account: this.accountOf(account),
      credentialId,
      userId: user.userId,
    });

    try {
      // An existing row was reactivated: deliveries were ignored until now and its hook rows are gone, so
      // the subscriptions alone cannot tell that events were lost. First, so a failed sync cannot skip it.
      if (!created)
        await this.resetImport(
          connection,
          await this.core.listRepositories(
            connection.organization_id,
            connection.id,
          ),
        );

      await this.refreshRepositories(connection);
    } catch (error) {
      // The connection exists; the repository dialog's refresh retries this.
      this.logger.warn(
        `Azure DevOps initial sync ${connection.id}: ${messageOf(error)}`,
      );
    }

    return connection;
  }

  /** For the picker: Microsoft refusing the sign-in is an answer for the admin, never a 500. */
  private async accountsOf(
    credential: IGitCredentialRow,
  ): Promise<IAzureAccount[]> {
    try {
      const token = await this.tokens.getAccessToken(credential);

      return await this.client.accounts(token, credential.external_user_id);
    } catch (error) {
      if (!(error instanceof AzureDevopsApiError)) throw error;

      this.logger.warn(`Azure DevOps organizations: ${messageOf(error)}`);

      if (error.status === 401 || error.status === 403 || error.oauthError)
        throw new ForbiddenException('expired');

      throw new BadGatewayException('azure_devops_unavailable');
    }
  }

  private accountOf(account: IAzureAccount): IProviderAccount {
    return {
      externalAccountId: account.accountId,
      installationId: null,
      login: account.accountName,
      name: account.accountName,
      type: 'Organization',
      avatarUrl: null,
      url: `${AZURE_DEVOPS_WEB_URL}/${encodeURIComponent(account.accountName)}`,
    };
  }

  // ---------------------------------------------------------------------------
  // Repositories and hooks
  // ---------------------------------------------------------------------------

  private async remoteRepositories(
    connection: IGitConnectionRow,
    token: string,
  ): Promise<IAzureRepository[]> {
    const { value } = await this.client.org<{ value?: IAzureRepository[] }>(
      connection.account_login,
      '/_apis/git/repositories',
      token,
    );

    return (value ?? []).filter((repository) => !repository.isDisabled);
  }

  async refreshRepositories(connection: IGitConnectionRow): Promise<void> {
    if (!connection.credential_id) {
      await this.core.setStatus(
        connection,
        'needs_attention',
        'authorization_expired',
      );

      throw new Error('Azure DevOps connection has no authorization');
    }

    const token = await this.tokenFor(connection);
    const remote = await this.remoteRepositories(connection, token);

    await this.core.upsertRepositories(
      connection,
      remote.map((repository) =>
        repositoryFromAzure(connection.account_login, repository),
      ),
      true,
    );

    await this.reconcileHooks(connection, token, remote);
  }

  async applyRepositorySelection(connection: IGitConnectionRow): Promise<void> {
    const token = await this.tokenFor(connection);

    await this.reconcileHooks(
      connection,
      token,
      await this.remoteRepositories(connection, token),
    );
  }

  /**
   * Makes Azure match the selection: every project with an enabled repository has all its subscriptions
   * enabled, other projects have none. Anything found missing or not enabled lost events, so the import of
   * that project's repositories runs again. One project's failure never stops another's.
   */
  private async reconcileHooks(
    connection: IGitConnectionRow,
    token: string,
    remote: IAzureRepository[],
  ): Promise<void> {
    const organization = connection.account_login;
    const rows = await this.core.listRepositories(
      connection.organization_id,
      connection.id,
    );
    const projectByRepository = new Map(
      remote.map((repository) => [repository.id, repository.project.id]),
    );
    const wanted = new Map<string, IGitRepositoryRow[]>();

    for (const row of rows) {
      const project = projectByRepository.get(row.external_id);

      if (!project || !row.is_enabled || row.removed_at) continue;

      wanted.set(project, [...(wanted.get(project) ?? []), row]);
    }

    const hooks = await this.hooksOf(connection);
    const { value } = await this.client.org<{ value?: IAzureSubscription[] }>(
      organization,
      '/_apis/hooks/subscriptions',
      token,
    );
    for (const [project, repositories] of wanted) {
      try {
        await this.reconcileProject(
          connection,
          token,
          project,
          repositories,
          hooks,
          value ?? [],
        );
      } catch (projectError) {
        this.logger.warn(
          `Azure DevOps reconcile ${project}: ${messageOf(projectError)}`,
        );
        await this.markRepositoriesFailed(repositories);
      }
    }

    for (const hook of hooks.filter(
      (row) => !wanted.has(row.project_external_id),
    ))
      await this.removeHook(organization, hook, token);
  }

  private async reconcileProject(
    connection: IGitConnectionRow,
    token: string,
    project: string,
    repositories: IGitRepositoryRow[],
    hooks: IHookRow[],
    subscriptions: IAzureSubscription[],
  ): Promise<void> {
    const organization = connection.account_login;
    const hook =
      hooks.find((row) => row.project_external_id === project) ??
      (await this.createHookRow(connection, project));
    const hookUrl = this.hookUrl(hook);
    const stored = new Set(Object.values(hook.subscription_ids));
    // Ours by address or by stored id: Azure allows duplicates, and keeps a subscription "enabled" at an
    // old address after PUBLIC_API_URL changed, so a stored id alone proves nothing.
    const ours = subscriptions.filter(
      (subscription) =>
        subscription.consumerInputs?.url === hookUrl ||
        stored.has(subscription.id),
    );
    const subscriptionIds: Record<string, string> = {};
    let error: string | null = null;
    // A stored error means an earlier tick could not subscribe, so events were lost back then. The error
    // is only cleared together with the reset below, so this survives until the import really runs again.
    let lostEvents = !!hook.error;

    for (const event of AZURE_HOOK_EVENTS) {
      const forEvent = ours.filter(
        (subscription) => subscription.eventType === event,
      );
      const healthy = forEvent.find(
        (subscription) =>
          subscription.status?.toLowerCase() === 'enabled' &&
          subscription.consumerInputs?.url === hookUrl,
      );

      // Replaced, disabled, or deleted in Azure: events were lost. A duplicate of a healthy one lost nothing.
      if (!healthy && (hook.subscription_ids[event] || forEvent.length))
        lostEvents = true;

      for (const subscription of forEvent)
        if (subscription !== healthy)
          await this.deleteSubscription(organization, subscription.id, token);

      if (healthy) {
        subscriptionIds[event] = healthy.id;
        continue;
      }

      if (error) continue;

      try {
        subscriptionIds[event] = await this.createSubscription(
          organization,
          hook,
          event,
          token,
        );
      } catch (createError) {
        this.logger.warn(
          `Azure DevOps subscription ${project} ${event}: ${messageOf(createError)}`,
        );
        error = hookErrorCode(createError);
      }
    }

    // Before the row is updated: a failed reset keeps the error, so the next tick tries again.
    if (
      lostEvents &&
      !error &&
      !(await this.resetImport(connection, repositories))
    )
      error = 'failed';

    await this.updateHookRow(hook, {
      subscription_ids: subscriptionIds,
      error,
    });

    for (const repository of repositories) {
      if (repository.webhook_error !== error)
        await this.core.updateRepositoryWebhook(repository, {
          webhook_error: error,
        });
    }
  }

  /** Best effort: already handling a failure, and this must not stop the next project either. */
  private async markRepositoriesFailed(
    repositories: IGitRepositoryRow[],
  ): Promise<void> {
    for (const repository of repositories) {
      try {
        await this.core.updateRepositoryWebhook(repository, {
          webhook_error: 'failed',
        });
      } catch (error) {
        this.logger.warn(
          `Azure DevOps webhook state ${repository.id}: ${messageOf(error)}`,
        );
      }
    }
  }

  private async hooksOf(connection: IGitConnectionRow): Promise<IHookRow[]> {
    const { data, error } = await this.db
      .from(HOOKS)
      .select('*')
      .eq('organization_id', connection.organization_id)
      .eq('connection_id', connection.id);

    if (error) throw new InternalServerErrorException(error.message);

    return (data ?? []) as IHookRow[];
  }

  /** The row comes first: its id is in the subscription's address. */
  private async createHookRow(
    connection: IGitConnectionRow,
    project: string,
  ): Promise<IHookRow> {
    const encrypted = encryptApiKey(randomBytes(32).toString('hex'));
    const { data, error } = await this.db
      .from(HOOKS)
      .insert({
        organization_id: connection.organization_id,
        connection_id: connection.id,
        project_external_id: project,
        webhook_secret_encrypted: encrypted.encrypted,
        webhook_secret_iv: encrypted.iv,
        webhook_secret_tag: encrypted.tag,
      })
      .select('*')
      .single();

    // Another instance or a selection save created it first: use that row and its secret.
    if ((error as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
      const existing = (await this.hooksOf(connection)).find(
        (row) => row.project_external_id === project,
      );

      if (existing) return existing;
    }

    if (error || !data)
      throw new InternalServerErrorException(
        error?.message ?? 'hook insert returned nothing',
      );

    return data as IHookRow;
  }

  private async updateHookRow(
    hook: IHookRow,
    patch: Pick<IHookRow, 'subscription_ids' | 'error'>,
  ): Promise<void> {
    const { error } = await this.db
      .from(HOOKS)
      .update(patch)
      .eq('id', hook.id)
      .eq('organization_id', hook.organization_id);

    if (error) throw new InternalServerErrorException(error.message);
  }

  private hookUrl(hook: Pick<IHookRow, 'id'>): string {
    return `${this.servers.publicApiUrl}/git-integrations/azure_devops/webhook/${hook.id}`;
  }

  private secretOf(hook: IHookRow): string {
    return decryptApiKey(
      hook.webhook_secret_encrypted,
      hook.webhook_secret_iv,
      hook.webhook_secret_tag,
    );
  }

  private async createSubscription(
    organization: string,
    hook: IHookRow,
    event: string,
    token: string,
  ): Promise<string> {
    const subscription = await this.client.org<{ id: string }>(
      organization,
      '/_apis/hooks/subscriptions',
      token,
      {
        method: 'POST',
        body: {
          publisherId: 'tfs',
          eventType: event,
          resourceVersion: '1.0',
          consumerId: 'webHooks',
          consumerActionId: 'httpRequest',
          publisherInputs: { projectId: hook.project_external_id },
          consumerInputs: {
            url: this.hookUrl(hook),
            basicAuthUsername: 'xisuite',
            basicAuthPassword: this.secretOf(hook),
            messagesToSend: 'none',
            detailedMessagesToSend: 'none',
          },
        },
      },
    );

    return subscription.id;
  }

  /** Best effort: a subscription left behind is disabled by the 410 of the receiver. */
  private async deleteSubscription(
    organization: string,
    id: string,
    token: string,
  ): Promise<void> {
    try {
      await this.client.org(
        organization,
        `/_apis/hooks/subscriptions/${encodeURIComponent(id)}`,
        token,
        { method: 'DELETE' },
      );
    } catch (error) {
      if (error instanceof AzureDevopsApiError && error.status === 404) return;

      this.logger.warn(
        `Azure DevOps subscription delete ${id}: ${messageOf(error)}`,
      );
    }
  }

  private async removeHook(
    organization: string,
    hook: IHookRow,
    token: string | null,
  ): Promise<void> {
    if (token)
      for (const id of Object.values(hook.subscription_ids))
        await this.deleteSubscription(organization, id, token);

    const { error } = await this.db
      .from(HOOKS)
      .delete()
      .eq('id', hook.id)
      .eq('organization_id', hook.organization_id);

    if (error)
      this.logger.warn(`Azure DevOps hook delete ${hook.id}: ${error.message}`);
  }

  /**
   * The cron imports these repositories again, which recovers events Azure did not deliver.
   * @returns false when the reset could not be saved, so the caller can try again later
   */
  private async resetImport(
    connection: IGitConnectionRow,
    repositories: IGitRepositoryRow[],
  ): Promise<boolean> {
    const { error } = await this.db
      .from('git_repositories')
      .update({
        pull_requests_backfilled_at: null,
        pull_requests_backfill_attempts: 0,
        pull_requests_backfill_retry_at: null,
      })
      .eq('organization_id', connection.organization_id)
      .eq('connection_id', connection.id)
      .in(
        'id',
        repositories.map((repository) => repository.id),
      );

    if (error)
      this.logger.warn(
        `Azure DevOps import reset ${connection.id}: ${error.message}`,
      );

    return !error;
  }

  async onDisconnect(connection: IGitConnectionRow): Promise<void> {
    let token: string | null = null;

    try {
      token = await this.tokenFor(connection);
    } catch (error) {
      this.logger.warn(
        `Azure DevOps disconnect ${connection.id}: no usable token: ${messageOf(error)}`,
      );
    }

    for (const hook of await this.hooksOf(connection))
      await this.removeHook(connection.account_login, hook, token);

    if (connection.credential_id)
      await this.deleteCredentialIfUnused(
        connection.credential_id,
        connection.organization_id,
        connection.id,
      );
  }

  /** Entra has no token revocation for an app; deleting the row ends XISUITE's access. */
  private async deleteCredentialIfUnused(
    credentialId: string,
    organizationId: string,
    exceptConnectionId: string,
  ): Promise<void> {
    const stillUsed = (
      await this.core.listConnections(organizationId, 'azure_devops')
    ).some(
      (other) =>
        other.id !== exceptConnectionId && other.credential_id === credentialId,
    );

    if (stillUsed) return;

    const { error } = await this.db
      .from(CREDENTIALS)
      .delete()
      .eq('id', credentialId)
      .eq('organization_id', organizationId)
      .eq('provider', 'azure_devops');

    if (error)
      this.logger.warn(
        `Azure DevOps credential delete ${credentialId}: ${error.message}`,
      );
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private readPullRequest(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
    number: number,
    token: string,
  ): Promise<IAzurePullRequest> {
    return this.client.org<IAzurePullRequest>(
      connection.account_login,
      `/_apis/git/repositories/${encodeURIComponent(repository.external_id)}/pullrequests/${number}`,
      token,
    );
  }

  async fetchPullRequest(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
    number: number,
  ): Promise<IProviderPullRequest> {
    try {
      const token = await this.tokenFor(connection);
      const pr = pullRequestFromAzure(
        await this.readPullRequest(connection, repository, number, token),
        repository,
      );

      return {
        ...pr,
        builds:
          pr.state === 'open'
            ? await this.buildsFor(
                connection,
                repository,
                pr.sourceBranch,
                pr.number,
                token,
              )
            : [],
      };
    } catch (error) {
      if (error instanceof AzureDevopsApiError && error.status === 404)
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
    const base = `/_apis/git/repositories/${encodeURIComponent(repository.external_id)}/pullrequests`;
    const list = async (criteria: Record<string, string>) => {
      const items: IAzurePullRequest[] = [];

      for (let page = 0; page < MAX_PAGES; page++) {
        const query = new URLSearchParams({
          ...criteria,
          $top: String(PAGE_SIZE),
          $skip: String(page * PAGE_SIZE),
        });
        const { value } = await this.client.org<{
          value?: IAzurePullRequest[];
        }>(connection.account_login, `${base}?${query.toString()}`, token);

        items.push(...(value ?? []));

        if ((value?.length ?? 0) < PAGE_SIZE) break;
      }

      return items;
    };
    const [open, closed] = await Promise.all([
      list({ 'searchCriteria.status': 'active' }),
      list({
        'searchCriteria.status': 'all',
        'searchCriteria.queryTimeRangeType': 'closed',
        'searchCriteria.minTime': since.toISOString(),
      }),
    ]);
    const byNumber = new Map(
      [...open, ...closed].map((pr) => [pr.pullRequestId, pr]),
    );
    const result: IProviderPullRequest[] = [];

    for (const listed of byNumber.values()) {
      // The list cuts the description, and storing a cut one would remove links by keys after the cut.
      const full =
        (listed.description?.length ?? 0) >= LIST_DESCRIPTION_LIMIT
          ? await this.readPullRequest(
              connection,
              repository,
              listed.pullRequestId,
              token,
            )
          : listed;

      result.push(pullRequestFromAzure(full, repository));
    }

    for (const pr of result
      .filter((candidate) => candidate.state === 'open')
      .slice(0, IMPORT_BUILDS_LIMIT))
      pr.builds = await this.buildsFor(
        connection,
        repository,
        pr.sourceBranch,
        pr.number,
        token,
      );

    return result;
  }

  async listKeyBranches(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
  ): Promise<IProviderBranch[]> {
    const token = await this.tokenFor(connection);
    const branches: IProviderBranch[] = [];
    let continuation: string | null = null;

    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({
        filter: 'heads/',
        $top: '1000',
        ...(continuation && { continuationToken: continuation }),
      });
      const response: {
        data: { value?: { name?: string }[] };
        headers: Headers;
      } = await this.client.orgPage(
        connection.account_login,
        `/_apis/git/repositories/${encodeURIComponent(repository.external_id)}/refs?${query.toString()}`,
        token,
      );

      for (const ref of response.data.value ?? []) {
        const name = branchFromRef(ref.name);

        if (name && extractTaskKeys(name).length)
          branches.push({ name, pushedAt: null });
      }

      continuation = response.headers.get('x-ms-continuationtoken');

      if (!continuation) break;
    }

    return branches;
  }

  /**
   * The latest builds of a pull request's branch (manual link, import): those of the branch itself and
   * those Azure runs on the pull request's merge ref, which a filter on the branch never returns.
   */
  private async buildsFor(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
    branch: string | null,
    pullRequestNumber: number,
    token: string,
  ): Promise<IProviderBuild[]> {
    const refs = [
      ...(branch ? [`refs/heads/${branch}`] : []),
      `refs/pull/${pullRequestNumber}/merge`,
    ];
    const builds = new Map<string, IProviderBuild>();

    // Sequential, and a failed ref only loses its own builds.
    for (const ref of refs)
      for (const build of await this.buildsOfRef(
        connection,
        repository,
        ref,
        token,
      ))
        builds.set(build.externalId, build);

    return [...builds.values()];
  }

  /** None when they cannot be read. */
  private async buildsOfRef(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
    ref: string,
    token: string,
  ): Promise<IProviderBuild[]> {
    try {
      const query = new URLSearchParams({
        repositoryId: repository.external_id,
        repositoryType: 'TfsGit',
        branchName: ref,
        $top: '20',
      });
      const { value } = await this.client.org<{ value?: IAzureBuild[] }>(
        connection.account_login,
        `/${encodeURIComponent(projectOf(repository))}/_apis/build/builds?${query.toString()}`,
        token,
      );

      return (value ?? []).flatMap(
        (build) => buildFromAzure(build, repository) ?? [],
      );
    } catch (error) {
      this.logger.warn(
        `Azure DevOps builds ${repository.id} ${ref}: ${messageOf(error)}`,
      );

      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  /**
   * Credentials never attached to a connection are swept by the GitLab health check, which covers every
   * provider. Unlike GitLab, every live connection is re-read, whatever its selection: this is also what
   * compares its subscriptions and picks up renames. ponytail: three calls per connection per 5 minutes.
   */
  async checkHealth(): Promise<void> {
    const connections = await this.core.listAllLive('azure_devops');
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
      const expire = async (connection: IGitConnectionRow) =>
        this.core.setStatus(
          connection,
          'needs_attention',
          'authorization_expired',
        );

      try {
        const credential = await this.tokens.read(
          credentialId!,
          organizationId,
        );

        if (!credential || credential.status === 'invalid') {
          for (const connection of group) await expire(connection);
          continue;
        }

        const accounts = await this.client.accounts(
          await this.tokens.getAccessToken(credential),
          credential.external_user_id,
        );

        for (const connection of group) {
          const account = accounts.find(
            (candidate) =>
              candidate.accountId === connection.external_account_id,
          );

          // The person left the organization, or it no longer exists.
          if (!account) {
            await expire(connection);
            continue;
          }

          let current = connection;

          if (account.accountName !== connection.account_login) {
            await this.core.updateAccountDetails(
              connection,
              this.accountOf(account),
            );
            current = { ...connection, account_login: account.accountName };
          }

          if (
            current.status === 'needs_attention' &&
            current.status_reason === 'authorization_expired'
          ) {
            await this.core.setStatus(
              current,
              'active',
              'authorization_expired',
            );
            healthy.push({ ...current, status: 'active', status_reason: null });
          } else if (current.status === 'active') {
            healthy.push(current);
          }
        }
      } catch (error) {
        // Throttling, outages and network errors keep the last known status.
        if (!isAuthFailure(error)) {
          this.logger.warn(
            `Azure DevOps health ${credentialId}: ${messageOf(error)}`,
          );
          continue;
        }

        for (const connection of group) await expire(connection);
      }
    }

    for (const connection of healthy) {
      try {
        await this.refreshRepositories(connection);
      } catch (error) {
        this.logger.warn(
          `Azure DevOps sync ${connection.id}: ${messageOf(error)}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook receiver
  // ---------------------------------------------------------------------------

  /**
   * `gone` (410) makes Azure disable a subscription nothing uses any more; `retry` (503) is the only answer
   * Azure retries without punishing it. Never a 500 or 404: those put the subscription on probation, which
   * loses new events.
   */
  async handleWebhook(input: {
    hookId: string;
    authorization?: string;
    rawBody?: Buffer;
  }): Promise<'ok' | 'unauthorized' | 'gone' | 'retry'> {
    const { data, error } = await this.db
      .from(HOOKS)
      .select('*')
      .eq('id', input.hookId)
      .maybeSingle();

    if (error) {
      this.logger.error(`Azure DevOps hook read: ${error.message}`);

      return 'retry';
    }

    const hook = data as IHookRow | null;

    if (!hook) return 'gone';
    if (!this.isAuthorized(hook, input.authorization)) return 'unauthorized';

    let connection: IGitConnectionRow;

    try {
      connection = await this.core.getConnection(
        hook.organization_id,
        hook.connection_id,
      );
    } catch (readError) {
      if (readError instanceof NotFoundException) return 'gone';

      this.logger.error(
        `Azure DevOps webhook ${hook.id}: ${messageOf(readError)}`,
      );

      return 'retry';
    }

    if (connection.status === 'disconnected') return 'gone';

    let payload: {
      id?: string;
      eventType?: string;
      resource?: {
        id?: number;
        pullRequestId?: number;
        pushId?: number;
        repository?: { id?: string };
      };
    };

    try {
      payload = JSON.parse(
        input.rawBody?.toString('utf8') ?? '',
      ) as typeof payload;
    } catch {
      return 'ok';
    }

    // Scoped to the hook, so one project's subscription cannot suppress another's delivery.
    const deliveryId = payload?.id ? `${hook.id}:${payload.id}` : null;

    if (
      deliveryId &&
      !(await this.core.recordDelivery(
        'azure_devops',
        deliveryId,
        payload.eventType ?? 'unknown',
      ))
    )
      return 'ok';

    let outcome: string;

    try {
      outcome = await this.processDelivery(connection, hook, payload);
    } catch (processError) {
      this.logger.error(
        `Azure DevOps webhook ${hook.id}: ${messageOf(processError)}`,
      );

      if (deliveryId)
        await this.core.forgetDelivery('azure_devops', deliveryId);

      return isTransient(processError) ? 'retry' : 'ok';
    }

    if (deliveryId)
      await this.core.setDeliveryOutcome('azure_devops', deliveryId, outcome);

    return 'ok';
  }

  private isAuthorized(hook: IHookRow, header: string | undefined): boolean {
    const match = /^Basic\s+(.+)$/i.exec(header ?? '');

    if (!match) return false;

    let secret: string;

    try {
      secret = this.secretOf(hook);
    } catch {
      return false;
    }

    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
    const expected = Buffer.from(secret);

    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** The payload only says what changed; the content is read from the API. */
  private async processDelivery(
    connection: IGitConnectionRow,
    hook: IHookRow,
    payload: {
      eventType?: string;
      resource?: {
        id?: number;
        pullRequestId?: number;
        pushId?: number;
        repository?: { id?: string };
      };
    },
  ): Promise<string> {
    // Reconnecting imports again, which covers these.
    if (connection.status !== 'active') return 'ignored_attention';

    const event = payload?.eventType;
    const resource = payload?.resource;

    if (event === 'build.complete')
      return resource?.id
        ? this.applyBuild(connection, hook, resource.id)
        : 'ignored';

    const repository = await this.liveRepository(
      connection,
      resource?.repository?.id,
    );

    if (!repository) return 'ignored_disabled';

    if (event === 'git.push')
      return resource?.pushId
        ? this.applyPush(connection, repository, resource.pushId)
        : 'ignored';

    if (event?.startsWith('git.pullrequest.') && resource?.pullRequestId) {
      const token = await this.tokenFor(connection);
      let pr: IAzurePullRequest;

      try {
        pr = await this.readPullRequest(
          connection,
          repository,
          resource.pullRequestId,
          token,
        );
      } catch (error) {
        if (error instanceof AzureDevopsApiError && error.status === 404)
          return 'ignored';

        throw error;
      }

      // Azure says who opened and who closed; who else changed it is not in the API.
      const actor =
        event === 'git.pullrequest.created'
          ? actorOf(pr.createdBy)
          : actorOf(pr.closedBy);

      await this.pullRequests.sync(
        repository,
        pullRequestFromAzure(pr, repository),
        actor,
      );

      return 'processed';
    }

    return 'ignored';
  }

  /** Only a repository of THIS connection: the id comes from a payload. */
  private async liveRepository(
    connection: IGitConnectionRow,
    externalId: string | undefined,
  ): Promise<IGitRepositoryRow | null> {
    if (!externalId) return null;

    const repository = await this.core.findRepository(connection, externalId);

    return repository &&
      repository.connection_id === connection.id &&
      isRepositoryLive(connection, repository)
      ? repository
      : null;
  }

  private async applyPush(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
    pushId: number,
  ): Promise<string> {
    const token = await this.tokenFor(connection);
    let push: IAzurePush;

    try {
      push = await this.client.org<IAzurePush>(
        connection.account_login,
        `/_apis/git/repositories/${encodeURIComponent(repository.external_id)}/pushes/${pushId}?includeCommits=${MAX_PUSH_COMMITS}&includeRefUpdates=true`,
        token,
      );
    } catch (error) {
      if (error instanceof AzureDevopsApiError && error.status === 404)
        return 'ignored';

      throw error;
    }

    const actor = actorOf(push.pushedBy);
    const at = isoOrNull(push.date) ?? new Date().toISOString();
    let applied = false;
    let commitBranch: string | null = null;

    for (const ref of push.refUpdates ?? []) {
      const name = branchFromRef(ref.name);

      // Tags and other refs; a push normally updates one branch.
      if (!name) continue;

      const deleted = ZERO_SHA.test(ref.newObjectId ?? '');

      await this.pullRequests.syncBranch(
        repository,
        name,
        deleted ? null : at,
        deleted,
        actor,
      );
      applied = true;
      commitBranch ??= deleted ? null : name;
    }

    if (
      commitBranch &&
      push.commits?.length &&
      (await this.pullRequests.commitLinkingEnabled(repository))
    ) {
      const commits = push.commits
        .flatMap((commit) => commitFromAzure(commit, repository) ?? [])
        .sort((a, b) => a.committedAt.localeCompare(b.committedAt));

      await this.pullRequests.syncCommits(
        repository,
        commitBranch,
        commits.slice(-MAX_PUSH_COMMITS),
        actor,
      );
    }

    return applied ? 'processed' : 'ignored';
  }

  /** A subscription is per project, so the repository comes from the build itself. */
  private async applyBuild(
    connection: IGitConnectionRow,
    hook: IHookRow,
    buildId: number,
  ): Promise<string> {
    const token = await this.tokenFor(connection);
    let build: IAzureBuild;

    try {
      build = await this.client.org<IAzureBuild>(
        connection.account_login,
        `/${encodeURIComponent(hook.project_external_id)}/_apis/build/builds/${buildId}`,
        token,
      );
    } catch (error) {
      if (error instanceof AzureDevopsApiError && error.status === 404)
        return 'ignored';

      throw error;
    }

    // GitHub, Bitbucket or TFVC builds run in Azure Pipelines too.
    if (build.repository?.type !== 'TfsGit') return 'ignored';

    const repository = await this.liveRepository(
      connection,
      build.repository.id,
    );

    if (!repository) return 'ignored_disabled';

    const normalised = buildFromAzure(build, repository);

    if (!normalised) return 'ignored';

    await this.pullRequests.syncBuilds(
      repository,
      [normalised],
      false,
      actorOf(build.requestedFor),
    );

    return 'processed';
  }

  // ---------------------------------------------------------------------------
  // Credentials
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
      .eq('provider', 'azure_devops')
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data)
      throw new NotFoundException('Azure DevOps authorization not found');

    return data as IGitCredentialRow;
  }

  private async tokenFor(connection: IGitConnectionRow): Promise<string> {
    const credential = connection.credential_id
      ? await this.tokens.read(
          connection.credential_id,
          connection.organization_id,
        )
      : null;

    if (!credential)
      throw new Error('Azure DevOps connection has no authorization');

    return this.tokens.getAccessToken(credential);
  }
}
