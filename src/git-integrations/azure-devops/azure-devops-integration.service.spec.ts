/**
 * @fileoverview Unit tests for the Azure DevOps half of the Git integrations. The core service and the
 * client are jest.fn objects; the Supabase admin client is a recording builder whose results come from a
 * per-test handler, as in the GitLab spec.
 * @module src/git-integrations/azure-devops/azure-devops-integration.service.spec
 */

import {
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';

import { createState } from '../../calendar/integrations/calendar-oauth.state';
import { encryptApiKey } from '../../lib/crypto/encryption';
import type {
  IGitConnectionRow,
  IGitRepositoryRow,
} from '../git-integrations.types';
import { pkceVerifier, stateProviderTag } from '../git-integrations.util';
import { AzureDevopsApiError } from './azure-devops.client';
import {
  AZURE_HOOK_EVENTS,
  AzureDevopsIntegrationService,
  buildFromAzure,
  buildStateFromAzure,
  commitFromAzure,
  pullRequestFromAzure,
  repositoryFromAzure,
  reviewsFromAzure,
  type IAzureRepository,
} from './azure-devops-integration.service';

process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = 'user-1';
const CONN_ID = '22222222-2222-2222-2222-222222222222';
const HOOK_ID = '33333333-3333-3333-3333-333333333333';
const ACCOUNT = '44444444-4444-4444-4444-444444444444';
const REPO_GUID = '55555555-5555-5555-5555-555555555555';
const PROJECT = '66666666-6666-6666-6666-666666666666';
const SHA = 'a'.repeat(40);
const PASSWORD = 'p'.repeat(64);

type Op = [string, ...unknown[]];
interface ICall {
  table: string;
  ops: Op[];
}
type Result = { data?: unknown; error?: { message: string } | null };

function makeDb(handler: (call: ICall) => Result = () => ({})) {
  const calls: ICall[] = [];
  const from = (table: string) => {
    const call: ICall = { table, ops: [] };

    calls.push(call);

    const resolve = () =>
      Promise.resolve({ data: null, error: null, ...handler(call) });
    const builder: unknown = new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'then')
            return (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
              resolve().then(f, r);
          if (prop === 'maybeSingle' || prop === 'single')
            return () => resolve();

          return (...args: unknown[]) => {
            call.ops.push([prop, ...args]);

            return builder;
          };
        },
      },
    );

    return builder;
  };

  return { client: { from }, calls };
}

const op = (call: ICall, name: string) => call.ops.find(([n]) => n === name);
const eq = (call: ICall, column: string, value: unknown) =>
  call.ops.some(([n, c, v]) => n === 'eq' && c === column && v === value);

