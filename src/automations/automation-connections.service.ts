// Automation connections — store, encrypt, and retrieve integration credentials (OAuth tokens, API keys).

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  decryptApiKey,
  encryptApiKey,
  packSecretForStorage,
  unpackStoredSecret,
} from '../lib/crypto/encryption';
import {
  validateNonGoogleProvider,
  type ConnectionCheckResult,
  type ValidatorResult,
} from './connection-validators';
import { isAllowedConfiguredOrSubdomainOrigin } from '../common/cors/site-studio-cors.util';
import type {
  IAutomationConnection,
  IAutomationConnectionResponse,
} from './interfaces/automation.interface';

// The edit form prefills masked previews, so a value carrying this back is one the user never
// retyped. Rejected on write so a preview can never overwrite the real credential.
const MASK_CHAR = '•';

function isMasked(value: unknown): boolean {
  return typeof value === 'string' && value.includes(MASK_CHAR);
}

function maskSecret(value: string | null | undefined): string {
  if (!value) return '••••••••';
  const len = value.length;
  if (len <= 4) return '••••';
  return value.slice(0, 4) + '••••••••' + value.slice(-2);
}

// SECURITY (H7): OAuth refresh/access tokens are stored in connection metadata.
// Strip known-secret keys so they are never returned to clients (even to a
// low-privilege viewer via the list endpoint). Encryption-at-rest of the stored
// refresh_token is a separate hardening step tracked in the report.
const SECRET_METADATA_KEYS = new Set([
  'refresh_token',
  'access_token',
  'token',
  'id_token',
  'client_secret',
  'secret',
  'password',
  'api_key',
  'apikey',
  // Identify the Azure app registration, so they are never sent to the client. Server-side reads
  // go through getConnectionMetadata(), which returns the raw row and is unaffected by this.
  'tenantid',
  'clientid',
]);

// Public Azure app-registration identifiers, not credentials — still stripped from `metadata`, but
// safe to preview so the edit form can show WHICH app is configured. Real secrets are never previewed.
const PREVIEWABLE_METADATA_KEYS = new Set(['tenantid', 'clientid']);

function sanitizeConnectionMetadata(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return metadata ?? null;
  }

  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(metadata as Record<string, unknown>)) {
    if (SECRET_METADATA_KEYS.has(k.toLowerCase())) continue;
    out[k] = v;
  }

  return out;
}

// Display-only previews. Never round-tripped: the edit form shows these as a hint and leaves the
// input blank, so a save cannot write a mask back over the stored value.
function maskedMetadata(metadata: unknown): Record<string, string> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(metadata as Record<string, unknown>)) {
    if (!PREVIEWABLE_METADATA_KEYS.has(k.toLowerCase())) continue;
    if (typeof v === 'string' && v) out[k] = maskSecret(v);
  }

  return out;
}

// Masks the decrypted secret, not the ciphertext — a ciphertext mask identifies nothing.
function maskStoredSecret(c: IAutomationConnection): string {
  try {
    return maskSecret(
      decryptApiKey(c.encrypted_secret, c.encryption_iv, c.encryption_tag),
    );
  } catch {
    return '••••••••';
  }
}

function toResponse(c: IAutomationConnection): IAutomationConnectionResponse {
  return {
    id: c.id,
    organization_id: c.organization_id,
    space_id: c.space_id,
    provider: c.provider,
    display_name: c.display_name,
    external_account_id: c.external_account_id,
    masked_secret: maskStoredSecret(c),
    metadata: sanitizeConnectionMetadata(
      c.metadata,
    ) as IAutomationConnectionResponse['metadata'],
    masked_metadata: maskedMetadata(c.metadata),
    is_revoked: c.is_revoked,
    last_used_at: c.last_used_at,
    created_at: c.created_at,
    updated_at: c.updated_at,
    created_by: c.created_by,
  };
}

// Refresh-token ("reconnect by") deadline. Neither Google nor Microsoft returns the refresh-token expiry in
// the token response, so it's computed from the provider's standard policy (config-adjustable):
//  - Google refresh tokens: 7 days for a "Testing" OAuth app; indefinite once "Published" (set 0 → null).
//  - Microsoft refresh tokens: ~90-day sliding window (renewed on each refresh).
const GOOGLE_REFRESH_TTL_DAYS = Number(
  process.env.GOOGLE_OAUTH_REFRESH_TTL_DAYS ?? 7,
);
const MS_REFRESH_TTL_DAYS = Number(
  process.env.AZURE_OAUTH_REFRESH_TTL_DAYS ?? 90,
);

function refreshTtlDays(provider: string): number | null {
  if (provider.startsWith('google')) return GOOGLE_REFRESH_TTL_DAYS || null;
  if (provider === 'teams' || provider === 'outlook')
    return MS_REFRESH_TTL_DAYS || null;

  return null;
}

