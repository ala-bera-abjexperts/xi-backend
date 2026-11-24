/**
 * @fileoverview Decides whether a request may reach an organization that has
 * Require SSO switched on. Backs the global {@link SsoEnforcementGuard} and the
 * `ssoRequired` slice of `GET /auth/bootstrap`.
 * @module src/auth/sso-enforcement.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { SUPER_ADMIN_ROLE } from './guards/super-admin.guard';
import { getSessionAssuranceTokenPayload } from './mfa/session-assurance.util';
import type { RequestUser } from './interfaces/request-user.interface';

interface IRequireSsoCacheEntry {
  value: boolean;
  expiresAt: number;
}

/**
 * Require SSO policy. A session satisfies it only when this org's own SAML
 * connection minted it (a `sso_session_bindings` row for the JWT session_id);
 * OAuth and password logins do not.
 */
@Injectable()
export class SsoEnforcementService {
  private static readonly CACHE_TTL_MS = 30_000;

  private readonly logger = new Logger(SsoEnforcementService.name);

  // Entries expire on their own via TTL, same pattern as EntitlementsService.
  private readonly cache = new Map<string, IRequireSsoCacheEntry>();

  /**
   * @param {SupabaseAdminService} supabaseAdmin - Service-role client (RLS bypassed, so every query is org-scoped)
   */
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  /**
   * Whether the org has Require SSO switched on. Cached per org for 30s, so a
   * settings change takes up to that long to apply.
   *
   * @param {string} orgId - Organization UUID
   * @returns {Promise<boolean>} `true` when the org requires SSO
   * @throws {Error} When the settings read fails (never silently skip the gate)
   */
  async requiresSso(orgId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.cache.get(orgId);

    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('sso_organization_settings')
      .select('require_sso')
      .eq('organization_id', orgId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to read SSO settings: ${error.message}`);
    }

    const value = (data as { require_sso?: boolean } | null)?.require_sso;

    this.cache.set(orgId, {
      value: value === true,
      expiresAt: now + SsoEnforcementService.CACHE_TTL_MS,
    });

    return value === true;
  }

  /**
   * The org's oldest enabled connection, used as the SSO login target.
   *
   * @param {string} orgId - Organization UUID
   * @returns {Promise<string | null>} Connection id, or null when none is enabled
   */
  async firstEnabledConnectionId(orgId: string): Promise<string | null> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('sso_connections')
      .select('id')
      .eq('organization_id', orgId)
      .eq('is_enabled', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) {
      this.logger.warn(`SSO connection lookup failed: ${error.message}`);
      return null;
    }

    return (data as { id?: string } | null)?.id ?? null;
  }

  /**
   * Whether this GoTrue session was created through the org's SSO for this
   * auth user. Never cached: a sign-out or expiry must apply immediately.
   *
   * @param {string} sessionId - JWT `session_id`
   * @param {string} orgId - Organization UUID
   * @param {string} authUserId - `auth.users.id` of the caller
   * @returns {Promise<boolean>} `true` when an unexpired binding exists
   */
  async hasBinding(
    sessionId: string,
    orgId: string,
    authUserId: string,
  ): Promise<boolean> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('sso_session_bindings')
      .select('session_id')
      .eq('session_id', sessionId)
      .eq('organization_id', orgId)
      .eq('auth_user_id', authUserId)
      .gt('expires_at', new Date().toISOString())
      .limit(1);

    if (error) {
      this.logger.warn(`SSO binding lookup failed: ${error.message}`);
      return false;
    }

    return Array.isArray(data) && data.length > 0;
  }

  /**
   * Applies the Require SSO rules to a request.
   *
   * @param {RequestUser} user - The authenticated caller
   * @param {string | null} token - The access token SupabaseAuthGuard verified
   * @param {{ isMcpS2s: boolean }} opts - Whether the request is MCP service-to-service
   * @returns {Promise<{ connectionId: string } | null>} null when allowed, otherwise the SSO login target
   */
  async evaluate(
    user: RequestUser | null | undefined,
    token: string | null,
    opts: { isMcpS2s: boolean },
  ): Promise<{ connectionId: string } | null> {
    if (!user || !user.organizationId || user.impersonation) {
      return null;
    }

    // Super-Admin detection mirrors FeatureGuard exactly.
    const metadata = user.appMetadata ?? {};
    const hasAuthClaim =
      metadata.role === SUPER_ADMIN_ROLE || metadata.is_super_admin === true;
    const isSuperAdmin =
      hasAuthClaim && user.role === SUPER_ADMIN_ROLE && user.isActive !== false;

    if (isSuperAdmin) {
      return null;
    }

    const orgId = user.organizationId;
    const role = user.memberships?.find(
      (m) => m.organizationId === orgId,
    )?.role;

    if (role === 'owner' || role === 'admin') {
      return null;
    }

    if (!(await this.requiresSso(orgId))) {
      return null;
    }

    if (!opts.isMcpS2s && token) {
      const sessionId = getSessionAssuranceTokenPayload(token)?.session_id;

      if (
        typeof sessionId === 'string' &&
        (await this.hasBinding(sessionId, orgId, user.authUserId))
      ) {
        return null;
      }
    }

    return { connectionId: (await this.firstEnabledConnectionId(orgId)) ?? '' };
  }
}
