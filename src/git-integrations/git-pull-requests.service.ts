/**
 * @fileoverview Pull requests / merge requests on tasks (ticket 4): storing what a provider reports,
 * linking by task key (all of it in the `git_sync_pull_request` RPC, atomic and idempotent), the
 * task's list, manual link / unlink with task history, and the bookkeeping of the one-time import
 * when a repository is first connected.
 *
 * Provider-neutral: nothing here talks to GitHub or GitLab. The webhook handlers, the controller and
 * the health cron fetch from the provider and hand the normalised pull request in.
 *
 * The admin client bypasses RLS, so every query filters on `organization_id`, except
 * {@link claimBackfill}, which sweeps all organizations on purpose (cron only).
 * @module src/git-integrations/git-pull-requests.service
 */

import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { GitActivityService } from './git-activity.service';
import { GitIdentitiesService } from './git-identities.service';
import { GitServersService } from './git-servers.service';
import { GitStatusAutomationService } from './git-status-automation.service';
import type {
  GitActivityKind,
  IGitActivity,
  GitProvider,
  GitPullRequestState,
  IGitActor,
  IGitConnectionRow,
  GitReviewState,
  IGitPullRequestSyncResult,
  IGitRepositoryRow,
  IGitServerRow,
  IGitTaskBranchDto,
  IGitTaskDevelopmentDto,
  GitBuildState,
  IGitBuildSummaryDto,
  IGitTaskCommitDto,
  IGitTaskMoreCommitsDto,
  IGitTaskPullRequestDto,
  IProviderBuild,
  IProviderCommit,
  IProviderPullRequest,
} from './git-integrations.types';
import {
  branchUrl,
  buildEvent,
  buildPhaseOf,
  changeIdOf,
  commitSearchUrl,
  commitTitle,
  combineBuildStates,
  comparePullRequests,
  developmentTaskIds,
  displayStateOf,
  extractClosingKeys,
  extractTaskKeys,
  isRepositoryLive,
  pullRequestEvents,
  spaceRepositoryIds,
  type IBuildRow,
  type IParsedPullRequestUrl,
  summarizeBuilds,
} from './git-integrations.util';

const REPOSITORIES = 'git_repositories';
const LINKS = 'git_pull_request_tasks';
const BRANCH_LINKS = 'git_branch_tasks';

/** Branch rows shown at most (newest first); a task rarely has more than a couple. */
const MAX_BRANCHES = 20;

/** Repositories imported per cron tick (each costs a few provider list calls). */
const BACKFILL_BATCH = 10;

/** Ticket 6: commit rows listed at most; the rest are counted per repository ("and 450 more"). */
const MAX_COMMITS = 50;

/** Ticket 6: commits per `git_sync_commits` call (one push can carry up to 2048). */
const COMMIT_SYNC_CHUNK = 500;

/** Ticket 6: GitHub sends at most 2048 commits per push; GitLab's compare API has no limit. */
export const MAX_PUSH_COMMITS = 2048;

/** What `git_task_commits` returns (migration 20261021120000_git_commits.sql). */
interface ITaskCommitsRow {
  commits: {
    provider: GitProvider;
    repository: string;
    sha: string;
    title: string;
    url: string;
    author_name: string | null;
    author_login: string | null;
    committed_at: string;
    closes: boolean;
  }[];
  more: {
    provider: GitProvider;
    repository: string;
    web_url: string | null;
    count: number;
  }[];
  pr_counts: { pull_request_id: string; count: number }[];
}

interface ILinkRow {
  source: 'auto' | 'manual';
  created_at: string;
  pull_request: {
    id: string;
    repository_id: string;
    number: number;
    title: string;
    url: string;
    state: GitPullRequestState;
    is_draft: boolean;
    source_branch: string | null;
    target_branch: string | null;
    author_external_id: string | null;
    author_login: string | null;
    author_avatar_url: string | null;
    provider_updated_at: string;
    review_state: GitReviewState | null;
    repository: {
      provider: GitProvider;
      /** Ticket 11: authors resolve against the accounts of this host (own servers have their own). */
      host: string;
      full_name: string;
      is_enabled: boolean;
      removed_at: string | null;
      connection: { status: IGitConnectionRow['status'] } | null;
    } | null;
  } | null;
}

interface IBranchLinkRow {
  branch: {
    id: string;
    name: string;
    last_pushed_at: string;
    repository: {
      id: string;
      provider: GitProvider;
      full_name: string;
      web_url: string | null;
      is_enabled: boolean;
      removed_at: string | null;
      connection: { status: IGitConnectionRow['status'] } | null;
    } | null;
  } | null;
}

const BRANCH_LINK_SELECT = `branch:git_branches!git_branch_tasks_branch_fkey(
    id, name, last_pushed_at,
    repository:git_repositories!git_branches_repository_fkey(
      id, provider, full_name, web_url, is_enabled, removed_at,
      connection:git_connections!git_repositories_connection_fkey(status)
    )
  )`;

type RepositoryWithConnection = IGitRepositoryRow & {
  connection: IGitConnectionRow | null;
};

const LINK_SELECT = `source, created_at,
  pull_request:git_pull_requests!git_pull_request_tasks_pull_request_fkey(
    id, repository_id, number, title, url, state, is_draft, source_branch, target_branch,
    author_external_id, author_login, author_avatar_url, provider_updated_at, review_state,
    repository:git_repositories!git_pull_requests_repository_fkey(
      provider, host, full_name, is_enabled, removed_at,
      connection:git_connections!git_repositories_connection_fkey(status)
    )
  )`;

const REPOSITORY_WITH_CONNECTION =
  '*, connection:git_connections!git_repositories_connection_fkey(*)';
/** Same, as an inner join: a filter on `connection.*` then drops the repository row itself. */
const REPOSITORY_WITH_LIVE_CONNECTION =
  '*, connection:git_connections!git_repositories_connection_fkey!inner(*)';

