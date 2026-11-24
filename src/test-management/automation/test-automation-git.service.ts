import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';

import { GitCredentialTokens } from '../../git-integrations/git-credential-tokens';
import { GithubAppClient } from '../../git-integrations/github/github-app.client';
import {
  GitlabApiError,
  GitlabClient,
} from '../../git-integrations/gitlab/gitlab.client';
import { GitIntegrationsService } from '../../git-integrations/git-integrations.service';
import type {
  IGitApp,
  IGitConnectionRow,
  IGitRepositoryRow,
} from '../../git-integrations/git-integrations.types';
import { GitServersService } from '../../git-integrations/git-servers.service';
import { EntitlementsService } from '../../licensing/entitlements.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestAutomationGitRepository } from '../dto/test-automation.dto';
import type { GithubAccess } from './test-automation-github.client';
import {
  gitlabBearerAccess,
  gitlabPipelineAddress,
  readToolJson,
} from './test-automation-gitlab.client';

const LICENCE = 'feature_external_integrations';

export const GITLAB_RECONNECT =
  'The GitLab connection needs a new sign-in. Reconnect GitLab in Tenant Configuration under Integrations';

/** The GitLab account connected in Integrations can't give a token until someone reconnects it. */
export class GitlabConnectionError extends Error {
  constructor() {
    super(GITLAB_RECONNECT);
    this.name = 'GitlabConnectionError';
  }
}

// At most 300 branches are offered; other names can still be typed.
const BRANCH_PAGES = 3;
const MATCH_COLUMNS =
  'id, connection_id, full_name, web_url, default_branch, is_private, is_archived, is_enabled, removed_at';

type MatchedRepository = Pick<
  IGitRepositoryRow,
  | 'id'
  | 'connection_id'
  | 'full_name'
  | 'web_url'
  | 'default_branch'
  | 'is_private'
  | 'is_archived'
  | 'is_enabled'
  | 'removed_at'
>;

export type GitRepositoryMatch =
  | {
      state: 'connected';
      repository: MatchedRepository;
      connection: IGitConnectionRow;
      installationId: string;
    }
  | { state: 'unavailable'; repository: MatchedRepository }
  | { state: 'none' };

export type ConnectedMatch = Extract<
  GitRepositoryMatch,
  { state: 'connected' }
>;

export type CiConnection =
  | { state: 'connected'; match: ConnectedMatch; workflow: string }
  | { state: 'unavailable' };

const GITLAB_COLUMNS = `${MATCH_COLUMNS}, external_id, host`;

type GitlabRepository = MatchedRepository &
  Pick<IGitRepositoryRow, 'external_id' | 'host'>;

/** A GitLab project usable through its connection, with the server it lives on. */
export interface GitlabMatch {
  repository: GitlabRepository;
  connection: IGitConnectionRow;
  app: IGitApp;
}

const DISPATCH_PATH =
  /^\/(?:api\/v3\/)?repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/;

// Wildcards in a name must match only themselves.
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');

/** The repository and workflow of a GitHub workflow start address; null for any other address. */
export function dispatchAddress(
  ciUrl: string,
): { fullName: string; workflow: string } | null {
  try {
    const parsed = new URL(ciUrl);
    const shape = DISPATCH_PATH.exec(parsed.pathname);
    const github =
      parsed.hostname === 'api.github.com' ||
      parsed.pathname.startsWith('/api/v3/');

    if (parsed.protocol !== 'https:' || parsed.search || !shape || !github) {
      return null;
    }

    return { fullName: shape[1], workflow: shape[2] };
  } catch {
    return null;
  }
}

/** Host and path in one form, so casing, a trailing slash or .git can't hide a match. */
export function repositoryKey(url: string): string | null {
  try {
    const parsed = new URL(url.trim());

    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return null;
    }

    const path = parsed.pathname
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();

    return path ? `${parsed.host.toLowerCase()}${path}` : null;
  } catch {
    return null;
  }
}

// Tokens keep working while an owner hasn't accepted a new permission yet.
function connectionUsable(connection: IGitConnectionRow): boolean {
  return (
    connection.status === 'active' ||
    (connection.status === 'needs_attention' &&
      connection.status_reason === 'permissions_pending')
  );
}

function repositoryUsable(repository: MatchedRepository): boolean {
  return (
    repository.is_enabled &&
    !repository.is_archived &&
    !repository.removed_at &&
    Boolean(repository.web_url)
  );
}

