/**
 * @fileoverview External calendar accounts: one row per person per provider.
 *
 * Deliberately user-owned. The automation connections are space-owned, so syncing a personal calendar
 * through one would hand that credential to everyone in the space.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import {
  decryptApiKey,
  encryptApiKey,
  packSecretForStorage,
  unpackStoredSecret,
} from '../../lib/crypto/encryption';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { CalendarAuditService } from '../calendar-audit.service';

const TABLE = 'calendar_accounts';

export type CalendarProvider =
  | 'google'
  | 'microsoft'
  | 'calendly'
  | 'ics'
  | 'zoom';

/** Asks the provider to withdraw a token; a provider without that offers nothing to call. */
export type RevokeAtProvider = (
  provider: CalendarProvider,
  accessToken: string,
) => Promise<void> | undefined;

export interface CalendarAccountRow {
  id: string;
  organization_id: string;
  user_id: string;
  provider: CalendarProvider;
  external_account_id: string | null;
  display_name: string | null;
  encrypted_secret: string | null;
  encryption_iv: string | null;
  encryption_tag: string | null;
  metadata: Record<string, unknown>;
  status: string;
  last_error: string | null;
  last_synced_at: string | null;
  [key: string]: unknown;
}

/** What the API may show about a connected account: never the token. */
export interface CalendarAccountView {
  id: string;
  provider: CalendarProvider;
  display_name: string | null;
  external_account_id: string | null;
  status: string;
  last_error: string | null;
  last_synced_at: string | null;

  // When the access token stops working. A published link has none, and an expired one is renewed
  // on the next sync, so this is shown, never acted on.
  expires_at: string | null;
  scopes: string[];
}

