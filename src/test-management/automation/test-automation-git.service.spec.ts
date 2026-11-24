import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import {
  GitCredentialTokens,
  type IGitCredentialRow,
} from '../../git-integrations/git-credential-tokens';
import { GithubAppClient } from '../../git-integrations/github/github-app.client';
import {
  GitlabApiError,
  GitlabClient,
} from '../../git-integrations/gitlab/gitlab.client';
import { GitIntegrationsService } from '../../git-integrations/git-integrations.service';
import type {
  IGitConnectionRow,
  IGitRepositoryRow,
} from '../../git-integrations/git-integrations.types';
import { GitServersService } from '../../git-integrations/git-servers.service';
import { EntitlementsService } from '../../licensing/entitlements.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  dispatchAddress,
  GitlabConnectionError,
  repositoryKey,
  TestAutomationGitService,
} from './test-automation-git.service';

const ORG = 'org-a';
const URL_A = 'https://github.com/acme/tests';

const connection = (over: Partial<IGitConnectionRow> = {}): IGitConnectionRow =>
  ({
    id: 'conn-1',
    organization_id: ORG,
    provider: 'github',
    host: 'github.com',
    installation_id: '42',
    status: 'active',
    status_reason: null,
    ...over,
  }) as IGitConnectionRow;

const repository = (over: Partial<IGitRepositoryRow> = {}): IGitRepositoryRow =>
  ({
    id: 'repo-1',
    organization_id: ORG,
    connection_id: 'conn-1',
    provider: 'github',
    full_name: 'acme/tests',
    web_url: URL_A,
    default_branch: 'main',
    is_private: true,
    is_archived: false,
    is_enabled: true,
    removed_at: null,
    ...over,
  }) as IGitRepositoryRow;

describe('repositoryKey', () => {
  it.each([
    [URL_A],
    ['https://GitHub.com/Acme/Tests'],
    ['https://github.com/acme/tests/'],
    ['https://github.com/acme/tests.git'],
    [' https://github.com/acme/tests.GIT/ '],
  ])('reads %s as the same repository', (url) => {
    expect(repositoryKey(url)).toBe('github.com/acme/tests');
  });

  it.each([
    ['http://github.com/acme/tests'],
    ['https://user:pass@github.com/acme/tests'],
    ['git@github.com:acme/tests.git'],
    ['https://github.com'],
    ['not a url'],
  ])('refuses %s', (url) => {
    expect(repositoryKey(url)).toBeNull();
  });

  it('keeps a different path different', () => {
    expect(repositoryKey(`${URL_A}/tree/main`)).not.toBe(repositoryKey(URL_A));
  });
});

describe('dispatchAddress', () => {
  const PATH = 'repos/acme/tests/actions/workflows/tests.yml/dispatches';

  it.each([
    [`https://api.github.com/${PATH}`],
    [`https://github.example.com/api/v3/${PATH}`],
  ])('reads %s', (url) => {
    expect(dispatchAddress(url)).toEqual({
      fullName: 'acme/tests',
      workflow: 'tests.yml',
    });
  });

  it.each([
    [`http://api.github.com/${PATH}`],
    [`https://api.github.com/${PATH}?x=1`],
    [`https://evil.example/${PATH}`],
    ['https://ci.example.com/job/a'],
    ['https://api.github.com/repos/acme/tests'],
    ['not a url'],
  ])('leaves %s alone', (url) => {
    expect(dispatchAddress(url)).toBeNull();
  });
});