// Deadline measured from now (used at connect and — for Microsoft's sliding window — on each refresh).
function computeRefreshExpiryFromNow(provider: string): string | null {
  const days = refreshTtlDays(provider);

  return days ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
}

// Fallback for pre-existing connections with no stored refresh_token_expires_at: derive from the
// connection's own timestamps (Google doesn't slide → from connect; Microsoft slides → from last refresh).
function deriveRefreshExpiry(
  provider: string,
  createdAt: string | null,
  updatedAt: string | null,
): string | null {
  const days = refreshTtlDays(provider);

  if (!days) return null;

  const base = provider.startsWith('google') ? createdAt : updatedAt;

  return base
    ? new Date(new Date(base).getTime() + days * 86_400_000).toISOString()
    : null;
}

@Injectable()
export class AutomationConnectionsService {
  private readonly logger = new Logger(AutomationConnectionsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly configService: ConfigService,
  ) {}

  // Validates a candidate origin (sent by the frontend as window.location.origin) before
  // it's ever trusted as an OAuth-callback redirect target. Reuses the same function/config
  // pair that already gates real CORS requests in main.ts — that's this app's existing
  // definition of "an origin we recognize as ourselves", so it's the right check for "safe
  // to redirect back to" too.
  isKnownAppOrigin(origin: string | undefined): boolean {
    if (!origin) return false;
    const allowedOrigins =
      this.configService.get<string[]>('allowedOrigins') ?? [];
    return isAllowedConfiguredOrSubdomainOrigin(origin, allowedOrigins);
  }

