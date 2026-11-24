/**
 * @fileoverview Self-hosted Git servers (ticket 11): an organization's OWN GitHub App or GitLab OAuth
 * application on a GitHub Enterprise Server, a self-managed GitLab, or (on-premise, when the XISUITE cloud
 * apps are absent) github.com / gitlab.com.
 *
 * {@link GitServersService.appFor} is the ONE place that decides which app a connection, credential or
 * repository talks to: the server row for (organization, provider, host), else the built-in env app for
 * its own host, else nothing. The built-in app is never used for a foreign host.
 *
 * `host` is the stable key stored on connections / repositories / credentials / identities and never
 * changes; `base_url` is the address and may change (links are rewritten by git_server_rebase_urls).
 *
 * The admin client bypasses RLS, so EVERY tenant query filters on `organization_id`. The only
 * cross-organization read is {@link findById} for the public GitHub webhook of one server.
 * @module src/git-integrations/git-servers.service
 */

import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { decryptApiKey, encryptApiKey } from '../lib/crypto/encryption';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { IGithubAppConfig } from './github/github-app.client';
import { GIT_ATTENTION_NOTIFICATION } from './git-integrations.service';
import {
  AZURE_DEVOPS_HOST,
  AZURE_DEVOPS_WEB_URL,
} from './azure-devops/azure-devops.client';
import type {
  GitProvider,
  GitServerStatus,
  IGitApp,
  IGitServerDto,
  IGitServerRow,
  IGitServerSecrets,
  IGitServerSetupDto,
  IGitServerTestResult,
  IGitServersOverviewDto,
} from './git-integrations.types';
import {
  GitServerAddressError,
  assertServerAddress,
  normalizeServerUrl,
} from './git-server-address.util';

const SERVERS = 'git_servers';
const CONNECTIONS = 'git_connections';
const UNIQUE_VIOLATION = '23505';

/** Decrypted apps are reused this long (per instance). An update clears this instance's copy at once. */
const APP_CACHE_MS = 60 * 1000;
/** `last_webhook_at` is written at most this often per server. */
const WEBHOOK_TOUCH_MS = 60 * 1000;
const PREVIOUS_ADDRESSES = 5;
const MAX_DETAIL = 500;

/** What the GitHub App registration on the server needs (shown in the wizard, step 2). */
export const GITHUB_APP_PERMISSIONS = [
  'Repository: Metadata (read-only)',
  'Repository: Contents (read-only)',
  'Repository: Pull requests (read-only)',
  'Repository: Checks (read-only)',
  'Repository: Actions (read and write)',
  'Repository: Commit statuses (read-only)',
  'Organization: Members (read-only)',
];
export const GITHUB_APP_EVENTS = [
  'Installation target',
  'Repository',
  'Push',
  'Pull request',
  'Pull request review',
  // Builds: GitHub Actions (workflow run), other CI apps (check run) and commit statuses (status).
  'Check run',
  'Workflow run',
  'Status',
  'Create',
  'Delete',
];
/** `api` creates the project webhooks; `read_user` links personal accounts (ticket 2). */
export const GITLAB_APP_SCOPES = ['api', 'read_user'];

export interface ICreateGitServerInput {
  provider: GitProvider;
  baseUrl: string;
  name: string;
}

export interface IUpdateGitServerInput {
  name?: string;
  baseUrl?: string;
  appId?: string | null;
  clientId?: string | null;
  clientSecret?: string;
  privateKey?: string;
}

const PEM =
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----$/;

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function badRequest(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}

/** REST base of a server: api.github.com for github.com itself, `/api/v3` on GHES, `/api/v4` on GitLab. */
export function apiUrlOf(provider: GitProvider, baseUrl: string): string {
  if (provider === 'gitlab') return `${baseUrl}/api/v4`;

  return new URL(baseUrl).host.toLowerCase() === 'github.com'
    ? 'https://api.github.com'
    : `${baseUrl}/api/v3`;
}

