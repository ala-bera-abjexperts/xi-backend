/**
 * @fileoverview Unit tests for the GitLab half of the Git integrations. The core service and the
 * GitLab client are jest.fn objects; the Supabase admin client is a recording builder whose results
 * come from a per-test handler.
 * @module src/git-integrations/gitlab/gitlab-integration.service.spec
 */

import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { createState } from '../../calendar/integrations/calendar-oauth.state';
import { decryptApiKey, encryptApiKey } from '../../lib/crypto/encryption';
import type {
  IGitConnectionRow,
  IGitPullRequestSyncResult,
  IGitRepositoryRow,
  IProviderPullRequest,
} from '../git-integrations.types';
import { stateProviderTag } from '../git-integrations.util';
import { GitlabApiError } from './gitlab.client';
import {
  buildFromGitlabPipeline,
  commitFromApi,
  commitFromHook,
  GitlabIntegrationService,
  mergeRequestFromApi,
  mergeRequestFromHook,
  reviewsFromGitlab,
  type IGitCredentialRow,
} from './gitlab-integration.service';

process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);

const ORG = '11111111-1111-1111-1111-111111111111';
const USER = 'user-1';
const CONN_ID = '22222222-2222-2222-2222-222222222222';
const RETURN_TO = 'http://localhost:3000';

type Op = [string, ...unknown[]];
interface ICall {
  table: string;
  ops: Op[];
}
type Result = {
  data?: unknown;
  error?: { message: string; code?: string } | null;
  count?: number;
};

const has = (call: ICall, name: string, ...args: unknown[]) =>
  call.ops.some(
    ([op, ...rest]) =>
      op === name &&
      args.every((arg, i) => JSON.stringify(rest[i]) === JSON.stringify(arg)),
  );
const kind = (call: ICall) =>
  call.ops.find(([op]) =>
    ['insert', 'update', 'delete', 'select'].includes(op),
  )?.[0];

/** checkHookAlerts' read of every hook recorded as disabled (not the round-robin batch). */
const isDisabledQuery = (call: ICall) =>
  call.ops.some(
    (op) =>
      op[0] === 'eq' &&
      op[1] === 'webhook_error' &&
      op[2] === 'disabled_by_gitlab',
  );

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

function encTokens(access: string, refresh: string) {
  const e = encryptApiKey(
    JSON.stringify({ access_token: access, refresh_token: refresh }),
  );

  return {
    encrypted_secret: e.encrypted,
    encryption_iv: e.iv,
    encryption_tag: e.tag,
  };
}

