/**
 * @fileoverview Workflow-owned GitHub connections. Stores a per-scope Personal
 * Access Token (AES-256-GCM encrypted), validates it against the GitHub API, and
 * lists the connected account's repositories for the workflow git triggers
 * (`git_branch_created` / `git_pr_merged`).
 *
 * Scope is STRICT: a connection is either ORG-level (`space_id = null`, used by
 * org-scoped workflows) or SPACE-level (non-null `space_id`, used by that space's
 * workflows). Every query branches on scope — org rows use `.is('space_id', null)`
 * (a plain `.eq('space_id', null)` matches NOTHING in PostgREST); space rows use
 * `.eq('space_id', spaceId)`.
 *
 * Deliberately SELF-CONTAINED: this module never reads or writes
 * `automation_connections` or any automations code — the workflow feature owns
 * its own `workflow_github_connections` table. All queries are scoped by
 * `organization_id` on every call (the admin client bypasses RLS).
 * @module src/workflow-github/workflow-github.service
 * @author Ala Bera
 */

import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { decryptApiKey, encryptApiKey } from '../lib/crypto/encryption';

const TABLE = 'workflow_github_connections';
const WEBHOOKS_TABLE = 'workflow_github_webhooks';
const TRIGGER_EVENTS_TABLE = 'workflow_github_trigger_events';
const PROVIDER = 'github';
const GITHUB_API = 'https://api.github.com';
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

/** A single repository reachable via the connected token. */
export interface IWorkflowGithubRepo {
  fullName: string;
  name: string;
  owner: string;
  isPrivate: boolean;
}

/** Secret-free connection summary returned to the client. */
export interface IWorkflowGithubConnectionSummary {
  connected: boolean;
  id?: string;
  external_account_id?: string | null;
  display_name?: string | null;
  /** Which scope the active connection belongs to (strict per-scope isolation). */
  scope?: 'space' | 'org';
}

/** A single git-trigger event mapped to camelCase for the client feed. */
export interface IWorkflowGithubTriggerEvent {
  id: string;
  outcome: string;
  repoFullName: string;
  branch: string | null;
  taskKey: string | null;
  // Human-readable task name (tasks.summary) resolved from taskKey within the
  // org. Null when there is no key (no_task) or the task no longer exists.
  taskName: string | null;
  eventName: string;
  message: string | null;
  createdAt: string;
}

/** Persisted row shape (only the columns this service reads). */
interface IWorkflowGithubRow {
  id: string;
  organization_id: string;
  space_id: string | null;
  provider: string;
  display_name: string | null;
  external_account_id: string | null;
  encrypted_secret: string;
  encryption_iv: string;
  encryption_tag: string;
  is_revoked: boolean;
}