/** Everything an organization connect needs. */
export function isAppComplete(app: IGitApp): boolean {
  if (app.provider !== 'github') return !!(app.clientId && app.clientSecret);

  return !!(
    app.appId &&
    app.appSlug &&
    app.privateKey &&
    app.clientId &&
    app.clientSecret &&
    app.webhookSecret
  );
}

@Injectable()
export class GitServersService {
  private readonly logger = new Logger(GitServersService.name);
  private readonly apps = new Map<
    string,
    { app: IGitApp | null; until: number }
  >();

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly audit: AuditLogsService,
    private readonly broadcast: NotificationsBroadcastService,
    private readonly config: ConfigService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  get onPremise(): boolean {
    return this.config.get<boolean>('onPrem.enabled') === true;
  }

  /** The backend's public `/api/v1` address, which the Git server calls back. */
  get publicApiUrl(): string {
    return (
      this.config.get<string>('publicApiUrl') || 'http://localhost:3001/api/v1'
    ).replace(/\/$/, '');
  }

  // ---------------------------------------------------------------------------
  // Built-in (env) apps
  // ---------------------------------------------------------------------------

  private get githubEnv(): IGithubAppConfig {
    return this.config.get<IGithubAppConfig>('git.github') ?? {};
  }

  private get gitlabEnv(): {
    clientId?: string;
    clientSecret?: string;
    baseUrl?: string;
  } {
    return this.config.get('git.gitlab') ?? {};
  }

  private get gitlabBuiltinWebUrl(): string {
    return (this.gitlabEnv.baseUrl || 'https://gitlab.com').replace(/\/$/, '');
  }

  /** The host the built-in app serves: github.com, and gitlab.com or the `GITLAB_BASE_URL` host. */
  builtinHost(provider: GitProvider): string {
    if (provider === 'azure_devops') return AZURE_DEVOPS_HOST;

    return provider === 'github'
      ? 'github.com'
      : new URL(this.gitlabBuiltinWebUrl).host.toLowerCase();
  }

  /**
   * The built-in app as an {@link IGitApp}, with whatever parts the env provides (identity linking only
   * needs the OAuth client, the organization connect needs everything; callers check what they need).
   */
  builtinApp(provider: GitProvider): IGitApp {
    if (provider === 'azure_devops') {
      const env =
        this.config.get<{ clientId?: string; clientSecret?: string }>(
          'git.azureDevops',
        ) ?? {};

      return {
        serverId: null,
        provider,
        host: AZURE_DEVOPS_HOST,
        webUrl: AZURE_DEVOPS_WEB_URL,
        apiUrl: AZURE_DEVOPS_WEB_URL,
        clientId: env.clientId,
        clientSecret: env.clientSecret,
      };
    }

    if (provider === 'github') {
      const env = this.githubEnv;

      return {
        serverId: null,
        provider,
        host: 'github.com',
        webUrl: 'https://github.com',
        apiUrl: 'https://api.github.com',
        appId: env.appId,
        appSlug: env.appSlug,
        privateKey: env.privateKey,
        clientId: env.clientId,
        clientSecret: env.clientSecret,
        webhookSecret: env.webhookSecret,
      };
    }

    const env = this.gitlabEnv;
    const webUrl = this.gitlabBuiltinWebUrl;

    return {
      serverId: null,
      provider,
      host: this.builtinHost('gitlab'),
      webUrl,
      apiUrl: `${webUrl}/api/v4`,
      clientId: env.clientId,
      clientSecret: env.clientSecret,
    };
  }

  /** Whether the built-in app has everything an organization connect needs. */
  isBuiltinConfigured(provider: GitProvider): boolean {
    return isAppComplete(this.builtinApp(provider));
  }

  // ---------------------------------------------------------------------------
  // The resolver
  // ---------------------------------------------------------------------------

