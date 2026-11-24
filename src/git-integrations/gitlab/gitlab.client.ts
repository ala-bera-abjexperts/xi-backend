/**
 * @fileoverview Thin HTTP client for GitLab (gitlab.com or any self-managed instance): the OAuth token
 * endpoints and the REST API v4. Holds no state; the app (address + OAuth application, ticket 11) and
 * the tokens are passed in on every call.
 * @module src/git-integrations/gitlab/gitlab.client
 */

import { Injectable, Logger } from '@nestjs/common';

import type { IGitApp } from '../git-integrations.types';

const TIMEOUT_MS = 10_000;

/** GitLab's default access-token lifetime, used when a token response omits `expires_in`. */
const DEFAULT_EXPIRES_IN_S = 7200;

export class GitlabApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** OAuth `error` code from the token endpoint (e.g. `invalid_grant`). */
    readonly oauthError: string | null = null,
  ) {
    super(message);
    this.name = 'GitlabApiError';
  }
}

export interface IGitlabTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const {
      message,
      error,
      error_description: description,
    } = body as Record<string, unknown>;
    const text = description ?? message ?? error;

    if (typeof text === 'string') return text.slice(0, 300);
    if (text) return JSON.stringify(text).slice(0, 300);
  }

  return fallback;
}

/** The OAuth client check of "Test connection" (ticket 11). */
export type GitlabClientCheck = 'ok' | 'client_invalid' | 'unknown';

@Injectable()
export class GitlabClient {
  private readonly logger = new Logger(GitlabClient.name);

  exchangeCode(
    app: IGitApp,
    code: string,
    redirectUri: string,
  ): Promise<IGitlabTokens> {
    return this.token(app, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
  }

  refresh(
    app: IGitApp,
    refreshToken: string,
    redirectUri: string,
  ): Promise<IGitlabTokens> {
    return this.token(app, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      redirect_uri: redirectUri,
    });
  }

  /**
   * Ticket 11 "Test connection": exchanges a code that cannot exist. GitLab answers `invalid_client` for a
   * wrong application id / secret and `invalid_grant` when the application itself is right.
   */
  async checkOAuthClient(
    app: IGitApp,
    redirectUri: string,
  ): Promise<GitlabClientCheck> {
    try {
      await this.exchangeCode(app, 'xisuite-connection-test', redirectUri);

      return 'unknown';
    } catch (error) {
      if (!(error instanceof GitlabApiError)) throw error;
      if (error.oauthError === 'invalid_client') return 'client_invalid';
      if (error.oauthError === 'invalid_grant') return 'ok';

      return 'unknown';
    }
  }

  /** Best effort: a failure is logged, never thrown. */
  async revoke(app: IGitApp, token: string): Promise<void> {
    try {
      await fetch(`${app.webUrl}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: app.clientId ?? '',
          client_secret: app.clientSecret ?? '',
          token,
        }),
        redirect: redirectMode(app),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn(
        `revoke failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * `GET /version` without a token (ticket 11): a 401 still proves the address answers as GitLab. With a
   * token the version comes back. Never follows redirects.
   */
  async probeVersion(
    app: IGitApp,
    token?: string,
  ): Promise<{ status: number; version: string | null; isGitlab: boolean }> {
    const response = await fetch(`${app.apiUrl}/version`, {
      headers: {
        accept: 'application/json',
        ...(token && { authorization: `Bearer ${token}` }),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as {
      version?: unknown;
      message?: unknown;
    } | null;
    const version = typeof body?.version === 'string' ? body.version : null;

    if (response.status >= 300 && response.status < 400)
      throw new GitlabApiError(
        response.status,
        `redirected (${response.status}) to ${response.headers.get('location') ?? 'an unknown address'}`,
      );

    // GitLab's API 401 body is {"message":"401 Unauthorized"}.
    const isGitlab =
      !!version ||
      (response.status === 401 &&
        typeof body?.message === 'string' &&
        body.message.startsWith('401'));

    return { status: response.status, version, isGitlab };
  }

  async api<T>(
    app: IGitApp,
    path: string,
    token: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    return (await this.request<T>(app, path, token, options)).data;
  }

  /** Follows `x-next-page`, 100 per page, at most `maxPages` pages. */
  async paginate<T>(
    app: IGitApp,
    path: string,
    token: string,
    maxPages: number,
  ): Promise<T[]> {
    const items: T[] = [];
    const separator = path.includes('?') ? '&' : '?';
    let page = '1';

    for (let count = 0; page && count < maxPages; count++) {
      const { data, headers } = await this.request<T[]>(
        app,
        `${path}${separator}per_page=100&page=${page}`,
        token,
      );

      items.push(...(Array.isArray(data) ? data : []));
      page = headers.get('x-next-page') ?? '';
    }

    return items;
  }

  private async request<T>(
    app: IGitApp,
    path: string,
    token: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const response = await fetch(`${app.apiUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(options.body !== undefined && {
          'content-type': 'application/json',
        }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: redirectMode(app),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);

      throw new GitlabApiError(
        response.status,
        messageOf(body, `GitLab responded ${response.status}`),
      );
    }

    if (response.status === 204)
      return { data: undefined as T, headers: response.headers };

    return { data: (await response.json()) as T, headers: response.headers };
  }

  private async token(
    app: IGitApp,
    params: Record<string, string>,
  ): Promise<IGitlabTokens> {
    const response = await fetch(`${app.webUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: app.clientId ?? '',
        client_secret: app.clientSecret ?? '',
        ...params,
      }),
      redirect: redirectMode(app),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!response.ok || typeof body.access_token !== 'string') {
      throw new GitlabApiError(
        response.ok ? 502 : response.status,
        messageOf(body, 'GitLab token request failed'),
        typeof body.error === 'string' ? body.error : null,
      );
    }

    const expiresIn = Number(body.expires_in) || DEFAULT_EXPIRES_IN_S;
    const issuedAt = Number(body.created_at)
      ? Number(body.created_at) * 1000
      : Date.now();

    return {
      accessToken: body.access_token,
      refreshToken:
        typeof body.refresh_token === 'string' ? body.refresh_token : '',
      expiresAt: new Date(issuedAt + expiresIn * 1000).toISOString(),
    };
  }
}

/** An admin-typed server never follows redirects (ticket 11); the built-in gitlab.com app does, as before. */
function redirectMode(app: IGitApp): RequestRedirect {
  return app.serverId ? 'manual' : 'follow';
}
