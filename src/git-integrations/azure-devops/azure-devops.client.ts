/**
 * @fileoverview Thin HTTP client for Azure DevOps Services: Microsoft Entra sign-in and the REST API.
 * Holds no state; the app and the tokens are passed in on every call.
 *
 * XISUITE never writes to a repository: the sign-in asks for read scopes only (`vso.code`, not
 * `vso.code_write`), and {@link AzureDevopsClient.org} refuses every write except service hook
 * subscriptions, which live in the project's settings and never in a repository.
 * @module src/git-integrations/azure-devops/azure-devops.client
 */

import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { IGitApp } from '../git-integrations.types';

const TIMEOUT_MS = 10_000;
const API_VERSION = '7.1';
const DEFAULT_EXPIRES_IN_S = 3600;

export const AZURE_DEVOPS_HOST = 'dev.azure.com';
export const AZURE_DEVOPS_WEB_URL = `https://${AZURE_DEVOPS_HOST}`;

/** Multi-tenant Entra app, work and school accounts. Entra has no sign-in for personal accounts on this resource. */
const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
/** The Azure DevOps resource in Entra. */
const RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
/** Profile and Accounts are organization-independent. */
const VSSPS_URL = 'https://app.vssps.visualstudio.com';

/**
 * Every permission of the app registration: `vso.code`, `vso.build`, `vso.project`, `vso.profile`.
 * No hooks scope: Microsoft lists `vso.code`, `vso.build` and `vso.work` for creating, listing and deleting
 * service hook subscriptions, and `vso.hooks*` are no longer public. A 403 on them is shown on the repository.
 */
export const AZURE_CONNECT_SCOPE = `${RESOURCE}/.default offline_access`;
/** A personal link: who the person is, no repository access. */
export const AZURE_IDENTITY_SCOPE = `${RESOURCE}/vso.profile`;

/** The only API area XISUITE may write to. */
const WRITABLE_PATH = /^\/_apis\/hooks\/subscriptions(?:[/?]|$)/;

export class AzureDevopsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** OAuth `error` code from the token endpoint (e.g. `invalid_grant`). */
    readonly oauthError: string | null = null,
  ) {
    super(message);
    this.name = 'AzureDevopsApiError';
  }
}

export interface IAzureDevopsTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export interface IAzureProfile {
  id: string;
  displayName?: string | null;
  emailAddress?: string | null;
  publicAlias?: string | null;
}

export interface IAzureAccount {
  accountId: string;
  accountName: string;
}

function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const { message, error_description: description } = body as Record<
      string,
      unknown
    >;
    const text = description ?? message;

    if (typeof text === 'string') return text.slice(0, 300);
  }

  return fallback;
}

/** RFC 7636 S256 challenge of a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

@Injectable()
export class AzureDevopsClient {
  authorizeUrl(
    app: IGitApp,
    input: {
      redirectUri: string;
      scope: string;
      state: string;
      codeVerifier: string;
    },
  ): string {
    const query = new URLSearchParams({
      client_id: app.clientId ?? '',
      response_type: 'code',
      redirect_uri: input.redirectUri,
      response_mode: 'query',
      scope: input.scope,
      state: input.state,
      code_challenge: pkceChallenge(input.codeVerifier),
      code_challenge_method: 'S256',
    });

    return `${AUTHORITY}/authorize?${query.toString()}`;
  }

  exchangeCode(
    app: IGitApp,
    input: {
      code: string;
      redirectUri: string;
      scope: string;
      codeVerifier: string;
    },
  ): Promise<IAzureDevopsTokens> {
    return this.token(app, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      scope: input.scope,
      code_verifier: input.codeVerifier,
    });
  }

  /** Microsoft may leave out a new refresh token; the old one then stays valid. */
  async refresh(
    app: IGitApp,
    refreshToken: string,
  ): Promise<IAzureDevopsTokens> {
    const tokens = await this.token(app, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: AZURE_CONNECT_SCOPE,
    });

    return { ...tokens, refreshToken: tokens.refreshToken || refreshToken };
  }

  profile(token: string): Promise<IAzureProfile> {
    return this.request<IAzureProfile>(
      `${VSSPS_URL}/_apis/profile/profiles/me`,
      token,
    ).then(({ data }) => data);
  }

  /** The organizations the person belongs to. */
  async accounts(token: string, memberId: string): Promise<IAzureAccount[]> {
    const { data } = await this.request<{ value?: IAzureAccount[] }>(
      `${VSSPS_URL}/_apis/accounts?memberId=${encodeURIComponent(memberId)}`,
      token,
    );

    return data.value ?? [];
  }

  /**
   * One call to an organization's REST API; `path` starts with `/_apis` or `/<project>/_apis`.
   * @throws {Error} for any write outside service hook subscriptions: XISUITE never writes to a repository.
   */
  async org<T>(
    organization: string,
    path: string,
    token: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    return (await this.orgPage<T>(organization, path, token, options)).data;
  }

  /** {@link org} with the response headers, for `x-ms-continuationtoken`. */
  orgPage<T>(
    organization: string,
    path: string,
    token: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<{ data: T; headers: Headers }> {
    if ((options.method ?? 'GET') !== 'GET' && !WRITABLE_PATH.test(path))
      throw new Error(`Refused write to Azure DevOps: ${path.split('?')[0]}`);

    return this.request<T>(
      `${AZURE_DEVOPS_WEB_URL}/${encodeURIComponent(organization)}${path}`,
      token,
      options,
    );
  }

  private async request<T>(
    url: string,
    token: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<{ data: T; headers: Headers }> {
    const separator = url.includes('?') ? '&' : '?';
    const response = await fetch(
      `${url}${separator}api-version=${API_VERSION}`,
      {
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
        // A refused token is answered with a redirect or a 203 to the sign-in page, not a 401.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );

    if (
      response.status === 203 ||
      (response.status >= 300 && response.status < 400)
    )
      throw new AzureDevopsApiError(401, 'Azure DevOps refused the token');

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);

      throw new AzureDevopsApiError(
        response.status,
        messageOf(body, `Azure DevOps responded ${response.status}`),
      );
    }

    if (response.status === 204)
      return { data: undefined as T, headers: response.headers };

    return { data: (await response.json()) as T, headers: response.headers };
  }

  private async token(
    app: IGitApp,
    params: Record<string, string>,
  ): Promise<IAzureDevopsTokens> {
    const response = await fetch(`${AUTHORITY}/token`, {
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!response.ok || typeof body.access_token !== 'string') {
      throw new AzureDevopsApiError(
        response.ok ? 502 : response.status,
        messageOf(body, 'Microsoft token request failed'),
        typeof body.error === 'string' ? body.error : null,
      );
    }

    return {
      accessToken: body.access_token,
      refreshToken:
        typeof body.refresh_token === 'string' ? body.refresh_token : '',
      expiresAt: new Date(
        Date.now() + (Number(body.expires_in) || DEFAULT_EXPIRES_IN_S) * 1000,
      ).toISOString(),
    };
  }
}
