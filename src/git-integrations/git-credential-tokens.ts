/**
 * @fileoverview The refresh of a stored Git sign-in (`git_credentials`), shared by GitLab and Azure DevOps.
 * Refresh tokens rotate, so two refreshes at once could end the grant: the refresh runs under a short lease
 * on the row and everyone else reads back its result.
 * @module src/git-integrations/git-credential-tokens
 */

import { InternalServerErrorException, type Logger } from '@nestjs/common';

import { decryptApiKey, encryptApiKey } from '../lib/crypto/encryption';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { GitIntegrationsService } from './git-integrations.service';

const CREDENTIALS = 'git_credentials';

/** A token this close to expiry is renewed before it is used. */
const EXPIRY_MARGIN_MS = 60_000;
const LEASE_MS = 30_000;
const WAIT_MS = 1_000;
const ATTEMPTS = 5;

export interface IGitCredentialRow {
  id: string;
  organization_id: string;
  provider: 'gitlab' | 'azure_devops';
  host: string;
  external_user_id: string;
  external_login: string | null;
  encrypted_secret: string;
  encryption_iv: string;
  encryption_tag: string;
  expires_at: string | null;
  refresh_lease_until: string | null;
  status: 'active' | 'invalid';
  created_by: string | null;
  created_at: string;
}

export interface IStoredTokens {
  access_token: string;
  refresh_token: string;
}

export interface IRenewedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export function encryptedTokens(tokens: IRenewedTokens): {
  encrypted_secret: string;
  encryption_iv: string;
  encryption_tag: string;
} {
  const encrypted = encryptApiKey(
    JSON.stringify({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
    } satisfies IStoredTokens),
  );

  return {
    encrypted_secret: encrypted.encrypted,
    encryption_iv: encrypted.iv,
    encryption_tag: encrypted.tag,
  };
}

export function storedTokens(row: IGitCredentialRow): IStoredTokens {
  return JSON.parse(
    decryptApiKey(row.encrypted_secret, row.encryption_iv, row.encryption_tag),
  ) as IStoredTokens;
}

export class GitCredentialTokens {
  constructor(
    private readonly deps: {
      /** In log and error messages. */
      label: string;
      logger: Logger;
      supabaseAdmin: SupabaseAdminService;
      core: Pick<GitIntegrationsService, 'listConnections' | 'setStatus'>;
      refresh(
        row: IGitCredentialRow,
        refreshToken: string,
      ): Promise<IRenewedTokens>;
      /** The provider refused the refresh token: only a new sign-in helps. */
      isRefusal(error: unknown): boolean;
      /** Thrown for a credential already known to be refused. */
      expiredError(): Error;
      delay(ms: number): Promise<void>;
    },
  ) {}

  private get db() {
    return this.deps.supabaseAdmin.getClient();
  }

  async read(
    id: string,
    organizationId: string,
  ): Promise<IGitCredentialRow | null> {
    const { data, error } = await this.db
      .from(CREDENTIALS)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);

    return (data as IGitCredentialRow | null) ?? null;
  }

  private isFresh(row: IGitCredentialRow): boolean {
    return Boolean(
      row.expires_at &&
      Date.parse(row.expires_at) - Date.now() > EXPIRY_MARGIN_MS,
    );
  }

  /** An access token that works now. */
  async getAccessToken(first: IGitCredentialRow): Promise<string> {
    let row: IGitCredentialRow | null = first;

    for (let attempt = 0; attempt < ATTEMPTS && row; attempt++) {
      if (this.isFresh(row)) return storedTokens(row).access_token;
      if (row.status === 'invalid') throw this.deps.expiredError();

      if (await this.lease(row)) {
        // Another request may have renewed it just before the lease became ours.
        const latest: IGitCredentialRow =
          (await this.read(row.id, row.organization_id)) ?? row;

        if (this.isFresh(latest)) {
          await this.release(latest);

          return storedTokens(latest).access_token;
        }

        return this.renew(latest);
      }

      await this.deps.delay(WAIT_MS);
      row = await this.read(row.id, row.organization_id);
    }

    throw new Error(`${this.deps.label} token refresh is busy, try again`);
  }

  private async renew(row: IGitCredentialRow): Promise<string> {
    try {
      const renewed = await this.deps.refresh(
        row,
        storedTokens(row).refresh_token,
      );
      const { error } = await this.db
        .from(CREDENTIALS)
        .update({
          ...encryptedTokens(renewed),
          expires_at: renewed.expiresAt,
          refresh_lease_until: null,
          status: 'active',
        })
        .eq('id', row.id)
        .eq('organization_id', row.organization_id);

      // The old refresh token is spent; nothing to fall back to. Use the new token for this call.
      if (error)
        this.deps.logger.error(
          `${this.deps.label} refreshed token not stored for ${row.id}: ${error.message}`,
        );

      return renewed.accessToken;
    } catch (error) {
      if (this.deps.isRefusal(error)) await this.markInvalid(row);

      throw error;
    } finally {
      await this.release(row);
    }
  }

  /** The provider refused the refresh token: every live connection using it needs a Reconnect. */
  private async markInvalid(row: IGitCredentialRow): Promise<void> {
    await this.db
      .from(CREDENTIALS)
      .update({ status: 'invalid' })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id);

    const connections = await this.deps.core.listConnections(
      row.organization_id,
      row.provider,
    );

    for (const connection of connections.filter(
      (c) => c.credential_id === row.id,
    )) {
      await this.deps.core.setStatus(
        connection,
        'needs_attention',
        'authorization_expired',
      );
    }
  }

  /** Claims the right to refresh; plain filters only (as in ZoomTokensService), never .or() on an update. */
  private async lease(row: IGitCredentialRow): Promise<boolean> {
    const now = new Date();
    const until = new Date(now.getTime() + LEASE_MS).toISOString();

    const free = await this.db
      .from(CREDENTIALS)
      .update({ refresh_lease_until: until })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id)
      .is('refresh_lease_until', null)
      .select('id');

    if (free.data?.length) return true;

    const stale = await this.db
      .from(CREDENTIALS)
      .update({ refresh_lease_until: until })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id)
      .lt('refresh_lease_until', now.toISOString())
      .select('id');

    return Boolean(stale.data?.length);
  }

  private async release(row: IGitCredentialRow): Promise<void> {
    await this.db
      .from(CREDENTIALS)
      .update({ refresh_lease_until: null })
      .eq('id', row.id)
      .eq('organization_id', row.organization_id);
  }
}