  /**
   * The app for a connection / credential / repository of `organizationId` on `host`.
   * @throws {UnprocessableEntityException} 'server_not_configured' when neither an own server nor the
   *   built-in app serves this host.
   * @throws {GitServerAddressError} when an own server's address may not be connected to (SaaS policy).
   */
  async appFor(
    organizationId: string,
    provider: GitProvider,
    host: string,
  ): Promise<IGitApp> {
    const key = `${organizationId}:${provider}:${host}`;
    const cached = this.apps.get(key);
    let app: IGitApp | null;

    if (cached && cached.until > Date.now()) {
      app = cached.app;
    } else {
      const { data, error } = await this.db
        .from(SERVERS)
        .select('*')
        .eq('organization_id', organizationId)
        .eq('provider', provider)
        .eq('host', host)
        .maybeSingle();

      if (error) throw new InternalServerErrorException(error.message);

      app = data
        ? this.toApp(data as IGitServerRow)
        : host === this.builtinHost(provider)
          ? this.builtinApp(provider)
          : null;
      this.apps.set(key, { app, until: Date.now() + APP_CACHE_MS });
    }

    if (!app)
      throw new UnprocessableEntityException({
        code: 'server_not_configured',
        message: `No ${provider} app is configured for ${host}`,
      });

    if (app.serverId) await assertServerAddress(app.webUrl, this.onPremise);

    return app;
  }

  /**
   * The app a new connect / personal link starts with: the organization's server `serverId`, or the
   * built-in app when none is given.
   */
  async appForStart(
    organizationId: string,
    provider: GitProvider,
    serverId: string | null | undefined,
  ): Promise<IGitApp> {
    if (!serverId) return this.builtinApp(provider);

    const server = await this.get(organizationId, serverId);

    if (server.provider !== provider)
      throw badRequest(
        'server_mismatch',
        'This server is for another provider',
      );

    return this.appFor(organizationId, provider, server.host);
  }

  /** The app of one server row (secrets decrypted). */
  toApp(server: IGitServerRow): IGitApp {
    const secrets = this.secretsOf(server);

    return {
      serverId: server.id,
      provider: server.provider,
      host: server.host,
      webUrl: server.base_url,
      apiUrl: apiUrlOf(server.provider, server.base_url),
      appId: server.app_id ?? undefined,
      appSlug: server.app_slug ?? undefined,
      clientId: server.client_id ?? undefined,
      clientSecret: secrets.clientSecret,
      privateKey: secrets.privateKey,
      webhookSecret: secrets.webhookSecret,
    };
  }

  private secretsOf(server: IGitServerRow): IGitServerSecrets {
    if (
      !server.encrypted_secret ||
      !server.encryption_iv ||
      !server.encryption_tag
    )
      return {};

    try {
      return JSON.parse(
        decryptApiKey(
          server.encrypted_secret,
          server.encryption_iv,
          server.encryption_tag,
        ),
      ) as IGitServerSecrets;
    } catch (error) {
      this.logger.error(
        `git server ${server.id}: secrets unreadable (${error instanceof Error ? error.message : error})`,
      );

      return {};
    }
  }