function conn(overrides: Partial<IGitConnectionRow> = {}): IGitConnectionRow {
  return {
    id: CONN_ID,
    organization_id: ORG,
    provider: 'azure_devops',
    host: 'dev.azure.com',
    external_account_id: ACCOUNT,
    installation_id: null,
    account_login: 'acme',
    account_name: 'acme',
    account_type: 'Organization',
    avatar_url: null,
    account_url: null,
    credential_id: 'cred-1',
    repository_selection: 'all',
    status: 'active',
    status_reason: null,
    status_changed_at: '',
    created_by: USER,
    disconnected_by: null,
    disconnected_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function repo(overrides: Partial<IGitRepositoryRow> = {}): IGitRepositoryRow {
  return {
    id: 'repo-1',
    organization_id: ORG,
    connection_id: CONN_ID,
    provider: 'azure_devops',
    host: 'dev.azure.com',
    external_id: REPO_GUID,
    full_name: 'acme/My Project/My Repo',
    web_url: 'https://dev.azure.com/acme/My%20Project/_git/My%20Repo',
    default_branch: 'main',
    is_private: true,
    is_archived: false,
    is_enabled: true,
    removed_at: null,
    webhook_id: null,
    webhook_secret_encrypted: null,
    webhook_secret_iv: null,
    webhook_secret_tag: null,
    webhook_error: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function hookRow(overrides: Record<string, unknown> = {}) {
  const secret = encryptApiKey(PASSWORD);

  return {
    id: HOOK_ID,
    organization_id: ORG,
    connection_id: CONN_ID,
    project_external_id: PROJECT,
    subscription_ids: {},
    webhook_secret_encrypted: secret.encrypted,
    webhook_secret_iv: secret.iv,
    webhook_secret_tag: secret.tag,
    error: null,
    ...overrides,
  };
}

function credential(overrides: Record<string, unknown> = {}) {
  const tokens = encryptApiKey(
    JSON.stringify({ access_token: 'at', refresh_token: 'rt' }),
  );

  return {
    id: 'cred-1',
    organization_id: ORG,
    provider: 'azure_devops',
    host: 'dev.azure.com',
    external_user_id: 'me',
    external_login: 'me@acme.com',
    encrypted_secret: tokens.encrypted,
    encryption_iv: tokens.iv,
    encryption_tag: tokens.tag,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    refresh_lease_until: null,
    status: 'active',
    created_by: USER,
    created_at: '',
    ...overrides,
  };
}

const remoteRepo = (
  id = REPO_GUID,
  project = PROJECT,
  overrides: Partial<IAzureRepository> = {},
): IAzureRepository => ({
  id,
  name: 'My Repo',
  webUrl: 'https://dev.azure.com/acme/My%20Project/_git/My%20Repo',
  defaultBranch: 'refs/heads/main',
  project: { id: project, name: 'My Project', visibility: 'private' },
  ...overrides,
});

const basic = (password: string) =>
  `Basic ${Buffer.from(`xisuite:${password}`).toString('base64')}`;

function setup(handler?: (call: ICall) => Result) {
  const db = makeDb(
    handler ??
      ((call) =>
        call.table === 'git_credentials' && op(call, 'select')
          ? { data: credential() }
          : {}),
  );
  const core = {
    isOrgAdmin: jest.fn().mockResolvedValue(true),
    getConnection: jest.fn().mockResolvedValue(conn()),
    listConnections: jest.fn().mockResolvedValue([]),
    listAllLive: jest.fn().mockResolvedValue([]),
    upsertConnection: jest.fn().mockResolvedValue({ connection: conn() }),
    updateAccountDetails: jest.fn().mockResolvedValue(undefined),
    setCredential: jest.fn().mockResolvedValue(undefined),
    setStatus: jest.fn().mockResolvedValue(true),
    listRepositories: jest.fn().mockResolvedValue([]),
    upsertRepositories: jest.fn().mockResolvedValue(undefined),
    updateRepositoryWebhook: jest.fn().mockResolvedValue(undefined),
    findRepository: jest.fn().mockResolvedValue(repo()),
    recordDelivery: jest.fn().mockResolvedValue(true),
    setDeliveryOutcome: jest.fn().mockResolvedValue(undefined),
    forgetDelivery: jest.fn().mockResolvedValue(undefined),
  };
  const client = {
    authorizeUrl: jest.fn().mockReturnValue('https://login/authorize'),
    exchangeCode: jest.fn().mockResolvedValue({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }),
    refresh: jest.fn(),
    profile: jest
      .fn()
      .mockResolvedValue({ id: 'me', emailAddress: 'Me@Acme.com' }),
    accounts: jest
      .fn()
      .mockResolvedValue([{ accountId: ACCOUNT, accountName: 'acme' }]),
    org: jest.fn(),
    orgPage: jest.fn(),
  };
  const pullRequests = {
    sync: jest.fn().mockResolvedValue({ applied: true }),
    syncBranch: jest.fn().mockResolvedValue(undefined),
    commitLinkingEnabled: jest.fn().mockResolvedValue(false),
    syncCommits: jest.fn().mockResolvedValue(0),
    syncBuilds: jest.fn().mockResolvedValue(0),
  };
  const servers = {
    builtinApp: jest.fn().mockReturnValue({
      serverId: null,
      provider: 'azure_devops',
      host: 'dev.azure.com',
      webUrl: 'https://dev.azure.com',
      apiUrl: 'https://dev.azure.com',
      clientId: 'cid',
      clientSecret: 'secret',
    }),
    isBuiltinConfigured: jest.fn().mockReturnValue(true),
    publicApiUrl: 'https://api.example.com/api/v1',
  };
  const svc = new AzureDevopsIntegrationService(
    core as never,
    client as never,
    { getClient: () => db.client } as never,
    pullRequests as never,
    servers as never,
  );

  svc.delay = () => Promise.resolve();

  return { svc, core, client, pullRequests, servers, db };
}

/** Hook row for HOOKS reads, credential for credential reads. */
const withHook =
  (hook: unknown = hookRow()) =>
  (call: ICall): Result => {
    if (call.table === 'git_azure_project_hooks' && op(call, 'select'))
      return { data: hook };
    if (call.table === 'git_credentials' && op(call, 'select'))
      return { data: credential() };

    return {};
  };

const delivery = (body: unknown) => ({
  hookId: HOOK_ID,
  authorization: basic(PASSWORD),
  rawBody: Buffer.from(JSON.stringify(body)),
});

const prEvent = (type = 'git.pullrequest.updated') => ({
  id: 'evt-1',
  eventType: type,
  resource: {
    pullRequestId: 7,
    // What a forged delivery would say: it must never reach storage.
    title: 'FORGED',
    repository: { id: REPO_GUID },
  },
});

const apiPr = (overrides: Record<string, unknown> = {}) => ({
  pullRequestId: 7,
  title: 'Real title',
  description: 'XE-T1',
  status: 'active',
  isDraft: false,
  sourceRefName: 'refs/heads/feature/XE-T1',
  targetRefName: 'refs/heads/main',
  createdBy: { id: 'author', uniqueName: 'Author@Acme.com' },
  creationDate: '2026-01-01T00:00:00Z',
  reviewers: [],
  lastMergeSourceCommit: { commitId: SHA },
  ...overrides,
});

describe('normalising', () => {
  const repository = repo();

  it.each([
    ['active', 'open'],
    ['completed', 'merged'],
    ['abandoned', 'closed'],
    ['notSet', 'open'],
  ])('pull request status %s is %s', (status, state) => {
    expect(
      pullRequestFromAzure({ pullRequestId: 1, status }, repository).state,
    ).toBe(state);
  });

  it('maps a merged pull request', () => {
    const pr = pullRequestFromAzure(
      {
        pullRequestId: 7,
        title: 'T',
        description: 'XE-T1',
        status: 'completed',
        isDraft: false,
        sourceRefName: 'refs/heads/feature/XE-T1',
        targetRefName: 'refs/heads/main',
        createdBy: {
          id: 'author',
          uniqueName: 'Author@Acme.com',
        },
        creationDate: '2026-01-01T00:00:00Z',
        closedDate: '2026-01-02T00:00:00Z',
        lastMergeSourceCommit: { commitId: SHA },
        lastMergeCommit: { commitId: 'b'.repeat(40) },
      },
      repository,
    );

    expect(pr).toMatchObject({
      number: 7,
      state: 'merged',
      sourceBranch: 'feature/XE-T1',
      targetBranch: 'main',
      url: 'https://dev.azure.com/acme/My%20Project/_git/My%20Repo/pullrequest/7',
      author: {
        externalId: 'author',
        login: 'author@acme.com',
        avatarUrl: null,
      },
      mergedAt: '2026-01-02T00:00:00.000Z',
      closedAt: '2026-01-02T00:00:00.000Z',
      mergeCommitShas: ['b'.repeat(40)],
      headSha: SHA,
    });
  });

  it('gives an abandoned pull request no merge time or commit', () => {
    const pr = pullRequestFromAzure(
      {
        pullRequestId: 7,
        status: 'abandoned',
        closedDate: '2026-01-02T00:00:00Z',
        lastMergeCommit: { commitId: 'b'.repeat(40) },
      },
      repository,
    );

    expect(pr.mergedAt).toBeNull();
    expect(pr.closedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(pr.mergeCommitShas).toEqual([]);
  });

  it('uses the time of the read as the update time, so it always orders after what is stored', () => {
    const before = Date.now();
    const pr = pullRequestFromAzure({ pullRequestId: 1 }, repository);

    expect(Date.parse(pr.updatedAt)).toBeGreaterThanOrEqual(before);
  });

  it('keeps a draft and a fork', () => {
    expect(
      pullRequestFromAzure(
        {
          pullRequestId: 1,
          isDraft: true,
          forkSource: { repository: { name: 'fork' } },
        },
        repository,
      ),
    ).toMatchObject({ isDraft: true, headRepoFullName: 'fork' });
  });

  it('builds addresses without a stored web address', () => {
    expect(
      pullRequestFromAzure({ pullRequestId: 7 }, repo({ web_url: null })).url,
    ).toBe(
      'https://dev.azure.com/acme/My%20Project/_git/My%20Repo/pullrequest/7',
    );
  });

  it('turns votes into verdicts; groups, decliners and no vote have none', () => {
    expect(
      reviewsFromAzure([
        { id: 'a', uniqueName: 'A@x.com', vote: 10 },
        { id: 'b', vote: 5 },
        { id: 'c', vote: -5 },
        { id: 'd', vote: -10 },
        { id: 'e', vote: 0 },
        { id: 'f', vote: 10, isContainer: true },
        { id: 'g', vote: -10, hasDeclined: true },
        { vote: 10 },
      ]),
    ).toEqual([
      {
        reviewerId: 'a',
        login: 'a@x.com',
        state: 'approved',
        submittedAt: null,
      },
      { reviewerId: 'b', login: null, state: 'approved', submittedAt: null },
      {
        reviewerId: 'c',
        login: null,
        state: 'changes_requested',
        submittedAt: null,
      },
      {
        reviewerId: 'd',
        login: null,
        state: 'changes_requested',
        submittedAt: null,
      },
    ]);
  });

  it.each([
    ['completed', 'succeeded', 'passed'],
    ['completed', 'partiallySucceeded', 'passed'],
    ['completed', 'failed', 'failed'],
    ['completed', 'canceled', 'cancelled'],
    ['inProgress', null, 'running'],
    ['cancelling', null, 'running'],
    ['notStarted', null, 'queued'],
    ['postponed', null, 'queued'],
  ])('build %s / %s is %s', (status, result, state) => {
    expect(buildStateFromAzure(status, result)).toBe(state);
  });

  it('takes branch and head commit of a pull request build from triggerInfo', () => {
    const build = buildFromAzure(
      {
        id: 9,
        status: 'completed',
        result: 'succeeded',
        sourceBranch: 'refs/pull/7/merge',
        sourceVersion: 'c'.repeat(40),
        definition: { id: 3, name: 'CI' },
        triggerInfo: {
          'pr.sourceBranch': 'refs/heads/feature/XE-T1',
          'pr.sourceSha': SHA,
        },
      },
      repository,
    );

    expect(build).toMatchObject({
      externalId: '9',
      workflowKey: '3',
      name: 'CI',
      headBranch: 'feature/XE-T1',
      headSha: SHA,
      state: 'passed',
    });
  });

  it('a pull request build without triggerInfo has no branch rather than a wrong one', () => {
    expect(
      buildFromAzure(
        {
          id: 9,
          sourceBranch: 'refs/pull/7/merge',
          sourceVersion: SHA,
          definition: { id: 3 },
        },
        repository,
      )?.headBranch,
    ).toBeNull();
  });

  it('refuses a build the columns would reject', () => {
    expect(
      buildFromAzure(
        { id: 9, sourceVersion: 'not-a-sha', definition: { id: 3 } },
        repository,
      ),
    ).toBeNull();
    expect(
      buildFromAzure({ id: 9, sourceVersion: SHA }, repository),
    ).toBeNull();
  });

  it("prefers Azure's own build address and falls back to the project", () => {
    const base = { id: 9, sourceVersion: SHA, definition: { id: 3 } };

    expect(
      buildFromAzure(
        { ...base, _links: { web: { href: 'https://x/_build/results' } } },
        repository,
      )?.url,
    ).toBe('https://x/_build/results');
    expect(buildFromAzure(base, repository)?.url).toBe(
      'https://dev.azure.com/acme/My%20Project/_build/results?buildId=9',
    );
  });

  it('maps a commit with its dates and no login', () => {
    expect(
      commitFromAzure(
        {
          commitId: SHA,
          comment: 'XE-T1 fix',
          author: { name: 'A', email: 'a@x.com', date: '2026-01-01T00:00:00Z' },
          committer: { date: '2026-01-02T00:00:00Z' },
        },
        repository,
      ),
    ).toEqual({
      sha: SHA,
      message: 'XE-T1 fix',
      url: `https://dev.azure.com/acme/My%20Project/_git/My%20Repo/commit/${SHA}`,
      authorName: 'A',
      authorEmail: 'a@x.com',
      authorLogin: null,
      authoredAt: '2026-01-01T00:00:00.000Z',
      committedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(commitFromAzure({}, repository)).toBeNull();
  });

  it('names a repository organization/project/repository, decoded', () => {
    expect(repositoryFromAzure('acme', remoteRepo())).toEqual({
      externalId: REPO_GUID,
      fullName: 'acme/My Project/My Repo',
      webUrl: 'https://dev.azure.com/acme/My%20Project/_git/My%20Repo',
      defaultBranch: 'main',
      isPrivate: true,
      isArchived: false,
    });
  });

  it('accepts an empty repository without a default branch, and public projects', () => {
    expect(
      repositoryFromAzure(
        'acme',
        remoteRepo(REPO_GUID, PROJECT, {
          defaultBranch: undefined,
          project: { id: PROJECT, name: 'P', visibility: 'public' },
        }),
      ),
    ).toMatchObject({ defaultBranch: null, isPrivate: false });
  });
});

describe('AzureDevopsIntegrationService', () => {
  describe('connect', () => {
    it('refuses to start when the app is not configured', async () => {
      const { svc, servers } = setup();

      servers.builtinApp.mockReturnValue({
        provider: 'azure_devops',
        serverId: null,
      });

      await expect(svc.connectUrl(USER, ORG, undefined)).rejects.toThrow(
        'not_configured',
      );
    });

    const state = (connectionId?: string) =>
      createState(
        USER,
        ORG,
        stateProviderTag('azure_devops', connectionId),
        'http://localhost:3000',
      );

    it('stores the sign-in with a verifier derived from the state, then sends the admin to the picker', async () => {
      const { svc, client, db } = setup((call) =>
        op(call, 'insert') ? { data: { id: 'cred-9' } } : {},
      );
      const signed = state();
      const url = await svc.handleCallback({ code: 'c', state: signed });

      expect(url).toContain('credential=cred-9');
      expect(url).toContain('integration=azure_devops');
      expect(client.exchangeCode.mock.calls[0][1].codeVerifier).toBe(
        pkceVerifier(signed),
      );

      const insert = db.calls.find((call) => op(call, 'insert'))!;

      expect(op(insert, 'insert')![1]).toMatchObject({
        organization_id: ORG,
        provider: 'azure_devops',
        host: 'dev.azure.com',
        external_user_id: 'me',
        external_login: 'me@acme.com',
        created_by: USER,
      });
      expect(JSON.stringify(op(insert, 'insert'))).not.toContain('"at"');
    });

    it.each([
      [
        'a state for GitLab',
        () => createState(USER, ORG, stateProviderTag('gitlab'), undefined),
      ],
      ['a forged state', () => 'forged'],
    ])('rejects %s', async (_name, make) => {
      const { svc, client } = setup();

      expect(await svc.handleCallback({ code: 'c', state: make() })).toContain(
        'error=expired',
      );
      expect(client.exchangeCode).not.toHaveBeenCalled();
    });

    it('refuses someone who is no longer an admin', async () => {
      const { svc, core, client } = setup();

      core.isOrgAdmin.mockResolvedValue(false);

      expect(await svc.handleCallback({ code: 'c', state: state() })).toContain(
        'error=forbidden',
      );
      expect(client.exchangeCode).not.toHaveBeenCalled();
    });

    it("passes on Microsoft's error, e.g. a tenant that needs admin consent", async () => {
      const { svc } = setup();

      expect(
        await svc.handleCallback({ error: 'access_denied', state: state() }),
      ).toContain('error=access_denied');
    });

    it('reports a failed code exchange', async () => {
      const { svc, client } = setup();

      client.exchangeCode.mockRejectedValue(new Error('boom'));

      expect(await svc.handleCallback({ code: 'c', state: state() })).toContain(
        'error=exchange_failed',
      );
    });

    it('a reconnect must reach the organization, and stores nothing otherwise', async () => {
      const { svc, client, db } = setup();

      client.accounts.mockResolvedValue([
        { accountId: 'other', accountName: 'other' },
      ]);

      expect(
        await svc.handleCallback({ code: 'c', state: state(CONN_ID) }),
      ).toContain('error=organization_not_accessible');
      expect(db.calls.some((call) => op(call, 'insert'))).toBe(false);
    });

    it('a reconnect replaces the credential, restores the status and imports again', async () => {
      const { svc, core, client, db } = setup((call) => {
        if (op(call, 'insert')) return { data: { id: 'cred-new' } };
        if (call.table === 'git_credentials') return { data: credential() };
        if (call.table === 'git_azure_project_hooks') return { data: [] };

        return {};
      });

      core.getConnection.mockResolvedValue(
        conn({
          status: 'needs_attention',
          status_reason: 'authorization_expired',
        }),
      );
      core.listRepositories.mockResolvedValue([repo()]);
      client.org.mockResolvedValue({ value: [] });

      expect(
        await svc.handleCallback({ code: 'c', state: state(CONN_ID) }),
      ).toContain('connected=azure_devops');
      expect(core.setCredential).toHaveBeenCalledWith(
        expect.objectContaining({ id: CONN_ID }),
        'cred-new',
        USER,
      );
      expect(core.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: CONN_ID }),
        'active',
        'authorization_expired',
        USER,
      );

      const reset = db.calls.find(
        (call) =>
          call.table === 'git_repositories' &&
          (op(call, 'update')?.[1] as Record<string, unknown>)
            ?.pull_requests_backfilled_at === null,
      );

      expect(reset).toBeDefined();
      expect(eq(reset!, 'organization_id', ORG)).toBe(true);
    });

    const user = { userId: USER, organizationId: ORG } as never;

    it('lists organizations with a search, marking connected ones', async () => {
      const { svc, core, client } = setup();

      client.accounts.mockResolvedValue([
        { accountId: ACCOUNT, accountName: 'zeta' },
        { accountId: 'b', accountName: 'Acme' },
        { accountId: 'c', accountName: 'other' },
      ]);
      core.listConnections.mockResolvedValue([conn()]);

      await expect(svc.listOrganizations(user, 'cred-1')).resolves.toEqual([
        { id: 'b', name: 'Acme', alreadyConnected: false },
        { id: 'c', name: 'other', alreadyConnected: false },
        { id: ACCOUNT, name: 'zeta', alreadyConnected: true },
      ]);
      await expect(
        svc.listOrganizations(user, 'cred-1', ' ACM '),
      ).resolves.toEqual([{ id: 'b', name: 'Acme', alreadyConnected: false }]);
    });

    it('only uses an Azure credential of the same user and organization', async () => {
      const { svc, db } = setup((call) =>
        call.table === 'git_credentials' ? { data: null } : {},
      );

      await expect(svc.listOrganizations(user, 'cred-1')).rejects.toThrow(
        NotFoundException,
      );

      const read = db.calls.find((call) => call.table === 'git_credentials')!;

      expect(eq(read, 'organization_id', ORG)).toBe(true);
      expect(eq(read, 'created_by', USER)).toBe(true);
      expect(eq(read, 'provider', 'azure_devops')).toBe(true);
    });

    it('connects only an organization the person really has', async () => {
      const { svc, core } = setup();

      await expect(
        svc.connectOrganization(user, 'cred-1', 'someone-elses'),
      ).rejects.toThrow('organization_not_accessible');
      expect(core.upsertConnection).not.toHaveBeenCalled();
    });

    it('keeps the connection when the first sync fails', async () => {
      const { svc, core, client } = setup();

      client.org.mockRejectedValue(new AzureDevopsApiError(500, 'down'));

      await expect(
        svc.connectOrganization(user, 'cred-1', ACCOUNT),
      ).resolves.toMatchObject({ id: CONN_ID });
      expect(core.upsertConnection.mock.calls[0][0]).toMatchObject({
        provider: 'azure_devops',
        host: 'dev.azure.com',
        account: {
          externalAccountId: ACCOUNT,
          login: 'acme',
          url: 'https://dev.azure.com/acme',
        },
      });
    });
  });

  describe('subscriptions', () => {
    function forReconcile(hooks: unknown[], subscriptions: unknown[] = []) {
      const context = setup((call) => {
        if (call.table === 'git_azure_project_hooks') {
          if (op(call, 'insert')) return { data: hookRow() };
          if (op(call, 'select')) return { data: hooks };
        }

        if (call.table === 'git_credentials') return { data: credential() };

        return {};
      });

      context.core.listRepositories.mockResolvedValue([repo()]);
      context.client.org.mockImplementation(
        async (
          _org: string,
          path: string,
          _t: string,
          opts?: { method?: string },
        ) => {
          if (path === '/_apis/git/repositories')
            return { value: [remoteRepo()] };
          if (path === '/_apis/hooks/subscriptions' && opts?.method === 'POST')
            return { id: `sub-${context.client.org.mock.calls.length}` };
          if (path === '/_apis/hooks/subscriptions')
            return { value: subscriptions };

          return undefined;
        },
      );

      return context;
    }

    const creates = (client: { org: jest.Mock }) =>
      client.org.mock.calls.filter(([, , , o]) => o?.method === 'POST');
    const deletes = (client: { org: jest.Mock }) =>
      client.org.mock.calls.filter(([, , , o]) => o?.method === 'DELETE');
    const resets = (db: { calls: ICall[] }) =>
      db.calls.filter(
        (call) =>
          call.table === 'git_repositories' &&
          (op(call, 'update')?.[1] as Record<string, unknown>)
            ?.pull_requests_backfilled_at === null,
      );

    it('creates one subscription per event for a project, with the password and our address', async () => {
      const { svc, client, db } = forReconcile([]);

      await svc.applyRepositorySelection(conn());

      expect(creates(client)).toHaveLength(AZURE_HOOK_EVENTS.length);

      const body = creates(client)[0][3].body;

      expect(body).toMatchObject({
        publisherId: 'tfs',
        consumerId: 'webHooks',
        consumerActionId: 'httpRequest',
        publisherInputs: { projectId: PROJECT },
        consumerInputs: {
          url: `https://api.example.com/api/v1/git-integrations/azure_devops/webhook/${HOOK_ID}`,
          basicAuthUsername: 'xisuite',
          basicAuthPassword: PASSWORD,
        },
      });
      expect(creates(client).map(([, , , o]) => o.body.eventType)).toEqual([
        ...AZURE_HOOK_EVENTS,
      ]);

      const insert = db.calls.find(
        (call) =>
          call.table === 'git_azure_project_hooks' && op(call, 'insert'),
      )!;

      expect(op(insert, 'insert')![1]).toMatchObject({
        organization_id: ORG,
        connection_id: CONN_ID,
        project_external_id: PROJECT,
      });
      // A first connection has nothing to recover: its import has not run yet.
      expect(resets(db)).toHaveLength(0);
    });

    const allIds = Object.fromEntries(
      AZURE_HOOK_EVENTS.map((event) => [event, `sub-${event}`]),
    );
    const HOOK_URL = `https://api.example.com/api/v1/git-integrations/azure_devops/webhook/${HOOK_ID}`;
    const enabled = AZURE_HOOK_EVENTS.map((event) => ({
      id: `sub-${event}`,
      eventType: event,
      status: 'enabled',
      consumerInputs: { url: HOOK_URL },
    }));

    it('changes nothing when everything is enabled', async () => {
      const { svc, client, db } = forReconcile(
        [hookRow({ subscription_ids: allIds })],
        enabled,
      );

      await svc.applyRepositorySelection(conn());

      expect(creates(client)).toHaveLength(0);
      expect(deletes(client)).toHaveLength(0);
      expect(resets(db)).toHaveLength(0);
    });

    it.each([
      ['disabledBySystem'],
      ['disabledByInactiveIdentity'],
      ['onProbation'],
    ])(
      'replaces a %s subscription and imports again, which recovers lost events',
      async (status) => {
        const { svc, client, db } = forReconcile(
          [hookRow({ subscription_ids: allIds })],
          enabled.map((row, index) => (index ? row : { ...row, status })),
        );

        await svc.applyRepositorySelection(conn());

        expect(deletes(client)).toHaveLength(1);
        expect(creates(client)).toHaveLength(1);
        expect(creates(client)[0][3].body.eventType).toBe(AZURE_HOOK_EVENTS[0]);
        expect(resets(db)).toHaveLength(1);
      },
    );

    it('sends only inputs Azure accepts: it refuses empty values with a 400', async () => {
      const { svc, client } = forReconcile([]);

      await svc.applyRepositorySelection(conn());

      for (const [, , , options] of creates(client))
        for (const value of Object.values(
          options.body.consumerInputs as Record<string, string>,
        ))
          expect(value).not.toBe('');
    });

    it('replaces a subscription still enabled at an old address, after PUBLIC_API_URL changed', async () => {
      const { svc, client, db } = forReconcile(
        [hookRow({ subscription_ids: allIds })],
        enabled.map((row, index) =>
          index
            ? row
            : { ...row, consumerInputs: { url: 'https://old.example.com/x' } },
        ),
      );

      await svc.applyRepositorySelection(conn());

      expect(deletes(client).map(([, path]) => path)).toEqual([
        `/_apis/hooks/subscriptions/sub-${AZURE_HOOK_EVENTS[0]}`,
      ]);
      expect(creates(client)).toHaveLength(1);
      expect(creates(client)[0][3].body.consumerInputs.url).toBe(HOOK_URL);
      expect(resets(db)).toHaveLength(1);
    });

    it('removes a duplicate and loses nothing, since Azure allows the same subscription twice', async () => {
      const { svc, client, db } = forReconcile(
        [hookRow({ subscription_ids: allIds })],
        [...enabled, { ...enabled[0], id: 'duplicate' }],
      );

      await svc.applyRepositorySelection(conn());

      expect(deletes(client).map(([, path]) => path)).toEqual([
        '/_apis/hooks/subscriptions/duplicate',
      ]);
      expect(creates(client)).toHaveLength(0);
      expect(resets(db)).toHaveLength(0);
    });

    it('adopts a subscription created just before a crash instead of creating it again', async () => {
      const { svc, client, db } = forReconcile([hookRow()], enabled);

      await svc.applyRepositorySelection(conn());

      expect(creates(client)).toHaveLength(0);
      expect(resets(db)).toHaveLength(0);

      const saved = db.calls.find(
        (call) =>
          call.table === 'git_azure_project_hooks' && op(call, 'update'),
      )!;

      expect(op(saved, 'update')![1]).toMatchObject({
        subscription_ids: allIds,
        error: null,
      });
    });

    it('never touches a subscription of someone else in the same project', async () => {
      const { svc, client } = forReconcile(
        [hookRow({ subscription_ids: allIds })],
        [
          ...enabled,
          {
            id: 'theirs',
            eventType: 'git.push',
            status: 'disabledBySystem',
            consumerInputs: { url: 'https://teams.example.com/hook' },
          },
        ],
      );

      await svc.applyRepositorySelection(conn());

      expect(deletes(client)).toHaveLength(0);
    });

    it('recreates a subscription someone deleted in Azure', async () => {
      const { svc, client, db } = forReconcile(
        [hookRow({ subscription_ids: allIds })],
        enabled.slice(1),
      );

      await svc.applyRepositorySelection(conn());

      expect(creates(client)).toHaveLength(1);
      expect(resets(db)).toHaveLength(1);
    });

    it('shows a failed project on its repositories and carries on with the next project', async () => {
      const second = '77777777-7777-7777-7777-777777777777';
      const { svc, client, core } = forReconcile([]);
      const other = repo({ id: 'repo-2', external_id: 'guid-2' });

      core.listRepositories.mockResolvedValue([repo(), other]);
      client.org.mockImplementation(
        async (
          _org: string,
          path: string,
          _t: string,
          opts?: {
            method?: string;
            body?: { publisherInputs: { projectId: string } };
          },
        ) => {
          if (path === '/_apis/git/repositories')
            return {
              value: [remoteRepo(), remoteRepo('guid-2', second)],
            };
          if (opts?.method === 'POST') {
            throw new AzureDevopsApiError(403, 'not a project admin');
          }

          return { value: [] };
        },
      );

      await svc.applyRepositorySelection(conn());

      expect(core.updateRepositoryWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'repo-1' }),
        { webhook_error: 'forbidden' },
      );
      expect(core.updateRepositoryWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'repo-2' }),
        { webhook_error: 'forbidden' },
      );
    });

    describe('events lost while a subscription could not be created', () => {
      const subscription = (event: string) => ({
        id: `sub-${event}`,
        eventType: event,
        status: 'enabled',
        consumerInputs: {
          url: `https://api.example.com/api/v1/git-integrations/azure_devops/webhook/${HOOK_ID}`,
        },
      });

      it('imports again once the subscriptions work after a failed tick', async () => {
        const { svc, db } = forReconcile([hookRow({ error: 'forbidden' })]);

        await svc.applyRepositorySelection(conn());

        expect(resets(db)).toHaveLength(1);

        const update = db.calls.find(
          (call) =>
            call.table === 'git_azure_project_hooks' && op(call, 'update'),
        )!;

        expect(op(update, 'update')![1]).toMatchObject({ error: null });
      });

      it('does not import while the subscriptions keep failing, and remembers it', async () => {
        const { svc, client, db } = forReconcile([
          hookRow({ error: 'forbidden' }),
        ]);

        client.org.mockImplementation(
          async (
            _o: string,
            path: string,
            _t: string,
            o?: { method?: string },
          ) => {
            if (path === '/_apis/git/repositories')
              return { value: [remoteRepo()] };
            if (o?.method === 'POST')
              throw new AzureDevopsApiError(403, 'not a project admin');

            return { value: [] };
          },
        );

        await svc.applyRepositorySelection(conn());

        expect(resets(db)).toHaveLength(0);

        const update = db.calls.find(
          (call) =>
            call.table === 'git_azure_project_hooks' && op(call, 'update'),
        )!;

        expect(op(update, 'update')![1]).toMatchObject({ error: 'forbidden' });
      });

      it('keeps the error when the import could not be reset, so the next tick tries again', async () => {
        const context = setup((call) => {
          if (call.table === 'git_azure_project_hooks' && op(call, 'select'))
            return { data: [hookRow({ error: 'forbidden' })] };
          if (call.table === 'git_credentials') return { data: credential() };
          if (call.table === 'git_repositories' && op(call, 'update'))
            return { error: { message: 'down' } };

          return {};
        });

        context.core.listRepositories.mockResolvedValue([repo()]);
        context.client.org.mockImplementation(
          async (
            _o: string,
            path: string,
            _t: string,
            o?: { method?: string },
          ) => {
            if (path === '/_apis/git/repositories')
              return { value: [remoteRepo()] };
            if (o?.method === 'POST') return { id: 'new' };

            return { value: [] };
          },
        );

        await context.svc.applyRepositorySelection(conn());

        const update = context.db.calls.find(
          (call) =>
            call.table === 'git_azure_project_hooks' && op(call, 'update'),
        )!;

        expect(op(update, 'update')![1]).toMatchObject({ error: 'failed' });
      });

      it('loses nothing when every subscription stayed healthy', async () => {
        const { svc, db } = forReconcile(
          [hookRow()],
          AZURE_HOOK_EVENTS.map(subscription),
        );

        await svc.applyRepositorySelection(conn());

        expect(resets(db)).toHaveLength(0);
      });
    });

    describe('one project must not stop the next', () => {
      const second = '77777777-7777-7777-7777-777777777777';

      function twoProjects(insert: (project: string) => Result) {
        const context = setup((call) => {
          if (call.table === 'git_azure_project_hooks') {
            const inserted = op(call, 'insert');

            if (inserted)
              return insert(
                (inserted[1] as { project_external_id: string })
                  .project_external_id,
              );
            if (op(call, 'select')) return { data: [] };
          }
          if (call.table === 'git_credentials') return { data: credential() };

          return {};
        });

        context.core.listRepositories.mockResolvedValue([
          repo(),
          repo({ id: 'repo-2', external_id: 'guid-2' }),
        ]);
        context.client.org.mockImplementation(
          async (
            _o: string,
            path: string,
            _t: string,
            o?: { method?: string },
          ) => {
            if (path === '/_apis/git/repositories')
              return { value: [remoteRepo(), remoteRepo('guid-2', second)] };
            if (o?.method === 'POST') return { id: 'new' };

            return { value: [] };
          },
        );

        return context;
      }

      it('carries on when the hook row of a project cannot be created', async () => {
        const { svc, client, core } = twoProjects((project) =>
          project === PROJECT
            ? { error: { message: 'insert failed' } }
            : {
                data: hookRow({
                  id: '88888888-8888-8888-8888-888888888888',
                  project_external_id: second,
                }),
              },
        );

        await expect(
          svc.applyRepositorySelection(conn()),
        ).resolves.toBeUndefined();

        expect(core.updateRepositoryWebhook).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'repo-1' }),
          { webhook_error: 'failed' },
        );
        expect(creates(client)).toHaveLength(AZURE_HOOK_EVENTS.length);
      });

      it('survives the failed project state not being saved either', async () => {
        const { svc, core, client } = twoProjects((project) =>
          project === PROJECT
            ? { error: { message: 'insert failed' } }
            : {
                data: hookRow({
                  id: '88888888-8888-8888-8888-888888888888',
                  project_external_id: second,
                }),
              },
        );

        core.updateRepositoryWebhook.mockRejectedValueOnce(new Error('down'));

        await expect(
          svc.applyRepositorySelection(conn()),
        ).resolves.toBeUndefined();
        expect(creates(client)).toHaveLength(AZURE_HOOK_EVENTS.length);
      });

      it('uses the row another instance created first', async () => {
        const context = setup((call) => {
          if (call.table === 'git_azure_project_hooks') {
            if (op(call, 'insert'))
              return {
                error: { message: 'duplicate', code: '23505' } as never,
              };

            if (op(call, 'select')) {
              context.hookReads += 1;

              return { data: context.hookReads === 1 ? [] : [hookRow()] };
            }
          }
          if (call.table === 'git_credentials') return { data: credential() };

          return {};
        }) as ReturnType<typeof setup> & { hookReads: number };

        context.hookReads = 0;
        context.core.listRepositories.mockResolvedValue([repo()]);
        context.client.org.mockImplementation(
          async (
            _o: string,
            path: string,
            _t: string,
            o?: { method?: string },
          ) => {
            if (path === '/_apis/git/repositories')
              return { value: [remoteRepo()] };
            if (o?.method === 'POST') return { id: 'new' };

            return { value: [] };
          },
        );

        await context.svc.applyRepositorySelection(conn());

        expect(creates(context.client)).toHaveLength(AZURE_HOOK_EVENTS.length);
        expect(context.core.updateRepositoryWebhook).not.toHaveBeenCalledWith(
          expect.anything(),
          { webhook_error: 'failed' },
        );
      });
    });

    it('clears the error once it works again', async () => {
      const { svc, core } = forReconcile([]);

      core.listRepositories.mockResolvedValue([
        repo({ webhook_error: 'forbidden' }),
      ]);

      await svc.applyRepositorySelection(conn());

      expect(core.updateRepositoryWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'repo-1' }),
        { webhook_error: null },
      );
    });

    it.each([
      ['disabled', { is_enabled: false }],
      ['removed', { removed_at: '2026-01-01' }],
    ])(
      'removes the subscriptions of a project whose only repository is %s',
      async (_name, patch) => {
        const { svc, client, core, db } = forReconcile([
          hookRow({
            subscription_ids: { 'git.push': 's1', 'build.complete': 's2' },
          }),
        ]);

        core.listRepositories.mockResolvedValue([repo(patch)]);

        await svc.applyRepositorySelection(conn());

        expect(deletes(client).map(([, path]) => path)).toEqual([
          '/_apis/hooks/subscriptions/s1',
          '/_apis/hooks/subscriptions/s2',
        ]);
        expect(creates(client)).toHaveLength(0);

        const removal = db.calls.find(
          (call) =>
            call.table === 'git_azure_project_hooks' && op(call, 'delete'),
        )!;

        expect(eq(removal, 'organization_id', ORG)).toBe(true);
      },
    );

    it('a selection never touches another connection: hooks are read by organization and connection', async () => {
      const { svc, db } = forReconcile([]);

      await svc.applyRepositorySelection(conn());

      const read = db.calls.find(
        (call) =>
          call.table === 'git_azure_project_hooks' && op(call, 'select'),
      )!;

      expect(eq(read, 'organization_id', ORG)).toBe(true);
      expect(eq(read, 'connection_id', CONN_ID)).toBe(true);
    });

    it('stores disabled Azure repositories as gone', async () => {
      const { svc, client, core } = forReconcile([]);

      client.org.mockImplementation(async (_o: string, path: string) =>
        path === '/_apis/git/repositories'
          ? { value: [remoteRepo(REPO_GUID, PROJECT, { isDisabled: true })] }
          : { value: [] },
      );

      await svc.refreshRepositories(conn());

      expect(core.upsertRepositories).toHaveBeenCalledWith(
        expect.anything(),
        [],
        true,
      );
    });

    it('flags a connection without an authorization', async () => {
      const { svc, core } = setup();

      await expect(
        svc.refreshRepositories(conn({ credential_id: null })),
      ).rejects.toThrow('no authorization');
      expect(core.setStatus).toHaveBeenCalledWith(
        expect.anything(),
        'needs_attention',
        'authorization_expired',
      );
    });

    it('disconnect deletes subscriptions, rows and the unused credential', async () => {
      const { svc, client, db } = setup((call) => {
        if (call.table === 'git_azure_project_hooks' && op(call, 'select'))
          return {
            data: [hookRow({ subscription_ids: { 'git.push': 's1' } })],
          };
        if (call.table === 'git_credentials') return { data: credential() };

        return {};
      });

      client.org.mockResolvedValue(undefined);

      await svc.onDisconnect(conn());

      expect(client.org).toHaveBeenCalledWith(
        'acme',
        '/_apis/hooks/subscriptions/s1',
        'at',
        { method: 'DELETE' },
      );
      expect(
        db.calls.some(
          (call) =>
            call.table === 'git_azure_project_hooks' && op(call, 'delete'),
        ),
      ).toBe(true);
      expect(
        db.calls.some(
          (call) => call.table === 'git_credentials' && op(call, 'delete'),
        ),
      ).toBe(true);
    });

    it('disconnect without a token still removes the rows, so leftovers get a 410', async () => {
      const { svc, client, db } = setup((call) => {
        if (call.table === 'git_azure_project_hooks' && op(call, 'select'))
          return {
            data: [hookRow({ subscription_ids: { 'git.push': 's1' } })],
          };
        if (call.table === 'git_credentials') return { data: null };

        return {};
      });

      await svc.onDisconnect(conn());

      expect(client.org).not.toHaveBeenCalled();
      expect(
        db.calls.some(
          (call) =>
            call.table === 'git_azure_project_hooks' && op(call, 'delete'),
        ),
      ).toBe(true);
    });

    it('keeps a credential another connection still uses', async () => {
      const { svc, core, db } = setup((call) =>
        call.table === 'git_azure_project_hooks'
          ? { data: [] }
          : { data: credential() },
      );

      core.listConnections.mockResolvedValue([
        conn({ id: 'other', credential_id: 'cred-1' }),
      ]);

      await svc.onDisconnect(conn());

      expect(
        db.calls.some(
          (call) => call.table === 'git_credentials' && op(call, 'delete'),
        ),
      ).toBe(false);
    });
  });

  describe('webhook receiver', () => {
    it('answers gone for an unknown hook, which disables a leftover subscription', async () => {
      const { svc } = setup(withHook(null));

      await expect(svc.handleWebhook(delivery({}))).resolves.toBe('gone');
    });

    it.each([
      ['no header', undefined],
      ['a wrong password', basic('wrong')],
      ['a wrong password of the same length', basic('x'.repeat(64))],
      ['another scheme', `Bearer ${PASSWORD}`],
      ['garbage', 'Basic !!!'],
    ])('refuses %s without reading anything', async (_name, authorization) => {
      const { svc, core, client } = setup(withHook());

      await expect(
        svc.handleWebhook({ ...delivery(prEvent()), authorization }),
      ).resolves.toBe('unauthorized');
      expect(core.recordDelivery).not.toHaveBeenCalled();
      expect(client.org).not.toHaveBeenCalled();
    });

    it('answers gone for a disconnected or deleted connection', async () => {
      const { svc, core } = setup(withHook());

      core.getConnection.mockResolvedValue(conn({ status: 'disconnected' }));
      await expect(svc.handleWebhook(delivery(prEvent()))).resolves.toBe(
        'gone',
      );

      core.getConnection.mockRejectedValue(new NotFoundException());
      await expect(svc.handleWebhook(delivery(prEvent()))).resolves.toBe(
        'gone',
      );
    });

    it('asks for a retry when our own database cannot be read, never a 500', async () => {
      const first = setup(() => ({ error: { message: 'down' } }));

      await expect(first.svc.handleWebhook(delivery({}))).resolves.toBe(
        'retry',
      );

      const second = setup(withHook());

      second.core.getConnection.mockRejectedValue(new Error('db down'));
      await expect(second.svc.handleWebhook(delivery({}))).resolves.toBe(
        'retry',
      );
    });

    it('accepts and ignores a body that is not JSON', async () => {
      const { svc, core } = setup(withHook());

      await expect(
        svc.handleWebhook({
          hookId: HOOK_ID,
          authorization: basic(PASSWORD),
          rawBody: Buffer.from('not json'),
        }),
      ).resolves.toBe('ok');
      expect(core.recordDelivery).not.toHaveBeenCalled();
    });

    it('skips a duplicate delivery, scoped to the hook', async () => {
      const { svc, core, client } = setup(withHook());

      core.recordDelivery.mockResolvedValue(false);

      await expect(svc.handleWebhook(delivery(prEvent()))).resolves.toBe('ok');
      expect(core.recordDelivery).toHaveBeenCalledWith(
        'azure_devops',
        `${HOOK_ID}:evt-1`,
        'git.pullrequest.updated',
      );
      expect(client.org).not.toHaveBeenCalled();
    });

    it('stores the pull request read from the API, never the payload', async () => {
      const { svc, core, client, pullRequests } = setup(withHook());

      client.org.mockResolvedValue(apiPr());

      await expect(svc.handleWebhook(delivery(prEvent()))).resolves.toBe('ok');

      expect(client.org).toHaveBeenCalledWith(
        'acme',
        `/_apis/git/repositories/${REPO_GUID}/pullrequests/7`,
        'at',
      );

      const [, stored] = pullRequests.sync.mock.calls[0];

      expect(stored.title).toBe('Real title');
      expect(JSON.stringify(stored)).not.toContain('FORGED');
      expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
        'azure_devops',
        `${HOOK_ID}:evt-1`,
        'processed',
      );
    });

    it('names the author on created and the closer on merged as the actor', async () => {
      const { svc, client, pullRequests } = setup(withHook());

      client.org.mockResolvedValue(
        apiPr({ closedBy: { id: 'closer', uniqueName: 'C@x.com' } }),
      );

      await svc.handleWebhook(delivery(prEvent('git.pullrequest.created')));
      await svc.handleWebhook(delivery(prEvent('git.pullrequest.merged')));

      expect(pullRequests.sync.mock.calls[0][2]).toEqual({
        externalId: 'author',
        login: 'author@acme.com',
      });
      expect(pullRequests.sync.mock.calls[1][2]).toEqual({
        externalId: 'closer',
        login: 'c@x.com',
      });
    });

    it('an update is still a live event when nobody is named', async () => {
      const { svc, client, pullRequests } = setup(withHook());

      client.org.mockResolvedValue(apiPr());

      await svc.handleWebhook(delivery(prEvent()));

      expect(pullRequests.sync.mock.calls[0][2]).toEqual({
        externalId: null,
        login: null,
      });
    });

    it.each([
      [
        'of another connection (same organization)',
        repo({ connection_id: 'other' }),
      ],
      ['disabled', repo({ is_enabled: false })],
      ['removed', repo({ removed_at: '2026-01-01' })],
      ['unknown', null],
    ])('ignores a repository that is %s', async (_name, found) => {
      const { svc, core, client, pullRequests } = setup(withHook());

      core.findRepository.mockResolvedValue(found);

      await expect(svc.handleWebhook(delivery(prEvent()))).resolves.toBe('ok');
      expect(client.org).not.toHaveBeenCalled();
      expect(pullRequests.sync).not.toHaveBeenCalled();
      expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
        'azure_devops',
        `${HOOK_ID}:evt-1`,
        'ignored_disabled',
      );
    });

    it('ignores deliveries while the connection needs a reconnect, which imports again', async () => {
      const { svc, core, client } = setup(withHook());

      core.getConnection.mockResolvedValue(conn({ status: 'needs_attention' }));

      await expect(svc.handleWebhook(delivery(prEvent()))).resolves.toBe('ok');
      expect(client.org).not.toHaveBeenCalled();
    });

    it.each([
      [429, 'retry'],
      [500, 'retry'],
      [503, 'retry'],
      [401, 'ok'],
      [403, 'ok'],
    ])(
      'an API %i answers %s and forgets the delivery, so a later one is processed',
      async (status, answer) => {
        const { svc, core, client } = setup(withHook());

        client.org.mockRejectedValue(new AzureDevopsApiError(status, 'x'));

        await expect(svc.handleWebhook(delivery(prEvent()))).resolves.toBe(
          answer,
        );
        expect(core.forgetDelivery).toHaveBeenCalledWith(
          'azure_devops',
          `${HOOK_ID}:evt-1`,
        );
      },
    );

    it('asks for a retry on a timeout or a busy token refresh', async () => {
      const { svc, client } = setup(withHook());

      client.org.mockRejectedValue(new Error('aborted'));

      await expect(svc.handleWebhook(delivery(prEvent()))).resolves.toBe(
        'retry',
      );
    });

    it('a pull request deleted meanwhile is not an error', async () => {
      const { svc, core, client, pullRequests } = setup(withHook());

      client.org.mockRejectedValue(new AzureDevopsApiError(404, 'gone'));

      await expect(svc.handleWebhook(delivery(prEvent()))).resolves.toBe('ok');
      expect(pullRequests.sync).not.toHaveBeenCalled();
      expect(core.forgetDelivery).not.toHaveBeenCalled();
    });

    describe('push', () => {
      const push = (overrides: Record<string, unknown> = {}) => ({
        pushId: 14,
        date: '2026-01-03T00:00:00Z',
        pushedBy: { id: 'pusher', uniqueName: 'P@x.com' },
        refUpdates: [{ name: 'refs/heads/feature/XE-T1', newObjectId: SHA }],
        commits: [
          {
            commitId: 'c'.repeat(40),
            comment: 'newer',
            committer: { date: '2026-01-02T00:00:00Z' },
          },
          {
            commitId: 'd'.repeat(40),
            comment: 'older',
            committer: { date: '2026-01-01T00:00:00Z' },
          },
        ],
        ...overrides,
      });
      const event = {
        id: 'evt-2',
        eventType: 'git.push',
        resource: {
          pushId: 14,
          repository: { id: REPO_GUID },
          refUpdates: [{ name: 'refs/heads/FORGED', newObjectId: SHA }],
        },
      };

      it('reads the push and stores branch and commits, oldest first', async () => {
        const { svc, client, pullRequests } = setup(withHook());

        client.org.mockResolvedValue(push());
        pullRequests.commitLinkingEnabled.mockResolvedValue(true);

        await svc.handleWebhook(delivery(event));

        expect(client.org.mock.calls[0][1]).toBe(
          `/_apis/git/repositories/${REPO_GUID}/pushes/14?includeCommits=2048&includeRefUpdates=true`,
        );

        const actor = { externalId: 'pusher', login: 'p@x.com' };

        expect(pullRequests.syncBranch).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'repo-1' }),
          'feature/XE-T1',
          '2026-01-03T00:00:00.000Z',
          false,
          actor,
        );
        expect(pullRequests.syncBranch).toHaveBeenCalledTimes(1);

        const [, branch, commits] = pullRequests.syncCommits.mock.calls[0];

        expect(branch).toBe('feature/XE-T1');
        expect(commits.map((c: { message: string }) => c.message)).toEqual([
          'older',
          'newer',
        ]);
      });

      it('does not link commits unless the organization wants that', async () => {
        const { svc, client, pullRequests } = setup(withHook());

        client.org.mockResolvedValue(push());

        await svc.handleWebhook(delivery(event));

        expect(pullRequests.syncBranch).toHaveBeenCalled();
        expect(pullRequests.syncCommits).not.toHaveBeenCalled();
      });

      it('a deleted branch has no time and no commits', async () => {
        const { svc, client, pullRequests } = setup(withHook());

        client.org.mockResolvedValue(
          push({
            refUpdates: [{ name: 'refs/heads/x', newObjectId: '0'.repeat(40) }],
          }),
        );
        pullRequests.commitLinkingEnabled.mockResolvedValue(true);

        await svc.handleWebhook(delivery(event));

        expect(pullRequests.syncBranch).toHaveBeenCalledWith(
          expect.anything(),
          'x',
          null,
          true,
          expect.anything(),
        );
        expect(pullRequests.syncCommits).not.toHaveBeenCalled();
      });

      it('ignores tags', async () => {
        const { svc, core, client, pullRequests } = setup(withHook());

        client.org.mockResolvedValue(
          push({ refUpdates: [{ name: 'refs/tags/v1', newObjectId: SHA }] }),
        );

        await svc.handleWebhook(delivery(event));

        expect(pullRequests.syncBranch).not.toHaveBeenCalled();
        expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
          'azure_devops',
          `${HOOK_ID}:evt-2`,
          'ignored',
        );
      });
    });

    describe('build', () => {
      const event = {
        id: 'evt-3',
        eventType: 'build.complete',
        resource: { id: 99 },
      };
      const build = (overrides: Record<string, unknown> = {}) => ({
        id: 99,
        status: 'completed',
        result: 'failed',
        sourceBranch: 'refs/heads/feature/XE-T1',
        sourceVersion: SHA,
        definition: { id: 3, name: 'CI' },
        repository: { id: REPO_GUID, type: 'TfsGit' },
        requestedFor: { id: 'r', uniqueName: 'R@x.com' },
        ...overrides,
      });

      it("reads the build in the hook's project and stores it", async () => {
        const { svc, core, client, pullRequests } = setup(withHook());

        client.org.mockResolvedValue(build());

        await svc.handleWebhook(delivery(event));

        expect(client.org.mock.calls[0][1]).toBe(
          `/${PROJECT}/_apis/build/builds/99`,
        );
        expect(core.findRepository).toHaveBeenCalledWith(
          expect.objectContaining({ id: CONN_ID }),
          REPO_GUID,
        );
        expect(pullRequests.syncBuilds).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'repo-1' }),
          [expect.objectContaining({ externalId: '99', state: 'failed' })],
          false,
          { externalId: 'r', login: 'r@x.com' },
        );
      });

      it.each([
        ['GitHub', { repository: { id: 'x', type: 'GitHub' } }],
        ['TFVC', { repository: { id: 'x', type: 'TfsVersionControl' } }],
        ['no repository', { repository: null }],
      ])('ignores a build from %s', async (_name, patch) => {
        const { svc, client, pullRequests } = setup(withHook());

        client.org.mockResolvedValue(build(patch));

        await svc.handleWebhook(delivery(event));

        expect(pullRequests.syncBuilds).not.toHaveBeenCalled();
      });

      it('ignores another repository of the project that is not enabled', async () => {
        const { svc, core, client, pullRequests } = setup(withHook());

        core.findRepository.mockResolvedValue(repo({ is_enabled: false }));
        client.org.mockResolvedValue(build());

        await svc.handleWebhook(delivery(event));

        expect(pullRequests.syncBuilds).not.toHaveBeenCalled();
      });

      it('ignores a build it cannot store', async () => {
        const { svc, client, pullRequests } = setup(withHook());

        client.org.mockResolvedValue(build({ sourceVersion: 'nope' }));

        await svc.handleWebhook(delivery(event));

        expect(pullRequests.syncBuilds).not.toHaveBeenCalled();
      });
    });

    it('ignores other events', async () => {
      const { svc, client } = setup(withHook());

      await expect(
        svc.handleWebhook(
          delivery({
            id: 'e',
            eventType: 'workitem.created',
            resource: { repository: { id: REPO_GUID } },
          }),
        ),
      ).resolves.toBe('ok');
      expect(client.org).not.toHaveBeenCalled();
    });
  });

  describe('reads', () => {
    it('fetchPullRequest adds the builds of an open pull request and maps a 404', async () => {
      const { svc, client } = setup();

      client.org.mockImplementation(async (_o: string, path: string) =>
        path.includes('/build/builds')
          ? {
              value: [
                {
                  id: 1,
                  sourceVersion: SHA,
                  definition: { id: 3 },
                  status: 'completed',
                  result: 'succeeded',
                },
              ],
            }
          : apiPr(),
      );

      const pr = await svc.fetchPullRequest(conn(), repo(), 7);

      expect(pr.builds).toHaveLength(1);

      const buildPath = client.org.mock.calls[1][1] as string;

      expect(buildPath.startsWith('/My%20Project/_apis/build/builds?')).toBe(
        true,
      );
      expect(buildPath).toContain('branchName=refs%2Fheads%2Ffeature%2FXE-T1');

      client.org.mockRejectedValue(new AzureDevopsApiError(404, 'x'));
      await expect(svc.fetchPullRequest(conn(), repo(), 7)).rejects.toThrow(
        'pull_request_not_found',
      );
    });

    describe('builds on the merge ref of a pull request', () => {
      const build = (id: number) => ({
        id,
        sourceVersion: SHA,
        definition: { id: 3 },
        status: 'completed',
        result: 'succeeded',
      });
      const respond =
        (forRef: (ref: string) => unknown) =>
        async (_o: string, path: string) => {
          if (!path.includes('/build/builds')) return apiPr();

          return forRef(
            new URL(`http://x${path}`).searchParams.get('branchName')!,
          );
        };

      it('reads both refs and returns the builds of each once', async () => {
        const { svc, client } = setup();

        client.org.mockImplementation(
          respond((ref) => ({
            value: ref.startsWith('refs/pull/')
              ? [build(1), build(2)]
              : [build(1)],
          })),
        );

        const pr = await svc.fetchPullRequest(conn(), repo(), 7);

        expect(pr.builds!.map((b) => b.externalId).sort()).toEqual(['1', '2']);

        const paths = client.org.mock.calls.map(([, path]) => path as string);

        expect(paths.some((p) => p.includes('refs%2Fpull%2F7%2Fmerge'))).toBe(
          true,
        );
      });

      it('keeps the builds of one ref when the other cannot be read', async () => {
        const { svc, client } = setup();

        client.org.mockImplementation(
          respond((ref) => {
            if (ref.startsWith('refs/pull/'))
              throw new AzureDevopsApiError(500, 'down');

            return { value: [build(1)] };
          }),
        );

        const pr = await svc.fetchPullRequest(conn(), repo(), 7);

        expect(pr.builds).toHaveLength(1);
      });
    });

    it('a failed build read never fails the pull request', async () => {
      const { svc, client } = setup();

      client.org.mockImplementation(async (_o: string, path: string) => {
        if (path.includes('/build/builds'))
          throw new AzureDevopsApiError(403, 'no build access');

        return apiPr();
      });

      await expect(
        svc.fetchPullRequest(conn(), repo(), 7),
      ).resolves.toMatchObject({ builds: [] });
    });

    it('reads a pull request in full when the list cut its description, so links by later keys stay', async () => {
      const { svc, client } = setup();
      const cut = 'x'.repeat(400);
      const full = `${cut} XE-T9`;

      client.org.mockImplementation(async (_o: string, path: string) => {
        if (path.includes('/build/builds')) return { value: [] };
        if (path.endsWith('/pullrequests/7'))
          return apiPr({ description: full });
        if (path.includes('searchCriteria.status=active'))
          return {
            value: [
              apiPr({ description: cut }),
              apiPr({ pullRequestId: 8, description: 'short' }),
            ],
          };

        return { value: [] };
      });

      const prs = await svc.listRecentPullRequests(
        conn(),
        repo(),
        new Date('2026-01-01'),
      );

      expect(prs.find((pr) => pr.number === 7)?.body).toBe(full);
      expect(prs.find((pr) => pr.number === 8)?.body).toBe('short');
      expect(
        client.org.mock.calls.filter(([, path]) =>
          (path as string).endsWith('/pullrequests/8'),
        ),
      ).toHaveLength(0);
    });

    it('imports open ones plus those closed since, without duplicates, across pages', async () => {
      const { svc, client } = setup();
      const page = Array.from({ length: 100 }, (_, i) =>
        apiPr({ pullRequestId: i + 1 }),
      );

      client.org.mockImplementation(async (_o: string, path: string) => {
        if (path.includes('/build/builds')) return { value: [] };
        if (path.includes('status=active'))
          return path.includes('%24skip=100') || path.includes('$skip=100')
            ? { value: [apiPr({ pullRequestId: 101 })] }
            : { value: page };

        expect(path).toContain('queryTimeRangeType=closed');

        return {
          value: [
            apiPr({ pullRequestId: 1, status: 'completed' }),
            apiPr({ pullRequestId: 200, status: 'abandoned' }),
          ],
        };
      });

      const prs = await svc.listRecentPullRequests(
        conn(),
        repo(),
        new Date('2026-01-01'),
      );

      expect(prs.map((pr) => pr.number)).toHaveLength(102);
      expect(prs.find((pr) => pr.number === 200)?.state).toBe('closed');
    });

    it('lists only branches with a task key, following the continuation', async () => {
      const { svc, client } = setup();

      client.orgPage
        .mockResolvedValueOnce({
          data: {
            value: [
              { name: 'refs/heads/main' },
              { name: 'refs/heads/feature/XE-T1' },
            ],
          },
          headers: new Headers({ 'x-ms-continuationtoken': 'next' }),
        })
        .mockResolvedValueOnce({
          data: { value: [{ name: 'refs/heads/XE-T2-fix' }] },
          headers: new Headers(),
        });

      await expect(svc.listKeyBranches(conn(), repo())).resolves.toEqual([
        { name: 'feature/XE-T1', pushedAt: null },
        { name: 'XE-T2-fix', pushedAt: null },
      ]);
      expect(client.orgPage.mock.calls[1][1]).toContain(
        'continuationToken=next',
      );
    });
  });

  describe('health', () => {
    function forHealth(cred: unknown = credential()) {
      const context = setup((call) => {
        if (call.table === 'git_credentials') return { data: cred };
        if (call.table === 'git_azure_project_hooks') return { data: [] };

        return {};
      });

      context.core.listAllLive.mockResolvedValue([conn()]);
      context.client.org.mockResolvedValue({ value: [] });

      return context;
    }

    it('re-reads a healthy connection, whatever its selection', async () => {
      const { svc, core } = forHealth();

      core.listAllLive.mockResolvedValue([
        conn({ repository_selection: 'selected' }),
      ]);

      await svc.checkHealth();

      expect(core.upsertRepositories).toHaveBeenCalled();
      expect(core.setStatus).not.toHaveBeenCalled();
    });

    it.each([
      ['no credential', null],
      ['a refused credential', credential({ status: 'invalid' })],
    ])('flags %s', async (_name, cred) => {
      const { svc, core } = forHealth(cred);

      await svc.checkHealth();

      expect(core.setStatus).toHaveBeenCalledWith(
        expect.anything(),
        'needs_attention',
        'authorization_expired',
      );
    });

    it('flags a connection without a credential id', async () => {
      const { svc, core } = forHealth();

      core.listAllLive.mockResolvedValue([conn({ credential_id: null })]);

      await svc.checkHealth();

      expect(core.setStatus).toHaveBeenCalledTimes(1);
    });

    it('flags an organization the person no longer has', async () => {
      const { svc, core, client } = forHealth();

      client.accounts.mockResolvedValue([]);

      await svc.checkHealth();

      expect(core.setStatus).toHaveBeenCalledWith(
        expect.anything(),
        'needs_attention',
        'authorization_expired',
      );
      expect(core.upsertRepositories).not.toHaveBeenCalled();
    });

    it('follows an organization rename by its stable id', async () => {
      const { svc, core, client } = forHealth();

      client.accounts.mockResolvedValue([
        { accountId: ACCOUNT, accountName: 'acme-new' },
      ]);

      await svc.checkHealth();

      expect(core.updateAccountDetails).toHaveBeenCalledWith(
        expect.objectContaining({ id: CONN_ID }),
        expect.objectContaining({
          login: 'acme-new',
          url: 'https://dev.azure.com/acme-new',
        }),
      );
      expect(client.org.mock.calls[0][0]).toBe('acme-new');
    });

    it('restores a connection that works again', async () => {
      const { svc, core } = forHealth();

      core.listAllLive.mockResolvedValue([
        conn({
          status: 'needs_attention',
          status_reason: 'authorization_expired',
        }),
      ]);

      await svc.checkHealth();

      expect(core.setStatus).toHaveBeenCalledWith(
        expect.anything(),
        'active',
        'authorization_expired',
      );
      expect(core.upsertRepositories).toHaveBeenCalled();
    });

    it.each([[429], [500], [503]])(
      'a %i keeps the last known status',
      async (status) => {
        const { svc, core, client } = forHealth();

        client.accounts.mockRejectedValue(new AzureDevopsApiError(status, 'x'));

        await svc.checkHealth();

        expect(core.setStatus).not.toHaveBeenCalled();
      },
    );

    it('a refused token asks for a reconnect', async () => {
      const { svc, core, client } = forHealth();

      client.accounts.mockRejectedValue(new AzureDevopsApiError(401, 'x'));

      await svc.checkHealth();

      expect(core.setStatus).toHaveBeenCalledWith(
        expect.anything(),
        'needs_attention',
        'authorization_expired',
      );
    });

    it('one connection failing never stops the next', async () => {
      const { svc, core, client } = forHealth();

      core.listAllLive.mockResolvedValue([conn(), conn({ id: 'second' })]);
      client.org
        .mockRejectedValueOnce(new AzureDevopsApiError(500, 'x'))
        .mockResolvedValue({ value: [] });

      await expect(svc.checkHealth()).resolves.toBeUndefined();
      expect(core.upsertRepositories).toHaveBeenCalledTimes(1);
    });
  });

  describe('token refresh', () => {
    const expiredAt = () => new Date(Date.now() - 1000).toISOString();

    function forRefresh() {
      return setup((call) => {
        if (call.table === 'git_credentials' && op(call, 'update')) {
          // The lease is claimed by the conditional update; other updates return nothing.
          return { data: [{ id: 'cred-1' }] };
        }

        if (call.table === 'git_credentials')
          return { data: credential({ expires_at: expiredAt() }) };

        return {};
      });
    }

    it('renews an expired token under the lease and stores the new one', async () => {
      const { svc, client, db } = forRefresh();

      client.refresh.mockResolvedValue({
        accessToken: 'new',
        refreshToken: 'rt-new',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      client.org.mockResolvedValue(apiPr());

      await svc.fetchPullRequest(conn(), repo(), 7);

      expect(client.refresh).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'azure_devops' }),
        'rt',
      );
      expect(client.org.mock.calls[0][2]).toBe('new');

      const stored = db.calls.find(
        (call) =>
          call.table === 'git_credentials' &&
          (op(call, 'update')?.[1] as { status?: string })?.status === 'active',
      )!;

      expect(eq(stored, 'organization_id', ORG)).toBe(true);
    });

    it.each(['invalid_grant', 'interaction_required'])(
      'a refused refresh (%s) asks for a reconnect',
      async (code) => {
        const { svc, core, client } = forRefresh();

        client.refresh.mockRejectedValue(
          new AzureDevopsApiError(400, 'x', code),
        );
        core.listConnections.mockResolvedValue([conn()]);

        await expect(svc.fetchPullRequest(conn(), repo(), 7)).rejects.toThrow();
        expect(core.setStatus).toHaveBeenCalledWith(
          expect.objectContaining({ id: CONN_ID }),
          'needs_attention',
          'authorization_expired',
        );
      },
    );

    it.each(['temporarily_unavailable', 'server_error', null])(
      'a temporary refresh failure (%s) keeps the grant',
      async (code) => {
        const { svc, core, client } = forRefresh();

        client.refresh.mockRejectedValue(
          new AzureDevopsApiError(503, 'x', code),
        );

        await expect(svc.fetchPullRequest(conn(), repo(), 7)).rejects.toThrow();
        expect(core.setStatus).not.toHaveBeenCalled();
      },
    );
  });

  describe('sign-in edge cases', () => {
    const user = { userId: USER, organizationId: ORG } as never;
    const signed = (connectionId?: string) =>
      createState(
        USER,
        ORG,
        stateProviderTag('azure_devops', connectionId),
        'http://localhost:3000',
      );
    const inserted = (call: ICall) =>
      call.table === 'git_credentials' && Boolean(op(call, 'insert'));

    afterEach(() => jest.restoreAllMocks());

    describe('callback state', () => {
      it.each([
        ['no state', () => undefined],
        ['an empty state', () => ''],
        ['a tampered signature', () => `${signed().slice(0, -2)}xx`],
        ['a state without a signature', () => signed().split('.')[0]],
      ])('rejects %s without calling Microsoft', async (_name, make) => {
        const { svc, client, db } = setup();

        expect(
          await svc.handleCallback({ code: 'c', state: make() }),
        ).toContain('error=expired');
        expect(client.exchangeCode).not.toHaveBeenCalled();
        expect(db.calls.some(inserted)).toBe(false);
      });

      it('rejects a state older than 10 minutes', async () => {
        const { svc, client } = setup();
        const now = Date.now();
        const spy = jest.spyOn(Date, 'now');

        spy.mockReturnValue(now - 11 * 60_000);

        const old = signed();

        spy.mockReturnValue(now);

        expect(await svc.handleCallback({ code: 'c', state: old })).toContain(
          'error=expired',
        );
        expect(client.exchangeCode).not.toHaveBeenCalled();
      });

      it('accepts a state just under 10 minutes old', async () => {
        const { svc, client } = setup((call) =>
          op(call, 'insert') ? { data: { id: 'cred-9' } } : {},
        );
        const now = Date.now();
        const spy = jest.spyOn(Date, 'now');

        spy.mockReturnValue(now - 9 * 60_000);

        const old = signed();

        spy.mockReturnValue(now);

        expect(await svc.handleCallback({ code: 'c', state: old })).toContain(
          'credential=cred-9',
        );
        expect(client.exchangeCode).toHaveBeenCalled();
      });

      it("ignores Microsoft's error when the state is not ours", async () => {
        const { svc } = setup();

        expect(
          await svc.handleCallback({ error: 'access_denied', state: 'forged' }),
        ).toContain('error=expired');
      });
    });

    describe('callback from Microsoft', () => {
      it('treats a missing code as expired and calls nobody', async () => {
        const { svc, client, core } = setup();

        expect(await svc.handleCallback({ state: signed() })).toContain(
          'error=expired',
        );
        expect(client.exchangeCode).not.toHaveBeenCalled();
        expect(core.isOrgAdmin).not.toHaveBeenCalled();
      });

      it('never lets an error code grow the address', async () => {
        const { svc } = setup();
        const url = await svc.handleCallback({
          error: 'x'.repeat(500),
          state: signed(),
        });

        expect(new URL(url).searchParams.get('error')).toBe('x'.repeat(50));
      });

      it('an error code cannot change the tab or the provider', async () => {
        const { svc } = setup();
        const query = new URL(
          await svc.handleCallback({
            error: 'a&tab=evil&integration=github',
            state: signed(),
          }),
        ).searchParams;

        expect(query.get('tab')).toBe('integrations');
        expect(query.get('integration')).toBe('azure_devops');
      });

      it('stores nothing when the profile cannot be read', async () => {
        const { svc, client, db } = setup();

        client.profile.mockRejectedValue(new AzureDevopsApiError(401, 'no'));

        expect(
          await svc.handleCallback({ code: 'c', state: signed() }),
        ).toContain('error=failed');
        expect(db.calls.some(inserted)).toBe(false);
      });

      it('reports a credential that cannot be stored', async () => {
        const { svc } = setup((call) =>
          op(call, 'insert') ? { error: { message: 'db down' } } : {},
        );

        expect(
          await svc.handleCallback({ code: 'c', state: signed() }),
        ).toContain('error=failed');
      });

      it.each([
        ['the display name', { displayName: 'Me Myself' }, 'Me Myself'],
        ['nothing', {}, null],
      ])(
        'falls back to %s without an email address',
        async (_name, profile, login) => {
          const { svc, client, db } = setup((call) =>
            op(call, 'insert') ? { data: { id: 'cred-9' } } : {},
          );

          client.profile.mockResolvedValue({ id: 'me', ...profile });

          await svc.handleCallback({ code: 'c', state: signed() });

          expect(op(db.calls.find(inserted)!, 'insert')![1]).toMatchObject({
            external_login: login,
          });
        },
      );

      it('BUG: refuses a sign-in without a refresh token, which would die within the hour', async () => {
        const { svc, client, db } = setup((call) =>
          op(call, 'insert') ? { data: { id: 'cred-9' } } : {},
        );

        client.exchangeCode.mockResolvedValue({
          accessToken: 'at',
          refreshToken: '',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        });

        expect(
          await svc.handleCallback({ code: 'c', state: signed() }),
        ).toContain('error=');
        expect(db.calls.some(inserted)).toBe(false);
      });
    });

    describe('reconnect', () => {
      it('will not start for an unknown connection', async () => {
        const { svc, core, client } = setup();

        core.getConnection.mockRejectedValue(new NotFoundException());

        await expect(
          svc.connectUrl(USER, ORG, undefined, CONN_ID),
        ).rejects.toThrow(NotFoundException);
        expect(client.authorizeUrl).not.toHaveBeenCalled();
      });

      it.each([
        ['unknown', () => Promise.reject(new NotFoundException())],
        [
          'of another provider',
          () => Promise.resolve(conn({ provider: 'github' })),
        ],
        [
          'disconnected',
          () => Promise.resolve(conn({ status: 'disconnected' })),
        ],
      ])(
        'stops before Microsoft for a connection that is %s',
        async (_name, result) => {
          const { svc, core, client, db } = setup();

          core.getConnection.mockImplementation(result);

          expect(
            await svc.handleCallback({ code: 'c', state: signed(CONN_ID) }),
          ).toContain('error=not_found');
          expect(client.exchangeCode).not.toHaveBeenCalled();
          expect(db.calls.some(inserted)).toBe(false);
        },
      );

      it('reads the connection inside the organization of the state', async () => {
        const { svc, core } = setup();

        await svc.handleCallback({ code: 'c', state: signed(CONN_ID) });

        expect(core.getConnection).toHaveBeenCalledWith(ORG, CONN_ID);
      });

      it('stores nothing when the organizations cannot be read', async () => {
        const { svc, client, core, db } = setup();

        client.accounts.mockRejectedValue(new AzureDevopsApiError(500, 'down'));

        expect(
          await svc.handleCallback({ code: 'c', state: signed(CONN_ID) }),
        ).toContain('error=failed');
        expect(db.calls.some(inserted)).toBe(false);
        expect(core.setCredential).not.toHaveBeenCalled();
      });

      it('still reports success when the repair afterwards fails', async () => {
        const { svc, client, core } = setup((call) =>
          op(call, 'insert') ? { data: { id: 'cred-new' } } : {},
        );

        client.org.mockRejectedValue(new AzureDevopsApiError(500, 'down'));

        expect(
          await svc.handleCallback({ code: 'c', state: signed(CONN_ID) }),
        ).toContain('connected=azure_devops');
        expect(core.setCredential).toHaveBeenCalled();
      });
    });

    describe('picker', () => {
      it('an account without organizations gets an empty list, not an error', async () => {
        const { svc, client } = setup();

        client.accounts.mockResolvedValue([]);

        await expect(svc.listOrganizations(user, 'cred-1')).resolves.toEqual(
          [],
        );
      });

      it('a search without a match gets an empty list', async () => {
        const { svc } = setup();

        await expect(
          svc.listOrganizations(user, 'cred-1', 'nothing'),
        ).resolves.toEqual([]);
      });

      it('reads connections of the own organization only', async () => {
        const { svc, core } = setup();

        await svc.listOrganizations(user, 'cred-1');

        expect(core.listConnections).toHaveBeenCalledWith(ORG, 'azure_devops');
      });

      it('an organization that needs a reconnect is not marked as connected', async () => {
        const { svc, core } = setup();

        core.listConnections.mockResolvedValue([
          conn({ status: 'needs_attention' }),
        ]);

        await expect(
          svc.listOrganizations(user, 'cred-1'),
        ).resolves.toMatchObject([{ id: ACCOUNT, alreadyConnected: false }]);
      });

      it('an organization already connected answers 409 and syncs nothing', async () => {
        const { svc, core, client } = setup();

        core.upsertConnection.mockRejectedValue(
          new ConflictException({ code: 'already_connected' }),
        );

        await expect(
          svc.connectOrganization(user, 'cred-1', ACCOUNT),
        ).rejects.toThrow(ConflictException);
        expect(client.org).not.toHaveBeenCalled();
      });

      it('connects inside the organization of the logged-in user', async () => {
        const { svc, core } = setup();

        await svc.connectOrganization(user, 'cred-1', ACCOUNT);

        expect(core.upsertConnection.mock.calls[0][0]).toMatchObject({
          organizationId: ORG,
          credentialId: 'cred-1',
          userId: USER,
        });
      });

      it('never asks Microsoft again with a credential known to be refused', async () => {
        const { svc, client } = setup((call) =>
          call.table === 'git_credentials' && op(call, 'select')
            ? {
                data: credential({
                  status: 'invalid',
                  expires_at: new Date(Date.now() - 1000).toISOString(),
                }),
              }
            : {},
        );

        await expect(svc.listOrganizations(user, 'cred-1')).rejects.toThrow();
        expect(client.refresh).not.toHaveBeenCalled();
      });

      // Live on 2026-11-03: the API answers 500 and the dialog says "try again", which can never help.
      it.each([
        [
          'Microsoft refuses the token',
          () => {
            const context = setup();

            context.client.accounts.mockRejectedValue(
              new AzureDevopsApiError(401, 'refused'),
            );

            return context;
          },
        ],
        [
          'the credential is known to be refused',
          () =>
            setup((call) =>
              call.table === 'git_credentials' && op(call, 'select')
                ? {
                    data: credential({
                      status: 'invalid',
                      expires_at: new Date(Date.now() - 1000).toISOString(),
                    }),
                  }
                : {},
            ),
        ],
      ])('BUG: answers an HTTP error, not a 500, when %s', async (_n, make) => {
        const { svc } = make();

        await expect(
          svc.listOrganizations(user, 'cred-1'),
        ).rejects.toBeInstanceOf(HttpException);
      });

      it('BUG: connecting an organization that needed a reconnect imports what was missed', async () => {
        const { svc, core, client, db } = setup((call) => {
          if (call.table === 'git_credentials') return { data: credential() };
          if (call.table === 'git_azure_project_hooks') return { data: [] };

          return {};
        });

        // upsertConnection reactivates the row; deliveries were ignored until now.
        core.upsertConnection.mockResolvedValue({
          connection: conn(),
          created: false,
        });
        core.listRepositories.mockResolvedValue([repo()]);
        client.org.mockResolvedValue({ value: [] });

        await svc.connectOrganization(user, 'cred-1', ACCOUNT);

        expect(
          db.calls.some(
            (call) =>
              call.table === 'git_repositories' &&
              (op(call, 'update')?.[1] as Record<string, unknown>)
                ?.pull_requests_backfilled_at === null,
          ),
        ).toBe(true);
      });
    });
  });
});
