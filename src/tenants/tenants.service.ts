/**
 * @fileoverview Service backing the `/tenants/*` endpoints introduced in
 * Prompt 03 of the multi-tenant migration. Implements:
 *
 *   - listForUser(userId)            -> every membership the caller has
 *   - resolveSlugForUser(slug, uid)  -> slug lookup with membership gate
 *   - findByIdForUser(orgId, uid)    -> id lookup with membership gate
 *   - switchActive(user, body, ...)  -> XOR-validated tenant switch with
 *                                       signed cookie write + audit trail
 *
 * The membership table (`organization_members`) is the single source of
 * truth for tenancy after Prompt 01 dropped `users.organization_id`. Cookie
 * writes go through {@link setActiveOrgCookie} so the value is HMAC-signed
 * with the same secret the {@link SupabaseAuthGuard} verifies on the next
 * request (see {@link RequestUser} resolution in Prompt 02).
 *
 * @module src/tenants/tenants.service
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { ImpersonationService } from '../impersonation/impersonation.service';
import { readCookieConfig, setActiveOrgCookie } from '../auth/cookies.util';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SwitchTenantDto } from './dto/switch-tenant.dto';
import { TenantSummaryDto } from './dto/tenant-summary.dto';

/**
 * Shape of a single row returned by the membership-list query.
 * Supabase typing returns one-to-one joins as either an object or an array
 * depending on the foreign-key cardinality declaration, so the join fields
 * are typed as both for runtime safety.
 * @private
 */
type MembershipJoinRow = {
  role: 'owner' | 'admin' | 'member' | 'viewer';
  created_at: string;
  organization:
    | {
        id: string;
        name: string;
        slug: string;
        branding:
          | { logo_light_url: string | null; primary_color: string | null }
          | { logo_light_url: string | null; primary_color: string | null }[]
          | null;
      }
    | {
        id: string;
        name: string;
        slug: string;
        branding:
          | { logo_light_url: string | null; primary_color: string | null }
          | { logo_light_url: string | null; primary_color: string | null }[]
          | null;
      }[]
    | null;
};

