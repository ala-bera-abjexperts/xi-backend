// Microsoft Graph app-only tokens (OAuth2 client credentials).
//
// No user, no consent screen, no refresh token — the app authenticates as itself
// and reads a named mailbox. This is why the delegated flow was dropped: it
// removes the admin-approval prompt, the personal-vs-work account problem, and
// the rotated-refresh-token bug in one go.

import { Injectable, Logger, BadRequestException } from '@nestjs/common';

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';
const REQUEST_TIMEOUT_MS = 15_000;
// Renew early so a token never expires mid-poll on a skewed clock.
const EXPIRY_SKEW_MS = 60_000;

export interface MailboxCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailboxAddress: string;
}

// metadata is free-form jsonb; anything non-string is treated as absent rather
// than stringified into "[object Object]".
function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

@Injectable()
export class GraphTokenService {
  private readonly logger = new Logger(GraphTokenService.name);

  // Keyed by connectionId + updatedAt: saving new credentials changes the key,
  // so a rotated secret takes effect immediately instead of after the old
  // token's ~1h lifetime.
  private readonly cache = new Map<string, CachedToken>();

  /**
   * Pull credentials out of a connection's decrypted secret + metadata.
   * Throws with the missing field named — a blank client_id would otherwise
   * reach Microsoft and come back as the opaque AADSTS900144.
   */
  static readCredentials(
    decryptedSecret: string,
    metadata: Record<string, unknown>,
  ): MailboxCredentials {
    const tenantId = readString(metadata.tenantId);
    const clientId = readString(metadata.clientId);
    const mailboxAddress = readString(metadata.mailboxAddress);
    const clientSecret = (decryptedSecret ?? '').trim();

    const missing = [
      !tenantId && 'tenantId',
      !clientId && 'clientId',
      !clientSecret && 'clientSecret',
      !mailboxAddress && 'mailboxAddress',
    ].filter(Boolean);

    if (missing.length > 0) {
      throw new BadRequestException(
        `Mailbox connection is missing: ${missing.join(', ')}`,
      );
    }

    // Client credentials cannot use the multi-tenant aliases — Microsoft needs a
    // concrete tenant to issue an app-only token, and the resulting error is
    // otherwise very hard to read.
    if (['common', 'consumers', 'organizations'].includes(tenantId)) {
      throw new BadRequestException(
        `Tenant "${tenantId}" cannot be used for a mailbox connection — enter your organisation's tenant ID`,
      );
    }

    return { tenantId, clientId, clientSecret, mailboxAddress };
  }

  async getToken(cacheKey: string, creds: MailboxCredentials): Promise<string> {
    const hit = this.cache.get(cacheKey);

    if (hit && hit.expiresAt > Date.now()) return hit.token;

    const token = await GraphTokenService.fetchToken(creds);

    this.cache.set(cacheKey, {
      token: token.accessToken,
      expiresAt: Date.now() + token.expiresInMs - EXPIRY_SKEW_MS,
    });

    return token.accessToken;
  }

  /** Drop a cached token — call when credentials change or a 401 is seen. */
  invalidate(cacheKey: string): void {
    this.cache.delete(cacheKey);
  }

  /**
   * Static so the connection validator can probe credentials that have not been
   * saved yet, without going through the cache.
   */
  static async fetchToken(
    creds: MailboxCredentials,
  ): Promise<{ accessToken: string; expiresInMs: number }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;

    try {
      res = await fetch(
        `${LOGIN}/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            scope: GRAPH_DEFAULT_SCOPE,
          }),
          signal: ctrl.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');

      throw new Error(GraphTokenService.describeTokenError(res.status, body));
    }

    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!json.access_token) {
      throw new Error('Microsoft returned no access token for this mailbox');
    }

    return {
      accessToken: json.access_token,
      expiresInMs: (json.expires_in ?? 3600) * 1000,
    };
  }

  /** Turn AAD error codes into something a non-admin can act on. */
  private static describeTokenError(status: number, body: string): string {
    if (body.includes('AADSTS7000215'))
      return 'Client secret is invalid or has expired — enter a new secret from the Azure app registration.';
    if (body.includes('AADSTS700016') || body.includes('AADSTS900023'))
      return 'Client ID or tenant ID was not found — check both against the Azure app registration.';
    if (body.includes('AADSTS7000222'))
      return 'The client secret has expired — generate a new one in Azure.';

    return `Microsoft token request failed (${status}): ${body.slice(0, 300)}`;
  }
}