  /**
   * Persist the PKCE verifier on the OAuth state row it belongs to.
   *
   * Previously this lived in a process-local Map with a `setTimeout` cleanup,
   * which meant the verifier existed only in the memory of the process that
   * built the authorize URL. Any deploy, restart or crash between "user clicks
   * Connect" and "provider redirects back" silently dropped it — a live bug
   * today — and it was the one hard blocker to running more than one backend
   * process, since the callback is load-balanced to an arbitrary worker.
   *
   * `automation_oauth_states` already models everything needed: keyed by
   * `state_token`, with `expires_at` (the same 15-minute TTL the setTimeout
   * emulated) and `consumed_at`. Row expiry now handles cleanup, so no timer.
   *
   * Ordering is safe: the caller creates the state row via `createOAuthState`
   * before building the provider URL, so the row always exists by the time this
   * runs. A missing row means something upstream went wrong, so it throws rather
   * than silently producing an authorize URL whose callback can never complete.
   */
  async storePkceVerifier(stateToken: string, verifier: string): Promise<void> {
    const { data, error } = await this.db
      .from('automation_oauth_states')
      .update({ code_verifier: verifier })
      .eq('state_token', stateToken)
      .select('id')
      .maybeSingle();

    if (error) {
      this.logger.error(`storePkceVerifier failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to store PKCE verifier');
    }

    if (!data) {
      throw new InternalServerErrorException(
        'Cannot store PKCE verifier: OAuth state not found',
      );
    }
  }

  /**
   * Read the verifier and clear it in the same step, so it can only be used once
   * even if a callback is replayed. Returns undefined when absent — the caller
   * treats that as "no PKCE for this flow", matching the old Map behaviour.
   */
  async consumePkceVerifier(stateToken: string): Promise<string | undefined> {
    // Read first, then clear.
    //
    // It is tempting to do this in one `update({code_verifier: null}).select()`,
    // but SQL's UPDATE ... RETURNING yields the row AFTER the write — so that
    // returns the null we just wrote, never the verifier, and the Salesforce
    // token exchange would fail with a confusing "invalid_grant".
    const read = await this.db
      .from('automation_oauth_states')
      .select('code_verifier')
      .eq('state_token', stateToken)
      .maybeSingle();

    if (read.error) {
      this.logger.error(
        `consumePkceVerifier read failed: ${read.error.message}`,
      );
      return undefined;
    }

    const verifier = (read.data as { code_verifier: string | null } | null)
      ?.code_verifier;

    if (!verifier) return undefined;

    // Clear immediately so a replayed callback cannot reuse it. A failure here is
    // logged but not fatal: the caller still holds a valid verifier for this
    // exchange, `consumed_at` already guards state reuse, and the row expires
    // anyway — failing the user's connection over a cleanup write would be worse.
    const cleared = await this.db
      .from('automation_oauth_states')
      .update({ code_verifier: null })
      .eq('state_token', stateToken);

    if (cleared.error) {
      this.logger.error(
        `consumePkceVerifier clear failed: ${cleared.error.message}`,
      );
    }

    return verifier;
  }

  // Resolves a space's URL slug from its id, so the OAuth success redirect can be built
  // from the space the user actually connected in (spaceId — always present and validated
  // at flow start) instead of depending on the frontend having also passed a matching
  // spaceKey through the whole round trip.
  //
  // Never throws: this runs after the connection has already been saved successfully, so a
  // transient lookup failure here must degrade to the return_to fallback at the call site,
  // not crash the callback and strand the user on an error page for a connection that
  // actually succeeded.
  async getSpaceKey(spaceId: string): Promise<string | null> {
    try {
      const { data } = await this.db
        .from('spaces')
        .select('key')
        .eq('id', spaceId)
        .maybeSingle();

      return (data?.key as string | undefined) ?? null;
    } catch (err: unknown) {
      this.logger.error(
        `getSpaceKey failed for space ${spaceId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  // Read-only health check for one connection: validates the stored credential live against the
  // provider and returns only a status (never the secret). Space-scoped (IDOR-safe). The only DB
  // writes are google's / microsoft's normal token refresh (via getGoogleAccessToken /
  // getMicrosoftAccessToken), which only fire when the access token is already expired.
  async checkStatus(
    id: string,
    spaceId: string,
  ): Promise<ConnectionCheckResult> {
    const { data: conn, error } = await this.db
      .from('automation_connections')
      .select(
        'provider, is_revoked, encrypted_secret, encryption_iv, encryption_tag, metadata, created_at, updated_at',
      )
      .eq('id', id)
      .eq('space_id', spaceId)
      .maybeSingle();

    if (error || !conn) {
      throw new NotFoundException('Automation connection not found');
    }

    const provider = conn.provider as string;
    const checkedAt = new Date().toISOString();

    // OAuth callbacks store the token expiry as metadata.token_expires_at (ISO). Surface it so the
    // UI can show a "days left" + date/time. (github's real expiry comes from the validator header.)
    const meta = (conn.metadata as Record<string, unknown>) ?? {};
    const storedExpiry =
      typeof meta['token_expires_at'] === 'string'
        ? meta['token_expires_at']
        : null;

    if (conn.is_revoked) {
      return {
        status: 'revoked',
        provider,
        detail: null,
        expiresAt: null,
        checkedAt,
      };
    }

    // Google: reuse getGoogleAccessToken (validates the token + refreshes it). Map its throws.
    if (
      provider === 'google_calendar' ||
      provider === 'google_sheets' ||
      provider === 'google_drive'
    ) {
      try {
        await this.getGoogleAccessToken(id, provider, spaceId);

        // getGoogleAccessToken may have refreshed the token — re-read the fresh expiry.
        const freshMeta = (await this.getConnectionMetadata(id, spaceId).catch(
          () => ({}),
        )) as Record<string, unknown>;
        const freshExpiry =
          typeof freshMeta['refresh_token_expires_at'] === 'string'
            ? freshMeta['refresh_token_expires_at']
            : deriveRefreshExpiry(
                provider,
                conn.created_at as string | null,
                conn.updated_at as string | null,
              );

        return {
          status: 'active',
          provider,
          detail: null,
          expiresAt: freshExpiry,
          checkedAt,
        };
      } catch (err: unknown) {
        if (err instanceof NotFoundException) {
          return {
            status: 'revoked',
            provider,
            detail: null,
            expiresAt: null,
            checkedAt,
          };
        }
        if (err instanceof InternalServerErrorException) {
          return {
            status: 'expired',
            provider,
            detail: err.message,
            expiresAt: null,
            checkedAt,
          };
        }

        return {
          status: 'error',
          provider,
          detail: 'Could not verify token',
          expiresAt: null,
          checkedAt,
        };
      }
    }

    // Microsoft: reuse getMicrosoftAccessToken (validates + refreshes the token, writing a fresh
    // token_expires_at). Success → active + fresh expiry (re-read); its throws map like google's.
    // This is what makes outlook/teams read a coherent "Active · Expires in <time>" (or Reconnect)
    // instead of a stale "Active + Expired", and makes the re-check button actually update.
    if (provider === 'outlook' || provider === 'teams') {
      try {
        await this.getMicrosoftAccessToken(id, provider);

        // getMicrosoftAccessToken may have refreshed the token — re-read the fresh expiry.
        const freshMeta = (await this.getConnectionMetadata(id, spaceId).catch(
          () => ({}),
        )) as Record<string, unknown>;
        const freshExpiry =
          typeof freshMeta['refresh_token_expires_at'] === 'string'
            ? freshMeta['refresh_token_expires_at']
            : deriveRefreshExpiry(
                provider,
                conn.created_at as string | null,
                conn.updated_at as string | null,
              );

        return {
          status: 'active',
          provider,
          detail: null,
          expiresAt: freshExpiry,
          checkedAt,
        };
      } catch (err: unknown) {
        if (err instanceof NotFoundException) {
          return {
            status: 'revoked',
            provider,
            detail: null,
            expiresAt: null,
            checkedAt,
          };
        }
        if (err instanceof InternalServerErrorException) {
          return {
            status: 'expired',
            provider,
            detail: err.message,
            expiresAt: null,
            checkedAt,
          };
        }

        return {
          status: 'error',
          provider,
          detail: 'Could not verify token',
          expiresAt: null,
          checkedAt,
        };
      }
    }

    // Non-google: decrypt the stored secret and validate it against the provider.
    let secret: string;

    try {
      secret = decryptApiKey(
        conn.encrypted_secret as string,
        conn.encryption_iv as string,
        conn.encryption_tag as string,
      );
    } catch {
      return {
        status: 'error',
        provider,
        detail: 'Could not decrypt credential',
        expiresAt: null,
        checkedAt,
      };
    }

    const result = await validateNonGoogleProvider(provider, secret, meta);

    // OAuth-refresh guard (now reached only by Salesforce — outlook/teams/google return from their
    // own branches above). Salesforce has no refresh path here, so a bare-whoami 401 with a stored
    // refresh_token isn't treated as a hard failure. It carries no token_expires_at, so it never
    // shows an expiry date and cannot produce an "Active + Expired" contradiction.
    const status =
      result.status === 'invalid' && typeof meta['refresh_token'] === 'string'
        ? 'active'
        : result.status;

    return {
      status,
      provider,
      detail: result.detail,
      expiresAt: result.expiresAt ?? storedExpiry,
      checkedAt,
    };
  }

  // Validate an UNSAVED credential (no persistence) — powers the "Test connection" button in the
  // manual API-key create form. Reuses the same live validators as checkStatus.
  async validateCredential(
    provider: string,
    secret: string,
    metadata?: Record<string, unknown>,
  ): Promise<ValidatorResult> {
    return validateNonGoogleProvider(provider, secret, metadata ?? {});
  }

  async listForSpace(
    spaceId: string,
  ): Promise<IAutomationConnectionResponse[]> {
    const { data, error } = await this.db
      .from('automation_connections')
      .select('*')
      .eq('space_id', spaceId)
      .eq('is_revoked', false)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`listForSpace failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to list automation connections',
      );
    }

    return ((data ?? []) as IAutomationConnection[]).map(toResponse);
  }

  async revoke(id: string, spaceId: string): Promise<void> {
    const { data: conn } = await this.db
      .from('automation_connections')
      .select('id, space_id')
      .eq('id', id)
      .maybeSingle();

    if (!conn) {
      throw new NotFoundException('Automation connection not found');
    }

    if ((conn.space_id as string) !== spaceId) {
      throw new BadRequestException(
        'Connection does not belong to the specified space',
      );
    }

    const { error } = await this.db
      .from('automation_connections')
      .update({ is_revoked: true, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      this.logger.error(`revoke failed: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to revoke automation connection',
      );
    }
  }

  async getDecryptedSecret(
    connectionId: string,
    spaceId?: string,
  ): Promise<string> {
    // SECURITY (H1): optional space scope so a connection id from another
    // space/tenant is not usable via the space-scoped controller routes.
    let q = this.db
      .from('automation_connections')
      .select('encrypted_secret, encryption_iv, encryption_tag, is_revoked')
      .eq('id', connectionId);

    if (spaceId) q = q.eq('space_id', spaceId);

    const { data: conn, error } = await q.maybeSingle();

    if (error || !conn) {
      throw new NotFoundException('Automation connection not found');
    }
    if (conn.is_revoked) {
      throw new NotFoundException('Connection has been revoked');
    }

    let secret: string;

    try {
      secret = decryptApiKey(
        conn.encrypted_secret as string,
        conn.encryption_iv as string,
        conn.encryption_tag as string,
      );
    } catch (err: unknown) {
      this.logger.error(
        `Decryption failed for connection ${connectionId}: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException(
        'Failed to decrypt connection secret — the connection may need to be re-saved',
      );
    }

    // Non-blocking last_used_at update
    void Promise.resolve(
      this.db
        .from('automation_connections')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', connectionId),
    ).catch(() => {});

    return secret;
  }

  async getConnectionMetadata(
    connectionId: string,
    spaceId?: string,
  ): Promise<Record<string, string>> {
    let q = this.db
      .from('automation_connections')
      .select('metadata')
      .eq('id', connectionId);

    if (spaceId) q = q.eq('space_id', spaceId);

    const { data: conn, error } = await q.maybeSingle();

    if (error || !conn) {
      throw new NotFoundException('Automation connection not found');
    }

    return (conn.metadata as Record<string, string>) ?? {};
  }

  async create(input: {
    spaceId: string;
    organizationId: string;
    provider: string;
    displayName: string;
    secret: string;
    metadata?: Record<string, unknown>;
    createdBy: string | null;
    // Only set by providers whose account identity is known up-front (the
    // inbound mailbox). Left undefined elsewhere, which stores NULL and — since
    // the unique key treats NULLs as distinct — preserves today's behaviour.
    externalAccountId?: string | null;
  }): Promise<IAutomationConnectionResponse> {
    const enc = encryptApiKey(input.secret);

    const insertResult = await this.db
      .from('automation_connections')
      .insert({
        space_id: input.spaceId,
        organization_id: input.organizationId,
        provider: input.provider,
        display_name: input.displayName,
        encrypted_secret: enc.encrypted,
        encryption_iv: enc.iv,
        encryption_tag: enc.tag,
        external_account_id: input.externalAccountId ?? null,
        metadata: input.metadata ?? {},
        is_revoked: false,
        created_by: input.createdBy,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (insertResult.error || !insertResult.data) {
      // Reachable only when externalAccountId was supplied — a NULL one never
      // conflicts. Without this the user sees a generic 500 when re-entering a
      // rotated secret, which is a guaranteed eventual event.
      if (insertResult.error?.code === '23505') {
        // Revoking is a soft delete and the unique key ignores is_revoked, so the row that
        // blocks this insert may be one the user already removed. Reviving it is the only way
        // "revoke, then add it again" can ever succeed. Matches upsertOAuthConnection, which
        // already revives on the same conflict target.
        // The id is reused on purpose: automation configs reference it, and the inbound-email
        // ledger dedupes on (connection_id, dedupe_key) — a fresh id would re-ingest old mail.
        // A NULL account id cannot have caused this conflict, so never look one up.
        const externalAccountId = input.externalAccountId || null;

        const { data: existing } = externalAccountId
          ? await this.db
              .from('automation_connections')
              .select('id, is_revoked')
              .eq('organization_id', input.organizationId)
              .eq('space_id', input.spaceId)
              .eq('provider', input.provider)
              .eq('external_account_id', externalAccountId)
              .maybeSingle()
          : { data: null };

        if (existing && (existing as { is_revoked: boolean }).is_revoked) {
          const revived = await this.db
            .from('automation_connections')
            .update({
              display_name: input.displayName,
              encrypted_secret: enc.encrypted,
              encryption_iv: enc.iv,
              encryption_tag: enc.tag,
              metadata: input.metadata ?? {},
              is_revoked: false,
              created_by: input.createdBy,
              updated_at: new Date().toISOString(),
            })
            .eq('id', (existing as { id: string }).id)
            // Compare-and-swap: two concurrent re-adds both read the row as revoked, so without
            // this both would revive it and the later secret would silently win. Only the request
            // that actually flips the flag succeeds; the loser falls through to the 400 below.
            .eq('is_revoked', true)
            .select('*')
            .single();

          if (!revived.error && revived.data) {
            return toResponse(revived.data as IAutomationConnection);
          }

          // PGRST116 = no row matched, i.e. another request revived it first. Expected, not an error.
          if (revived.error && revived.error.code !== 'PGRST116') {
            this.logger.error(
              `revive revoked connection failed: ${revived.error.message}`,
            );
          }
        }

        // Still connected, or the row belongs to another org — the original guard stands.
        throw new BadRequestException(
          'This account is already connected in this space. Revoke the existing connection first, then add it again.',
        );
      }

      this.logger.error(
        `create connection failed: ${insertResult.error?.message}`,
      );
      throw new InternalServerErrorException('Failed to create connection');
    }

    return toResponse(insertResult.data as IAutomationConnection);
  }

  /**
   * Edit a manual connection's credentials in place.
   *
   * The mailbox address IS editable. Because it is the account identity, changing it also rewrites
   * `external_account_id` so the (space, provider, account) unique key keeps meaning what it says —
   * leaving it stale would let the same mailbox be connected twice and would break the revive path
   * in `create()`. A collision with another connection surfaces as a 400, not a 500.
   * A blank/omitted secret keeps the stored one, so saving the form without retyping it is safe.
   */
  async update(input: {
    connectionId: string;
    spaceId: string;
    organizationId: string;
    displayName?: string;
    metadata?: Record<string, unknown>;
    secret?: string;
  }): Promise<IAutomationConnectionResponse> {
    const { data: existing, error: readErr } = await this.db
      .from('automation_connections')
      .select('id, is_revoked, metadata, external_account_id, provider')
      .eq('id', input.connectionId)
      .eq('organization_id', input.organizationId)
      .eq('space_id', input.spaceId)
      .maybeSingle();

    if (readErr || !existing) {
      throw new NotFoundException('Automation connection not found');
    }

    if ((existing as { is_revoked: boolean }).is_revoked) {
      throw new BadRequestException(
        'This connection has been removed. Add it again instead of editing it.',
      );
    }

    const storedMetadata =
      (existing as { metadata?: Record<string, unknown> }).metadata ?? {};

    // Merge over the stored metadata — a partial edit must not drop keys the form did not send.
    // Blank strings are dropped so an untouched write-only field keeps its stored value, and so
    // are masked previews: the form prefills those, so a value still carrying MASK_CHAR is one
    // the user never retyped. Without this an edit that only renames the connection would write
    // "6470••••••••65" over the real tenantId, unrecoverably.
    const incoming = Object.fromEntries(
      Object.entries(input.metadata ?? {}).filter(([, v]) => {
        if (v === undefined || v === null) return false;
        if (isMasked(v)) return false;

        return typeof v !== 'string' || v.trim() !== '';
      }),
    );

    const merged: Record<string, unknown> = { ...storedMetadata, ...incoming };

    const patch: Record<string, unknown> = {
      metadata: merged,
      updated_at: new Date().toISOString(),
    };

    // The mailbox address is the account identity, so external_account_id has to move with it —
    // that column is what the unique key and create()'s revive lookup both match on.
    const storedMailbox = (
      typeof storedMetadata.mailboxAddress === 'string'
        ? storedMetadata.mailboxAddress
        : ''
    ).trim();

    const nextMailbox = (
      typeof merged.mailboxAddress === 'string' ? merged.mailboxAddress : ''
    ).trim();

    const mailboxChanged = !!nextMailbox && nextMailbox !== storedMailbox;

    if (mailboxChanged) {
      patch.external_account_id = nextMailbox;

      // The unique key ignores is_revoked, so a REVOKED connection still owns its address and would
      // block this edit — with nothing visible to the user, since listForSpace hides revoked rows.
      // Release the claim by nulling that row's account id: NULLs are distinct in the unique index,
      // and the row itself (plus its poller and inbound-email history, which key on connection_id)
      // is left intact. An ACTIVE holder is a real conflict and falls through to the 23505 below.
      const { data: blocker } = await this.db
        .from('automation_connections')
        .select('id, is_revoked')
        .eq('organization_id', input.organizationId)
        .eq('space_id', input.spaceId)
        .eq('provider', (existing as { provider?: string }).provider ?? '')
        .eq('external_account_id', nextMailbox)
        .neq('id', input.connectionId)
        .maybeSingle();

      if (blocker && (blocker as { is_revoked: boolean }).is_revoked) {
        const { error: freeErr } = await this.db
          .from('automation_connections')
          .update({ external_account_id: null })
          .eq('id', (blocker as { id: string }).id)
          // Compare-and-swap: if it was un-revoked in the meantime, leave it alone and let the
          // write below fail with the honest conflict instead of stealing a live address.
          .eq('is_revoked', true);

        if (freeErr) {
          this.logger.error(
            `could not release revoked connection's account id: ${freeErr.message}`,
          );
        }
      }
    }

    if (input.displayName && input.displayName.trim()) {
      patch.display_name = input.displayName.trim();
    }

    // Same masked-preview rule as the metadata above: the form prefills the stored secret as a
    // mask, so only a genuinely retyped value may overwrite it.
    if (input.secret && input.secret.trim() && !isMasked(input.secret)) {
      const enc = encryptApiKey(input.secret);

      patch.encrypted_secret = enc.encrypted;
      patch.encryption_iv = enc.iv;
      patch.encryption_tag = enc.tag;
    }

    const updateResult = await this.db
      .from('automation_connections')
      .update(patch)
      .eq('id', input.connectionId)
      .eq('organization_id', input.organizationId)
      .eq('space_id', input.spaceId)
      .select('*')
      .single();

    if (updateResult.error || !updateResult.data) {
      // Moving the address onto one this space already connects. Deliberately worded differently
      // from create()'s conflict: sharing one message makes a 400 ambiguous about which endpoint
      // produced it, which is exactly the confusion this wording avoids.
      if (updateResult.error?.code === '23505') {
        throw new BadRequestException(
          'Another connection in this space already uses that mailbox address. Choose a different address, or revoke the other connection first.',
        );
      }

      this.logger.error(
        `update connection failed: ${updateResult.error?.message}`,
      );
      throw new InternalServerErrorException('Failed to update connection');
    }

    // A delta cursor is minted per mailbox: kept after a mailbox change it would either be rejected
    // by Graph (410) or silently keep reading the old inbox. Clearing it re-seeds from the
    // watermark, so the new mailbox starts clean rather than replaying another mailbox's history.
    if (mailboxChanged) {
      const { error: pollerErr } = await this.db
        .from('automation_mailbox_pollers')
        .update({
          delta_cursor: null,
          watermark_at: new Date().toISOString(),
          last_error: null,
        })
        .eq('connection_id', input.connectionId);

      if (pollerErr) {
        // Non-fatal: the connection is already saved. A stale cursor self-heals on Graph's 410.
        this.logger.error(
          `reset mailbox poller cursor failed: ${pollerErr.message}`,
        );
      }
    }

    return toResponse(updateResult.data as IAutomationConnection);
  }