/** First retry of a failed import after 5 minutes, doubling per failure, at most daily (never given up). */
const BACKFILL_RETRY_BASE_MS = 5 * 60 * 1000;
const BACKFILL_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

/** When a repository whose import failed `attempts` times (this one included) is claimed again. */
export function backfillRetryAt(attempts: number, now = Date.now()): string {
  const delay = Math.min(
    BACKFILL_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    BACKFILL_RETRY_MAX_MS,
  );

  return new Date(now + delay).toISOString();
}

/** What `git_task_builds` returns (migration 20261022120000_git_builds.sql). */
interface ITaskBuildsRow {
  pull_requests: {
    pull_request_id: string;
    current: IBuildRow[];
    history: IBuildRow[];
    after_merge: IBuildRow[];
  }[];
  branches: { branch_id: string; current: IBuildRow[]; history: IBuildRow[] }[];
}

/**
 * Ticket 7: the section's headline over open pull requests, branches and merged pull requests' after-merge
 * builds (closed pull requests are left out by the caller): the worst state and how many failed / run.
 */
function summarizeTaskBuilds(
  builds: (IGitBuildSummaryDto | null)[],
): { state: GitBuildState; failed: number; running: number } | null {
  const states = builds.flatMap((build) => (build ? [build.state] : []));
  const state = combineBuildStates(states);

  return state
    ? {
        state,
        failed: states.filter((s) => s === 'failed').length,
        running: states.filter((s) => s === 'running' || s === 'queued').length,
      }
    : null;
}

/** `%`, `_` and `\` are wildcards in ILIKE; a repository name must match literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** The address parts of an own server that a pasted link may start with (ticket 11). */
export type ServerAddress = Pick<
  IGitServerRow,
  'host' | 'base_url' | 'previous_base_urls'
>;

/**
 * Ticket 11: a pasted pull request / merge request address on one of the organization's own servers,
 * rewritten to `https://<server host key><rest>` so {@link parsePullRequestUrl} yields the stored host key
 * and no GitLab relative root (`https://company.com/gitlab/...`). The longest matching current or previous
 * server address wins; a prefix only matches up to a `/`, so `https://git.co` never matches
 * `https://git.company.com`. Null when the address is on none of them (built-in hosts).
 */
export function mapToServerHost(
  input: string,
  servers: ServerAddress[],
): string | null {
  const url = input.trim();
  const lower = url.toLowerCase();
  let best: { length: number; host: string } | null = null;

  for (const server of servers) {
    for (const address of [server.base_url, ...server.previous_base_urls]) {
      const prefix = address.replace(/\/+$/, '').toLowerCase();

      if (
        lower.startsWith(`${prefix}/`) &&
        (!best || prefix.length > best.length)
      )
        best = { length: prefix.length, host: server.host };
    }
  }

  return best ? `https://${best.host}${url.slice(best.length)}` : null;
}

