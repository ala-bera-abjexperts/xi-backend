import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { SsoEnforcementService } from '../../auth/sso-enforcement.service';
import {
  issueTmAccessToken,
  tmAccessTokenHash,
  TM_ACCESS_TOKEN_TTL_SECONDS,
} from '../../auth/tm-access-token';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  TM_API_KEY_LIMITS,
  type AuthenticateTestManagementApiKeyDto,
  type CreateTestManagementApiKeyDto,
  type TestManagementAccessToken,
  type TestManagementApiKey,
  type TestManagementApiKeyOwner,
} from '../dto/test-management-api-key.dto';
import { notFound, tmDbError } from '../test-management-errors';

const TABLE = 'test_management_api_keys';
const TOKEN_TABLE = 'test_management_api_tokens';
const TOKEN_PREFIX = 'xis_tm_';
const DAY_MS = 24 * 60 * 60 * 1000;
// Keeps a 365-day key inside the database CHECK when this server's clock runs slightly ahead.
const CLOCK_MARGIN_MS = 60 * 1000;

// Never token_hash: the list and create responses must not leak it.
const KEY_COLUMNS =
  'id, user_id, name, token_prefix, created_at, expires_at, last_used_at';

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

interface UserRow {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
}

function toApiKey(
  row: ApiKeyRow,
  owner?: TestManagementApiKeyOwner,
): TestManagementApiKey {
  return {
    id: row.id,
    name: row.name,
    token_prefix: row.token_prefix,
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    expired:
      row.expires_at !== null &&
      new Date(row.expires_at).getTime() <= Date.now(),
    ...(owner && { owner }),
  };
}

/** The expiry date of a new key, or null when it never expires; one kind of choice per request. */
function keyExpiry(
  user: RequestUser,
  dto: CreateTestManagementApiKeyDto,
  now: number,
): string | null {
  const custom =
    dto.expires_in_amount !== undefined || dto.expires_in_unit !== undefined;
  const choices = [
    dto.expires_in_days !== undefined,
    custom,
    dto.never_expires === true,
  ];

  if (choices.filter(Boolean).length > 1) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'Choose one expiry: a preset, a custom length or no expiry',
    });
  }

  if (dto.never_expires === true) {
    if (!isManager(user)) {
      throw new ForbiddenException({
        code: 'NO_EXPIRY_NOT_ALLOWED',
        message: 'Only owners and admins can create keys that never expire',
      });
    }

    return null;
  }

  if (custom) {
    if (dto.expires_in_amount === undefined || !dto.expires_in_unit) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'A custom expiry needs both an amount and a unit',
      });
    }

    // Months and years follow the calendar, so 3 months from 29 October is 29 January.
    const date = new Date(now);

    if (dto.expires_in_unit === 'days')
      date.setUTCDate(date.getUTCDate() + dto.expires_in_amount);
    if (dto.expires_in_unit === 'months')
      date.setUTCMonth(date.getUTCMonth() + dto.expires_in_amount);
    if (dto.expires_in_unit === 'years')
      date.setUTCFullYear(date.getUTCFullYear() + dto.expires_in_amount);

    return new Date(date.getTime() - CLOCK_MARGIN_MS).toISOString();
  }

  const days = dto.expires_in_days ?? TM_API_KEY_LIMITS.defaultDays;

  return new Date(now + days * DAY_MS - CLOCK_MARGIN_MS).toISOString();
}

function isManager(user: RequestUser): boolean {
  const role = user.memberships.find(
    (m) => m.organizationId === user.organizationId,
  )?.role;

  return role === 'owner' || role === 'admin';
}

function assertNotImpersonating(user: RequestUser): void {
  if (user.impersonation) {
    throw new ForbiddenException({
      code: 'IMPERSONATION_BLOCKED',
      message:
        'This action is not available during impersonation. Exit impersonation and try again as yourself.',
    });
  }
}