function cred(
  overrides: Partial<IGitCredentialRow> = {},
  access = 'at-old',
  refresh = 'rt-old',
): IGitCredentialRow {
  return {
    id: 'cred-1',
    organization_id: ORG,
    provider: 'gitlab',
    host: 'gitlab.example.com',
    external_user_id: '9',
    external_login: 'alice',
    ...encTokens(access, refresh),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    refresh_lease_until: null,
    status: 'active',
    created_by: USER,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

const expired = () => new Date(Date.now() - 1000).toISOString();

function conn(overrides: Partial<IGitConnectionRow> = {}): IGitConnectionRow {
  return {
    id: CONN_ID,
    organization_id: ORG,
    provider: 'gitlab',
    host: 'gitlab.example.com',
    external_account_id: '42',
    installation_id: null,
    account_login: 'acme',
    account_name: 'Acme',
    account_type: 'Group',
    avatar_url: null,
    account_url: null,
    credential_id: 'cred-1',
    repository_selection: 'selected',
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
    provider: 'gitlab',
    host: 'gitlab.example.com',
    external_id: '100',
    full_name: 'acme/api',
    web_url: 'https://gitlab.example.com/acme/api',
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

function makeCore() {
  return {
    isOrgAdmin: jest.fn().mockResolvedValue(true),
    getConnection: jest.fn().mockResolvedValue(conn()),
    listConnections: jest.fn().mockResolvedValue([]),
    listAllLive: jest.fn().mockResolvedValue([]),
    upsertConnection: jest.fn(),
    setCredential: jest.fn().mockResolvedValue(undefined),
    setStatus: jest.fn().mockResolvedValue(true),
    listRepositories: jest.fn().mockResolvedValue([]),
    upsertRepositories: jest.fn().mockResolvedValue(undefined),
    updateRepositoryWebhook: jest.fn().mockResolvedValue(undefined),
    findRepositoryById: jest.fn().mockResolvedValue(null),
    recordDelivery: jest.fn().mockResolvedValue(true),
    setDeliveryOutcome: jest.fn().mockResolvedValue(undefined),
    forgetDelivery: jest.fn().mockResolvedValue(undefined),
    patchRepository: jest.fn().mockResolvedValue(undefined),
  };
}

/** The built-in-like app the servers mock resolves by default (ticket 11). */
const APP = {
  serverId: null,
  provider: 'gitlab' as const,
  host: 'gitlab.example.com',
  webUrl: 'https://gitlab.example.com',
  apiUrl: 'https://gitlab.example.com/api/v4',
  clientId: 'cid',
  clientSecret: 'csecret',
};

/**
 * The client mocks record calls WITHOUT the leading app argument (so path / token assertions stay
 * readable); `apps` records the app of every call and `wrapped` is what the service receives.
 */
function makeClient() {
  const inner = {
    exchangeCode: jest.fn(),
    refresh: jest.fn(),
    revoke: jest.fn().mockResolvedValue(undefined),
    api: jest.fn(),
    paginate: jest.fn().mockResolvedValue([]),
  };
  const apps: unknown[] = [];
  const wrapped = Object.fromEntries(
    Object.entries(inner).map(([name, fn]) => [
      name,
      (app: unknown, ...rest: unknown[]) => {
        apps.push(app);

        return (fn as jest.Mock)(...rest);
      },
    ]),
  );

  return { ...inner, apps, wrapped };
}

function makeServers() {
  return {
    appFor: jest.fn().mockResolvedValue(APP),
    appForStart: jest.fn().mockResolvedValue(APP),
    isBuiltinConfigured: jest.fn().mockReturnValue(true),
    touchWebhookByHost: jest.fn().mockResolvedValue(undefined),
  };
}

function setup(handler?: (call: ICall) => Result) {
  const core = makeCore();
  const client = makeClient();
  const servers = makeServers();
  const db = makeDb(handler);
  const pullRequests = {
    syncBranch: jest.fn().mockResolvedValue(undefined),
    commitLinkingEnabled: jest.fn().mockResolvedValue(false),
    syncCommits: jest.fn().mockResolvedValue(0),
    syncBuilds: jest.fn().mockResolvedValue(0),
    sync: jest
      .fn<
        Promise<IGitPullRequestSyncResult>,
        [IGitRepositoryRow, IProviderPullRequest]
      >()
      .mockResolvedValue({
        pullRequestId: 'pr-1',
        applied: true,
        linked: [],
        removed: [],
      }),
  };
  const svc = new GitlabIntegrationService(
    core as never,
    client.wrapped as never,
    { getClient: () => db.client } as never,
    { get: () => 'https://api.example.com/api/v1' } as never,
    pullRequests as never,
    servers as never,
  );

  svc.delay = jest.fn().mockResolvedValue(undefined);

  return { svc, core, client, db, pullRequests, servers };
}

const params = (url: string) => new URL(url).searchParams;
const user = { userId: USER, organizationId: ORG } as never;

describe('GitlabIntegrationService', () => {
  describe('connectUrl', () => {
    it('builds the authorize URL with scope api and a gitlab state', async () => {
      const { svc } = setup();
      const url = new URL(await svc.connectUrl(USER, ORG, RETURN_TO));

      expect(url.origin + url.pathname).toBe(
        'https://gitlab.example.com/oauth/authorize',
      );
      expect(url.searchParams.get('scope')).toBe('api');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://api.example.com/api/v1/git-integrations/gitlab/callback',
      );
    });
  });

  describe('handleCallback', () => {
    const state = (connectionId?: string) =>
      createState(
        USER,
        ORG,
        stateProviderTag('gitlab', connectionId),
        RETURN_TO,
      );

    it('bad state or another provider -> expired', async () => {
      const { svc } = setup();

      expect(
        params(await svc.handleCallback({ code: 'c', state: 'garbage' })).get(
          'error',
        ),
      ).toBe('expired');
      expect(
        params(
          await svc.handleCallback({
            code: 'c',
            state: createState(USER, ORG, 'git:github', RETURN_TO),
          }),
        ).get('error'),
      ).toBe('expired');
    });

    it('passes a provider error through, capped at 50 chars', async () => {
      const { svc } = setup();
      const url = await svc.handleCallback({
        state: state(),
        error: 'access_denied' + 'x'.repeat(100),
      });

      expect(params(url).get('error')).toHaveLength(50);
    });

    it('non-admin -> forbidden, no exchange', async () => {
      const { svc, core, client } = setup();
      core.isOrgAdmin.mockResolvedValue(false);

      expect(
        params(await svc.handleCallback({ code: 'c', state: state() })).get(
          'error',
        ),
      ).toBe('forbidden');
      expect(client.exchangeCode).not.toHaveBeenCalled();
    });

    it('failed exchange -> exchange_failed', async () => {
      const { svc, client } = setup();
      client.exchangeCode.mockRejectedValue(
        new GitlabApiError(400, 'bad', 'invalid_grant'),
      );

      expect(
        params(await svc.handleCallback({ code: 'c', state: state() })).get(
          'error',
        ),
      ).toBe('exchange_failed');
    });

    it('stores an encrypted credential and redirects with credential=<id>', async () => {
      const { svc, client, db } = setup((call) =>
        kind(call) === 'insert' ? { data: { id: 'cred-new' } } : {},
      );
      client.exchangeCode.mockResolvedValue({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      client.api.mockResolvedValue({ id: 9, username: 'alice' });

      const url = await svc.handleCallback({ code: 'c', state: state() });

      expect(params(url).get('credential')).toBe('cred-new');
      const insert = db.calls
        .find((c) => kind(c) === 'insert')!
        .ops.find(([op]) => op === 'insert')![1] as Record<string, string>;
      expect(insert).toMatchObject({
        organization_id: ORG,
        provider: 'gitlab',
        host: 'gitlab.example.com',
        external_user_id: '9',
        external_login: 'alice',
        created_by: USER,
      });
      expect(
        JSON.parse(
          decryptApiKey(
            insert.encrypted_secret,
            insert.encryption_iv,
            insert.encryption_tag,
          ),
        ),
      ).toEqual({
        access_token: 'at',
        refresh_token: 'rt',
      });
    });

    it('reconnect: swaps the credential, recovers status, repairs missing hooks', async () => {
      const { svc, core, client } = setup((call) =>
        kind(call) === 'insert'
          ? { data: { id: 'cred-new' } }
          : kind(call) === 'select'
            ? { data: cred({ id: 'cred-new' }) }
            : {},
      );
      const attention = conn({
        status: 'needs_attention',
        status_reason: 'authorization_expired',
      });
      core.getConnection.mockResolvedValue(attention);
      core.listRepositories.mockResolvedValue([
        repo(),
        repo({ id: 'repo-2', webhook_id: '5' }),
        repo({ id: 'repo-3', is_enabled: false }),
      ]);
      client.exchangeCode.mockResolvedValue({
        accessToken: 'at-new',
        refreshToken: 'rt',
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      client.api.mockImplementation((path: string) =>
        Promise.resolve(
          path === '/user'
            ? { id: 9, username: 'alice' }
            : path.endsWith('/hooks')
              ? { id: 77 }
              : path.includes('/members/all/')
                ? { access_level: 40 }
                : { id: 42 },
        ),
      );

      const url = await svc.handleCallback({
        code: 'c',
        state: state(CONN_ID),
      });

      expect(params(url).get('connected')).toBe('gitlab');
      expect(client.api).toHaveBeenCalledWith(
        '/groups/42/members/all/9',
        'at-new',
      );
      expect(core.getConnection).toHaveBeenCalledWith(ORG, CONN_ID);
      expect(core.setCredential).toHaveBeenCalledWith(
        attention,
        'cred-new',
        USER,
      );
      expect(core.setStatus).toHaveBeenCalledWith(
        attention,
        'active',
        'authorization_expired',
        USER,
      );
      const hookPosts = client.api.mock.calls.filter(([path]) =>
        String(path).endsWith('/hooks'),
      );
      expect(hookPosts).toHaveLength(1);
      expect(hookPosts[0][0]).toBe('/projects/100/hooks');
      expect(core.updateRepositoryWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'repo-1' }),
        expect.objectContaining({ webhook_id: '77' }),
      );
    });

    it('reconnect: group not reachable with the new sign-in -> group_not_accessible, nothing stored', async () => {
      const { svc, core, client, db } = setup();
      client.exchangeCode.mockResolvedValue({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      client.api.mockImplementation((path: string) =>
        path === '/user'
          ? Promise.resolve({ id: 9, username: 'alice' })
          : Promise.reject(new GitlabApiError(404, 'not found')),
      );

      const url = await svc.handleCallback({
        code: 'c',
        state: state(CONN_ID),
      });

      expect(params(url).get('error')).toBe('group_not_accessible');
      expect(db.calls.some((c) => kind(c) === 'insert')).toBe(false);
      expect(core.setCredential).not.toHaveBeenCalled();
    });

    it('reconnect: a personal space signed in again by someone else -> group_not_accessible, nothing stored', async () => {
      const { svc, core, client, db } = setup();
      core.getConnection.mockResolvedValue(
        conn({ account_type: 'User', account_login: 'alice' }),
      );
      client.exchangeCode.mockResolvedValue({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      client.api.mockResolvedValue({ id: 10, username: 'bob' });

      const url = await svc.handleCallback({
        code: 'c',
        state: state(CONN_ID),
      });

      expect(params(url).get('error')).toBe('group_not_accessible');
      expect(db.calls.some((c) => kind(c) === 'insert')).toBe(false);
      expect(core.setCredential).not.toHaveBeenCalled();
    });

    it('reconnect: a visible (e.g. public) group the user does not maintain -> maintainer_required, nothing stored', async () => {
      const { svc, core, client, db } = setup();
      client.exchangeCode.mockResolvedValue({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      client.api.mockImplementation((path: string) =>
        path === '/user'
          ? Promise.resolve({ id: 9, username: 'alice' })
          : path.includes('/members/all/')
            ? Promise.reject(new GitlabApiError(404, 'not a member'))
            : Promise.resolve({ id: 42 }),
      );

      const url = await svc.handleCallback({
        code: 'c',
        state: state(CONN_ID),
      });

      expect(params(url).get('error')).toBe('maintainer_required');
      expect(db.calls.some((c) => kind(c) === 'insert')).toBe(false);
      expect(core.setCredential).not.toHaveBeenCalled();
    });

    it('reconnect: revokes and deletes the previous credential when nothing else uses it, keeps it when shared', async () => {
      const run = async (others: IGitConnectionRow[]) => {
        const ctx = setup((call) =>
          kind(call) === 'insert'
            ? { data: { id: 'cred-new' } }
            : kind(call) === 'select'
              ? { data: cred({ id: 'cred-1' }, 'at-previous') }
              : {},
        );
        ctx.core.getConnection.mockResolvedValue(
          conn({ credential_id: 'cred-1' }),
        );
        ctx.core.listConnections.mockResolvedValue(others);
        ctx.client.exchangeCode.mockResolvedValue({
          accessToken: 'at-new',
          refreshToken: 'rt',
          expiresAt: '2030-01-01T00:00:00.000Z',
        });
        ctx.client.api.mockImplementation((path: string) =>
          Promise.resolve(
            path === '/user'
              ? { id: 9, username: 'alice' }
              : path.includes('/members/all/')
                ? { access_level: 50 }
                : { id: 42 },
          ),
        );

        expect(
          params(
            await ctx.svc.handleCallback({ code: 'c', state: state(CONN_ID) }),
          ).get('connected'),
        ).toBe('gitlab');

        return ctx;
      };

      const unused = await run([conn({ credential_id: 'cred-new' })]);
      expect(unused.client.revoke).toHaveBeenCalledWith('at-previous');
      const del = unused.db.calls.find((c) => kind(c) === 'delete')!;
      expect(
        has(del, 'eq', 'id', 'cred-1') &&
          has(del, 'eq', 'organization_id', ORG),
      ).toBe(true);

      const shared = await run([
        conn({ id: 'other', credential_id: 'cred-1' }),
      ]);
      expect(shared.client.revoke).not.toHaveBeenCalled();
      expect(shared.db.calls.some((c) => kind(c) === 'delete')).toBe(false);
    });
  });

  describe('loadCredential (via listGroups)', () => {
    it('rejects a credential created by another user', async () => {
      const { svc } = setup(() => ({
        data: cred({ created_by: 'someone-else' }),
      }));

      await expect(svc.listGroups(user, 'cred-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a credential of another organization', async () => {
      const { svc } = setup(() => ({
        data: cred({ organization_id: 'other-org' }),
      }));

      await expect(svc.listGroups(user, 'cred-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('filters the lookup on id, org and creator, and flags already-connected groups', async () => {
      const { svc, core, client, db } = setup(() => ({ data: cred() }));
      client.paginate.mockResolvedValue([
        { id: 42, full_path: 'acme', name: 'Acme', avatar_url: null },
        { id: 43, full_path: 'beta', name: 'Beta', avatar_url: null },
      ]);
      core.listConnections.mockResolvedValue([
        conn(),
        conn({ id: 'x', external_account_id: '43', status: 'needs_attention' }),
      ]);

      const groups = await svc.listGroups(user, 'cred-1', 'ac');

      const lookup = db.calls[0];
      expect(
        has(lookup, 'eq', 'id', 'cred-1') &&
          has(lookup, 'eq', 'organization_id', ORG) &&
          has(lookup, 'eq', 'created_by', USER),
      ).toBe(true);
      expect(client.paginate).toHaveBeenCalledWith(
        '/groups?min_access_level=40&order_by=name&search=ac',
        'at-old',
        5,
      );
      expect(groups.map((g) => [g.id, g.alreadyConnected])).toEqual([
        ['42', true],
        ['43', false],
      ]);
    });
  });

  describe('connectGroup', () => {
    const group = {
      id: 42,
      full_path: 'acme',
      name: 'Acme',
      avatar_url: null,
      web_url: 'https://gitlab.example.com/groups/acme',
    };

    it('connects a group the authorizing user maintains', async () => {
      const { svc, core, client } = setup(() => ({ data: cred() }));
      client.api.mockImplementation((path: string) =>
        Promise.resolve(
          path.includes('/members/all/') ? { access_level: 40 } : group,
        ),
      );
      core.upsertConnection.mockResolvedValue({
        connection: conn(),
        created: true,
      });

      await svc.connectGroup(user, 'cred-1', '42');

      expect(core.upsertConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG,
          provider: 'gitlab',
          credentialId: 'cred-1',
          account: expect.objectContaining({
            externalAccountId: '42',
            type: 'Group',
          }),
        }),
      );
    });

    it('refuses a group where the user is below Maintainer', async () => {
      const { svc, core, client } = setup(() => ({ data: cred() }));
      client.api.mockImplementation((path: string) =>
        Promise.resolve(
          path.includes('/members/all/') ? { access_level: 30 } : group,
        ),
      );

      await expect(
        svc.connectGroup(user, 'cred-1', '42'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(core.upsertConnection).not.toHaveBeenCalled();
    });

    it('refuses a public group the user is not a member of', async () => {
      const { svc, core, client } = setup(() => ({ data: cred() }));
      client.api.mockImplementation((path: string) =>
        path.includes('/members/all/')
          ? Promise.reject(new GitlabApiError(404, 'not found'))
          : Promise.resolve(group),
      );

      await expect(
        svc.connectGroup(user, 'cred-1', '42'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(core.upsertConnection).not.toHaveBeenCalled();
    });
  });

  describe('personal GitLab space', () => {
    const own = {
      id: 7,
      kind: 'user',
      full_path: 'alice',
      name: 'Alice',
      avatar_url: null,
      web_url: 'https://gitlab.example.com/alice',
    };

    it("lists the user's own space first, and only when it matches the search", async () => {
      const { svc, client } = setup(() => ({ data: cred() }));
      client.paginate.mockResolvedValue([
        { id: 42, full_path: 'acme', name: 'Acme', avatar_url: null },
      ]);
      client.api.mockResolvedValue(own);

      const all = await svc.listGroups(user, 'cred-1');
      const searched = await svc.listGroups(user, 'cred-1', 'acme');

      expect(client.api).toHaveBeenCalledWith(
        '/namespaces/alice',
        expect.any(String),
      );
      expect(all.map((g) => g.id)).toEqual(['7', '42']);
      expect(searched.map((g) => g.id)).toEqual(['42']);
    });

    it("connects the user's own space as User, without a Maintainer check", async () => {
      const { svc, core, client } = setup(() => ({ data: cred() }));
      client.api.mockResolvedValue(own);
      core.upsertConnection.mockResolvedValue({
        connection: conn({ account_type: 'User', account_login: 'alice' }),
        created: true,
      });

      await svc.connectGroup(user, 'cred-1', '7');

      const [input] = core.upsertConnection.mock.calls[0] as [
        { account: { externalAccountId: string; login: string; type: string } },
      ];

      expect([
        input.account.externalAccountId,
        input.account.login,
        input.account.type,
      ]).toEqual(['7', 'alice', 'User']);
      expect(
        client.api.mock.calls.some(([path]) =>
          String(path).includes('/members/all/'),
        ),
      ).toBe(false);
    });

    it("treats another id as a group, so someone else's space is refused", async () => {
      const { svc, core, client } = setup(() => ({ data: cred() }));
      client.api.mockImplementation((path: string) =>
        path === '/namespaces/alice'
          ? Promise.resolve(own)
          : Promise.reject(new GitlabApiError(404, 'not found')),
      );

      await expect(
        svc.connectGroup(user, 'cred-1', '8'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(core.upsertConnection).not.toHaveBeenCalled();
    });

    it('syncs the projects of a personal space from the user endpoint', async () => {
      const { svc, client } = setup(() => ({ data: cred() }));

      await svc.refreshRepositories(
        conn({ account_type: 'User', account_login: 'alice' }),
      );

      expect(client.paginate).toHaveBeenCalledWith(
        '/users/alice/projects',
        expect.any(String),
        expect.any(Number),
      );
    });
  });

  describe('getAccessToken', () => {
    it('uses a still-valid token without refreshing', async () => {
      const { svc, client } = setup(() => ({ data: cred() }));
      client.paginate.mockResolvedValue([]);

      await svc.listGroups(user, 'cred-1');

      expect(client.refresh).not.toHaveBeenCalled();
      expect(client.paginate).toHaveBeenCalledWith(
        expect.any(String),
        'at-old',
        5,
      );
    });

    it('lease winner refreshes and stores the rotated tokens', async () => {
      const { svc, client, db } = setup((call) => {
        if (
          kind(call) === 'update' &&
          has(call, 'is', 'refresh_lease_until', null)
        )
          return { data: [{ id: 'cred-1' }] };
        if (kind(call) === 'select')
          return { data: cred({ expires_at: expired() }) };

        return {};
      });
      client.refresh.mockResolvedValue({
        accessToken: 'at-new',
        refreshToken: 'rt-new',
        expiresAt: '2030-01-01T00:00:00.000Z',
      });

      await svc.listGroups(user, 'cred-1');

      expect(client.refresh).toHaveBeenCalledWith(
        'rt-old',
        'https://api.example.com/api/v1/git-integrations/gitlab/callback',
      );
      expect(client.paginate).toHaveBeenCalledWith(
        expect.any(String),
        'at-new',
        5,
      );
      const store = db.calls.find(
        (c) =>
          kind(c) === 'update' &&
          c.ops.some(
            ([op, v]) =>
              op === 'update' &&
              (v as Record<string, unknown>).encrypted_secret,
          ),
      )!;
      const patch = store.ops.find(([op]) => op === 'update')![1] as Record<
        string,
        string | null
      >;
      expect(patch).toMatchObject({
        expires_at: '2030-01-01T00:00:00.000Z',
        refresh_lease_until: null,
        status: 'active',
      });
      expect(
        JSON.parse(
          decryptApiKey(
            patch.encrypted_secret!,
            patch.encryption_iv!,
            patch.encryption_tag!,
          ),
        ),
      ).toEqual({
        access_token: 'at-new',
        refresh_token: 'rt-new',
      });
      expect(has(store, 'eq', 'organization_id', ORG)).toBe(true);
    });

    it('lease loser waits and reads back the token the winner stored', async () => {
      let reads = 0;
      const { svc, client } = setup((call) => {
        if (kind(call) === 'update') return { data: [] };
        reads += 1;

        // 1: loadCredential (expired), 2: re-read after the wait (renewed by someone else).
        return {
          data:
            reads === 1
              ? cred({ expires_at: expired() })
              : cred({}, 'at-winner', 'rt-winner'),
        };
      });

      await svc.listGroups(user, 'cred-1');

      expect(client.refresh).not.toHaveBeenCalled();
      expect(svc.delay).toHaveBeenCalledTimes(1);
      expect(client.paginate).toHaveBeenCalledWith(
        expect.any(String),
        'at-winner',
        5,
      );
    });

    it('invalid_grant marks the credential invalid and every connection using it needs attention', async () => {
      const { svc, core, client, db } = setup((call) => {
        if (
          kind(call) === 'update' &&
          has(call, 'is', 'refresh_lease_until', null)
        )
          return { data: [{ id: 'cred-1' }] };
        if (kind(call) === 'select')
          return { data: cred({ expires_at: expired() }) };

        return {};
      });
      const a = conn({ id: 'a' });
      const b = conn({ id: 'b' });
      core.listConnections.mockResolvedValue([
        a,
        b,
        conn({ id: 'c', credential_id: 'cred-other' }),
      ]);
      client.refresh.mockRejectedValue(
        new GitlabApiError(400, 'invalid', 'invalid_grant'),
      );

      await expect(svc.listGroups(user, 'cred-1')).rejects.toBeInstanceOf(
        GitlabApiError,
      );

      expect(
        db.calls.some(
          (c) =>
            has(c, 'update', { status: 'invalid' }) &&
            has(c, 'eq', 'organization_id', ORG),
        ),
      ).toBe(true);
      expect(
        core.setStatus.mock.calls.map(([c, to, reason]) => [c.id, to, reason]),
      ).toEqual([
        ['a', 'needs_attention', 'authorization_expired'],
        ['b', 'needs_attention', 'authorization_expired'],
      ]);
    });
  });

  describe('applyRepositorySelection', () => {
    it('creates hooks per project; a 403 is stored as forbidden and the next project still succeeds', async () => {
      const { svc, core, client } = setup(() => ({ data: cred() }));
      client.api
        .mockRejectedValueOnce(new GitlabApiError(403, 'forbidden'))
        .mockResolvedValueOnce({ id: 7 });

      await svc.applyRepositorySelection(
        conn(),
        [repo(), repo({ id: 'repo-2', external_id: '200' })],
        [],
      );

      expect(client.api).toHaveBeenCalledWith(
        '/projects/200/hooks',
        'at-old',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            url: 'https://api.example.com/api/v1/git-integrations/gitlab/webhook/repo-2',
            push_events: true,
            enable_ssl_verification: true,
          }),
        }),
      );
      expect(core.updateRepositoryWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'repo-1' }),
        { webhook_error: 'forbidden' },
      );
      const [, patch] = core.updateRepositoryWebhook.mock.calls[1];
      expect(patch).toMatchObject({ webhook_id: '7', webhook_error: null });
      // The stored secret is the token GitLab was given.
      const sent = (client.api.mock.calls[1][2] as { body: { token: string } })
        .body.token;
      expect(
        decryptApiKey(
          patch.webhook_secret_encrypted,
          patch.webhook_secret_iv,
          patch.webhook_secret_tag,
        ),
      ).toBe(sent);
    });

    describe('the webhook address', () => {
      const withConfig = (
        svc: GitlabIntegrationService,
        values: Record<string, string | undefined>,
      ) => {
        Object.assign(svc, { config: { get: (key: string) => values[key] } });

        return jest.spyOn(
          (svc as unknown as { logger: { warn: () => void } }).logger,
          'warn',
        );
      };
      const hookPosts = (api: jest.Mock) =>
        (api.mock.calls as unknown[][]).filter(([path]) =>
          String(path).endsWith('/hooks'),
        );

      it('uses GIT_WEBHOOK_PUBLIC_URL for the hook and keeps PUBLIC_API_URL for sign-in', async () => {
        const { svc, client } = setup(() => ({ data: cred() }));
        withConfig(svc, {
          publicApiUrl: 'http://localhost:3001/api/v1',
          gitWebhookPublicUrl: 'https://hooks.example.com/api/v1/',
        });
        client.api.mockResolvedValue({ id: 9 });

        await svc.applyRepositorySelection(conn(), [repo()], []);

        expect(client.api).toHaveBeenCalledWith(
          '/projects/100/hooks',
          'at-old',
          expect.objectContaining({
            body: expect.objectContaining({
              url: 'https://hooks.example.com/api/v1/git-integrations/gitlab/webhook/repo-1',
            }) as object,
          }),
        );
      });

      it('does not ask gitlab.com to call a localhost address, records it once and warns once', async () => {
        const { svc, client, core } = setup(() => ({ data: cred() }));
        const warn = withConfig(svc, {
          publicApiUrl: 'http://localhost:3001/api/v1',
        });

        await svc.applyRepositorySelection(
          conn({ host: 'gitlab.com' }),
          [
            repo(),
            repo({
              id: 'repo-2',
              external_id: '200',
              webhook_error: 'invalid_url',
            }),
          ],
          [],
        );
        await svc.applyRepositorySelection(
          conn({ host: 'gitlab.com' }),
          [repo({ webhook_error: 'invalid_url' })],
          [],
        );

        expect(hookPosts(client.api)).toHaveLength(0);
        expect(core.updateRepositoryWebhook).toHaveBeenCalledTimes(1);
        expect(core.updateRepositoryWebhook).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'repo-1' }),
          { webhook_error: 'invalid_url' },
        );
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String((warn.mock.calls as unknown[][])[0][0])).toContain(
          'GIT_WEBHOOK_PUBLIC_URL',
        );
      });

      it('still tries a self-managed GitLab, which may reach a private address', async () => {
        const { svc, client } = setup(() => ({ data: cred() }));
        withConfig(svc, { publicApiUrl: 'http://localhost:3001/api/v1' });
        client.api.mockResolvedValue({ id: 9 });

        await svc.applyRepositorySelection(conn(), [repo()], []);

        expect(hookPosts(client.api)).toHaveLength(1);
      });

      it('logs and stores a failure only when it is new', async () => {
        const { svc, client, core } = setup(() => ({ data: cred() }));
        const warn = withConfig(svc, {
          publicApiUrl: 'https://api.example.com/api/v1',
        });
        client.api.mockRejectedValue(new GitlabApiError(403, 'forbidden'));

        await svc.applyRepositorySelection(
          conn(),
          [repo({ webhook_error: 'forbidden' })],
          [],
        );

        expect(warn).not.toHaveBeenCalled();
        expect(core.updateRepositoryWebhook).not.toHaveBeenCalled();

        await svc.applyRepositorySelection(
          conn(),
          [repo({ webhook_error: 'not_found' })],
          [],
        );

        expect(warn).toHaveBeenCalledTimes(1);
        expect(core.updateRepositoryWebhook).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'repo-1' }),
          { webhook_error: 'forbidden' },
        );
      });
    });

    it('deletes hooks of disabled projects; 404 counts as done, other errors keep the hook', async () => {
      const { svc, core, client } = setup(() => ({ data: cred() }));
      client.api
        .mockRejectedValueOnce(new GitlabApiError(404, 'gone'))
        .mockRejectedValueOnce(new GitlabApiError(500, 'boom'));

      await svc.applyRepositorySelection(
        conn(),
        [],
        [
          repo({ webhook_id: '5' }),
          repo({ id: 'repo-2', external_id: '200', webhook_id: '6' }),
        ],
      );

      expect(client.api).toHaveBeenCalledWith(
        '/projects/100/hooks/5',
        'at-old',
        { method: 'DELETE' },
      );
      expect(core.updateRepositoryWebhook).toHaveBeenCalledTimes(1);
      expect(core.updateRepositoryWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'repo-1' }),
        expect.objectContaining({ webhook_id: null }),
      );
    });
  });

  describe('onDisconnect', () => {
    it('removes hooks, revokes and deletes a credential no other connection uses', async () => {
      const { svc, core, client, db } = setup(() => ({ data: cred() }));
      core.listRepositories.mockResolvedValue([
        repo({ webhook_id: '5' }),
        repo({ id: 'repo-2' }),
      ]);
      client.api.mockResolvedValue(undefined);

      await svc.onDisconnect(conn());

      expect(client.api).toHaveBeenCalledTimes(1);
      expect(client.revoke).toHaveBeenCalledWith('at-old');
      const del = db.calls.find((c) => kind(c) === 'delete')!;
      expect(
        has(del, 'eq', 'id', 'cred-1') &&
          has(del, 'eq', 'organization_id', ORG),
      ).toBe(true);
    });

    it('keeps a credential another live connection still uses', async () => {
      const { svc, core, client, db } = setup(() => ({ data: cred() }));
      core.listConnections.mockResolvedValue([conn({ id: 'other' })]);

      await svc.onDisconnect(conn());

      expect(client.revoke).not.toHaveBeenCalled();
      expect(db.calls.some((c) => kind(c) === 'delete')).toBe(false);
    });
  });

  describe('checkHealth', () => {
    it('sweeps unattached credentials, recovers a healthy one and syncs "all" connections', async () => {
      const { svc, core, client, db } = setup((call) => {
        if (call.table === 'git_connections')
          return { data: [{ credential_id: 'cred-1' }] };
        if (call.ops.some(([op, col]) => op === 'lt' && col === 'created_at'))
          return {
            data: [
              { id: 'cred-1', organization_id: ORG },
              { id: 'stale-a', organization_id: ORG },
              { id: 'stale-b', organization_id: 'org-2' },
            ],
          };

        return { data: cred() };
      });
      const recovering = conn({
        status: 'needs_attention',
        status_reason: 'authorization_expired',
        repository_selection: 'all',
      });
      const noCredential = conn({ id: 'x', credential_id: null });
      core.listAllLive.mockResolvedValue([recovering, noCredential]);
      client.api.mockResolvedValue({ id: 9 });

      await svc.checkHealth();

      const deletes = db.calls.filter((c) => kind(c) === 'delete');
      expect(deletes).toHaveLength(2);
      expect(
        has(deletes[0], 'in', 'id', ['stale-a']) &&
          has(deletes[0], 'eq', 'organization_id', ORG),
      ).toBe(true);
      expect(
        has(deletes[1], 'in', 'id', ['stale-b']) &&
          has(deletes[1], 'eq', 'organization_id', 'org-2'),
      ).toBe(true);
      expect(core.setStatus).toHaveBeenCalledWith(
        noCredential,
        'needs_attention',
        'authorization_expired',
      );
      expect(core.setStatus).toHaveBeenCalledWith(
        recovering,
        'active',
        'authorization_expired',
      );
      expect(client.paginate).toHaveBeenCalledWith(
        '/groups/42/projects?include_subgroups=true&with_shared=false',
        'at-old',
        50,
      );
    });

    it('a 5xx keeps the status; a 401 flags every connection of the credential', async () => {
      const { svc, core, client } = setup((call) =>
        call.table === 'git_connections' ? { data: [] } : { data: cred() },
      );
      core.listAllLive.mockResolvedValue([conn()]);
      client.api.mockRejectedValueOnce(new GitlabApiError(503, 'down'));

      await svc.checkHealth();
      expect(core.setStatus).not.toHaveBeenCalled();

      client.api.mockRejectedValueOnce(new GitlabApiError(401, 'revoked'));
      await svc.checkHealth();
      expect(core.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: CONN_ID }),
        'needs_attention',
        'authorization_expired',
      );
    });
  });

  describe('credential sweep chunking', () => {
    it('checks references and deletes in chunks of 100', async () => {
      const candidates = Array.from({ length: 250 }, (_, i) => ({
        id: `c${i}`,
        organization_id: ORG,
      }));
      const { svc, db } = setup((call) => {
        if (call.table === 'git_connections') {
          const ids = call.ops.find(([op]) => op === 'in')![2] as string[];

          return { data: ids.includes('c0') ? [{ credential_id: 'c0' }] : [] };
        }
        if (call.ops.some(([op, col]) => op === 'lt' && col === 'created_at'))
          return { data: candidates };

        return { data: [] };
      });

      await svc.checkHealth();

      const lookups = db.calls.filter((c) => c.table === 'git_connections');
      expect(
        lookups.map(
          (c) => (c.ops.find(([op]) => op === 'in')![2] as string[]).length,
        ),
      ).toEqual([100, 100, 50]);
      const deleted = db.calls
        .filter((c) => kind(c) === 'delete')
        .map((c) => c.ops.find(([op]) => op === 'in')![2] as string[]);
      expect(deleted.map((ids) => ids.length)).toEqual([99, 100, 50]);
      expect(deleted.flat()).not.toContain('c0');
    });
  });

  describe('handleWebhook', () => {
    const secret = 's'.repeat(64);
    const hooked = (overrides: Partial<IGitRepositoryRow> = {}) => {
      const e = encryptApiKey(secret);

      return repo({
        webhook_id: '5',
        webhook_secret_encrypted: e.encrypted,
        webhook_secret_iv: e.iv,
        webhook_secret_tag: e.tag,
        ...overrides,
      });
    };
    const body = (value: unknown) => Buffer.from(JSON.stringify(value));

    it('unknown repository -> unauthorized', async () => {
      const { svc } = setup();

      expect(
        await svc.handleWebhook({ repositoryId: 'nope', token: secret }),
      ).toBe('unauthorized');
    });

    it('wrong or missing token -> unauthorized, nothing recorded', async () => {
      const { svc, core } = setup();
      core.findRepositoryById.mockResolvedValue(hooked());

      expect(
        await svc.handleWebhook({ repositoryId: 'repo-1', token: 'wrong' }),
      ).toBe('unauthorized');
      expect(
        await svc.handleWebhook({
          repositoryId: 'repo-1',
          token: 'x'.repeat(64),
        }),
      ).toBe('unauthorized');
      expect(await svc.handleWebhook({ repositoryId: 'repo-1' })).toBe(
        'unauthorized',
      );
      expect(core.recordDelivery).not.toHaveBeenCalled();
    });

    it('duplicate event uuid is skipped', async () => {
      const { svc, core } = setup();
      core.findRepositoryById.mockResolvedValue(hooked());
      core.recordDelivery.mockResolvedValue(false);

      expect(
        await svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          event: 'Push Hook',
          eventUuid: 'u1',
        }),
      ).toBe('ok');
      expect(core.recordDelivery).toHaveBeenCalledWith(
        'gitlab',
        'repo-1:u1',
        'Push Hook',
      );
      expect(core.getConnection).not.toHaveBeenCalled();
    });

    it('disabled repository -> ignored_disabled', async () => {
      const { svc, core } = setup();
      core.findRepositoryById.mockResolvedValue(hooked({ is_enabled: false }));

      expect(
        await svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          eventUuid: 'u2',
          rawBody: body({}),
        }),
      ).toBe('ok');
      expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
        'gitlab',
        'repo-1:u2',
        'ignored_disabled',
      );
      expect(core.patchRepository).not.toHaveBeenCalled();
    });

    it('a renamed project is patched on the row', async () => {
      const { svc, core } = setup();
      core.findRepositoryById.mockResolvedValue(hooked());

      const outcome = await svc.handleWebhook({
        repositoryId: 'repo-1',
        token: secret,
        eventUuid: 'u3',
        rawBody: body({
          project: {
            path_with_namespace: 'acme/api-v2',
            web_url: 'https://gitlab.example.com/acme/api-v2',
          },
        }),
      });

      expect(outcome).toBe('ok');
      expect(core.getConnection).toHaveBeenCalledWith(ORG, CONN_ID);
      expect(core.patchRepository).toHaveBeenCalledWith(
        expect.objectContaining({ id: CONN_ID }),
        '100',
        {
          full_name: 'acme/api-v2',
          web_url: 'https://gitlab.example.com/acme/api-v2',
        },
      );
      expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
        'gitlab',
        'repo-1:u3',
        'ignored',
      );
    });

    it('a delivery that fails processing is forgotten so the retry is processed', async () => {
      const { svc, core } = setup();
      core.findRepositoryById.mockResolvedValue(hooked());
      core.getConnection.mockRejectedValue(new Error('db down'));

      expect(
        await svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          eventUuid: 'u4',
          rawBody: body({}),
        }),
      ).toBe('ok');
      expect(core.forgetDelivery).toHaveBeenCalledWith('gitlab', 'repo-1:u4');
      expect(core.setDeliveryOutcome).not.toHaveBeenCalled();
    });

    describe('merge requests (ticket 4)', () => {
      const hook = (
        attrs: Record<string, unknown> = {},
        extra: Record<string, unknown> = {},
      ) =>
        body({
          object_kind: 'merge_request',
          user: { id: 7, username: 'dev', avatar_url: 'av' },
          project: { path_with_namespace: 'acme/api' },
          object_attributes: {
            id: 555,
            iid: 12,
            title: 'XE-T1 and xe-t2',
            description: 'Fixes RM-T9',
            url: 'https://gitlab.example.com/acme/api/-/merge_requests/12',
            state: 'opened',
            action: 'open',
            draft: true,
            source_branch: 'XE-T656-git-integration',
            target_branch: 'main',
            source_project_id: 100,
            target_project_id: 100,
            author_id: 7,
            created_at: '2026-10-19 09:00:00 UTC',
            updated_at: '2026-10-19 10:00:00 UTC',
            ...attrs,
          },
          ...extra,
        });

      it('syncs a merge request hook, normalised', async () => {
        const { svc, core, pullRequests } = setup();
        core.findRepositoryById.mockResolvedValue(
          hooked({ full_name: 'acme/api' }),
        );

        await svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          eventUuid: 'm1',
          rawBody: hook(),
        });

        expect(pullRequests.sync).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'repo-1' }),
          {
            number: 12,
            externalId: '555',
            title: 'XE-T1 and xe-t2',
            url: 'https://gitlab.example.com/acme/api/-/merge_requests/12',
            state: 'open',
            isDraft: true,
            sourceBranch: 'XE-T656-git-integration',
            targetBranch: 'main',
            headRepoFullName: null,
            author: { externalId: '7', login: 'dev', avatarUrl: 'av' },
            openedAt: '2026-10-19T09:00:00.000Z',
            closedAt: null,
            mergedAt: null,
            updatedAt: '2026-10-19T10:00:00.000Z',
            body: 'Fixes RM-T9',
            mergeCommitShas: [],
            headSha: null,
          },
          { externalId: '7', login: 'dev' },
        );
        expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
          'gitlab',
          'repo-1:m1',
          'processed',
        );
      });

      it('merged state, fork source and an actor who is not the author', async () => {
        const { svc, core, pullRequests } = setup();
        core.findRepositoryById.mockResolvedValue(
          hooked({ full_name: 'acme/api' }),
        );

        await svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          rawBody: hook({
            state: 'merged',
            action: 'merge',
            source_project_id: 200,
            source: { path_with_namespace: 'fork/api' },
            author_id: 99,
          }),
        });

        expect(pullRequests.sync.mock.calls[0][1]).toMatchObject({
          state: 'merged',
          mergedAt: '2026-10-19T10:00:00.000Z',
          headRepoFullName: 'fork/api',
          author: { externalId: '99', login: null, avatarUrl: null },
        });
      });

      it('approval actions are processed (ticket 5); labels-only actions ignored; locked counts as open', async () => {
        const { svc, core, pullRequests } = setup();
        core.findRepositoryById.mockResolvedValue(
          hooked({ full_name: 'acme/api' }),
        );

        await svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          eventUuid: 'm2',
          rawBody: hook({ action: 'approved' }),
        });
        expect(pullRequests.sync).toHaveBeenCalledTimes(1);

        await svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          eventUuid: 'm3',
          rawBody: hook({ action: 'something_new' }),
        });
        expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
          'gitlab',
          'repo-1:m3',
          'ignored',
        );

        await svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          rawBody: hook({ state: 'locked', action: 'update' }),
        });
        expect(pullRequests.sync.mock.calls[1][1].state).toBe('open');
      });

      it('sends the verdicts: hook reviewers plus approvals from non-reviewers (ticket 5)', async () => {
        const { svc, core, client, pullRequests } = setup();
        (svc as unknown as { tokenFor: jest.Mock }).tokenFor = jest
          .fn()
          .mockResolvedValue('tok');
        core.findRepositoryById.mockResolvedValue(
          hooked({ full_name: 'acme/api' }),
        );
        client.api.mockResolvedValueOnce({
          approved_by: [{ user: { id: 50, username: 'lead' } }],
        });

        await svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          rawBody: hook(
            { action: 'update' },
            {
              reviewers: [
                { id: 7, username: 'dev', state: 'requested_changes' },
                { id: 8, username: 'qa', state: 'unreviewed' },
              ],
            },
          ),
        });

        expect(client.api).toHaveBeenCalledWith(
          '/projects/100/merge_requests/12/approvals',
          'tok',
        );
        expect(pullRequests.sync.mock.calls[0][1].reviews).toEqual([
          {
            reviewerId: '50',
            login: 'lead',
            state: 'approved',
            submittedAt: null,
          },
          {
            reviewerId: '7',
            login: 'dev',
            state: 'changes_requested',
            submittedAt: null,
          },
        ]);
      });

      it('a token problem still links; verdicts stay as stored (reviews undefined)', async () => {
        const { svc, core, pullRequests } = setup();
        (svc as unknown as { tokenFor: jest.Mock }).tokenFor = jest
          .fn()
          .mockRejectedValue(new Error('no authorization'));
        core.findRepositoryById.mockResolvedValue(
          hooked({ full_name: 'acme/api' }),
        );

        await svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          eventUuid: 'm4',
          rawBody: hook(),
        });

        expect(pullRequests.sync).toHaveBeenCalledTimes(1);
        expect(pullRequests.sync.mock.calls[0][1].reviews).toBeUndefined();
        expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
          'gitlab',
          'repo-1:m4',
          'processed',
        );
      });

      it.each([
        ['a push', 'abc123', false, '2026-10-19T09:00:00.000Z'],
        ['a new branch', 'abc123', false, '2026-10-19T09:00:00.000Z'],
        [
          'a deleted branch',
          '0000000000000000000000000000000000000000',
          true,
          null,
        ],
      ])(
        'push hook: %s (ticket 5)',
        async (_label, after, deleted, pushedAt) => {
          const { svc, core, pullRequests } = setup();
          core.findRepositoryById.mockResolvedValue(hooked());

          await svc.handleWebhook({
            repositoryId: 'repo-1',
            token: secret,
            rawBody: body({
              object_kind: 'push',
              ref: 'refs/heads/XE-T656-git',
              after,
              user_id: 5,
              user_username: 'pusher',
              commits: deleted
                ? []
                : [{ timestamp: '2026-10-19T11:00:00+02:00' }],
            }),
          });

          expect(pullRequests.syncBranch).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'repo-1' }),
            'XE-T656-git',
            pushedAt,
            deleted,
            { externalId: '5', login: 'pusher' },
          );
        },
      );

      it('push hook for a tag is ignored', async () => {
        const { svc, core, pullRequests } = setup();
        core.findRepositoryById.mockResolvedValue(hooked());

        await svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          eventUuid: 'p9',
          rawBody: body({
            object_kind: 'push',
            ref: 'refs/tags/v1',
            after: 'abc',
          }),
        });

        expect(pullRequests.syncBranch).not.toHaveBeenCalled();
        expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
          'gitlab',
          'repo-1:p9',
          'ignored',
        );
      });

      it('listKeyBranches keeps only branches with a task key, with the commit date', async () => {
        const { svc, client } = setup();
        (svc as unknown as { tokenFor: jest.Mock }).tokenFor = jest
          .fn()
          .mockResolvedValue('tok');
        client.paginate.mockResolvedValueOnce([
          { name: 'main', commit: { committed_date: '2026-10-01T00:00:00Z' } },
          {
            name: 'XE-T5-fix',
            commit: { committed_date: '2026-10-19T08:00:00Z' },
          },
        ]);

        await expect(
          svc.listKeyBranches(conn() as never, hooked() as never),
        ).resolves.toEqual([
          { name: 'XE-T5-fix', pushedAt: '2026-10-19T08:00:00.000Z' },
        ]);
        expect(client.paginate).toHaveBeenCalledWith(
          '/projects/100/repository/branches',
          'tok',
          10,
        );
      });

      it('reviewsFromGitlab maps requested_changes, ignores other states, uses the reviewers API shape', () => {
        expect(
          reviewsFromGitlab(
            [
              { user: { id: 1, username: 'a' }, state: 'approved' },
              { user: { id: 2, username: 'b' }, state: 'requested_changes' },
              { user: { id: 3, username: 'c' }, state: 'reviewed' },
            ],
            [{ user: { id: 2, username: 'b' } }],
          ),
        ).toEqual([
          {
            reviewerId: '2',
            login: 'b',
            state: 'changes_requested',
            submittedAt: null,
          },
          { reviewerId: '1', login: 'a', state: 'approved', submittedAt: null },
        ]);
      });

      it('a disabled project never syncs', async () => {
        const { svc, core, pullRequests } = setup();
        core.findRepositoryById.mockResolvedValue(
          hooked({ is_enabled: false }),
        );

        await svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          rawBody: hook(),
        });

        expect(pullRequests.sync).not.toHaveBeenCalled();
      });

      it('fetchPullRequest reads the API by project id and maps a 404', async () => {
        const { svc, client } = setup();
        (svc as unknown as { tokenFor: jest.Mock }).tokenFor = jest
          .fn()
          .mockResolvedValue('tok');
        client.api.mockResolvedValueOnce({
          id: 555,
          iid: 12,
          title: 't',
          description: null,
          web_url: 'u',
          state: 'closed',
          source_branch: 'b',
          target_branch: 'main',
          author: { id: 7, username: 'dev', avatar_url: null },
          created_at: '2026-10-19T09:00:00Z',
          updated_at: '2026-10-19T10:00:00Z',
          closed_at: '2026-10-19T10:00:00Z',
        });

        const pr = await svc.fetchPullRequest(
          conn() as never,
          hooked() as never,
          12,
        );

        expect(client.api).toHaveBeenCalledWith(
          '/projects/100/merge_requests/12',
          'tok',
        );
        expect(pr).toMatchObject({
          number: 12,
          state: 'closed',
          author: { login: 'dev' },
        });

        client.api.mockRejectedValueOnce(new GitlabApiError(404, 'nope'));
        await expect(
          svc.fetchPullRequest(conn() as never, hooked() as never, 13),
        ).rejects.toThrow('pull_request_not_found');
      });

      it('listRecentPullRequests merges open and recently updated lists by iid', async () => {
        const { svc, client } = setup();
        (svc as unknown as { tokenFor: jest.Mock }).tokenFor = jest
          .fn()
          .mockResolvedValue('tok');
        const mr = (iid: number, state = 'opened') => ({
          id: iid,
          iid,
          title: 't',
          description: null,
          web_url: 'u',
          state,
          source_branch: null,
          target_branch: null,
          author: null,
          created_at: null,
          updated_at: '2026-10-19T10:00:00Z',
        });
        client.paginate
          .mockResolvedValueOnce([mr(1), mr(2)])
          .mockResolvedValueOnce([mr(2), mr(3, 'merged')]);

        const result = await svc.listRecentPullRequests(
          conn() as never,
          hooked() as never,
          new Date('2026-09-19T00:00:00Z'),
        );

        expect((client.paginate.mock.calls as string[][])[0][0]).toContain(
          'state=opened',
        );
        expect((client.paginate.mock.calls as string[][])[1][0]).toContain(
          'updated_after=2026-09-19T00%3A00%3A00.000Z',
        );
        expect(result.map((pr) => pr.number).sort()).toEqual([1, 2, 3]);
      });
    });

    describe('commits (ticket 6)', () => {
      const BEFORE = 'b'.repeat(40);
      const AFTER = 'c'.repeat(40);
      const ZEROS = '0'.repeat(40);
      const hookCommit = (id: string, message: string) => ({
        id,
        message,
        timestamp: '2026-10-19T11:00:00+02:00',
        url: `https://gitlab.example.com/acme/api/-/commit/${id}`,
        author: { name: 'Dev', email: 'dev@example.com' },
      });
      const apiCommit = (id: string, message: string) => ({
        id,
        message,
        web_url: `https://gitlab.example.com/acme/api/-/commit/${id}`,
        author_name: 'Dev',
        author_email: 'dev@example.com',
        authored_date: '2026-10-18T09:00:00+02:00',
        committed_date: '2026-10-19T11:00:00+02:00',
      });
      const fromApi = (id: string, message: string) => ({
        sha: id,
        message,
        url: `https://gitlab.example.com/acme/api/-/commit/${id}`,
        authorName: 'Dev',
        authorEmail: 'dev@example.com',
        authorLogin: null,
        authoredAt: '2026-10-18T07:00:00.000Z',
        committedAt: '2026-10-19T09:00:00.000Z',
      });
      const comparePath = (from: string) =>
        `/projects/100/repository/compare?${new URLSearchParams({ from, to: AFTER }).toString()}`;

      const push = async (
        payload: Record<string, unknown>,
        { linking = true, eventUuid = 'c1' } = {},
      ) => {
        const ctx = setup();
        (ctx.svc as unknown as { tokenFor: jest.Mock }).tokenFor = jest
          .fn()
          .mockResolvedValue('tok');
        ctx.core.findRepositoryById.mockResolvedValue(hooked());
        ctx.pullRequests.commitLinkingEnabled.mockResolvedValue(linking);

        await ctx.svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          eventUuid,
          rawBody: body({
            object_kind: 'push',
            ref: 'refs/heads/XE-T1-docs',
            before: BEFORE,
            after: AFTER,
            user_id: 5,
            user_username: 'pusher',
            ...payload,
          }),
        });

        return ctx;
      };

      it('a keyed push compares before..after and links the API commits (author date)', async () => {
        const ctx = setup();
        (ctx.svc as unknown as { tokenFor: jest.Mock }).tokenFor = jest
          .fn()
          .mockResolvedValue('tok');
        ctx.core.findRepositoryById.mockResolvedValue(hooked());
        ctx.pullRequests.commitLinkingEnabled.mockResolvedValue(true);
        ctx.client.api.mockResolvedValueOnce({
          commits: [apiCommit('d1', 'Refs XE-T1 update docs')],
        });

        await ctx.svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          eventUuid: 'c2',
          rawBody: body({
            object_kind: 'push',
            ref: 'refs/heads/XE-T1-docs',
            before: BEFORE,
            after: AFTER,
            total_commits_count: 1,
            commits: [hookCommit('d1', 'Refs XE-T1 update docs')],
            user_id: 5,
            user_username: 'pusher',
          }),
        });

        expect(ctx.client.api).toHaveBeenCalledWith(comparePath(BEFORE), 'tok');
        expect(ctx.pullRequests.syncCommits).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'repo-1' }),
          'XE-T1-docs',
          [fromApi('d1', 'Refs XE-T1 update docs')],
          { externalId: '5', login: 'pusher' },
        );
        expect(ctx.core.setDeliveryOutcome).toHaveBeenCalledWith(
          'gitlab',
          'repo-1:c2',
          'processed',
        );
      });

      it('a truncated hook (25 pushed, 20 listed, none keyed) still compares', async () => {
        const ctx = setup();
        (ctx.svc as unknown as { tokenFor: jest.Mock }).tokenFor = jest
          .fn()
          .mockResolvedValue('tok');
        ctx.core.findRepositoryById.mockResolvedValue(hooked());
        ctx.pullRequests.commitLinkingEnabled.mockResolvedValue(true);
        ctx.client.api.mockResolvedValueOnce({
          commits: [
            apiCommit('old', 'XE-T9 early work'),
            apiCommit('new', 'tidy'),
          ],
        });

        await ctx.svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          rawBody: body({
            object_kind: 'push',
            ref: 'refs/heads/XE-T1-docs',
            before: BEFORE,
            after: AFTER,
            total_commits_count: 25,
            commits: Array.from({ length: 20 }, (_, i) =>
              hookCommit(`h${i}`, `chore ${i}`),
            ),
          }),
        });

        expect(ctx.pullRequests.commitLinkingEnabled).toHaveBeenCalled();
        expect(ctx.client.api).toHaveBeenCalledWith(comparePath(BEFORE), 'tok');
        expect(ctx.pullRequests.syncCommits.mock.calls[0][2]).toEqual([
          fromApi('old', 'XE-T9 early work'),
          fromApi('new', 'tidy'),
        ]);
      });

      it('setting off: no compare, no syncCommits, still processed', async () => {
        const { client, core, pullRequests } = await push(
          { total_commits_count: 1, commits: [hookCommit('d1', 'XE-T1 docs')] },
          { linking: false, eventUuid: 'c3' },
        );

        expect(pullRequests.commitLinkingEnabled).toHaveBeenCalled();
        expect(client.api).not.toHaveBeenCalled();
        expect(pullRequests.syncCommits).not.toHaveBeenCalled();
        expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
          'gitlab',
          'repo-1:c3',
          'processed',
        );
      });

      it('no key in a complete hook: the setting is not even read', async () => {
        const { client, pullRequests } = await push({
          total_commits_count: 1,
          commits: [hookCommit('d1', 'update docs')],
        });

        expect(pullRequests.commitLinkingEnabled).not.toHaveBeenCalled();
        expect(client.api).not.toHaveBeenCalled();
        expect(pullRequests.syncCommits).not.toHaveBeenCalled();
      });

      it('a new branch compares from the default branch', async () => {
        const { client } = await push({
          before: ZEROS,
          total_commits_count: 1,
          commits: [hookCommit('d1', 'XE-T1 docs')],
        });

        expect(client.api).toHaveBeenCalledWith(comparePath('main'), 'tok');
      });

      it('a failed compare links the hook commits (committer date)', async () => {
        const ctx = setup();
        (ctx.svc as unknown as { tokenFor: jest.Mock }).tokenFor = jest
          .fn()
          .mockResolvedValue('tok');
        ctx.core.findRepositoryById.mockResolvedValue(hooked());
        ctx.pullRequests.commitLinkingEnabled.mockResolvedValue(true);
        ctx.client.api.mockRejectedValueOnce(new GitlabApiError(500, 'boom'));

        await ctx.svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          rawBody: body({
            object_kind: 'push',
            ref: 'refs/heads/XE-T1-docs',
            before: BEFORE,
            after: AFTER,
            total_commits_count: 1,
            commits: [hookCommit('d1', 'XE-T1 docs')],
          }),
        });

        expect(ctx.pullRequests.syncCommits).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'repo-1' }),
          'XE-T1-docs',
          [
            {
              sha: 'd1',
              message: 'XE-T1 docs',
              url: 'https://gitlab.example.com/acme/api/-/commit/d1',
              authorName: 'Dev',
              authorEmail: 'dev@example.com',
              authorLogin: null,
              authoredAt: '2026-10-19T09:00:00.000Z',
              committedAt: '2026-10-19T09:00:00.000Z',
            },
          ],
          // A hook without a pusher still counts as a live delivery.
          { externalId: null, login: null },
        );
      });

      it('a branch deletion skips commit handling', async () => {
        const { client, pullRequests } = await push({
          after: ZEROS,
          total_commits_count: 0,
          commits: [hookCommit('d1', 'XE-T1 docs')],
        });

        expect(pullRequests.syncBranch).toHaveBeenCalled();
        expect(pullRequests.commitLinkingEnabled).not.toHaveBeenCalled();
        expect(client.api).not.toHaveBeenCalled();
        expect(pullRequests.syncCommits).not.toHaveBeenCalled();
      });

      it('commitFromApi builds a missing url from the repository; commitFromHook needs id and url', () => {
        const { web_url: _omit, ...noUrl } = apiCommit('d1', 'm');

        expect(
          commitFromApi(noUrl, 'https://gitlab.example.com/acme/api/')?.url,
        ).toBe('https://gitlab.example.com/acme/api/-/commit/d1');
        expect(commitFromApi(noUrl, null)).toBeNull();
        expect(commitFromHook({ message: 'x', url: 'u' })).toBeNull();
        expect(commitFromHook({ id: 'd1', message: 'x' })).toBeNull();
      });

      it('mergeCommitShas: merged -> merge and squash shas, open -> []', () => {
        const attrs = {
          id: 555,
          iid: 12,
          title: 't',
          url: 'https://gitlab.example.com/acme/api/-/merge_requests/12',
          merge_commit_sha: 'a',
          squash_commit_sha: 'b',
        };
        const api = {
          id: 555,
          iid: 12,
          title: 't',
          description: null,
          web_url: attrs.url,
          source_branch: 'b',
          target_branch: 'main',
          author: null,
          created_at: null,
          updated_at: null,
          merge_commit_sha: 'a',
          squash_commit_sha: 'b',
        };

        expect(
          mergeRequestFromHook({
            object_kind: 'merge_request',
            object_attributes: { ...attrs, state: 'merged' },
          } as never)?.mergeCommitShas,
        ).toEqual(['a', 'b']);
        expect(
          mergeRequestFromHook({
            object_kind: 'merge_request',
            object_attributes: { ...attrs, state: 'opened' },
          } as never)?.mergeCommitShas,
        ).toEqual([]);
        expect(
          mergeRequestFromApi({ ...api, state: 'merged' } as never)
            .mergeCommitShas,
        ).toEqual(['a', 'b']);
        expect(
          mergeRequestFromApi({
            ...api,
            state: 'merged',
            squash_commit_sha: null,
          } as never).mergeCommitShas,
        ).toEqual(['a']);
        expect(
          mergeRequestFromApi({ ...api, state: 'opened' } as never)
            .mergeCommitShas,
        ).toEqual([]);
      });
    });

    describe('builds (ticket 7)', () => {
      const SHA = 'd'.repeat(40);
      const pipelineHook = (
        attrs: Record<string, unknown> = {},
        extra: Record<string, unknown> = {},
      ) =>
        body({
          object_kind: 'pipeline',
          user: { id: 8, username: 'runner' },
          object_attributes: {
            id: 901,
            name: null,
            ref: 'XE-T1-x',
            tag: false,
            sha: SHA,
            status: 'failed',
            created_at: '2026-10-19 09:00:00 UTC',
            finished_at: '2026-10-19 09:05:00 UTC',
            url: 'https://gitlab.example.com/acme/api/-/pipelines/901',
            ...attrs,
          },
          ...extra,
        });
      const deliver = async (rawBody: Buffer, eventUuid = 'p1') => {
        const ctx = setup();
        ctx.core.findRepositoryById.mockResolvedValue(hooked());
        await ctx.svc.handleWebhook({
          repositoryId: 'repo-1',
          token: secret,
          event: 'Pipeline Hook',
          eventUuid,
          rawBody,
        });

        return ctx;
      };
      const built = (pullRequests: { syncBuilds: jest.Mock }) =>
        (pullRequests.syncBuilds.mock.calls[0] as unknown[][])[1][0];

      it('a failed pipeline on a branch syncs the exact build; processed', async () => {
        const { core, pullRequests } = await deliver(pipelineHook());

        expect(pullRequests.syncBuilds).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'repo-1' }),
          [
            {
              externalId: '901',
              workflowKey: 'pipeline',
              name: 'Pipeline',
              headBranch: 'XE-T1-x',
              headRepoFullName: null,
              headSha: SHA,
              state: 'failed',
              attempt: 1,
              url: 'https://gitlab.example.com/acme/api/-/pipelines/901',
              startedAt: null,
              completedAt: '2026-10-19T09:05:00.000Z',
              createdAt: '2026-10-19T09:00:00.000Z',
              updatedAt: null,
            },
          ],
          false,
          { externalId: '8', login: 'runner' },
        );
        expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
          'gitlab',
          'repo-1:p1',
          'processed',
        );
      });

      it.each([
        ['success', 'passed', '2026-10-19T09:05:00.000Z'],
        ['running', 'running', null],
        ['manual', 'queued', null],
        ['canceled', 'cancelled', '2026-10-19T09:05:00.000Z'],
      ])('status %s -> %s', async (status, state, completedAt) => {
        const { pullRequests } = await deliver(pipelineHook({ status }));

        expect(built(pullRequests)).toMatchObject({ state, completedAt });
      });

      it('a merge request pipeline takes the source branch', async () => {
        const { pullRequests } = await deliver(
          pipelineHook(
            { ref: 'refs/merge-requests/7/head' },
            { merge_request: { iid: 7, source_branch: 'XE-T1-mr' } },
          ),
        );

        expect(built(pullRequests)).toMatchObject({ headBranch: 'XE-T1-mr' });
      });

      it('tag pipelines and pipelines without a sha are ignored', async () => {
        const tag = await deliver(pipelineHook({ tag: true, ref: 'v1.0' }));
        expect(tag.pullRequests.syncBuilds).not.toHaveBeenCalled();
        expect(tag.core.setDeliveryOutcome).toHaveBeenCalledWith(
          'gitlab',
          'repo-1:p1',
          'ignored',
        );

        const noSha = await deliver(pipelineHook({ sha: undefined }), 'p2');
        expect(noSha.pullRequests.syncBuilds).not.toHaveBeenCalled();
        expect(noSha.core.setDeliveryOutcome).toHaveBeenCalledWith(
          'gitlab',
          'repo-1:p2',
          'ignored',
        );
      });

      it('without a url the pipeline link is built from the project web url', async () => {
        const { pullRequests } = await deliver(pipelineHook({ url: null }));

        expect(built(pullRequests)).toMatchObject({
          url: 'https://gitlab.example.com/acme/api/-/pipelines/901',
        });
      });

      it('buildFromGitlabPipeline: no url and no web url -> null', () => {
        expect(
          buildFromGitlabPipeline(
            { id: 1, sha: SHA, status: 'success', ref: 'main' },
            null,
            null,
          ),
        ).toBeNull();
      });

      it('headSha: hook from last_commit.id, API from sha', () => {
        expect(
          mergeRequestFromHook({
            object_kind: 'merge_request',
            object_attributes: {
              iid: 1,
              url: 'u',
              state: 'opened',
              last_commit: { id: SHA },
            },
          } as never)?.headSha,
        ).toBe(SHA);
        expect(
          mergeRequestFromApi({
            id: 1,
            iid: 1,
            web_url: 'u',
            state: 'opened',
            sha: SHA,
          } as never).headSha,
        ).toBe(SHA);
      });

      const apiMr = (state: string) => ({
        id: 555,
        iid: 12,
        title: 't',
        description: null,
        web_url: 'u',
        state,
        sha: SHA,
        source_branch: 'XE-T1-src',
        target_branch: 'main',
        author: null,
        created_at: '2026-10-19T09:00:00Z',
        updated_at: '2026-10-19T10:00:00Z',
      });
      const apiPipeline = {
        id: 77,
        ref: 'refs/merge-requests/12/head',
        sha: SHA,
        status: 'success',
        web_url: 'https://gitlab.example.com/acme/api/-/pipelines/77',
        created_at: '2026-10-19T09:00:00Z',
        updated_at: '2026-10-19T09:10:00Z',
      };
      const pipelinesPath = `/projects/100/pipelines?sha=${SHA}&per_page=20`;
      const routed = (
        mr: unknown,
        pipelines: () => Promise<unknown> = () =>
          Promise.resolve([apiPipeline]),
      ) => {
        const ctx = setup();
        (ctx.svc as unknown as { tokenFor: jest.Mock }).tokenFor = jest
          .fn()
          .mockResolvedValue('tok');
        ctx.client.api.mockImplementation((path: string) => {
          if (path.includes('/pipelines?')) return pipelines();
          if (path.endsWith('/reviewers')) return Promise.resolve([]);
          if (path.endsWith('/approvals'))
            return Promise.resolve({ approved_by: [] });

          return Promise.resolve(mr);
        });

        return ctx;
      };

      it('fetchPullRequest maps the pipelines of an open merge request', async () => {
        const { svc, client, pullRequests } = routed(apiMr('opened'));

        const pr = await svc.fetchPullRequest(
          conn() as never,
          hooked() as never,
          12,
        );

        expect(client.api).toHaveBeenCalledWith(pipelinesPath, 'tok');
        expect(pr.builds).toEqual([
          expect.objectContaining({
            externalId: '77',
            headBranch: 'XE-T1-src',
            headSha: SHA,
            state: 'passed',
            url: 'https://gitlab.example.com/acme/api/-/pipelines/77',
            completedAt: '2026-10-19T09:10:00.000Z',
          }),
        ]);
        // Ticket 8: a manual link / import returns data; the caller syncs it without an actor.
        expect(pullRequests.sync).not.toHaveBeenCalled();
        expect(pullRequests.syncBuilds).not.toHaveBeenCalled();
      });

      it('fetchPullRequest: merged -> no pipelines call; failing pipelines -> [] and the PR still returned', async () => {
        const merged = routed(apiMr('merged'));
        const pr = await merged.svc.fetchPullRequest(
          conn() as never,
          hooked() as never,
          12,
        );
        expect(pr.builds).toEqual([]);
        expect(
          (merged.client.api.mock.calls as string[][]).some(([path]) =>
            path.includes('/pipelines'),
          ),
        ).toBe(false);

        const failing = routed(apiMr('opened'), () =>
          Promise.reject(new GitlabApiError(500, 'boom')),
        );
        const open = await failing.svc.fetchPullRequest(
          conn() as never,
          hooked() as never,
          12,
        );
        expect(open).toMatchObject({ number: 12, state: 'open', builds: [] });
      });

      it('listRecentPullRequests attaches builds to open merge requests only', async () => {
        const { svc, client } = routed(null);
        client.paginate
          .mockResolvedValueOnce([{ ...apiMr('opened'), iid: 1 }])
          .mockResolvedValueOnce([{ ...apiMr('merged'), iid: 2 }]);

        const result = await svc.listRecentPullRequests(
          conn() as never,
          hooked() as never,
          new Date('2026-09-19T00:00:00Z'),
        );
        const byNumber = new Map(result.map((pr) => [pr.number, pr]));

        expect(byNumber.get(1)?.builds).toEqual([
          expect.objectContaining({ externalId: '77', state: 'passed' }),
        ]);
        expect(byNumber.get(2)?.builds).toBeUndefined();
        expect(
          (client.api.mock.calls as string[][]).filter(([path]) =>
            path.includes('/pipelines'),
          ),
        ).toHaveLength(1);
      });
    });
  });

  describe('own servers (ticket 11)', () => {
    const SERVER_ID = '33333333-3333-4333-8333-333333333333';
    const SERVER_APP = {
      ...APP,
      serverId: SERVER_ID,
      host: 'git.corp.local',
      webUrl: 'https://git.corp.local/gitlab',
      apiUrl: 'https://git.corp.local/gitlab/api/v4',
      clientId: 'own-cid',
    };

    it('connectUrl with a server uses its address and client and carries it in the state', async () => {
      const { svc, servers } = setup();
      servers.appForStart.mockResolvedValue(SERVER_APP);

      const url = new URL(
        await svc.connectUrl(USER, ORG, RETURN_TO, undefined, SERVER_ID),
      );

      expect(servers.appForStart).toHaveBeenCalledWith(
        ORG,
        'gitlab',
        SERVER_ID,
      );
      expect(url.origin + url.pathname).toBe(
        'https://git.corp.local/gitlab/oauth/authorize',
      );
      expect(url.searchParams.get('client_id')).toBe('own-cid');

      const opened = await svc.handleCallback({
        state: url.searchParams.get('state')!,
        error: 'access_denied',
      });

      expect(params(opened).get('server')).toBe(SERVER_ID);
    });

    it('connectUrl refuses an app without its OAuth client', async () => {
      const { svc, servers } = setup();
      servers.appForStart.mockResolvedValue({
        ...SERVER_APP,
        clientSecret: undefined,
      });

      await expect(
        svc.connectUrl(USER, ORG, RETURN_TO, undefined, SERVER_ID),
      ).rejects.toThrow('not_configured');
    });

    it('reconnect resolves the app from the connection host', async () => {
      const { svc, servers, core } = setup();
      core.getConnection.mockResolvedValue(conn({ host: 'git.corp.local' }));
      servers.appFor.mockResolvedValue(SERVER_APP);

      const url = new URL(await svc.connectUrl(USER, ORG, RETURN_TO, CONN_ID));

      expect(servers.appFor).toHaveBeenCalledWith(
        ORG,
        'gitlab',
        'git.corp.local',
      );
      expect(url.host).toBe('git.corp.local');
    });

    it('callback with a server tag stores the credential under the server host', async () => {
      const { svc, client, db, servers } = setup((call) =>
        kind(call) === 'insert' ? { data: { id: 'cred-new' } } : {},
      );
      servers.appForStart.mockResolvedValue(SERVER_APP);
      client.exchangeCode.mockResolvedValue({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      client.api.mockResolvedValue({ id: 9, username: 'alice' });

      const url = await svc.handleCallback({
        code: 'c',
        state: createState(
          USER,
          ORG,
          stateProviderTag('gitlab', undefined, SERVER_ID),
          RETURN_TO,
        ),
      });

      expect(params(url).get('credential')).toBe('cred-new');
      expect(params(url).get('server')).toBe(SERVER_ID);
      expect(client.apps[0]).toBe(SERVER_APP);
      const insert = db.calls
        .find((c) => kind(c) === 'insert')!
        .ops.find(([op]) => op === 'insert')![1] as Record<string, string>;
      expect(insert.host).toBe('git.corp.local');
    });

    it('callback whose server is gone -> not_configured, nothing exchanged', async () => {
      const { svc, client, servers } = setup();
      servers.appForStart.mockRejectedValue(new Error('server_not_configured'));

      const url = await svc.handleCallback({
        code: 'c',
        state: createState(
          USER,
          ORG,
          stateProviderTag('gitlab', undefined, SERVER_ID),
          RETURN_TO,
        ),
      });

      expect(params(url).get('error')).toBe('not_configured');
      expect(client.exchangeCode).not.toHaveBeenCalled();
    });

    it('health skips a credential whose app cannot be resolved, without flagging it', async () => {
      const { svc, core, servers } = setup((call) =>
        call.table === 'git_connections' ? { data: [] } : { data: cred() },
      );
      core.listAllLive.mockResolvedValue([conn()]);
      servers.appFor.mockRejectedValue(new Error('server_not_configured'));

      await svc.checkHealth();

      expect(core.setStatus).not.toHaveBeenCalled();
    });

    it('a verified webhook touches the server, also when it is a duplicate', async () => {
      const { svc, core, servers } = setup();
      const secret = 's'.repeat(64);
      const e = encryptApiKey(secret);
      core.findRepositoryById.mockResolvedValue(
        repo({
          host: 'git.corp.local',
          webhook_id: '5',
          webhook_secret_encrypted: e.encrypted,
          webhook_secret_iv: e.iv,
          webhook_secret_tag: e.tag,
        }),
      );
      core.recordDelivery.mockResolvedValue(false);

      await svc.handleWebhook({
        repositoryId: 'repo-1',
        token: secret,
        event: 'Push Hook',
        eventUuid: 'u1',
      });
      expect(servers.touchWebhookByHost).toHaveBeenCalledWith(
        ORG,
        'gitlab',
        'git.corp.local',
      );

      servers.touchWebhookByHost.mockClear();
      await svc.handleWebhook({ repositoryId: 'repo-1', token: 'wrong' });
      expect(servers.touchWebhookByHost).not.toHaveBeenCalled();
    });

    describe('testInboundHook', () => {
      const hookedRows = (rows: IGitRepositoryRow[]) => (call: ICall) =>
        call.table === 'git_repositories' ? { data: rows } : { data: cred() };

      it('no hooked project -> no_project', async () => {
        const { svc, core } = setup(hookedRows([]));
        core.listConnections.mockResolvedValue([conn()]);

        expect(await svc.testInboundHook(ORG, 'gitlab.example.com')).toEqual({
          result: 'no_project',
        });
      });

      it('no connection on that host -> no_project without a query', async () => {
        const { svc, core, db } = setup();
        core.listConnections.mockResolvedValue([conn({ host: 'other.host' })]);

        expect(
          (await svc.testInboundHook(ORG, 'gitlab.example.com')).result,
        ).toBe('no_project');
        expect(db.calls.some((c) => c.table === 'git_repositories')).toBe(
          false,
        );
      });

      it('fires the push test of a project with a default branch', async () => {
        const { svc, core, client, db } = setup(
          hookedRows([
            repo({ id: 'empty', webhook_id: '4', default_branch: null }),
            repo({ webhook_id: '5' }),
          ]),
        );
        core.listConnections.mockResolvedValue([conn()]);
        client.api.mockResolvedValue({});

        expect(await svc.testInboundHook(ORG, 'gitlab.example.com')).toEqual({
          result: 'sent',
          repositoryId: 'repo-1',
        });
        expect(client.api).toHaveBeenCalledWith(
          '/projects/100/hooks/5/test/push_events',
          'at-old',
          { method: 'POST' },
        );
        const query = db.calls.find((c) => c.table === 'git_repositories')!;
        expect(has(query, 'eq', 'organization_id', ORG)).toBe(true);
        expect(has(query, 'in', 'connection_id', [CONN_ID])).toBe(true);
      });

      it('GitLab blocking the local network -> blocked with its message', async () => {
        const { svc, core, client } = setup(
          hookedRows([repo({ webhook_id: '5' })]),
        );
        core.listConnections.mockResolvedValue([conn()]);
        client.api.mockRejectedValue(
          new GitlabApiError(
            422,
            'Hook execution failed: URL is blocked: Requests to the local network are not allowed',
          ),
        );

        const result = await svc.testInboundHook(ORG, 'gitlab.example.com');

        expect(result.result).toBe('blocked');
        expect(result.detail).toContain('local network');
      });

      it('any other GitLab error -> failed with status and message', async () => {
        const { svc, core, client } = setup(
          hookedRows([repo({ webhook_id: '5' })]),
        );
        core.listConnections.mockResolvedValue([conn()]);
        client.api.mockRejectedValue(new GitlabApiError(500, 'boom'));

        expect(await svc.testInboundHook(ORG, 'gitlab.example.com')).toEqual({
          result: 'failed',
          detail: '500: boom',
          repositoryId: 'repo-1',
        });
      });
    });

    describe('checkHookAlerts', () => {
      it('flags disabled hooks, clears recovered ones, skips errors', async () => {
        const rows = [
          repo({
            id: 'r-off',
            full_name: 'acme/off',
            external_id: '1',
            webhook_id: '11',
          }),
          repo({
            id: 'r-back',
            full_name: 'acme/back',
            external_id: '2',
            webhook_id: '12',
            webhook_error: 'disabled_by_gitlab',
          }),
          repo({
            id: 'r-err',
            full_name: 'acme/err',
            external_id: '3',
            webhook_id: '13',
          }),
          repo({
            id: 'r-temp',
            full_name: 'acme/temp',
            external_id: '4',
            webhook_id: '14',
          }),
        ];
        // What the table holds after this tick's writes: r-off and r-temp, plus r-old from an earlier batch.
        const recorded = [
          rows[0],
          rows[3],
          repo({ id: 'r-old', full_name: 'acme/old' }),
        ];
        const { svc, core, client } = setup((call) =>
          call.table !== 'git_repositories'
            ? { data: cred() }
            : isDisabledQuery(call)
              ? { data: recorded, count: 3 }
              : { data: rows },
        );
        core.listConnections.mockResolvedValue([conn()]);
        client.api.mockImplementation((path: string) =>
          path.startsWith('/projects/1/')
            ? Promise.resolve({ alert_status: 'disabled' })
            : path.startsWith('/projects/2/')
              ? Promise.resolve({ alert_status: 'executable' })
              : path.startsWith('/projects/3/')
                ? Promise.reject(new GitlabApiError(404, 'gone'))
                : Promise.resolve({ alert_status: 'temporarily_disabled' }),
        );

        const result = await svc.checkHookAlerts(ORG, 'gitlab.example.com');

        expect(result.checked).toBe(3);
        // Every hook still recorded as disabled, not only this batch's (no flapping with > limit hooks).
        expect(result.failing).toEqual([
          {
            repositoryId: 'r-off',
            fullName: 'acme/off',
            alertStatus: 'disabled',
          },
          {
            repositoryId: 'r-temp',
            fullName: 'acme/temp',
            alertStatus: 'temporarily_disabled',
          },
          {
            repositoryId: 'r-old',
            fullName: 'acme/old',
            alertStatus: 'disabled',
          },
        ]);
        expect(result.failingTotal).toBe(3);
        expect(core.updateRepositoryWebhook).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'r-off' }),
          { webhook_error: 'disabled_by_gitlab' },
        );
        expect(core.updateRepositoryWebhook).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'r-back' }),
          { webhook_error: null },
        );
        expect(core.updateRepositoryWebhook).toHaveBeenCalledTimes(3);
      });

      it('walks the hooks round robin: the next call starts after the last id', async () => {
        const page = [
          repo({ id: 'a', webhook_id: '1' }),
          repo({ id: 'b', webhook_id: '2' }),
        ];
        const { svc, core, client, db } = setup((call) =>
          call.table === 'git_repositories' ? { data: page } : { data: cred() },
        );
        core.listConnections.mockResolvedValue([conn()]);
        client.api.mockResolvedValue({ alert_status: 'executable' });

        await svc.checkHookAlerts(ORG, 'gitlab.example.com', 2);
        await svc.checkHookAlerts(ORG, 'gitlab.example.com', 2);

        const queries = db.calls.filter(
          (c) => c.table === 'git_repositories' && !isDisabledQuery(c),
        );
        expect(has(queries[0], 'gt', 'id', 'b')).toBe(false);
        expect(has(queries[1], 'gt', 'id', 'b')).toBe(true);
      });
    });
  });
});