@Injectable()
export class GitPullRequestsService {
  private readonly logger = new Logger(GitPullRequestsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly identities: GitIdentitiesService,
    private readonly automation: GitStatusAutomationService,
    private readonly activity: GitActivityService,
    private readonly servers: GitServersService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /**
   * Stores the pull request and links it to every task of the repository's organization whose key
   * (current or previous) is in its source branch, title or description. Automatic links whose key
   * disappeared are removed; manual links and manual unlinks are never touched. A delivery older than
   * the stored state changes nothing.
   * @param actor only for a live webhook delivery: the state change it caused may move task status (ticket 8).
   */
  async sync(
    repository: IGitRepositoryRow,
    pr: IProviderPullRequest,
    actor?: IGitActor,
  ): Promise<IGitPullRequestSyncResult> {
    const { data, error } = (await this.db.rpc('git_sync_pull_request', {
      p_org: repository.organization_id,
      p_repository_id: repository.id,
      p_pr: {
        number: pr.number,
        external_id: pr.externalId,
        title: pr.title,
        url: pr.url,
        state: pr.state,
        is_draft: pr.isDraft,
        source_branch: pr.sourceBranch,
        target_branch: pr.targetBranch,
        head_repo_full_name: pr.headRepoFullName,
        author_external_id: pr.author?.externalId ?? null,
        author_login: pr.author?.login ?? null,
        author_avatar_url: pr.author?.avatarUrl ?? null,
        opened_at: pr.openedAt,
        closed_at: pr.closedAt,
        merged_at: pr.mergedAt,
        provider_updated_at: pr.updatedAt,
      },
      p_keys: extractTaskKeys(pr.sourceBranch, pr.title, pr.body),
    })) as { data: unknown; error: { message: string } | null };

    if (error) throw new InternalServerErrorException(error.message);

    const result = data as {
      pull_request_id: string;
      applied: boolean;
      linked: string[] | null;
      removed: string[] | null;
      prev_state?: GitPullRequestState | null;
      prev_is_draft?: boolean | null;
      tasks?: string[] | null;
    };

    // Only with a delivery that was applied, so an older snapshot never replaces a newer one.
    if (pr.reviews && result.applied) {
      const { error: reviewsError } = (await this.db.rpc(
        'git_set_pull_request_reviews',
        {
          p_org: repository.organization_id,
          p_pull_request_id: result.pull_request_id,
          p_reviews: pr.reviews.map((review) => ({
            id: review.reviewerId,
            login: review.login,
            state: review.state,
            submitted_at: review.submittedAt,
          })),
        },
      )) as { error: { message: string } | null };

      if (reviewsError)
        throw new InternalServerErrorException(reviewsError.message);
    }

    // Ticket 6: a merged pull request's merge commit never changes, so no ordering guard is needed.
    // Ticket 7: the head commit moves with every push, so only an applied (newer) delivery may set it.
    const shas: { merge_commit_shas?: string[]; head_sha?: string } = {};

    if (pr.mergeCommitShas?.length)
      shas.merge_commit_shas = pr.mergeCommitShas.map((sha) =>
        sha.toLowerCase(),
      );
    if (pr.headSha && result.applied) shas.head_sha = pr.headSha.toLowerCase();

    if (Object.keys(shas).length) {
      const { error: shaError } = await this.db
        .from('git_pull_requests')
        .update(shas)
        .eq('id', result.pull_request_id)
        .eq('organization_id', repository.organization_id);

      if (shaError) throw new InternalServerErrorException(shaError.message);
    }

    // Ticket 7: builds read with the pull request (manual link, first import), after its head is stored.
    if (pr.builds?.length)
      await this.syncBuilds(
        repository,
        pr.builds,
        repository.provider === 'github',
      );

    if (actor && result.applied) {
      const linked = result.linked ?? [];
      const events = pullRequestEvents(
        {
          prevState: result.prev_state ?? null,
          prevDraft: result.prev_is_draft ?? null,
          state: pr.state,
          isDraft: pr.isDraft,
        },
        result.tasks ?? [],
        linked,
      );
      const activity = (
        kind: GitActivityKind,
        taskIds: string[],
      ): IGitActivity => ({
        organizationId: repository.organization_id,
        provider: repository.provider,
        host: repository.host,
        kind,
        taskIds,
        subject: {
          kind: 'pull_request',
          number: pr.number,
          title: pr.title,
          url: pr.url,
          pullRequestId: result.pull_request_id,
          repository: repository.full_name,
        },
        actor,
        repositoryId: repository.id,
      });

      // Ticket 9: History and notifications first, so History reads "merged", then "status changed".
      // A task linked by this delivery gets one "linked" row, not a second "opened" one.
      await this.activity.record(activity('pr_linked', linked));
      await this.activity.record(activity('pr_unlinked', result.removed ?? []));
      for (const [event, taskIds] of events)
        await this.activity.record(
          activity(
            event as GitActivityKind,
            taskIds.filter((id) => !linked.includes(id)),
          ),
        );

      for (const [event, taskIds] of events)
        await this.automation.handle({
          organizationId: repository.organization_id,
          repositoryId: repository.id,
          provider: repository.provider,
          host: repository.host,
          event,
          taskIds,
          subject: {
            kind: 'pull_request',
            number: pr.number,
            title: pr.title,
            url: pr.url,
            pullRequestId: result.pull_request_id,
          },
          actor,
        });
    }

    return {
      pullRequestId: result.pull_request_id,
      applied: result.applied,
      linked: result.linked ?? [],
      removed: result.removed ?? [],
    };
  }

  /**
   * One review event (GitHub `pull_request_review`). A comment never changes the verdict, a dismissal
   * clears it, an event older than the reviewer's stored one is ignored, and a review of a pull request
   * XISUITE does not know is ignored.
   * @returns the pull request's summary verdict afterwards (null: none, or the pull request is unknown).
   */
  async recordReview(
    repository: IGitRepositoryRow,
    number: number,
    review: {
      reviewerId: string;
      login: string | null;
      state: string;
      submittedAt: string | null;
    },
  ): Promise<GitReviewState | null> {
    const { data, error } = (await this.db.rpc(
      'git_record_pull_request_review',
      {
        p_org: repository.organization_id,
        p_repository_id: repository.id,
        p_number: number,
        p_reviewer_id: review.reviewerId,
        p_login: review.login,
        p_state: review.state,
        p_submitted_at: review.submittedAt,
      },
    )) as { data: unknown; error: { message: string } | null };

    if (error) throw new InternalServerErrorException(error.message);

    return (data as GitReviewState | null) ?? null;
  }

  /**
   * A branch was pushed, created or deleted. Only branches whose name contains a task key are kept;
   * anything else is skipped without a database call.
   * @param actor only for a live webhook delivery: a branch newly linked to a task is `branch_created` (ticket 8).
   */
  async syncBranch(
    repository: IGitRepositoryRow,
    name: string,
    pushedAt: string | null,
    deleted: boolean,
    actor?: IGitActor,
  ): Promise<void> {
    const keys = extractTaskKeys(name);

    if (!keys.length) return;

    const { data, error } = (await this.db.rpc('git_sync_branch', {
      p_org: repository.organization_id,
      p_repository_id: repository.id,
      p_name: name,
      p_keys: keys,
      p_pushed_at: pushedAt,
      p_deleted: deleted,
    })) as {
      data: { linked: string[] | null } | null;
      error: { message: string } | null;
    };

    if (error) throw new InternalServerErrorException(error.message);

    const linked = data?.linked ?? [];

    if (actor && !deleted && linked.length)
      await this.automation.handle({
        organizationId: repository.organization_id,
        repositoryId: repository.id,
        provider: repository.provider,
        host: repository.host,
        event: 'branch_created',
        taskIds: linked,
        subject: {
          kind: 'branch',
          title: name,
          url: branchUrl(repository.provider, repository.web_url, name),
        },
        actor,
      });
  }

  /** Ticket 6: whether the organization links commits for this repository's provider (off without a settings row). */
  async commitLinkingEnabled(repository: IGitRepositoryRow): Promise<boolean> {
    const { data, error } = await this.db
      .from('git_integration_settings')
      .select('link_commits')
      .eq('organization_id', repository.organization_id)
      .eq('provider', repository.provider)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);

    return (data as { link_commits: boolean } | null)?.link_commits === true;
  }