/** Slug allowlist re-checked at service entry (DTO-level @Matches is bypassable in tests). */
const SLUG_REGEX = /^[a-z0-9-]+$/;

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly configService: ConfigService,
    private readonly impersonationService: ImpersonationService,
  ) {}

  /** @private Supabase admin client shortcut. */
  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Returns every organization the user is a member of, oldest membership
   * first, with denormalised branding fields for the switcher chip.
   *
   * Single JOIN query — no N+1. Member counts are intentionally omitted
   * here; the DTO marks `memberCount` optional and a separate aggregation
   * endpoint can populate it later if the switcher needs it.
   */
  async listForUser(userId: string): Promise<TenantSummaryDto[]> {
    const { data, error } = await this.client
      .from('organization_members')
      .select(
        `
          role,
          created_at,
          organization:organizations (
            id,
            name,
            slug,
            is_active,
            branding:organization_branding ( logo_light_url, primary_color )
          )
        `,
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) {
      this.logger.error(`listForUser failed: ${error.message}`);
      throw new InternalServerErrorException('Failed to list tenants for user');
    }

    return ((data ?? []) as unknown as MembershipJoinRow[]).flatMap((row) => {
      const org = Array.isArray(row.organization)
        ? row.organization[0]
        : row.organization;
      if (!org) return [];
      // Deactivated orgs are never offered in the tenant switcher — a user
      // must not be able to switch into an org an admin has turned off.
      if ((org as { is_active?: boolean | null }).is_active === false)
        return [];
      const branding = Array.isArray(org.branding)
        ? org.branding[0]
        : org.branding;
      return [
        this.toSummary({
          organizationId: org.id,
          slug: org.slug,
          name: org.name,
          role: row.role,
          joinedAt: row.created_at,
          iconUrl: branding?.logo_light_url ?? null,
          primaryColor: branding?.primary_color ?? null,
        }),
      ];
    });
  }

  /**
   * Resolves a slug to a tenant for the given user.
   *
   *   - 404 when the slug does not match any organization.
   *   - 403 with a structured `NOT_A_MEMBER` body when the org exists but the
   *     caller has no membership row. The frontend uses this to distinguish
   *     "Not found" vs "Request access" UI states.
   */
  async resolveSlugForUser(
    slug: string,
    userId: string,
  ): Promise<TenantSummaryDto> {
    if (!SLUG_REGEX.test(slug)) {
      // Defence-in-depth — controller DTO already validates the path param
      // but direct service calls (tests, internal callers) bypass that.
      throw new BadRequestException('Invalid slug');
    }

    const orgResult = await this.client
      .from('organizations')
      .select('id, name, slug, is_active')
      .eq('slug', slug)
      .maybeSingle();

    if (orgResult.error) {
      this.logger.error(
        `resolveSlugForUser org lookup failed: ${orgResult.error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to resolve organization slug',
      );
    }

    const org = orgResult.data;

    if (!org) {
      throw new NotFoundException(`No organization with slug "${slug}"`);
    }

    this.assertOrgActive(org);

    return this.fetchMembershipOrThrow(org.id, org.name, org.slug, userId);
  }

  /**
   * Symmetric to {@link resolveSlugForUser} but keyed by organization UUID.
   * Same 404/403 semantics so the switcher can use either form.
   */
  async findByIdForUser(
    orgId: string,
    userId: string,
  ): Promise<TenantSummaryDto> {
    const orgResult = await this.client
      .from('organizations')
      .select('id, name, slug, is_active')
      .eq('id', orgId)
      .maybeSingle();

    if (orgResult.error) {
      this.logger.error(
        `findByIdForUser org lookup failed: ${orgResult.error.message}`,
      );
      throw new InternalServerErrorException('Failed to resolve organization');
    }

    const org = orgResult.data;

    if (!org) {
      throw new NotFoundException(`No organization with id "${orgId}"`);
    }

    this.assertOrgActive(org);

    return this.fetchMembershipOrThrow(org.id, org.name, org.slug, userId);
  }

  /**
   * Switches the caller's active tenant.
   *
   * Order of operations:
   *   1. XOR validation on the body — exactly one of `organizationId` /
   *      `slug` must be provided.
   *   2. Resolve target via the corresponding lookup. The lookup is the
   *      membership gate: it throws 403 NOT_A_MEMBER when the user isn't a
   *      member of the target, so we never reach the cookie write in that
   *      case.
   *   3. No-op when the target equals the currently active tenant — avoids
   *      audit-table churn on defensive client retries.
   *   4. Best-effort write to `tenant_switch_audit`. Audit failures are
   *      logged and swallowed so they cannot block the switch itself.
   *   5. Write the signed `active_org_id` cookie. The cookie value is
   *      HMAC-verified by the auth guard on the next request.
   */
  async switchActive(
    user: RequestUser,
    body: SwitchTenantDto,
    req: Request,
    res: Response,
  ): Promise<TenantSummaryDto> {
    // M5: enforce XOR by FIELD PRESENCE, not truthiness. An empty string
    // is "provided but invalid" — we want to reject it as ambiguous rather
    // than silently treat it as absent. Two cases that the old length-based
    // check let through:
    //   1. { organizationId: "", slug: "acme" } → hasId=false, hasSlug=true,
    //      old code accepted and used slug. New code rejects as both-present.
    //   2. { organizationId: "" } → hasId=false, hasSlug=false, both old and
    //      new code reject — same outcome.
    const hasIdField =
      Object.prototype.hasOwnProperty.call(body, 'organizationId') &&
      body.organizationId !== undefined;
    const hasSlugField =
      Object.prototype.hasOwnProperty.call(body, 'slug') &&
      body.slug !== undefined;

    if (hasIdField === hasSlugField) {
      throw new BadRequestException(
        'Provide exactly one of organizationId or slug',
      );
    }

    // After the XOR check, also reject empty strings — they passed XOR
    // (only one field present) but cannot resolve to a real org.
    if (hasIdField) {
      if (
        typeof body.organizationId !== 'string' ||
        body.organizationId.length === 0
      ) {
        throw new BadRequestException(
          'organizationId must be a non-empty string',
        );
      }
    } else {
      if (typeof body.slug !== 'string' || body.slug.length === 0) {
        throw new BadRequestException('slug must be a non-empty string');
      }
    }

    // Switching tenants ends any active impersonation overlay — the SA is
    // leaving the impersonated context, so the read-only/blocked overlay must
    // not leak into the new tenant. Best-effort only: a stop failure is logged
    // and never blocks or fails the switch itself.
    if (user.impersonation) {
      try {
        await this.impersonationService.stopActiveForSuperAdmin(
          user.impersonation.realUserId,
          'switched',
        );
      } catch (err) {
        this.logger.warn(
          `Failed to stop active impersonation on tenant switch (suppressed): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const target = hasIdField
      ? await this.findByIdForUser(body.organizationId!, user.userId)
      : await this.resolveSlugForUser(body.slug!, user.userId);

    // No-op when the user is "switching" to their current tenant.
    if (target.organizationId === user.organizationId) {
      return target;
    }

    // Audit trail — best effort. We never let an audit insert failure mask
    // the actual switch; the user-facing operation succeeds and the failure
    // is logged for ops to investigate.
    try {
      const { error } = await this.client.from('tenant_switch_audit').insert({
        user_id: user.userId,
        from_organization_id: user.organizationId || null,
        to_organization_id: target.organizationId,
        ip_address: req.ip ?? null,
        user_agent: req.headers['user-agent'] ?? null,
      });
      if (error) {
        this.logger.warn(
          `tenant_switch_audit insert returned error (suppressed): ${error.message}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `tenant_switch_audit insert threw (suppressed): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const cfg = readCookieConfig(this.configService);
    setActiveOrgCookie(res, target.organizationId, cfg);

    return target;
  }

  /**
   * Rejects resolution of a deactivated organization. A user must never be
   * able to switch into / land on an org an admin has turned off. Thrown as
   * 403 with a structured `ORG_DEACTIVATED` code so the frontend can show a
   * specific message rather than a generic "not a member" / "not found".
   * @private
   */
  private assertOrgActive(org: {
    id: string;
    name: string;
    is_active: boolean | null;
  }): void {
    if (org.is_active === false) {
      throw new ForbiddenException({
        code: 'ORG_DEACTIVATED',
        message: `"${org.name}" has been deactivated`,
        organizationId: org.id,
        organizationName: org.name,
      });
    }
  }

  /**
   * Shared "fetch membership row, build summary OR throw NOT_A_MEMBER"
   * helper used by both lookup methods.
   * @private
   */
  private async fetchMembershipOrThrow(
    orgId: string,
    orgName: string,
    orgSlug: string,
    userId: string,
  ): Promise<TenantSummaryDto> {
    const membershipResult = await this.client
      .from('organization_members')
      .select('role, created_at')
      .eq('organization_id', orgId)
      .eq('user_id', userId)
      .maybeSingle();

    if (membershipResult.error) {
      this.logger.error(
        `fetchMembershipOrThrow failed: ${membershipResult.error.message}`,
      );
      throw new InternalServerErrorException(
        'Failed to verify tenant membership',
      );
    }

    const membership = membershipResult.data;

    if (!membership) {
      // 403 (not 404) so the frontend can show "Request access" instead of
      // "Not found" — the org exists, the user just isn't in it.
      throw new ForbiddenException({
        code: 'NOT_A_MEMBER',
        message: `You are not a member of "${orgName}"`,
        organizationId: orgId,
        organizationName: orgName,
      });
    }

    const brandingResult = await this.client
      .from('organization_branding')
      .select('logo_light_url, primary_color')
      .eq('organization_id', orgId)
      .maybeSingle();

    const branding = brandingResult.data;

    return this.toSummary({
      organizationId: orgId,
      slug: orgSlug,
      name: orgName,
      role: membership.role,
      joinedAt: membership.created_at,
      iconUrl: branding?.logo_light_url ?? null,
      primaryColor: branding?.primary_color ?? null,
    });
  }

  /** @private Single mapping site so all three read paths produce identical shapes. */
  private toSummary(input: TenantSummaryDto): TenantSummaryDto {
    return {
      organizationId: input.organizationId,
      slug: input.slug,
      name: input.name,
      role: input.role,
      joinedAt: input.joinedAt,
      iconUrl: input.iconUrl ?? null,
      primaryColor: input.primaryColor ?? null,
    };
  }
}
