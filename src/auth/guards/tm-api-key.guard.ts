/**
 * @fileoverview Authenticates `Authorization: Bearer xis_tm_…` Test Management
 * API keys on routes marked with {@link AllowTestManagementApiKey}. Runs after
 * McpServiceTokenGuard and before SupabaseAuthGuard; any other request passes
 * through untouched.
 * @module src/auth/guards/tm-api-key.guard
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'crypto';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_TM_API_KEY } from '../decorators/allow-test-management-api-key.decorator';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  isTmAccessToken,
  readTmAccessToken,
  tmAccessTokenHash,
} from '../tm-access-token';
import type {
  RequestUser,
  RequestUserMembership,
} from '../interfaces/request-user.interface';

const TM_KEY_PREFIX = 'xis_tm_';
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;
const LAST_USED_REFRESH_MS = 5 * 60 * 1000;
const MEMBER_ROLES: RequestUserMembership['role'][] = [
  'owner',
  'admin',
  'member',
  'viewer',
];

interface ApiKeyRow {
  id: string;
  organization_id: string;
  user_id: string;
  expires_at: string | null;
  last_used_at: string | null;
}

interface UserRow {
  id: string;
  auth_user_id: string | null;
  email: string | null;
  role: string | null;
  is_active: boolean | null;
}

interface MemberRow {
  role: string;
}

interface OrgRow {
  id: string;
  slug: string | null;
  is_active: boolean | null;
}

type TmApiKeyRequest = Request & {
  user?: RequestUser;
  _mcpS2s?: boolean;
  _tmApiKey?: boolean;
  _orgSource?: string;
};

/**
 * Turns a valid Test Management API key into the owner's RequestUser, scoped to
 * the key's single organization.
 */
@Injectable()
export class TmApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(TmApiKeyGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  /**
   * @param {ExecutionContext} context - The current request context
   * @returns {Promise<boolean>} True when the request has no key or a valid key
   * @throws {UnauthorizedException} When a key is sent where it is not allowed or is invalid
   * @throws {ServiceUnavailableException} When the key cannot be checked against the database
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TmApiKeyRequest>();
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' ? BEARER_PATTERN.exec(header)?.[1] : undefined;

    if (!token?.startsWith(TM_KEY_PREFIX)) {
      return true;
    }

    const targets = [context.getHandler(), context.getClass()];

    // Public routes ignore app keys, so there is nothing to verify.
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    if (request._mcpS2s === true) {
      throw new UnauthorizedException('Conflicting credentials');
    }

    if (!this.reflector.getAllAndOverride<boolean>(ALLOW_TM_API_KEY, targets)) {
      throw new UnauthorizedException(
        'API keys are not accepted on this route',
      );
    }

    const key = await this.findKey(token);
    const [user, member, org] = await Promise.all([
      this.selectOne<UserRow>(
        key.id,
        'users',
        'id, auth_user_id, email, role, is_active',
        { id: key.user_id },
      ),
      this.selectOne<MemberRow>(key.id, 'organization_members', 'role', {
        organization_id: key.organization_id,
        user_id: key.user_id,
      }),
      this.selectOne<OrgRow>(key.id, 'organizations', 'id, slug, is_active', {
        id: key.organization_id,
      }),
    ]);
    const role = member?.role as RequestUserMembership['role'] | undefined;

    if (
      !user ||
      user.is_active === false ||
      !user.auth_user_id ||
      !role ||
      !MEMBER_ROLES.includes(role) ||
      org?.is_active !== true
    ) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Only the key's org and no auth app_metadata, so no super-admin bypass.
    request.user = {
      authUserId: user.auth_user_id,
      userId: user.id,
      email: user.email || '',
      organizationId: key.organization_id,
      memberships: [
        {
          organizationId: key.organization_id,
          organizationSlug: org.slug ?? '',
          role,
        },
      ],
      role: user.role,
      isActive: user.is_active,
      appMetadata: { tm_api_key_id: key.id },
    };
    request._tmApiKey = true;
    request._orgSource = 'tm_api_key';

    this.touchLastUsed(key);

    return true;
  }

  // Looks the key up by its sha256 hash; the raw token never leaves this method.
  private async findKey(token: string): Promise<ApiKeyRow> {
    const keyId = isTmAccessToken(token)
      ? await this.accessTokenKeyId(token)
      : null;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const query = this.supabaseAdmin
      .getClient()
      .from('test_management_api_keys')
      .select('id, organization_id, user_id, expires_at, last_used_at');
    const { data, error } = await (
      keyId ? query.eq('id', keyId) : query.eq('token_hash', tokenHash)
    ).maybeSingle();

    if (error) {
      this.logger.error('API key lookup failed');
      throw new ServiceUnavailableException('Failed to verify API key');
    }

    const key = data as ApiKeyRow | null;

    // A key without an expiry date never expires.
    if (
      !key ||
      (key.expires_at !== null &&
        new Date(key.expires_at).getTime() <= Date.now())
    ) {
      throw new UnauthorizedException('Invalid API key');
    }

    return key;
  }

  // An access token from /test-management/authenticate counts only while its stored row is there and not expired.
  private async accessTokenKeyId(token: string): Promise<string> {
    const access = readTmAccessToken(token);

    if (!access || access.expires * 1000 <= Date.now()) {
      throw new UnauthorizedException('Invalid API key');
    }

    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('test_management_api_tokens')
      .select('key_id')
      .eq('token_hash', tmAccessTokenHash(token))
      .eq('key_id', access.keyId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (error) {
      this.logger.error('API token lookup failed');
      throw new ServiceUnavailableException('Failed to verify API key');
    }

    if (!data) throw new UnauthorizedException('Invalid API key');

    return access.keyId;
  }

  private async selectOne<T>(
    keyId: string,
    table: string,
    columns: string,
    match: Record<string, string>,
  ): Promise<T | null> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from(table)
      .select(columns)
      .match(match)
      .maybeSingle();

    if (error) {
      this.logger.error(
        `API key ${keyId}: ${table} lookup failed: ${error.message}`,
      );
      throw new ServiceUnavailableException('Failed to verify API key');
    }

    return data as T | null;
  }

  // Throttled so busy pipelines do not write on every request; never blocks the request.
  private touchLastUsed(key: ApiKeyRow): void {
    if (
      key.last_used_at &&
      Date.now() - new Date(key.last_used_at).getTime() < LAST_USED_REFRESH_MS
    ) {
      return;
    }

    const warn = (message: string) =>
      this.logger.warn(
        `API key ${key.id}: last_used_at update failed: ${message}`,
      );

    try {
      void this.supabaseAdmin
        .getClient()
        .from('test_management_api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', key.id)
        .then(
          ({ error }) => {
            if (error) warn(error.message);
          },
          (err: unknown) =>
            warn(err instanceof Error ? err.message : String(err)),
        );
    } catch (err) {
      warn(err instanceof Error ? err.message : String(err));
    }
  }
}