describe('TestAutomationGitService.branchNames', () => {
  it('asks for at most 3 pages of the repository through the integration', async () => {
    const app = { apiUrl: 'https://api.github.com' };
    const listBranches = jest
      .fn()
      .mockResolvedValue([{ name: 'main' }, { name: 'dev' }]);
    const appFor = jest.fn().mockResolvedValue(app);
    const moduleRef = {
      get: (token: unknown) =>
        token === GithubAppClient ? { listBranches } : { appFor },
    };
    const service = new TestAutomationGitService(
      {} as unknown as SupabaseAdminService,
      {} as unknown as GitIntegrationsService,
      {} as unknown as EntitlementsService,
      moduleRef as unknown as ModuleRef,
    );

    await expect(
      service.branchNames({
        state: 'connected',
        repository: repository(),
        connection: connection(),
        installationId: '42',
      }),
    ).resolves.toEqual(['main', 'dev']);
    expect(appFor).toHaveBeenCalledWith(ORG, 'github', 'github.com');
    expect(listBranches).toHaveBeenCalledWith(app, '42', 'acme/tests', 3);
  });
});

describe('TestAutomationGitService', () => {
  const listConnections = jest.fn();
  const listRepositories = jest.fn();
  const getConnection = jest.fn();
  const licensed = jest.fn();
  const appFor = jest.fn();
  const installationToken = jest.fn();
  const moduleGet = jest.fn();
  const eq = jest.fn();
  const ilike = jest.fn();
  let rows: Partial<IGitRepositoryRow>[];
  let queryError: { message: string } | null;

  const chain = {
    select: () => chain,
    eq: (column: string, value: string) => {
      eq(column, value);

      return chain;
    },
    ilike: (column: string, value: string) => {
      ilike(column, value);

      return chain;
    },
    order: () => Promise.resolve({ data: rows, error: queryError }),
  };

  const service = () =>
    new TestAutomationGitService(
      {
        getClient: () => ({ from: () => chain }),
      } as unknown as SupabaseAdminService,
      {
        listConnections,
        listRepositories,
        getConnection,
      } as unknown as GitIntegrationsService,
      {
        getEffectiveEntitlements: () => Promise.resolve({ has: licensed }),
      } as unknown as EntitlementsService,
      { get: moduleGet } as unknown as ModuleRef,
    );

  beforeEach(() => {
    jest.resetAllMocks();
    rows = [repository()];
    queryError = null;
    licensed.mockReturnValue(true);
    getConnection.mockResolvedValue(connection());
    listConnections.mockResolvedValue([connection()]);
    listRepositories.mockResolvedValue([repository()]);
    moduleGet.mockImplementation((token: unknown) =>
      token === GitServersService ? { appFor } : { installationToken },
    );
  });

  describe('connectedRepositories', () => {
    it('reads through the integration and returns only the listed fields', async () => {
      await expect(service().connectedRepositories(ORG)).resolves.toEqual([
        {
          id: 'repo-1',
          provider: 'github',
          full_name: 'acme/tests',
          web_url: URL_A,
          default_branch: 'main',
          is_private: true,
        },
      ]);
      expect(listConnections).toHaveBeenCalledWith(ORG);
      expect(listRepositories).toHaveBeenCalledWith(ORG, 'conn-1');
    });

    it('names the account each repository was connected through', async () => {
      listConnections.mockResolvedValue([
        connection({ account_login: 'acme' }),
        connection({
          id: 'conn-2',
          provider: 'gitlab',
          account_login: 'qa-group',
        }),
      ]);
      listRepositories.mockImplementation((_org: string, id: string) =>
        Promise.resolve(
          id === 'conn-2'
            ? [
                repository({
                  id: 'repo-2',
                  connection_id: 'conn-2',
                  provider: 'gitlab',
                  full_name: 'qa-group/app',
                }),
              ]
            : [repository()],
        ),
      );

      const rows = await service().connectedRepositories(ORG);

      expect(rows.map((row) => [row.id, row.account])).toEqual([
        ['repo-1', 'acme'],
        ['repo-2', 'qa-group'],
      ]);
    });

    it('gives a GitLab project its trigger address, and GitHub none', async () => {
      appFor.mockResolvedValue({ apiUrl: 'https://gitlab.com/api/v4' });
      listConnections.mockResolvedValue([
        connection(),
        connection({ id: 'conn-2', provider: 'gitlab', host: 'gitlab.com' }),
      ]);
      listRepositories.mockImplementation((_org: string, id: string) =>
        Promise.resolve(
          id === 'conn-2'
            ? [
                repository({
                  id: 'repo-2',
                  connection_id: 'conn-2',
                  provider: 'gitlab',
                  external_id: '77',
                  full_name: 'qa/app',
                }),
              ]
            : [repository()],
        ),
      );

      const rows = await service().connectedRepositories(ORG);

      expect(rows.map((row) => [row.id, row.trigger_url])).toEqual([
        ['repo-1', undefined],
        ['repo-2', 'https://gitlab.com/api/v4/projects/77/trigger/pipeline'],
      ]);
      expect(appFor).toHaveBeenCalledWith(ORG, 'gitlab', 'gitlab.com');
    });

    it('leaves out the trigger address when the GitLab server cannot be read', async () => {
      appFor.mockRejectedValue(new Error('server removed'));
      listConnections.mockResolvedValue([
        connection({ provider: 'gitlab', host: 'gitlab.com' }),
      ]);
      listRepositories.mockResolvedValue([
        repository({ provider: 'gitlab', external_id: '77' }),
      ]);

      const [row] = await service().connectedRepositories(ORG);

      expect(row.id).toBe('repo-1');
      expect(row.trigger_url).toBeUndefined();
    });

    it('offers nothing and reads nothing without the licence', async () => {
      licensed.mockReturnValue(false);

      await expect(service().connectedRepositories(ORG)).resolves.toEqual([]);
      expect(listConnections).not.toHaveBeenCalled();
    });

    it.each([
      ['disabled', { is_enabled: false }],
      ['archived', { is_archived: true }],
      ['removed', { removed_at: '2026-01-01' }],
      ['without an address', { web_url: null }],
    ])('leaves out a %s repository', async (_name, over) => {
      listRepositories.mockResolvedValue([repository(over)]);

      await expect(service().connectedRepositories(ORG)).resolves.toEqual([]);
    });

    it('leaves out a connection that needs attention for another reason', async () => {
      listConnections.mockResolvedValue([
        connection({ status: 'needs_attention', status_reason: 'suspended' }),
      ]);

      await expect(service().connectedRepositories(ORG)).resolves.toEqual([]);
      expect(listRepositories).not.toHaveBeenCalled();
    });

    it('keeps a connection waiting on a permission to be accepted', async () => {
      listConnections.mockResolvedValue([
        connection({
          status: 'needs_attention',
          status_reason: 'permissions_pending',
        }),
      ]);

      await expect(service().connectedRepositories(ORG)).resolves.toHaveLength(
        1,
      );
    });

    it('sorts by name across connections and keeps GitLab rows', async () => {
      listConnections.mockResolvedValue([
        connection(),
        connection({ id: 'conn-2', provider: 'gitlab' }),
      ]);
      listRepositories.mockImplementation((_org: string, id: string) =>
        Promise.resolve(
          id === 'conn-1'
            ? [repository({ full_name: 'zeta/tests' })]
            : [
                repository({
                  id: 'repo-2',
                  provider: 'gitlab',
                  full_name: 'alpha/tests',
                }),
              ],
        ),
      );

      const list = await service().connectedRepositories(ORG);

      expect(list.map((row) => row.full_name)).toEqual([
        'alpha/tests',
        'zeta/tests',
      ]);
      expect(list[0].provider).toBe('gitlab');
    });
  });

  describe('findRepository', () => {
    it('matches inside this organization, GitHub only', async () => {
      const match = await service().findRepository(ORG, `${URL_A}.git`);

      expect(match).toMatchObject({
        state: 'connected',
        installationId: '42',
        repository: { id: 'repo-1' },
      });
      expect(eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(eq).toHaveBeenCalledWith('provider', 'github');
      expect(getConnection).toHaveBeenCalledWith(ORG, 'conn-1');
    });

    it('answers none when only another organization holds it', async () => {
      rows = [];

      await expect(service().findRepository(ORG, URL_A)).resolves.toEqual({
        state: 'none',
      });
      expect(getConnection).not.toHaveBeenCalled();
    });

    it('answers none for an address it cannot read, without a query', async () => {
      await expect(
        service().findRepository(ORG, 'git@github.com:acme/tests.git'),
      ).resolves.toEqual({ state: 'none' });
      expect(ilike).not.toHaveBeenCalled();
    });

    it('escapes wildcards, then still requires the exact repository', async () => {
      rows = [
        repository({ web_url: 'https://github.com/acme/my-tests' }),
        repository({
          id: 'repo-2',
          full_name: 'acme/my_tests',
          web_url: 'https://github.com/acme/my_tests',
        }),
      ];

      const match = await service().findRepository(
        ORG,
        'https://github.com/acme/my_tests',
      );

      expect(ilike).toHaveBeenCalledWith(
        'web_url',
        'https://github.com/acme/my\\_tests',
      );
      expect(match).toMatchObject({ repository: { id: 'repo-2' } });
    });

    it('never lets a percent sign match other repositories', async () => {
      rows = [repository({ web_url: 'https://github.com/acme/other' })];

      await expect(
        service().findRepository(ORG, 'https://github.com/acme/%'),
      ).resolves.toEqual({ state: 'none' });
      expect(ilike).toHaveBeenCalledWith(
        'web_url',
        'https://github.com/acme/\\%',
      );
    });

    it.each([
      ['disabled', { is_enabled: false }],
      ['archived', { is_archived: true }],
      ['removed', { removed_at: '2026-01-01' }],
    ])('answers unavailable for a %s repository', async (_name, over) => {
      rows = [repository(over)];

      await expect(service().findRepository(ORG, URL_A)).resolves.toMatchObject(
        { state: 'unavailable', repository: { id: 'repo-1' } },
      );
    });

    it('answers unavailable without the licence', async () => {
      licensed.mockReturnValue(false);

      await expect(service().findRepository(ORG, URL_A)).resolves.toMatchObject(
        { state: 'unavailable' },
      );
    });

    it.each([
      ['disconnected', { status: 'disconnected' }],
      ['suspended', { status: 'needs_attention', status_reason: 'suspended' }],
      ['without an installation', { installation_id: null }],
    ] as [string, Partial<IGitConnectionRow>][])(
      'answers unavailable for a %s connection',
      async (_name, over) => {
        getConnection.mockResolvedValue(connection(over));

        await expect(
          service().findRepository(ORG, URL_A),
        ).resolves.toMatchObject({ state: 'unavailable' });
      },
    );

    it('stays connected while a permission waits to be accepted', async () => {
      getConnection.mockResolvedValue(
        connection({
          status: 'needs_attention',
          status_reason: 'permissions_pending',
        }),
      );

      await expect(service().findRepository(ORG, URL_A)).resolves.toMatchObject(
        { state: 'connected' },
      );
    });

    it('answers unavailable when the connection row is gone', async () => {
      getConnection.mockRejectedValue(new NotFoundException());

      await expect(service().findRepository(ORG, URL_A)).resolves.toMatchObject(
        { state: 'unavailable' },
      );
    });

    it('passes on a real database failure', async () => {
      getConnection.mockRejectedValue(new Error('database down'));

      await expect(service().findRepository(ORG, URL_A)).rejects.toThrow(
        'database down',
      );
    });

    it('passes on a failed repository read', async () => {
      queryError = { message: 'read failed' };

      await expect(service().findRepository(ORG, URL_A)).rejects.toThrow(
        'read failed',
      );
    });

    it('prefers the live row over a removed one at the same address', async () => {
      rows = [
        repository({ id: 'repo-old', removed_at: '2026-01-01' }),
        repository({ id: 'repo-new' }),
      ];

      await expect(service().findRepository(ORG, URL_A)).resolves.toMatchObject(
        { state: 'connected', repository: { id: 'repo-new' } },
      );
    });
  });

  describe('finding by id or name', () => {
    it('finds a picked repository inside this organization only', async () => {
      await expect(
        service().findRepositoryById(ORG, 'repo-1'),
      ).resolves.toMatchObject({ state: 'connected' });
      expect(eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(eq).toHaveBeenCalledWith('id', 'repo-1');
    });

    it('answers none for an id this organization doesn’t hold', async () => {
      rows = [];

      await expect(
        service().findRepositoryById(ORG, 'repo-other'),
      ).resolves.toEqual({ state: 'none' });
    });

    it('finds a saved name in any casing, and only that name', async () => {
      rows = [
        repository({ id: 'repo-near', full_name: 'acme/testsX' }),
        repository({ id: 'repo-1', full_name: 'Acme/Tests' }),
      ];

      await expect(
        service().findRepositoryByName(ORG, 'acme/tests'),
      ).resolves.toMatchObject({ repository: { id: 'repo-1' } });
      expect(ilike).toHaveBeenCalledWith('full_name', 'acme/tests');
    });
  });

  describe('ciConnection', () => {
    const DISPATCH =
      'https://api.github.com/repos/acme/tests/actions/workflows/tests.yml/dispatches';

    beforeEach(() => {
      appFor.mockResolvedValue({ apiUrl: 'https://api.github.com' });
    });

    it('accepts the exact address of a connected repository', async () => {
      await expect(
        service().ciConnection(ORG, DISPATCH),
      ).resolves.toMatchObject({ state: 'connected', workflow: 'tests.yml' });
    });

    it('ignores an address that doesn’t start a workflow', async () => {
      await expect(
        service().ciConnection(ORG, 'https://ci.example.com/job/a'),
      ).resolves.toBeNull();
      expect(ilike).not.toHaveBeenCalled();
    });

    it('never treats a look-alike host as the repository', async () => {
      await expect(
        service().ciConnection(
          ORG,
          'https://evil.example/repos/acme/tests/actions/workflows/tests.yml/dispatches',
        ),
      ).resolves.toBeNull();
    });

    it('refuses a look-alike server path that the App doesn’t own', async () => {
      await expect(
        service().ciConnection(
          ORG,
          'https://evil.example/api/v3/repos/acme/tests/actions/workflows/tests.yml/dispatches',
        ),
      ).resolves.toEqual({ state: 'unavailable' });
    });

    it('refuses different casing, which isn’t the address it built', async () => {
      rows = [repository({ full_name: 'Acme/Tests' })];

      await expect(service().ciConnection(ORG, DISPATCH)).resolves.toEqual({
        state: 'unavailable',
      });
    });

    it('answers unavailable once the repository is gone', async () => {
      rows = [];

      await expect(service().ciConnection(ORG, DISPATCH)).resolves.toEqual({
        state: 'unavailable',
      });
    });

    it('answers unavailable when the repository was disabled', async () => {
      rows = [repository({ is_enabled: false })];

      await expect(service().ciConnection(ORG, DISPATCH)).resolves.toEqual({
        state: 'unavailable',
      });
    });
  });

  describe('tokenFor', () => {
    it('uses the integration for the App and the token of this installation', async () => {
      const app = { serverId: 'server-1' };

      appFor.mockResolvedValue(app);
      installationToken.mockResolvedValue('token-value');

      const match = await service().findRepository(ORG, URL_A);

      if (match.state !== 'connected') throw new Error('expected connected');

      await expect(service().tokenFor(match)).resolves.toBe('token-value');
      expect(appFor).toHaveBeenCalledWith(ORG, 'github', 'github.com');
      expect(installationToken).toHaveBeenCalledWith(app, '42');
    });

    it('finds services the integration does not export', async () => {
      const servers = { appFor: jest.fn().mockResolvedValue({}) };
      const client = {
        installationToken: jest.fn().mockResolvedValue('real-lookup'),
      };
      const compiled = await Test.createTestingModule({
        providers: [
          { provide: GitServersService, useValue: servers },
          { provide: GithubAppClient, useValue: client },
        ],
      }).compile();
      const looked = new TestAutomationGitService(
        {
          getClient: () => ({ from: () => chain }),
        } as unknown as SupabaseAdminService,
        { getConnection } as unknown as GitIntegrationsService,
        {
          getEffectiveEntitlements: () => Promise.resolve({ has: licensed }),
        } as unknown as EntitlementsService,
        compiled.get(ModuleRef),
      );
      const match = await looked.findRepository(ORG, URL_A);

      if (match.state !== 'connected') throw new Error('expected connected');

      await expect(looked.tokenFor(match)).resolves.toBe('real-lookup');
    });
  });

  describe('GitLab through its connection', () => {
    const API = 'https://gitlab.example.com/api/v4';
    const PIPELINE = `${API}/projects/42/pipeline`;
    const refresh = jest.fn();
    const config = { get: jest.fn() };
    const credential = {
      id: 'cred-1',
      organization_id: ORG,
      provider: 'gitlab',
      host: 'gitlab.example.com',
    } as IGitCredentialRow;
    const gitlabConnection = connection({
      provider: 'gitlab',
      host: 'gitlab.example.com',
      installation_id: null,
      credential_id: 'cred-1',
    });
    let read: jest.SpyInstance;
    let accessToken: jest.SpyInstance;

    beforeEach(() => {
      rows = [
        repository({
          provider: 'gitlab',
          host: 'gitlab.example.com',
          external_id: '42',
          full_name: 'group/app',
          web_url: 'https://gitlab.example.com/group/app',
        }),
      ];
      getConnection.mockResolvedValue(gitlabConnection);
      appFor.mockResolvedValue({ apiUrl: API });
      config.get.mockReturnValue('https://api.example.com/');
      moduleGet.mockImplementation((token: unknown) => {
        if (token === GitServersService) return { appFor };
        if (token === GitlabClient) return { refresh };

        return token === ConfigService ? config : {};
      });
      read = jest
        .spyOn(GitCredentialTokens.prototype, 'read')
        .mockResolvedValue(credential);
      accessToken = jest
        .spyOn(GitCredentialTokens.prototype, 'getAccessToken')
        .mockResolvedValue('gl-oauth-1');
    });

    afterEach(() => {
      read.mockRestore();
      accessToken.mockRestore();
    });

    it('accepts only the exact pipeline address of a connected project', async () => {
      await expect(
        service().gitlabCiConnection(ORG, PIPELINE),
      ).resolves.toMatchObject({
        repository: { full_name: 'group/app', external_id: '42' },
        connection: { id: 'conn-1' },
        app: { apiUrl: API },
      });
      expect(eq).toHaveBeenCalledWith('organization_id', ORG);
      expect(eq).toHaveBeenCalledWith('provider', 'gitlab');
      expect(eq).toHaveBeenCalledWith('external_id', '42');
    });

    it.each([
      [`${API}/projects/42/trigger/pipeline`],
      [`${PIPELINE}?private_token=x`],
      ['https://ci.example.com/job/a'],
    ])('leaves %s on today’s path without a lookup', async (url) => {
      await expect(service().gitlabCiConnection(ORG, url)).resolves.toBeNull();
      expect(eq).not.toHaveBeenCalled();
    });

    it('never matches a project with the same id on another server', async () => {
      appFor.mockResolvedValue({ apiUrl: 'https://other.example.com/api/v4' });

      await expect(
        service().gitlabCiConnection(ORG, PIPELINE),
      ).resolves.toBeNull();
    });

    it.each([
      ['needs attention', { status: 'needs_attention' }],
      ['is a GitHub one', { provider: 'github' }],
    ] as const)(
      'answers unavailable when the connection %s',
      async (_name, over) => {
        getConnection.mockResolvedValue({ ...gitlabConnection, ...over });

        await expect(service().gitlabCiConnection(ORG, PIPELINE)).resolves.toBe(
          'unavailable',
        );
      },
    );

    it('answers unavailable without the licence', async () => {
      licensed.mockReturnValue(false);

      await expect(service().gitlabCiConnection(ORG, PIPELINE)).resolves.toBe(
        'unavailable',
      );
    });

    it('finds a picked GitLab project, and nothing once it is disabled', async () => {
      await expect(
        service().gitlabRepositoryById(ORG, 'repo-1'),
      ).resolves.toMatchObject({ repository: { id: 'repo-1' } });

      rows = [repository({ provider: 'gitlab', is_enabled: false })];

      await expect(
        service().gitlabRepositoryById(ORG, 'repo-1'),
      ).resolves.toBeNull();
    });

    it('builds the pipeline address from the server’s API root', async () => {
      const match = await service().gitlabRepositoryById(ORG, 'repo-1');

      if (!match) throw new Error('expected a match');

      expect(service().gitlabPipelineUrl(match)).toBe(PIPELINE);
    });

    it('gets a token from the connection’s own sign-in', async () => {
      await expect(service().gitlabToken(ORG, gitlabConnection)).resolves.toBe(
        'gl-oauth-1',
      );
      expect(read).toHaveBeenCalledWith('cred-1', ORG);
      expect(accessToken).toHaveBeenCalledWith(credential);
    });

    it('refreshes with the same app and callback address as the integration', async () => {
      const app = { apiUrl: API };

      appFor.mockResolvedValue(app);
      // The refresh the integration's token code would call when the token is near expiry.
      accessToken.mockImplementation(function (this: GitCredentialTokens) {
        const deps = Reflect.get(this, 'deps') as {
          refresh(row: IGitCredentialRow, token: string): Promise<unknown>;
        };

        return deps.refresh(credential, 'refresh-1');
      });
      refresh.mockResolvedValue('renewed');

      await service().gitlabToken(ORG, gitlabConnection);

      expect(appFor).toHaveBeenCalledWith(ORG, 'gitlab', 'gitlab.example.com');
      expect(refresh).toHaveBeenCalledWith(
        app,
        'refresh-1',
        'https://api.example.com/git-integrations/gitlab/callback',
      );
    });

    it.each([
      ['no sign-in', () => read.mockResolvedValue(null)],
      [
        'a refused refresh',
        () =>
          accessToken.mockRejectedValue(
            new GitlabApiError(400, 'bad', 'invalid_grant'),
          ),
      ],
      [
        'an expired sign-in',
        () => accessToken.mockRejectedValue(new GitlabApiError(401, 'expired')),
      ],
    ])('asks for a reconnect after %s', async (_name, arrange) => {
      arrange();

      await expect(
        service().gitlabToken(ORG, gitlabConnection),
      ).rejects.toBeInstanceOf(GitlabConnectionError);
    });

    it('asks for a reconnect when the connection has no sign-in at all', async () => {
      await expect(
        service().gitlabToken(ORG, {
          ...gitlabConnection,
          credential_id: null,
        }),
      ).rejects.toBeInstanceOf(GitlabConnectionError);
      expect(read).not.toHaveBeenCalled();
    });

    it('passes on an outage, which a retry may fix', async () => {
      accessToken.mockRejectedValue(new GitlabApiError(503, 'down'));

      await expect(
        service().gitlabToken(ORG, gitlabConnection),
      ).rejects.toBeInstanceOf(GitlabApiError);
    });
  });
});
