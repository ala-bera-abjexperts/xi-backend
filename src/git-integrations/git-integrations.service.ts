/**
 * @fileoverview Provider-neutral core of the org-level Git integrations: connections, repositories,
 * settings, status changes, audit and admin notifications. The GitHub and GitLab services call into
 * this; nothing here talks to a provider.
 *
 * The admin client bypasses RLS, so EVERY tenant query filters on `organization_id`. The only
 * cross-organization read is {@link findLiveByInstallation}, used to fan a GitHub delivery out to
 * every organization that connected that installation.
 * @module src/git-integrations/git-integrations.service
 */

import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type {
  GitAttentionReason,
  GitConnectionStatus,
  GitProvider,
  GitRepositorySelection,
  IGitConnectionDto,
  IGitConnectionRow,
  IGitLegacyConnectionDto,
  IGitProviderDetailDto,
  IGitProviderOverviewDto,
  IGitRepositoriesDto,
  IGitRepositoryRow,
  IGitSettingsDto,
  IGitBranchSettingsDto,
  IProviderAccount,
  IProviderRepository,
  ISpaceGitRepositoriesDto,
  IUserRefDto,
} from './git-integrations.types';

const CONNECTIONS = 'git_connections';
const REPOSITORIES = 'git_repositories';
const SETTINGS = 'git_integration_settings';
const DELIVERIES = 'git_webhook_deliveries';
const LEGACY_CONNECTIONS = 'workflow_github_connections';

/** Notification type for a connection that stopped working. In-app only (not an emailable type). */
export const GIT_ATTENTION_NOTIFICATION = 'git_integration_attention';

const DEFAULT_SETTINGS: IGitSettingsDto = {
  // Opt-in (ticket 6); matches the column default since 20261021120000_git_commits.sql.
  linkCommits: false,
  showBuildStatus: true,
};

const BRANCH_SETTINGS = 'git_branch_settings';
const DEFAULT_BRANCH_SETTINGS: IGitBranchSettingsDto = {
  prefix: '',
  keyCase: 'upper',
};

const UNIQUE_VIOLATION = '23505';

/** A delivery recorded this long ago without an outcome is taken to have crashed mid-processing. */
const STALE_DELIVERY_MS = 5 * 60 * 1000;

/** PostgREST returns at most max_rows (1000 by default) per response. */
const PAGE_SIZE = 1000;
/** Ids sent in one `in (...)` filter, which lives in the request URL. */
const ID_CHUNK = 100;
const INSERT_CHUNK = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];

  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));

  return out;
}

interface IUserNameRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

const PROVIDER_NAMES: Record<GitProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  azure_devops: 'Azure DevOps',
};