/** Self-service Test Management API keys; only a sha256 hash of each token is stored. */
@Injectable()
export class TestManagementApiKeysService {
  private readonly logger = new Logger(TestManagementApiKeysService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly auditLogs: AuditLogsService,
    private readonly sso: SsoEnforcementService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Exchanges a key's id and the key itself for a short-lived, encrypted access token; only the token's hash
   * is stored. Every failure gives the same answer, so it never tells which part was wrong; the user,
   * membership and organization are checked again on each request made with the token.
   */
  async authenticate(
    dto: AuthenticateTestManagementApiKeyDto,
  ): Promise<TestManagementAccessToken> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('id, organization_id, token_hash, expires_at')
      .eq('id', dto.client_id)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'load the API key', error);

    const key = data as {
      id: string;
      organization_id: string;
      token_hash: string;
      expires_at: string | null;
    } | null;
    const given = Buffer.from(
      createHash('sha256').update(dto.client_secret).digest('hex'),
    );
    // A key without an expiry date never expires.
    const keyExpires = !key
      ? 0
      : key.expires_at === null
        ? Number.POSITIVE_INFINITY
        : new Date(key.expires_at).getTime();

    if (
      !key ||
      given.length !== Buffer.byteLength(key.token_hash) ||
      !timingSafeEqual(given, Buffer.from(key.token_hash)) ||
      keyExpires <= Date.now()
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_CLIENT',
        message: 'Invalid client credentials',
      });
    }

    // Never valid past the key itself.
    const expires = Math.floor(
      Math.min(Date.now() + TM_ACCESS_TOKEN_TTL_SECONDS * 1000, keyExpires) /
        1000,
    );
    let token: string;

    try {
      token = issueTmAccessToken(key.id, expires);
    } catch {
      this.logger.error('Access token encryption is not configured');
      throw new ServiceUnavailableException({
        code: 'TOKENS_NOT_CONFIGURED',
        message: 'Access tokens are not configured',
      });
    }

    // Expired tokens of this key are cleared so the table stays small; a failure here is harmless.
    const cleared = await this.client
      .from(TOKEN_TABLE)
      .delete()
      .eq('key_id', key.id)
      .lt('expires_at', new Date().toISOString());

    if (cleared.error) {
      this.logger.warn(
        `Clearing expired tokens of API key ${key.id} failed: ${cleared.error.message}`,
      );
    }

    const saved = await this.client.from(TOKEN_TABLE).insert({
      organization_id: key.organization_id,
      key_id: key.id,
      token_hash: tmAccessTokenHash(token),
      expires_at: new Date(expires * 1000).toISOString(),
    });

    if (saved.error) {
      this.logger.error(
        `Saving an access token failed: ${saved.error.message}`,
      );
      throw new ServiceUnavailableException({
        code: 'TOKEN_NOT_SAVED',
        message: 'The access token could not be issued',
      });
    }

    void this.auditLogs.logSystemAction(
      key.organization_id,
      'test_management_api_key',
      key.id,
      'update',
      {
        action: 'token_issued',
        expires_at: new Date(expires * 1000).toISOString(),
      },
    );

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: Math.max(0, expires - Math.floor(Date.now() / 1000)),
      expires_at: new Date(expires * 1000).toISOString(),
    };
  }

  /** The caller's keys, or every key of the org with its owner when `all` is set (owners and admins only). */
  async list(user: RequestUser, all: boolean): Promise<TestManagementApiKey[]> {
    if (all && !isManager(user)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Only owners and admins can see every API key',
      });
    }

    let query = this.client
      .from(TABLE)
      .select(KEY_COLUMNS)
      .eq('organization_id', user.organizationId);

    if (!all) query = query.eq('user_id', user.userId);

    const { data, error } = await query.order('created_at', {
      ascending: false,
    });

    if (error) throw tmDbError(this.logger, 'list API keys', error);

    const rows = (data ?? []) as unknown as ApiKeyRow[];

    if (!all) return rows.map((row) => toApiKey(row));

    const owners = await this.loadOwners([
      ...new Set(rows.map((row) => row.user_id)),
    ]);

    return rows.map((row) => toApiKey(row, owners.get(row.user_id)));
  }

  /** Creates a key; the plaintext token is returned here once and never stored or logged. */
  async create(
    user: RequestUser,
    dto: CreateTestManagementApiKeyDto,
  ): Promise<{ token: string; api_key: TestManagementApiKey }> {
    assertNotImpersonating(user);

    const orgId = user.organizationId;

    // Under Require SSO a member key would be a way around the SSO login.
    if (!isManager(user) && (await this.sso.requiresSso(orgId))) {
      throw new ForbiddenException({
        code: 'SSO_REQUIRED_KEYS',
        message:
          'This workspace requires single sign-on, so only owners and admins can create API keys',
      });
    }

    const now = Date.now();
    const active = await this.client
      .from(TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('user_id', user.userId)
      .or(`expires_at.is.null,expires_at.gt.${new Date(now).toISOString()}`);

    if (active.error)
      throw tmDbError(this.logger, 'count API keys', active.error);

    // Two requests at once can pass the count together; the limit is a guard rail, not a hard quota.
    if ((active.count ?? 0) >= TM_API_KEY_LIMITS.maxActivePerUser) {
      throw new ConflictException({
        code: 'API_KEY_LIMIT',
        message: `You can have at most ${TM_API_KEY_LIMITS.maxActivePerUser} active API keys. Revoke one first.`,
      });
    }

    const expiresAt = keyExpiry(user, dto, now);
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const tokenPrefix = token.slice(0, TOKEN_PREFIX.length + 4);
    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: orgId,
        user_id: user.userId,
        name: dto.name,
        token_prefix: tokenPrefix,
        token_hash: createHash('sha256').update(token).digest('hex'),
        expires_at: expiresAt,
      })
      .select(KEY_COLUMNS)
      .single();

    if (error) throw tmDbError(this.logger, 'create the API key', error);

    const row = data as unknown as ApiKeyRow;

    await this.auditLogs.logSystemAction(
      orgId,
      'test_management_api_key',
      row.id,
      'create',
      {
        actor_user_id: user.userId,
        name: row.name,
        token_prefix: row.token_prefix,
        expires_at: row.expires_at,
      },
    );

    return { token, api_key: toApiKey(row) };
  }

  /** Deletes a key; another person's key is only reachable for owners and admins, otherwise 404. */
  async revoke(user: RequestUser, keyId: string): Promise<{ id: string }> {
    assertNotImpersonating(user);

    const orgId = user.organizationId;
    const { data, error } = await this.client
      .from(TABLE)
      .select('id, user_id, name, token_prefix')
      .eq('id', keyId)
      .eq('organization_id', orgId)
      .maybeSingle();

    if (error) throw tmDbError(this.logger, 'read the API key', error);

    const row = data as Pick<
      ApiKeyRow,
      'id' | 'user_id' | 'name' | 'token_prefix'
    > | null;

    if (!row || (row.user_id !== user.userId && !isManager(user))) {
      throw notFound();
    }

    const deleted = await this.client
      .from(TABLE)
      .delete()
      .eq('id', keyId)
      .eq('organization_id', orgId);

    if (deleted.error) {
      throw tmDbError(this.logger, 'revoke the API key', deleted.error);
    }

    await this.auditLogs.logSystemAction(
      orgId,
      'test_management_api_key',
      keyId,
      'delete',
      {
        actor_user_id: user.userId,
        name: row.name,
        token_prefix: row.token_prefix,
        key_owner_id: row.user_id,
      },
    );

    return { id: keyId };
  }

  // The table has no FK to users, so owners are read separately.
  private async loadOwners(
    ids: string[],
  ): Promise<Map<string, TestManagementApiKeyOwner>> {
    const owners = new Map<string, TestManagementApiKeyOwner>();

    if (!ids.length) return owners;

    const { data, error } = await this.client
      .from('users')
      .select('id, email, first_name, last_name')
      .in('id', ids);

    if (error) throw tmDbError(this.logger, 'load API key owners', error);

    for (const owner of (data ?? []) as unknown as UserRow[]) {
      const name = [owner.first_name, owner.last_name]
        .filter(Boolean)
        .join(' ')
        .trim();

      owners.set(owner.id, {
        id: owner.id,
        email: owner.email,
        name: name || null,
      });
    }

    return owners;
  }
}
