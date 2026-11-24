/**
 * @fileoverview Unit tests for GithubIntegrationService: webhook signature / dedup / fan-out,
 * the connect callback branches, the signed pick token, manage URLs and the health check.
 * The core service and the GitHub client are mocked.
 * @module src/git-integrations/github/github-integration.service.spec
 */

import { createHmac } from 'node:crypto';

import { BadRequestException, ConflictException } from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { createState } from '../../calendar/integrations/calendar-oauth.state';
import type { GitIntegrationsService } from '../git-integrations.service';
import type { GitPullRequestsService } from '../git-pull-requests.service';
import type { GitServersService } from '../git-servers.service';
import { isAppComplete } from '../git-servers.service';
import type {
  IGitApp,
  IGitConnectionRow,
  IGitPullRequestSyncResult,
  IGitRepositoryRow,
  IProviderPullRequest,
} from '../git-integrations.types';
import { readToken, signToken } from '../git-integrations.util';
import { GithubApiError, type GithubAppClient } from './github-app.client';
import {
  buildFromGithubCheckRun,
  buildFromGithubRun,
  buildFromGithubStatus,
  GithubIntegrationService,
  reviewsFromGithub,
  toProviderCommit,
  toProviderPullRequest,
} from './github-integration.service';

const CFG = {
  appId: '1',
  appSlug: 'xisuite',
  privateKey: 'pem',
  clientId: 'cid',
  clientSecret: 'cs',
  webhookSecret: 'whsec',
};

/** The built-in App (env) as GitServersService resolves it. */
const BUILTIN: IGitApp = {
  serverId: null,
  provider: 'github',
  host: 'github.com',
  webUrl: 'https://github.com',
  apiUrl: 'https://api.github.com',
  ...CFG,
};

const SERVER_ID = '11111111-1111-1111-1111-111111111111';

/** An organization's own App on a GitHub Enterprise Server (ticket 11). */
const GHES: IGitApp = {
  ...BUILTIN,
  serverId: SERVER_ID,
  host: 'ghe.local',
  webUrl: 'https://ghe.local',
  apiUrl: 'https://ghe.local/api/v3',
  appId: '7',
  appSlug: 'xisuite-ghe',
  clientId: 'ghe-cid',
  webhookSecret: 'ghe-whsec',
};

const USER_ID = 'user-1';
const ORG_ID = 'org-1';
// Ticket 8: the webhook sender, passed on as the actor of a live delivery.
const SENDER = { id: 99, login: 'octo' };
const ACTOR = { externalId: '99', login: 'octo' };

