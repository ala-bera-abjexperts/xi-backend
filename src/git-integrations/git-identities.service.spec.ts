/**
 * @fileoverview Unit tests for personal Git account links (ticket 2): link / relink / unlink, the
 * admin's linked-member list and removal, the author resolver, the OAuth callback outcomes and the
 * connect URL. The Supabase admin client is the same hand-written recording mock as
 * git-integrations.service.spec.
 * @module src/git-integrations/git-identities.service.spec
 */

import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { readState } from '../calendar/integrations/calendar-oauth.state';
import {
  GitIdentitiesService,
  isBotAuthor,
  type IGitIdentityRow,
} from './git-identities.service';
import { parseIdentityStateTag, pkceVerifier } from './git-integrations.util';

const ORG = 'org-1';
const USER = 'user-1';
const OTHER = 'user-2';
const IDENTITIES = 'git_user_identities';
const MEMBERS = 'organization_members';
const USERS = 'users';

// ---------------------------------------------------------------------------
// Recording Supabase mock (same approach as git-integrations.service.spec)
// ---------------------------------------------------------------------------

interface ICall {
  method: string;
  args: unknown[];
}

interface IChain {
  table: string;
  calls: ICall[];
}

interface IResult {
  data?: unknown;
  error?: { message: string; code?: string } | null;
}

const CHAIN_METHODS = [
  'select',
  'insert',
  'update',
  'upsert',
  'delete',
  'eq',
  'neq',
  'in',
  'is',
  'or',
  'order',
  'limit',
  'range',
];

function makeDb() {
  const chains: IChain[] = [];
  const queues = new Map<string, IResult[]>();

  const next = (table: string) => {
    const result = queues.get(table)?.shift() ?? {};

    return { data: result.data ?? null, error: result.error ?? null };
  };

  const from = (table: string) => {
    const chain: IChain = { table, calls: [] };
    let resolved: { data: unknown; error: unknown } | undefined;
    const resolve = () => (resolved ??= next(table));
    const builder: Record<string, unknown> = {};

    chains.push(chain);

    for (const method of CHAIN_METHODS) {
      builder[method] = (...args: unknown[]) => {
        chain.calls.push({ method, args });

        return builder;
      };
    }

    for (const method of ['maybeSingle', 'single']) {
      builder[method] = (...args: unknown[]) => {
        chain.calls.push({ method, args });

        return Promise.resolve(resolve());
      };
    }

    builder.then = (
      onF: (v: unknown) => unknown,
      onR?: (e: unknown) => unknown,
    ) => {
      chain.calls.push({ method: 'then', args: [] });

      return Promise.resolve(resolve()).then(onF, onR);
    };

    return builder;
  };

  return {
    client: { from },
    chains,
    queue(table: string, ...results: IResult[]) {
      queues.set(table, [...(queues.get(table) ?? []), ...results]);
    },
    on(table: string) {
      return chains.filter((chain) => chain.table === table);
    },
  };
}

type Db = ReturnType<typeof makeDb>;

function calls(chain: IChain, method: string) {
  return chain.calls.filter((call) => call.method === method);
}

function hasEq(chain: IChain, column: string, value: unknown) {
  return calls(chain, 'eq').some(
    (call) => call.args[0] === column && call.args[1] === value,
  );
}

function inValues(chain: IChain, column: string): unknown[] | undefined {
  return calls(chain, 'in').find((call) => call.args[0] === column)?.args[1] as
    | unknown[]
    | undefined;
}

function payload(
  chain: IChain,
  method: 'insert' | 'update',
): Record<string, unknown> | undefined {
  return calls(chain, method)[0]?.args[0] as
    | Record<string, unknown>
    | undefined;
}

function writes(db: Db) {
  return db
    .on(IDENTITIES)
    .filter((chain) =>
      ['insert', 'update', 'upsert', 'delete'].some(
        (m) => calls(chain, m).length,
      ),
    );
}

interface IOptions {
  githubConfigured?: boolean;
  gitlabConfigured?: boolean;
  gitlabBaseUrl?: string;
  servers?: IServerFixture[];
}

/** The parts of a git_servers row the identities service reads, plus its decrypted client secret. */
interface IServerFixture {
  id: string;
  provider: 'github' | 'gitlab';
  host: string;
  base_url: string;
  name: string;
  client_id: string | null;
  secret: string | null;
}

const SERVER = '33333333-3333-4333-8333-333333333333';
const GITLAB_SERVER: IServerFixture = {
  id: SERVER,
  provider: 'gitlab',
  host: 'gitlab.company.local',
  base_url: 'https://gitlab.company.local/code',
  name: 'Company GitLab',
  client_id: 'srv-client',
  secret: 'srv-secret',
};

const BUILTIN_GITHUB = expect.objectContaining({
  serverId: null,
  host: 'github.com',
});
const BUILTIN_GITLAB = expect.objectContaining({
  serverId: null,
  host: 'gitlab.com',
});