/** What Test Management needs from the Tenant Configuration integration: its repositories and tokens. */
@Injectable()
export class TestAutomationGitService {
  private readonly logger = new Logger(TestAutomationGitService.name);
  private gitlabCredentials?: GitCredentialTokens;

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly integrations: GitIntegrationsService,
    private readonly entitlements: EntitlementsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private async licensed(organizationId: string): Promise<boolean> {
    const entitlements =
      await this.entitlements.getEffectiveEntitlements(organizationId);

    return entitlements.has(LICENCE);
  }

  /** Whether this organization may use the connections of Tenant Configuration > Integrations. */
  externalIntegrationsLicensed(organizationId: string): Promise<boolean> {
    return this.licensed(organizationId);
  }

  /** Repositories an admin enabled in Tenant Configuration; none without the licence. */
  async connectedRepositories(
    organizationId: string,
  ): Promise<TestAutomationGitRepository[]> {
    if (!(await this.licensed(organizationId))) return [];

    const connections = (
      await this.integrations.listConnections(organizationId)
    ).filter(connectionUsable);
    const lists = await Promise.all(
      connections.map(async (connection) => {
        const [rows, apiUrl] = await Promise.all([
          this.integrations.listRepositories(organizationId, connection.id),
          connection.provider === 'gitlab'
            ? this.gitlabApiUrl(organizationId, connection.host)
            : null,
        ]);

        return rows.map((row) => ({
          row,
          account: connection.account_login,
          triggerUrl: apiUrl
            ? `${apiUrl}/projects/${row.external_id}/trigger/pipeline`
            : null,
        }));
      }),
    );

    return lists
      .flat()
      .filter(({ row }) => repositoryUsable(row))
      .sort((a, b) => a.row.full_name.localeCompare(b.row.full_name))
      .map(({ row, account, triggerUrl }) => ({
        id: row.id,
        provider: row.provider,
        full_name: row.full_name,
        web_url: row.web_url as string,
        default_branch: row.default_branch,
        is_private: row.is_private,
        account,
        ...(triggerUrl && { trigger_url: triggerUrl }),
      }));
  }

  /**
   * The GitHub repository of this organization at this address. GitLab answers 'none' and stays on
   * today's path; only CI jobs reach GitLab, through gitlabCiConnection.
   */
  async findRepository(
    organizationId: string,
    url: string,
  ): Promise<GitRepositoryMatch> {
    const key = repositoryKey(url);

    if (!key) return { state: 'none' };

    const rows = await this.readRows(
      organizationId,
      'web_url',
      escapeLike(`https://${key}`),
    );

    return this.resolve(
      organizationId,
      rows.filter((row) => row.web_url && repositoryKey(row.web_url) === key),
    );
  }

  /** A repository picked from the list; another organization's id finds nothing. */
  async findRepositoryById(
    organizationId: string,
    repositoryId: string,
  ): Promise<GitRepositoryMatch> {
    return this.resolve(
      organizationId,
      await this.readRows(organizationId, 'id', repositoryId),
    );
  }

  /** A repository by its owner/name, as saved on a CI run. */
  async findRepositoryByName(
    organizationId: string,
    fullName: string,
  ): Promise<GitRepositoryMatch> {
    const name = fullName.toLowerCase();
    const rows = await this.readRows(
      organizationId,
      'full_name',
      escapeLike(name),
    );

    return this.resolve(
      organizationId,
      rows.filter((row) => row.full_name.toLowerCase() === name),
    );
  }