function conn(overrides: Partial<IGitConnectionRow> = {}): IGitConnectionRow {
  return {
    id: 'conn-1',
    organization_id: ORG_ID,
    provider: 'github',
    host: 'github.com',
    external_account_id: '500',
    installation_id: '77',
    account_login: 'acme',
    account_name: null,
    account_type: 'Organization',
    avatar_url: null,
    account_url: null,
    credential_id: null,
    repository_selection: 'all',
    status: 'active',
    status_reason: null,
    status_changed_at: '',
    created_by: null,
    disconnected_by: null,
    disconnected_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

/** A live (enabled, present) repository row as findRepository returns it. */
const liveRepo = () =>
  ({
    id: 'repo-5',
    organization_id: ORG_ID,
    external_id: '5',
    full_name: 'acme/api',
    web_url: 'https://github.com/acme/api',
    is_enabled: true,
    removed_at: null,
  }) as unknown as IGitRepositoryRow;

const installation = (overrides: Record<string, unknown> = {}) => ({
  id: 77,
  app_id: 1,
  account: {
    id: 500,
    login: 'acme',
    type: 'Organization',
    avatar_url: 'a',
    html_url: 'h',
  },
  suspended_at: null,
  ...overrides,
});

function setup(cfg: Partial<typeof CFG> = CFG) {
  const core = {
    isOrgAdmin: jest.fn().mockResolvedValue(true),
    listConnections: jest.fn().mockResolvedValue([]),
    upsertConnection: jest
      .fn()
      .mockResolvedValue({ connection: conn(), created: true }),
    setStatus: jest.fn().mockResolvedValue(true),
    upsertRepositories: jest.fn().mockResolvedValue(undefined),
    markRepositoriesRemoved: jest.fn().mockResolvedValue(undefined),
    patchRepository: jest.fn().mockResolvedValue(undefined),
    findLiveByInstallation: jest.fn().mockResolvedValue([]),
    listAllLive: jest.fn().mockResolvedValue([]),
    updateAccountDetails: jest.fn().mockResolvedValue(undefined),
    recordDelivery: jest.fn().mockResolvedValue(true),
    setDeliveryOutcome: jest.fn().mockResolvedValue(undefined),
    forgetDelivery: jest.fn().mockResolvedValue(undefined),
    findRepository: jest.fn().mockResolvedValue(null),
    getConnection: jest.fn().mockResolvedValue(conn()),
  };
  const pullRequests = {
    recordReview: jest.fn().mockResolvedValue('approved'),
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
  const client = {
    exchangeCode: jest.fn().mockResolvedValue('user-token'),
    listUserInstallations: jest.fn().mockResolvedValue([installation()]),
    getInstallation: jest.fn().mockResolvedValue(installation()),
    installationToken: jest.fn().mockResolvedValue('inst'),
    listInstallationRepositories: jest.fn().mockResolvedValue([]),
    getUser: jest.fn().mockResolvedValue({ id: 900, login: 'me' }),
    getOrgMembership: jest
      .fn()
      .mockResolvedValue({ state: 'active', role: 'admin' }),
    getPull: jest.fn(),
    listPulls: jest.fn().mockResolvedValue([]),
    listReviews: jest.fn().mockResolvedValue([]),
    listBranches: jest.fn().mockResolvedValue([]),
    compareCommits: jest.fn().mockResolvedValue([]),
    listRunsForSha: jest.fn().mockResolvedValue([]),
    listCheckRunsForRef: jest.fn().mockResolvedValue([]),
    listStatusesForRef: jest.fn().mockResolvedValue([]),
    getApp: jest.fn().mockResolvedValue({ id: 1, slug: 'xisuite' }),
  };
  const builtin: IGitApp = { ...BUILTIN, ...cfg };

  for (const key of Object.keys(CFG) as (keyof typeof CFG)[])
    if (!(key in cfg) || cfg[key] === undefined) delete builtin[key];

  const servers = {
    publicApiUrl: 'https://api.example.com/api/v1',
    isBuiltinConfigured: jest.fn(() => isAppComplete(builtin)),
    builtinApp: jest.fn(() => builtin),
    builtinHost: jest.fn(() => 'github.com'),
    appFor: jest.fn(async (_org: string, _provider: string, host: string) =>
      host === 'github.com' ? builtin : GHES,
    ),
    appForStart: jest.fn(
      async (_org: string, _provider: string, serverId?: string | null) =>
        serverId ? GHES : builtin,
    ),
    findById: jest.fn().mockResolvedValue(null),
    toApp: jest.fn(() => GHES),
    touchWebhook: jest.fn().mockResolvedValue(undefined),
  };
  const service = new GithubIntegrationService(
    core as unknown as GitIntegrationsService,
    client as unknown as GithubAppClient,
    servers as unknown as GitServersService,
    pullRequests as unknown as GitPullRequestsService,
  );

  return { service, core, client, pullRequests, servers };
}

const user = { userId: USER_ID, organizationId: ORG_ID } as RequestUser;
const pickEntry = {
  id: 77,
  accountId: 500,
  login: 'acme',
  type: 'Organization',
  avatarUrl: null,
  url: null,
};
const pickToken = (u = USER_ID, o = ORG_ID) =>
  signToken({ u, o, i: [pickEntry] });
const params = (url: string) => new URL(url).searchParams;

function signed(body: unknown, secret = 'whsec') {
  const rawBody = Buffer.from(JSON.stringify(body));

  return {
    rawBody,
    signature: `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
  };
}

describe('GithubIntegrationService', () => {
  const SECRET_VARS = [
    'CALENDAR_STATE_SECRET',
    'AI_ENCRYPTION_SECRET',
    'JWT_SECRET',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const name of SECRET_VARS) savedEnv[name] = process.env[name];
    process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
  });

  afterAll(() => {
    for (const name of SECRET_VARS) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  it('rejects pick tokens when no signing secret is configured', async () => {
    const { service } = setup();
    const token = pickToken();

    for (const name of SECRET_VARS) delete process.env[name];

    try {
      expect(() => readToken(token)).toThrow();
      await expect(service.getPick(user, token)).rejects.toThrow();
    } finally {
      process.env.AI_ENCRYPTION_SECRET = 'a'.repeat(64);
    }
  });

  describe('config + urls', () => {
    it('isConfigured needs all six values', () => {
      expect(setup().service.isConfigured()).toBe(true);
      expect(
        setup({ ...CFG, webhookSecret: undefined }).service.isConfigured(),
      ).toBe(false);
    });

    it('connectUrl points at GitHub OAuth with our callback', async () => {
      const url = new URL(
        await setup().service.connectUrl(USER_ID, ORG_ID, undefined),
      );

      expect(url.origin + url.pathname).toBe(
        'https://github.com/login/oauth/authorize',
      );
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://api.example.com/api/v1/git-integrations/github/callback',
      );
      expect(url.searchParams.get('state')).toBeTruthy();
    });

    it('connectUrl rejects when not configured', async () => {
      await expect(
        setup({}).service.connectUrl(USER_ID, ORG_ID, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('manageUrl for organization and user installs', () => {
      const { service } = setup();

      expect(service.manageUrl(conn())).toBe(
        'https://github.com/organizations/acme/settings/installations/77',
      );
      expect(service.manageUrl(conn({ account_type: 'User' }))).toBe(
        'https://github.com/settings/installations/77',
      );
      expect(service.manageUrl(conn({ installation_id: null }))).toBeNull();
    });
  });

  describe('handleCallback', () => {
    const state = () => createState(USER_ID, ORG_ID, 'git:github');

    it('bad state -> expired', async () => {
      const { service } = setup();

      expect(
        params(await service.handleCallback({ code: 'c', state: 'nope' })).get(
          'error',
        ),
      ).toBe('expired');
      expect(
        params(
          await service.handleCallback({
            code: 'c',
            state: createState(USER_ID, ORG_ID, 'git:gitlab'),
          }),
        ).get('error'),
      ).toBe('expired');
    });

    it('setup_action=request -> pending_approval, nothing stored', async () => {
      const { service, core } = setup();
      const url = await service.handleCallback({
        state: state(),
        setupAction: 'request',
      });

      expect(params(url).get('error')).toBe('pending_approval');
      expect(core.upsertConnection).not.toHaveBeenCalled();
    });

    it('non-admin -> forbidden', async () => {
      const { service, core, client } = setup();

      core.isOrgAdmin.mockResolvedValue(false);

      expect(
        params(await service.handleCallback({ code: 'c', state: state() })).get(
          'error',
        ),
      ).toBe('forbidden');
      expect(client.exchangeCode).not.toHaveBeenCalled();
    });

    it('exchange failure -> exchange_failed', async () => {
      const { service, client } = setup();

      client.exchangeCode.mockRejectedValue(new Error('boom'));

      expect(
        params(await service.handleCallback({ code: 'c', state: state() })).get(
          'error',
        ),
      ).toBe('exchange_failed');
    });

    it('installation not in the user list -> installation_not_accessible', async () => {
      const { service, core } = setup();
      const url = await service.handleCallback({
        code: 'c',
        state: state(),
        installationId: '999',
      });

      expect(params(url).get('error')).toBe('installation_not_accessible');
      expect(core.upsertConnection).not.toHaveBeenCalled();
    });

    it('installation in the user list -> connected directly', async () => {
      const { service, core } = setup();
      const url = await service.handleCallback({
        code: 'c',
        state: state(),
        installationId: '77',
      });

      expect(params(url).get('connected')).toBe('github');
      expect(core.upsertConnection).toHaveBeenCalledWith({
        organizationId: ORG_ID,
        provider: 'github',
        host: 'github.com',
        account: {
          externalAccountId: '500',
          installationId: '77',
          login: 'acme',
          name: null,
          type: 'Organization',
          avatarUrl: 'a',
          url: 'h',
        },
        userId: USER_ID,
      });
      expect(core.upsertRepositories).toHaveBeenCalledWith(conn(), [], true);
    });

    it('already connected -> already_connected', async () => {
      const { service, core } = setup();

      core.upsertConnection.mockRejectedValue(new ConflictException());

      const url = await service.handleCallback({
        code: 'c',
        state: state(),
        installationId: '77',
      });

      expect(params(url).get('error')).toBe('already_connected');
    });

    it('update of an installation already connected here -> no error, repositories re-read', async () => {
      const { service, core, client } = setup();

      core.upsertConnection.mockRejectedValue(new ConflictException());
      core.findLiveByInstallation.mockResolvedValue([conn()]);

      const url = await service.handleCallback({
        code: 'c',
        state: state(),
        installationId: '77',
        setupAction: 'update',
      });

      expect(params(url).get('error')).toBeNull();
      expect(params(url).get('integration')).toBe('github');
      expect(core.findLiveByInstallation).toHaveBeenCalledWith(
        'github.com',
        '77',
        ORG_ID,
      );
      expect(client.listInstallationRepositories).toHaveBeenCalled();
    });

    it('update redirect without state (repository access changed on GitHub) -> no error', async () => {
      const { service } = setup();

      const url = await service.handleCallback({
        installationId: '77',
        setupAction: 'update',
      });

      expect(params(url).get('error')).toBeNull();
      expect(params(url).get('integration')).toBe('github');
    });

    it('update redirect with state but no code -> no error', async () => {
      const { service } = setup();

      const url = await service.handleCallback({
        state: state(),
        installationId: '77',
        setupAction: 'update',
      });

      expect(params(url).get('error')).toBeNull();
    });

    it('no installation id -> signed pick token bound to user + org', async () => {
      const { service } = setup();
      const url = await service.handleCallback({ code: 'c', state: state() });
      const payload = readToken<{
        u: string;
        o: string;
        i: { id: number; accountId: number }[];
      }>(params(url).get('pick') ?? undefined);

      expect(payload).toMatchObject({
        u: USER_ID,
        o: ORG_ID,
        i: [{ id: 77, accountId: 500 }],
      });
    });
  });

  describe('callback admin eligibility', () => {
    const state = () => createState(USER_ID, ORG_ID, 'git:github');
    const personal = (id: number) =>
      installation({
        id: 88,
        account: {
          id,
          login: 'me',
          type: 'User',
          avatar_url: null,
          html_url: null,
        },
      });
    const pickedIds = async (service: GithubIntegrationService) => {
      const url = await service.handleCallback({ code: 'c', state: state() });
      const payload = readToken<{ i: { id: number }[] }>(
        params(url).get('pick') ?? undefined,
      );

      return payload?.i.map((e) => e.id);
    };

    it('keeps an org admin', async () => {
      const { service, client } = setup();

      expect(await pickedIds(service)).toEqual([77]);
      expect(client.getOrgMembership).toHaveBeenCalledWith(
        BUILTIN,
        'user-token',
        'acme',
      );
    });

    it('filters out a plain member', async () => {
      const { service, client } = setup();

      client.getOrgMembership.mockResolvedValue({
        state: 'active',
        role: 'member',
      });

      expect(await pickedIds(service)).toEqual([]);
    });

    it('filters out a pending admin and a 404 membership', async () => {
      const { service, client } = setup();

      client.getOrgMembership.mockResolvedValueOnce({
        state: 'pending',
        role: 'admin',
      });
      expect(await pickedIds(service)).toEqual([]);

      client.getOrgMembership.mockRejectedValueOnce(
        new GithubApiError(404, 'nope'),
      );
      expect(await pickedIds(service)).toEqual([]);
    });

    it('keeps the own personal account, filters out another user', async () => {
      const { service, client } = setup();

      client.listUserInstallations.mockResolvedValue([personal(900)]);
      expect(await pickedIds(service)).toEqual([88]);

      client.listUserInstallations.mockResolvedValue([personal(901)]);
      expect(await pickedIds(service)).toEqual([]);
    });

    it('direct installationId that is not eligible -> not_account_admin', async () => {
      const { service, client, core } = setup();

      client.getOrgMembership.mockResolvedValue({
        state: 'active',
        role: 'member',
      });

      const url = await service.handleCallback({
        code: 'c',
        state: state(),
        installationId: '77',
      });

      expect(params(url).get('error')).toBe('not_account_admin');
      expect(core.upsertConnection).not.toHaveBeenCalled();
    });
  });

  describe('pick + connectInstallation', () => {
    it('getPick marks already-connected accounts and returns an install URL', async () => {
      const { service, core } = setup();

      core.listConnections.mockResolvedValue([conn()]);

      const pick = await service.getPick(user, pickToken());

      expect(pick.installations).toEqual([
        {
          id: '77',
          login: 'acme',
          type: 'Organization',
          avatarUrl: null,
          alreadyConnected: true,
        },
      ]);
      expect(pick.installUrl).toMatch(
        /^https:\/\/github\.com\/apps\/xisuite\/installations\/new\?state=/,
      );
    });

    it('getPick rejects a token of another user or org', async () => {
      const { service } = setup();

      await expect(
        service.getPick(user, pickToken('someone-else')),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.getPick(user, pickToken(USER_ID, 'org-2')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('connectInstallation rejects an id not in the token', async () => {
      const { service, core } = setup();

      await expect(
        service.connectInstallation(user, pickToken(), '999'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(core.upsertConnection).not.toHaveBeenCalled();
    });

    it('connectInstallation rejects an account id mismatch', async () => {
      const { service, core, client } = setup();

      client.getInstallation.mockResolvedValue(
        installation({ account: { id: 666, login: 'evil', type: 'User' } }),
      );

      await expect(
        service.connectInstallation(user, pickToken(), '77'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(core.upsertConnection).not.toHaveBeenCalled();
    });

    it('connectInstallation flags a suspended installation and survives a sync failure', async () => {
      const { service, core, client } = setup();

      client.getInstallation.mockResolvedValue(
        installation({ suspended_at: '2026-01-01' }),
      );
      client.listInstallationRepositories.mockRejectedValue(new Error('down'));

      await service.connectInstallation(user, pickToken(), '77');

      expect(core.setStatus).toHaveBeenCalledWith(
        conn(),
        'needs_attention',
        'suspended',
        USER_ID,
      );
    });
  });

  describe('refreshRepositories', () => {
    it('flags app_removed when the installation token cannot be minted', async () => {
      const { service, core, client } = setup();

      client.installationToken.mockRejectedValue(
        new GithubApiError(404, 'gone'),
      );

      await expect(service.refreshRepositories(conn())).rejects.toBeInstanceOf(
        GithubApiError,
      );
      expect(core.setStatus).toHaveBeenCalledWith(
        conn(),
        'needs_attention',
        'app_removed',
      );
    });

    it('maps repositories for a full sync', async () => {
      const { service, core, client } = setup();

      client.listInstallationRepositories.mockResolvedValue([
        {
          id: 1,
          full_name: 'acme/a',
          html_url: 'u',
          default_branch: 'main',
          private: true,
          archived: false,
        },
      ]);

      await service.refreshRepositories(conn());

      expect(core.upsertRepositories).toHaveBeenCalledWith(
        conn(),
        [
          {
            externalId: '1',
            fullName: 'acme/a',
            webUrl: 'u',
            defaultBranch: 'main',
            isPrivate: true,
            isArchived: false,
          },
        ],
        true,
      );
    });
  });

  describe('handleWebhook', () => {
    const body = { action: 'deleted', installation: { id: 77 } };

    it('rejects a missing or invalid signature', async () => {
      const { service, core } = setup();
      const { rawBody, signature } = signed(body, 'wrong');

      expect(
        await service.handleWebhook({
          event: 'installation',
          rawBody,
          signature,
        }),
      ).toBe('unauthorized');
      expect(
        await service.handleWebhook({
          event: 'installation',
          rawBody,
          signature: undefined,
        }),
      ).toBe('unauthorized');
      expect(
        await service.handleWebhook({
          event: 'installation',
          rawBody,
          signature: 'sha256=short',
        }),
      ).toBe('unauthorized');
      expect(core.recordDelivery).not.toHaveBeenCalled();
    });

    it('accepts a valid signature and flags every connection on installation.deleted', async () => {
      const { service, core } = setup();
      const a = conn();
      const b = conn({ id: 'conn-2', organization_id: 'org-2' });

      core.findLiveByInstallation.mockResolvedValue([a, b]);

      expect(
        await service.handleWebhook({
          event: 'installation',
          deliveryId: 'd1',
          ...signed(body),
        }),
      ).toBe('ok');
      expect(core.findLiveByInstallation).toHaveBeenCalledWith(
        'github.com',
        '77',
        undefined,
      );
      expect(core.setStatus).toHaveBeenCalledWith(
        a,
        'needs_attention',
        'app_removed',
      );
      expect(core.setStatus).toHaveBeenCalledWith(
        b,
        'needs_attention',
        'app_removed',
      );
      expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
        'github',
        'd1',
        'processed',
      );
    });

    it('skips a duplicate delivery', async () => {
      const { service, core } = setup();

      core.recordDelivery.mockResolvedValue(false);

      expect(
        await service.handleWebhook({
          event: 'installation',
          deliveryId: 'd1',
          ...signed(body),
        }),
      ).toBe('ok');
      expect(core.findLiveByInstallation).not.toHaveBeenCalled();
    });

    it('fans out: one organization failing does not stop the other', async () => {
      const { service, core } = setup();
      const a = conn();
      const b = conn({ id: 'conn-2', organization_id: 'org-2' });

      core.findLiveByInstallation.mockResolvedValue([a, b]);
      core.markRepositoriesRemoved.mockRejectedValueOnce(new Error('db down'));

      const payload = {
        action: 'removed',
        installation: { id: 77 },
        repositories_removed: [{ id: 10, full_name: 'acme/x' }],
      };

      expect(
        await service.handleWebhook({
          event: 'installation_repositories',
          deliveryId: 'd2',
          ...signed(payload),
        }),
      ).toBe('ok');
      expect(core.markRepositoriesRemoved).toHaveBeenCalledWith(a, ['10']);
      expect(core.markRepositoriesRemoved).toHaveBeenCalledWith(b, ['10']);
      // A failed delivery is forgotten so GitHub can redeliver it.
      expect(core.forgetDelivery).toHaveBeenCalledWith('github', 'd2');
      expect(core.setDeliveryOutcome).not.toHaveBeenCalled();
    });

    it('repositories_added upserts without a full sync, keeping and then reading the default branch', async () => {
      const { service, core, client } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);
      client.listInstallationRepositories.mockResolvedValue([
        {
          id: 5,
          full_name: 'acme/n',
          html_url: 'https://github.com/acme/n',
          default_branch: 'develop',
          private: true,
          archived: false,
        },
        {
          id: 6,
          full_name: 'acme/other',
          html_url: 'https://github.com/acme/other',
          default_branch: 'main',
          private: false,
          archived: false,
        },
      ]);

      await service.handleWebhook({
        event: 'installation_repositories',
        ...signed({
          action: 'added',
          installation: { id: 77 },
          repositories_added: [{ id: 5, full_name: 'acme/n', private: true }],
        }),
      });

      expect(core.upsertRepositories).toHaveBeenCalledWith(
        conn(),
        [
          {
            externalId: '5',
            fullName: 'acme/n',
            webUrl: 'https://github.com/acme/n',
            defaultBranch: undefined,
            isPrivate: true,
            isArchived: false,
          },
        ],
        false,
      );
      // Then the added repositories only (never a full sync), with their real default branch.
      expect(core.upsertRepositories).toHaveBeenLastCalledWith(
        conn(),
        [
          {
            externalId: '5',
            fullName: 'acme/n',
            webUrl: 'https://github.com/acme/n',
            defaultBranch: 'develop',
            isPrivate: true,
            isArchived: false,
          },
        ],
        false,
      );
    });

    it('repositories_added survives a failed detail read', async () => {
      const { service, core, client } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);
      client.listInstallationRepositories.mockRejectedValue(
        new GithubApiError(502, 'bad gateway'),
      );

      await service.handleWebhook({
        event: 'installation_repositories',
        ...signed({
          action: 'added',
          installation: { id: 77 },
          repositories_added: [{ id: 5, full_name: 'acme/n', private: true }],
        }),
      });

      expect(core.upsertRepositories).toHaveBeenCalledTimes(1);
      expect(core.setDeliveryOutcome).not.toHaveBeenCalledWith(
        expect.anything(),
        'error',
      );
    });

    it('check_run of another CI app is stored as a build; a GitHub Actions job is not', async () => {
      const { service, core, pullRequests } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);
      core.findRepository.mockResolvedValue(liveRepo());

      const checkRun = (slug: string) =>
        signed({
          action: 'completed',
          installation: { id: 77 },
          repository: { id: 5, full_name: 'acme/api' },
          check_run: {
            id: 42,
            name: 'ci/build',
            head_sha: 'a'.repeat(40),
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://github.com/acme/api/runs/42',
            started_at: '2026-10-25T10:00:00Z',
            completed_at: '2026-10-25T10:05:00Z',
            app: { id: 9, slug },
            check_suite: { head_branch: 'feature/XE-T1-x' },
          },
        });

      await service.handleWebhook({
        event: 'check_run',
        ...checkRun('circleci'),
      });
      await service.handleWebhook({
        event: 'check_run',
        ...checkRun('github-actions'),
        deliveryId: 'd-2',
      });

      expect(pullRequests.syncBuilds).toHaveBeenCalledTimes(1);
      expect(pullRequests.syncBuilds).toHaveBeenCalledWith(
        liveRepo(),
        [
          expect.objectContaining({
            externalId: 'check:42',
            name: 'ci/build',
            state: 'failed',
            headBranch: 'feature/XE-T1-x',
          }),
        ],
        true,
        expect.anything(),
      );
    });

    it('status is stored per commit and context, ordered by time only', async () => {
      const { service, core, pullRequests } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);
      core.findRepository.mockResolvedValue(liveRepo());

      await service.handleWebhook({
        event: 'status',
        ...signed({
          installation: { id: 77 },
          repository: { id: 5, full_name: 'acme/api' },
          id: 1,
          sha: 'b'.repeat(40),
          context: 'jenkins/pr',
          state: 'pending',
          target_url: 'https://ci.example.com/job/1',
          created_at: '2026-10-25T10:00:00Z',
          updated_at: '2026-10-25T10:00:00Z',
          branches: [{ name: 'main' }, { name: 'XE-T7-fix' }],
        }),
      });

      expect(pullRequests.syncBuilds).toHaveBeenCalledWith(
        liveRepo(),
        [
          expect.objectContaining({
            name: 'jenkins/pr',
            state: 'running',
            phase: 0,
            headBranch: 'XE-T7-fix',
            url: 'https://ci.example.com/job/1',
          }),
        ],
        true,
        expect.anything(),
      );
    });

    it('repository.renamed patches the row', async () => {
      const { service, core } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);

      await service.handleWebhook({
        event: 'repository',
        ...signed({
          action: 'renamed',
          installation: { id: 77 },
          repository: {
            id: 5,
            full_name: 'acme/new',
            html_url: 'h',
            default_branch: 'main',
            private: false,
            archived: false,
          },
        }),
      });

      expect(core.patchRepository).toHaveBeenCalledWith(conn(), '5', {
        full_name: 'acme/new',
        web_url: 'h',
        default_branch: 'main',
        is_private: false,
        is_archived: false,
      });
    });

    it('records no_connection and ignored events', async () => {
      const { service, core } = setup();

      await service.handleWebhook({
        event: 'installation',
        deliveryId: 'd3',
        ...signed(body),
      });
      expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
        'github',
        'd3',
        'no_connection',
      );

      await service.handleWebhook({
        event: 'issues',
        deliveryId: 'd4',
        ...signed(body),
      });
      expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
        'github',
        'd4',
        'ignored',
      );
    });
  });

  describe('pull requests (ticket 4)', () => {
    const repoRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'repo-1',
      organization_id: ORG_ID,
      external_id: '42',
      full_name: 'acme/api',
      is_enabled: true,
      removed_at: null,
      ...overrides,
    });
    const pull = (overrides: Record<string, unknown> = {}) => ({
      id: 9001,
      number: 12,
      title: 'XE-T1 and xe-t2',
      body: 'Fixes RM-T9',
      html_url: 'https://github.com/acme/api/pull/12',
      state: 'open',
      draft: true,
      merged: false,
      merged_at: null,
      closed_at: null,
      created_at: '2026-10-19T09:00:00Z',
      updated_at: '2026-10-19T10:00:00Z',
      head: { ref: 'XE-T656-git-integration', repo: { full_name: 'fork/api' } },
      base: { ref: 'main', repo: { full_name: 'acme/api' } },
      user: { id: 7, login: 'dev', avatar_url: 'av', type: 'User' },
      ...overrides,
    });
    const event = (action: string, pr = pull()) =>
      signed({
        action,
        installation: { id: 77 },
        repository: { id: 42, full_name: 'acme/api' },
        pull_request: pr,
        sender: SENDER,
      });

    it('normalises the payload and syncs it for each live repository', async () => {
      const { service, core, pullRequests } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);
      core.findRepository.mockResolvedValue(repoRow());

      await service.handleWebhook({
        event: 'pull_request',
        deliveryId: 'p1',
        ...event('opened'),
      });

      expect(core.findRepository).toHaveBeenCalledWith(conn(), '42');
      expect(pullRequests.sync).toHaveBeenCalledWith(
        repoRow(),
        {
          number: 12,
          externalId: '9001',
          title: 'XE-T1 and xe-t2',
          url: 'https://github.com/acme/api/pull/12',
          state: 'open',
          isDraft: true,
          sourceBranch: 'XE-T656-git-integration',
          targetBranch: 'main',
          headRepoFullName: 'fork/api',
          author: {
            externalId: '7',
            login: 'dev',
            avatarUrl: 'av',
            type: 'User',
          },
          openedAt: '2026-10-19T09:00:00Z',
          closedAt: null,
          mergedAt: null,
          updatedAt: '2026-10-19T10:00:00Z',
          body: 'Fixes RM-T9',
          mergeCommitShas: [],
          headSha: null,
        },
        ACTOR,
      );
      expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
        'github',
        'p1',
        'processed',
      );
    });

    it('a payload without a sender passes an empty actor (still a live delivery)', async () => {
      const { service, core, pullRequests } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);
      core.findRepository.mockResolvedValue(repoRow());

      await service.handleWebhook({
        event: 'pull_request',
        ...signed({
          action: 'closed',
          installation: { id: 77 },
          repository: { id: 42, full_name: 'acme/api' },
          pull_request: pull(),
        }),
      });

      expect(pullRequests.sync).toHaveBeenCalledWith(
        repoRow(),
        expect.anything(),
        { externalId: null, login: null },
      );
    });

    it('maps closed + merged_at to merged and a same-repo head to no fork', async () => {
      const { service, core, pullRequests } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);
      core.findRepository.mockResolvedValue(repoRow());

      await service.handleWebhook({
        event: 'pull_request',
        ...event(
          'closed',
          pull({
            state: 'closed',
            merged: true,
            merged_at: '2026-10-19T11:00:00Z',
            head: { ref: 'x', repo: { full_name: 'acme/api' } },
          }),
        ),
      });

      expect(pullRequests.sync.mock.calls[0][1]).toMatchObject({
        state: 'merged',
        mergedAt: '2026-10-19T11:00:00Z',
        headRepoFullName: null,
      });
    });

    it('skips unknown, disabled and removed repositories without failing', async () => {
      const { service, core, pullRequests } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);

      for (const row of [
        null,
        repoRow({ is_enabled: false }),
        repoRow({ removed_at: '2026-01-01' }),
      ]) {
        core.findRepository.mockResolvedValueOnce(row);
        await service.handleWebhook({
          event: 'pull_request',
          ...event('edited'),
        });
      }

      expect(pullRequests.sync).not.toHaveBeenCalled();
      expect(core.forgetDelivery).not.toHaveBeenCalled();
    });

    it('ignores actions that cannot change a link (labeled, assigned...)', async () => {
      const { service, core, pullRequests } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);
      core.findRepository.mockResolvedValue(repoRow());

      await service.handleWebhook({
        event: 'pull_request',
        deliveryId: 'p2',
        ...event('labeled'),
      });

      expect(pullRequests.sync).not.toHaveBeenCalled();
      expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
        'github',
        'p2',
        'ignored',
      );
    });

    it('fans out: each organization holding the installation syncs its own repository row', async () => {
      const { service, core, pullRequests } = setup();

      core.findLiveByInstallation.mockResolvedValue([
        conn(),
        conn({ id: 'c2', organization_id: 'org-2' }),
      ]);
      core.findRepository.mockImplementation((c: IGitConnectionRow) =>
        Promise.resolve(
          repoRow({
            id: `repo-${c.organization_id}`,
            organization_id: c.organization_id,
          }),
        ),
      );

      await service.handleWebhook({
        event: 'pull_request',
        ...event('opened'),
      });

      expect(
        pullRequests.sync.mock.calls.map((call) => call[0].organization_id),
      ).toEqual([ORG_ID, 'org-2']);
    });

    it('a sync failure forgets the delivery so it can be redelivered', async () => {
      const { service, core, pullRequests } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);
      core.findRepository.mockResolvedValue(repoRow());
      pullRequests.sync.mockRejectedValue(new Error('db down'));

      await service.handleWebhook({
        event: 'pull_request',
        deliveryId: 'p3',
        ...event('opened'),
      });

      expect(core.forgetDelivery).toHaveBeenCalledWith('github', 'p3');
    });

    it('fetchPullRequest maps a 404 to pull_request_not_found', async () => {
      const { service, client } = setup();

      client.getPull.mockRejectedValue(new GithubApiError(404, 'nope'));

      await expect(
        service.fetchPullRequest(conn(), repoRow() as never, 12),
      ).rejects.toThrow('pull_request_not_found');
    });

    it('fetchPullRequest without an installation is repository_not_connected', async () => {
      const { service } = setup();

      await expect(
        service.fetchPullRequest(
          conn({ installation_id: null }),
          repoRow() as never,
          12,
        ),
      ).rejects.toThrow('repository_not_connected');
    });

    it('listRecentPullRequests reads every open one and closed ones updated since the cutoff', async () => {
      const { service, client } = setup();
      const since = new Date('2026-09-19T00:00:00Z');

      client.listPulls
        .mockResolvedValueOnce([pull()])
        .mockResolvedValueOnce([pull({ number: 3, state: 'closed' })]);

      const result = await service.listRecentPullRequests(
        conn(),
        repoRow() as never,
        since,
      );

      expect(client.listPulls).toHaveBeenCalledWith(
        BUILTIN,
        '77',
        'acme/api',
        'open',
        10,
      );
      expect(client.listPulls).toHaveBeenCalledWith(
        BUILTIN,
        '77',
        'acme/api',
        'closed',
        10,
        since,
      );
      expect(result.map((pr) => pr.number)).toEqual([12, 3]);
    });

    // ---- Ticket 5: reviews and branches --------------------------------------------------

    const review = (
      id: number,
      state: string,
      at: string,
      login = `u${id}`,
    ) => ({
      id: Number(at.replace(/\D/g, '').slice(-6)),
      state,
      submitted_at: at,
      user: { id, login },
    });

    it("reviewsFromGithub keeps each reviewer's latest verdict; comments and pending never change it", () => {
      expect(
        reviewsFromGithub([
          review(1, 'APPROVED', '2026-10-19T10:00:00Z'),
          review(1, 'COMMENTED', '2026-10-19T10:05:00Z'),
          review(2, 'CHANGES_REQUESTED', '2026-10-19T10:01:00Z'),
          review(2, 'DISMISSED', '2026-10-19T10:02:00Z'),
          review(3, 'PENDING', '2026-10-19T10:03:00Z'),
          { id: 9, state: 'APPROVED', submitted_at: null, user: null },
        ]),
      ).toEqual([
        {
          reviewerId: '1',
          login: 'u1',
          state: 'approved',
          submittedAt: '2026-10-19T10:00:00Z',
        },
        {
          reviewerId: '2',
          login: 'u2',
          state: 'dismissed',
          submittedAt: '2026-10-19T10:02:00Z',
        },
      ]);
    });

    it('fetchPullRequest reads the reviews too', async () => {
      const { service, client } = setup();

      client.getPull.mockResolvedValue(pull());
      client.listReviews.mockResolvedValue([
        review(5, 'CHANGES_REQUESTED', '2026-10-19T10:00:00Z'),
      ]);

      const pr = await service.fetchPullRequest(conn(), repoRow() as never, 12);

      expect(client.listReviews).toHaveBeenCalledWith(
        BUILTIN,
        '77',
        'acme/api',
        12,
        3,
      );
      expect(pr.reviews).toEqual([
        {
          reviewerId: '5',
          login: 'u5',
          state: 'changes_requested',
          submittedAt: '2026-10-19T10:00:00Z',
        },
      ]);
    });

    it('the import reads reviews of open pull requests only', async () => {
      const { service, client } = setup();

      client.listPulls
        .mockResolvedValueOnce([pull()])
        .mockResolvedValueOnce([pull({ number: 3, state: 'closed' })]);

      const result = await service.listRecentPullRequests(
        conn(),
        repoRow() as never,
        new Date(),
      );

      expect(client.listReviews).toHaveBeenCalledTimes(1);
      expect(client.listReviews).toHaveBeenCalledWith(
        BUILTIN,
        '77',
        'acme/api',
        12,
        3,
      );
      expect(result.find((pr) => pr.number === 3)?.reviews).toBeUndefined();
      expect(result.find((pr) => pr.number === 12)?.reviews).toEqual([]);
    });

    it('listKeyBranches keeps branches with a task key only', async () => {
      const { service, client } = setup();

      client.listBranches.mockResolvedValue([
        { name: 'main' },
        { name: 'feature/XE-T5-x' },
      ]);

      await expect(
        service.listKeyBranches(conn(), repoRow() as never),
      ).resolves.toEqual([{ name: 'feature/XE-T5-x', pushedAt: null }]);
    });

    const reviewEvent = (action: string, state = 'approved') =>
      signed({
        action,
        installation: { id: 77 },
        repository: { id: 42, full_name: 'acme/api' },
        pull_request: pull(),
        review: {
          id: 1,
          state,
          submitted_at: '2026-10-19T11:00:00Z',
          user: { id: 7, login: 'dev' },
        },
      });

    it.each([
      ['submitted', 'changes_requested', 'changes_requested'],
      ['edited', 'approved', 'approved'],
      ['dismissed', 'dismissed', 'dismissed'],
    ])(
      'pull_request_review %s records the verdict',
      async (action, state, recorded) => {
        const { service, core, pullRequests } = setup();

        core.findLiveByInstallation.mockResolvedValue([conn()]);
        core.findRepository.mockResolvedValue(repoRow());

        await service.handleWebhook({
          event: 'pull_request_review',
          deliveryId: 'r1',
          ...reviewEvent(action, state),
        });

        expect(pullRequests.recordReview).toHaveBeenCalledWith(repoRow(), 12, {
          reviewerId: '7',
          login: 'dev',
          state: recorded,
          submittedAt: '2026-10-19T11:00:00Z',
        });
        expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
          'github',
          'r1',
          'processed',
        );
      },
    );

    it('a review on a disabled repository is skipped', async () => {
      const { service, core, pullRequests } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);
      core.findRepository.mockResolvedValue(repoRow({ is_enabled: false }));

      await service.handleWebhook({
        event: 'pull_request_review',
        ...reviewEvent('submitted'),
      });

      expect(pullRequests.recordReview).not.toHaveBeenCalled();
    });

    const branchEvent = (event: string, extra: Record<string, unknown>) =>
      signed({
        installation: { id: 77 },
        repository: { id: 42, full_name: 'acme/api' },
        sender: SENDER,
        ...extra,
      });

    it.each([
      [
        'create',
        { ref: 'XE-T5-fix', ref_type: 'branch' },
        'XE-T5-fix',
        false,
        'now',
      ],
      [
        'delete',
        { ref: 'XE-T5-fix', ref_type: 'branch' },
        'XE-T5-fix',
        true,
        null,
      ],
      [
        'push',
        {
          ref: 'refs/heads/XE-T5-fix',
          head_commit: { timestamp: '2026-10-19T12:00:00Z' },
        },
        'XE-T5-fix',
        false,
        '2026-10-19T12:00:00Z',
      ],
      [
        'push',
        { ref: 'refs/heads/XE-T5-fix', deleted: true, head_commit: null },
        'XE-T5-fix',
        true,
        null,
      ],
    ])(
      '%s %j syncs the branch',
      async (event, payload, name, deleted, pushedAt) => {
        const { service, core, pullRequests } = setup();

        core.findLiveByInstallation.mockResolvedValue([conn()]);
        core.findRepository.mockResolvedValue(repoRow());

        await service.handleWebhook({ event, ...branchEvent(event, payload) });

        expect(pullRequests.syncBranch).toHaveBeenCalledWith(
          repoRow(),
          name,
          pushedAt === 'now' ? expect.any(String) : pushedAt,
          deleted,
          ACTOR,
        );
      },
    );

    it.each([
      ['create', { ref: 'v1.0', ref_type: 'tag' }],
      ['delete', { ref: 'v1.0', ref_type: 'tag' }],
      ['push', { ref: 'refs/tags/v1.0' }],
    ])('%s of a tag is ignored', async (event, payload) => {
      const { service, core, pullRequests } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);
      core.findRepository.mockResolvedValue(repoRow());

      await service.handleWebhook({
        event,
        deliveryId: 't1',
        ...branchEvent(event, payload),
      });

      expect(pullRequests.syncBranch).not.toHaveBeenCalled();
      expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
        'github',
        't1',
        'ignored',
      );
    });

    it('a branch event never falls through to the repository handler', async () => {
      const { service, core } = setup();

      core.findLiveByInstallation.mockResolvedValue([conn()]);
      core.findRepository.mockResolvedValue(repoRow());

      await service.handleWebhook({
        event: 'push',
        ...branchEvent('push', { ref: 'refs/heads/main', action: 'deleted' }),
      });

      expect(core.patchRepository).not.toHaveBeenCalled();
    });

    describe('commits (ticket 6)', () => {
      const BEFORE = 'a'.repeat(40);
      const AFTER = 'b'.repeat(40);
      const pushed = (overrides: Record<string, unknown> = {}) => ({
        id: AFTER,
        message: 'Refs XE-T1 update docs',
        timestamp: '2026-10-19T12:00:00Z',
        url: `https://github.com/acme/api/commit/${AFTER}`,
        author: {
          name: 'Dev',
          email: 'payload@x.dev',
          username: 'dev-payload',
        },
        ...overrides,
      });
      const compared = {
        sha: AFTER,
        html_url: 'h',
        commit: {
          message: 'Refs XE-T1 update docs',
          author: {
            name: 'Dev Real',
            email: 'real@x.dev',
            date: '2026-10-18T08:00:00Z',
          },
          committer: {
            name: 'Dev Real',
            email: 'real@x.dev',
            date: '2026-10-19T11:59:00Z',
          },
        },
        author: { login: 'dev' },
      };
      const pushEvent = (extra: Record<string, unknown> = {}) =>
        branchEvent('push', {
          ref: 'refs/heads/XE-T1-docs',
          before: BEFORE,
          after: AFTER,
          head_commit: { timestamp: '2026-10-19T12:00:00Z' },
          commits: [pushed()],
          ...extra,
        });
      const live = (row: unknown = repoRow({ default_branch: 'main' })) => {
        const ctx = setup();

        ctx.core.findLiveByInstallation.mockResolvedValue([conn()]);
        ctx.core.findRepository.mockResolvedValue(row);
        ctx.pullRequests.commitLinkingEnabled.mockResolvedValue(true);
        ctx.client.compareCommits.mockResolvedValue([compared]);

        return ctx;
      };
      const expectNoCommitHandling = (ctx: ReturnType<typeof setup>) => {
        expect(ctx.pullRequests.commitLinkingEnabled).not.toHaveBeenCalled();
        expect(ctx.client.compareCommits).not.toHaveBeenCalled();
        expect(ctx.pullRequests.syncCommits).not.toHaveBeenCalled();
      };

      it('reads author dates via compare and syncs the commits', async () => {
        const ctx = live();

        await ctx.service.handleWebhook({
          event: 'push',
          deliveryId: 'c1',
          ...pushEvent(),
        });

        expect(ctx.client.compareCommits).toHaveBeenCalledWith(
          BUILTIN,
          '77',
          'acme/api',
          BEFORE,
          AFTER,
          10,
        );
        expect(ctx.pullRequests.syncCommits).toHaveBeenCalledWith(
          repoRow({ default_branch: 'main' }),
          'XE-T1-docs',
          [
            {
              sha: AFTER,
              message: 'Refs XE-T1 update docs',
              url: `https://github.com/acme/api/commit/${AFTER}`,
              authorName: 'Dev Real',
              authorEmail: 'real@x.dev',
              authorLogin: 'dev',
              authoredAt: '2026-10-18T08:00:00Z',
              committedAt: '2026-10-19T11:59:00Z',
            },
          ],
          ACTOR,
        );
        expect(ctx.core.setDeliveryOutcome).toHaveBeenCalledWith(
          'github',
          'c1',
          'processed',
        );
      });

      it('setting off: no compare, no sync, branch still synced', async () => {
        const ctx = live();

        ctx.pullRequests.commitLinkingEnabled.mockResolvedValue(false);
        await ctx.service.handleWebhook({
          event: 'push',
          deliveryId: 'c2',
          ...pushEvent(),
        });

        expect(ctx.pullRequests.commitLinkingEnabled).toHaveBeenCalledWith(
          repoRow({ default_branch: 'main' }),
        );
        expect(ctx.client.compareCommits).not.toHaveBeenCalled();
        expect(ctx.pullRequests.syncCommits).not.toHaveBeenCalled();
        expect(ctx.pullRequests.syncBranch).toHaveBeenCalled();
        expect(ctx.core.setDeliveryOutcome).toHaveBeenCalledWith(
          'github',
          'c2',
          'processed',
        );
      });

      it('no commit names a task key: the setting is never read', async () => {
        const ctx = live();

        await ctx.service.handleWebhook({
          event: 'push',
          ...pushEvent({ commits: [pushed({ message: 'update docs' })] }),
        });

        expectNoCommitHandling(ctx);
      });

      it('a new branch compares from the default branch', async () => {
        const ctx = live();

        await ctx.service.handleWebhook({
          event: 'push',
          ...pushEvent({ before: '0'.repeat(40) }),
        });

        expect(ctx.client.compareCommits).toHaveBeenCalledWith(
          BUILTIN,
          '77',
          'acme/api',
          'main',
          AFTER,
          10,
        );
      });

      it('a compare failure falls back to the payload timestamp and author', async () => {
        const ctx = live();

        ctx.client.compareCommits.mockRejectedValue(
          new GithubApiError(500, 'down'),
        );
        await ctx.service.handleWebhook({
          event: 'push',
          deliveryId: 'c3',
          ...pushEvent(),
        });

        expect(ctx.pullRequests.syncCommits).toHaveBeenCalledWith(
          expect.anything(),
          'XE-T1-docs',
          [
            expect.objectContaining({
              authorEmail: 'payload@x.dev',
              authorLogin: 'dev-payload',
              authoredAt: '2026-10-19T12:00:00Z',
              committedAt: '2026-10-19T12:00:00Z',
            }),
          ],
          ACTOR,
        );
        expect(ctx.core.setDeliveryOutcome).toHaveBeenCalledWith(
          'github',
          'c3',
          'processed',
        );
      });

      it.each([
        ['a deleted branch', { deleted: true, head_commit: null }],
        ['a tag', { ref: 'refs/tags/v1' }],
      ])('%s push handles no commits', async (_label, extra) => {
        const ctx = live();

        await ctx.service.handleWebhook({ event: 'push', ...pushEvent(extra) });

        expectNoCommitHandling(ctx);
      });

      it.each([
        ['unknown', null],
        ['disabled', repoRow({ is_enabled: false })],
        ['removed', repoRow({ removed_at: '2026-01-01' })],
      ])('a %s repository handles no commits', async (_label, row) => {
        const ctx = live(row);

        await ctx.service.handleWebhook({ event: 'push', ...pushEvent() });

        expectNoCommitHandling(ctx);
      });

      it('passes a closing message through unchanged', async () => {
        const ctx = live();

        await ctx.service.handleWebhook({
          event: 'push',
          ...pushEvent({ commits: [pushed({ message: 'Fixes XE-T1' })] }),
        });

        expect(ctx.pullRequests.syncCommits.mock.calls[0][2][0].message).toBe(
          'Fixes XE-T1',
        );
      });

      it('toProviderPullRequest: merge sha only once merged', () => {
        expect(
          toProviderPullRequest(
            pull({
              state: 'closed',
              merged: true,
              merged_at: '2026-10-19T11:00:00Z',
              merge_commit_sha: 'abc',
            }) as never,
          ).mergeCommitShas,
        ).toEqual(['abc']);
        expect(
          toProviderPullRequest(pull({ merge_commit_sha: 'abc' }) as never)
            .mergeCommitShas,
        ).toEqual([]);
      });

      it('toProviderCommit: compare values win, payload is the fallback', () => {
        expect(toProviderCommit(pushed(), undefined)).toEqual({
          sha: AFTER,
          message: 'Refs XE-T1 update docs',
          url: `https://github.com/acme/api/commit/${AFTER}`,
          authorName: 'Dev',
          authorEmail: 'payload@x.dev',
          authorLogin: 'dev-payload',
          authoredAt: '2026-10-19T12:00:00Z',
          committedAt: '2026-10-19T12:00:00Z',
        });
        expect(toProviderCommit(pushed(), compared)).toMatchObject({
          authorName: 'Dev Real',
          authorEmail: 'real@x.dev',
          authorLogin: 'dev',
          authoredAt: '2026-10-18T08:00:00Z',
          committedAt: '2026-10-19T11:59:00Z',
        });
        expect(
          toProviderCommit(
            pushed({ timestamp: undefined, author: null }),
            undefined,
          ),
        ).toMatchObject({
          authorName: null,
          authorEmail: null,
          authorLogin: null,
          authoredAt: null,
          committedAt: expect.any(String),
        });
      });
    });

    describe('builds (ticket 7)', () => {
      const SHA = 'c'.repeat(40);
      const run = (overrides: Record<string, unknown> = {}) => ({
        id: 555,
        name: 'CI',
        workflow_id: 31,
        run_attempt: 1,
        status: 'completed',
        conclusion: 'failure',
        head_branch: 'XE-T7-builds',
        head_sha: SHA,
        html_url: 'https://github.com/acme/api/actions/runs/555',
        created_at: '2026-10-19T12:00:00Z',
        updated_at: '2026-10-19T12:10:00Z',
        run_started_at: '2026-10-19T12:01:00Z',
        head_repository: { full_name: 'acme/api' },
        ...overrides,
      });
      const expected = (overrides: Record<string, unknown> = {}) => ({
        externalId: '555',
        workflowKey: '31',
        name: 'CI',
        headBranch: 'XE-T7-builds',
        headRepoFullName: null,
        headSha: SHA,
        state: 'failed',
        attempt: 1,
        url: 'https://github.com/acme/api/actions/runs/555',
        startedAt: '2026-10-19T12:01:00Z',
        completedAt: '2026-10-19T12:10:00Z',
        createdAt: '2026-10-19T12:00:00Z',
        updatedAt: '2026-10-19T12:10:00Z',
        ...overrides,
      });
      const runEvent = (action: string, wr = run()) =>
        signed({
          action,
          installation: { id: 77 },
          repository: { id: 42, full_name: 'acme/api' },
          workflow_run: wr,
          sender: SENDER,
        });
      const live = (row: unknown = repoRow()) => {
        const ctx = setup();

        ctx.core.findLiveByInstallation.mockResolvedValue([conn()]);
        ctx.core.findRepository.mockResolvedValue(row);

        return ctx;
      };

      it('a completed failed run syncs the exact build and is processed', async () => {
        const { service, core, pullRequests } = live();

        await service.handleWebhook({
          event: 'workflow_run',
          deliveryId: 'w1',
          ...runEvent('completed'),
        });

        expect(pullRequests.syncBuilds).toHaveBeenCalledWith(
          repoRow(),
          [expected()],
          true,
          ACTOR,
        );
        expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
          'github',
          'w1',
          'processed',
        );
      });

      it.each([
        ['in_progress', 'running'],
        ['requested', 'queued'],
      ])('%s -> %s, not completed', async (action, state) => {
        const { service, pullRequests } = live();

        await service.handleWebhook({
          event: 'workflow_run',
          ...runEvent(
            action,
            run({
              status: action === 'requested' ? 'queued' : action,
              conclusion: null,
            }),
          ),
        });

        expect(pullRequests.syncBuilds).toHaveBeenCalledWith(
          repoRow(),
          [expected({ state, completedAt: null })],
          true,
          ACTOR,
        );
      });

      it('a re-run passes its attempt', async () => {
        const { service, pullRequests } = live();

        await service.handleWebhook({
          event: 'workflow_run',
          ...runEvent('completed', run({ run_attempt: 2 })),
        });

        expect(pullRequests.syncBuilds).toHaveBeenCalledWith(
          repoRow(),
          [expected({ attempt: 2 })],
          true,
          ACTOR,
        );
      });

      it.each([
        ['someone/fork', 'someone/fork'],
        ['ACME/Api', null],
      ])(
        'head repository %s -> headRepoFullName %s',
        async (head, headRepoFullName) => {
          const { service, pullRequests } = live();

          await service.handleWebhook({
            event: 'workflow_run',
            ...runEvent(
              'completed',
              run({ head_repository: { full_name: head } }),
            ),
          });

          expect(pullRequests.syncBuilds).toHaveBeenCalledWith(
            repoRow(),
            [expected({ headRepoFullName })],
            true,
            ACTOR,
          );
        },
      );

      it('an unknown action is ignored', async () => {
        const { service, core, pullRequests } = live();

        await service.handleWebhook({
          event: 'workflow_run',
          deliveryId: 'w2',
          ...runEvent('edited'),
        });

        expect(pullRequests.syncBuilds).not.toHaveBeenCalled();
        expect(core.setDeliveryOutcome).toHaveBeenCalledWith(
          'github',
          'w2',
          'ignored',
        );
      });

      it.each([
        ['unknown', null],
        ['disabled', repoRow({ is_enabled: false })],
      ])('a run on an %s repository syncs nothing', async (_label, row) => {
        const { service, pullRequests } = live(row);

        await service.handleWebhook({
          event: 'workflow_run',
          ...runEvent('completed'),
        });

        expect(pullRequests.syncBuilds).not.toHaveBeenCalled();
      });

      it.each([
        ['success', 'passed'],
        ['neutral', 'passed'],
        ['failure', 'failed'],
        ['timed_out', 'failed'],
        ['startup_failure', 'failed'],
        ['cancelled', 'cancelled'],
        ['stale', 'cancelled'],
        ['skipped', 'skipped'],
        ['action_required', 'queued'],
      ])('buildFromGithubRun: conclusion %s -> %s', (conclusion, state) => {
        expect(
          buildFromGithubRun(run({ conclusion }) as never, 'acme/api').state,
        ).toBe(state);
      });

      it('buildFromGithubRun falls back to Workflow and attempt 1', () => {
        expect(
          buildFromGithubRun(
            run({ name: null, run_attempt: undefined }) as never,
            'acme/api',
          ),
        ).toMatchObject({ name: 'Workflow', attempt: 1 });
      });

      it('toProviderPullRequest reads headSha', () => {
        expect(
          toProviderPullRequest(pull({ head: { ref: 'x', sha: SHA } }) as never)
            .headSha,
        ).toBe(SHA);
        expect(toProviderPullRequest(pull() as never).headSha).toBeNull();
      });

      const shaPull = (overrides: Record<string, unknown> = {}) =>
        pull({
          head: {
            ref: 'XE-T7-builds',
            sha: SHA,
            repo: { full_name: 'acme/api' },
          },
          ...overrides,
        });

      it('fetchPullRequest attaches the runs of an open pull request', async () => {
        const { service, client, pullRequests } = setup();

        client.getPull.mockResolvedValue(shaPull());
        client.listRunsForSha.mockResolvedValue([run()]);

        const pr = await service.fetchPullRequest(
          conn(),
          repoRow() as never,
          12,
        );

        expect(client.listRunsForSha).toHaveBeenCalledWith(
          BUILTIN,
          '77',
          'acme/api',
          SHA,
        );
        expect(pr.builds).toEqual([expected()]);
        // Ticket 8: a manual link / import returns data; the caller syncs it without an actor.
        expect(pullRequests.sync).not.toHaveBeenCalled();
        expect(pullRequests.syncBuilds).not.toHaveBeenCalled();
      });

      it('fetchPullRequest reads no runs for a merged pull request', async () => {
        const { service, client } = setup();

        client.getPull.mockResolvedValue(
          shaPull({
            state: 'closed',
            merged: true,
            merged_at: '2026-10-19T13:00:00Z',
          }),
        );

        const pr = await service.fetchPullRequest(
          conn(),
          repoRow() as never,
          12,
        );

        expect(client.listRunsForSha).not.toHaveBeenCalled();
        expect(pr.builds).toEqual([]);
      });

      it('fetchPullRequest still links when the runs cannot be read', async () => {
        const { service, client } = setup();

        client.getPull.mockResolvedValue(shaPull());
        client.listRunsForSha.mockRejectedValue(
          new GithubApiError(500, 'boom'),
        );

        const pr = await service.fetchPullRequest(
          conn(),
          repoRow() as never,
          12,
        );

        expect(pr.number).toBe(12);
        expect(pr.builds).toEqual([]);
      });

      it('the import attaches builds to open pull requests only', async () => {
        const { service, client } = setup();

        client.listPulls
          .mockResolvedValueOnce([shaPull()])
          .mockResolvedValueOnce([shaPull({ number: 3, state: 'closed' })]);
        client.listRunsForSha.mockResolvedValue([run()]);

        const result = await service.listRecentPullRequests(
          conn(),
          repoRow() as never,
          new Date(),
        );

        expect(client.listRunsForSha).toHaveBeenCalledTimes(1);
        expect(result.find((pr) => pr.number === 12)?.builds).toEqual([
          expected(),
        ]);
        expect(result.find((pr) => pr.number === 3)?.builds).toBeUndefined();
      });
    });
  });

  describe('checkHealth', () => {
    it('404 -> needs attention (app_removed)', async () => {
      const { service, core, client } = setup();

      core.listAllLive.mockResolvedValue([conn()]);
      client.getInstallation.mockRejectedValue(new GithubApiError(404, 'gone'));

      await service.checkHealth();

      expect(core.setStatus).toHaveBeenCalledWith(
        conn(),
        'needs_attention',
        'app_removed',
      );
    });

    it('503 -> no status change', async () => {
      const { service, core, client } = setup();

      core.listAllLive.mockResolvedValue([conn()]);
      client.getInstallation.mockRejectedValue(new GithubApiError(503, 'down'));

      await service.checkHealth();

      expect(core.setStatus).not.toHaveBeenCalled();
    });

    it('healthy -> recovers app_removed and refreshes a changed login', async () => {
      const { service, core, client } = setup();
      const flagged = conn({
        status: 'needs_attention',
        status_reason: 'app_removed',
      });

      core.listAllLive.mockResolvedValue([flagged]);
      client.getInstallation.mockResolvedValue(
        installation({
          account: {
            id: 500,
            login: 'acme-renamed',
            type: 'Organization',
            avatar_url: 'a',
            html_url: 'h',
          },
        }),
      );

      await service.checkHealth();

      expect(core.setStatus).toHaveBeenCalledWith(
        flagged,
        'active',
        'app_removed',
      );
      expect(core.updateAccountDetails).toHaveBeenCalledWith(
        flagged,
        expect.objectContaining({ login: 'acme-renamed' }),
      );
    });
  });
  describe('checkHealth permissions (permissions_pending)', () => {
    const required = { metadata: 'read', checks: 'read', members: 'read' };

    it('flags a connection whose installation has not approved new permissions', async () => {
      const { service, core, client } = setup();

      core.listAllLive.mockResolvedValue([conn()]);
      client.getApp.mockResolvedValue({
        id: 1,
        slug: 'x',
        permissions: required,
      });
      client.getInstallation.mockResolvedValue(
        installation({ permissions: { metadata: 'read', members: 'read' } }),
      );

      await service.checkHealth();

      expect(core.setStatus).toHaveBeenCalledWith(
        conn(),
        'needs_attention',
        'permissions_pending',
      );
    });

    it('clears permissions_pending once everything is granted, reading the App once per run', async () => {
      const { service, core, client } = setup();
      const flagged = conn({
        status: 'needs_attention',
        status_reason: 'permissions_pending',
      });

      core.listAllLive.mockResolvedValue([
        flagged,
        conn({ id: 'conn-2', installation_id: '78' }),
      ]);
      client.getApp.mockResolvedValue({
        id: 1,
        slug: 'x',
        permissions: required,
      });
      client.getInstallation.mockResolvedValue(
        installation({
          permissions: { metadata: 'read', checks: 'write', members: 'read' },
        }),
      );

      await service.checkHealth();

      expect(core.setStatus).toHaveBeenCalledWith(
        flagged,
        'active',
        'permissions_pending',
      );
      expect(core.setStatus).not.toHaveBeenCalledWith(
        expect.anything(),
        'needs_attention',
        'permissions_pending',
      );
      expect(client.getApp).toHaveBeenCalledTimes(1);
    });

    it('a personal account is not flagged for organization permissions it cannot grant', async () => {
      const { service, core, client } = setup();

      core.listAllLive.mockResolvedValue([conn({ account_type: 'User' })]);
      client.getApp.mockResolvedValue({
        id: 1,
        slug: 'x',
        permissions: required,
      });
      client.getInstallation.mockResolvedValue(
        installation({
          account: {
            id: 500,
            login: 'acme',
            type: 'User',
            avatar_url: 'a',
            html_url: 'h',
          },
          permissions: { metadata: 'read', checks: 'read' },
        }),
      );

      await service.checkHealth();

      expect(core.setStatus).not.toHaveBeenCalledWith(
        expect.anything(),
        'needs_attention',
        'permissions_pending',
      );
    });

    it('an unreadable App never changes the status', async () => {
      const { service, core, client } = setup();

      core.listAllLive.mockResolvedValue([conn()]);
      client.getApp.mockRejectedValue(new GithubApiError(500, 'down'));
      client.getInstallation.mockResolvedValue(
        installation({ permissions: {} }),
      );

      await service.checkHealth();

      expect(core.setStatus).not.toHaveBeenCalled();
    });
  });

  describe('check runs and commit statuses (pure)', () => {
    it('buildFromGithubCheckRun skips GitHub Actions jobs and keys re-runs by app + name', () => {
      const run = {
        id: 1,
        name: 'lint',
        head_sha: 'c'.repeat(40),
        status: 'in_progress',
        conclusion: null,
        details_url: 'https://ci.example.com/1',
        app: { id: 9, slug: 'buildkite' },
      };

      expect(
        buildFromGithubCheckRun({
          ...run,
          app: { id: 15, slug: 'github-actions' },
        }),
      ).toBeNull();

      const first = buildFromGithubCheckRun(run)!;
      const rerun = buildFromGithubCheckRun({ ...run, id: 2 })!;

      expect(first).toMatchObject({
        externalId: 'check:1',
        state: 'running',
        url: 'https://ci.example.com/1',
      });
      expect(rerun.externalId).toBe('check:2');
      expect(rerun.workflowKey).toBe(first.workflowKey);
      expect(first.workflowKey.length).toBeLessThanOrEqual(64);
    });

    it('buildFromGithubStatus maps states, keeps one row per commit + context and falls back to the commit URL', () => {
      const base = {
        id: 1,
        sha: 'D'.repeat(40),
        context: 'jenkins',
        created_at: '2026-10-25T10:00:00Z',
      };

      expect(
        buildFromGithubStatus({ ...base, state: 'success' }, null),
      ).toBeNull();

      const failed = buildFromGithubStatus(
        { ...base, state: 'error', branches: [{ name: 'only' }] },
        'https://github.com/acme/api',
      )!;
      const again = buildFromGithubStatus(
        { ...base, id: 2, sha: 'd'.repeat(40), state: 'success' },
        'https://github.com/acme/api',
      )!;

      expect(failed).toMatchObject({
        state: 'failed',
        headBranch: 'only',
        url: `https://github.com/acme/api/commit/${'D'.repeat(40)}`,
        phase: 0,
      });
      expect(again.state).toBe('passed');
      expect(again.headBranch).toBeNull();
      expect(again.externalId).toBe(failed.externalId);
      expect(failed.externalId.length).toBeLessThanOrEqual(64);
    });
  });

  describe('own servers (ticket 11)', () => {
    const serverRow = {
      id: SERVER_ID,
      organization_id: ORG_ID,
      provider: 'github',
      host: 'ghe.local',
    };
    const body = { action: 'deleted', installation: { id: 77 } };

    it('the built-in webhook only reaches github.com connections', async () => {
      const { service, core } = setup();

      await service.handleWebhook({
        event: 'installation',
        deliveryId: 'd1',
        ...signed(body),
      });

      expect(core.findLiveByInstallation).toHaveBeenCalledWith(
        'github.com',
        '77',
        undefined,
      );
    });

    it('a server webhook is verified with that server secret, touched, and fanned out to its organization only', async () => {
      const { service, core, servers } = setup();

      servers.findById.mockResolvedValue(serverRow);

      expect(
        await service.handleWebhook({
          event: 'installation',
          deliveryId: 'd1',
          serverId: SERVER_ID,
          ...signed(body, 'ghe-whsec'),
        }),
      ).toBe('ok');
      expect(servers.touchWebhook).toHaveBeenCalledWith(SERVER_ID);
      expect(core.findLiveByInstallation).toHaveBeenCalledWith(
        'ghe.local',
        '77',
        ORG_ID,
      );
    });

    it('a server webhook signed with another secret (or unknown server) is unauthorized and not touched', async () => {
      const { service, core, servers } = setup();

      servers.findById.mockResolvedValue(serverRow);

      expect(
        await service.handleWebhook({
          event: 'installation',
          serverId: SERVER_ID,
          ...signed(body, 'whsec'),
        }),
      ).toBe('unauthorized');

      servers.findById.mockResolvedValue(null);

      expect(
        await service.handleWebhook({
          event: 'installation',
          serverId: SERVER_ID,
          ...signed(body, 'ghe-whsec'),
        }),
      ).toBe('unauthorized');
      expect(servers.touchWebhook).not.toHaveBeenCalled();
      expect(core.recordDelivery).not.toHaveBeenCalled();
    });

    it('a ping from the server is touched even though it is ignored', async () => {
      const { service, servers, core } = setup();

      servers.findById.mockResolvedValue(serverRow);

      expect(
        await service.handleWebhook({
          event: 'ping',
          deliveryId: 'p1',
          serverId: SERVER_ID,
          ...signed({ zen: 'hi', hook_id: 1 }, 'ghe-whsec'),
        }),
      ).toBe('ok');
      expect(servers.touchWebhook).toHaveBeenCalledWith(SERVER_ID);
      expect(core.findLiveByInstallation).not.toHaveBeenCalled();
    });

    it('connectUrl with a server uses the server authorize page and carries the server in the state', async () => {
      const { service } = setup();
      const url = new URL(
        await service.connectUrl(
          USER_ID,
          ORG_ID,
          undefined,
          undefined,
          SERVER_ID,
        ),
      );

      expect(url.origin + url.pathname).toBe(
        'https://ghe.local/login/oauth/authorize',
      );
      expect(url.searchParams.get('client_id')).toBe('ghe-cid');
    });

    it('connectUrl works with only a server when the built-in App is missing (on-premise)', async () => {
      const { service } = setup({});

      await expect(
        service.connectUrl(USER_ID, ORG_ID, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.connectUrl(USER_ID, ORG_ID, undefined, undefined, SERVER_ID),
      ).resolves.toContain('https://ghe.local/');
    });

    it('a reconnect follows the connection host to its server', async () => {
      const { service, core } = setup();

      core.getConnection.mockResolvedValue(conn({ host: 'ghe.local' }));

      expect(
        await service.connectUrl(USER_ID, ORG_ID, undefined, 'conn-1'),
      ).toContain('https://ghe.local/login/oauth/authorize');
    });

    it('the callback with a server tag connects with the server host and returns to the server page', async () => {
      const { service, core, client } = setup();

      client.listUserInstallations.mockResolvedValue([
        installation({ app_id: 7 }),
      ]);

      const url = await service.handleCallback({
        code: 'c',
        installationId: '77',
        state: createState(USER_ID, ORG_ID, `git:github@${SERVER_ID}`),
      });

      expect(client.exchangeCode).toHaveBeenCalledWith(
        GHES,
        'c',
        'https://api.example.com/api/v1/git-integrations/github/callback',
      );
      expect(core.upsertConnection).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'ghe.local' }),
      );
      expect(params(url).get('connected')).toBe('github');
      expect(params(url).get('server')).toBe(SERVER_ID);
    });

    it('the callback keeps only installations of the server App', async () => {
      const { service, client } = setup();

      client.listUserInstallations.mockResolvedValue([
        installation({ app_id: 1 }),
      ]);

      const url = await service.handleCallback({
        code: 'c',
        installationId: '77',
        state: createState(USER_ID, ORG_ID, `git:github@${SERVER_ID}`),
      });

      expect(params(url).get('error')).toBe('installation_not_accessible');
    });

    it('the pick carries the server: install link on the server, connect on its host', async () => {
      const { service, core } = setup();
      const token = signToken({
        u: USER_ID,
        o: ORG_ID,
        s: SERVER_ID,
        i: [pickEntry],
      });

      const pick = await service.getPick(user, token);

      expect(pick.installUrl).toMatch(
        /^https:\/\/ghe\.local\/github-apps\/xisuite-ghe\/installations\/new\?state=/,
      );

      await service.connectInstallation(user, token, '77');

      expect(core.upsertConnection).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'ghe.local' }),
      );
    });

    it('manageUrl and new repository links use the connection web origin', async () => {
      const { service } = setup();

      expect(
        service.manageUrl(
          conn({ host: 'ghe.local', account_url: 'https://ghe.local/acme' }),
        ),
      ).toBe('https://ghe.local/organizations/acme/settings/installations/77');
    });

    it('checkHealth checks each App separately, even without the built-in App', async () => {
      const { service, core, client } = setup({});

      core.listAllLive.mockResolvedValue([
        conn({ host: 'ghe.local' }),
        conn({ id: 'conn-2', organization_id: 'org-2' }),
      ]);
      client.getInstallation.mockResolvedValue(installation());

      await service.checkHealth();

      // The built-in App has no key here, so only the server's installation is read.
      expect(client.getInstallation).toHaveBeenCalledTimes(1);
      expect(client.getInstallation).toHaveBeenCalledWith(GHES, '77');
    });

    it('checkHealth skips a connection whose App cannot be resolved', async () => {
      const { service, core, client, servers } = setup();

      core.listAllLive.mockResolvedValue([conn({ host: 'gone.local' })]);
      servers.appFor.mockRejectedValue(new Error('server_not_configured'));

      await service.checkHealth();

      expect(client.getInstallation).not.toHaveBeenCalled();
      expect(core.setStatus).not.toHaveBeenCalled();
    });
  });
});