  /**
   * Ticket 6: stores the commits of one push to `branch` whose message names a task key and links them
   * (all in `git_sync_commits`: one row per change, the newest version wins, idempotent). The caller
   * checks {@link commitLinkingEnabled} first, before it spends a provider call on author dates.
   * @param actor only for a live webhook delivery: closing commits that reached the default branch are
   *   `commit_closes` (ticket 8).
   * @returns how many commits were stored or updated.
   */
  async syncCommits(
    repository: IGitRepositoryRow,
    branch: string,
    commits: IProviderCommit[],
    actor?: IGitActor,
  ): Promise<number> {
    const rows = commits.slice(0, MAX_PUSH_COMMITS).flatMap((commit) => {
      const keys = extractTaskKeys(commit.message);

      return keys.length
        ? [
            {
              change_id: changeIdOf(
                commit.authorEmail,
                commit.authoredAt,
                commit.sha,
              ),
              sha: commit.sha.toLowerCase(),
              title: commitTitle(commit.message),
              url: commit.url,
              author_name: commit.authorName,
              author_login: commit.authorLogin,
              authored_at: commit.authoredAt,
              committed_at: commit.committedAt,
              keys,
              closing_keys: extractClosingKeys(commit.message),
            },
          ]
        : [];
    });
    let stored = 0;
    const reached: { task_id: string; sha: string }[] = [];
    const linked: { commit_id: string; task_id: string }[] = [];

    for (let i = 0; i < rows.length; i += COMMIT_SYNC_CHUNK) {
      const { data, error } = (await this.db.rpc('git_sync_commits', {
        p_org: repository.organization_id,
        p_repository_id: repository.id,
        p_branch: branch,
        p_commits: rows.slice(i, i + COMMIT_SYNC_CHUNK),
      })) as {
        data: {
          stored: number;
          linked?: { commit_id: string; task_id: string }[] | null;
          reached_default?: { task_id: string; sha: string }[] | null;
        } | null;
        error: { message: string } | null;
      };

      if (error) throw new InternalServerErrorException(error.message);

      stored += data?.stored ?? 0;
      linked.push(...(data?.linked ?? []));
      reached.push(...(data?.reached_default ?? []));
    }

    // Ticket 9: one "N commits linked" History row per task and push (newly linked commits only).
    if (actor) {
      const commitsByTask = new Map<string, Set<string>>();

      for (const pair of linked)
        commitsByTask.set(
          pair.task_id,
          (commitsByTask.get(pair.task_id) ?? new Set()).add(pair.commit_id),
        );

      for (const [taskId, commitIds] of commitsByTask)
        await this.activity.record({
          organizationId: repository.organization_id,
          provider: repository.provider,
          host: repository.host,
          kind: 'commits_linked',
          taskIds: [taskId],
          subject: {
            kind: 'commit',
            count: commitIds.size,
            branch,
            repository: repository.full_name,
            url: branchUrl(repository.provider, repository.web_url, branch),
          },
          actor,
          repositoryId: repository.id,
        });
    }

    if (actor)
      for (const row of rows) {
        const taskIds = [
          ...new Set(
            reached.filter((r) => r.sha === row.sha).map((r) => r.task_id),
          ),
        ];

        if (taskIds.length)
          await this.automation.handle({
            organizationId: repository.organization_id,
            repositoryId: repository.id,
            provider: repository.provider,
            host: repository.host,
            event: 'commit_closes',
            taskIds,
            subject: {
              kind: 'commit',
              sha: row.sha,
              title: row.title,
              url: row.url,
            },
            actor,
          });
      }

    return stored;
  }

  /** Ticket 7: whether the organization shows build status for this repository's provider (on without a settings row). */
  async buildStatusEnabled(repository: IGitRepositoryRow): Promise<boolean> {
    const { data, error } = await this.db
      .from('git_integration_settings')
      .select('show_build_status')
      .eq('organization_id', repository.organization_id)
      .eq('provider', repository.provider)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);