  private async readRows(
    organizationId: string,
    column: 'id' | 'web_url' | 'full_name',
    value: string,
  ): Promise<MatchedRepository[]> {
    const query = this.supabaseAdmin
      .getClient()
      .from('git_repositories')
      .select(MATCH_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('provider', 'github');
    const { data, error } = await (
      column === 'id' ? query.eq('id', value) : query.ilike(column, value)
    ).order('id', { ascending: true });

    if (error) throw new Error(error.message);

    return (data ?? []) as unknown as MatchedRepository[];
  }

  private async resolve(
    organizationId: string,
    rows: MatchedRepository[],
  ): Promise<GitRepositoryMatch> {
    const repository =
      rows.find((row) => !row.removed_at && row.is_enabled) ??
      rows.find((row) => !row.removed_at) ??
      rows[0];

    if (!repository) return { state: 'none' };

    const unavailable: GitRepositoryMatch = {
      state: 'unavailable',
      repository,
    };

    if (
      !repositoryUsable(repository) ||
      !(await this.licensed(organizationId))
    ) {
      return unavailable;
    }

    const connection = await this.integrations
      .getConnection(organizationId, repository.connection_id)
      .catch((reason: unknown) => {
        if (reason instanceof NotFoundException) return null;

        throw reason;
      });

    if (
      !connection ||
      !connectionUsable(connection) ||
      !connection.installation_id
    ) {
      return unavailable;
    }

    return {
      state: 'connected',
      repository,
      connection,
      installationId: connection.installation_id,
    };
  }

  // Neither of the next two is exported by the integration's module, so they are looked up across the app.
  private appOf(match: ConnectedMatch): Promise<IGitApp> {
    return this.moduleRef
      .get(GitServersService, { strict: false })
      .appFor(
        match.connection.organization_id,
        'github',
        match.connection.host,
      );
  }

  /** Never saved anywhere: the integration caches it and renews it near expiry. */
  async tokenFor(match: ConnectedMatch): Promise<string> {
    const client = this.moduleRef.get(GithubAppClient, { strict: false });

    return client.installationToken(
      await this.appOf(match),
      match.installationId,
    );
  }

  /** What the Actions calls need: the App's API address and a token. */
  async actionsAccess(match: ConnectedMatch): Promise<GithubAccess> {
    const { apiUrl } = await this.appOf(match);

    return {
      apiUrl,
      fullName: match.repository.full_name,
      token: await this.tokenFor(match),
    };
  }

  async branchNames(match: ConnectedMatch): Promise<string[]> {
    const client = this.moduleRef.get(GithubAppClient, { strict: false });
    const branches = await client.listBranches(
      await this.appOf(match),
      match.installationId,
      match.repository.full_name,
      BRANCH_PAGES,
    );

    return branches.map((branch) => branch.name);
  }

  /** The only address a connection's token is ever sent to when starting a workflow. */
  async dispatchUrl(match: ConnectedMatch, workflow: string): Promise<string> {
    const { apiUrl } = await this.appOf(match);

    return `${apiUrl}/repos/${match.repository.full_name}/actions/workflows/${workflow}/dispatches`;
  }

  /**
   * Whether a saved CI address starts a workflow of a connected repository. Null is any other
   * address, which stays on today's path. Compared in full, so a look-alike address never gets a token.
   */
  async ciConnection(
    organizationId: string,
    ciUrl: string,
  ): Promise<CiConnection | null> {
    const address = dispatchAddress(ciUrl);

    if (!address) return null;

    const match = await this.findRepositoryByName(
      organizationId,
      address.fullName,
    );

    if (match.state !== 'connected') return { state: 'unavailable' };

    return (await this.dispatchUrl(match, address.workflow)) === ciUrl
      ? { state: 'connected', match, workflow: address.workflow }
      : { state: 'unavailable' };
  }

  private async gitlabRows(
    organizationId: string,
    column: 'id' | 'external_id',
    value: string,
  ): Promise<GitlabRepository[]> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('git_repositories')
      .select(GITLAB_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('provider', 'gitlab')
      .eq(column, value)
      .order('id', { ascending: true });

    if (error) throw new Error(error.message);

    return (data ?? []) as unknown as GitlabRepository[];
  }

  private gitlabApp(organizationId: string, host: string): Promise<IGitApp> {
    return this.moduleRef
      .get(GitServersService, { strict: false })
      .appFor(organizationId, 'gitlab', host);
  }

  // Only a hint for typing an address, so a server that can't be read just gives none.
  private async gitlabApiUrl(
    organizationId: string,
    host: string,
  ): Promise<string | null> {
    try {
      return (await this.gitlabApp(organizationId, host)).apiUrl;
    } catch {
      return null;
    }
  }

  // Only an active connection: a GitLab one never waits on permissions the way a GitHub App does.
  private async gitlabResolve(
    organizationId: string,
    rows: GitlabRepository[],
  ): Promise<GitlabMatch | 'unavailable' | null> {
    const repository =
      rows.find((row) => !row.removed_at && row.is_enabled) ??
      rows.find((row) => !row.removed_at) ??
      rows[0];

    if (!repository) return null;

    if (
      !repositoryUsable(repository) ||
      !(await this.licensed(organizationId))
    ) {
      return 'unavailable';
    }

    const connection = await this.integrations
      .getConnection(organizationId, repository.connection_id)
      .catch((reason: unknown) => {
        if (reason instanceof NotFoundException) return null;

        throw reason;
      });

    if (
      !connection ||
      connection.provider !== 'gitlab' ||
      connection.status !== 'active'
    ) {
      return 'unavailable';
    }

    return {
      repository,
      connection,
      app: await this.gitlabApp(organizationId, repository.host),
    };
  }

  /** A connected GitLab project picked from the list; null for any other id. */
  async gitlabRepositoryById(
    organizationId: string,
    repositoryId: string,
  ): Promise<GitlabMatch | null> {
    const match = await this.gitlabResolve(
      organizationId,
      await this.gitlabRows(organizationId, 'id', repositoryId),
    );

    return match === 'unavailable' ? null : match;
  }

  /** The GitLab project with this id on the server of this API root; null when this organization has none. */
  async gitlabRepositoryByProject(
    organizationId: string,
    base: string,
    projectId: string,
  ): Promise<GitlabMatch | 'unavailable' | null> {
    const rows = await this.gitlabRows(
      organizationId,
      'external_id',
      projectId,
    );
    const here: GitlabRepository[] = [];

    for (const row of rows) {
      // A server removed since then can't be this address.
      const app = await this.gitlabApp(organizationId, row.host).catch(
        () => null,
      );

      if (app?.apiUrl === base) here.push(row);
    }

    return this.gitlabResolve(organizationId, here);
  }

  /** The only address a GitLab connection's token is ever sent to when starting a pipeline. */
  gitlabPipelineUrl(match: GitlabMatch): string {
    return `${match.app.apiUrl}/projects/${match.repository.external_id}/pipeline`;
  }

  /**
   * Whether a saved CI address creates a pipeline of a connected GitLab project. Null is any other
   * address, which stays on today's path. Compared in full, so a look-alike address never gets a token.
   */
  async gitlabCiConnection(
    organizationId: string,
    ciUrl: string,
  ): Promise<GitlabMatch | 'unavailable' | null> {
    const address = gitlabPipelineAddress(ciUrl);

    if (!address) return null;

    const match = await this.gitlabRepositoryByProject(
      organizationId,
      address.base,
      address.projectId,
    );

    if (!match || match === 'unavailable') return match;

    return this.gitlabPipelineUrl(match) === ciUrl ? match : 'unavailable';
  }

  // Built once, with the same refresh rules the GitLab integration uses for its own token.
  private get gitlabTokens(): GitCredentialTokens {
    if (this.gitlabCredentials) return this.gitlabCredentials;

    const client = this.moduleRef.get(GitlabClient, { strict: false });
    const servers = this.moduleRef.get(GitServersService, { strict: false });
    const publicApiUrl = (
      this.moduleRef
        .get(ConfigService, { strict: false })
        .get<string>('publicApiUrl') ?? ''
    ).replace(/\/$/, '');
    const redirectUri = `${publicApiUrl}/git-integrations/gitlab/callback`;

    this.gitlabCredentials = new GitCredentialTokens({
      label: 'GitLab',
      logger: this.logger,
      supabaseAdmin: this.supabaseAdmin,
      core: this.integrations,
      refresh: async (row, refreshToken) =>
        client.refresh(
          await servers.appFor(row.organization_id, 'gitlab', row.host),
          refreshToken,
          redirectUri,
        ),
      isRefusal: (error) =>
        error instanceof GitlabApiError &&
        (error.status === 400 || error.status === 401),
      expiredError: () =>
        new GitlabApiError(
          401,
          'GitLab authorization expired',
          'invalid_grant',
        ),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    return this.gitlabCredentials;
  }

  /** A working token of the connected GitLab account; never saved by Test Management. */
  async gitlabToken(
    organizationId: string,
    connection: IGitConnectionRow,
  ): Promise<string> {
    const credential = connection.credential_id
      ? await this.gitlabTokens.read(connection.credential_id, organizationId)
      : null;

    if (!credential || credential.provider !== 'gitlab') {
      throw new GitlabConnectionError();
    }

    try {
      return await this.gitlabTokens.getAccessToken(credential);
    } catch (error) {
      if (
        error instanceof GitlabApiError &&
        (error.status === 400 || error.status === 401)
      ) {
        throw new GitlabConnectionError();
      }

      throw error;
    }
  }

  /** At most 100 branches are offered; other names can still be typed. */
  async gitlabBranchNames(match: GitlabMatch): Promise<string[]> {
    const access = gitlabBearerAccess(
      match.app.apiUrl,
      await this.gitlabToken(
        match.connection.organization_id,
        match.connection,
      ),
    );
    const branches = await readToolJson<unknown>(
      access,
      `${match.app.apiUrl}/projects/${match.repository.external_id}/repository/branches?per_page=100`,
    );

    if (!Array.isArray(branches)) return [];

    return branches
      .map((branch: unknown) =>
        branch && typeof branch === 'object'
          ? (branch as { name?: unknown }).name
          : null,
      )
      .filter((name): name is string => typeof name === 'string' && !!name);
  }
}
