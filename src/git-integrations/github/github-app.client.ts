/**
 * @fileoverview Minimal GitHub REST client for a GitHub App: app JWT (RS256 via node:crypto), cached
 * installation tokens, the user OAuth code exchange and the few read-only endpoints the integration
 * needs. XISUITE never writes to GitHub.
 *
 * Stateless per call (ticket 11): every method takes the {@link IGitApp} to talk to, which is either the
 * built-in XISUITE App on github.com or an organization's own App on github.com / a GitHub Enterprise
 * Server. Only the installation-token cache is kept, keyed per app.
 * @module src/git-integrations/github/github-app.client
 */

import { createSign } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { IGitApp } from '../git-integrations.types';

const TIMEOUT_MS = 10_000;
const TOKEN_SAFETY_MS = 5 * 60 * 1000;

export interface IGithubAppConfig {
  appId?: string;
  appSlug?: string;
  privateKey?: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
}

export interface IGithubUser {
  id: number;
  login: string;
  type?: string;
  avatar_url?: string | null;
  html_url?: string | null;
}

export interface IGithubAccount {
  id: number;
  login: string;
  type: string;
  avatar_url: string | null;
  html_url: string | null;
}

/** GitHub permission name → level (`read`, `write`, `admin`). */
export type IGithubPermissions = Record<string, string>;

export interface IGithubInstallation {
  id: number;
  app_id?: number;
  account: IGithubAccount;
  suspended_at: string | null;
  /** What the account granted; behind the App's own permissions until a new request is approved. */
  permissions?: IGithubPermissions;
}

export interface IGithubRepository {
  id: number;
  full_name: string;
  html_url: string;
  default_branch: string | null;
  private: boolean;
  archived: boolean;
}

export interface IGithubPullRequest {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  merged_at: string | null;
  /** The merge, squash or last rebased commit once merged (ticket 6); a test merge while open. */
  merge_commit_sha?: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  head: { ref: string; sha?: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } | null };
  user: {
    id: number;
    login: string;
    avatar_url?: string | null;
    type?: string;
  } | null;
}

/** One review over REST (states are upper case there, lower case in webhooks). */
export interface IGithubReview {
  id: number;
  state: string;
  submitted_at: string | null;
  user: { id: number; login: string } | null;
}

export interface IGithubBranch {
  name: string;
}

/** A GitHub Actions run, as the `workflow_run` webhook and the runs API report it (ticket 7). */
export interface IGithubWorkflowRun {
  id: number;
  name?: string | null;
  workflow_id: number;
  run_attempt?: number;
  status: string | null;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  html_url: string;
  created_at: string;
  updated_at?: string | null;
  run_started_at?: string | null;
  head_repository?: { full_name: string } | null;
}

/** A check run of any CI app, as the `check_run` webhook and the check-runs API report it. */
export interface IGithubCheckRun {
  id: number;
  name: string;
  head_sha: string;
  status: string | null;
  conclusion: string | null;
  html_url?: string | null;
  details_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  app?: { id: number; slug?: string | null; name?: string | null } | null;
  check_suite?: { head_branch?: string | null } | null;
}

/** A commit status (`status` webhook / statuses API): the latest per `context` is the current one. */
export interface IGithubCommitStatus {
  id: number;
  context: string;
  state: string;
  target_url?: string | null;
  created_at: string;
  updated_at?: string | null;
}

/** One commit of the compare API (ticket 6): unlike a push payload, it has author and committer dates. */
export interface IGithubCompareCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name?: string; email?: string; date?: string } | null;
    committer: { name?: string; email?: string; date?: string } | null;
  };
  author: { login: string } | null;
}

/** `owner/repo` as a URL path, each segment encoded. */
function repoPath(fullName: string): string {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubApiError';
  }
}

/** A webhook delivery as GitHub's App delivery log reports it (ticket 11 test + health). */
export interface IGithubHookDelivery {
  id: number;
  guid: string;
  delivered_at: string;
  redelivery: boolean;
  /** e.g. "OK", "Invalid HTTP Response: 401", "Couldn't connect to server". */
  status: string;
  /** 0 when GitHub could not connect at all. */
  status_code: number;
  event: string;
}

/** The App's webhook settings on GitHub (`GET /app/hook/config`). */
export interface IGithubHookConfig {
  url?: string | null;
  content_type?: string | null;
  insecure_ssl?: string | null;
  secret?: string | null;
}

/** `GET /meta`: on a GitHub Enterprise Server `installed_version` is the server's release. */
export interface IGithubMeta {
  installed_version?: string;
  verifiable_password_authentication?: boolean;
}

/** The OAuth client check of "Test connection": a dummy code tells a wrong client from a right one. */
export type GithubClientCheck = 'ok' | 'client_invalid' | 'unknown';