function makeService(db: Db, options: IOptions = {}) {
  const {
    githubConfigured = true,
    gitlabConfigured = true,
    gitlabBaseUrl = 'https://gitlab.com',
    servers: serverRows = [],
  } = options;
  const audit = { logAction: jest.fn().mockResolvedValue(undefined) };
  const github = {
    exchangeCode: jest.fn().mockResolvedValue('gh-token'),
    getUser: jest.fn().mockResolvedValue({
      id: 42,
      login: 'octo',
      type: 'User',
      avatar_url: 'https://avatars/octo',
      html_url: 'https://github.com/octo',
    }),
    revokeUserToken: jest.fn().mockResolvedValue(undefined),
  };
  const gitlab = {
    exchangeCode: jest.fn().mockResolvedValue({ accessToken: 'gl-token' }),
    api: jest.fn().mockResolvedValue({
      id: 7,
      username: 'tanuki',
      avatar_url: 'https://avatars/tanuki',
      web_url: 'https://gitlab.com/tanuki',
      bot: false,
    }),
    revoke: jest.fn().mockResolvedValue(undefined),
  };
  const azureDevops = {
    authorizeUrl: jest.fn().mockReturnValue('https://login/authorize'),
    exchangeCode: jest.fn().mockResolvedValue({ accessToken: 'az-token' }),
    profile: jest.fn().mockResolvedValue({
      id: 'az-id',
      emailAddress: 'Mixed.Case@Acme.com',
    }),
  };
  const builtin = (provider: 'github' | 'gitlab' | 'azure_devops') => {
    if (provider === 'azure_devops')
      return {
        serverId: null,
        provider,
        host: 'dev.azure.com',
        webUrl: 'https://dev.azure.com',
        apiUrl: 'https://dev.azure.com',
        clientId: 'az-client',
        clientSecret: 'az-secret',
      };

    if (provider === 'github')
      return {
        serverId: null,
        provider,
        host: 'github.com',
        webUrl: 'https://github.com',
        apiUrl: 'https://api.github.com',
        ...(githubConfigured && {
          clientId: 'gh-client',
          clientSecret: 'gh-secret',
        }),
      };

    const webUrl = gitlabBaseUrl.replace(/\/$/, '');

    return {
      serverId: null,
      provider,
      host: new URL(webUrl).host.toLowerCase(),
      webUrl,
      apiUrl: `${webUrl}/api/v4`,
      ...(gitlabConfigured && {
        clientId: 'gl-client',
        clientSecret: 'gl-secret',
      }),
    };
  };
  const toApp = (server: IServerFixture) => ({
    serverId: server.id,
    provider: server.provider,
    host: server.host,
    webUrl: server.base_url,
    apiUrl: `${server.base_url}/api/v4`,
    clientId: server.client_id ?? undefined,
    clientSecret: server.secret ?? undefined,
  });
  const get = async (_org: string, id: string) => {
    const server = serverRows.find((item) => item.id === id);

    if (!server) throw new NotFoundException('Git server not found');

    return server;
  };
  const servers = {
    publicApiUrl: 'https://api.example.com/api/v1',
    builtinApp: jest.fn(builtin),
    builtinHost: jest.fn(
      (provider: 'github' | 'gitlab' | 'azure_devops') =>
        builtin(provider).host,
    ),
    list: jest.fn().mockResolvedValue(serverRows),
    get: jest.fn(get),
    toApp: jest.fn(toApp),
    appForStart: jest.fn(
      async (
        org: string,
        provider: 'github' | 'gitlab' | 'azure_devops',
        id?: string | null,
      ) =>
        id ? toApp(await get(org, id)) : builtin(provider),
    ),
  };
  const service = new GitIdentitiesService(
    { getClient: () => db.client } as never,
    audit as never,
    github as never,
    gitlab as never,
    servers as never,
    azureDevops as never,
  );

  return { service, audit, github, gitlab, servers, azureDevops };
}

