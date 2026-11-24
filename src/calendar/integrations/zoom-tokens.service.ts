/**
 * @fileoverview A person's Zoom login, as a token that works right now.
 *
 * Zoom rotates refresh tokens and two refreshes at once can end the grant, so a refresh is taken
 * under a short lease on the account row and everyone else waits for the token it stores.
 */
import { BadRequestException, Injectable } from '@nestjs/common';

import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { CalendarAccountRow } from './calendar-accounts.service';
import { CalendarAccountsService } from './calendar-accounts.service';
import { ZoomProvider } from './zoom.provider';

const TABLE = 'calendar_accounts';

/** A token this close to expiry is renewed before it is used. */
const EXPIRY_MARGIN_MS = 60_000;

const LEASE_MS = 15_000;

const WAIT_MS = 1_000;

const ATTEMPTS = 5;

export interface ZoomLogin {
  accountId: string;
  zoomUserId: string;
  token: string;
}

export interface ZoomLoginStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  needsReconnect: boolean;
}

function statusOf(error: unknown): number | null {
  const match =
    error instanceof Error ? /\((\d{3})\)$/.exec(error.message) : null;

  return match ? Number(match[1]) : null;
}

@Injectable()
export class ZoomTokensService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly accounts: CalendarAccountsService,
    private readonly zoom: ZoomProvider,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** The acting person's Zoom login in this organization, with a token good right now. */
  async forPerson(userId: string, organizationId: string): Promise<ZoomLogin> {
    const row = await this.ownRow(userId, organizationId);

    if (!row) throw new Error('Connect your Zoom account (428)');

    if (row.status !== 'active') {
      throw new Error('Reconnect your Zoom account (401)');
    }

    return this.login(row);
  }

  /** The login that made a meeting: the host's row for that exact Zoom user, in any organization. */
  async forHost(
    hostUserId: string | null,
    zoomUserId: string,
  ): Promise<ZoomLogin> {
    const result = hostUserId
      ? await this.client
          .from(TABLE)
          .select('*')
          .eq('user_id', hostUserId)
          .eq('provider', 'zoom')
          .eq('external_account_id', zoomUserId)
          .maybeSingle()
      : { data: null, error: null };

    const row = (result.data as CalendarAccountRow | null) ?? null;

    if (result.error || !row || row.status !== 'active') {
      throw new Error('Reconnect Zoom to update this meeting (401)');
    }

    return this.login(row);
  }

  /** What the person sees about their own Zoom login; never a token. */
  async status(
    userId: string,
    organizationId: string,
  ): Promise<ZoomLoginStatus> {
    const row = await this.ownRow(userId, organizationId);

    return {
      configured: this.zoom.configured,
      connected: Boolean(row && row.status === 'active'),
      email: row?.display_name ?? null,
      needsReconnect: Boolean(row && row.status !== 'active'),
    };
  }

  /** A token Zoom refused means the login was withdrawn there. */
  async invalid(accountId: string, reason: string): Promise<void> {
    await this.accounts.markNeedsReconnect(accountId, reason);
  }

  private async ownRow(
    userId: string,
    organizationId: string,
  ): Promise<CalendarAccountRow | null> {
    const result = await this.client
      .from(TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .eq('provider', 'zoom')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (result.error) throw new BadRequestException(result.error.message);

    return (result.data as CalendarAccountRow | null) ?? null;
  }

  private async login(row: CalendarAccountRow): Promise<ZoomLogin> {
    return {
      accountId: row.id,
      zoomUserId: row.external_account_id ?? '',
      token: await this.usable(row),
    };
  }

  /** A token that works now, renewed under the lease when it is about to run out. */
  private async usable(first: CalendarAccountRow): Promise<string> {
    let row: CalendarAccountRow | null = first;

    for (let attempt = 0; attempt < ATTEMPTS && row; attempt++) {
      const { accessToken, refreshToken, expiresAt } =
        this.accounts.tokens(row);

      const fresh =
        accessToken &&
        (!expiresAt || Date.parse(expiresAt) - Date.now() > EXPIRY_MARGIN_MS);

      if (fresh) return accessToken;

      if (!refreshToken) {
        await this.accounts.markNeedsReconnect(
          row.id,
          'No refresh token stored — reconnect Zoom.',
        );

        throw new Error('Reconnect your Zoom account (401)');
      }

      if (await this.lease(row.id)) {
        // Re-read once the lease is ours; another request may have renewed it a moment ago.
        const latest = (await this.accounts.getById(row.id)) ?? row;
        const now = this.accounts.tokens(latest);

        if (
          now.accessToken &&
          (!now.expiresAt ||
            Date.parse(now.expiresAt) - Date.now() > EXPIRY_MARGIN_MS)
        ) {
          await this.release(row.id);

          return now.accessToken;
        }

        return this.renew(row.id, now.refreshToken ?? refreshToken);
      }

      // Someone else is renewing it; their token is read back rather than refreshing twice.
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      row = await this.accounts.getById(row.id);
    }

    throw new Error('Zoom sign-in is busy, try again (429)');
  }

  private async renew(
    accountId: string,
    refreshToken: string,
  ): Promise<string> {
    try {
      const renewed = await this.zoom.refresh(refreshToken);

      await this.accounts.storeRefreshed(
        accountId,
        renewed.accessToken,
        renewed.expiresAt,
        renewed.refreshToken,
      );

      return renewed.accessToken;
    } catch (error) {
      const status = statusOf(error);
      const latest = await this.accounts.getById(accountId);
      const unchanged =
        latest && this.accounts.tokens(latest).refreshToken === refreshToken;

      // Only Zoom's refusal of the token we still hold ends the login; a network error or a token
      // rotated meanwhile by another request does not.
      if (unchanged && (status === 400 || status === 401)) {
        await this.accounts.markNeedsReconnect(
          accountId,
          error instanceof Error ? error.message : 'refresh failed',
        );

        throw new Error('Reconnect your Zoom account (401)');
      }

      throw error instanceof Error
        ? error
        : new Error('Zoom could not be reached (504)');
    } finally {
      await this.release(accountId);
    }
  }

  private async release(accountId: string): Promise<void> {
    await this.client
      .from(TABLE)
      .update({ refresh_lease_until: null })
      .eq('id', accountId);
  }

  /** Claims the right to renew this account's token; plain filters only, never .or() on an update. */
  private async lease(accountId: string): Promise<boolean> {
    const now = new Date();
    const until = new Date(now.getTime() + LEASE_MS).toISOString();

    const free = await this.client
      .from(TABLE)
      .update({ refresh_lease_until: until })
      .eq('id', accountId)
      .is('refresh_lease_until', null)
      .select('id')
      .maybeSingle();

    if (free.data) return true;

    const stale = await this.client
      .from(TABLE)
      .update({ refresh_lease_until: until })
      .eq('id', accountId)
      .lt('refresh_lease_until', now.toISOString())
      .select('id')
      .maybeSingle();

    return Boolean(stale.data);
  }
}
