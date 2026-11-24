/**
 * @fileoverview Shared types for the org-level Git integrations (GitHub App, GitLab OAuth).
 * Row shapes mirror migration 20261016120000_git_integrations.sql; the `I*Dto` shapes are the
 * API contract the Tenant Configuration > Integrations page consumes.
 * @module src/git-integrations/git-integrations.types
 */

import type { GitDevelopmentEvent } from '../workflow-engine/handlers/triggers/git-development-event.trigger';

export const GIT_PROVIDERS = ['github', 'gitlab', 'azure_devops'] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

export type GitConnectionStatus = 'active' | 'needs_attention' | 'disconnected';
export type GitRepositorySelection = 'all' | 'selected';

/** Why a connection needs attention. Rendered (translated) by the frontend. */
export type GitAttentionReason =
  | 'app_removed'
  | 'suspended'
  | 'authorization_expired'
  | 'permissions_pending';

export interface IGitConnectionRow {
  id: string;
  organization_id: string;
  provider: GitProvider;
  host: string;
  external_account_id: string;
  installation_id: string | null;
  account_login: string;
  account_name: string | null;
  account_type: string | null;
  avatar_url: string | null;
  account_url: string | null;
  credential_id: string | null;
  repository_selection: GitRepositorySelection;
  status: GitConnectionStatus;
  status_reason: string | null;
  status_changed_at: string;
  created_by: string | null;
  disconnected_by: string | null;
  disconnected_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface IGitRepositoryRow {
  id: string;
  organization_id: string;
  connection_id: string;
  provider: GitProvider;
  host: string;
  external_id: string;
  full_name: string;
  web_url: string | null;
  default_branch: string | null;
  is_private: boolean;
  is_archived: boolean;
  is_enabled: boolean;
  removed_at: string | null;
  webhook_id: string | null;
  webhook_secret_encrypted: string | null;
  webhook_secret_iv: string | null;
  webhook_secret_tag: string | null;
  webhook_error: string | null;
  /** When the one-time pull request import was claimed (ticket 4); null = not imported yet. */
  pull_requests_backfilled_at?: string | null;
  /** Failed imports so far, and the earliest next claim (migration 20261027120000). */
  pull_requests_backfill_attempts?: number;
  pull_requests_backfill_retry_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** What a provider reports about one repository / project. */
export interface IProviderRepository {
  externalId: string;
  fullName: string;
  webUrl: string | null;
  /** `undefined` = the source does not say (a webhook list of granted repositories): the stored one is kept. */
  defaultBranch: string | null | undefined;
  isPrivate: boolean;
  isArchived: boolean;
}

/** What a provider reports about the connected account (GitHub org/user, GitLab group). */
export interface IProviderAccount {
  externalAccountId: string;
  installationId?: string | null;
  login: string;
  name: string | null;
  type: string | null;
  avatarUrl: string | null;
  url: string | null;
}

export interface IUserRefDto {
  id: string;
  name: string;
}

export interface IGitConnectionDto {
  id: string;
  provider: GitProvider;
  accountLogin: string;
  accountName: string | null;
  accountType: string | null;
  avatarUrl: string | null;
  accountUrl: string | null;
  /** Where the outer repository grant is changed on the provider side (GitHub installation settings). */
  manageUrl: string | null;
  status: GitConnectionStatus;
  statusReason: string | null;
  repositorySelection: GitRepositorySelection;
  repositoryCount: number;
  createdBy: IUserRefDto | null;
  createdAt: string;
}

export interface IGitSettingsDto {
  linkCommits: boolean;
  showBuildStatus: boolean;
}

/** The organization's branch naming convention (ticket 3). */
export interface IGitBranchSettingsDto {
  prefix: string;
  keyCase: 'upper' | 'lower';
}

export interface IGitLegacyConnectionDto {
  id: string;
  scope: 'org' | 'space';
  spaceId: string | null;
  spaceName: string | null;
  githubLogin: string | null;
  createdBy: IUserRefDto | null;
  createdAt: string;
}

export interface IGitProviderOverviewDto {
  provider: GitProvider;
  configured: boolean;
  status: 'not_connected' | 'connected' | 'needs_attention';
  connectionCount: number;
}

/** `GET /git-integrations/servers`: the organization's own servers (ticket 11). */
export interface IGitServersOverviewDto {
  servers: IGitServerDto[];
  /** Built-in hosts an own server may NOT use because the built-in app serves them (SaaS). */
  builtinHosts: Record<GitProvider, string | null>;
  onPremise: boolean;
}

// ---------------------------------------------------------------------------
// Self-hosted servers (ticket 11). Row mirrors migration 20261026120000_git_servers.sql.
// ---------------------------------------------------------------------------

/**
 * The app XISUITE talks to a Git instance with: the built-in cloud app from env (`serverId` null) or an
 * organization's own app on a self-hosted server. Resolved by GitServersService.appFor; the provider
 * clients take it on every call.
 */
export interface IGitApp {
  serverId: string | null;
  provider: GitProvider;
  /** The stable key stored on connections / repositories / credentials / identities. */
  host: string;
  /** Web address without a trailing slash: `https://github.com`, `https://company.com/gitlab`. */
  webUrl: string;
  /** REST base without a trailing slash: `https://api.github.com`, `<web>/api/v3`, `<web>/api/v4`. */
  apiUrl: string;
  appId?: string;
  appSlug?: string;
  privateKey?: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
}

export type GitServerStatus = 'active' | 'needs_attention';

export interface IGitServerRow {
  id: string;
  organization_id: string;
  provider: GitProvider;
  host: string;
  base_url: string;
  previous_base_urls: string[];
  name: string;
  app_id: string | null;
  app_slug: string | null;
  client_id: string | null;
  encrypted_secret: string | null;
  encryption_iv: string | null;
  encryption_tag: string | null;
  status: GitServerStatus;
  status_reason: string | null;
  status_detail: string | null;
  status_changed_at: string;
  last_webhook_at: string | null;
  last_test: IGitServerTestResult | null;
  last_test_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/** The secrets packed into `git_servers.encrypted_secret`. */
export interface IGitServerSecrets {
  clientSecret?: string;
  privateKey?: string;
  webhookSecret?: string;
}

export type GitServerCheckKey =
  | 'address'
  | 'reach'
  | 'version'
  | 'credentials'
  | 'webhook_settings'
  | 'inbound'
  | 'public_url';

export type GitServerCheckResult = 'ok' | 'warning' | 'error' | 'skipped';

/** One line of "Test connection". `code` is translated by the frontend; `detail` is the raw message. */
export interface IGitServerCheck {
  key: GitServerCheckKey;
  result: GitServerCheckResult;
  code: string;
  detail?: string;
}

export interface IGitServerTestResult {
  ok: boolean;
  checkedAt: string;
  version: string | null;
  checks: IGitServerCheck[];
}

export interface IGitServerDto {
  id: string;
  provider: GitProvider;
  name: string;
  baseUrl: string;
  host: string;
  appId: string | null;
  appSlug: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  hasPrivateKey: boolean;
  /** All values the server needs are present (GitHub: App ID, client id + secret, private key). */
  configured: boolean;
  status: GitServerStatus;
  statusReason: string | null;
  statusDetail: string | null;
  lastWebhookAt: string | null;
  lastTest: IGitServerTestResult | null;
  connectionCount: number;
  createdAt: string;
}

/** Exactly what the admin enters in the app registration on the Git server (ticket 11 wizard). */
export interface IGitServerSetupDto {
  provider: GitProvider;
  /** Where the admin registers the app on the server. */
  registerUrls: string[];
  homepageUrl: string;
  callbackUrl: string;
  /** GitHub only: Setup URL (same as the callback) and the webhook. */
  setupUrl: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  /** GitLab: scopes. GitHub: "<permission>: read" lines. */
  scopes: string[];
  permissions: string[];
  events: string[];
  /** GitLab: XISUITE creates project webhooks to this address (shown so the admin can allow it). */
  inboundUrl: string;
}

export interface IGitProviderDetailDto {
  provider: GitProvider;
  configured: boolean;
  enabledBy: IUserRefDto | null;
  enabledAt: string | null;
  connections: IGitConnectionDto[];
  settings: IGitSettingsDto;
  /** GitHub only: workflow-editor PAT connections, which keep working unchanged. */
  legacyConnections?: IGitLegacyConnectionDto[];
}

export interface IGitRepositoryDto {
  id: string;
  externalId: string;
  fullName: string;
  webUrl: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  isEnabled: boolean;
  removed: boolean;
  webhookError: string | null;
}

/** One repository in a space's Development settings (Development module, per-space repositories). */
export interface ISpaceGitRepositoryDto {
  id: string;
  provider: GitProvider;
  host: string;
  fullName: string;
  webUrl: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  /** Assigned to the space: its pull requests, branches and commits show on the space's tasks. */
  assigned: boolean;
  /** Selectable: enabled in Tenant Config, not removed, connection not disconnected. */
  available: boolean;
  connection: {
    id: string;
    account: string | null;
    status: IGitConnectionRow['status'];
  };
}

export interface ISpaceGitRepositoriesDto {
  /** Available repositories of the tenant, plus assigned ones that no longer are. */
  repositories: ISpaceGitRepositoryDto[];
}

export interface IGitRepositoriesDto {
  selection: GitRepositorySelection;
  /** True when a requested refresh from the provider failed; the list is the last known state. */
  stale: boolean;
  repositories: IGitRepositoryDto[];
}

/**
 * The provider-specific half of the integration. Implemented by the GitHub and GitLab services;
 * the controllers reach them through {@link GitProvidersRegistry}.
 */
export interface IGitProviderAdapter {
  readonly provider: GitProvider;
  /** Whether the BUILT-IN (env) app can connect organizations. Own servers carry their own flag (ticket 11). */
  isConfigured(): boolean;
  /**
   * Provider sign-in / install address for a new connection on the built-in app or on the organization's
   * server `serverId` (ticket 11), or for reconnecting `connectionId` (its server follows from its host).
   */
  connectUrl(
    userId: string,
    organizationId: string,
    returnTo: string | undefined,
    connectionId?: string,
    serverId?: string,
  ): Promise<string>;
  /** Re-reads the account's repositories from the provider and stores them. */
  refreshRepositories(connection: IGitConnectionRow): Promise<void>;
  /** Called after the admin's selection changed (GitLab creates / deletes project webhooks). */
  applyRepositorySelection(
    connection: IGitConnectionRow,
    enabled: IGitRepositoryRow[],
    disabled: IGitRepositoryRow[],
  ): Promise<void>;
  /** Best-effort provider cleanup after a disconnect (GitLab removes its project webhooks). */
  onDisconnect(connection: IGitConnectionRow): Promise<void>;
  /** Periodic check that the provider still grants access; flips status through the core service. */
  checkHealth(): Promise<void>;
  /** Provider-side settings page for the outer repository grant, if any. */
  manageUrl(connection: IGitConnectionRow): string | null;
  /**
   * One pull request / merge request, read live from the provider (manual linking).
   * @throws {NotFoundException} 'pull_request_not_found' when the provider has no such number.
   */
  fetchPullRequest(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
    number: number,
  ): Promise<IProviderPullRequest>;
  /** Open pull requests plus those updated since `since` (first-connection import). */
  listRecentPullRequests(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
    since: Date,
  ): Promise<IProviderPullRequest[]>;
  /** Branches whose name contains a task key (first-connection import, ticket 5). */
  listKeyBranches(
    connection: IGitConnectionRow,
    repository: IGitRepositoryRow,
  ): Promise<IProviderBranch[]>;
}

// ---------------------------------------------------------------------------
// Pull requests (ticket 4). Rows mirror migration 20261019120000_git_pull_requests.sql.
// ---------------------------------------------------------------------------

export type GitPullRequestState = 'open' | 'closed' | 'merged';

/** A pull request / merge request as either provider reports it, normalised. */
export interface IProviderPullRequest {
  number: number;
  externalId: string;
  title: string;
  url: string;
  state: GitPullRequestState;
  isDraft: boolean;
  sourceBranch: string | null;
  targetBranch: string | null;
  /** Set when the pull request comes from a fork. */
  headRepoFullName: string | null;
  /** GitLab webhooks only carry the author's id; `login` is null until an event or API read names them. */
  author: {
    externalId: string;
    login: string | null;
    avatarUrl: string | null;
    type?: string | null;
  } | null;
  openedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  updatedAt: string;
  /** Scanned for task keys, never stored. */
  body: string | null;
  /**
   * The complete current reviewer verdicts (ticket 5), when the source knows them: GitHub REST reads,
   * GitLab merge request events. Undefined (GitHub `pull_request` events) leaves the stored set alone.
   */
  reviews?: IProviderReview[];
  /**
   * Ticket 6: the commit(s) a merged pull request landed as (GitHub `merge_commit_sha`; GitLab merge and
   * squash commits). Empty while not merged.
   */
  mergeCommitShas?: string[];
  /** Ticket 7: the head commit (GitHub `head.sha`; GitLab `last_commit.id` / `sha`). */
  headSha?: string | null;
  /** Ticket 7: the latest builds of the head commit, read on a manual link or the first import. */
  builds?: IProviderBuild[];
}

// ---------------------------------------------------------------------------
// Builds (ticket 7). Rows mirror migration 20261022120000_git_builds.sql.
// ---------------------------------------------------------------------------

export type GitBuildState =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'skipped';

/** A GitHub Actions run or a GitLab pipeline, normalised. */
export interface IProviderBuild {
  externalId: string;
  /** GitHub `workflow_id`; GitLab `pipeline`. */
  workflowKey: string;
  name: string;
  headBranch: string | null;
  /** The fork the commit comes from; null for the repository itself. */
  headRepoFullName: string | null;
  headSha: string;
  state: GitBuildState;
  attempt: number;
  url: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
  /**
   * Ordering phase override (default: from `state`). Commit statuses pass 0, because a status legitimately
   * goes from failure back to pending on a re-run: they are ordered by `updatedAt` alone.
   */
  phase?: 0 | 1 | 2;
}

/** One build as the task page shows it. */
export interface IGitBuildDto {
  id: string;
  provider: GitProvider;
  name: string;
  state: GitBuildState;
  url: string;
  attempt: number;
  branch: string | null;
  shortSha: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** The builds of one commit (a pull request head, a branch, a merge commit), combined. */
export interface IGitBuildSummaryDto {
  /** Failed if any failed, else running, queued, cancelled, passed; skipped only when all skipped. */
  state: GitBuildState;
  /** The run that decided the state. */
  url: string;
  /** Newest run per workflow. */
  runs: IGitBuildDto[];
  /** The 10 newest runs of the branch / commit, any workflow. */
  history: IGitBuildDto[];
}

/** A pushed commit, normalised (ticket 6). Dates come from the compare API when it could be read. */
export interface IProviderCommit {
  sha: string;
  /** Scanned for task keys and keywords; only its first line is stored. */
  message: string;
  url: string;
  authorName: string | null;
  /** Hashed into the change identity, never stored. */
  authorEmail: string | null;
  /** GitHub username when the email belongs to a GitHub account; GitLab never sends one. */
  authorLogin: string | null;
  authoredAt: string | null;
  committedAt: string;
}

/** One reviewer's latest verdict. GitLab's `requested_changes` is mapped to `changes_requested`. */
export interface IProviderReview {
  reviewerId: string;
  login: string | null;
  state: 'approved' | 'changes_requested' | 'dismissed';
  submittedAt: string | null;
}

/** A branch as the provider reports it (ticket 5). */
export interface IProviderBranch {
  name: string;
  /** Last commit time when the provider tells it (GitLab); GitHub's branch list has none. */
  pushedAt: string | null;
}

export interface IGitPullRequestSyncResult {
  pullRequestId: string;
  applied: boolean;
  linked: string[];
  removed: string[];
}

/** One pull request linked to a task, as the task page shows it. */
export interface IGitTaskPullRequestDto {
  id: string;
  provider: GitProvider;
  repository: string;
  number: number;
  title: string;
  url: string;
  state: GitPullRequestState;
  isDraft: boolean;
  sourceBranch: string | null;
  targetBranch: string | null;
  author: {
    login: string | null;
    avatarUrl: string | null;
    /** The linked XISUITE member, when the author linked their Git account (ticket 2). */
    user: { id: string; name: string; avatarUrl: string | null } | null;
  } | null;
  source: 'auto' | 'manual';
  /** False when the connection is disconnected or the repository disabled / removed: shown as no longer updated. */
  live: boolean;
  linkedAt: string;
  updatedAt: string;
  /** Ticket 5: the reviewers' summary verdict (null: none yet). */
  reviewState: GitReviewState | null;
  /** Ticket 5: what the panel shows; merged > closed > draft > changes requested > approved > open. */
  displayState: GitPullRequestDisplayState;
  /** Ticket 6: linked commits folded into this pull request (on its branch, or its merge commit). */
  commitCount: number;
  /** Ticket 7: builds of the head commit (null: none, or build status hidden). */
  build: IGitBuildSummaryDto | null;
  /** Ticket 7: merged pull requests only, builds of the merge commit ("After merge"). */
  afterMerge: IGitBuildSummaryDto | null;
}

export type GitReviewState = 'approved' | 'changes_requested';

export type GitPullRequestDisplayState =
  | 'open'
  | 'draft'
  | 'approved'
  | 'changes_requested'
  | 'merged'
  | 'closed';

/** A branch named after the task that has no pull request yet (ticket 5). */
export interface IGitTaskBranchDto {
  id: string;
  provider: GitProvider;
  repository: string;
  name: string;
  url: string | null;
  updatedAt: string;
  live: boolean;
  /** Ticket 7: builds of the newest commit on the branch. */
  build: IGitBuildSummaryDto | null;
}

/** Everything the task's Development section shows (ticket 5). */
export interface IGitTaskDevelopmentDto {
  pullRequests: IGitTaskPullRequestDto[];
  branches: IGitTaskBranchDto[];
  /** Distinct pull requests linked to the task's subtasks (all levels). */
  subtaskPullRequestCount: number;
  /** Ticket 6: linked commits not folded into a pull request, newest first, at most 50. */
  commits: IGitTaskCommitDto[];
  /** Ticket 6: commits beyond the 50, per repository, with the provider's search for the task key. */
  moreCommits: IGitTaskMoreCommitsDto[];
  /**
   * Ticket 7: the worst build state over open pull requests, branches and merged pull requests' after-merge
   * builds, with how many of those are failed / running. Null when none of them has a build.
   */
  buildSummary: {
    state: GitBuildState;
    failed: number;
    running: number;
  } | null;
}

/** A commit linked to the task by a key in its message (ticket 6). */
export interface IGitTaskCommitDto {
  sha: string;
  shortSha: string;
  title: string;
  url: string;
  provider: GitProvider;
  repository: string;
  author: {
    name: string | null;
    login: string | null;
    /** The linked XISUITE member (GitHub username via ticket 2). */
    user: { id: string; name: string; avatarUrl: string | null } | null;
  } | null;
  committedAt: string;
  /** "Fixes / Closes / Resolves <key>": ticket 8 resolves the task once the commit is on the default branch. */
  closes: boolean;
}

export interface IGitTaskMoreCommitsDto {
  provider: GitProvider;
  repository: string;
  count: number;
  url: string | null;
}

// ---------------------------------------------------------------------------
// Ticket 8: status automation
// ---------------------------------------------------------------------------

/**
 * Who caused a webhook event, as the provider names them (GitHub `sender`, GitLab hook `user`). Passing one
 * to a sync marks the call as a live delivery: only live deliveries move task status (an import, the health
 * backfill or a manual link never does).
 */
export interface IGitActor {
  externalId: string | null;
  login: string | null;
}

/** What the event is about, for History ("opened pull request #12"). */
export interface IGitDevEventSubject {
  kind: 'pull_request' | 'branch' | 'build' | 'commit';
  /** Pull request number. */
  number?: number;
  /** Pull request / commit title, build (workflow) name, branch name. */
  title?: string;
  url?: string | null;
  /** Commit sha. */
  sha?: string;
  /** For `pr_merged` with "all linked pull requests merged": the pull request itself is not waited for. */
  pullRequestId?: string;
  /** Ticket 9: repository full name (History, notifications). */
  repository?: string;
  /** Ticket 9: the build's head branch / the pushed branch. */
  branch?: string | null;
  /** Ticket 9: commits linked by one push. */
  count?: number;
}

/** A development event for the tasks it belongs to, derived from the state change a webhook caused. */
export interface IGitDevEvent {
  organizationId: string;
  provider: GitProvider;
  /** Ticket 11: the repository's host key, so the actor resolves on the right server (default: built-in). */
  host?: string;
  event: GitDevelopmentEvent;
  taskIds: string[];
  subject: IGitDevEventSubject;
  actor: IGitActor;
  /** The event's repository: only tasks whose space has it assigned are affected. */
  repositoryId: string;
}

// ---------------------------------------------------------------------------
// Ticket 9: activity history and notifications
// ---------------------------------------------------------------------------

/**
 * What a task's History tab shows for a development event. `build_passed` is input only: it becomes
 * `build_fixed` when the task's last build on that branch failed, and nothing otherwise.
 */
export type GitActivityKind =
  | 'pr_linked'
  | 'pr_unlinked'
  | 'pr_opened'
  | 'pr_ready_for_review'
  | 'pr_merged'
  | 'pr_closed'
  | 'build_failed'
  | 'build_passed'
  | 'build_fixed'
  | 'commits_linked';

/** A development event for History and notifications, for the tasks it belongs to. */
export interface IGitActivity {
  organizationId: string;
  provider: GitProvider;
  /** Ticket 11: the repository's host key, so people resolve on the right server (default: built-in). */
  host?: string;
  kind: GitActivityKind;
  taskIds: string[];
  subject: IGitDevEventSubject;
  actor: IGitActor;
  /**
   * For the liveness check before notifying (a disconnected connection sends nothing), and the space
   * gate: only tasks whose space has the repository assigned get History and notifications.
   */
  repositoryId: string;
  /** A manual link: the XISUITE user who linked it; its History row is already written (ticket 4). */
  manualBy?: string;
}