@Injectable()
export class WorkflowGithubService {
  private readonly logger = new Logger(WorkflowGithubService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly configService: ConfigService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** Decrypt a connection row's stored PAT (throws on tamper/failure). */
  private decryptToken(conn: IWorkflowGithubRow): string {
    return decryptApiKey(
      conn.encrypted_secret,
      conn.encryption_iv,
      conn.encryption_tag,
    );
  }

  /** Public callback URL GitHub POSTs deliveries to (publicApiUrl already ends in /api/v1). */
  private get webhookCallbackUrl(): string {
    const base = (
      this.configService.get<string>('publicApiUrl') ||
      'http://localhost:3001/api/v1'
    ).replace(/\/$/, '');

    return `${base}/git-triggers/github/events`;
  }

  /**
   * Validates a PAT against `GET /user` and returns the authenticated login.
   * @throws {BadRequestException} On a 401 (invalid/expired token) or any other
   *   non-OK GitHub response.
   */
  private async fetchGithubLogin(token: string): Promise<string> {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (res.status === 401) {
      throw new BadRequestException('Invalid GitHub token');
    }
    if (!res.ok) {
      throw new BadRequestException(
        `GitHub rejected the token (${res.status})`,
      );
    }

    const user = (await res.json()) as { login?: string };

    if (!user.login) {
      throw new BadRequestException('Invalid GitHub token');
    }

    return user.login;
  }

  /**
   * Resolves the single ACTIVE connection row for the given scope (or null),
   * scoped by org. Org scope when `spaceId` is falsy, space scope otherwise.
   */
  private async findActive(
    organizationId: string,
    spaceId: string | null | undefined,
  ): Promise<IWorkflowGithubRow | null> {
    const base = this.db
      .from(TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('provider', PROVIDER)
      .eq('is_revoked', false);

    // Org-level rows use `.is('space_id', null)`; space rows use `.eq(...)`.
    // A plain `.eq('space_id', null)` matches nothing in PostgREST.
    const scopedQuery = spaceId
      ? base.eq('space_id', spaceId)
      : base.is('space_id', null);

    const result = await scopedQuery
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (result.error) {
      this.logger.error(`findActive failed: ${result.error.message}`);
      throw new InternalServerErrorException(
        'Failed to load GitHub connection',
      );
    }

    return (result.data as IWorkflowGithubRow | null) ?? null;
  }

  /**
   * Returns the active connection for the scope WITHOUT the secret.
   */
  async getConnection(
    organizationId: string,
    spaceId?: string | null,
  ): Promise<IWorkflowGithubConnectionSummary> {
    const conn = await this.findActive(organizationId, spaceId);

    if (!conn) {
      return { connected: false };
    }

    return {
      connected: true,
      id: conn.id,
      external_account_id: conn.external_account_id,
      display_name: conn.display_name,
      scope: conn.space_id ? 'space' : 'org',
    };
  }

  /**
   * Read-only feed of the most recent git-trigger events for the scope, newest
   * first, capped at 50. Org scope when `spaceId` is falsy, space scope otherwise.
   * @throws {InternalServerErrorException} On a query failure.
   */
  async listTriggerEvents(
    organizationId: string,
    spaceId?: string | null,
    workflowId?: string | null,
  ): Promise<IWorkflowGithubTriggerEvent[]> {
    const base = this.db
      .from(TRIGGER_EVENTS_TABLE)
      .select(
        'id, outcome, repo_full_name, branch, task_key, event_name, message, created_at',
      )
      .eq('organization_id', organizationId);

    // Prefer workflow scope when given (the editor passes the PUBLISHED workflow
    // id so a draft still shows its parent's history); else fall back to the
    // space/org scope. Org-level rows use `.is('space_id', null)` — a plain
    // `.eq('space_id', null)` matches nothing in PostgREST.
    const scopedQuery = workflowId
      ? base.eq('workflow_id', workflowId)
      : spaceId
        ? base.eq('space_id', spaceId)
        : base.is('space_id', null);

    const result = await scopedQuery
      .order('created_at', { ascending: false })
      .limit(50);

    if (result.error) {
      this.logger.error(`listTriggerEvents failed: ${result.error.message}`);
      throw new InternalServerErrorException(
        'Failed to load git-trigger events',
      );
    }

    const rows = (result.data ?? []) as Array<{
      id: string;
      outcome: string;
      repo_full_name: string;
      branch: string | null;
      task_key: string | null;
      event_name: string;
      message: string | null;
      created_at: string;
    }>;

    // Resolve human-readable task names from the keys, org-scoped. `tasks.key` is
    // UNIQUE per organization (idx_tasks_key_unique on (organization_id, key)), so
    // a single batched lookup maps each key to at most one task summary. Best-effort:
    // a failure leaves names null rather than dropping the whole feed.
    const taskKeys = Array.from(
      new Set(rows.map((r) => r.task_key).filter((k): k is string => !!k)),
    );

    const nameByKey = new Map<string, string | null>();

    if (taskKeys.length) {
      const tasks = await this.db
        .from('tasks')
        .select('key, summary')
        .eq('organization_id', organizationId)
        .in('key', taskKeys);

      if (tasks.error) {
        this.logger.warn(
          `listTriggerEvents task-name lookup failed: ${tasks.error.message}`,
        );
      } else {
        for (const t of (tasks.data ?? []) as Array<{
          key: string;
          summary: string | null;
        }>) {
          nameByKey.set(t.key, t.summary ?? null);
        }
      }
    }

    return rows.map((r) => ({
      id: r.id,
      outcome: r.outcome,
      repoFullName: r.repo_full_name,
      branch: r.branch,
      taskKey: r.task_key,
      taskName: r.task_key ? (nameByKey.get(r.task_key) ?? null) : null,
      eventName: r.event_name,
      message: r.message,
      createdAt: r.created_at,
    }));
  }

  /**
   * Validates the PAT, revokes any existing active connection at the SAME scope,
   * and stores the encrypted token. Never returns the token.
   */
  async connect(input: {
    organizationId: string;
    spaceId?: string | null;
    token: string;
    displayName?: string;
    createdBy: string | null;
  }): Promise<{ id: string; external_account_id: string; is_revoked: false }> {
    if (!input.organizationId) {
      throw new BadRequestException(
        'Organization context required to connect GitHub',
      );
    }

    const login = await this.fetchGithubLogin(input.token);

    // Revoke/replace any existing active connection at the SAME scope so the
    // partial unique indexes (one active per space, one active per org) hold.
    const revokeBase = this.db
      .from(TABLE)
      .update({ is_revoked: true, updated_at: new Date().toISOString() })
      .eq('organization_id', input.organizationId)
      .eq('provider', PROVIDER)
      .eq('is_revoked', false);

    const revokeQuery = input.spaceId
      ? revokeBase.eq('space_id', input.spaceId)
      : revokeBase.is('space_id', null);

    const { error: revokeError } = await revokeQuery;

    if (revokeError) {
      this.logger.error(
        `connect revoke-existing failed: ${revokeError.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to replace the existing GitHub connection',
      );
    }

    const enc = encryptApiKey(input.token);

    const insertResult = await this.db
      .from(TABLE)
      .insert({
        organization_id: input.organizationId,
        space_id: input.spaceId ?? null,
        provider: PROVIDER,
        display_name: input.displayName ?? login,
        external_account_id: login,
        encrypted_secret: enc.encrypted,
        encryption_iv: enc.iv,
        encryption_tag: enc.tag,
        is_revoked: false,
        created_by: input.createdBy,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('id, external_account_id')
      .single();

    if (insertResult.error || !insertResult.data) {
      this.logger.error(
        `connect insert failed: ${insertResult.error?.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to save GitHub connection',
      );
    }

    const row = insertResult.data as {
      id: string;
      external_account_id: string;
    };

    return {
      id: row.id,
      external_account_id: row.external_account_id,
      is_revoked: false,
    };
  }

  /**
   * Marks the scope's active connection revoked. No-op when none exists.
   */
  async disconnect(
    organizationId: string,
    spaceId?: string | null,
  ): Promise<void> {
    // Best-effort: delete the GitHub-side hooks we registered for this connection
    // BEFORE revoking, so no orphaned webhooks linger on the user's repos.
    const conn = await this.findActive(organizationId, spaceId);

    if (conn) {
      await this.removeWebhooksForConnection(conn).catch((err: unknown) => {
        this.logger.warn(
          `webhook cleanup on disconnect failed (connection ${conn.id}): ${(err as Error).message}`,
        );
      });
    }

    const base = this.db
      .from(TABLE)
      .update({ is_revoked: true, updated_at: new Date().toISOString() })
      .eq('organization_id', organizationId)
      .eq('provider', PROVIDER)
      .eq('is_revoked', false);

    const disconnectQuery = spaceId
      ? base.eq('space_id', spaceId)
      : base.is('space_id', null);

    const { error } = await disconnectQuery;

    if (error) {
      this.logger.error(`disconnect failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to disconnect GitHub');
    }
  }

  /**
   * Decrypts the scope's active token and lists the account's repositories.
   * @throws {NotFoundException} When the scope has no active connection.
   * @throws {UnauthorizedException} When GitHub rejects the token (401 —
   *   revoked/expired); the client should prompt a reconnect.
   */
  async listRepos(
    organizationId: string,
    spaceId?: string | null,
  ): Promise<IWorkflowGithubRepo[]> {
    const conn = await this.findActive(organizationId, spaceId);

    if (!conn) {
      throw new NotFoundException('No active GitHub connection for this scope');
    }

    let token: string;

    try {
      token = decryptApiKey(
        conn.encrypted_secret,
        conn.encryption_iv,
        conn.encryption_tag,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Decryption failed for workflow github connection ${conn.id}: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException(
        'Failed to decrypt the GitHub token — reconnect the account',
      );
    }

    // GitHub caps `per_page` at 100, so page through until a short page (the
    // last one) or the safety ceiling of ~1000 repos (MAX_PAGES * 100).
    const MAX_PAGES = 10;
    const repos: Array<{
      full_name: string;
      name: string;
      owner: { login: string };
      private: boolean;
    }> = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );

      if (res.status === 401) {
        throw new UnauthorizedException(
          'GitHub token is no longer valid — reconnect the account',
        );
      }

      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({}))) as {
          message?: string;
        };

        throw new InternalServerErrorException(
          `GitHub API error (${res.status}): ${errJson.message ?? res.statusText}`,
        );
      }

      const pageRepos = (await res.json()) as Array<{
        full_name: string;
        name: string;
        owner: { login: string };
        private: boolean;
      }>;

      repos.push(...pageRepos);

      // A short page means we've reached the last one — stop paging.
      if (pageRepos.length < 100) {
        break;
      }

      // A full page at the ceiling: there may be more repos we won't fetch.
      if (page === MAX_PAGES) {
        this.logger.warn(
          `listRepos hit the ${MAX_PAGES}-page ceiling for connection ${conn.id}; the repository list may be truncated`,
        );
      }
    }

    // Non-blocking last_used_at touch.
    void Promise.resolve(
      this.db
        .from(TABLE)
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', conn.id),
    ).catch(() => {});

    return repos.map((r) => ({
      fullName: r.full_name,
      name: r.name,
      owner: r.owner.login,
      isPrivate: r.private,
    }));
  }

  /**
   * Idempotently ensure a GitHub webhook is registered for `repoFullName` on the
   * scope's active connection so `create` / `pull_request` events are delivered to
   * this app (POST /git-triggers/github/events). One hook per (connection, repo) —
   * it fans out to every workflow transition watching that repo. Space-scoped only.
   *
   * @throws NotFoundException when the scope has no active GitHub connection.
   * @throws BadRequestException for a malformed repo or an org-scoped connection.
   * @throws UnauthorizedException/ForbiddenException when the PAT is invalid or
   *   lacks admin (repo-hook) permission on the repo.
   */
  async ensureRepoWebhook(input: {
    organizationId: string;
    spaceId?: string | null;
    repoFullName: string;
    createdBy: string | null;
  }): Promise<{ registered: boolean; hookId: number }> {
    const repoFullName = input.repoFullName?.trim();
    const [owner, repo] = (repoFullName ?? '').split('/');

    if (!owner || !repo) {
      throw new BadRequestException('repo_full_name must be "owner/repo"');
    }

    const conn = await this.findActive(input.organizationId, input.spaceId);

    if (!conn) {
      throw new NotFoundException('No active GitHub connection for this scope');
    }

    if (!conn.space_id) {
      throw new BadRequestException(
        'Automatic webhook registration is only available for space-scoped workflows',
      );
    }

    // Idempotent: already registered for this (connection, repo).
    const existing = await this.db
      .from(WEBHOOKS_TABLE)
      .select('hook_id')
      .eq('connection_id', conn.id)
      .eq('repo_full_name', repoFullName)
      .maybeSingle();

    if (existing.error) {
      this.logger.error(
        `ensureRepoWebhook lookup failed: ${existing.error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to check the existing webhook',
      );
    }

    if (existing.data) {
      return {
        registered: false,
        hookId: Number((existing.data as { hook_id: number }).hook_id),
      };
    }

    const token = this.decryptTokenSafe(conn);
    const secret = randomBytes(32).toString('hex');
    const repoExternalId = await this.fetchRepoExternalId(token, owner, repo);
    const hookId = await this.createGithubHook(token, owner, repo, secret);

    const enc = encryptApiKey(secret);
    const insert = await this.db
      .from(WEBHOOKS_TABLE)
      .insert({
        organization_id: input.organizationId,
        space_id: conn.space_id,
        connection_id: conn.id,
        repo_full_name: repoFullName,
        repo_external_id: repoExternalId,
        hook_id: hookId,
        secret_encrypted: enc.encrypted,
        secret_iv: enc.iv,
        secret_tag: enc.tag,
        created_by: input.createdBy,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (insert.error) {
      // Roll back the GitHub hook so we never leak an untracked webhook.
      await this.deleteGithubHook(token, owner, repo, hookId).catch(() => {});
      this.logger.error(
        `ensureRepoWebhook insert failed: ${insert.error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to save the registered webhook',
      );
    }

    return { registered: true, hookId };
  }

  /**
   * Delete every GitHub-side hook registered under a connection (best-effort per
   * hook) then remove the tracking rows. Called on disconnect.
   */
  async removeWebhooksForConnection(conn: IWorkflowGithubRow): Promise<void> {
    const rows = await this.db
      .from(WEBHOOKS_TABLE)
      .select('id, repo_full_name, hook_id')
      .eq('connection_id', conn.id);

    if (rows.error) {
      this.logger.warn(
        `removeWebhooksForConnection list failed: ${rows.error.message}`,
      );

      return;
    }

    const list = (rows.data ?? []) as Array<{
      id: string;
      repo_full_name: string;
      hook_id: number;
    }>;

    if (list.length === 0) return;

    let token: string | null = null;

    try {
      token = this.decryptToken(conn);
    } catch {
      token = null; // can't reach GitHub; still drop our rows below.
    }

    for (const row of list) {
      const [owner, repo] = row.repo_full_name.split('/');

      if (token && owner && repo) {
        await this.deleteGithubHook(token, owner, repo, row.hook_id).catch(
          (err: unknown) => {
            this.logger.warn(
              `failed to delete GitHub hook ${row.hook_id} on ${row.repo_full_name}: ${(err as Error).message}`,
            );
          },
        );
      }
    }

    await this.db.from(WEBHOOKS_TABLE).delete().eq('connection_id', conn.id);
  }

  /** Decrypt with a friendly error surfaced to the client. */
  private decryptTokenSafe(conn: IWorkflowGithubRow): string {
    try {
      return this.decryptToken(conn);
    } catch (err: unknown) {
      this.logger.error(
        `Decryption failed for workflow github connection ${conn.id}: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException(
        'Failed to decrypt the GitHub token — reconnect the account',
      );
    }
  }

  /** GET the repo's numeric id (for rename resilience); null on any failure. */
  private async fetchRepoExternalId(
    token: string,
    owner: string,
    repo: string,
  ): Promise<string | null> {
    try {
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
        headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
      });

      if (!res.ok) return null;

      const body = (await res.json()) as { id?: number };

      return body.id != null ? String(body.id) : null;
    } catch {
      return null;
    }
  }

  /**
   * Create a repo webhook for `create` + `pull_request`, returning its hook id.
   * On 422 (a hook with our URL already exists) it deletes the stale hook and
   * recreates it with our secret so the stored secret always matches the live hook.
   */
  private async createGithubHook(
    token: string,
    owner: string,
    repo: string,
    secret: string,
    isRetry = false,
  ): Promise<number> {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/hooks`, {
      method: 'POST',
      headers: {
        ...GITHUB_HEADERS,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['create', 'pull_request'],
        config: {
          url: this.webhookCallbackUrl,
          content_type: 'json',
          secret,
          insecure_ssl: '0',
        },
      }),
    });

    if (res.status === 201) {
      const body = (await res.json()) as { id: number };

      return body.id;
    }

    if (res.status === 401) {
      throw new UnauthorizedException(
        'GitHub token is no longer valid — reconnect the account',
      );
    }

    if (res.status === 403 || res.status === 404) {
      throw new ForbiddenException(
        `The connected token cannot manage webhooks on ${owner}/${repo}. Use a token with the "repo" scope on a repository you administer.`,
      );
    }

    // 422: a hook with our callback URL already exists — delete + recreate once.
    if (res.status === 422 && !isRetry) {
      const stale = await this.findExistingHookId(token, owner, repo);

      if (stale != null) {
        await this.deleteGithubHook(token, owner, repo, stale).catch(() => {});

        return this.createGithubHook(token, owner, repo, secret, true);
      }
    }

    const errJson = (await res.json().catch(() => ({}))) as {
      message?: string;
    };

    throw new InternalServerErrorException(
      `GitHub webhook create failed (${res.status}): ${errJson.message ?? res.statusText}`,
    );
  }

  /** Find an existing hook id whose config.url is our callback URL, or null. */
  private async findExistingHookId(
    token: string,
    owner: string,
    repo: string,
  ): Promise<number | null> {
    try {
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/hooks`, {
        headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
      });

      if (!res.ok) return null;

      const hooks = (await res.json()) as Array<{
        id: number;
        config?: { url?: string };
      }>;
      const mine = hooks.find((h) => h.config?.url === this.webhookCallbackUrl);

      return mine?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Best-effort delete of a repo hook. Swallows 404 (already gone). */
  private async deleteGithubHook(
    token: string,
    owner: string,
    repo: string,
    hookId: number,
  ): Promise<void> {
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/hooks/${hookId}`,
      {
        method: 'DELETE',
        headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
      },
    );

    if (!res.ok && res.status !== 404) {
      throw new Error(`GitHub hook delete failed (${res.status})`);
    }
  }
}
