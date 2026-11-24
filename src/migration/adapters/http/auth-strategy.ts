/**
 * @fileoverview Authentication strategies for outbound Atlassian requests.
 *
 * - Basic:  `username:secret` (Server user/pass, or Cloud email:API-token) — the migration default.
 * - Bearer PAT: Server/DC Personal Access Token (Jira ≥8.14 / Confluence ≥7.9).
 * - OAuth: Cloud 3LO — declared here; refresh wiring lands in Phase 8 (Jira Cloud parity).
 */

import type {
  IAuthStrategy,
  SourceAuthType,
} from '../source-adapter.interface';

export class BasicAuthStrategy implements IAuthStrategy {
  private readonly header: string;

  constructor(username: string, secret: string) {
    this.header =
      'Basic ' + Buffer.from(`${username}:${secret}`).toString('base64');
  }

  // Sync header mutation; returns a resolved promise to satisfy the async `IAuthStrategy`
  // contract (OAuth's `apply` will genuinely await a token refresh in Phase 8).
  apply(headers: Record<string, string>): Promise<void> {
    headers['Authorization'] = this.header;

    return Promise.resolve();
  }
}

export class BearerPatStrategy implements IAuthStrategy {
  constructor(private readonly token: string) {}

  apply(headers: Record<string, string>): Promise<void> {
    headers['Authorization'] = `Bearer ${this.token}`;

    return Promise.resolve();
  }
}

/**
 * Build the auth strategy for a connection. `authType` comes from `migration_connections.auth_type`;
 * `username` is `auth_username` (email/username), `secret` is the decrypted credential.
 */
export function buildAuthStrategy(
  authType: SourceAuthType,
  secret: string,
  username?: string | null,
): IAuthStrategy {
  switch (authType) {
    case 'basic':
      if (!username) {
        throw new Error(
          'Basic auth requires a username (email for Cloud, username for Server)',
        );
      }

      return new BasicAuthStrategy(username, secret);

    case 'pat':
      return new BearerPatStrategy(secret);

    case 'oauth':
      // OAuth 3LO (with lazy token refresh) is implemented in Phase 8 for Jira Cloud parity.
      throw new Error(
        'OAuth authentication is not available yet — use Basic or a Personal Access Token',
      );

    default:
      throw new Error(`Unknown auth type: ${authType as string}`);
  }
}