  async getGoogleAccessToken(
    connectionId: string,
    provider:
      | 'google_calendar'
      | 'google_sheets'
      | 'google_drive' = 'google_calendar',
    spaceId?: string,
  ): Promise<string> {
    const providerName =
      provider === 'google_sheets'
        ? 'Google Sheets'
        : provider === 'google_drive'
          ? 'Google Drive'
          : 'Google Calendar';

    // SECURITY (H1): optional space scope (see getDecryptedSecret).
    let gq = this.db
      .from('automation_connections')
      .select(
        'encrypted_secret, encryption_iv, encryption_tag, is_revoked, metadata',
      )
      .eq('id', connectionId);

    if (spaceId) gq = gq.eq('space_id', spaceId);

    const { data: conn, error } = await gq.maybeSingle();

    if (error || !conn) {
      throw new NotFoundException('Automation connection not found');
    }
    if (conn.is_revoked) {
      throw new NotFoundException('Connection has been revoked');
    }

    let accessToken = decryptApiKey(
      conn.encrypted_secret as string,
      conn.encryption_iv as string,
      conn.encryption_tag as string,
    );

    // Validate token scope via Google tokeninfo
    const tokenInfoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`,
    );
    const tokenInfo = (await tokenInfoRes.json()) as {
      scope?: string;
      error?: string;
    };

    const hasCalendarScope =
      tokenInfo.scope?.includes('auth/calendar') ||
      tokenInfo.scope?.includes('calendar.readonly');

    // Only enforce calendar scope for google_calendar connections
    if (
      tokenInfoRes.ok &&
      provider === 'google_calendar' &&
      !hasCalendarScope
    ) {
      throw new InternalServerErrorException(
        'Google Calendar connection is missing required permissions — re-authorize the connection with calendar access',
      );
    }

    // Token invalid/expired — attempt refresh
    if (!tokenInfoRes.ok || tokenInfo.error) {
      const meta = (conn.metadata as Record<string, string>) ?? {};
      const refreshToken = unpackStoredSecret(meta['refresh_token']);

      if (!refreshToken) {
        throw new InternalServerErrorException(
          `No refresh token stored — re-authorize the ${providerName} connection`,
        );
      }

      const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: process.env.GOOGLE_CLIENT_ID ?? '',
          client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        }).toString(),
      });

      if (!refreshRes.ok) {
        throw new InternalServerErrorException(
          `Token refresh failed — the ${providerName} connection must be re-authorized`,
        );
      }

      const refreshData = (await refreshRes.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (!refreshData.access_token) {
        throw new InternalServerErrorException(
          `Token refresh failed — the ${providerName} connection must be re-authorized`,
        );
      }

      accessToken = refreshData.access_token;

      // Persist new encrypted token to DB
      const enc = encryptApiKey(accessToken);
      await this.db
        .from('automation_connections')
        .update({
          encrypted_secret: enc.encrypted,
          encryption_iv: enc.iv,
          encryption_tag: enc.tag,
          updated_at: new Date().toISOString(),
        })
        .eq('id', connectionId);

      // Update token_expires_at in metadata
      if (refreshData.expires_in) {
        const newExpiresAt = new Date(
          Date.now() + refreshData.expires_in * 1000,
        ).toISOString();
        const existingMeta = (conn.metadata as Record<string, unknown>) ?? {};
        await this.db
          .from('automation_connections')
          .update({
            metadata: { ...existingMeta, token_expires_at: newExpiresAt },
            updated_at: new Date().toISOString(),
          })
          .eq('id', connectionId);
      }
    }

    return accessToken;
  }

  async createOAuthState(params: {
    stateToken: string;
    userId: string;
    spaceId: string;
    organizationId: string;
    provider: string;
    returnTo: string;
    appOrigin: string | null;
  }): Promise<void> {
    const { error } = await this.db.from('automation_oauth_states').insert({
      state_token: params.stateToken,
      user_id: params.userId,
      space_id: params.spaceId,
      organization_id: params.organizationId,
      provider: params.provider,
      return_to: params.returnTo,
      app_origin: params.appOrigin,
    });

    if (error) {
      this.logger.error(`createOAuthState failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to create OAuth state');
    }
  }

  async consumeOAuthState(stateToken: string): Promise<{
    id: string;
    provider: string;
    space_id: string;
    organization_id: string;
    user_id: string;
    expires_at: string;
    consumed_at: string | null;
    return_to: string | null;
    app_origin: string | null;
  } | null> {
    const stateResult = await this.db
      .from('automation_oauth_states')
      .select('*')
      .eq('state_token', stateToken)
      .maybeSingle();

    return stateResult.data as {
      id: string;
      provider: string;
      space_id: string;
      organization_id: string;
      user_id: string;
      expires_at: string;
      consumed_at: string | null;
      return_to: string | null;
      app_origin: string | null;
    } | null;
  }

  async upsertOAuthConnection(params: {
    stateId: string;
    organizationId: string;
    spaceId: string;
    provider: string;
    displayName: string;
    externalAccountId: string | null;
    secret: string;
    metadata: Record<string, unknown>;
    createdBy: string;
  }): Promise<void> {
    await this.db
      .from('automation_oauth_states')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', params.stateId);

    const enc = encryptApiKey(params.secret);

    const { error } = await this.db.from('automation_connections').upsert(
      {
        organization_id: params.organizationId,
        space_id: params.spaceId,
        provider: params.provider,
        display_name: params.displayName,
        external_account_id: params.externalAccountId,
        encrypted_secret: enc.encrypted,
        encryption_iv: enc.iv,
        encryption_tag: enc.tag,
        metadata: {
          ...params.metadata,
          // Real "reconnect by" deadline (refresh-token lifetime), set once at connect. Providers don't
          // return it, so it's computed per policy; keep any value the caller already supplied.
          refresh_token_expires_at:
            params.metadata['refresh_token_expires_at'] ??
            computeRefreshExpiryFromNow(params.provider),
        },
        is_revoked: false,
        created_by: params.createdBy,
      },
      { onConflict: 'space_id,provider,external_account_id' },
    );

    if (error) {
      this.logger.error(`upsertOAuthConnection failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to save OAuth connection');
    }
  }

  async getMicrosoftAccessToken(
    connectionId: string,
    provider: 'teams' | 'outlook' = 'outlook',
  ): Promise<string> {
    const label =
      provider === 'teams' ? 'Microsoft Teams' : 'Microsoft Outlook';

    const { data: conn, error } = await this.db
      .from('automation_connections')
      .select(
        'encrypted_secret, encryption_iv, encryption_tag, is_revoked, metadata',
      )
      .eq('id', connectionId)
      .maybeSingle();

    if (error || !conn) {
      throw new NotFoundException('Automation connection not found');
    }
    if (conn.is_revoked) {
      throw new NotFoundException('Connection has been revoked');
    }

    const meta = (conn.metadata as Record<string, string | null>) ?? {};
    const expiresAt = meta['token_expires_at']
      ? new Date(meta['token_expires_at'])
      : null;

    // Refresh if expired or expiring within 60 seconds
    const isExpired = !expiresAt || expiresAt <= new Date(Date.now() + 60_000);

    let accessToken = decryptApiKey(
      conn.encrypted_secret as string,
      conn.encryption_iv as string,
      conn.encryption_tag as string,
    );

    if (isExpired) {
      const refreshToken = unpackStoredSecret(meta['refresh_token']);

      if (!refreshToken) {
        throw new InternalServerErrorException(
          `No refresh token stored — re-authorize the ${label} connection`,
        );
      }

      const tenantId = process.env.AZURE_TENANT_ID ?? 'common';
      const refreshRes = await fetch(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: process.env.AZURE_CLIENT_ID ?? '',
            client_secret: process.env.AZURE_CLIENT_SECRET ?? '',
          }),
        },
      );

      if (!refreshRes.ok) {
        throw new InternalServerErrorException(
          `Token refresh failed — re-authorize the ${label} connection`,
        );
      }

      const refreshData = (await refreshRes.json()) as {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
      };

      if (!refreshData.access_token) {
        throw new InternalServerErrorException(
          `Token refresh failed — re-authorize the ${label} connection`,
        );
      }

      accessToken = refreshData.access_token;

      const enc = encryptApiKey(accessToken);
      const newExpiresAt = refreshData.expires_in
        ? new Date(Date.now() + refreshData.expires_in * 1000).toISOString()
        : null;

      // Microsoft ROTATES the refresh token on every refresh — persist the new one, else the connection
      // dies once the current refresh token's window ends. Slide the refresh-token deadline forward too.
      const rotatedRefreshToken = refreshData.refresh_token
        ? packSecretForStorage(refreshData.refresh_token)
        : meta['refresh_token'];

      await this.db
        .from('automation_connections')
        .update({
          encrypted_secret: enc.encrypted,
          encryption_iv: enc.iv,
          encryption_tag: enc.tag,
          metadata: {
            ...meta,
            token_expires_at: newExpiresAt,
            refresh_token: rotatedRefreshToken,
            refresh_token_expires_at: computeRefreshExpiryFromNow(provider),
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', connectionId);
    }

    void Promise.resolve(
      this.db
        .from('automation_connections')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', connectionId),
    ).catch(() => {});

    return accessToken;
  }
}