@Injectable()
export class CalendarAccountsService {
  private readonly logger = new Logger(CalendarAccountsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly audit?: CalendarAuditService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  static view(row: CalendarAccountRow): CalendarAccountView {
    const scope = row.metadata?.scope;

    return {
      id: row.id,
      provider: row.provider,
      display_name: row.display_name,
      external_account_id: row.external_account_id,
      status: row.status,
      last_error: row.last_error,
      last_synced_at: row.last_synced_at,
      expires_at: (row.metadata?.token_expires_at as string | null) ?? null,
      scopes: typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [],
    };
  }

  /** The accounts this person connected, without any secret. */
  async listForUser(
    userId: string,
    organizationId: string,
  ): Promise<CalendarAccountView[]> {
    const result = await this.client
      .from(TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (result.error) throw new BadRequestException(result.error.message);

    return ((result.data ?? []) as CalendarAccountRow[]).map((row) =>
      CalendarAccountsService.view(row),
    );
  }

  async getOwned(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<CalendarAccountRow> {
    const result = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .maybeSingle();

    if (result.error) throw new BadRequestException(result.error.message);
    if (!result.data) throw new NotFoundException('Calendar account not found');

    return result.data as CalendarAccountRow;
  }

  /** Used by the sync engine, which acts for the calendar's owner rather than the caller. */
  async getById(id: string): Promise<CalendarAccountRow | null> {
    const result = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (result.error) throw new BadRequestException(result.error.message);

    return (result.data as CalendarAccountRow | null) ?? null;
  }

  /**
   * Stores a freshly connected account, or updates the one already there.
   *
   * Reconnecting the same account updates the row, so automations and calendars that point at it keep
   * working instead of ending up beside a duplicate.
   */
  async save(input: {
    organizationId: string;
    userId: string;
    provider: CalendarProvider;
    externalAccountId: string | null;
    displayName: string | null;
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: string | null;
    scope?: string | null;
  }): Promise<CalendarAccountRow> {
    const secret = encryptApiKey(input.accessToken);
    const metadata: Record<string, unknown> = {
      scope: input.scope ?? null,
      token_expires_at: input.expiresAt ?? null,
    };

    if (input.refreshToken) {
      metadata.refresh_token = packSecretForStorage(input.refreshToken);
    }

    const existing = input.externalAccountId
      ? await this.client
          .from(TABLE)
          .select('id, metadata')
          .eq('user_id', input.userId)
          .eq('provider', input.provider)
          .eq('external_account_id', input.externalAccountId)
          .maybeSingle()
      : { data: null, error: null };

    if (existing.error) throw new BadRequestException(existing.error.message);

    const row = {
      organization_id: input.organizationId,
      user_id: input.userId,
      provider: input.provider,
      external_account_id: input.externalAccountId,
      display_name: input.displayName,
      encrypted_secret: secret.encrypted,
      encryption_iv: secret.iv,
      encryption_tag: secret.tag,

      // A reconnect without a new refresh token keeps the one already stored.
      metadata: {
        ...((existing.data?.metadata as Record<string, unknown>) ?? {}),
        ...metadata,
      },
      status: 'active',
      last_error: null,
    };

    const written = existing.data
      ? await this.client
          .from(TABLE)
          .update(row)
          .eq('id', existing.data.id as string)
          .select()
          .single()
      : await this.client.from(TABLE).insert(row).select().single();

    if (written.error) throw new BadRequestException(written.error.message);

    return written.data as CalendarAccountRow;
  }

  /** The access token, and the refresh token when one was stored. */
  tokens(row: CalendarAccountRow): {
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: string | null;
  } {
    const accessToken =
      row.encrypted_secret && row.encryption_iv && row.encryption_tag
        ? decryptApiKey(
            row.encrypted_secret,
            row.encryption_iv,
            row.encryption_tag,
          )
        : null;

    return {
      accessToken,
      refreshToken: unpackStoredSecret(
        row.metadata?.refresh_token as string | undefined,
      ),
      expiresAt: (row.metadata?.token_expires_at as string | null) ?? null,
    };
  }

  /** Saves a refreshed access token, keeping a rotated refresh token when the provider sends one. */
  async storeRefreshed(
    id: string,
    accessToken: string,
    expiresAt: string | null,
    rotatedRefreshToken?: string | null,
  ): Promise<void> {
    const current = await this.getById(id);

    if (!current) return;

    const secret = encryptApiKey(accessToken);
    const metadata: Record<string, unknown> = {
      ...current.metadata,
      token_expires_at: expiresAt,
    };

    // Zoom and Microsoft hand back a new refresh token; losing it would break the next refresh.
    if (rotatedRefreshToken) {
      metadata.refresh_token = packSecretForStorage(rotatedRefreshToken);
    }

    await this.client
      .from(TABLE)
      .update({
        encrypted_secret: secret.encrypted,
        encryption_iv: secret.iv,
        encryption_tag: secret.tag,
        metadata,
        status: 'active',
        last_error: null,
      })
      .eq('id', id);
  }

  async markNeedsReconnect(id: string, reason: string): Promise<void> {
    await this.client
      .from(TABLE)
      .update({ status: 'reauth_required', last_error: reason })
      .eq('id', id);
  }

  /**
   * Disconnects an account. Calendars linked to it keep their entries and simply stop syncing, because
   * the link column is cleared rather than the calendar removed.
   */
  async disconnect(
    id: string,
    userId: string,
    organizationId: string,
    revoke?: RevokeAtProvider,
  ): Promise<{ success: true }> {
    const account = await this.getOwned(id, userId, organizationId);

    // Access is withdrawn at the provider first; a provider that refuses never keeps the row here.
    await this.revokeQuietly(account, revoke);

    const unlinked = await this.client
      .from('calendars')
      .update({
        sync_account_id: null,
        sync_external_calendar_id: null,
        sync_status: 'idle',
        sync_state: {},
      })
      .eq('organization_id', organizationId)
      .eq('sync_account_id', id);

    if (unlinked.error) throw new BadRequestException(unlinked.error.message);

    const removed = await this.client.from(TABLE).delete().eq('id', id);

    if (removed.error) throw new BadRequestException(removed.error.message);

    return { success: true };
  }

  /**
   * Keeps one account of this provider per person: any other is withdrawn and removed.
   *
   * Used for Zoom, where a person signs in with exactly one Zoom user.
   */
  async keepOnly(
    kept: CalendarAccountRow,
    revoke?: RevokeAtProvider,
  ): Promise<void> {
    const others = await this.client
      .from(TABLE)
      .select('*')
      .eq('user_id', kept.user_id)
      .eq('provider', kept.provider)
      .neq('id', kept.id);

    if (others.error) throw new BadRequestException(others.error.message);

    for (const row of (others.data ?? []) as CalendarAccountRow[]) {
      await this.revokeQuietly(row, revoke);

      const removed = await this.client.from(TABLE).delete().eq('id', row.id);

      if (removed.error) {
        this.logger.warn(
          `Replaced ${row.provider} account ${row.id} was not removed`,
        );

        continue;
      }

      this.audit?.integration(
        'disconnect',
        row.organization_id,
        row.user_id,
        row.id,
        {
          provider: row.provider,
          account: row.display_name,
          replaced_by: kept.id,
        },
      );
    }
  }

  /** Never fails the caller; only the account id and the reason's status are logged. */
  private async revokeQuietly(
    row: CalendarAccountRow,
    revoke?: RevokeAtProvider,
  ): Promise<void> {
    if (!revoke) return;

    try {
      const { accessToken } = this.tokens(row);

      if (accessToken) await revoke(row.provider, accessToken);
    } catch (error) {
      const status =
        error instanceof Error ? /\((\d{3})\)$/.exec(error.message)?.[1] : null;

      this.logger.warn(
        `Access for ${row.provider} account ${row.id} was not revoked (${status ?? 'no status'})`,
      );
    }
  }
}
