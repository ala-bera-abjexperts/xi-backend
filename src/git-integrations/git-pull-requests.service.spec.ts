/**
 * @fileoverview Unit tests for GitPullRequestsService: the RPC payload and key extraction, the task
 * list (tenant filters, author resolution, "no longer updated"), link target lookup, manual link /
 * unlink with history, and the backfill claim. The database is mocked; the RPC's own behaviour is
 * covered by the SQL behaviour test of migration 20261019120000.
 * @module src/git-integrations/git-pull-requests.service.spec
 */

import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { RequestUser } from '../auth/interfaces/request-user.interface';
import type { GitActivityService } from './git-activity.service';
import type { GitIdentitiesService } from './git-identities.service';
import type { GitStatusAutomationService } from './git-status-automation.service';
import type {
  IGitRepositoryRow,
  IProviderBuild,
  IProviderCommit,
  IProviderPullRequest,
} from './git-integrations.types';
import {
  branchUrl,
  changeIdOf,
  parsePullRequestUrl,
} from './git-integrations.util';
import {
  backfillRetryAt,
  GitPullRequestsService,
  mapToServerHost,
} from './git-pull-requests.service';

// Every task counts as being in a space with the Development module on. The gate is an RPC with its own
// tests; these specs are about what happens behind it.
jest.mock('./git-integrations.util', () => ({
  ...jest.requireActual('./git-integrations.util'),
  developmentTaskIds: jest.fn((_db: unknown, _org: string, ids: string[]) =>
    Promise.resolve(new Set(ids)),
  ),
  // Every repository is assigned to every space, for the same reason.
  spaceRepositoryIds: jest.fn(() =>
    Promise.resolve({ get: () => ({ has: () => true }) }),
  ),
}));

const ORG = 'org-1';
const TASK = '11111111-1111-4111-8111-111111111111';
const user = { userId: 'user-1', organizationId: ORG } as RequestUser;

interface ICall {
  method: string;
  args: unknown[];
}

interface IResult {
  data?: unknown;
  error?: { message: string } | null;
}

function makeDb() {
  const chains: { table: string; calls: ICall[] }[] = [];
  const queues = new Map<string, IResult[]>();
  const rpc = jest.fn();
  const next = (table: string) => {
    const result = queues.get(table)?.shift() ?? {};

    return { data: result.data ?? null, error: result.error ?? null };
  };
  const from = (table: string) => {
    const chain = { table, calls: [] as ICall[] };
    let resolved: { data: unknown; error: unknown } | undefined;
    const resolve = () => (resolved ??= next(table));
    const builder: Record<string, unknown> = {};

    chains.push(chain);

    for (const method of [
      'select',
      'insert',
      'update',
      'upsert',
      'eq',
      'in',
      'is',
      'neq',
      'or',
      'ilike',
      'order',
      'limit',
    ]) {
      builder[method] = (...args: unknown[]) => {
        chain.calls.push({ method, args });

        return builder;
      };
    }

    builder.maybeSingle = () => Promise.resolve(resolve());
    builder.then = (
      onF: (v: unknown) => unknown,
      onR?: (e: unknown) => unknown,
    ) => Promise.resolve(resolve()).then(onF, onR);

    return builder;
  };

  return {
    client: { from, rpc },
    rpc,
    queue(table: string, ...results: IResult[]) {
      queues.set(table, [...(queues.get(table) ?? []), ...results]);
    },
    on(table: string) {
      return chains.filter((chain) => chain.table === table);
    },
  };
}

const args = (chain: { calls: ICall[] }, method: string) =>
  chain.calls.filter((call) => call.method === method).map((call) => call.args);

function setup() {
  const db = makeDb();
  const identities = {
    resolveAuthors: jest.fn().mockResolvedValue(new Map()),
    resolveLogins: jest.fn().mockResolvedValue(new Map()),
  };
  const automation = { handle: jest.fn().mockResolvedValue(undefined) };
  const activity = { record: jest.fn().mockResolvedValue(undefined) };
  const servers = { list: jest.fn().mockResolvedValue([]) };
  const service = new GitPullRequestsService(
    { getClient: () => db.client } as never,
    identities as unknown as GitIdentitiesService,
    automation as unknown as GitStatusAutomationService,
    activity as unknown as GitActivityService,
    servers as never,
  );

  return { service, db, identities, automation, activity, servers };
}

const repo = (overrides: Partial<IGitRepositoryRow> = {}) =>
  ({
    id: 'repo-1',
    organization_id: ORG,
    connection_id: 'conn-1',
    provider: 'github',
    host: 'github.com',
    external_id: '42',
    full_name: 'acme/api',
    is_enabled: true,
    removed_at: null,
    ...overrides,
  }) as IGitRepositoryRow;

const pr = (
  overrides: Partial<IProviderPullRequest> = {},
): IProviderPullRequest => ({
  number: 12,
  externalId: '9001',
  title: 'XE-T1 and xe-t2',
  url: 'https://github.com/acme/api/pull/12',
  state: 'open',
  isDraft: false,
  sourceBranch: 'XE-T656-git-integration',
  targetBranch: 'main',
  headRepoFullName: null,
  author: { externalId: '7', login: 'dev', avatarUrl: null },
  openedAt: '2026-10-19T09:00:00Z',
  closedAt: null,
  mergedAt: null,
  updatedAt: '2026-10-19T10:00:00Z',
  body: 'Also RM-T9. XE-T6560 is a different task.',
  ...overrides,
});

const linkRow = (
  overrides: Record<string, unknown> = {},
  prOverrides: Record<string, unknown> = {},
) => ({
  source: 'auto',
  created_at: '2026-10-19T10:00:00Z',
  pull_request: {
    id: 'pr-1',
    number: 12,
    title: 'T',
    url: 'u',
    state: 'open',
    is_draft: false,
    source_branch: 'b',
    target_branch: 'main',
    author_external_id: '7',
    author_login: 'dev',
    author_avatar_url: null,
    provider_updated_at: '2026-10-19T10:00:00Z',
    review_state: null,
    repository: {
      provider: 'github',
      host: 'github.com',
      full_name: 'acme/api',
      is_enabled: true,
      removed_at: null,
      connection: { status: 'active' },
    },
    ...prOverrides,
  },
  ...overrides,
});