@Injectable()
export class GitIntegrationsService {
  private readonly logger = new Logger(GitIntegrationsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly audit: AuditLogsService,
    private readonly broadcast: NotificationsBroadcastService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  // ---------------------------------------------------------------------------
  // Connections
  // ---------------------------------------------------------------------------

  /** Live (not disconnected) connections of one organization, oldest first. */
  async listConnections(
    organizationId: string,
    provider?: GitProvider,
  ): Promise<IGitConnectionRow[]> {
    let query = this.db
      .from(CONNECTIONS)
      .select('*')
      .eq('organization_id', organizationId)
      .neq('status', 'disconnected')
      .order('created_at', { ascending: true });

    if (provider) query = query.eq('provider', provider);

    const { data, error } = await query;

    if (error) throw new InternalServerErrorException(error.message);

    return (data ?? []) as IGitConnectionRow[];
  }

  /** One connection of this organization, in any status. */
  async getConnection(
    organizationId: string,
    connectionId: string,
  ): Promise<IGitConnectionRow> {
    const { data, error } = await this.db
      .from(CONNECTIONS)
      .select('*')
      .eq('id', connectionId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Connection not found');

    return data as IGitConnectionRow;
  }

  /**
   * Every live connection, in ANY organization, served by a GitHub installation. The single
   * deliberate cross-tenant read: one GitHub delivery is processed once per organization holding
   * the installation, and each organization only ever touches its own rows afterwards.
   */
  async findLiveByInstallation(
    host: string,
    installationId: string,
    organizationId?: string,
  ): Promise<IGitConnectionRow[]> {
    // Installation ids are only unique per GitHub instance (ticket 11): always scoped to the host, and to
    // the server's organization for an organization's own App.
    let query = this.db
      .from(CONNECTIONS)
      .select('*')
      .eq('provider', 'github')
      .eq('host', host)
      .eq('installation_id', installationId);

    if (organizationId) query = query.eq('organization_id', organizationId);

    const { data, error } = await query.neq('status', 'disconnected');

    if (error) throw new InternalServerErrorException(error.message);

    return (data ?? []) as IGitConnectionRow[];
  }

  /** Every live connection of a provider across organizations (health checks only). */
  async listAllLive(provider: GitProvider): Promise<IGitConnectionRow[]> {
    const { data, error } = await this.db
      .from(CONNECTIONS)
      .select('*')
      .eq('provider', provider)
      .neq('status', 'disconnected');

    if (error) throw new InternalServerErrorException(error.message);

    return (data ?? []) as IGitConnectionRow[];
  }

  /**
   * Creates the connection, or reactivates this organization's existing row for the same account
   * (after a disconnect, a removed App, an expired authorization), so nothing downstream is ever
   * duplicated. An account that is already active here is a 409.
   */
  async upsertConnection(input: {
    organizationId: string;
    provider: GitProvider;
    host: string;
    account: IProviderAccount;
    credentialId?: string | null;
    userId: string;
  }): Promise<{ connection: IGitConnectionRow; created: boolean }> {
    const { organizationId, provider, host, account, userId } = input;

    const { data: existing, error: findError } = await this.db
      .from(CONNECTIONS)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('provider', provider)
      .eq('host', host)
      .eq('external_account_id', account.externalAccountId)
      .maybeSingle();

    if (findError) throw new InternalServerErrorException(findError.message);

    const accountFields = {
      installation_id: account.installationId ?? null,
      account_login: account.login,
      account_name: account.name,
      account_type: account.type,
      avatar_url: account.avatarUrl,
      account_url: account.url,
      ...(input.credentialId !== undefined && {
        credential_id: input.credentialId,
      }),
    };

    if (existing) {
      const row = existing as IGitConnectionRow;

      if (row.status === 'active') {
        throw new ConflictException({
          code: 'already_connected',
          message: `${account.login} is already connected to this organization`,
        });
      }

      const { data, error } = await this.db
        .from(CONNECTIONS)
        .update({
          ...accountFields,
          status: 'active',
          status_reason: null,
          status_changed_at: new Date().toISOString(),
          disconnected_by: null,
          disconnected_at: null,
        })
        .eq('id', row.id)
        .eq('organization_id', organizationId)
        // Two admins reconnecting at the same moment: only one reactivates, the other gets the 409.
        .neq('status', 'active')
        .select('*')
        .maybeSingle();

      if (error) throw new InternalServerErrorException(error.message);
      if (!data) {
        throw new ConflictException({
          code: 'already_connected',
          message: `${account.login} is already connected to this organization`,
        });
      }

      void this.audit.logAction(
        organizationId,
        userId,
        'git_connection',
        row.id,
        'update',
        {
          event: 'reconnect',
          provider,
          account: account.login,
          previous_status: row.status,
        },
      );

      return { connection: data as IGitConnectionRow, created: false };
    }

    const { data, error } = await this.db
      .from(CONNECTIONS)
      .insert({
        organization_id: organizationId,
        provider,
        host,
        external_account_id: account.externalAccountId,
        ...accountFields,
        created_by: userId,
      })
      .select('*')
      .single();

    if (error) {
      // Two admins connecting the same account at the same moment.
      if (error.code === UNIQUE_VIOLATION) {
        throw new ConflictException({
          code: 'already_connected',
          message: `${account.login} is already connected to this organization`,
        });
      }

      throw new InternalServerErrorException(error.message);
    }

    const connection = data as IGitConnectionRow;

    void this.audit.logAction(
      organizationId,
      userId,
      'git_connection',
      connection.id,
      'create',
      {
        event: 'connect',
        provider,
        account: account.login,
        account_type: account.type,
      },
    );

    return { connection, created: true };
  }

  /** Refreshes the account details shown on the card (name, avatar, installation) without touching status. */
  async updateAccountDetails(
    connection: IGitConnectionRow,
    account: IProviderAccount,
  ): Promise<void> {
    const { error } = await this.db
      .from(CONNECTIONS)
      .update({
        account_login: account.login,
        account_name: account.name,
        account_type: account.type,
        avatar_url: account.avatarUrl,
        account_url: account.url,
        ...(account.installationId !== undefined && {
          installation_id: account.installationId,
        }),
      })
      .eq('id', connection.id)
      .eq('organization_id', connection.organization_id);

    if (error)
      this.logger.warn(
        `updateAccountDetails ${connection.id}: ${error.message}`,
      );
  }

  /** Points a GitLab connection at a fresh authorization (Reconnect). */
  async setCredential(
    connection: IGitConnectionRow,
    credentialId: string,
    userId: string,
  ): Promise<void> {
    const { error } = await this.db
      .from(CONNECTIONS)
      .update({ credential_id: credentialId })
      .eq('id', connection.id)
      .eq('organization_id', connection.organization_id);

    if (error) throw new InternalServerErrorException(error.message);

    void this.audit.logAction(
      connection.organization_id,
      userId,
      'git_connection',
      connection.id,
      'update',
      {
        event: 'reauthorize',
        provider: connection.provider,
        account: connection.account_login,
      },
    );
  }

  /**
   * Moves a connection between `active` and `needs_attention`. Conditional on the current status,
   * so when several instances (or a webhook and the health check) see the same change, exactly one
   * of them wins: only the winner writes the audit row and notifies the admins.
   * @returns whether this call changed the status.
   */
  async setStatus(
    connection: IGitConnectionRow,
    to: Exclude<GitConnectionStatus, 'disconnected'>,
    reason: GitAttentionReason | null,
    actorUserId: string | null = null,
  ): Promise<boolean> {
    const from: GitConnectionStatus =
      to === 'active' ? 'needs_attention' : 'active';

    let query = this.db
      .from(CONNECTIONS)
      .update({
        status: to,
        status_reason: to === 'active' ? null : reason,
        status_changed_at: new Date().toISOString(),
      })
      .eq('id', connection.id)
      .eq('organization_id', connection.organization_id)
      .eq('status', from);

    // Recovering from one reason must not clear a different, still-valid one.
    if (to === 'active' && reason) query = query.eq('status_reason', reason);

    const { data, error } = await query.select('id');

    if (error) {
      this.logger.warn(`setStatus ${connection.id} -> ${to}: ${error.message}`);

      return false;
    }

    if (!data || data.length === 0) return false;

    const changes = {
      event: 'status_change',
      provider: connection.provider,
      account: connection.account_login,
      from,
      to,
      reason,
    };

    if (actorUserId) {
      void this.audit.logAction(
        connection.organization_id,
        actorUserId,
        'git_connection',
        connection.id,
        'update',
        changes,
      );
    } else {
      void this.audit.logSystemAction(
        connection.organization_id,
        'git_connection',
        connection.id,
        'update',
        changes,
      );
    }

    if (to === 'needs_attention') await this.notifyAdmins(connection, reason);

    return true;
  }

  /** Marks the connection disconnected (row kept for history and reactivation). */
  async disconnect(
    organizationId: string,
    connectionId: string,
    userId: string,
  ): Promise<IGitConnectionRow> {
    const connection = await this.getConnection(organizationId, connectionId);

    if (connection.status === 'disconnected') return connection;

    const { error } = await this.db
      .from(CONNECTIONS)
      .update({
        status: 'disconnected',
        status_reason: null,
        status_changed_at: new Date().toISOString(),
        disconnected_by: userId,
        disconnected_at: new Date().toISOString(),
      })
      .eq('id', connectionId)
      .eq('organization_id', organizationId);

    if (error) throw new InternalServerErrorException(error.message);

    void this.audit.logAction(
      organizationId,
      userId,
      'git_connection',
      connectionId,
      'delete',
      {
        event: 'disconnect',
        provider: connection.provider,
        account: connection.account_login,
      },
    );

    return connection;
  }

  private async notifyAdmins(
    connection: IGitConnectionRow,
    reason: GitAttentionReason | null,
  ): Promise<void> {
    const { data: members, error } = await this.db
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', connection.organization_id)
      .in('role', ['owner', 'admin']);

    if (error || !members?.length) return;

    const provider = PROVIDER_NAMES[connection.provider];
    const { data: inserted, error: insertError } = await this.db
      .from('notifications')
      .insert(
        (members as { user_id: string }[]).map((member) => ({
          organization_id: connection.organization_id,
          user_id: member.user_id,
          type: GIT_ATTENTION_NOTIFICATION,
          // English fallback; the frontend renders the translated text from type + metadata.
          title: `${provider} integration needs attention`,
          body: `${connection.account_login}: ${reason ?? 'access lost'}`,
          is_read: false,
          reference_type: 'git_connection',
          reference_id: connection.id,
          metadata: {
            provider: connection.provider,
            account_login: connection.account_login,
            reason,
          },
        })),
      )
      .select();

    if (insertError) {
      this.logger.warn(`notifyAdmins ${connection.id}: ${insertError.message}`);

      return;
    }

    for (const row of inserted ?? []) {
      void this.broadcast.broadcastNotification(row as Record<string, unknown>);
    }
  }

  // ---------------------------------------------------------------------------
  // Repositories
  // ---------------------------------------------------------------------------

  async listRepositories(
    organizationId: string,
    connectionId: string,
  ): Promise<IGitRepositoryRow[]> {
    return this.selectAllPages<IGitRepositoryRow>((from, to) =>
      this.db
        .from(REPOSITORIES)
        .select('*')
        .eq('organization_id', organizationId)
        .eq('connection_id', connectionId)
        .order('full_name', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    );
  }

  /**
   * Reads every row of a query page by page: PostgREST silently caps a single response at its
   * max_rows (1000 by default), and a truncated list here would make repositories look new or gone.
   */
  private async selectAllPages<T>(
    page: (
      from: number,
      to: number,
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  ): Promise<T[]> {
    const rows: T[] = [];

    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await page(from, from + PAGE_SIZE - 1);

      if (error) throw new InternalServerErrorException(error.message);

      const batch = (data ?? []) as T[];

      rows.push(...batch);

      if (batch.length < PAGE_SIZE) return rows;
    }
  }

  /**
   * Stores what the provider reports. Rows are matched on the provider's immutable id per
   * organization, so renames and transfers between this organization's connections keep the row.
   * New rows start enabled when the connection's selection is `all`. With `fullSync`, rows of this
   * connection the provider no longer lists are marked removed (their history stays).
   */
  async upsertRepositories(
    connection: IGitConnectionRow,
    repositories: IProviderRepository[],
    fullSync: boolean,
  ): Promise<void> {
    const { organization_id: organizationId, provider, host } = connection;
    const now = new Date().toISOString();

    const existingRows = await this.selectAllPages<{
      id: string;
      external_id: string;
      connection_id: string;
    }>((from, to) =>
      this.db
        .from(REPOSITORIES)
        .select('id, external_id, connection_id')
        .eq('organization_id', organizationId)
        .eq('provider', provider)
        .eq('host', host)
        .order('id', { ascending: true })
        .range(from, to),
    );

    const byExternalId = new Map(
      existingRows.map((row) => [row.external_id, row]),
    );

    const inserts: Record<string, unknown>[] = [];

    for (const repo of repositories) {
      const details = {
        connection_id: connection.id,
        full_name: repo.fullName,
        web_url: repo.webUrl,
        // Unknown (undefined) never blanks the stored default branch.
        ...(repo.defaultBranch !== undefined && {
          default_branch: repo.defaultBranch,
        }),
        is_private: repo.isPrivate,
        is_archived: repo.isArchived,
        removed_at: null,
      };
      const existing = byExternalId.get(repo.externalId);

      if (existing) {
        const { error: updateError } = await this.db
          .from(REPOSITORIES)
          .update(details)
          .eq('id', existing.id)
          .eq('organization_id', organizationId);

        if (updateError)
          throw new InternalServerErrorException(updateError.message);
      } else {
        inserts.push({
          ...details,
          organization_id: organizationId,
          provider,
          host,
          external_id: repo.externalId,
          is_enabled: connection.repository_selection === 'all',
        });
      }
    }

    for (const batch of chunk(inserts, INSERT_CHUNK)) {
      const { error: insertError } = await this.db
        .from(REPOSITORIES)
        .insert(batch);

      if (insertError)
        throw new InternalServerErrorException(insertError.message);
    }

    if (fullSync) {
      const listed = new Set(repositories.map((repo) => repo.externalId));
      const gone = [...byExternalId.values()]
        .filter(
          (row) =>
            row.connection_id === connection.id && !listed.has(row.external_id),
        )
        .map((row) => row.external_id);

      await this.markRepositoriesRemoved(connection, gone, now);
    }
  }

  /** The provider stopped granting these repositories to this connection (or deleted them). */
  async markRepositoriesRemoved(
    connection: IGitConnectionRow,
    externalIds: string[],
    at = new Date().toISOString(),
  ): Promise<void> {
    // Chunked: every id travels in the request URL.
    for (const ids of chunk(externalIds, ID_CHUNK)) {
      const { error } = await this.db
        .from(REPOSITORIES)
        .update({ removed_at: at })
        .eq('organization_id', connection.organization_id)
        // Only while still attached to this connection: a repository transferred to another
        // connected account of this organization has already been re-pointed there.
        .eq('connection_id', connection.id)
        .in('external_id', ids)
        .is('removed_at', null);

      if (error) throw new InternalServerErrorException(error.message);
    }
  }

  /** Applies a provider event (rename, archive, ...) to this organization's row, if it has one. */
  async patchRepository(
    connection: IGitConnectionRow,
    externalId: string,
    patch: Partial<
      Pick<
        IGitRepositoryRow,
        | 'full_name'
        | 'web_url'
        | 'default_branch'
        | 'is_private'
        | 'is_archived'
        | 'removed_at'
      >
    >,
  ): Promise<void> {
    const { error } = await this.db
      .from(REPOSITORIES)
      .update(patch)
      .eq('organization_id', connection.organization_id)
      .eq('provider', connection.provider)
      .eq('host', connection.host)
      .eq('external_id', externalId);

    if (error) throw new InternalServerErrorException(error.message);
  }

  /** Webhook bookkeeping on one repository row (GitLab project hooks). */
  async updateRepositoryWebhook(
    repository: IGitRepositoryRow,
    patch: Partial<
      Pick<
        IGitRepositoryRow,
        | 'webhook_id'
        | 'webhook_secret_encrypted'
        | 'webhook_secret_iv'
        | 'webhook_secret_tag'
        | 'webhook_error'
      >
    >,
  ): Promise<void> {
    const { error } = await this.db
      .from(REPOSITORIES)
      .update(patch)
      .eq('id', repository.id)
      .eq('organization_id', repository.organization_id);

    if (error) throw new InternalServerErrorException(error.message);
  }

  /** This organization's repository row for a provider repository id, or null when it is not known here. */
  async findRepository(
    connection: IGitConnectionRow,
    externalId: string,
  ): Promise<IGitRepositoryRow | null> {
    const { data, error } = await this.db
      .from(REPOSITORIES)
      .select('*')
      .eq('organization_id', connection.organization_id)
      .eq('provider', connection.provider)
      .eq('host', connection.host)
      .eq('external_id', externalId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);

    return (data as IGitRepositoryRow | null) ?? null;
  }

  /** A repository row by id, for the GitLab webhook route. Cross-tenant by id on purpose: the id IS the routing key. */
  async findRepositoryById(
    repositoryId: string,
  ): Promise<IGitRepositoryRow | null> {
    const { data, error } = await this.db
      .from(REPOSITORIES)
      .select('*')
      .eq('id', repositoryId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);

    return (data as IGitRepositoryRow | null) ?? null;
  }

  /**
   * Saves the admin's choice. With `all`, every repository still granted is enabled; with
   * `selected`, exactly `enabledIds` (which must belong to this connection) are.
   * @returns the rows whose enabled flag changed, for the provider to act on.
   */
  async updateSelection(
    organizationId: string,
    connectionId: string,
    selection: GitRepositorySelection,
    enabledIds: string[],
    userId: string,
  ): Promise<{
    connection: IGitConnectionRow;
    enabled: IGitRepositoryRow[];
    disabled: IGitRepositoryRow[];
  }> {
    const connection = await this.getConnection(organizationId, connectionId);

    if (connection.status === 'disconnected')
      throw new NotFoundException('Connection not found');

    const rows = await this.listRepositories(organizationId, connectionId);
    const wanted = new Set(enabledIds);
    // A repository the provider no longer grants can never be enabled, in either mode.
    const shouldEnable = (row: IGitRepositoryRow) =>
      !row.removed_at && (selection === 'all' || wanted.has(row.id));

    const enabled = rows.filter((row) => !row.is_enabled && shouldEnable(row));
    const disabled = rows.filter((row) => row.is_enabled && !shouldEnable(row));

    for (const [rowIds, value] of [
      [enabled.map((row) => row.id), true],
      [disabled.map((row) => row.id), false],
    ] as const) {
      // Chunked: every id travels in the request URL.
      for (const ids of chunk([...rowIds], ID_CHUNK)) {
        const { error } = await this.db
          .from(REPOSITORIES)
          .update({ is_enabled: value })
          .eq('organization_id', organizationId)
          .eq('connection_id', connectionId)
          .in('id', ids);

        if (error) throw new InternalServerErrorException(error.message);
      }
    }

    // Saved after the rows, so a failure above never leaves the mode changed but the rows not.
    if (connection.repository_selection !== selection) {
      const { error } = await this.db
        .from(CONNECTIONS)
        .update({ repository_selection: selection })
        .eq('id', connectionId)
        .eq('organization_id', organizationId);

      if (error) throw new InternalServerErrorException(error.message);
    }

    if (
      connection.repository_selection !== selection ||
      enabled.length ||
      disabled.length
    ) {
      void this.audit.logAction(
        organizationId,
        userId,
        'git_repository_selection',
        connectionId,
        'update',
        {
          provider: connection.provider,
          account: connection.account_login,
          selection,
          previous_selection: connection.repository_selection,
          enabled: enabled.map((row) => row.full_name),
          disabled: disabled.map((row) => row.full_name),
        },
      );
    }

    return {
      connection: { ...connection, repository_selection: selection },
      enabled: enabled.map((row) => ({ ...row, is_enabled: true })),
      disabled: disabled.map((row) => ({ ...row, is_enabled: false })),
    };
  }

  async getRepositoriesDto(
    organizationId: string,
    connectionId: string,
    stale: boolean,
  ): Promise<IGitRepositoriesDto> {
    const connection = await this.getConnection(organizationId, connectionId);
    const rows = await this.listRepositories(organizationId, connectionId);

    return {
      selection: connection.repository_selection,
      stale,
      repositories: rows.map((row) => ({
        id: row.id,
        externalId: row.external_id,
        fullName: row.full_name,
        webUrl: row.web_url,
        isPrivate: row.is_private,
        isArchived: row.is_archived,
        isEnabled: row.is_enabled,
        removed: !!row.removed_at,
        webhookError: row.webhook_error,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Space repositories (Development module): which tenant repositories a space shows
  // ---------------------------------------------------------------------------

  /** The tenant's available repositories plus the space's assigned ones that no longer are. */
  async getSpaceRepositoriesDto(
    organizationId: string,
    spaceId: string,
  ): Promise<ISpaceGitRepositoriesDto> {
    await this.assertSpace(organizationId, spaceId);

    const [rows, assigned] = await Promise.all([
      this.selectAllPages<
        IGitRepositoryRow & {
          connection: Pick<
            IGitConnectionRow,
            'id' | 'account_login' | 'status'
          > | null;
        }
      >((from, to) =>
        this.db
          .from(REPOSITORIES)
          .select(
            'id, provider, host, full_name, web_url, is_private, is_archived, is_enabled, removed_at, ' +
              'connection:git_connections!git_repositories_connection_fkey(id, account_login, status)',
          )
          .eq('organization_id', organizationId)
          .order('full_name', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
      this.assignedRepositoryIds(organizationId, spaceId),
    ]);

    return {
      repositories: rows.flatMap((row) => {
        const available =
          row.is_enabled &&
          !row.removed_at &&
          !!row.connection &&
          row.connection.status !== 'disconnected';
        const isAssigned = assigned.includes(row.id);

        if (!row.connection || (!available && !isAssigned)) return [];

        return [
          {
            id: row.id,
            provider: row.provider,
            host: row.host,
            fullName: row.full_name,
            webUrl: row.web_url,
            isPrivate: row.is_private,
            isArchived: row.is_archived,
            assigned: isAssigned,
            available,
            connection: {
              id: row.connection.id,
              account: row.connection.account_login,
              status: row.connection.status,
            },
          },
        ];
      }),
    };
  }

  /**
   * Replaces the space's list in one serialized RPC. Only available repositories can be added (narrow
   * only); `expected` is the list the client loaded, so a concurrent save is refused with 409 `stale`.
   */
  async setSpaceRepositories(
    organizationId: string,
    spaceId: string,
    userId: string,
    repositoryIds: string[],
    expected: string[],
  ): Promise<ISpaceGitRepositoriesDto> {
    await this.assertSpace(organizationId, spaceId);

    const { data, error } = (await this.db.rpc('git_set_space_repositories', {
      p_org: organizationId,
      p_space_id: spaceId,
      p_repository_ids: repositoryIds,
      p_user: userId,
      p_expected: expected,
    })) as {
      data: { added: string[]; removed: string[] } | null;
      error: { message: string } | null;
    };

    if (error) {
      if (error.message.includes('stale')) throw new ConflictException('stale');
      if (error.message.includes('repository_not_available'))
        throw new UnprocessableEntityException('repository_not_available');
      throw new InternalServerErrorException(error.message);
    }

    const added = data?.added ?? [];
    const removed = data?.removed ?? [];

    if (added.length || removed.length) {
      const { data: names } = await this.db
        .from(REPOSITORIES)
        .select('id, full_name')
        .eq('organization_id', organizationId)
        .in('id', [...added, ...removed]);
      const nameOf = new Map(
        ((names ?? []) as Array<{ id: string; full_name: string }>).map(
          (row) => [row.id, row.full_name],
        ),
      );

      void this.audit.logAction(
        organizationId,
        userId,
        'space_git_repositories',
        spaceId,
        'update',
        {
          added: added.map((id) => nameOf.get(id) ?? id),
          removed: removed.map((id) => nameOf.get(id) ?? id),
        },
      );
    }

    return this.getSpaceRepositoriesDto(organizationId, spaceId);
  }

  private async assignedRepositoryIds(
    organizationId: string,
    spaceId: string,
  ): Promise<string[]> {
    const { data, error } = await this.db
      .from('git_space_repositories')
      .select('repository_id')
      .eq('organization_id', organizationId)
      .eq('space_id', spaceId);

    if (error) throw new InternalServerErrorException(error.message);

    return ((data ?? []) as Array<{ repository_id: string }>).map(
      (row) => row.repository_id,
    );
  }

  private async assertSpace(
    organizationId: string,
    spaceId: string,
  ): Promise<void> {
    const { data, error } = await this.db
      .from('spaces')
      .select('id')
      .eq('id', spaceId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Space not found');
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  async getSettings(
    organizationId: string,
    provider: GitProvider,
  ): Promise<IGitSettingsDto> {
    const { data, error } = await this.db
      .from(SETTINGS)
      .select('link_commits, show_build_status')
      .eq('organization_id', organizationId)
      .eq('provider', provider)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) return { ...DEFAULT_SETTINGS };

    const row = data as {
      link_commits: boolean;
      show_build_status: boolean;
    };

    return {
      linkCommits: row.link_commits,
      showBuildStatus: row.show_build_status,
    };
  }

  /** The organization's branch naming convention; defaults when never saved. */
  async getBranchSettings(
    organizationId: string,
  ): Promise<IGitBranchSettingsDto> {
    const { data, error } = await this.db
      .from(BRANCH_SETTINGS)
      .select('prefix, key_case')
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) return { ...DEFAULT_BRANCH_SETTINGS };

    const row = data as { prefix: string; key_case: 'upper' | 'lower' };

    return { prefix: row.prefix, keyCase: row.key_case };
  }

  async updateBranchSettings(
    organizationId: string,
    settings: IGitBranchSettingsDto,
    userId: string,
  ): Promise<IGitBranchSettingsDto> {
    const before = await this.getBranchSettings(organizationId);

    const { error } = await this.db.from(BRANCH_SETTINGS).upsert(
      {
        organization_id: organizationId,
        prefix: settings.prefix,
        key_case: settings.keyCase,
        updated_by: userId,
      },
      { onConflict: 'organization_id' },
    );

    if (error) throw new InternalServerErrorException(error.message);

    void this.audit.logAction(
      organizationId,
      userId,
      'git_branch_settings',
      organizationId,
      'update',
      {
        before,
        after: settings,
      },
    );

    return settings;
  }

  /** Providers this organization has at least one live (not disconnected) connection for. */
  async connectedProviders(organizationId: string): Promise<GitProvider[]> {
    const connections = await this.listConnections(organizationId);

    return [...new Set(connections.map((connection) => connection.provider))];
  }

  /**
   * Whether the organization ever connected GitHub or GitLab (any status, disconnected included), so
   * pull requests linked before a disconnect stay visible as "no longer updated" (ticket 5).
   */
  async everConnected(organizationId: string): Promise<boolean> {
    const { count, error } = await this.db
      .from(CONNECTIONS)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId);

    if (error) throw new InternalServerErrorException(error.message);

    return (count ?? 0) > 0;
  }

  async updateSettings(
    organizationId: string,
    provider: GitProvider,
    settings: IGitSettingsDto,
    userId: string,
  ): Promise<IGitSettingsDto> {
    const before = await this.getSettings(organizationId, provider);

    const { error } = await this.db.from(SETTINGS).upsert(
      {
        organization_id: organizationId,
        provider,
        link_commits: settings.linkCommits,
        show_build_status: settings.showBuildStatus,
        updated_by: userId,
      },
      { onConflict: 'organization_id,provider' },
    );

    if (error) throw new InternalServerErrorException(error.message);

    void this.audit.logAction(
      organizationId,
      userId,
      'git_integration_settings',
      organizationId,
      'update',
      {
        provider,
        before,
        after: settings,
      },
    );

    return settings;
  }

  // ---------------------------------------------------------------------------
  // Read models for the page
  // ---------------------------------------------------------------------------

  /**
   * One card per BUILT-IN provider. Connections on the organization's own servers (ticket 11) are left
   * out here; `ownHosts` lists those servers' hosts per provider.
   */
  async getOverview(
    organizationId: string,
    configured: Record<GitProvider, boolean>,
    ownHosts: Record<GitProvider, Set<string>> = {
      github: new Set(),
      gitlab: new Set(),
      azure_devops: new Set(),
    },
  ): Promise<IGitProviderOverviewDto[]> {
    const connections = await this.listConnections(organizationId);

    return (Object.keys(configured) as GitProvider[]).map((provider) => {
      const mine = connections.filter(
        (connection) =>
          connection.provider === provider &&
          !ownHosts[provider].has(connection.host),
      );

      return {
        provider,
        configured: configured[provider],
        status: !mine.length
          ? 'not_connected'
          : mine.some((connection) => connection.status === 'needs_attention')
            ? 'needs_attention'
            : 'connected',
        connectionCount: mine.length,
      };
    });
  }

  /**
   * One provider's page. `hosts` narrows the connections (ticket 11): `only` = one own server's page,
   * `exclude` = the built-in page without the own servers' connections. Settings are per provider and
   * shared by both; legacy PAT connections only exist on the built-in GitHub page.
   */
  async getDetail(
    organizationId: string,
    provider: GitProvider,
    configured: boolean,
    manageUrl: (connection: IGitConnectionRow) => string | null,
    hosts: { only?: string; exclude?: Set<string> } = {},
  ): Promise<IGitProviderDetailDto> {
    const [all, settings] = await Promise.all([
      this.listConnections(organizationId, provider),
      this.getSettings(organizationId, provider),
    ]);
    const connections = all.filter((connection) =>
      hosts.only !== undefined
        ? connection.host === hosts.only
        : !hosts.exclude?.has(connection.host),
    );
    const legacy =
      provider === 'github' && hosts.only === undefined
        ? await this.listLegacyGithubConnections(organizationId)
        : undefined;

    const counts = await this.countEnabledRepositories(
      organizationId,
      connections.map((connection) => connection.id),
    );
    const users = await this.userRefs([
      ...connections.map((connection) => connection.created_by),
      ...(legacy ?? []).map((row) => row.createdById),
    ]);

    const dtos: IGitConnectionDto[] = connections.map((connection) => ({
      id: connection.id,
      provider: connection.provider,
      accountLogin: connection.account_login,
      accountName: connection.account_name,
      accountType: connection.account_type,
      avatarUrl: connection.avatar_url,
      accountUrl: connection.account_url,
      manageUrl: manageUrl(connection),
      status: connection.status,
      statusReason: connection.status_reason,
      repositorySelection: connection.repository_selection,
      repositoryCount: counts.get(connection.id) ?? 0,
      createdBy: connection.created_by
        ? (users.get(connection.created_by) ?? null)
        : null,
      createdAt: connection.created_at,
    }));

    const first = connections[0];

    return {
      provider,
      configured,
      enabledBy: first?.created_by
        ? (users.get(first.created_by) ?? null)
        : null,
      enabledAt: first?.created_at ?? null,
      connections: dtos,
      settings,
      ...(legacy && {
        legacyConnections: legacy.map(({ createdById, ...row }) => ({
          ...row,
          createdBy: createdById ? (users.get(createdById) ?? null) : null,
        })),
      }),
    };
  }

  private async countEnabledRepositories(
    organizationId: string,
    connectionIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();

    if (!connectionIds.length) return counts;

    // A server-side count per connection: fetching the rows would be capped at max_rows.
    await Promise.all(
      connectionIds.map(async (connectionId) => {
        const { count, error } = await this.db
          .from(REPOSITORIES)
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('connection_id', connectionId)
          .eq('is_enabled', true)
          .is('removed_at', null);

        if (error) throw new InternalServerErrorException(error.message);

        counts.set(connectionId, count ?? 0);
      }),
    );

    return counts;
  }

  /**
   * Workflow-editor PAT connections (read only). Listed so the admin knows they exist and keep
   * working; switching them over arrives with automatic status changes (ticket 8).
   */
  private async listLegacyGithubConnections(organizationId: string): Promise<
    (Omit<IGitLegacyConnectionDto, 'createdBy'> & {
      createdById: string | null;
    })[]
  > {
    const { data, error } = await this.db
      .from(LEGACY_CONNECTIONS)
      .select(
        'id, space_id, display_name, external_account_id, created_by, created_at, spaces(name)',
      )
      .eq('organization_id', organizationId)
      .eq('provider', 'github')
      .eq('is_revoked', false)
      .order('created_at', { ascending: true });

    if (error) {
      // Never let the legacy listing break the page.
      this.logger.warn(
        `listLegacyGithubConnections ${organizationId}: ${error.message}`,
      );

      return [];
    }

    return (
      (data ?? []) as unknown as {
        id: string;
        space_id: string | null;
        display_name: string | null;
        external_account_id: string | null;
        created_by: string | null;
        created_at: string;
        spaces: { name: string | null } | null;
      }[]
    ).map((row) => ({
      id: row.id,
      scope: row.space_id ? 'space' : 'org',
      spaceId: row.space_id,
      spaceName: row.spaces?.name ?? null,
      githubLogin: row.external_account_id ?? row.display_name,
      createdById: row.created_by,
      createdAt: row.created_at,
    }));
  }

  private async userRefs(
    ids: (string | null)[],
  ): Promise<Map<string, IUserRefDto>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    const refs = new Map<string, IUserRefDto>();

    if (!unique.length) return refs;

    const { data } = await this.db
      .from('users')
      .select('id, first_name, last_name, email')
      .in('id', unique);

    for (const user of (data ?? []) as IUserNameRow[]) {
      const name =
        `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() ||
        user.email ||
        '';

      refs.set(user.id, { id: user.id, name });
    }

    return refs;
  }

  // ---------------------------------------------------------------------------
  // Access + deliveries
  // ---------------------------------------------------------------------------

  /** Whether the user is (still) an owner or admin. Used by the public callbacks, which have no guard. */
  async isOrgAdmin(organizationId: string, userId: string): Promise<boolean> {
    const { data } = await this.db
      .from('organization_members')
      .select('role')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .maybeSingle();

    const role = (data as { role?: string } | null)?.role;

    return role === 'owner' || role === 'admin';
  }

  /**
   * Records an inbound delivery. False when it was already recorded (a provider redelivery or a
   * replay), in which case the caller must not process it again.
   */
  async recordDelivery(
    provider: GitProvider,
    deliveryId: string,
    event: string,
  ): Promise<boolean> {
    const { error } = await this.db.from(DELIVERIES).insert({
      provider,
      delivery_id: deliveryId.slice(0, 200),
      event: event.slice(0, 100),
    });

    if (!error) return true;
    if (error.code === UNIQUE_VIOLATION)
      return this.reclaimStaleDelivery(provider, deliveryId);

    // Bookkeeping failure must not drop the event; worst case it is processed twice.
    this.logger.warn(
      `recordDelivery ${provider}/${deliveryId}: ${error.message}`,
    );

    return true;
  }

  /**
   * A duplicate whose first attempt never finished (the process died before an outcome was written)
   * is processed again once it is older than {@link STALE_DELIVERY_MS}. The conditional update lets
   * exactly one caller take it over; a delivery still in flight or already finished stays a duplicate.
   */
  private async reclaimStaleDelivery(
    provider: GitProvider,
    deliveryId: string,
  ): Promise<boolean> {
    const { data, error } = await this.db
      .from(DELIVERIES)
      .update({ received_at: new Date().toISOString() })
      .eq('provider', provider)
      .eq('delivery_id', deliveryId.slice(0, 200))
      .is('outcome', null)
      .lt('received_at', new Date(Date.now() - STALE_DELIVERY_MS).toISOString())
      .select('delivery_id');

    if (error) {
      this.logger.warn(
        `reclaimStaleDelivery ${provider}/${deliveryId}: ${error.message}`,
      );

      return false;
    }

    return Array.isArray(data) && data.length > 0;
  }

  async setDeliveryOutcome(
    provider: GitProvider,
    deliveryId: string,
    outcome: string,
  ): Promise<void> {
    await this.db
      .from(DELIVERIES)
      .update({ outcome: outcome.slice(0, 100) })
      .eq('provider', provider)
      .eq('delivery_id', deliveryId.slice(0, 200));
  }

  /**
   * Drops a delivery record whose processing failed, so the provider's redelivery (manual or
   * automatic) is processed instead of being discarded as a duplicate. Handlers are idempotent.
   */
  async forgetDelivery(
    provider: GitProvider,
    deliveryId: string,
  ): Promise<void> {
    const { error } = await this.db
      .from(DELIVERIES)
      .delete()
      .eq('provider', provider)
      .eq('delivery_id', deliveryId.slice(0, 200));

    if (error)
      this.logger.warn(
        `forgetDelivery ${provider}/${deliveryId}: ${error.message}`,
      );
  }

  async pruneDeliveries(olderThanDays = 30): Promise<void> {
    const cutoff = new Date(
      Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { error } = await this.db
      .from(DELIVERIES)
      .delete()
      .lt('received_at', cutoff);

    if (error) this.logger.warn(`pruneDeliveries: ${error.message}`);
  }
}