/** The browser-facing address of the OAuth authorize page of `app`. */
export function githubAuthorizeUrl(app: IGitApp): string {
  return `${app.webUrl}/login/oauth/authorize`;
}

/** Where an organization installs `app` (GHES serves Apps under `/github-apps/`). */
export function githubInstallUrl(app: IGitApp): string {
  const path =
    app.serverId && app.host !== 'github.com' ? 'github-apps' : 'apps';

  return `${app.webUrl}/${path}/${encodeURIComponent(app.appSlug ?? '')}/installations/new`;
}

@Injectable()
export class GithubAppClient {
  private readonly tokens = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  /** Short-lived JWT that authenticates as the App itself. */
  appJwt(app: IGitApp): string {
    const { appId, privateKey } = app;

    if (!appId || !privateKey) throw new Error('GitHub App is not configured');

    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
    const signature = createSign('RSA-SHA256')
      .update(body)
      .sign(privateKey, 'base64url');

    return `${body}.${signature}`;
  }

  // ponytail: per-process token cache; fine for a handful of instances (GitHub allows many tokens).
  async installationToken(
    app: IGitApp,
    installationId: string,
  ): Promise<string> {
    // Installation ids are only unique per GitHub instance (and an own App on github.com is another App).
    const key = `${app.serverId ?? 'builtin'}:${installationId}`;
    const cached = this.tokens.get(key);

    if (cached && cached.expiresAt - TOKEN_SAFETY_MS > Date.now())
      return cached.token;

    const { data } = await this.request<{ token: string; expires_at: string }>(
      app,
      `${app.apiUrl}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      this.appJwt(app),
      'POST',
    );

    this.tokens.set(key, {
      token: data.token,
      expiresAt: Date.parse(data.expires_at),
    });

    return data.token;
  }

  /** Exchanges the OAuth code for a user access token. The caller must not store it. */
  async exchangeCode(
    app: IGitApp,
    code: string,
    redirectUri: string,
  ): Promise<string> {
    const data = await this.tokenRequest(app, code, redirectUri);

    if (data.error || !data.access_token) {
      throw new GithubApiError(
        400,
        `GitHub code exchange failed: ${data.error ?? 'no token'}`,
      );
    }

    return data.access_token;
  }

  /**
   * Ticket 11 "Test connection": exchanges a code that cannot exist. GitHub answers
   * `incorrect_client_credentials` for a wrong client id / secret and `bad_verification_code` otherwise.
   */
  async checkOAuthClient(
    app: IGitApp,
    redirectUri: string,
  ): Promise<GithubClientCheck> {
    const data = await this.tokenRequest(
      app,
      'xisuite-connection-test',
      redirectUri,
    );

    if (data.error === 'incorrect_client_credentials') return 'client_invalid';
    if (
      data.error === 'bad_verification_code' ||
      data.error === 'redirect_uri_mismatch'
    )
      return 'ok';

    return 'unknown';
  }

  private async tokenRequest(
    app: IGitApp,
    code: string,
    redirectUri: string,
  ): Promise<{ access_token?: string; error?: string }> {
    const res = await fetch(`${app.webUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'xisuite',
      },
      body: JSON.stringify({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      redirect: redirectMode(app),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok)
      throw new GithubApiError(
        res.status,
        `GitHub code exchange failed (${res.status})`,
      );

    return (await res.json()) as { access_token?: string; error?: string };
  }

  /** Installations of THIS App that the user can access. */
  async listUserInstallations(
    app: IGitApp,
    userToken: string,
  ): Promise<IGithubInstallation[]> {
    return this.paginate<IGithubInstallation>(
      app,
      '/user/installations',
      userToken,
      'installations',
      10,
    );
  }

  /** The user behind a user access token. `type` is 'User' for people ('Bot', 'Organization' otherwise). */
  async getUser(app: IGitApp, userToken: string): Promise<IGithubUser> {
    const { data } = await this.request<IGithubUser>(
      app,
      `${app.apiUrl}/user`,
      userToken,
    );

    return data;
  }

  /**
   * Revokes a user access token that is no longer needed (identity linking keeps no token).
   * Best effort: never throws, because the link itself already succeeded.
   */
  async revokeUserToken(app: IGitApp, userToken: string): Promise<void> {
    const { clientId, clientSecret } = app;

    if (!clientId || !clientSecret) return;

    try {
      await fetch(
        `${app.apiUrl}/applications/${encodeURIComponent(clientId)}/token`,
        {
          method: 'DELETE',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'xisuite',
          },
          body: JSON.stringify({ access_token: userToken }),
          redirect: redirectMode(app),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
    } catch {
      // The token expires on its own (8 h); nothing else to do.
    }
  }

  /** The user's own membership in `org` (needs the App's read-only Organization "Members" permission). */
  async getOrgMembership(
    app: IGitApp,
    userToken: string,
    org: string,
  ): Promise<{ state: string; role: string }> {
    const { data } = await this.request<{ state: string; role: string }>(
      app,
      `${app.apiUrl}/user/memberships/orgs/${encodeURIComponent(org)}`,
      userToken,
    );

    return data;
  }

  async getInstallation(
    app: IGitApp,
    installationId: string,
  ): Promise<IGithubInstallation> {
    const { data } = await this.request<IGithubInstallation>(
      app,
      `${app.apiUrl}/app/installations/${encodeURIComponent(installationId)}`,
      this.appJwt(app),
    );

    return data;
  }

  // ---- Ticket 11: server checks ------------------------------------------------------------

  /** `GET /meta` without a token: proves the address answers as GitHub, and the GHES version. */
  async getMeta(app: IGitApp): Promise<IGithubMeta> {
    const res = await fetch(`${app.apiUrl}/meta`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'xisuite',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok)
      throw new GithubApiError(
        res.status,
        redirectedMessage(res) ?? `GitHub GET /meta failed (${res.status})`,
      );

    return (await res.json()) as IGithubMeta;
  }

  /** The App itself (app JWT): proves the App ID and private key; carries the slug and its permissions. */
  async getApp(app: IGitApp): Promise<{
    id: number;
    slug: string;
    name?: string;
    permissions?: IGithubPermissions;
  }> {
    const { data } = await this.request<{
      id: number;
      slug: string;
      name?: string;
      permissions?: IGithubPermissions;
    }>(app, `${app.apiUrl}/app`, this.appJwt(app));

    return data;
  }

  async getHookConfig(app: IGitApp): Promise<IGithubHookConfig> {
    const { data } = await this.request<IGithubHookConfig>(
      app,
      `${app.apiUrl}/app/hook/config`,
      this.appJwt(app),
    );

    return data;
  }

  /** The App's newest webhook deliveries, newest first. */
  async listHookDeliveries(
    app: IGitApp,
    perPage: number,
  ): Promise<IGithubHookDelivery[]> {
    const { data } = await this.request<IGithubHookDelivery[]>(
      app,
      `${app.apiUrl}/app/hook/deliveries?per_page=${perPage}`,
      this.appJwt(app),
    );

    return Array.isArray(data) ? data : [];
  }

  /** Asks GitHub to send a delivery again (same GUID). GitHub answers 202 and sends it asynchronously. */
  async redeliver(app: IGitApp, deliveryId: number): Promise<void> {
    await this.request<unknown>(
      app,
      `${app.apiUrl}/app/hook/deliveries/${encodeURIComponent(String(deliveryId))}/attempts`,
      this.appJwt(app),
      'POST',
    );
  }

  // ---- Repository reads ------------------------------------------------------------------------

  async listInstallationRepositories(
    app: IGitApp,
    installationId: string,
  ): Promise<IGithubRepository[]> {
    const token = await this.installationToken(app, installationId);

    return this.paginate<IGithubRepository>(
      app,
      '/installation/repositories',
      token,
      'repositories',
      50,
    );
  }

  async getPull(
    app: IGitApp,
    installationId: string,
    fullName: string,
    number: number,
  ): Promise<IGithubPullRequest> {
    const { data } = await this.request<IGithubPullRequest>(
      app,
      `${app.apiUrl}/repos/${repoPath(fullName)}/pulls/${number}`,
      await this.installationToken(app, installationId),
    );

    return data;
  }

  /**
   * Pull requests in `state`, most recently updated first, stopping at the first one updated before
   * `updatedSince` (when given) or after `maxPages` pages of 100.
   */
  async listPulls(
    app: IGitApp,
    installationId: string,
    fullName: string,
    state: 'open' | 'closed',
    maxPages: number,
    updatedSince?: Date,
  ): Promise<IGithubPullRequest[]> {
    const token = await this.installationToken(app, installationId);
    const items: IGithubPullRequest[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const { data } = await this.request<IGithubPullRequest[]>(
        app,
        `${app.apiUrl}/repos/${repoPath(fullName)}/pulls?state=${state}&sort=updated&direction=desc&per_page=100&page=${page}`,
        token,
      );

      for (const pr of data) {
        if (updatedSince && Date.parse(pr.updated_at) < updatedSince.getTime())
          return items;

        items.push(pr);
      }

      if (data.length < 100) break;
    }

    return items;
  }

  /** Every review of a pull request, oldest first (GitHub's order), at most `maxPages` pages of 100. */
  async listReviews(
    app: IGitApp,
    installationId: string,
    fullName: string,
    number: number,
    maxPages: number,
  ): Promise<IGithubReview[]> {
    return this.listArray<IGithubReview>(
      app,
      installationId,
      `/repos/${repoPath(fullName)}/pulls/${number}/reviews`,
      maxPages,
    );
  }

  /** Branch names, at most `maxPages` pages of 100 (GitHub's list carries no commit dates). */
  async listBranches(
    app: IGitApp,
    installationId: string,
    fullName: string,
    maxPages: number,
  ): Promise<IGithubBranch[]> {
    return this.listArray<IGithubBranch>(
      app,
      installationId,
      `/repos/${repoPath(fullName)}/branches`,
      maxPages,
    );
  }

  /**
   * The commits on `head` that are not on `base` (ticket 6), oldest first, at most `maxPages` pages of
   * 100. `base` may be a sha or a branch name.
   */
  async compareCommits(
    app: IGitApp,
    installationId: string,
    fullName: string,
    base: string,
    head: string,
    maxPages: number,
  ): Promise<IGithubCompareCommit[]> {
    const ref = (value: string) =>
      value.split('/').map(encodeURIComponent).join('/');

    return this.paginate<IGithubCompareCommit>(
      app,
      `/repos/${repoPath(fullName)}/compare/${ref(base)}...${ref(head)}`,
      await this.installationToken(app, installationId),
      'commits',
      maxPages,
    );
  }

  /** The newest Actions runs of one commit (ticket 7), at most 30. */
  async listRunsForSha(
    app: IGitApp,
    installationId: string,
    fullName: string,
    sha: string,
  ): Promise<IGithubWorkflowRun[]> {
    const { data } = await this.request<{
      workflow_runs?: IGithubWorkflowRun[];
    }>(
      app,
      `${app.apiUrl}/repos/${repoPath(fullName)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=30`,
      await this.installationToken(app, installationId),
    );

    return data.workflow_runs ?? [];
  }

  /** The newest check runs of one commit, at most 100 (every CI app, GitHub Actions jobs included). */
  async listCheckRunsForRef(
    app: IGitApp,
    installationId: string,
    fullName: string,
    sha: string,
  ): Promise<IGithubCheckRun[]> {
    const { data } = await this.request<{ check_runs?: IGithubCheckRun[] }>(
      app,
      `${app.apiUrl}/repos/${repoPath(fullName)}/commits/${encodeURIComponent(sha)}/check-runs?filter=latest&per_page=100`,
      await this.installationToken(app, installationId),
    );

    return data.check_runs ?? [];
  }

  /** The commit statuses of one commit, newest first, at most 100 (several per context). */
  async listStatusesForRef(
    app: IGitApp,
    installationId: string,
    fullName: string,
    sha: string,
  ): Promise<IGithubCommitStatus[]> {
    const { data } = await this.request<IGithubCommitStatus[]>(
      app,
      `${app.apiUrl}/repos/${repoPath(fullName)}/commits/${encodeURIComponent(sha)}/statuses?per_page=100`,
      await this.installationToken(app, installationId),
    );

    return Array.isArray(data) ? data : [];
  }

  /** Pages through an endpoint that returns a bare array. */
  private async listArray<T>(
    app: IGitApp,
    installationId: string,
    path: string,
    maxPages: number,
  ): Promise<T[]> {
    const token = await this.installationToken(app, installationId);
    const items: T[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const { data } = await this.request<T[]>(
        app,
        `${app.apiUrl}${path}?per_page=100&page=${page}`,
        token,
      );

      items.push(...data);

      if (data.length < 100) break;
    }

    return items;
  }

  private async paginate<T>(
    app: IGitApp,
    path: string,
    token: string,
    key: string,
    maxPages: number,
  ): Promise<T[]> {
    const items: T[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const { data } = await this.request<Record<string, T[]>>(
        app,
        `${app.apiUrl}${path}?per_page=100&page=${page}`,
        token,
      );
      const batch = data[key] ?? [];

      items.push(...batch);

      if (batch.length < 100) break;
    }

    return items;
  }

  private async request<T>(
    app: IGitApp,
    url: string,
    token: string,
    method = 'GET',
  ): Promise<{ data: T }> {
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'xisuite',
      },
      redirect: redirectMode(app),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok)
      throw new GithubApiError(
        res.status,
        redirectedMessage(res) ??
          `GitHub ${method} ${new URL(url).pathname} failed (${res.status})`,
      );

    if (res.status === 202 || res.status === 204)
      return { data: undefined as T };

    return { data: (await res.json()) as T };
  }
}

/**
 * The built-in App follows redirects (the API redirects renamed repositories). An admin-typed server
 * never does: a redirect could lead to an address the server check never saw (ticket 11).
 */
function redirectMode(app: IGitApp): RequestRedirect {
  return app.serverId ? 'manual' : 'follow';
}

function redirectedMessage(res: Response): string | null {
  if (res.status < 300 || res.status >= 400) return null;

  return `redirected (${res.status}) to ${res.headers.get('location') ?? 'an unknown address'}`;
}