  private forget(
    server: Pick<IGitServerRow, 'organization_id' | 'provider' | 'host'>,
  ): void {
    this.apps.delete(
      `${server.organization_id}:${server.provider}:${server.host}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async list(organizationId: string): Promise<IGitServerRow[]> {
    const { data, error } = await this.db
      .from(SERVERS)
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) throw new InternalServerErrorException(error.message);

    return (data ?? []) as IGitServerRow[];
  }

  /** @throws {NotFoundException} when the server is not this organization's. */
  async get(organizationId: string, id: string): Promise<IGitServerRow> {
    const { data, error } = await this.db
      .from(SERVERS)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Git server not found');

    return data as IGitServerRow;
  }

  /** Cross-organization by id: ONLY for the public webhook of that server (verified by its own secret). */
  async findById(id: string): Promise<IGitServerRow | null> {
    const { data, error } = await this.db
      .from(SERVERS)
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);

    return (data as IGitServerRow | null) ?? null;
  }

  /** Every server of every organization (health cron only). */
  async listAll(): Promise<IGitServerRow[]> {
    const { data, error } = await this.db.from(SERVERS).select('*');

    if (error) throw new InternalServerErrorException(error.message);

    return (data ?? []) as IGitServerRow[];
  }

  /** Hosts of this organization's own servers of `provider` (the built-in cards leave these out). */
  async ownHosts(
    organizationId: string,
    provider: GitProvider,
  ): Promise<Set<string>> {
    return new Set(
      (await this.list(organizationId))
        .filter((server) => server.provider === provider)
        .map((server) => server.host),
    );
  }

  async overview(organizationId: string): Promise<IGitServersOverviewDto> {
    return {
      servers: await this.toDtos(
        organizationId,
        await this.list(organizationId),
      ),
      builtinHosts: {
        github: this.isBuiltinConfigured('github')
          ? this.builtinHost('github')
          : null,
        gitlab: this.isBuiltinConfigured('gitlab')
          ? this.builtinHost('gitlab')
          : null,
        // Azure DevOps Server is not supported, so no own server can use this host.
        azure_devops: null,
      },
      onPremise: this.onPremise,
    };
  }

  async getDto(organizationId: string, id: string): Promise<IGitServerDto> {
    const [dto] = await this.toDtos(organizationId, [
      await this.get(organizationId, id),
    ]);

    return dto;
  }

  private async toDtos(
    organizationId: string,
    servers: IGitServerRow[],
  ): Promise<IGitServerDto[]> {
    if (!servers.length) return [];

    const { data, error } = await this.db
      .from(CONNECTIONS)
      .select('provider, host')
      .eq('organization_id', organizationId)
      .neq('status', 'disconnected');

    if (error) throw new InternalServerErrorException(error.message);

    const live = (data ?? []) as { provider: string; host: string }[];

    return servers.map((server) => {
      const app = this.toApp(server);

      return {
        id: server.id,
        provider: server.provider,
        name: server.name,
        baseUrl: server.base_url,
        host: server.host,
        appId: server.app_id,
        appSlug: server.app_slug,
        clientId: server.client_id,
        hasClientSecret: !!app.clientSecret,
        hasPrivateKey: !!app.privateKey,
        configured: isAppComplete(app),
        status: server.status,
        statusReason: server.status_reason,
        statusDetail: server.status_detail,
        lastWebhookAt: server.last_webhook_at,
        lastTest: server.last_test,
        connectionCount: live.filter(
          (row) => row.provider === server.provider && row.host === server.host,
        ).length,
        createdAt: server.created_at,
      };
    });
  }

  /** What the admin enters in the app registration on the server (wizard step 2). Audited: carries the webhook secret. */
  async setup(
    organizationId: string,
    id: string,
    userId: string,
  ): Promise<IGitServerSetupDto> {
    const server = await this.get(organizationId, id);
    const app = this.toApp(server);
    const homepageUrl = (
      this.config.get<string>('appUrl') || 'http://localhost:3000'
    ).replace(/\/$/, '');
    const callbackUrl = `${this.publicApiUrl}/git-integrations/${server.provider}/callback`;

    void this.audit.logAction(
      organizationId,
      userId,
      'git_server',
      server.id,
      'update',
      {
        event: 'setup_values_viewed',
        provider: server.provider,
        host: server.host,
      },
    );

    if (server.provider === 'github') {
      return {
        provider: 'github',
        registerUrls: [
          `${server.base_url}/settings/apps/new`,
          `${server.base_url}/organizations/<organization>/settings/apps/new`,
        ],
        homepageUrl,
        callbackUrl,
        setupUrl: callbackUrl,
        webhookUrl: this.githubWebhookUrl(server.id),
        webhookSecret: app.webhookSecret ?? null,
        scopes: [],
        permissions: GITHUB_APP_PERMISSIONS,
        events: GITHUB_APP_EVENTS,
        inboundUrl: this.publicApiUrl,
      };
    }

    return {
      provider: 'gitlab',
      registerUrls: [
        `${server.base_url}/admin/applications/new`,
        `${server.base_url}/-/user_settings/applications`,
      ],
      homepageUrl,
      callbackUrl,
      setupUrl: null,
      webhookUrl: null,
      webhookSecret: null,
      scopes: GITLAB_APP_SCOPES,
      permissions: [],
      events: [],
      inboundUrl: `${this.publicApiUrl}/git-integrations/gitlab/webhook/`,
    };
  }

  githubWebhookUrl(serverId: string): string {
    return `${this.publicApiUrl}/git-integrations/github/webhook/${serverId}`;
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * Validates an admin-typed address: format, http only on-premise, and (SaaS) public addresses only.
   * @throws {BadRequestException} with the address error's code
   */
  private async checkAddress(
    raw: string,
  ): Promise<{ baseUrl: string; host: string }> {
    try {
      const normalized = normalizeServerUrl(raw, this.onPremise);

      await assertServerAddress(normalized.baseUrl, this.onPremise);

      return normalized;
    } catch (error) {
      if (error instanceof GitServerAddressError)
        throw badRequest(error.code, error.message);
      throw error;
    }
  }

  async create(
    organizationId: string,
    userId: string,
    input: ICreateGitServerInput,
  ): Promise<IGitServerDto> {
    const name = input.name?.trim();

    if (!name || name.length > 100)
      throw badRequest('invalid_name', 'Enter a name of up to 100 characters');

    const { baseUrl, host } = await this.checkAddress(input.baseUrl);

    // An own app for the host the built-in app serves would collide with the built-in connections' keys.
    if (
      host === this.builtinHost(input.provider) &&
      this.isBuiltinConfigured(input.provider)
    )
      throw badRequest(
        'builtin_available',
        `${host} is already available through the built-in connection`,
      );

    const secrets: IGitServerSecrets =
      input.provider === 'github'
        ? { webhookSecret: randomBytes(32).toString('hex') }
        : {};
    const encrypted = encryptApiKey(JSON.stringify(secrets));

    const { data, error } = await this.db
      .from(SERVERS)
      .insert({
        organization_id: organizationId,
        provider: input.provider,
        host,
        base_url: baseUrl,
        name,
        encrypted_secret: encrypted.encrypted,
        encryption_iv: encrypted.iv,
        encryption_tag: encrypted.tag,
        created_by: userId,
        updated_by: userId,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION)
        throw new ConflictException({
          code: 'server_exists',
          message: `${host} is already registered`,
        });
      throw new InternalServerErrorException(error.message);
    }

    const server = data as IGitServerRow;

    this.forget(server);
    void this.audit.logAction(
      organizationId,
      userId,
      'git_server',
      server.id,
      'create',
      {
        event: 'server_added',
        provider: server.provider,
        host,
        base_url: baseUrl,
      },
    );

    return (await this.toDtos(organizationId, [server]))[0];
  }

  async update(
    organizationId: string,
    id: string,
    userId: string,
    input: IUpdateGitServerInput,
  ): Promise<IGitServerDto> {
    const server = await this.get(organizationId, id);
    const patch: Record<string, unknown> = { updated_by: userId };
    const changed: string[] = [];

    if (input.name !== undefined) {
      const name = input.name.trim();

      if (!name || name.length > 100)
        throw badRequest(
          'invalid_name',
          'Enter a name of up to 100 characters',
        );
      if (name !== server.name) {
        patch.name = name;
        changed.push('name');
      }
    }

    let addressChange: { from: string; to: string } | null = null;

    if (input.baseUrl !== undefined) {
      // The host KEY stays whatever the new address is: every link keeps its row (§3.2).
      const { baseUrl } = await this.checkAddress(input.baseUrl);

      if (baseUrl !== server.base_url) {
        patch.base_url = baseUrl;
        patch.previous_base_urls = [
          server.base_url,
          ...server.previous_base_urls.filter(
            (url) => url !== server.base_url && url !== baseUrl,
          ),
        ].slice(0, PREVIOUS_ADDRESSES);
        addressChange = { from: server.base_url, to: baseUrl };
        changed.push('base_url');
      }
    }

    if (input.appId !== undefined) {
      const value = trimOrNull(input.appId);

      if (value && !/^\d{1,20}$/.test(value))
        throw badRequest('invalid_app_id', 'The App ID is a number');
      if (value !== server.app_id) {
        patch.app_id = value;
        patch.app_slug = null; // read again from GitHub by the next test
        changed.push('app_id');
      }
    }

    if (input.clientId !== undefined) {
      const value = trimOrNull(input.clientId);

      if (value && value.length > 200)
        throw badRequest('invalid_value', 'The client id is too long');
      if (value !== server.client_id) {
        patch.client_id = value;
        changed.push('client_id');
      }
    }

    if (input.clientSecret !== undefined || input.privateKey !== undefined) {
      const secrets = this.secretsOf(server);

      if (input.clientSecret !== undefined) {
        const value = input.clientSecret.trim();

        if (value.length > 500)
          throw badRequest('invalid_value', 'The client secret is too long');
        secrets.clientSecret = value || undefined;
        changed.push('client_secret');
      }

      if (input.privateKey !== undefined) {
        if (server.provider !== 'github')
          throw badRequest(
            'invalid_value',
            'Only a GitHub App has a private key',
          );

        // A pasted key may carry literal "\n" sequences (as the env value does).
        const pem = input.privateKey.replace(/\\n/g, '\n').trim();

        if (pem && (pem.length > 10_000 || !PEM.test(pem)))
          throw badRequest(
            'invalid_private_key',
            'Paste the whole .pem file of the GitHub App',
          );
        secrets.privateKey = pem || undefined;
        changed.push('private_key');
      }

      const encrypted = encryptApiKey(JSON.stringify(secrets));

      patch.encrypted_secret = encrypted.encrypted;
      patch.encryption_iv = encrypted.iv;
      patch.encryption_tag = encrypted.tag;
    }

    if (!changed.length) return this.getDto(organizationId, id);

    // A test of the old address / app values proves nothing about the new ones: "Connect" waits for a new test.
    if (changed.some((field) => field !== 'name')) {
      patch.last_test = null;
      patch.last_test_at = null;
    }

    const { data, error } = await this.db
      .from(SERVERS)
      .update(patch)
      .eq('organization_id', organizationId)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw new InternalServerErrorException(error.message);

    const updated = data as IGitServerRow;
    let rewritten: number | null = null;

    if (addressChange) {
      // Stored links (pull requests, commits, builds ...) follow the new address; keys never change.
      const { data: count, error: rebaseError } = await this.db.rpc(
        'git_server_rebase_urls',
        {
          p_org: organizationId,
          p_provider: server.provider,
          p_host: server.host,
          p_old: `${addressChange.from}/`,
          p_new: `${addressChange.to}/`,
        },
      );

      if (rebaseError) {
        // The address itself is saved; old links still open the old address. Saving again retries.
        this.logger.error(
          `git_server_rebase_urls ${id}: ${rebaseError.message}`,
        );
      } else {
        rewritten = Number(count) || 0;
      }
    }

    this.forget(updated);
    void this.audit.logAction(
      organizationId,
      userId,
      'git_server',
      id,
      'update',
      {
        event: addressChange ? 'server_address_changed' : 'server_updated',
        provider: server.provider,
        host: server.host,
        changed,
        ...(addressChange && {
          from: addressChange.from,
          to: addressChange.to,
          links_rewritten: rewritten,
        }),
      },
    );

    return (await this.toDtos(organizationId, [updated]))[0];
  }

  /** New webhook secret (GitHub). The admin pastes it into the App's webhook settings. */
  async rotateWebhookSecret(
    organizationId: string,
    id: string,
    userId: string,
  ): Promise<{ webhookSecret: string }> {
    const server = await this.get(organizationId, id);

    if (server.provider !== 'github')
      throw badRequest(
        'invalid_value',
        'Only a GitHub App has a webhook secret',
      );

    const webhookSecret = randomBytes(32).toString('hex');
    const encrypted = encryptApiKey(
      JSON.stringify({ ...this.secretsOf(server), webhookSecret }),
    );

    const { error } = await this.db
      .from(SERVERS)
      .update({
        encrypted_secret: encrypted.encrypted,
        encryption_iv: encrypted.iv,
        encryption_tag: encrypted.tag,
        updated_by: userId,
        // The stored test checked the old secret.
        last_test: null,
        last_test_at: null,
      })
      .eq('organization_id', organizationId)
      .eq('id', id);

    if (error) throw new InternalServerErrorException(error.message);

    this.forget(server);
    void this.audit.logAction(
      organizationId,
      userId,
      'git_server',
      id,
      'update',
      {
        event: 'webhook_secret_rotated',
        provider: server.provider,
        host: server.host,
      },
    );

    return { webhookSecret };
  }

  /** @throws {ConflictException} 'server_in_use' while a connection on this server is not disconnected. */
  async remove(
    organizationId: string,
    id: string,
    userId: string,
  ): Promise<void> {
    const server = await this.get(organizationId, id);
    const { count, error: countError } = await this.db
      .from(CONNECTIONS)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('provider', server.provider)
      .eq('host', server.host)
      .neq('status', 'disconnected');

    if (countError) throw new InternalServerErrorException(countError.message);
    if (count)
      throw new ConflictException({
        code: 'server_in_use',
        message: 'Disconnect every organization or group of this server first',
      });

    const { error } = await this.db
      .from(SERVERS)
      .delete()
      .eq('organization_id', organizationId)
      .eq('id', id);

    if (error) throw new InternalServerErrorException(error.message);

    this.forget(server);
    void this.audit.logAction(
      organizationId,
      userId,
      'git_server',
      id,
      'delete',
      {
        event: 'server_removed',
        provider: server.provider,
        host: server.host,
        base_url: server.base_url,
      },
    );
  }

  /** The GitHub slug read from `GET /app` by the test (the admin never types it). */
  async saveSlug(server: IGitServerRow, slug: string): Promise<void> {
    if (slug === server.app_slug) return;

    const { error } = await this.db
      .from(SERVERS)
      .update({ app_slug: slug })
      .eq('organization_id', server.organization_id)
      .eq('id', server.id);

    if (error) throw new InternalServerErrorException(error.message);
    this.forget(server);
  }

  async saveTest(
    server: IGitServerRow,
    result: IGitServerTestResult,
  ): Promise<void> {
    const { error } = await this.db
      .from(SERVERS)
      .update({ last_test: result, last_test_at: result.checkedAt })
      .eq('organization_id', server.organization_id)
      .eq('id', server.id);

    if (error) throw new InternalServerErrorException(error.message);
  }

  auditTest(
    organizationId: string,
    userId: string,
    id: string,
    result: IGitServerTestResult,
  ): void {
    void this.audit.logAction(
      organizationId,
      userId,
      'git_server',
      id,
      'update',
      {
        event: 'server_tested',
        ok: result.ok,
        failed: result.checks
          .filter((check) => check.result === 'error')
          .map((check) => check.code),
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Webhook arrival + status
  // ---------------------------------------------------------------------------

  /** A verified event arrived from this server. Written at most once a minute. Never throws. */
  async touchWebhook(serverId: string): Promise<void> {
    await this.touch({ id: serverId });
  }

  /** Same, for a GitLab project webhook: the server is found by the repository's host. */
  async touchWebhookByHost(
    organizationId: string,
    provider: GitProvider,
    host: string,
  ): Promise<void> {
    await this.touch({ organization_id: organizationId, provider, host });
  }

  private async touch(match: Record<string, string>): Promise<void> {
    try {
      const since = new Date(Date.now() - WEBHOOK_TOUCH_MS).toISOString();
      const { error } = await this.db
        .from(SERVERS)
        .update({ last_webhook_at: new Date().toISOString() })
        .match(match)
        .or(`last_webhook_at.is.null,last_webhook_at.lt.${since}`);

      if (error) this.logger.warn(`touchWebhook: ${error.message}`);
    } catch (error) {
      this.logger.warn(
        `touchWebhook: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** For the test's wait loop: bypasses the once-a-minute throttle by reading the row. */
  async lastWebhookAt(
    organizationId: string,
    id: string,
  ): Promise<string | null> {
    const { data, error } = await this.db
      .from(SERVERS)
      .select('last_webhook_at')
      .eq('organization_id', organizationId)
      .eq('id', id)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);

    return (
      (data as { last_webhook_at: string | null } | null)?.last_webhook_at ??
      null
    );
  }

  /** Lets the next event from this server write `last_webhook_at` at once (the test waits for it). */
  async resetWebhookTouch(server: IGitServerRow): Promise<void> {
    const { error } = await this.db
      .from(SERVERS)
      .update({ last_webhook_at: null })
      .eq('organization_id', server.organization_id)
      .eq('id', server.id);

    if (error) throw new InternalServerErrorException(error.message);
  }

  /**
   * Conditional status change: only the instance whose update actually changed the row notifies the
   * owners / admins (once) and audits. Recovery (`active`) clears the reason and does not notify. A
   * changed reason while already needing attention only updates the text.
   */
  async setStatus(
    server: IGitServerRow,
    status: GitServerStatus,
    reason: string | null,
    detail: string | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    const text = detail ? detail.slice(0, MAX_DETAIL) : null;

    if (status === 'active') {
      const { data, error } = await this.db
        .from(SERVERS)
        .update({
          status: 'active',
          status_reason: null,
          status_detail: null,
          status_changed_at: now,
        })
        .eq('organization_id', server.organization_id)
        .eq('id', server.id)
        .eq('status', 'needs_attention')
        .select('id');

      if (error) throw new InternalServerErrorException(error.message);
      if (data?.length)
        this.auditStatus(server, {
          event: 'server_recovered',
          previous_reason: server.status_reason,
        });

      return;
    }

    const { data, error } = await this.db
      .from(SERVERS)
      .update({
        status: 'needs_attention',
        status_reason: reason,
        status_detail: text,
        status_changed_at: now,
      })
      .eq('organization_id', server.organization_id)
      .eq('id', server.id)
      .eq('status', 'active')
      .select('id');

    if (error) throw new InternalServerErrorException(error.message);

    if (!data?.length) {
      // Already needs attention: keep the newest explanation, no second notification.
      if (server.status_reason !== reason || server.status_detail !== text) {
        const { error: textError } = await this.db
          .from(SERVERS)
          .update({ status_reason: reason, status_detail: text })
          .eq('organization_id', server.organization_id)
          .eq('id', server.id)
          .eq('status', 'needs_attention');

        if (textError)
          this.logger.warn(`setStatus ${server.id}: ${textError.message}`);
      }

      return;
    }

    this.auditStatus(server, {
      event: 'server_needs_attention',
      reason,
      detail: text,
    });
    await this.notifyAdmins(server, reason);
  }

  /** System changes are attributed to the admin who added the server (audit rows need a user). */
  private auditStatus(
    server: IGitServerRow,
    details: Record<string, unknown>,
  ): void {
    if (!server.created_by) return;

    void this.audit.logAction(
      server.organization_id,
      server.created_by,
      'git_server',
      server.id,
      'update',
      {
        ...details,
        provider: server.provider,
        host: server.host,
        system: true,
      },
    );
  }

  private async notifyAdmins(
    server: IGitServerRow,
    reason: string | null,
  ): Promise<void> {
    const { data: members, error } = await this.db
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', server.organization_id)
      .in('role', ['owner', 'admin']);

    if (error || !members?.length) return;

    const provider = server.provider === 'github' ? 'GitHub' : 'GitLab';
    const { data: inserted, error: insertError } = await this.db
      .from('notifications')
      .insert(
        (members as { user_id: string }[]).map((member) => ({
          organization_id: server.organization_id,
          user_id: member.user_id,
          type: GIT_ATTENTION_NOTIFICATION,
          // English fallback; the frontend renders the translated text from type + metadata.
          title: `${provider} integration needs attention`,
          body: `${server.name}: ${reason ?? 'unreachable'}`,
          is_read: false,
          reference_type: 'git_server',
          reference_id: server.id,
          metadata: {
            provider: server.provider,
            account_login: server.name,
            server_id: server.id,
            reason,
          },
        })),
      )
      .select();

    if (insertError) {
      this.logger.warn(
        `notifyAdmins server ${server.id}: ${insertError.message}`,
      );

      return;
    }

    for (const row of inserted ?? [])
      void this.broadcast.broadcastNotification(row as Record<string, unknown>);
  }
}