describe('GitPullRequestsService', () => {
  describe('sync', () => {
    it('sends the stored fields and every key from branch, title and description (never the description itself)', async () => {
      const { service, db } = setup();

      db.rpc.mockResolvedValue({
        data: {
          pull_request_id: 'pr-1',
          applied: true,
          linked: ['t1'],
          removed: [],
        },
        error: null,
      });

      const result = await service.sync(repo(), pr());

      const [name, params] = db.rpc.mock.calls[0] as [
        string,
        {
          p_org: string;
          p_repository_id: string;
          p_keys: string[];
          p_pr: Record<string, unknown>;
        },
      ];

      expect(name).toBe('git_sync_pull_request');
      expect(params.p_org).toBe(ORG);
      expect(params.p_repository_id).toBe('repo-1');
      expect(params.p_keys).toEqual([
        'XE-T656',
        'XE-T1',
        'XE-T2',
        'RM-T9',
        'XE-T6560',
      ]);
      expect(params.p_pr).toMatchObject({
        number: 12,
        external_id: '9001',
        state: 'open',
        source_branch: 'XE-T656-git-integration',
        author_external_id: '7',
        author_login: 'dev',
        provider_updated_at: '2026-10-19T10:00:00Z',
      });
      expect(JSON.stringify(params.p_pr)).not.toContain('Also RM-T9');
      expect(result).toEqual({
        pullRequestId: 'pr-1',
        applied: true,
        linked: ['t1'],
        removed: [],
      });
    });

    it('throws on an RPC error (the webhook then forgets the delivery)', async () => {
      const { service, db } = setup();

      db.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

      await expect(service.sync(repo(), pr())).rejects.toThrow('boom');
    });
  });

  describe('getDevelopment', () => {
    it('404 when the task is not in this organization (nothing else is read)', async () => {
      const { service, db } = setup();

      db.queue('tasks', { data: null });

      await expect(service.getDevelopment(ORG, TASK)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(args(db.on('tasks')[0], 'eq')).toContainEqual([
        'organization_id',
        ORG,
      ]);
      expect(db.on('git_pull_request_tasks')).toHaveLength(0);
      expect(db.rpc).not.toHaveBeenCalled();
    });

    it('pull requests: org + task filtered, open → merged → closed, newest first, authors, liveness, display state', async () => {
      const { service, db, identities } = setup();

      db.rpc.mockResolvedValue({ data: 0, error: null });
      db.queue('tasks', { data: { id: TASK } });
      db.queue('git_pull_request_tasks', {
        data: [
          linkRow(
            {},
            {
              id: 'merged',
              state: 'merged',
              provider_updated_at: '2026-10-19T13:00:00Z',
            },
          ),
          linkRow(
            {},
            {
              id: 'old-open',
              provider_updated_at: '2026-10-01T00:00:00Z',
              review_state: 'approved',
            },
          ),
          linkRow(
            {},
            {
              id: 'closed',
              state: 'closed',
              provider_updated_at: '2026-10-19T14:00:00Z',
            },
          ),
          linkRow(
            { source: 'manual' },
            {
              id: 'new-open',
              is_draft: true,
              review_state: 'approved',
              provider_updated_at: '2026-10-19T12:00:00Z',
              repository: {
                provider: 'github',
                host: 'ghe.company.local',
                full_name: 'acme/web',
                is_enabled: true,
                removed_at: null,
                connection: { status: 'disconnected' },
              },
            },
          ),
          { source: 'auto', created_at: 'x', pull_request: null },
        ],
      });
      db.queue('git_branch_tasks', { data: [] });
      identities.resolveAuthors.mockResolvedValue(
        new Map([
          ['7', { userId: 'u7', name: 'Dev Eloper', avatarUrl: 'pic' }],
        ]),
      );

      const { pullRequests } = await service.getDevelopment(ORG, TASK);

      expect(args(db.on('git_pull_request_tasks')[0], 'eq')).toEqual([
        ['organization_id', ORG],
        ['task_id', TASK],
        ['state', 'linked'],
      ]);
      expect(
        pullRequests.map((pr) => [pr.id, pr.displayState, pr.live, pr.source]),
      ).toEqual([
        ['new-open', 'draft', false, 'manual'],
        ['old-open', 'approved', true, 'auto'],
        ['merged', 'merged', true, 'auto'],
        ['closed', 'closed', true, 'auto'],
      ]);
      // Ticket 11: authors resolve against the accounts of each repository's host.
      expect(
        identities.resolveAuthors.mock.calls.map((call) => call[3]).sort(),
      ).toEqual(['ghe.company.local', 'github.com']);
      expect(pullRequests[0].reviewState).toBe('approved');
      expect(pullRequests[0].author).toEqual({
        login: 'dev',
        avatarUrl: null,
        user: { id: 'u7', name: 'Dev Eloper', avatarUrl: 'pic' },
      });
    });

    it('branches: hides those a pull request already uses, newest first, with provider URL and liveness', async () => {
      const { service, db } = setup();
      const repoA = {
        id: 'repo-a',
        provider: 'github',
        full_name: 'acme/api',
        web_url: 'https://github.com/acme/api',
        is_enabled: true,
        removed_at: null,
        connection: { status: 'active' },
      };
      const repoB = {
        ...repoA,
        id: 'repo-b',
        provider: 'gitlab',
        full_name: 'grp/web',
        web_url: 'https://gitlab.com/grp/web',
        connection: { status: 'disconnected' },
      };

      db.rpc.mockResolvedValue({ data: 3, error: null });
      db.queue('tasks', { data: { id: TASK } });
      db.queue('git_pull_request_tasks', { data: [] });
      db.queue('git_branch_tasks', {
        data: [
          {
            branch: {
              name: 'XE-T1-has-pr',
              last_pushed_at: '2026-10-19T09:00:00Z',
              repository: repoA,
            },
          },
          {
            branch: {
              id: 'br-old',
              name: 'feature/XE-T1-old',
              last_pushed_at: '2026-10-18T09:00:00Z',
              repository: repoA,
            },
          },
          {
            branch: {
              id: 'br-b',
              name: 'XE-T1-has-pr',
              last_pushed_at: '2026-10-19T10:00:00Z',
              repository: repoB,
            },
          },
          { branch: null },
        ],
      });
      db.queue('git_pull_requests', {
        data: [{ repository_id: 'repo-a', source_branch: 'XE-T1-has-pr' }],
      });

      const result = await service.getDevelopment(ORG, TASK);

      expect(result.subtaskPullRequestCount).toBe(3);
      expect(db.rpc).toHaveBeenCalledWith('git_subtask_pull_request_count', {
        p_org: ORG,
        p_task_id: TASK,
      });
      expect(args(db.on('git_pull_requests')[0], 'eq')).toEqual([
        ['organization_id', ORG],
      ]);
      expect(result.branches).toEqual([
        {
          id: 'br-b',
          provider: 'gitlab',
          repository: 'grp/web',
          name: 'XE-T1-has-pr',
          url: 'https://gitlab.com/grp/web/-/tree/XE-T1-has-pr',
          updatedAt: '2026-10-19T10:00:00Z',
          live: false,
          build: null,
        },
        {
          id: 'br-old',
          provider: 'github',
          repository: 'acme/api',
          name: 'feature/XE-T1-old',
          url: 'https://github.com/acme/api/tree/feature/XE-T1-old',
          updatedAt: '2026-10-18T09:00:00Z',
          live: true,
          build: null,
        },
      ]);
    });

    it('no branches → no pull request lookup', async () => {
      const { service, db } = setup();

      db.rpc.mockResolvedValue({ data: 0, error: null });
      db.queue('tasks', { data: { id: TASK } });
      db.queue('git_pull_request_tasks', { data: [] });
      db.queue('git_branch_tasks', { data: [] });

      await expect(service.getDevelopment(ORG, TASK)).resolves.toEqual({
        pullRequests: [],
        branches: [],
        subtaskPullRequestCount: 0,
        commits: [],
        moreCommits: [],
        buildSummary: null,
      });
      expect(db.on('git_pull_requests')).toHaveLength(0);
    });
  });

  describe('reviews and branches (ticket 5)', () => {
    it('sync sends the reviewer snapshot only when the delivery was applied', async () => {
      const { service, db } = setup();
      const reviews = [
        {
          reviewerId: '5',
          login: 'lead',
          state: 'approved' as const,
          submittedAt: null,
        },
      ];

      db.rpc
        .mockResolvedValueOnce({
          data: {
            pull_request_id: 'pr-1',
            applied: true,
            linked: [],
            removed: [],
          },
          error: null,
        })
        .mockResolvedValueOnce({ data: 'approved', error: null })
        .mockResolvedValueOnce({
          data: {
            pull_request_id: 'pr-1',
            applied: false,
            linked: [],
            removed: [],
          },
          error: null,
        });

      await service.sync(repo(), pr({ reviews }));
      await service.sync(repo(), pr({ reviews }));

      expect(db.rpc).toHaveBeenCalledTimes(3);
      expect(db.rpc.mock.calls[1]).toEqual([
        'git_set_pull_request_reviews',
        {
          p_org: ORG,
          p_pull_request_id: 'pr-1',
          p_reviews: [
            { id: '5', login: 'lead', state: 'approved', submitted_at: null },
          ],
        },
      ]);
    });

    it('sync without reviews (GitHub pull_request event) leaves the verdicts alone', async () => {
      const { service, db } = setup();

      db.rpc.mockResolvedValue({
        data: {
          pull_request_id: 'pr-1',
          applied: true,
          linked: [],
          removed: [],
        },
        error: null,
      });

      await service.sync(repo(), pr());

      expect(db.rpc).toHaveBeenCalledTimes(1);
    });

    it('recordReview passes the event to the RPC and returns the summary', async () => {
      const { service, db } = setup();

      db.rpc.mockResolvedValue({ data: 'changes_requested', error: null });

      await expect(
        service.recordReview(repo(), 12, {
          reviewerId: '7',
          login: 'dev',
          state: 'changes_requested',
          submittedAt: '2026-10-19T11:00:00Z',
        }),
      ).resolves.toBe('changes_requested');
      expect(db.rpc).toHaveBeenCalledWith('git_record_pull_request_review', {
        p_org: ORG,
        p_repository_id: 'repo-1',
        p_number: 12,
        p_reviewer_id: '7',
        p_login: 'dev',
        p_state: 'changes_requested',
        p_submitted_at: '2026-10-19T11:00:00Z',
      });
    });

    it('syncBranch: keys from the name; a branch without a key costs no database call', async () => {
      const { service, db } = setup();

      db.rpc.mockResolvedValue({ data: {}, error: null });

      await service.syncBranch(repo(), 'main', null, false);
      await service.syncBranch(
        repo(),
        'feature/xe-t5-login',
        '2026-10-19T12:00:00Z',
        false,
      );

      expect(db.rpc).toHaveBeenCalledTimes(1);
      expect(db.rpc).toHaveBeenCalledWith('git_sync_branch', {
        p_org: ORG,
        p_repository_id: 'repo-1',
        p_name: 'feature/xe-t5-login',
        p_keys: ['XE-T5'],
        p_pushed_at: '2026-10-19T12:00:00Z',
        p_deleted: false,
      });
    });

    it('syncBranch throws on an RPC error (the webhook then forgets the delivery)', async () => {
      const { service, db } = setup();

      db.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

      await expect(
        service.syncBranch(repo(), 'XE-T5', null, true),
      ).rejects.toThrow('boom');
    });
  });

  describe('commits (ticket 6)', () => {
    const commit = (
      overrides: Partial<IProviderCommit> = {},
    ): IProviderCommit => ({
      sha: 'A'.repeat(40),
      message: 'Fixes XE-T1, refs xe-t2\n\nlong body that is never stored',
      url: 'https://github.com/acme/api/commit/a',
      authorName: 'Dev',
      authorEmail: 'dev@example.com',
      authorLogin: 'dev',
      authoredAt: '2026-10-01T10:00:00Z',
      committedAt: '2026-10-02T10:00:00Z',
      ...overrides,
    });

    it('syncCommits sends only keyed commits: change id, first line, keys and closing keys; never the email or body', async () => {
      const { service, db } = setup();

      db.rpc.mockResolvedValue({ data: { stored: 1 }, error: null });

      await expect(
        service.syncCommits(repo(), 'main', [
          commit(),
          commit({ sha: 'b'.repeat(40), message: 'no key here' }),
        ]),
      ).resolves.toBe(1);

      expect(db.rpc).toHaveBeenCalledTimes(1);
      expect(db.rpc).toHaveBeenCalledWith('git_sync_commits', {
        p_org: ORG,
        p_repository_id: 'repo-1',
        p_branch: 'main',
        p_commits: [
          {
            change_id: changeIdOf(
              'dev@example.com',
              '2026-10-01T10:00:00Z',
              'a',
            ),
            sha: 'a'.repeat(40),
            title: 'Fixes XE-T1, refs xe-t2',
            url: 'https://github.com/acme/api/commit/a',
            author_name: 'Dev',
            author_login: 'dev',
            authored_at: '2026-10-01T10:00:00Z',
            committed_at: '2026-10-02T10:00:00Z',
            keys: ['XE-T1', 'XE-T2'],
            closing_keys: ['XE-T1'],
          },
        ],
      });
      expect(JSON.stringify(db.rpc.mock.calls)).not.toContain(
        'dev@example.com',
      );
      expect(JSON.stringify(db.rpc.mock.calls)).not.toContain('long body');
    });

    it('syncCommits: no keyed commit → no RPC; big pushes go in chunks of 500, capped at 2048', async () => {
      const { service, db } = setup();

      db.rpc.mockResolvedValue({ data: { stored: 7 }, error: null });

      await expect(
        service.syncCommits(repo(), 'main', [commit({ message: 'wip' })]),
      ).resolves.toBe(0);
      expect(db.rpc).not.toHaveBeenCalled();

      const many = Array.from({ length: 2100 }, (_, i) =>
        commit({
          sha: i.toString(16).padStart(40, '0'),
          message: `Refs XE-T${i + 1}`,
        }),
      );

      await expect(service.syncCommits(repo(), 'main', many)).resolves.toBe(35);

      const sizes = db.rpc.mock.calls.map(
        (call) => (call[1] as { p_commits: unknown[] }).p_commits.length,
      );

      expect(sizes).toEqual([500, 500, 500, 500, 48]);
    });

    it('syncCommits throws on an RPC error (the webhook then forgets the delivery)', async () => {
      const { service, db } = setup();

      db.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

      await expect(
        service.syncCommits(repo(), 'main', [commit()]),
      ).rejects.toThrow('boom');
    });

    it('commitLinkingEnabled reads the org + provider setting; no row means off', async () => {
      const { service, db } = setup();

      db.queue(
        'git_integration_settings',
        { data: { link_commits: true } },
        { data: null },
        { data: { link_commits: false } },
      );

      await expect(
        service.commitLinkingEnabled(repo({ provider: 'gitlab' })),
      ).resolves.toBe(true);
      await expect(service.commitLinkingEnabled(repo())).resolves.toBe(false);
      await expect(service.commitLinkingEnabled(repo())).resolves.toBe(false);
      expect(args(db.on('git_integration_settings')[0], 'eq')).toEqual([
        ['organization_id', ORG],
        ['provider', 'gitlab'],
      ]);
    });

    it('sync stores the merge commits of a merged pull request (lower case, org-scoped); none → no write', async () => {
      const { service, db } = setup();

      db.rpc.mockResolvedValue({
        data: {
          pull_request_id: 'pr-1',
          applied: true,
          linked: [],
          removed: [],
        },
        error: null,
      });

      await service.sync(
        repo(),
        pr({ state: 'merged', mergeCommitShas: ['ABC', 'def'] }),
      );
      await service.sync(repo(), pr({ mergeCommitShas: [] }));

      const updates = db.on('git_pull_requests');

      expect(updates).toHaveLength(1);
      expect(args(updates[0], 'update')).toEqual([
        [{ merge_commit_shas: ['abc', 'def'] }],
      ]);
      expect(args(updates[0], 'eq')).toEqual([
        ['id', 'pr-1'],
        ['organization_id', ORG],
      ]);
    });

    it('getDevelopment: commits, per-PR counts, overflow search links and GitHub authors as members', async () => {
      const { service, db, identities } = setup();

      db.rpc.mockImplementation((fn: string) =>
        Promise.resolve(
          fn === 'git_task_commits'
            ? {
                data: {
                  commits: [
                    {
                      provider: 'github',
                      repository: 'acme/api',
                      repositoryId: 'repo-1',
                      sha: 'c'.repeat(40),
                      title: 'Refs XE-T1 docs',
                      url: 'https://github.com/acme/api/commit/c',
                      author_name: 'Dev',
                      author_login: 'dev',
                      committed_at: '2026-10-02T10:00:00Z',
                      closes: true,
                    },
                    {
                      provider: 'gitlab',
                      repository: 'g/p',
                      sha: 'd'.repeat(40),
                      title: 'hotfix XE-T1',
                      url: 'https://gitlab.com/g/p/-/commit/d',
                      author_name: 'Lab Dev',
                      author_login: null,
                      committed_at: '2026-10-01T10:00:00Z',
                      closes: false,
                    },
                  ],
                  more: [
                    {
                      provider: 'github',
                      repository: 'acme/api',
                      repositoryId: 'repo-1',
                      web_url: 'https://github.com/acme/api',
                      count: 450,
                    },
                  ],
                  pr_counts: [{ pull_request_id: 'pr-1', count: 3 }],
                  total: 452,
                },
                error: null,
              }
            : { data: 0, error: null },
        ),
      );
      db.queue('tasks', { data: { id: TASK, key: 'XE-T1' } });
      db.queue('git_pull_request_tasks', {
        data: [linkRow(), linkRow({}, { id: 'pr-2' })],
      });
      db.queue('git_branch_tasks', { data: [] });
      identities.resolveLogins.mockResolvedValue(
        new Map([
          ['dev', { userId: 'u7', name: 'Dev Eloper', avatarUrl: 'pic' }],
        ]),
      );

      const result = await service.getDevelopment(ORG, TASK);

      expect(db.rpc).toHaveBeenCalledWith('git_task_commits', {
        p_org: ORG,
        p_task_id: TASK,
        p_limit: 50,
      });
      expect(identities.resolveLogins).toHaveBeenCalledWith(
        ORG,
        'github',
        ['dev'],
        'github.com',
      );
      expect(result.pullRequests.map((p) => [p.id, p.commitCount])).toEqual([
        ['pr-1', 3],
        ['pr-2', 0],
      ]);
      expect(result.commits).toEqual([
        {
          sha: 'c'.repeat(40),
          shortSha: 'ccccccc',
          title: 'Refs XE-T1 docs',
          url: 'https://github.com/acme/api/commit/c',
          provider: 'github',
          repository: 'acme/api',
          author: {
            name: 'Dev',
            login: 'dev',
            user: { id: 'u7', name: 'Dev Eloper', avatarUrl: 'pic' },
          },
          committedAt: '2026-10-02T10:00:00Z',
          closes: true,
        },
        {
          sha: 'd'.repeat(40),
          shortSha: 'ddddddd',
          title: 'hotfix XE-T1',
          url: 'https://gitlab.com/g/p/-/commit/d',
          provider: 'gitlab',
          repository: 'g/p',
          author: { name: 'Lab Dev', login: null, user: null },
          committedAt: '2026-10-01T10:00:00Z',
          closes: false,
        },
      ]);
      expect(result.moreCommits).toEqual([
        {
          provider: 'github',
          repository: 'acme/api',
          count: 450,
          url: 'https://github.com/search?q=repo%3Aacme%2Fapi+XE-T1&type=commits',
        },
      ]);
    });

    it('getDevelopment: no commits → no member lookup; a keyless task gets no search link', async () => {
      const { service, db, identities } = setup();

      db.rpc.mockImplementation((fn: string) =>
        Promise.resolve(
          fn === 'git_task_commits'
            ? {
                data: {
                  commits: [],
                  more: [
                    {
                      provider: 'gitlab',
                      repository: 'g/p',
                      web_url: 'https://gitlab.com/g/p',
                      count: 2,
                    },
                  ],
                  pr_counts: [],
                },
                error: null,
              }
            : { data: 0, error: null },
        ),
      );
      db.queue('tasks', { data: { id: TASK, key: null } });
      db.queue('git_pull_request_tasks', { data: [] });
      db.queue('git_branch_tasks', { data: [] });

      const result = await service.getDevelopment(ORG, TASK);

      expect(identities.resolveLogins).not.toHaveBeenCalled();
      expect(result.moreCommits).toEqual([
        { provider: 'gitlab', repository: 'g/p', count: 2, url: null },
      ]);
    });

    it('getDevelopment throws when git_task_commits fails', async () => {
      const { service, db } = setup();

      db.rpc.mockImplementation((fn: string) =>
        Promise.resolve(
          fn === 'git_task_commits'
            ? { data: null, error: { message: 'nope' } }
            : { data: 0, error: null },
        ),
      );
      db.queue('tasks', { data: { id: TASK, key: 'XE-T1' } });
      db.queue('git_pull_request_tasks', { data: [] });
      db.queue('git_branch_tasks', { data: [] });

      await expect(service.getDevelopment(ORG, TASK)).rejects.toThrow('nope');
    });
  });

  describe('builds (ticket 7)', () => {
    const build = (
      overrides: Partial<IProviderBuild> = {},
    ): IProviderBuild => ({
      externalId: '901',
      workflowKey: '55',
      name: 'CI',
      headBranch: 'XE-T1-ci',
      headRepoFullName: null,
      headSha: 'ABCDEF1234567890ABCDEF1234567890ABCDEF12',
      state: 'running',
      attempt: 2,
      url: 'https://github.com/acme/api/actions/runs/901',
      startedAt: '2026-10-20T10:00:00Z',
      completedAt: null,
      createdAt: '2026-10-20T09:59:00Z',
      updatedAt: '2026-10-20T10:01:00Z',
      ...overrides,
    });

    const buildRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'b1',
      provider: 'github',
      workflow_key: 'ci',
      name: 'CI',
      state: 'passed',
      url: 'https://github.com/acme/api/actions/runs/1',
      attempt: 1,
      head_branch: 'XE-T1-ci',
      head_sha: 'a'.repeat(40),
      started_at: null,
      completed_at: null,
      provider_created_at: '2026-10-20T10:00:00Z',
      ...overrides,
    });

    it('buildStatusEnabled: on without a settings row, off only when the row says so', async () => {
      const { service, db } = setup();

      db.queue(
        'git_integration_settings',
        { data: null },
        { data: { show_build_status: false } },
        { data: { show_build_status: true } },
      );

      await expect(service.buildStatusEnabled(repo())).resolves.toBe(true);
      await expect(service.buildStatusEnabled(repo())).resolves.toBe(false);
      await expect(
        service.buildStatusEnabled(repo({ provider: 'gitlab' })),
      ).resolves.toBe(true);
      expect(args(db.on('git_integration_settings')[2], 'eq')).toEqual([
        ['organization_id', ORG],
        ['provider', 'gitlab'],
      ]);
    });

    it('syncBuilds sends the build with its phase, branch keys and ordering flag; counts applied ones', async () => {
      const { service, db } = setup();

      db.queue('git_integration_settings', { data: null });
      db.rpc
        .mockResolvedValueOnce({ data: { applied: true }, error: null })
        .mockResolvedValueOnce({ data: { applied: false }, error: null });

      await expect(
        service.syncBuilds(
          repo(),
          [
            build(),
            build({ externalId: '902', state: 'failed', headBranch: null }),
          ],
          true,
        ),
      ).resolves.toBe(1);
      expect(db.rpc).toHaveBeenNthCalledWith(1, 'git_sync_build', {
        p_org: ORG,
        p_repository_id: 'repo-1',
        p_build: {
          external_id: '901',
          workflow_key: '55',
          name: 'CI',
          head_branch: 'XE-T1-ci',
          head_repo_full_name: null,
          head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
          state: 'running',
          phase: 1,
          attempt: 2,
          url: 'https://github.com/acme/api/actions/runs/901',
          started_at: '2026-10-20T10:00:00Z',
          completed_at: null,
          provider_created_at: '2026-10-20T09:59:00Z',
          provider_updated_at: '2026-10-20T10:01:00Z',
        },
        p_keys: ['XE-T1'],
        p_ordered: true,
      });
      expect(
        (
          db.rpc.mock.calls[1][1] as {
            p_build: { phase: number };
            p_keys: string[];
          }
        ).p_build.phase,
      ).toBe(2);
      expect((db.rpc.mock.calls[1][1] as { p_keys: string[] }).p_keys).toEqual(
        [],
      );
    });

    it("syncBuilds uses a build's own phase when it has one (commit statuses: time order only)", async () => {
      const { service, db } = setup();

      db.queue('git_integration_settings', { data: null });
      db.rpc.mockResolvedValue({ data: { applied: true }, error: null });

      await service.syncBuilds(
        repo(),
        [build({ state: 'failed', phase: 0 })],
        true,
      );

      expect(
        (db.rpc.mock.calls[0][1] as { p_build: { phase: number } }).p_build
          .phase,
      ).toBe(0);
    });

    it('syncBuilds stores nothing while build status is hidden, and nothing for an empty list', async () => {
      const { service, db } = setup();

      db.queue('git_integration_settings', {
        data: { show_build_status: false },
      });

      await expect(service.syncBuilds(repo(), [build()], true)).resolves.toBe(
        0,
      );
      await expect(service.syncBuilds(repo(), [], true)).resolves.toBe(0);
      expect(db.rpc).not.toHaveBeenCalled();
      expect(db.on('git_integration_settings')).toHaveLength(1);
    });

    it('syncBuilds throws on an RPC error (the webhook then forgets the delivery)', async () => {
      const { service, db } = setup();

      db.queue('git_integration_settings', { data: null });
      db.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

      await expect(
        service.syncBuilds(repo(), [build()], false),
      ).rejects.toThrow('boom');
    });

    it('sync stores the head commit only for an applied delivery, then the builds read with the pull request', async () => {
      const { service, db } = setup();

      db.rpc.mockImplementation((fn: string) =>
        Promise.resolve(
          fn === 'git_sync_pull_request'
            ? {
                data: {
                  pull_request_id: 'pr-1',
                  applied: true,
                  linked: [],
                  removed: [],
                },
                error: null,
              }
            : { data: { applied: true }, error: null },
        ),
      );
      db.queue('git_integration_settings', { data: null });

      await service.sync(
        repo(),
        pr({ headSha: 'ABC'.padEnd(40, '0'), builds: [build()] }),
      );

      expect(args(db.on('git_pull_requests')[0], 'update')).toEqual([
        [{ head_sha: 'abc'.padEnd(40, '0') }],
      ]);
      expect(db.rpc).toHaveBeenCalledWith(
        'git_sync_build',
        expect.objectContaining({ p_ordered: true }),
      );

      const stale = setup();

      stale.db.rpc.mockResolvedValue({
        data: {
          pull_request_id: 'pr-1',
          applied: false,
          linked: [],
          removed: [],
        },
        error: null,
      });
      await stale.service.sync(repo(), pr({ headSha: 'b'.repeat(40) }));
      expect(stale.db.on('git_pull_requests')).toHaveLength(0);
    });

    it('getDevelopment: PR build + after merge, branch build, headline over open, merged and branches (closed left out)', async () => {
      const { service, db } = setup();

      db.rpc.mockImplementation((fn: string) =>
        Promise.resolve(
          fn === 'git_task_builds'
            ? {
                data: {
                  pull_requests: [
                    {
                      pull_request_id: 'open',
                      current: [
                        buildRow({
                          id: 'o1',
                          state: 'failed',
                          url: 'fail-url',
                        }),
                        buildRow({ id: 'o2', workflow_key: 'lint' }),
                      ],
                      history: [buildRow({ id: 'h1' })],
                      after_merge: [],
                    },
                    {
                      pull_request_id: 'merged',
                      current: [buildRow({ id: 'm1' })],
                      history: [],
                      after_merge: [
                        buildRow({
                          id: 'am',
                          state: 'running',
                          url: 'main-run',
                        }),
                      ],
                    },
                    {
                      pull_request_id: 'closed',
                      current: [buildRow({ id: 'c1', state: 'failed' })],
                      history: [],
                      after_merge: [],
                    },
                  ],
                  branches: [
                    {
                      branch_id: 'br-1',
                      current: [buildRow({ id: 'br', state: 'queued' })],
                      history: [],
                    },
                  ],
                },
                error: null,
              }
            : { data: 0, error: null },
        ),
      );
      db.queue('tasks', { data: { id: TASK, key: 'XE-T1' } });
      db.queue('git_pull_request_tasks', {
        data: [
          linkRow({}, { id: 'open' }),
          linkRow({}, { id: 'merged', state: 'merged' }),
          linkRow({}, { id: 'closed', state: 'closed' }),
        ],
      });
      db.queue('git_branch_tasks', {
        data: [
          {
            branch: {
              id: 'br-1',
              name: 'XE-T1-wip',
              last_pushed_at: '2026-10-20T10:00:00Z',
              repository: {
                id: 'repo-x',
                provider: 'github',
                full_name: 'acme/web',
                web_url: null,
                is_enabled: true,
                removed_at: null,
                connection: { status: 'active' },
              },
            },
          },
        ],
      });
      db.queue('git_pull_requests', { data: [] });

      const result = await service.getDevelopment(ORG, TASK);
      const byId = new Map(result.pullRequests.map((p) => [p.id, p]));

      expect(db.rpc).toHaveBeenCalledWith('git_task_builds', {
        p_org: ORG,
        p_task_id: TASK,
      });
      expect(byId.get('open')?.build).toMatchObject({
        state: 'failed',
        url: 'fail-url',
      });
      expect(byId.get('open')?.build?.runs).toHaveLength(2);
      expect(byId.get('open')?.build?.history.map((h) => h.id)).toEqual(['h1']);
      expect(byId.get('open')?.afterMerge).toBeNull();
      expect(byId.get('merged')?.afterMerge).toMatchObject({
        state: 'running',
        url: 'main-run',
      });
      expect(byId.get('closed')?.build?.state).toBe('failed');
      expect(result.branches[0].build?.state).toBe('queued');
      // open: failed, merged after merge: running, branch: queued; the closed PR's failure is left out.
      expect(result.buildSummary).toEqual({
        state: 'failed',
        failed: 1,
        running: 2,
      });
    });

    it('getDevelopment: no builds anywhere → no headline', async () => {
      const { service, db } = setup();

      db.rpc.mockImplementation((fn: string) =>
        Promise.resolve(
          fn === 'git_task_builds'
            ? { data: { pull_requests: [], branches: [] }, error: null }
            : { data: 0, error: null },
        ),
      );
      db.queue('tasks', { data: { id: TASK, key: 'XE-T1' } });
      db.queue('git_pull_request_tasks', { data: [linkRow()] });
      db.queue('git_branch_tasks', { data: [] });

      const result = await service.getDevelopment(ORG, TASK);

      expect(result.pullRequests[0]).toMatchObject({
        build: null,
        afterMerge: null,
      });
      expect(result.buildSummary).toBeNull();
    });
  });

  describe('findLinkTarget', () => {
    const parsed = {
      provider: 'github' as const,
      host: 'github.com',
      fullName: 'acme/my_api',
      number: 12,
    };

    it('matches the name literally (LIKE wildcards escaped) and skips a removed row', async () => {
      const { service, db } = setup();
      const live = {
        ...repo({ id: 'live' }),
        connection: { status: 'active' },
      };

      db.queue('git_repositories', {
        data: [
          {
            ...repo({ id: 'gone', removed_at: '2026-01-01' }),
            connection: { status: 'active' },
          },
          live,
        ],
      });

      const target = await service.findLinkTarget(ORG, parsed);

      const chain = db.on('git_repositories')[0];

      expect(args(chain, 'ilike')).toEqual([['full_name', 'acme/my\\_api']]);
      expect(args(chain, 'eq')).toContainEqual(['organization_id', ORG]);
      expect(target.repository.id).toBe('live');
      expect(target.connection).toEqual({ status: 'active' });
    });

    it('repository_not_connected when there is no live row', async () => {
      const { service, db } = setup();

      db.queue('git_repositories', {
        data: [
          { ...repo({ is_enabled: false }), connection: { status: 'active' } },
        ],
      });

      await expect(service.findLinkTarget(ORG, parsed)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });

  describe('manual link / unlink', () => {
    it('linkManual upserts a manual, linked row and writes history with the person', async () => {
      const { service, db } = setup();

      await service.linkManual(user, TASK, 'pr-1', {
        provider: 'github',
        repository: 'acme/api',
        repositoryId: 'repo-1',
        pr: pr(),
      });

      expect(args(db.on('git_pull_request_tasks')[0], 'upsert')[0]).toEqual([
        {
          pull_request_id: 'pr-1',
          task_id: TASK,
          organization_id: ORG,
          source: 'manual',
          state: 'linked',
          linked_by: 'user-1',
          unlinked_by: null,
          unlinked_at: null,
        },
        { onConflict: 'pull_request_id,task_id' },
      ]);
      expect(args(db.on('task_history')[0], 'insert')[0][0]).toEqual({
        task_id: TASK,
        organization_id: ORG,
        action: 'pull_request_linked',
        field_name: null,
        old_value: null,
        new_value: {
          provider: 'github',
          repository: 'acme/api',
          number: 12,
          title: 'XE-T1 and xe-t2',
          url: 'https://github.com/acme/api/pull/12',
        },
        changed_by: 'user-1',
      });
    });

    it('unlink keeps the row as unlinked (sticky) and writes history', async () => {
      const { service, db } = setup();

      db.queue('tasks', { data: { id: TASK } });
      db.queue('git_pull_request_tasks', { data: [linkRow()] });

      await service.unlink(user, TASK, 'pr-1');

      const chain = db.on('git_pull_request_tasks')[0];

      expect(args(chain, 'update')[0][0]).toMatchObject({
        state: 'unlinked',
        unlinked_by: 'user-1',
      });
      expect(args(chain, 'eq')).toEqual([
        ['organization_id', ORG],
        ['task_id', TASK],
        ['pull_request_id', 'pr-1'],
        ['state', 'linked'],
      ]);
      expect(args(db.on('task_history')[0], 'insert')[0][0]).toMatchObject({
        action: 'pull_request_unlinked',
        new_value: { provider: 'github', repository: 'acme/api', number: 12 },
      });
    });

    it('unlink of something not linked is a 404 and writes no history', async () => {
      const { service, db } = setup();

      db.queue('tasks', { data: { id: TASK } });
      db.queue('git_pull_request_tasks', { data: [] });

      await expect(service.unlink(user, TASK, 'pr-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(db.on('task_history')).toHaveLength(0);
    });

    it('a history failure never fails the link', async () => {
      const { service, db } = setup();

      db.queue('task_history', { error: { message: 'boom' } });

      await expect(
        service.linkManual(user, TASK, 'pr-1', {
          provider: 'github',
          repository: 'acme/api',
          repositoryId: 'repo-1',
          pr: pr(),
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('claimBackfill', () => {
    it('claims only live repositories it wins, with a conditional update', async () => {
      const { service, db } = setup();

      db.queue(
        'git_repositories',
        {
          data: [
            { ...repo({ id: 'a' }), connection: { status: 'active' } },
            { ...repo({ id: 'b' }), connection: { status: 'disconnected' } },
            { ...repo({ id: 'c' }), connection: { status: 'needs_attention' } },
          ],
        },
        { data: [{ id: 'a' }] },
        { data: [] },
      );

      const claimed = await service.claimBackfill(['github']);

      expect(claimed.map((entry) => entry.repository.id)).toEqual(['a']);

      const [list, claimA, claimC] = db.on('git_repositories');

      expect(args(list, 'is')).toEqual([
        ['removed_at', null],
        ['pull_requests_backfilled_at', null],
      ]);
      // Disconnected connections are dropped by the query (inner join), rows waiting to retry too.
      expect(args(list, 'select')[0][0]).toContain('!inner(*)');
      expect(args(list, 'neq')).toEqual([
        ['connection.status', 'disconnected'],
      ]);
      expect(args(list, 'or')[0][0]).toMatch(
        /^pull_requests_backfill_retry_at\.is\.null,pull_requests_backfill_retry_at\.lte\./,
      );
      expect(args(claimA, 'is')).toEqual([
        ['pull_requests_backfilled_at', null],
      ]);
      expect(args(claimC, 'eq')).toContainEqual(['id', 'c']);
    });

    it('gives a failed repository back with a growing delay', async () => {
      const { service, db } = setup();

      db.queue('git_repositories', { data: null });

      const before = Date.now();

      await service.releaseBackfill(
        repo({ id: 'a', pull_requests_backfill_attempts: 2 }),
      );

      const [release] = db.on('git_repositories');
      const patch = args(release, 'update')[0][0] as Record<string, unknown>;

      expect(patch).toMatchObject({
        pull_requests_backfilled_at: null,
        pull_requests_backfill_attempts: 3,
      });
      // Third failure: 5 min * 2^2 = 20 min.
      const delay =
        Date.parse(patch.pull_requests_backfill_retry_at as string) - before;
      expect(delay).toBeGreaterThanOrEqual(20 * 60 * 1000 - 1000);
      expect(delay).toBeLessThanOrEqual(20 * 60 * 1000 + 1000);
    });

    it('caps the retry delay at a day', () => {
      expect(Date.parse(backfillRetryAt(40, 0))).toBe(24 * 60 * 60 * 1000);
      expect(Date.parse(backfillRetryAt(1, 0))).toBe(5 * 60 * 1000);
    });

    it('no configured provider -> nothing claimed, no query', async () => {
      const { service, db } = setup();

      await expect(service.claimBackfill([])).resolves.toEqual([]);
      expect(db.on('git_repositories')).toHaveLength(0);
    });
  });
});

describe('GitPullRequestsService status automation (ticket 8)', () => {
  const actor = { externalId: '7', login: 'dev' };

  describe('sync', () => {
    const syncResult = (overrides: Record<string, unknown> = {}) => ({
      data: {
        pull_request_id: 'pr-1',
        applied: true,
        linked: [],
        removed: [],
        prev_state: null,
        prev_is_draft: null,
        tasks: ['t1'],
        ...overrides,
      },
      error: null,
    });

    it('a new open pull request with an actor → pr_opened for its tasks', async () => {
      const { service, db, automation } = setup();

      db.rpc.mockResolvedValue(syncResult({ linked: ['t1'] }));

      await service.sync(repo(), pr(), actor);

      expect(automation.handle).toHaveBeenCalledTimes(1);
      expect(automation.handle).toHaveBeenCalledWith({
        organizationId: ORG,
        provider: 'github',
        host: 'github.com',
        event: 'pr_opened',
        repositoryId: 'repo-1',
        taskIds: ['t1'],
        subject: {
          kind: 'pull_request',
          number: 12,
          title: 'XE-T1 and xe-t2',
          url: 'https://github.com/acme/api/pull/12',
          pullRequestId: 'pr-1',
        },
        actor,
      });
    });

    it('a delivery that was not applied → no automation', async () => {
      const { service, db, automation } = setup();

      db.rpc.mockResolvedValue(syncResult({ applied: false }));

      await service.sync(repo(), pr(), actor);

      expect(automation.handle).not.toHaveBeenCalled();
    });

    it('without an actor (backfill, manual link) → no automation', async () => {
      const { service, db, automation } = setup();

      db.rpc.mockResolvedValue(syncResult());

      await service.sync(repo(), pr());

      expect(automation.handle).not.toHaveBeenCalled();
    });

    it('merged with two tasks → one call with both task ids', async () => {
      const { service, db, automation } = setup();

      db.rpc.mockResolvedValue(
        syncResult({
          prev_state: 'open',
          prev_is_draft: false,
          tasks: ['t1', 't2'],
        }),
      );

      await service.sync(
        repo(),
        pr({ state: 'merged', mergedAt: '2026-10-19T11:00:00Z' }),
        actor,
      );

      expect(automation.handle).toHaveBeenCalledTimes(1);
      expect(automation.handle).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'pr_merged', taskIds: ['t1', 't2'] }),
      );
    });

    it('a duplicate open delivery → no automation', async () => {
      const { service, db, automation } = setup();

      db.rpc.mockResolvedValue(
        syncResult({ prev_state: 'open', prev_is_draft: false }),
      );

      await service.sync(repo(), pr(), actor);

      expect(automation.handle).not.toHaveBeenCalled();
    });
  });

  describe('syncBranch', () => {
    const web = repo({
      web_url: 'https://github.com/acme/api',
    } as Partial<IGitRepositoryRow>);

    it('with an actor, newly linked tasks → branch_created', async () => {
      const { service, db, automation } = setup();

      db.rpc.mockResolvedValue({ data: { linked: ['t1', 't2'] }, error: null });

      await service.syncBranch(web, 'XE-T5-login', null, false, actor);

      expect(automation.handle).toHaveBeenCalledTimes(1);
      expect(automation.handle).toHaveBeenCalledWith({
        organizationId: ORG,
        provider: 'github',
        host: 'github.com',
        event: 'branch_created',
        repositoryId: 'repo-1',
        taskIds: ['t1', 't2'],
        subject: {
          kind: 'branch',
          title: 'XE-T5-login',
          url: branchUrl(
            'github',
            'https://github.com/acme/api',
            'XE-T5-login',
          ),
        },
        actor,
      });
    });

    it('a deleted branch, no newly linked task, or no actor → no automation', async () => {
      const { service, db, automation } = setup();

      db.rpc
        .mockResolvedValueOnce({ data: { linked: ['t1'] }, error: null })
        .mockResolvedValueOnce({ data: { linked: [] }, error: null })
        .mockResolvedValueOnce({ data: { linked: ['t1'] }, error: null });

      await service.syncBranch(web, 'XE-T5', null, true, actor);
      await service.syncBranch(web, 'XE-T5', null, false, actor);
      await service.syncBranch(web, 'XE-T5', null, false);

      expect(automation.handle).not.toHaveBeenCalled();
    });
  });

  describe('syncCommits', () => {
    const A = 'a'.repeat(40);
    const B = 'b'.repeat(40);
    const commit = (sha: string, message: string): IProviderCommit => ({
      sha,
      message,
      url: `https://github.com/acme/api/commit/${sha}`,
      authorName: 'Dev',
      authorEmail: 'dev@example.com',
      authorLogin: 'dev',
      authoredAt: '2026-10-01T10:00:00Z',
      committedAt: '2026-10-02T10:00:00Z',
    });
    const commits = [
      commit(A.toUpperCase(), 'Fixes XE-T1\n\nbody'),
      commit(B, 'Closes XE-T2'),
    ];
    const reached = {
      data: {
        stored: 2,
        reached_default: [
          { task_id: 't1', sha: A },
          { task_id: 't2', sha: B },
          { task_id: 't3', sha: B },
        ],
      },
      error: null,
    };

    it('with an actor, commit_closes per commit that reached the default branch', async () => {
      const { service, db, automation } = setup();

      db.rpc.mockResolvedValue(reached);

      await service.syncCommits(repo(), 'main', commits, actor);

      expect(automation.handle).toHaveBeenCalledTimes(2);
      expect(automation.handle).toHaveBeenNthCalledWith(1, {
        organizationId: ORG,
        provider: 'github',
        host: 'github.com',
        event: 'commit_closes',
        repositoryId: 'repo-1',
        taskIds: ['t1'],
        subject: {
          kind: 'commit',
          sha: A,
          title: 'Fixes XE-T1',
          url: `https://github.com/acme/api/commit/${A.toUpperCase()}`,
        },
        actor,
      });
      expect(automation.handle).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          taskIds: ['t2', 't3'],
          subject: expect.objectContaining({ sha: B, title: 'Closes XE-T2' }),
        }),
      );
    });

    it('without an actor, or nothing reached the default branch → no automation', async () => {
      const { service, db, automation } = setup();

      db.rpc.mockResolvedValueOnce(reached).mockResolvedValueOnce({
        data: { stored: 2, reached_default: null },
        error: null,
      });

      await service.syncCommits(repo(), 'main', commits);
      await service.syncCommits(repo(), 'main', commits, actor);

      expect(automation.handle).not.toHaveBeenCalled();
    });
  });

  describe('syncBuilds', () => {
    const build = (
      overrides: Partial<IProviderBuild> = {},
    ): IProviderBuild => ({
      externalId: '901',
      workflowKey: 'ci',
      name: 'CI',
      headBranch: 'XE-T1-ci',
      headRepoFullName: null,
      headSha: 'a'.repeat(40),
      state: 'failed',
      attempt: 1,
      url: 'https://github.com/acme/api/actions/runs/901',
      startedAt: '2026-10-20T10:00:00Z',
      completedAt: '2026-10-20T10:05:00Z',
      createdAt: '2026-10-20T10:00:00Z',
      updatedAt: '2026-10-20T10:05:00Z',
      ...overrides,
    });
    const applied = (prev_state: string | null) => ({
      data: { applied: true, build_id: 'b1', prev_state },
      error: null,
    });
    const run = (workflow_key: string, state: string) => ({
      workflow_key,
      state,
      provider_created_at: '2026-10-20T10:00:00Z',
    });
    const rpcNames = (db: ReturnType<typeof makeDb>) =>
      db.rpc.mock.calls.map((call) => call[0] as string);

    it('a run that failed (was running) with the commit failed → build_failed for the tasks', async () => {
      const { service, db, automation } = setup();

      db.queue('git_integration_settings', { data: null });
      db.rpc.mockResolvedValueOnce(applied('running')).mockResolvedValueOnce({
        data: {
          tasks: ['t1', 't2'],
          runs: [run('ci', 'failed'), run('lint', 'passed')],
        },
        error: null,
      });

      await expect(
        service.syncBuilds(repo(), [build()], true, actor),
      ).resolves.toBe(1);

      expect(db.rpc).toHaveBeenNthCalledWith(2, 'git_build_tasks', {
        p_org: ORG,
        p_build_id: 'b1',
      });
      expect(automation.handle).toHaveBeenCalledWith({
        organizationId: ORG,
        provider: 'github',
        host: 'github.com',
        event: 'build_failed',
        repositoryId: 'repo-1',
        taskIds: ['t1', 't2'],
        subject: {
          kind: 'build',
          title: 'CI',
          url: 'https://github.com/acme/api/actions/runs/901',
        },
        actor,
      });
    });

    it('lint passed while CI still runs → no automation', async () => {
      const { service, db, automation } = setup();

      db.queue('git_integration_settings', { data: null });
      db.rpc.mockResolvedValueOnce(applied('running')).mockResolvedValueOnce({
        data: {
          tasks: ['t1'],
          runs: [run('lint', 'passed'), run('ci', 'running')],
        },
        error: null,
      });

      await service.syncBuilds(
        repo(),
        [build({ workflowKey: 'lint', name: 'Lint', state: 'passed' })],
        true,
        actor,
      );

      expect(rpcNames(db)).toEqual(['git_sync_build', 'git_build_tasks']);
      expect(automation.handle).not.toHaveBeenCalled();
    });

    it('state unchanged (redelivery) → git_build_tasks not called', async () => {
      const { service, db, automation } = setup();

      db.queue('git_integration_settings', { data: null });
      db.rpc.mockResolvedValueOnce(applied('failed'));

      await service.syncBuilds(repo(), [build()], true, actor);

      expect(rpcNames(db)).toEqual(['git_sync_build']);
      expect(automation.handle).not.toHaveBeenCalled();
    });

    it('no actor → git_build_tasks not called', async () => {
      const { service, db, automation } = setup();

      db.queue('git_integration_settings', { data: null });
      db.rpc.mockResolvedValueOnce(applied('running'));

      await service.syncBuilds(repo(), [build()], true);

      expect(rpcNames(db)).toEqual(['git_sync_build']);
      expect(automation.handle).not.toHaveBeenCalled();
    });

    it('a run that was not applied → nothing', async () => {
      const { service, db, automation } = setup();

      db.queue('git_integration_settings', { data: null });
      db.rpc.mockResolvedValueOnce({
        data: { applied: false, build_id: 'b1', prev_state: 'running' },
        error: null,
      });

      await expect(
        service.syncBuilds(repo(), [build()], true, actor),
      ).resolves.toBe(0);

      expect(rpcNames(db)).toEqual(['git_sync_build']);
      expect(automation.handle).not.toHaveBeenCalled();
    });
  });
});

describe('GitPullRequestsService activity (ticket 9)', () => {
  const actor = { externalId: '7', login: 'dev' };
  const kinds = (activity: { record: jest.Mock }) =>
    activity.record.mock.calls.map(
      (call) => [call[0].kind, call[0].taskIds] as [string, string[]],
    );

  describe('sync', () => {
    const syncResult = (overrides: Record<string, unknown> = {}) => ({
      data: {
        pull_request_id: 'pr-1',
        applied: true,
        linked: [],
        removed: [],
        prev_state: 'open',
        prev_is_draft: false,
        tasks: ['t1'],
        ...overrides,
      },
      error: null,
    });

    it('newly linked task → one "linked" (no extra "opened"); others get the event; before automation', async () => {
      const { service, db, activity, automation } = setup();
      const order: string[] = [];

      activity.record.mockImplementation(async (a: { kind: string }) => {
        order.push(`activity:${a.kind}`);
      });
      automation.handle.mockImplementation(async (e: { event: string }) => {
        order.push(`automation:${e.event}`);
      });
      db.rpc.mockResolvedValue(
        syncResult({
          prev_state: 'closed',
          linked: ['t2'],
          removed: ['t3'],
          tasks: ['t1', 't2'],
        }),
      );

      await service.sync(repo(), pr(), actor);

      expect(kinds(activity)).toEqual([
        ['pr_linked', ['t2']],
        ['pr_unlinked', ['t3']],
        ['pr_opened', ['t1']],
      ]);
      expect(activity.record.mock.calls[0][0]).toEqual({
        organizationId: ORG,
        provider: 'github',
        host: 'github.com',
        kind: 'pr_linked',
        taskIds: ['t2'],
        subject: {
          kind: 'pull_request',
          number: 12,
          title: 'XE-T1 and xe-t2',
          url: 'https://github.com/acme/api/pull/12',
          pullRequestId: 'pr-1',
          repository: 'acme/api',
        },
        actor,
        repositoryId: 'repo-1',
      });
      // Automation still sees both tasks as opened (ticket 8 unchanged), after the activity.
      expect(order).toEqual([
        'activity:pr_linked',
        'activity:pr_unlinked',
        'activity:pr_opened',
        'automation:pr_opened',
      ]);
      expect(automation.handle).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'pr_opened', taskIds: ['t1', 't2'] }),
      );
    });

    it('merged → pr_merged for the linked tasks', async () => {
      const { service, db, activity } = setup();

      db.rpc.mockResolvedValue(syncResult({ tasks: ['t1', 't2'] }));

      await service.sync(
        repo(),
        pr({ state: 'merged', mergedAt: '2026-10-19T11:00:00Z' }),
        actor,
      );

      expect(kinds(activity)).toEqual([
        ['pr_linked', []],
        ['pr_unlinked', []],
        ['pr_merged', ['t1', 't2']],
      ]);
    });

    it('no actor (import, backfill, manual link) or not applied → no activity', async () => {
      const { service, db, activity } = setup();

      db.rpc
        .mockResolvedValueOnce(syncResult({ linked: ['t1'] }))
        .mockResolvedValueOnce(syncResult({ applied: false, linked: ['t1'] }));

      await service.sync(repo(), pr());
      await service.sync(repo(), pr(), actor);

      expect(activity.record).not.toHaveBeenCalled();
    });
  });

  describe('syncCommits', () => {
    const commit = (n: number): IProviderCommit => ({
      sha: n.toString(16).padStart(40, '0'),
      message: `XE-T1 change ${n}`,
      url: `https://github.com/acme/api/commit/${n}`,
      authorName: 'Dev',
      authorEmail: 'dev@example.com',
      authorLogin: 'dev',
      authoredAt: '2026-10-01T10:00:00Z',
      committedAt: '2026-10-02T10:00:00Z',
    });
    const web = repo({
      web_url: 'https://github.com/acme/api',
    } as Partial<IGitRepositoryRow>);

    it('one "commits linked" per task and push, counted across chunks', async () => {
      const { service, db, activity } = setup();
      const commits = Array.from({ length: 501 }, (_, i) => commit(i + 1));

      db.rpc
        .mockResolvedValueOnce({
          data: {
            stored: 500,
            linked: [
              { commit_id: 'c1', task_id: 't1' },
              { commit_id: 'c2', task_id: 't1' },
              { commit_id: 'c2', task_id: 't2' },
            ],
          },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { stored: 1, linked: [{ commit_id: 'c3', task_id: 't1' }] },
          error: null,
        });

      await service.syncCommits(web, 'XE-T1-work', commits, actor);

      expect(db.rpc).toHaveBeenCalledTimes(2);
      expect(activity.record).toHaveBeenCalledTimes(2);
      expect(activity.record).toHaveBeenNthCalledWith(1, {
        organizationId: ORG,
        provider: 'github',
        host: 'github.com',
        kind: 'commits_linked',
        taskIds: ['t1'],
        subject: {
          kind: 'commit',
          count: 3,
          branch: 'XE-T1-work',
          repository: 'acme/api',
          url: branchUrl('github', 'https://github.com/acme/api', 'XE-T1-work'),
        },
        actor,
        repositoryId: 'repo-1',
      });
      expect(activity.record).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          taskIds: ['t2'],
          subject: expect.objectContaining({ count: 1 }),
        }),
      );
    });

    it('nothing newly linked (re-push, merge to main) or no actor → no activity', async () => {
      const { service, db, activity } = setup();

      db.rpc
        .mockResolvedValueOnce({ data: { stored: 1, linked: [] }, error: null })
        .mockResolvedValueOnce({
          data: { stored: 1, linked: [{ commit_id: 'c1', task_id: 't1' }] },
          error: null,
        });

      await service.syncCommits(web, 'main', [commit(1)], actor);
      await service.syncCommits(web, 'main', [commit(1)]);

      expect(activity.record).not.toHaveBeenCalled();
    });
  });

  describe('syncBuilds', () => {
    const build: IProviderBuild = {
      externalId: '901',
      workflowKey: 'ci',
      name: 'CI',
      headBranch: 'XE-T1-ci',
      headRepoFullName: null,
      headSha: 'A'.repeat(40),
      state: 'passed',
      attempt: 2,
      url: 'https://github.com/acme/api/actions/runs/901',
      startedAt: '2026-10-20T10:00:00Z',
      completedAt: '2026-10-20T10:05:00Z',
      createdAt: '2026-10-20T10:00:00Z',
      updatedAt: '2026-10-20T10:05:00Z',
    };

    it('a passed commit → build_passed with branch and sha (the activity decides "fixed")', async () => {
      const { service, db, activity } = setup();

      db.queue('git_integration_settings', { data: null });
      db.rpc
        .mockResolvedValueOnce({
          data: { applied: true, build_id: 'b1', prev_state: 'running' },
          error: null,
        })
        .mockResolvedValueOnce({
          data: {
            tasks: ['t1'],
            runs: [
              {
                workflow_key: 'ci',
                state: 'passed',
                provider_created_at: '2026-10-20T10:00:00Z',
              },
            ],
          },
          error: null,
        });

      await service.syncBuilds(repo(), [build], true, actor);

      expect(activity.record).toHaveBeenCalledWith({
        organizationId: ORG,
        provider: 'github',
        host: 'github.com',
        kind: 'build_passed',
        taskIds: ['t1'],
        subject: {
          kind: 'build',
          title: 'CI',
          url: 'https://github.com/acme/api/actions/runs/901',
          sha: 'a'.repeat(40),
          branch: 'XE-T1-ci',
          repository: 'acme/api',
        },
        actor,
        repositoryId: 'repo-1',
      });
    });
  });

  describe('linkManual', () => {
    it('asks for the "linked" notification as the person, without a second History row', async () => {
      const { service, db, activity } = setup();

      await service.linkManual(user, TASK, 'pr-1', {
        provider: 'github',
        repository: 'acme/api',
        repositoryId: 'repo-1',
        pr: pr(),
      });

      expect(db.on('task_history')).toHaveLength(1);
      expect(activity.record).toHaveBeenCalledWith({
        organizationId: ORG,
        provider: 'github',
        kind: 'pr_linked',
        repositoryId: 'repo-1',
        taskIds: [TASK],
        subject: {
          kind: 'pull_request',
          number: 12,
          title: 'XE-T1 and xe-t2',
          url: 'https://github.com/acme/api/pull/12',
          pullRequestId: 'pr-1',
          repository: 'acme/api',
        },
        actor: { externalId: null, login: null },
        manualBy: 'user-1',
      });
    });
  });
});