    return (
      (data as { show_build_status: boolean } | null)?.show_build_status !==
      false
    );
  }

  /**
   * Ticket 7: stores GitHub Actions runs / GitLab pipelines (all in `git_sync_build`: only builds that can
   * show on a task, a re-run updates its row, the 10 newest per workflow and branch are kept). Nothing is
   * stored while the organization hides build status for the provider.
   * @param ordered GitHub: an older delivery of a run never overwrites a newer one. GitLab: last one wins.
   * @param actor only for a live webhook delivery: a run that turned its commit failed / passed is
   *   `build_failed` / `build_passed` for the commit's tasks (ticket 8).
   * @returns how many builds were stored or updated.
   */
  async syncBuilds(
    repository: IGitRepositoryRow,
    builds: IProviderBuild[],
    ordered: boolean,
    actor?: IGitActor,
  ): Promise<number> {
    if (!builds.length || !(await this.buildStatusEnabled(repository)))
      return 0;

    let stored = 0;

    for (const build of builds) {
      const { data, error } = (await this.db.rpc('git_sync_build', {
        p_org: repository.organization_id,
        p_repository_id: repository.id,
        p_build: {
          external_id: build.externalId,
          workflow_key: build.workflowKey,
          name: build.name,
          head_branch: build.headBranch,
          head_repo_full_name: build.headRepoFullName,
          head_sha: build.headSha.toLowerCase(),
          state: build.state,
          phase: build.phase ?? buildPhaseOf(build.state),
          attempt: build.attempt,
          url: build.url,
          started_at: build.startedAt,
          completed_at: build.completedAt,
          provider_created_at: build.createdAt,
          provider_updated_at: build.updatedAt,
        },
        p_keys: extractTaskKeys(build.headBranch),
        p_ordered: ordered,
      })) as {
        data: {
          applied: boolean;
          build_id?: string | null;
          prev_state?: GitBuildState | null;
        } | null;
        error: { message: string } | null;
      };

      if (error) throw new InternalServerErrorException(error.message);
      if (!data?.applied) continue;

      stored++;

      if (actor && data.build_id)
        await this.buildAutomation(
          repository,
          build,
          data.build_id,
          data.prev_state ?? null,
          actor,
        );
    }

    return stored;
  }

  /** Ticket 8: the build event of one applied run for the tasks of its commit (open pull request head, branch). */
  private async buildAutomation(
    repository: IGitRepositoryRow,
    build: IProviderBuild,
    buildId: string,
    prevState: GitBuildState | null,
    actor: IGitActor,
  ): Promise<void> {
    if (prevState === build.state) return;
    if (build.state !== 'failed' && build.state !== 'passed') return;

    const { data, error } = (await this.db.rpc('git_build_tasks', {
      p_org: repository.organization_id,
      p_build_id: buildId,
    })) as {
      data: {
        tasks: string[];
        runs: {
          workflow_key: string;
          state: GitBuildState;
          provider_created_at: string;
        }[];
      } | null;
      error: { message: string } | null;
    };

    if (error) throw new InternalServerErrorException(error.message);
    if (!data?.tasks.length) return;

    const event = buildEvent(prevState, build.state, data.runs);

    // Ticket 9: History "build failed" / "build fixed" (a pass after a failure) and their notifications.
    if (event)
      await this.activity.record({
        organizationId: repository.organization_id,
        provider: repository.provider,
        host: repository.host,
        kind: event,
        taskIds: data.tasks,
        subject: {
          kind: 'build',
          title: build.name,
          url: build.url,
          sha: build.headSha.toLowerCase(),
          branch: build.headBranch,
          repository: repository.full_name,
        },
        actor,
        repositoryId: repository.id,
      });

    if (event)
      await this.automation.handle({
        organizationId: repository.organization_id,
        repositoryId: repository.id,
        provider: repository.provider,
        host: repository.host,
        event,
        taskIds: data.tasks,
        subject: { kind: 'build', title: build.name, url: build.url },
        actor,
      });
  }

  // ---------------------------------------------------------------------------
  // Task page
  // ---------------------------------------------------------------------------

  /**
   * @returns the task's key (null for keyless tasks) and space.
   * @throws {NotFoundException} when the task is not in this organization.
   * @throws {ForbiddenException} when the task's space has the Development module off.
   */
  async assertTask(
    organizationId: string,
    taskId: string,
  ): Promise<{ key: string | null; spaceId: string | null }> {
    const { data, error } = await this.db
      .from('tasks')
      .select('id, key, space_id')
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Task not found');
    if (!(await developmentTaskIds(this.db, organizationId, [taskId])).size)
      throw new ForbiddenException('Development module is not enabled');

    const task = data as { key: string | null; space_id: string | null };

    return { key: task.key ?? null, spaceId: task.space_id };
  }

  /**
   * Manual link: the pull request's repository must be assigned to the task's space.
   * @throws {UnprocessableEntityException} `repository_not_in_space` otherwise.
   */
  async assertRepositoryInSpace(
    organizationId: string,
    taskId: string,
    repositoryId: string,
  ): Promise<void> {
    if (
      !(
        await developmentTaskIds(
          this.db,
          organizationId,
          [taskId],
          repositoryId,
        )
      ).size
    )
      throw new UnprocessableEntityException('repository_not_in_space');
  }

  /**
   * Everything the task's Development section shows: linked pull requests (open, then merged, then
   * closed; newest first), branches named after the task that have no pull request yet, and the number
   * of pull requests linked to its subtasks.
   */
  async getDevelopment(
    organizationId: string,
    taskId: string,
  ): Promise<IGitTaskDevelopmentDto> {
    const { key, spaceId } = await this.assertTask(organizationId, taskId);
    // Only the repositories assigned to the task's space (commits and builds are filtered in SQL).
    const assigned =
      (await spaceRepositoryIds(this.db, spaceId ? [spaceId] : [])).get(
        spaceId ?? '',
      ) ?? new Set<string>();

    const [pullRequests, branches, subtaskPullRequestCount, commits, builds] =
      await Promise.all([
        this.pullRequestsOf(organizationId, taskId, assigned),
        this.branchesOf(organizationId, taskId, assigned),
        this.subtaskPullRequestCount(organizationId, taskId),
        this.commitsOf(organizationId, taskId, key),
        this.buildsOf(organizationId, taskId),
      ]);

    const withBuilds = pullRequests.map((pr) => {
      const found = builds.pullRequests.get(pr.id);

      return {
        ...pr,
        commitCount: commits.countByPullRequest.get(pr.id) ?? 0,
        build: found ? summarizeBuilds(found.current, found.history) : null,
        afterMerge:
          found && pr.state === 'merged'
            ? summarizeBuilds(found.after_merge, [])
            : null,
      };
    });
    const branchesWithBuilds = branches.map((branch) => {
      const found = builds.branches.get(branch.id);

      return {
        ...branch,
        build: found ? summarizeBuilds(found.current, found.history) : null,
      };
    });

    return {
      pullRequests: withBuilds,
      branches: branchesWithBuilds,
      subtaskPullRequestCount,
      commits: commits.commits,
      moreCommits: commits.more,
      buildSummary: summarizeTaskBuilds([
        ...withBuilds.map((pr) =>
          pr.state === 'open' ? pr.build : pr.afterMerge,
        ),
        ...branchesWithBuilds.map((branch) => branch.build),
      ]),
    };
  }

  /** Ticket 7: the builds of the task's pull requests and branches (matching and the display setting in SQL). */
  private async buildsOf(
    organizationId: string,
    taskId: string,
  ): Promise<{
    pullRequests: Map<string, ITaskBuildsRow['pull_requests'][number]>;
    branches: Map<string, ITaskBuildsRow['branches'][number]>;
  }> {
    const { data, error } = (await this.db.rpc('git_task_builds', {
      p_org: organizationId,
      p_task_id: taskId,
    })) as { data: ITaskBuildsRow | null; error: { message: string } | null };

    if (error) throw new InternalServerErrorException(error.message);

    return {
      pullRequests: new Map(
        (data?.pull_requests ?? []).map((row) => [row.pull_request_id, row]),
      ),
      branches: new Map(
        (data?.branches ?? []).map((row) => [row.branch_id, row]),
      ),
    };
  }

  /**
   * Ticket 6: the task's commits (folding into linked pull requests, the link-commits setting and the
   * limit are applied in `git_task_commits`), with GitHub authors resolved to XISUITE members.
   */
  private async commitsOf(
    organizationId: string,
    taskId: string,
    taskKey: string | null,
  ): Promise<{
    commits: IGitTaskCommitDto[];
    more: IGitTaskMoreCommitsDto[];
    countByPullRequest: Map<string, number>;
  }> {
    const { data, error } = (await this.db.rpc('git_task_commits', {
      p_org: organizationId,
      p_task_id: taskId,
      p_limit: MAX_COMMITS,
    })) as { data: ITaskCommitsRow | null; error: { message: string } | null };

    if (error) throw new InternalServerErrorException(error.message);

    const rows = data?.commits ?? [];
    // Ticket 11: GitHub logins are per instance, so resolve per host KEY. The commit's address is mapped
    // through the organization's servers (current and previous addresses), so a server whose address
    // changed still resolves under its stored key.
    const servers = rows.some((row) => row.provider === 'github')
      ? await this.servers.list(organizationId)
      : [];
    const hostOf = (url: string) => {
      try {
        return new URL(mapToServerHost(url, servers) ?? url).host.toLowerCase();
      } catch {
        return '';
      }
    };
    const loginsByHost = new Map<string, string[]>();

    for (const row of rows) {
      if (row.provider !== 'github' || !row.author_login) continue;

      const host = hostOf(row.url);

      loginsByHost.set(host, [
        ...(loginsByHost.get(host) ?? []),
        row.author_login,
      ]);
    }

    const members = new Map<
      string,
      Awaited<ReturnType<GitIdentitiesService['resolveLogins']>>
    >();

    for (const [host, logins] of loginsByHost)
      members.set(
        host,
        await this.identities.resolveLogins(
          organizationId,
          'github',
          logins,
          host,
        ),
      );

    return {
      commits: rows.map((row): IGitTaskCommitDto => {
        const user =
          row.provider === 'github' && row.author_login
            ? members.get(hostOf(row.url))?.get(row.author_login)
            : undefined;

        return {
          sha: row.sha,
          shortSha: row.sha.slice(0, 7),
          title: row.title,
          url: row.url,
          provider: row.provider,
          repository: row.repository,
          author:
            row.author_name || row.author_login || user
              ? {
                  name: row.author_name,
                  login: row.author_login,
                  user: user
                    ? {
                        id: user.userId,
                        name: user.name,
                        avatarUrl: user.avatarUrl,
                      }
                    : null,
                }
              : null,
          committedAt: row.committed_at,
          closes: row.closes,
        };
      }),
      more: (data?.more ?? []).map((row) => ({
        provider: row.provider,
        repository: row.repository,
        count: row.count,
        url: taskKey
          ? commitSearchUrl(row.provider, row.web_url, row.repository, taskKey)
          : null,
      })),
      countByPullRequest: new Map(
        (data?.pr_counts ?? []).map((row) => [row.pull_request_id, row.count]),
      ),
    };
  }

  private async pullRequestsOf(
    organizationId: string,
    taskId: string,
    assigned: Set<string>,
  ): Promise<IGitTaskPullRequestDto[]> {
    const { data, error } = await this.db
      .from(LINKS)
      .select(LINK_SELECT)
      .eq('organization_id', organizationId)
      .eq('task_id', taskId)
      .eq('state', 'linked');

    if (error) throw new InternalServerErrorException(error.message);

    const links = (data ?? []) as unknown as ILinkRow[];
    const rows = links.flatMap((link) =>
      link.pull_request?.repository &&
      assigned.has(link.pull_request.repository_id)
        ? [
            {
              link,
              pr: link.pull_request,
              repository: link.pull_request.repository,
            },
          ]
        : [],
    );
    // Keyed by provider + host: each Git instance has its own accounts (ticket 11).
    const authors = new Map<
      string,
      Awaited<ReturnType<GitIdentitiesService['resolveAuthors']>>
    >();
    const targets = new Map<
      string,
      {
        provider: GitProvider;
        host: string;
        list: { externalId: string; login: string }[];
      }
    >();

    for (const { pr, repository } of rows) {
      if (!pr.author_external_id) continue;

      const key = `${repository.provider}|${repository.host}`;
      const target = targets.get(key) ?? {
        provider: repository.provider,
        host: repository.host,
        list: [],
      };

      target.list.push({
        externalId: pr.author_external_id,
        login: pr.author_login ?? '',
      });
      targets.set(key, target);
    }

    for (const [key, { provider, host, list }] of targets)
      authors.set(
        key,
        await this.identities.resolveAuthors(
          organizationId,
          provider,
          list,
          host,
        ),
      );

    return rows
      .map(({ link, pr, repository }): IGitTaskPullRequestDto => {
        const user = pr.author_external_id
          ? authors
              .get(`${repository.provider}|${repository.host}`)
              ?.get(pr.author_external_id)
          : undefined;

        return {
          id: pr.id,
          provider: repository.provider,
          repository: repository.full_name,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          isDraft: pr.is_draft,
          sourceBranch: pr.source_branch,
          targetBranch: pr.target_branch,
          author:
            pr.author_login || user
              ? {
                  login: pr.author_login,
                  avatarUrl: pr.author_avatar_url,
                  user: user
                    ? {
                        id: user.userId,
                        name: user.name,
                        avatarUrl: user.avatarUrl,
                      }
                    : null,
                }
              : null,
          source: link.source,
          live: isRepositoryLive(
            { status: repository.connection?.status ?? 'disconnected' },
            repository,
          ),
          linkedAt: link.created_at,
          updatedAt: pr.provider_updated_at,
          reviewState: pr.review_state,
          displayState: displayStateOf({
            state: pr.state,
            isDraft: pr.is_draft,
            reviewState: pr.review_state,
          }),
          // Filled in by getDevelopment from git_task_commits / git_task_builds.
          commitCount: 0,
          build: null,
          afterMerge: null,
        };
      })
      .sort(comparePullRequests);
  }

  /**
   * Branches linked to the task that no pull request of the same repository uses as its source branch
   * (in any state, linked or not), so a branch disappears as soon as its pull request is opened and
   * does not come back when that pull request is unlinked by hand.
   */
  private async branchesOf(
    organizationId: string,
    taskId: string,
    assigned: Set<string>,
  ): Promise<IGitTaskBranchDto[]> {
    const { data, error } = await this.db
      .from(BRANCH_LINKS)
      .select(BRANCH_LINK_SELECT)
      .eq('organization_id', organizationId)
      .eq('task_id', taskId);

    if (error) throw new InternalServerErrorException(error.message);

    const branches = ((data ?? []) as unknown as IBranchLinkRow[]).flatMap(
      (row) =>
        row.branch?.repository && assigned.has(row.branch.repository.id)
          ? [{ ...row.branch, repository: row.branch.repository }]
          : [],
    );

    if (!branches.length) return [];

    const { data: prs, error: prError } = await this.db
      .from('git_pull_requests')
      .select('repository_id, source_branch')
      .eq('organization_id', organizationId)
      .in('repository_id', [...new Set(branches.map((b) => b.repository.id))])
      .in('source_branch', [...new Set(branches.map((b) => b.name))]);

    if (prError) throw new InternalServerErrorException(prError.message);

    const withPullRequest = new Set(
      ((prs ?? []) as { repository_id: string; source_branch: string }[]).map(
        (pr) => `${pr.repository_id}\u0000${pr.source_branch}`,
      ),
    );

    return branches
      .filter((b) => !withPullRequest.has(`${b.repository.id}\u0000${b.name}`))
      .sort((a, b) => b.last_pushed_at.localeCompare(a.last_pushed_at))
      .slice(0, MAX_BRANCHES)
      .map(
        (b): IGitTaskBranchDto => ({
          id: b.id,
          provider: b.repository.provider,
          repository: b.repository.full_name,
          name: b.name,
          url: branchUrl(b.repository.provider, b.repository.web_url, b.name),
          updatedAt: b.last_pushed_at,
          live: isRepositoryLive(
            { status: b.repository.connection?.status ?? 'disconnected' },
            b.repository,
          ),
          // Filled in by getDevelopment from git_task_builds.
          build: null,
        }),
      );
  }

  private async subtaskPullRequestCount(
    organizationId: string,
    taskId: string,
  ): Promise<number> {
    const { data, error } = (await this.db.rpc(
      'git_subtask_pull_request_count',
      {
        p_org: organizationId,
        p_task_id: taskId,
      },
    )) as { data: unknown; error: { message: string } | null };

    if (error) throw new InternalServerErrorException(error.message);

    return Number(data) || 0;
  }

  /**
   * The live repository (and its connection) a pasted address points at, in this organization.
   * @throws {UnprocessableEntityException} 'repository_not_connected'
   */
  async findLinkTarget(
    organizationId: string,
    parsed: IParsedPullRequestUrl,
  ): Promise<{ connection: IGitConnectionRow; repository: IGitRepositoryRow }> {
    const { data, error } = await this.db
      .from(REPOSITORIES)
      .select(REPOSITORY_WITH_CONNECTION)
      .eq('organization_id', organizationId)
      .eq('provider', parsed.provider)
      .eq('host', parsed.host)
      .ilike('full_name', escapeLike(parsed.fullName))
      .limit(10);

    if (error) throw new InternalServerErrorException(error.message);

    // A repository deleted and re-created upstream under the same name leaves an old, removed row.
    for (const { connection, ...repository } of (data ??
      []) as RepositoryWithConnection[]) {
      if (connection && isRepositoryLive(connection, repository))
        return { connection, repository };
    }

    throw new UnprocessableEntityException('repository_not_connected');
  }

  /** Whether the pull request `number` of `repository` is linked to the task now (null: never linked). */
  async linkState(
    organizationId: string,
    taskId: string,
    repository: IGitRepositoryRow,
    number: number,
  ): Promise<'linked' | 'unlinked' | null> {
    const { data, error } = await this.db
      .from(LINKS)
      .select(
        'state, pull_request:git_pull_requests!git_pull_request_tasks_pull_request_fkey!inner(id)',
      )
      .eq('organization_id', organizationId)
      .eq('task_id', taskId)
      .eq('pull_request.repository_id', repository.id)
      .eq('pull_request.number', number)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);

    return (data as { state?: 'linked' | 'unlinked' } | null)?.state ?? null;
  }

  /**
   * Links by hand (after {@link sync} stored the pull request): the row becomes manual and linked,
   * whether it was new, unlinked by hand, or created automatically by that same sync.
   */
  async linkManual(
    user: RequestUser,
    taskId: string,
    pullRequestId: string,
    details: {
      provider: GitProvider;
      repository: string;
      repositoryId: string;
      pr: IProviderPullRequest;
    },
  ): Promise<void> {
    const { error } = await this.db.from(LINKS).upsert(
      {
        pull_request_id: pullRequestId,
        task_id: taskId,
        organization_id: user.organizationId,
        source: 'manual',
        state: 'linked',
        linked_by: user.userId,
        unlinked_by: null,
        unlinked_at: null,
      },
      { onConflict: 'pull_request_id,task_id' },
    );

    if (error) throw new InternalServerErrorException(error.message);

    await this.logHistory(user, taskId, 'pull_request_linked', {
      provider: details.provider,
      repository: details.repository,
      number: details.pr.number,
      title: details.pr.title,
      url: details.pr.url,
    });

    // Ticket 9: "pull request linked to my task" (opt-in) for the assignee; History is the row above.
    await this.activity.record({
      organizationId: user.organizationId,
      provider: details.provider,
      kind: 'pr_linked',
      taskIds: [taskId],
      subject: {
        kind: 'pull_request',
        number: details.pr.number,
        title: details.pr.title,
        url: details.pr.url,
        pullRequestId,
        repository: details.repository,
      },
      actor: { externalId: null, login: null },
      manualBy: user.userId,
      repositoryId: details.repositoryId,
    });
  }

  /**
   * Unlinks by hand. The row stays as 'unlinked' so the key in the pull request never links it again.
   * @throws {NotFoundException} when the pull request is not linked to this task.
   */
  async unlink(
    user: RequestUser,
    taskId: string,
    pullRequestId: string,
  ): Promise<void> {
    await this.assertTask(user.organizationId, taskId);

    const { data, error } = await this.db
      .from(LINKS)
      .update({
        state: 'unlinked',
        unlinked_by: user.userId,
        unlinked_at: new Date().toISOString(),
      })
      .eq('organization_id', user.organizationId)
      .eq('task_id', taskId)
      .eq('pull_request_id', pullRequestId)
      .eq('state', 'linked')
      .select(LINK_SELECT);

    if (error) throw new InternalServerErrorException(error.message);

    const row = ((data ?? []) as unknown as ILinkRow[])[0];

    if (!row) throw new NotFoundException('Pull request link not found');

    const pr = row.pull_request;

    await this.logHistory(user, taskId, 'pull_request_unlinked', {
      provider: pr?.repository?.provider ?? null,
      repository: pr?.repository?.full_name ?? null,
      number: pr?.number ?? null,
      title: pr?.title ?? null,
      url: pr?.url ?? null,
    });
  }

  /** Best effort, like the other task history writers: a history failure never fails the action. */
  private async logHistory(
    user: RequestUser,
    taskId: string,
    action: 'pull_request_linked' | 'pull_request_unlinked',
    value: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.db.from('task_history').insert({
      task_id: taskId,
      organization_id: user.organizationId,
      action,
      field_name: null,
      old_value: null,
      new_value: value,
      changed_by: user.userId,
    });

    if (error)
      this.logger.warn(`task history ${action} ${taskId}: ${error.message}`);
  }

  // ---------------------------------------------------------------------------
  // First-connection import
  // ---------------------------------------------------------------------------

  /**
   * Claims up to {@link BACKFILL_BATCH} live repositories, in ANY organization, whose open and recent
   * pull requests were never imported. The claim is a conditional update, so several instances never
   * import the same repository. ponytail: first time only; a repository re-enabled later is not
   * re-imported (clear `pull_requests_backfilled_at` to force it).
   */
  async claimBackfill(
    providers: GitProvider[],
  ): Promise<
    { connection: IGitConnectionRow; repository: IGitRepositoryRow }[]
  > {
    if (!providers.length) return [];

    const now = new Date().toISOString();

    // Inner join on a live connection: rows of disconnected connections can never fill the batch (they
    // used to sit first in the queue forever). Rows given back after a failure wait for their retry time.
    const { data, error } = await this.db
      .from(REPOSITORIES)
      .select(REPOSITORY_WITH_LIVE_CONNECTION)
      .in('provider', providers)
      .eq('is_enabled', true)
      .is('removed_at', null)
      .is('pull_requests_backfilled_at', null)
      .neq('connection.status', 'disconnected')
      .or(
        `pull_requests_backfill_retry_at.is.null,pull_requests_backfill_retry_at.lte.${now}`,
      )
      .order('created_at', { ascending: true })
      .limit(BACKFILL_BATCH * 5);

    if (error) throw new InternalServerErrorException(error.message);

    const claimed: {
      connection: IGitConnectionRow;
      repository: IGitRepositoryRow;
    }[] = [];

    for (const { connection, ...repository } of (data ??
      []) as RepositoryWithConnection[]) {
      if (claimed.length >= BACKFILL_BATCH) break;
      if (!connection || !isRepositoryLive(connection, repository)) continue;

      const { data: won, error: claimError } = await this.db
        .from(REPOSITORIES)
        .update({ pull_requests_backfilled_at: new Date().toISOString() })
        .eq('id', repository.id)
        .eq('organization_id', repository.organization_id)
        .is('pull_requests_backfilled_at', null)
        .select('id');

      if (claimError) {
        this.logger.warn(
          `claim backfill ${repository.id}: ${claimError.message}`,
        );
        continue;
      }

      if (Array.isArray(won) && won.length)
        claimed.push({ connection, repository });
    }

    return claimed;
  }

  /**
   * Gives a claimed repository back after a failed import. It is retried with a growing delay (5 min, 10, 20
   * ... at most daily), so a repository that keeps failing never takes a slot every tick.
   */
  async releaseBackfill(repository: IGitRepositoryRow): Promise<void> {
    const attempts = Math.min(
      (repository.pull_requests_backfill_attempts ?? 0) + 1,
      // smallint; the delay is capped long before this.
      30000,
    );

    const { error } = await this.db
      .from(REPOSITORIES)
      .update({
        pull_requests_backfilled_at: null,
        pull_requests_backfill_attempts: attempts,
        pull_requests_backfill_retry_at: backfillRetryAt(attempts),
      })
      .eq('id', repository.id)
      .eq('organization_id', repository.organization_id);

    if (error)
      this.logger.warn(`release backfill ${repository.id}: ${error.message}`);
  }
}