function row(overrides: Partial<IGitIdentityRow> = {}): IGitIdentityRow {
  return {
    id: 'ident-1',
    user_id: USER,
    provider: 'github',
    host: 'github.com',
    external_user_id: '42',
    login: 'octo',
    avatar_url: null,
    profile_url: null,
    linked_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const ACCOUNT = {
  externalUserId: '42',
  login: 'octo',
  avatarUrl: 'https://a/octo',
  profileUrl: 'https://github.com/octo',
};

const ENV_KEYS = [
  'AI_ENCRYPTION_SECRET',
  'CALENDAR_STATE_SECRET',
  'JWT_SECRET',
  'FRONTEND_URL',
  'ALLOWED_ORIGINS',
  'APP_URL',
];

describe('GitIdentitiesService', () => {
  const saved: Record<string, string | undefined> = {};
  let db: Db;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
    process.env.FRONTEND_URL = 'https://app.example.com';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    db = makeDb();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  describe('link', () => {
    it('inserts a new link and audits event link', async () => {
      const { service, audit } = makeService(db);

      db.queue(IDENTITIES, { data: null }, { data: null }, { data: row() });

      await expect(service.link(USER, ORG, 'github', ACCOUNT)).resolves.toEqual(
        row(),
      );

      const write = db.on(IDENTITIES)[2];

      expect(payload(write, 'insert')).toEqual({
        external_user_id: '42',
        login: 'octo',
        avatar_url: 'https://a/octo',
        profile_url: 'https://github.com/octo',
        user_id: USER,
        provider: 'github',
        host: 'github.com',
      });
      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        USER,
        'git_user_identity',
        'ident-1',
        'create',
        {
          event: 'link',
          provider: 'github',
          host: 'github.com',
          login: 'octo',
        },
      );
    });

    it('same user relinking the same account updates without linked_at and without audit', async () => {
      const { service, audit } = makeService(db);

      db.queue(
        IDENTITIES,
        { data: { id: 'ident-1', user_id: USER } },
        { data: row({ login: 'old-name' }) },
        { data: row() },
      );

      await service.link(USER, ORG, 'github', ACCOUNT);

      const write = db.on(IDENTITIES)[2];

      expect(calls(write, 'insert')).toHaveLength(0);
      expect(payload(write, 'update')).toEqual({
        external_user_id: '42',
        login: 'octo',
        avatar_url: 'https://a/octo',
        profile_url: 'https://github.com/octo',
      });
      expect(hasEq(write, 'id', 'ident-1')).toBe(true);
      expect(hasEq(write, 'user_id', USER)).toBe(true);
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('same user linking a different account updates linked_at and audits relink with previous_login', async () => {
      const { service, audit } = makeService(db);

      db.queue(
        IDENTITIES,
        { data: null },
        { data: row({ external_user_id: '41', login: 'old' }) },
        { data: row() },
      );

      await service.link(USER, ORG, 'github', ACCOUNT);

      const update = payload(db.on(IDENTITIES)[2], 'update');

      expect(update).toMatchObject({ external_user_id: '42', login: 'octo' });
      expect(typeof update?.linked_at).toBe('string');
      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        USER,
        'git_user_identity',
        'ident-1',
        'create',
        {
          event: 'relink',
          provider: 'github',
          host: 'github.com',
          login: 'octo',
          previous_login: 'old',
        },
      );
    });

    it('an account owned by another user is a 409 identity_taken and nothing is written', async () => {
      const { service, audit } = makeService(db);

      db.queue(IDENTITIES, { data: { id: 'ident-9', user_id: OTHER } });

      const error = await service
        .link(USER, ORG, 'github', ACCOUNT)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'identity_taken',
      });
      expect(writes(db)).toHaveLength(0);
      expect(db.on(IDENTITIES)).toHaveLength(1);
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it.each([
      ['insert', null],
      ['update', row({ external_user_id: '41' })],
    ])('%s returning 23505 is a ConflictException', async (_method, mine) => {
      const { service, audit } = makeService(db);

      db.queue(
        IDENTITIES,
        { data: null },
        { data: mine },
        { error: { message: 'dup', code: '23505' } },
      );

      await expect(
        service.link(USER, ORG, 'github', ACCOUNT),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('every query filters provider + host, and the own-row lookup filters user_id', async () => {
      const { service } = makeService(db, {
        gitlabBaseUrl: 'https://GitLab.Example.org',
      });

      db.queue(
        IDENTITIES,
        { data: null },
        { data: row({ provider: 'gitlab' }) },
        { data: row() },
      );

      await service.link(USER, ORG, 'gitlab', {
        ...ACCOUNT,
        externalUserId: '99',
      });

      const [owner, mine, write] = db.on(IDENTITIES);

      for (const chain of [owner, mine]) {
        expect(hasEq(chain, 'provider', 'gitlab')).toBe(true);
        expect(hasEq(chain, 'host', 'gitlab.example.org')).toBe(true);
      }
      expect(hasEq(owner, 'external_user_id', '99')).toBe(true);
      expect(hasEq(mine, 'user_id', USER)).toBe(true);
      expect(hasEq(write, 'user_id', USER)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('unlink', () => {
    it("deletes only the caller's row for that provider and audits each deleted row", async () => {
      const { service, audit } = makeService(db);

      db.queue(IDENTITIES, { data: [{ id: 'ident-1', login: 'octo' }] });

      await service.unlink(USER, ORG, 'github');

      const [chain] = db.on(IDENTITIES);

      expect(calls(chain, 'delete')).toHaveLength(1);
      expect(hasEq(chain, 'user_id', USER)).toBe(true);
      expect(hasEq(chain, 'provider', 'github')).toBe(true);
      expect(hasEq(chain, 'host', 'github.com')).toBe(true);
      expect(audit.logAction).toHaveBeenCalledTimes(1);
      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        USER,
        'git_user_identity',
        'ident-1',
        'delete',
        {
          event: 'unlink',
          provider: 'github',
          host: 'github.com',
          login: 'octo',
        },
      );
    });

    it('does not audit when nothing was deleted', async () => {
      const { service, audit } = makeService(db);

      db.queue(IDENTITIES, { data: [] });

      await service.unlink(USER, ORG, 'gitlab');

      expect(audit.logAction).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('removeMemberLink', () => {
    it('target not a member of the org is NotFound and no delete is issued', async () => {
      const { service, audit } = makeService(db);

      db.queue(MEMBERS, { data: [] });

      await expect(
        service.removeMemberLink(ORG, USER, 'github', OTHER),
      ).rejects.toBeInstanceOf(NotFoundException);

      const [members] = db.on(MEMBERS);

      expect(hasEq(members, 'organization_id', ORG)).toBe(true);
      expect(inValues(members, 'user_id')).toEqual([OTHER]);
      expect(db.on(IDENTITIES)).toHaveLength(0);
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it('member without a link is NotFound', async () => {
      const { service, audit } = makeService(db);

      db.queue(MEMBERS, { data: [{ user_id: OTHER }] });
      db.queue(IDENTITIES, { data: [] });

      await expect(
        service.removeMemberLink(ORG, USER, 'github', OTHER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(audit.logAction).not.toHaveBeenCalled();
    });

    it("deletes the member's link and audits admin_remove in the admin's org", async () => {
      const { service, audit } = makeService(db);

      db.queue(MEMBERS, { data: [{ user_id: OTHER }] });
      db.queue(IDENTITIES, { data: [{ id: 'ident-9', login: 'someone' }] });

      await service.removeMemberLink(ORG, USER, 'gitlab', OTHER);

      const [chain] = db.on(IDENTITIES);

      expect(calls(chain, 'delete')).toHaveLength(1);
      expect(hasEq(chain, 'user_id', OTHER)).toBe(true);
      expect(hasEq(chain, 'provider', 'gitlab')).toBe(true);
      expect(hasEq(chain, 'host', 'gitlab.com')).toBe(true);
      expect(audit.logAction).toHaveBeenCalledWith(
        ORG,
        USER,
        'git_user_identity',
        'ident-9',
        'delete',
        {
          event: 'admin_remove',
          provider: 'gitlab',
          host: 'gitlab.com',
          login: 'someone',
          target_user_id: OTHER,
        },
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('listMine', () => {
    it('returns both providers with configured flags and identity or null', async () => {
      const { service } = makeService(db, { gitlabConfigured: false });

      db.queue(IDENTITIES, {
        data: [
          row({
            avatar_url: 'https://a/octo',
            profile_url: 'https://github.com/octo',
          }),
          // A link on another GitLab host is not this deployment's GitLab.
          row({
            provider: 'gitlab',
            host: 'gitlab.other.com',
            login: 'elsewhere',
          }),
        ],
      });

      await expect(service.listMine(USER)).resolves.toEqual([
        {
          provider: 'github',
          configured: true,
          serverId: null,
          serverName: null,
          host: 'github.com',
          identity: {
            login: 'octo',
            avatarUrl: 'https://a/octo',
            profileUrl: 'https://github.com/octo',
            linkedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        {
          provider: 'gitlab',
          configured: false,
          serverId: null,
          serverName: null,
          host: 'gitlab.com',
          identity: null,
        },
        {
          provider: 'azure_devops',
          configured: true,
          serverId: null,
          serverName: null,
          host: 'dev.azure.com',
          identity: null,
        },
      ]);
      expect(hasEq(db.on(IDENTITIES)[0], 'user_id', USER)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('listLinkedMembers', () => {
    it('queries identities only for org members, chunked by 100', async () => {
      const { service } = makeService(db);
      const members = Array.from({ length: 250 }, (_, i) => ({
        user_id: `m-${i}`,
      }));

      db.queue(MEMBERS, { data: members });
      db.queue(IDENTITIES, { data: [] }, { data: [] }, { data: [] });

      await expect(service.listLinkedMembers(ORG, 'github')).resolves.toEqual(
        [],
      );

      const chains = db.on(IDENTITIES);

      expect(chains).toHaveLength(3);
      expect(chains.map((chain) => inValues(chain, 'user_id')?.length)).toEqual(
        [100, 100, 50],
      );
      expect(chains.flatMap((chain) => inValues(chain, 'user_id'))).toEqual(
        members.map((m) => m.user_id),
      );
      for (const chain of chains) {
        expect(hasEq(chain, 'provider', 'github')).toBe(true);
        expect(hasEq(chain, 'host', 'github.com')).toBe(true);
      }
      expect(hasEq(db.on(MEMBERS)[0], 'organization_id', ORG)).toBe(true);
    });

    it('sorts by name, falling back to email then login', async () => {
      const { service } = makeService(db);

      db.queue(MEMBERS, {
        data: [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }],
      });
      db.queue(IDENTITIES, {
        data: [
          row({ user_id: 'a', login: 'zed-login' }),
          row({ user_id: 'b', login: 'b-login' }),
          row({ user_id: 'c', login: 'aaa-login' }),
        ],
      });
      db.queue(USERS, {
        data: [
          {
            id: 'a',
            first_name: 'Mia',
            last_name: 'Zhou',
            email: 'mia@x.com',
            avatar_url: 'https://a/mia',
          },
          {
            id: 'b',
            first_name: null,
            last_name: null,
            email: 'bob@x.com',
            avatar_url: null,
          },
          // 'c' has no XISUITE user row: the login is shown.
        ],
      });

      const result = await service.listLinkedMembers(ORG, 'github');

      expect(result.map((item) => item.name)).toEqual([
        'aaa-login',
        'bob@x.com',
        'Mia Zhou',
      ]);
      expect(result[2]).toEqual({
        userId: 'a',
        name: 'Mia Zhou',
        email: 'mia@x.com',
        avatarUrl: 'https://a/mia',
        login: 'zed-login',
        profileUrl: null,
        linkedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(result[0]).toMatchObject({ email: null, avatarUrl: null });
    });

    // Bug: displayName() returns '' for a user row with no name and no email, so the login fallback
    // (git-identities.service.ts:483) never applies when the user row exists.
    it('falls back to the login when the user row has no name and no email', async () => {
      const { service } = makeService(db);

      db.queue(MEMBERS, { data: [{ user_id: 'a' }] });
      db.queue(IDENTITIES, { data: [row({ user_id: 'a', login: 'octo' })] });
      db.queue(USERS, {
        data: [
          {
            id: 'a',
            first_name: null,
            last_name: null,
            email: null,
            avatar_url: null,
          },
        ],
      });

      const [item] = await service.listLinkedMembers(ORG, 'github');

      expect(item.name).toBe('octo');
    });
  });

  // -------------------------------------------------------------------------
  describe('resolveAuthors', () => {
    it('empty input issues no queries', async () => {
      const { service } = makeService(db);

      await expect(service.resolveAuthors(ORG, 'github', [])).resolves.toEqual(
        new Map(),
      );
      expect(db.chains).toHaveLength(0);
    });

    it('only-bot input issues no queries', async () => {
      const { service } = makeService(db);

      await service.resolveAuthors(ORG, 'github', [
        { externalId: '1', login: 'actions', type: 'Bot' },
        { externalId: '2', login: 'dependabot[bot]' },
        { externalId: '3', login: 'renovate[bot]', type: null },
      ]);

      expect(db.chains).toHaveLength(0);
    });

    it('maps only linked, non-bot authors who are current members; de-duplicates ids', async () => {
      const { service } = makeService(db);

      db.queue(IDENTITIES, {
        data: [
          { user_id: 'u-member', external_user_id: '10' },
          { user_id: 'u-gone', external_user_id: '11' },
        ],
      });
      db.queue(MEMBERS, { data: [{ user_id: 'u-member' }] });
      db.queue(USERS, {
        data: [
          {
            id: 'u-member',
            first_name: 'Ada',
            last_name: 'L',
            email: 'ada@x.com',
            avatar_url: 'https://a/ada',
          },
        ],
      });

      const result = await service.resolveAuthors(ORG, 'github', [
        { externalId: '10', login: 'ada', type: 'User' },
        { externalId: '10', login: 'ada', type: 'User' },
        { externalId: '11', login: 'left-the-org' },
        { externalId: '12', login: 'not-linked' },
        { externalId: '13', login: 'bot-type', type: 'Bot' },
        { externalId: '14', login: 'dependabot[bot]' },
        { externalId: '15', login: 'renovate[bot]' },
      ]);

      expect([...result.entries()]).toEqual([
        [
          '10',
          { userId: 'u-member', name: 'Ada L', avatarUrl: 'https://a/ada' },
        ],
      ]);

      const [identities] = db.on(IDENTITIES);

      expect(inValues(identities, 'external_user_id')).toEqual([
        '10',
        '11',
        '12',
      ]);
      expect(hasEq(identities, 'provider', 'github')).toBe(true);
      expect(hasEq(identities, 'host', 'github.com')).toBe(true);

      const [members] = db.on(MEMBERS);

      expect(hasEq(members, 'organization_id', ORG)).toBe(true);
      expect(inValues(members, 'user_id')).toEqual(['u-member', 'u-gone']);
      // Non-members' user rows are never read.
      expect(inValues(db.on(USERS)[0], 'id')).toEqual(['u-member']);
    });

    it('no links found → no member or user queries', async () => {
      const { service } = makeService(db);

      db.queue(IDENTITIES, { data: [] });

      await expect(
        service.resolveAuthors(ORG, 'gitlab', [
          { externalId: '1', login: 'x' },
        ]),
      ).resolves.toEqual(new Map());
      expect(db.on(MEMBERS)).toHaveLength(0);
      expect(db.on(USERS)).toHaveLength(0);
    });
  });

  describe('resolveLogins (ticket 6)', () => {
    it('maps linked, current members by username; skips bots, blanks and duplicates', async () => {
      const { service } = makeService(db);

      db.queue(IDENTITIES, {
        data: [
          { user_id: 'u-member', login: 'ada' },
          { user_id: 'u-gone', login: 'left' },
        ],
      });
      db.queue(MEMBERS, { data: [{ user_id: 'u-member' }] });
      db.queue(USERS, {
        data: [
          {
            id: 'u-member',
            first_name: 'Ada',
            last_name: 'L',
            email: 'ada@x.com',
            avatar_url: 'https://a/ada',
          },
        ],
      });

      const result = await service.resolveLogins(ORG, 'github', [
        'ada',
        'ada',
        'left',
        '',
        'dependabot[bot]',
        'nobody',
      ]);

      expect([...result.entries()]).toEqual([
        [
          'ada',
          { userId: 'u-member', name: 'Ada L', avatarUrl: 'https://a/ada' },
        ],
      ]);

      const [identities] = db.on(IDENTITIES);

      expect(inValues(identities, 'login')).toEqual(['ada', 'left', 'nobody']);
      expect(hasEq(identities, 'provider', 'github')).toBe(true);
      expect(hasEq(identities, 'host', 'github.com')).toBe(true);
      expect(hasEq(db.on(MEMBERS)[0], 'organization_id', ORG)).toBe(true);
    });

    it('only bots or nothing → no queries', async () => {
      const { service } = makeService(db);

      await expect(
        service.resolveLogins(ORG, 'github', ['renovate[bot]', '']),
      ).resolves.toEqual(new Map());
      expect(db.chains).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('handleCallback', () => {
    const base = {
      userId: USER,
      organizationId: ORG,
      returnTo: 'https://app.example.com/x',
    };

    function query(url: string) {
      return new URL(url).searchParams;
    }

    function queueSuccess() {
      db.queue(MEMBERS, { data: [{ user_id: USER }] });
      db.queue(IDENTITIES, { data: null }, { data: null }, { data: row() });
    }

    it('error param redirects with that error, without exchanging', async () => {
      const { service, github } = makeService(db);
      const url = await service.handleCallback({
        ...base,
        provider: 'github',
        page: 'profile',
        error: 'access_denied',
        code: 'c',
      });

      expect(query(url).get('error')).toBe('access_denied');
      expect(github.exchangeCode).not.toHaveBeenCalled();
    });

    it('no code → expired', async () => {
      const { service } = makeService(db);
      const url = await service.handleCallback({
        ...base,
        provider: 'github',
        page: 'profile',
      });

      expect(query(url).get('error')).toBe('expired');
      expect(db.chains).toHaveLength(0);
    });

    it('non-member → forbidden, without exchanging the code', async () => {
      const { service, github } = makeService(db);

      db.queue(MEMBERS, { data: [] });

      const url = await service.handleCallback({
        ...base,
        provider: 'github',
        page: 'profile',
        code: 'c',
      });

      expect(query(url).get('error')).toBe('forbidden');
      expect(github.exchangeCode).not.toHaveBeenCalled();
    });

    it('GitHub type Bot → bot_account, token still revoked, nothing written', async () => {
      const { service, github } = makeService(db);

      db.queue(MEMBERS, { data: [{ user_id: USER }] });
      github.getUser.mockResolvedValue({ id: 1, login: 'ci', type: 'Bot' });

      const url = await service.handleCallback({
        ...base,
        provider: 'github',
        page: 'profile',
        code: 'c',
      });

      expect(query(url).get('error')).toBe('bot_account');
      expect(github.revokeUserToken).toHaveBeenCalledWith(
        BUILTIN_GITHUB,
        'gh-token',
      );
      expect(db.on(IDENTITIES)).toHaveLength(0);
    });

    it('GitLab bot:true → bot_account, token still revoked', async () => {
      const { service, gitlab } = makeService(db);

      db.queue(MEMBERS, { data: [{ user_id: USER }] });
      gitlab.api.mockResolvedValue({
        id: 1,
        username: 'project_1_bot',
        bot: true,
      });

      const url = await service.handleCallback({
        ...base,
        provider: 'gitlab',
        page: 'profile',
        code: 'c',
      });

      expect(query(url).get('error')).toBe('bot_account');
      expect(gitlab.revoke).toHaveBeenCalledWith(BUILTIN_GITLAB, 'gl-token');
      expect(db.on(IDENTITIES)).toHaveLength(0);
    });

    it('account linked to someone else → identity_taken, token revoked', async () => {
      const { service, github } = makeService(db);

      db.queue(MEMBERS, { data: [{ user_id: USER }] });
      db.queue(IDENTITIES, { data: { id: 'x', user_id: OTHER } });

      const url = await service.handleCallback({
        ...base,
        provider: 'github',
        page: 'profile',
        code: 'c',
      });

      expect(query(url).get('error')).toBe('identity_taken');
      expect(github.revokeUserToken).toHaveBeenCalledWith(
        BUILTIN_GITHUB,
        'gh-token',
      );
    });

    it('GitHub success → connected=github, token revoked, profile page', async () => {
      const { service, github } = makeService(db);

      queueSuccess();

      const url = await service.handleCallback({
        ...base,
        provider: 'github',
        page: 'profile',
        code: 'the-code',
      });

      expect(url).toBe(
        'https://app.example.com/user-profile?tab=connectedAccounts&connected=github',
      );
      expect(github.exchangeCode).toHaveBeenCalledWith(
        BUILTIN_GITHUB,
        'the-code',
        'https://api.example.com/api/v1/git-integrations/github/callback',
      );
      expect(github.revokeUserToken).toHaveBeenCalledWith(
        BUILTIN_GITHUB,
        'gh-token',
      );
      expect(payload(db.on(IDENTITIES)[2], 'insert')).toMatchObject({
        external_user_id: '42',
        login: 'octo',
        avatar_url: 'https://avatars/octo',
        profile_url: 'https://github.com/octo',
      });
    });

    it('GitLab success → connected=gitlab, token revoked, integrations page', async () => {
      const { service, gitlab } = makeService(db);

      queueSuccess();

      const url = await service.handleCallback({
        ...base,
        provider: 'gitlab',
        page: 'integrations',
        code: 'c',
      });

      expect(url).toBe(
        'https://app.example.com/tenant-config?tab=integrations&integration=gitlab&connected=gitlab',
      );
      expect(gitlab.api).toHaveBeenCalledWith(
        BUILTIN_GITLAB,
        '/user',
        'gl-token',
      );
      expect(gitlab.revoke).toHaveBeenCalledWith(BUILTIN_GITLAB, 'gl-token');
      expect(payload(db.on(IDENTITIES)[2], 'insert')).toMatchObject({
        external_user_id: '7',
        login: 'tanuki',
        host: 'gitlab.com',
      });
    });

    it('a failing GET /user still revokes the token and maps to exchange_failed', async () => {
      const { service, github } = makeService(db);

      db.queue(MEMBERS, { data: [{ user_id: USER }] });
      github.getUser.mockRejectedValue(new Error('boom'));

      const url = await service.handleCallback({
        ...base,
        provider: 'github',
        page: 'profile',
        code: 'c',
      });

      expect(query(url).get('error')).toBe('exchange_failed');
      expect(github.revokeUserToken).toHaveBeenCalledWith(
        BUILTIN_GITHUB,
        'gh-token',
      );
    });

    it('a failing GitLab /user still revokes the token', async () => {
      const { service, gitlab } = makeService(db);

      db.queue(MEMBERS, { data: [{ user_id: USER }] });
      gitlab.api.mockRejectedValue(new Error('boom'));

      const url = await service.handleCallback({
        ...base,
        provider: 'gitlab',
        page: 'profile',
        code: 'c',
      });

      expect(query(url).get('error')).toBe('exchange_failed');
      expect(gitlab.revoke).toHaveBeenCalledWith(BUILTIN_GITLAB, 'gl-token');
    });

    it('a failing code exchange → exchange_failed', async () => {
      const { service, github } = makeService(db);

      db.queue(MEMBERS, { data: [{ user_id: USER }] });
      github.exchangeCode.mockRejectedValue(new Error('bad_verification_code'));

      const url = await service.handleCallback({
        ...base,
        provider: 'github',
        page: 'profile',
        code: 'c',
      });

      expect(query(url).get('error')).toBe('exchange_failed');
    });

    it('a database error → exchange_failed', async () => {
      const { service } = makeService(db);

      db.queue(MEMBERS, { error: { message: 'db down' } });

      const url = await service.handleCallback({
        ...base,
        provider: 'github',
        page: 'profile',
        code: 'c',
      });

      expect(query(url).get('error')).toBe('exchange_failed');
    });

    it('profile page forces tab=connectedAccounts and allow-lists the origin', async () => {
      const { service } = makeService(db);
      const url = await service.handleCallback({
        ...base,
        returnTo: 'https://evil.com',
        provider: 'github',
        page: 'profile',
        error: 'access_denied',
      });

      expect(url).toBe(
        'https://app.example.com/user-profile?tab=connectedAccounts&error=access_denied',
      );
    });

    it('integrations page goes to tenant-config with the provider', async () => {
      const { service } = makeService(db);
      const url = await service.handleCallback({
        ...base,
        provider: 'github',
        page: 'integrations',
        error: 'access_denied',
      });

      expect(url).toBe(
        'https://app.example.com/tenant-config?tab=integrations&integration=github&error=access_denied',
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('Azure DevOps personal link', () => {
    const input = (state?: string) => ({
      provider: 'azure_devops' as const,
      page: 'profile' as const,
      userId: USER,
      organizationId: ORG,
      returnTo: 'https://app.example.com',
      code: 'c',
      state,
    });

    it('needs the signed state, because the PKCE verifier derives from it', async () => {
      const { service, azureDevops } = makeService(db);

      db.queue(MEMBERS, { data: [{ user_id: USER }] });

      await expect(service.handleCallback(input())).resolves.toContain(
        'error=expired',
      );
      expect(azureDevops.exchangeCode).not.toHaveBeenCalled();
    });

    it('exchanges with the derived verifier and stores nothing of the token', async () => {
      const { service, azureDevops } = makeService(db);

      db.queue(MEMBERS, { data: [{ user_id: USER }] });
      db.queue(IDENTITIES, { data: null });

      await service.handleCallback(input('signed-state'));

      expect(azureDevops.exchangeCode.mock.calls[0][1]).toMatchObject({
        code: 'c',
        codeVerifier: pkceVerifier('signed-state'),
      });
      expect(azureDevops.profile).toHaveBeenCalledWith('az-token');
    });
  });

  describe('connectUrl', () => {
    it('github URL carries client_id, redirect_uri and an identity-tagged state', async () => {
      const { service } = makeService(db);
      const url = new URL(
        await service.connectUrl(
          'github',
          USER,
          ORG,
          'https://app.example.com/p',
          'profile',
        ),
      );

      expect(url.origin + url.pathname).toBe(
        'https://github.com/login/oauth/authorize',
      );
      expect(url.searchParams.get('client_id')).toBe('gh-client');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://api.example.com/api/v1/git-integrations/github/callback',
      );
      expect(url.searchParams.has('scope')).toBe(false);

      const state = readState(url.searchParams.get('state') ?? undefined);

      expect(state).toMatchObject({
        userId: USER,
        organizationId: ORG,
        returnTo: 'https://app.example.com',
      });
      expect(parseIdentityStateTag(state!.provider)).toEqual({
        provider: 'github',
        page: 'profile',
      });
    });

    it('azure_devops URL asks for the profile ONLY, never repository access', async () => {
      const { service, azureDevops } = makeService(db);

      await service.connectUrl(
        'azure_devops',
        USER,
        ORG,
        undefined,
        'profile',
      );

      const [, input] = azureDevops.authorizeUrl.mock.calls[0];

      expect(input.scope).toMatch(/\/vso\.profile$/);
      expect(input.scope).not.toMatch(/code|build|default/);
      expect(input.redirectUri).toBe(
        'https://api.example.com/api/v1/git-integrations/azure_devops/callback',
      );
      expect(input.codeVerifier).toBe(pkceVerifier(input.state));
    });

    it('gitlab URL asks for read_user ONLY', async () => {
      const { service } = makeService(db, {
        gitlabBaseUrl: 'https://gitlab.example.org',
      });
      const url = new URL(
        await service.connectUrl(
          'gitlab',
          USER,
          ORG,
          undefined,
          'integrations',
        ),
      );

      expect(url.origin + url.pathname).toBe(
        'https://gitlab.example.org/oauth/authorize',
      );
      expect(url.searchParams.getAll('scope')).toEqual(['read_user']);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('gl-client');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://api.example.com/api/v1/git-integrations/gitlab/callback',
      );

      const state = readState(url.searchParams.get('state') ?? undefined);

      expect(parseIdentityStateTag(state!.provider)).toEqual({
        provider: 'gitlab',
        page: 'integrations',
      });
    });

    it.each(['github', 'gitlab'] as const)(
      '%s not configured → BadRequest not_configured',
      async (provider) => {
        const { service } = makeService(db, {
          githubConfigured: false,
          gitlabConfigured: false,
        });

        await expect(
          service.connectUrl(provider, USER, ORG, undefined, 'profile'),
        ).rejects.toThrow(new BadRequestException('not_configured'));
      },
    );

    it('no state secret → BadRequest not_configured', async () => {
      const { service } = makeService(db);

      delete process.env.AI_ENCRYPTION_SECRET;

      await expect(
        service.connectUrl('github', USER, ORG, undefined, 'profile'),
      ).rejects.toThrow(new BadRequestException('not_configured'));
    });
  });

  // -------------------------------------------------------------------------
  describe('own servers (ticket 11)', () => {
    const SERVER_APP = expect.objectContaining({
      serverId: SERVER,
      host: 'gitlab.company.local',
      webUrl: 'https://gitlab.company.local/code',
    });

    it('connectUrl on a server uses its address, its client and a server-tagged state', async () => {
      const { service } = makeService(db, { servers: [GITLAB_SERVER] });
      const url = new URL(
        await service.connectUrl(
          'gitlab',
          USER,
          ORG,
          undefined,
          'profile',
          SERVER,
        ),
      );

      expect(url.origin + url.pathname).toBe(
        'https://gitlab.company.local/code/oauth/authorize',
      );
      expect(url.searchParams.get('client_id')).toBe('srv-client');
      expect(url.searchParams.getAll('scope')).toEqual(['read_user']);
      // One callback URL for every server: the state says which one.
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://api.example.com/api/v1/git-integrations/gitlab/callback',
      );

      const state = readState(url.searchParams.get('state') ?? undefined);

      expect(parseIdentityStateTag(state!.provider)).toEqual({
        provider: 'gitlab',
        page: 'profile',
        serverId: SERVER,
      });
    });

    it('connectUrl on a server without its OAuth client → not_configured; unknown server → NotFound', async () => {
      const { service } = makeService(db, {
        servers: [{ ...GITLAB_SERVER, secret: null }],
      });

      await expect(
        service.connectUrl('gitlab', USER, ORG, undefined, 'profile', SERVER),
      ).rejects.toThrow(new BadRequestException('not_configured'));
      await expect(
        service.connectUrl(
          'gitlab',
          USER,
          ORG,
          undefined,
          'profile',
          '44444444-4444-4444-8444-444444444444',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('callback on a server reads the account there and stores the server host; returns with server=', async () => {
      const { service, gitlab } = makeService(db, { servers: [GITLAB_SERVER] });

      db.queue(MEMBERS, { data: [{ user_id: USER }] });
      db.queue(IDENTITIES, { data: null }, { data: null }, { data: row() });

      const url = await service.handleCallback({
        userId: USER,
        organizationId: ORG,
        returnTo: 'https://app.example.com/x',
        provider: 'gitlab',
        page: 'integrations',
        code: 'c',
        serverId: SERVER,
      });

      expect(url).toBe(
        `https://app.example.com/tenant-config?tab=integrations&integration=gitlab&connected=gitlab&server=${SERVER}`,
      );
      expect(gitlab.exchangeCode).toHaveBeenCalledWith(
        SERVER_APP,
        'c',
        'https://api.example.com/api/v1/git-integrations/gitlab/callback',
      );
      expect(gitlab.api).toHaveBeenCalledWith(SERVER_APP, '/user', 'gl-token');
      expect(gitlab.revoke).toHaveBeenCalledWith(SERVER_APP, 'gl-token');

      const [owner, mine, write] = db.on(IDENTITIES);

      for (const chain of [owner, mine])
        expect(hasEq(chain, 'host', 'gitlab.company.local')).toBe(true);
      expect(payload(write, 'insert')).toMatchObject({
        provider: 'gitlab',
        host: 'gitlab.company.local',
        external_user_id: '7',
      });
    });

    it('listMine with the organization adds one entry per own server', async () => {
      const { service } = makeService(db, { servers: [GITLAB_SERVER] });

      db.queue(IDENTITIES, {
        data: [
          row({
            provider: 'gitlab',
            host: 'gitlab.company.local',
            login: 'worker',
          }),
        ],
      });

      const entries = await service.listMine(USER, ORG);

      expect(entries.map((e) => [e.provider, e.serverId, e.host])).toEqual([
        ['github', null, 'github.com'],
        ['gitlab', null, 'gitlab.com'],
        ['azure_devops', null, 'dev.azure.com'],
        ['gitlab', SERVER, 'gitlab.company.local'],
      ]);
      expect(entries[3]).toMatchObject({
        configured: true,
        serverName: 'Company GitLab',
        identity: { login: 'worker' },
      });
      expect(entries[1].identity).toBeNull();
    });

    it('on-premise: an own app on the built-in host replaces the unconfigured built-in entry', async () => {
      const { service } = makeService(db, {
        gitlabConfigured: false,
        servers: [
          {
            ...GITLAB_SERVER,
            host: 'gitlab.com',
            base_url: 'https://gitlab.com',
          },
        ],
      });

      db.queue(IDENTITIES, { data: [] });

      const entries = await service.listMine(USER, ORG);

      expect(
        entries.map((e) => [e.provider, e.serverId, e.configured]),
      ).toEqual([
        ['github', null, true],
        ['gitlab', SERVER, true],
        ['azure_devops', null, true],
      ]);
    });

    it('unlink, linked members and admin removal on a server filter on its host', async () => {
      const { service } = makeService(db, { servers: [GITLAB_SERVER] });

      db.queue(IDENTITIES, { data: [] });
      await service.unlink(USER, ORG, 'gitlab', SERVER);
      expect(hasEq(db.on(IDENTITIES)[0], 'host', 'gitlab.company.local')).toBe(
        true,
      );

      db.queue(MEMBERS, { data: [{ user_id: OTHER }] });
      db.queue(IDENTITIES, { data: [] });
      await service.listLinkedMembers(ORG, 'gitlab', SERVER);
      expect(hasEq(db.on(IDENTITIES)[1], 'host', 'gitlab.company.local')).toBe(
        true,
      );

      db.queue(MEMBERS, { data: [{ user_id: OTHER }] });
      db.queue(IDENTITIES, { data: [{ id: 'i', login: 'l' }] });
      await service.removeMemberLink(ORG, USER, 'gitlab', OTHER, SERVER);
      expect(hasEq(db.on(IDENTITIES)[2], 'host', 'gitlab.company.local')).toBe(
        true,
      );
    });

    it('a server of the other provider is refused', async () => {
      const { service } = makeService(db, { servers: [GITLAB_SERVER] });

      await expect(service.unlink(USER, ORG, 'github', SERVER)).rejects.toThrow(
        new BadRequestException('server_mismatch'),
      );
    });

    it('the resolvers look up accounts of the given repository host', async () => {
      const { service } = makeService(db);

      db.queue(IDENTITIES, { data: [] }, { data: [] });

      await service.resolveAuthors(
        ORG,
        'github',
        [{ externalId: '1', login: 'a' }],
        'ghe.company.local',
      );
      await service.resolveActor(
        ORG,
        'github',
        { externalId: null, login: 'b' } as never,
        'ghe.company.local',
      );

      for (const chain of db.on(IDENTITIES))
        expect(hasEq(chain, 'host', 'ghe.company.local')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('isBotAuthor', () => {
    it.each([
      [{ login: 'octo', type: 'User' }, false],
      [{ login: 'octo' }, false],
      [{ login: 'octo', type: null }, false],
      [{ login: 'github-actions', type: 'Bot' }, true],
      [{ login: 'acme', type: 'Organization' }, true],
      [{ login: 'dependabot[bot]' }, true],
      [{ login: 'renovate[bot]', type: null }, true],
      [{ login: 'Renovate[BOT]' }, true],
      [{ login: 'robot' }, false],
      [{ login: '[bot]user' }, false],
    ])('%p → %p', (author, expected) => {
      expect(isBotAuthor(author)).toBe(expected);
    });
  });
});