describe('mapToServerHost (ticket 11)', () => {
  const servers = [
    {
      host: 'company.com',
      base_url: 'https://company.com/gitlab',
      previous_base_urls: [],
    },
    {
      host: 'gitlab.old.local',
      base_url: 'https://gitlab.new.local',
      previous_base_urls: ['https://gitlab.old.local'],
    },
    {
      host: 'git.co',
      base_url: 'https://git.co',
      previous_base_urls: [],
    },
  ];

  it('strips a GitLab relative root and keeps the server host key', () => {
    const mapped = mapToServerHost(
      ' https://company.com/gitlab/grp/app/-/merge_requests/3#note_1 ',
      servers,
    );

    expect(mapped).toBe(
      'https://company.com/grp/app/-/merge_requests/3#note_1',
    );
    expect(parsePullRequestUrl(mapped!)).toEqual({
      provider: 'gitlab',
      host: 'company.com',
      fullName: 'grp/app',
      number: 3,
    });
  });

  it('maps the current and an old address to the stable key', () => {
    expect(
      mapToServerHost(
        'https://gitlab.new.local/g/p/-/merge_requests/1',
        servers,
      ),
    ).toBe('https://gitlab.old.local/g/p/-/merge_requests/1');
    expect(
      mapToServerHost(
        'https://GITLAB.old.local/g/p/-/merge_requests/1',
        servers,
      ),
    ).toBe('https://gitlab.old.local/g/p/-/merge_requests/1');
  });

  it('a lookalike prefix never matches; built-in hosts stay unmapped', () => {
    expect(
      mapToServerHost('https://git.company.com/a/b/pull/1', servers),
    ).toBeNull();
    expect(
      mapToServerHost(
        'https://company.com/gitlabx/a/-/merge_requests/1',
        servers,
      ),
    ).toBeNull();
    expect(
      mapToServerHost('https://github.com/a/b/pull/1', servers),
    ).toBeNull();
    expect(mapToServerHost('https://git.co/a/b/pull/1', servers)).toBe(
      'https://git.co/a/b/pull/1',
    );
  });

  it('the longest matching address wins', () => {
    expect(
      mapToServerHost('https://company.com/gitlab/g/p/-/merge_requests/1', [
        {
          host: 'root.key',
          base_url: 'https://company.com',
          previous_base_urls: [],
        },
        ...servers,
      ]),
    ).toBe('https://company.com/g/p/-/merge_requests/1');
  });
});
