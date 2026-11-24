/**
 * @fileoverview Global authentication guard that verifies Supabase JWT tokens on every request.
 * Supports both HS256 (hosted Supabase) and ES256 (local Supabase dev) token algorithms.
 * Attaches a {@link RequestUser} object to the request for downstream consumption.
 * @module src/auth/guards/supabase-auth.guard
 * @author Prince Jadiya
 */

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { UsersService } from '../../users/users.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { MembershipContextService } from '../services/membership-context.service';
import {
  ACTIVE_ORG_COOKIE,
  readActiveOrgCookie,
  readCookieConfig,
  readImpersonationCookie,
  readMfaPendingCookie,
} from '../cookies.util';
import { ALLOW_PENDING_MFA_KEY } from '../decorators/allow-pending-mfa.decorator';
import type { JwtPayload } from '../interfaces/jwt-payload.interface';
import type {
  ImpersonationContext,
  RequestUser,
} from '../interfaces/request-user.interface';
import {
  PASSKEY_SESSION_ASSURANCE,
  type PasskeySessionAssuranceReader,
} from '../passkeys/passkey-session-assurance.port';
import {
  deriveSessionMfaState,
  getSessionAssuranceTokenPayload,
  normalizeAuthenticationMethods,
} from '../mfa/session-assurance.util';

/**
 * Augmented Express request shape used by the guard to hand off the deferred
 * cookie write to {@link ActiveOrgCookieInterceptor}. The interceptor reads
 * `_pendingActiveOrgCookie` after the controller resolves and, if present,
 * writes the signed cookie before the response is flushed.
 *
 * `_pendingActiveOrgClear` is the inverse: the guard saw a signed cookie that
 * no longer matches a real membership and we want to evict it on this same
 * response so the next request doesn't re-trigger the same fallback.
 */
export interface RequestWithPendingCookie {
  _pendingActiveOrgCookie?: string;
  _pendingActiveOrgClear?: boolean;
}

/**
 * Columns read off `impersonation_sessions` by the Phase B overlay in
 * {@link SupabaseAuthGuard.tryApplyImpersonation}. Supabase `.maybeSingle()`
 * returns `any`, so we cast the result to this minimal shape (mirrors the
 * `(data ?? []) as unknown as Row[]` convention used elsewhere in the backend)
 * to keep all downstream member access type-safe. Phase 3's service owns the
 * canonical type; this local copy avoids importing a not-yet-existent module.
 */
interface ImpersonationSessionRow {
  id: string;
  super_admin_user_id: string;
  target_user_id: string;
  target_organization_id: string;
  target_membership_role: 'owner' | 'admin' | 'member' | 'viewer';
  write_access: boolean;
  expires_at: string;
  started_at: string;
  reason: string;
  ended_at: string | null;
}

/** Minimal `users` lookup shape read by the impersonation overlay. */
interface ImpersonationTargetUserRow {
  id: string;
  email: string;
  role: string | null;
  is_active: boolean | null;
  auth_user_id: string | null;
}

/** Minimal `organizations` lookup shape read by the impersonation overlay. */
interface ImpersonationTargetOrgRow {
  id: string;
  is_active: boolean | null;
}

/** `organizations.slug` lookup shape for the subdomain-agreement check. */
interface ImpersonationOrgSlugRow {
  slug: string | null;
}

type AuthFactor = {
  status?: string;
  factor_type?: string;
};

type AuthUserForMfa = {
  id: string;
  email?: string;
  app_metadata?: Record<string, unknown>;
  factors?: AuthFactor[];
};

/**
 * Global guard that authenticates every request by verifying the Supabase JWT access token.
 *
 * Security flow:
 * 1. Check if the route is decorated with `@Public()` -- if so, allow access immediately
 * 2. Extract the Bearer token from the `Authorization` header
 * 3. Attempt local HS256 JWT verification (fastest, no network call)
 * 4. If HS256 fails, fall back to Supabase `auth.getUser()` for ES256 tokens (local dev)
 * 5. Resolve the Supabase `auth.users.id` to the application-level `public.users.id`
 * 6. Attach a {@link RequestUser} object to `request.user`
 *
 * @example
 * // Registered as a global guard in AuthModule:
 * { provide: APP_GUARD, useClass: SupabaseAuthGuard }
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  /** @private Logger instance scoped to this guard */
  private readonly logger = new Logger(SupabaseAuthGuard.name);

  private static readonly IMPERSONATION_BYPASS_PATHS = [
    '/auth/refresh',
    '/auth/signout',
    '/admin/impersonation/',
  ];

  private static readonly IMPERSONATION_NON_TENANT_SUBDOMAINS = [
    'auth',
    'app',
    'api',
  ];

  /**
   * @param {Reflector} reflector - NestJS reflector for reading route metadata
   * @param {JwtService} jwtService - JWT service for local token verification
   * @param {ConfigService} configService - Config service for reading JWT secret
   * @param {UsersService} usersService - Service to resolve auth user ID to public user
   * @param {SupabaseAdminService} supabaseAdmin - Admin client for fallback token verification
   * @param {MembershipContextService} membershipContext - Shared membership loader (also used by the S2S guard)
   */
  constructor(
    private reflector: Reflector,
    private jwtService: JwtService,
    private configService: ConfigService,
    private usersService: UsersService,
    private supabaseAdmin: SupabaseAdminService,
    private membershipContext: MembershipContextService,
    @Optional()
    @Inject(PASSKEY_SESSION_ASSURANCE)
    private readonly passkeySessionAssurance?: PasskeySessionAssuranceReader,
  ) {}

  /**
   * Determines whether the current request is authorized.
   *
   * @param {ExecutionContext} context - The NestJS execution context
   * @returns {Promise<boolean>} `true` if the request is authorized
   * @throws {UnauthorizedException} When the token is missing, invalid, expired, or the user profile is not found
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check for @Public() decorator
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      // Attempt optional user resolution — attach RequestUser when a valid token
      // is present so public routes (e.g. listTasks with assignedToMe) can use
      // the caller's identity. Never throws; anonymous callers are unaffected.
      await this.tryAttachOptionalUser(context);

      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    // S2S pass-through: McpServiceTokenGuard runs before this guard. When it has
    // already authenticated the request (dedicated header present + verified) it
    // sets `request.user` and the `_mcpS2s` marker. Such requests carry no
    // `Authorization` header, so we must not re-run normal verification (which
    // would throw "Missing authorization token"). Normal Bearer/cookie requests
    // never carry this marker, so their path is unchanged.
    if (
      ((request as Request & { _mcpS2s?: boolean })._mcpS2s === true ||
        (request as Request & { _tmApiKey?: boolean })._tmApiKey === true) &&
      (request as Request & { user?: RequestUser }).user
    ) {
      return true;
    }

    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('Missing authorization token');
    }

    // App keys never go to the auth server; only their own guard accepts them.
    if (token.startsWith('xis_')) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    try {
      // Try local JWT verification first (HS256, fastest - no network call)
      // Falls back to Supabase auth.getUser() for ES256 tokens (local Supabase dev)
      let authUserId: string | undefined;
      let email: string | undefined;
      let appMetadata: Record<string, unknown> = {};
      let tokenAal: string | undefined;
      let authUserForMfa: AuthUserForMfa | null = null;

      const tokenAlg = this.decodeTokenAlgorithm(token);
      let verifiedLocally = false;

      if (!tokenAlg || tokenAlg === 'HS256') {
        try {
          const jwtSecret =
            this.configService.get<string>('supabase.jwtSecret');
          const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
            secret: jwtSecret,
            algorithms: ['HS256'],
          });
          authUserId = payload.sub;
          email = payload.email;
          appMetadata = payload.app_metadata ?? {};
          tokenAal = payload.aal;
          verifiedLocally = true;
        } catch (hs256Err) {
          // HS256 failed. For HS256-shaped tokens this is a real JWT-secret /
          // signature problem and deserves a dev diagnostic. ES256 local-dev
          // Supabase tokens skip this branch entirely so the logs don't fill
          // with expected "invalid algorithm" warnings.
          if (process.env.NODE_ENV !== 'production') {
            this.logger.warn(
              `[auth-guard] HS256 verify failed: ${hs256Err instanceof Error ? hs256Err.message : 'unknown'} — falling back to auth.getUser()`,
            );
          }
        }
      }

      if (!verifiedLocally) {
        // Fall back to Supabase auth.getUser() which validates via the auth server.
        const {
          data: { user },
          error,
        } = await this.supabaseAdmin.getClient().auth.getUser(token);

        if (error || !user) {
          if (process.env.NODE_ENV !== 'production') {
            this.logger.warn(
              `[auth-guard] auth.getUser() fallback also failed: ${error?.message ?? 'user=null'} — token is unverifiable; check SUPABASE_URL matches the project that issued this JWT`,
            );
          }

          throw new UnauthorizedException('Invalid or expired token');
        }

        authUserId = user.id;
        email = user.email;
        appMetadata = user.app_metadata ?? {};
        tokenAal = this.decodeTokenAal(token);
        authUserForMfa = user;
      }

      if (!authUserId) {
        throw new UnauthorizedException('Invalid or expired token');
      }

      const allowPendingMfa = this.reflector.getAllAndOverride<boolean>(
        ALLOW_PENDING_MFA_KEY,
        [context.getHandler(), context.getClass()],
      );

      if (!allowPendingMfa) {
        await this.enforceMfaIfRequired(
          request,
          token,
          tokenAal,
          authUserForMfa,
          authUserId,
        );
      }

      // Resolve auth UUID to public user ID
      // Critical: organization_members.user_id references public.users.id, NOT auth.users.id
      const publicUser =
        await this.usersService.getUserByAuthUserId(authUserId);

      if (!publicUser) {
        // Dev-only diagnostic: the JWT verified but no public.users row exists
        // for this auth UUID. Common when running against a fresh local Supabase
        // where auth.users was seeded but the handle_new_user trigger / public.users
        // table wasn't populated.
        if (process.env.NODE_ENV !== 'production') {
          this.logger.warn(
            `[auth-guard] JWT verified for auth_user_id=${authUserId} (email=${email ?? 'unknown'}) but no matching public.users row found. ` +
              `Seed the local Supabase or run the handle_new_user trigger.`,
          );
        }

        throw new UnauthorizedException('User profile not found');
      }

      // Resolve the active tenant for this request.
      //
      //   1. Load every membership in ONE round-trip (joined to organizations
      //      for the slug — used by the tenant switcher and by some bootstrap
      //      consumers).
      //   2. Prefer the active_org_id cookie when its signature verifies AND
      //      the org is still in `memberships` (covers the "user was removed
      //      since last switch" case).
      //   3. Fall back to the first membership ordered by created_at ASC so a
      //      brand-new user lands on their oldest / first org. The desired
      //      cookie write is stashed on the request for
      //      ActiveOrgCookieInterceptor to flush after the controller.
      //   4. Empty memberships → organizationId stays ''. Org-scoped services
      //      already guard this onboarding state.
      const memberships = await this.membershipContext.loadMemberships(
        publicUser.id,
      );

      const cookies = (
        request as Request & { cookies?: Record<string, string> }
      ).cookies;
      const cookieCfg = readCookieConfig(this.configService);
      const cookieResult = readActiveOrgCookie(cookies, cookieCfg);
      let tenantSlug = this.extractTenantSlug(request);
      let originDerivedSlug = false;

      // Browser XHRs never carry x-tenant-slug. It is stamped by the Next
      // middleware (SSR / proxied requests only), but in SaaS production the
      // browser calls this API origin directly and bypasses Next entirely — so
      // SSR resolved the org from the subdomain while client-side fetches fell
      // through to the cookie or the OLDEST membership. For a multi-org user
      // that means the page shell and its client-fetched data can disagree
      // about which tenant they are showing.
      //
      // Derive the tenant from Origin as a fallback. This is deliberately
      // ADDITIVE: it is adopted only when the header is absent AND the derived
      // slug names an org the caller is already a member of. A forged Origin
      // therefore cannot reach any org the user does not already belong to, and
      // when it does not match we leave resolution exactly as before
      // (cookie -> oldest membership). Authorization still comes from the
      // membership checks below, never from Origin.
      if (!tenantSlug) {
        const originSlug = this.extractTenantSlugFromOrigin(request);

        if (
          originSlug &&
          memberships.some((m) => m.organizationSlug === originSlug)
        ) {
          tenantSlug = originSlug;
          originDerivedSlug = true;
        }
      }

      let activeOrgId = '';
      let orgSource = 'none';
      const pending = request as Request & RequestWithPendingCookie;

      // Tenant-subdomain SSR forwards x-tenant-slug from Next middleware. That
      // host-derived signal is stronger than the sticky active_org_id cookie:
      // when a user is browsing b.example.com, bootstrap and org-scoped APIs
      // must resolve org B even if the cookie still points to org A.
      if (tenantSlug) {
        const hit = memberships.find((m) => m.organizationSlug === tenantSlug);

        if (hit) {
          activeOrgId = hit.organizationId;
          pending._pendingActiveOrgCookie = activeOrgId;
          orgSource = originDerivedSlug ? 'origin' : 'slug';
        } else {
          orgSource = 'slug-miss';
          // Do not fall back to a different tenant when the request explicitly
          // targeted a tenant slug the user does not belong to. Downstream
          // org-scoped handlers will treat the empty org as denied/invalid
          // instead of leaking data from the oldest membership.
          pending._pendingActiveOrgClear = true;
        }
      }

      if (!tenantSlug && cookieResult.valid) {
        const hit = memberships.find(
          (m) => m.organizationId === cookieResult.orgId,
        );
        if (hit) {
          activeOrgId = hit.organizationId;
          orgSource = 'cookie';
        } else {
          // Cookie pointed at an org the user is no longer a member of —
          // evict it so the next request doesn't keep paying the lookup.
          pending._pendingActiveOrgClear = true;
        }
      } else if (!tenantSlug && cookies?.[ACTIVE_ORG_COOKIE]) {
        // Cookie was present but signature failed (tampered / rotated secret).
        // Treat as absent and clear so we don't probe it again.
        pending._pendingActiveOrgClear = true;
      }

      if (!activeOrgId && !tenantSlug && memberships.length > 0) {
        activeOrgId = memberships[0].organizationId;
        pending._pendingActiveOrgCookie = activeOrgId;
        orgSource = 'oldest-membership';
      }

      // Surfaced by LoggingInterceptor on >=400 responses so a wrong-tenant
      // resolution can be diagnosed from production logs alone.
      (request as Request & { _orgSource?: string })._orgSource = orgSource;

      // Attach RequestUser to the request object
      // organizationId may be empty for onboarding (POST /organizations).
      // Org-scoped services must guard against empty string before querying.
      let requestUser: RequestUser = {
        authUserId,
        userId: publicUser.id,
        email: publicUser.email || email || '',
        organizationId: activeOrgId,
        memberships,
        role: publicUser.role,
        isActive: publicUser.is_active,
        appMetadata,
      };

      // Phase B — impersonation overlay
      if (this.shouldAttemptImpersonationOverlay(request)) {
        const impersonationCookies = (
          request as Request & { cookies?: Record<string, string> }
        ).cookies;
        const rawToken = readImpersonationCookie(impersonationCookies);

        if (rawToken) {
          const overlay = await this.tryApplyImpersonation(
            rawToken,
            requestUser,
            tenantSlug,
          );

          if (overlay) {
            requestUser = overlay;
          }
          // Invalid / expired / revoked / subdomain-mismatched cookies are silently stripped.
        }
      }

      (request as Request & { user: RequestUser }).user = requestUser;

      return true;
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof ServiceUnavailableException
      ) {
        // 401 (auth genuinely failed) and 503 (downstream DB unavailable
        // during membership lookup) must surface as themselves. Collapsing
        // a 503 to a 401 trains the frontend to log the user out instead
        // of retrying / showing a degraded-state banner.
        throw error;
      }
      this.logger.warn(
        `JWT verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /**
   * Extracts the access token from the request. Order of precedence:
   *   1. `Authorization: Bearer <token>` header — used by service-to-service callers
   *      and any tests / scripts that prefer header-based auth.
   *   2. `access_token` HttpOnly cookie — set by NestJS on signin/verify-otp/refresh.
   *      This is what the browser sends on cross-origin fetches with `credentials:'include'`.
   *
   * @private
   * @param {Request} request - The incoming HTTP request (with `cookies` populated by cookie-parser)
   * @returns {string | undefined} The token string, or undefined if not present
   */
  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, headerToken] = request.headers.authorization?.split(' ') ?? [];
    if (type === 'Bearer' && headerToken) {
      return headerToken;
    }

    // Fall back to the access_token cookie set by /auth/signin and friends.
    const cookies = (request as Request & { cookies?: Record<string, string> })
      .cookies;

    return cookies?.access_token as string | undefined;
  }

  private extractTenantSlug(request: Request): string | undefined {
    const raw = request.headers['x-tenant-slug'];
    const value = Array.isArray(raw) ? raw[0] : raw;

    if (typeof value !== 'string') return undefined;

    const slug = value.trim().toLowerCase();

    return /^[a-z0-9-]+$/.test(slug) ? slug : undefined;
  }

  /**
   * Cheap gate that decides whether to even look for an impersonation cookie.
   * Keeps the common (no-impersonation) path a strict no-op: only requests on
   * a tenant subdomain and outside the bypass list are eligible. No DB calls
   * happen here.
   *
   * @private
   */
  private shouldAttemptImpersonationOverlay(request: Request): boolean {
    const path = request.path || request.url || '';

    if (
      SupabaseAuthGuard.IMPERSONATION_BYPASS_PATHS.some((p) => path.includes(p))
    ) {
      return false;
    }

    const host =
      (request.headers['x-forwarded-host'] as string | undefined) ??
      request.headers.host ??
      '';
    const sub = this.extractHostSubdomain(host);

    if (
      sub &&
      SupabaseAuthGuard.IMPERSONATION_NON_TENANT_SUBDOMAINS.includes(sub)
    ) {
      return false;
    }

    return true;
  }

  /**
   * Derives a tenant slug from the request's Origin header.
   *
   * Used only as a fallback when `x-tenant-slug` is absent — i.e. browser XHRs,
   * which reach this API directly and so never pass through the Next middleware
   * that stamps the header. Host is useless here (it is the API host, e.g.
   * api.xisuite.cloud); Origin is the tenant the browser is actually on.
   *
   * Returns undefined for the apex, hosts outside ROOT_DOMAIN, multi-label
   * subdomains, and the reserved non-tenant subdomains.
   *
   * @private
   */
  private extractTenantSlugFromOrigin(request: Request): string | undefined {
    const raw = request.headers.origin;
    const origin = Array.isArray(raw) ? (raw as string[])[0] : raw;

    if (typeof origin !== 'string' || !origin) return undefined;

    let host: string;

    try {
      host = new URL(origin).host;
    } catch {
      return undefined;
    }

    const sub = this.extractHostSubdomain(host);

    if (!sub) return undefined;
    if (SupabaseAuthGuard.IMPERSONATION_NON_TENANT_SUBDOMAINS.includes(sub)) {
      return undefined;
    }

    return /^[a-z0-9-]+$/.test(sub) ? sub : undefined;
  }

  /**
   * Extracts the single-label subdomain from a host, scoped to ROOT_DOMAIN.
   * Returns null for the apex domain, hosts outside the root, or multi-label
   * left segments.
   *
   * @private
   */
  private extractHostSubdomain(host: string): string | null {
    if (!host) return null;

    const root = (
      process.env.ROOT_DOMAIN ||
      process.env.NEXT_PUBLIC_ROOT_DOMAIN ||
      'xisuite.cloud'
    ).toLowerCase();
    const hostNoPort = host.split(':')[0].toLowerCase();

    if (hostNoPort === root) return null;
    if (!hostNoPort.endsWith('.' + root)) return null;

    const sub = hostNoPort.slice(0, hostNoPort.length - root.length - 1);

    if (!sub || sub.includes('.')) return null;

    return sub;
  }

  /**
   * Attempts to build an impersonation overlay over the SA's RequestUser.
   *
   * Returns the TARGET user's RequestUser (with `impersonation` populated) when
   * the cookie maps to a live session owned by the calling SA AND every
   * integrity check passes. Returns null (silently strips the cookie) on any
   * failure — never throws — so a normal SA session is never broken. Stale
   * sessions are auto-ended in the DB with an appropriate `ended_reason`.
   *
   * @private
   */
  private async tryApplyImpersonation(
    rawToken: string,
    requestUser: RequestUser,
    tenantSlugFromHost: string | undefined,
  ): Promise<RequestUser | null> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const client = this.supabaseAdmin.getClient();
    // `select('*')` resolves to `any` under the untyped admin client, so we
    // capture the whole result and cast `data` to the typed row below rather
    // than destructuring an `any` value.
    const result = await client
      .from('impersonation_sessions')
      .select('*')
      .eq('token_hash', tokenHash)
      .is('ended_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    const error = result.error;
    const session = result.data as ImpersonationSessionRow | null;

    if (error || !session) return null;

    // 1. SA identity check (token theft defense).
    const isSuperAdminClaim =
      requestUser.appMetadata?.role === 'SUPER_ADMIN' ||
      requestUser.appMetadata?.is_super_admin === true;
    const isSuperAdminPublic = requestUser.role === 'SUPER_ADMIN';
    const isSameSA = requestUser.userId === session.super_admin_user_id;

    if (!isSuperAdminClaim || !isSuperAdminPublic || !isSameSA) {
      this.logger.warn(
        `Impersonation cookie presented by wrong user: session=${session.id} expected_sa=${session.super_admin_user_id} actual_user=${requestUser.userId}`,
      );
      await client
        .from('impersonation_sessions')
        .update({ ended_at: new Date().toISOString(), ended_reason: 'revoked' })
        .eq('id', session.id)
        .is('ended_at', null);

      return null;
    }

    // 2. Subdomain agreement — auto-stop with 'switched' if host tenant != session target tenant.
    if (tenantSlugFromHost) {
      const { data: slugData } = await client
        .from('organizations')
        .select('slug')
        .eq('id', session.target_organization_id)
        .maybeSingle();

      const targetOrgForSlugCheck = slugData as ImpersonationOrgSlugRow | null;

      if (
        targetOrgForSlugCheck?.slug &&
        targetOrgForSlugCheck.slug !== tenantSlugFromHost
      ) {
        this.logger.log(
          `Impersonation subdomain mismatch: session target slug=${targetOrgForSlugCheck.slug}, request slug=${tenantSlugFromHost}. Auto-switching (ending current session).`,
        );
        await client
          .from('impersonation_sessions')
          .update({
            ended_at: new Date().toISOString(),
            ended_reason: 'switched',
          })
          .eq('id', session.id)
          .is('ended_at', null);

        return null;
      }
    }

    // 3. Target user must exist and be active.
    const { data: targetUserData } = await client
      .from('users')
      .select('id, email, role, is_active, auth_user_id')
      .eq('id', session.target_user_id)
      .maybeSingle();

    const targetUser = targetUserData as ImpersonationTargetUserRow | null;

    if (!targetUser || targetUser.is_active === false) {
      await client
        .from('impersonation_sessions')
        .update({ ended_at: new Date().toISOString(), ended_reason: 'revoked' })
        .eq('id', session.id)
        .is('ended_at', null);

      return null;
    }

    // 4. Target organization must exist and be active.
    const { data: targetOrgData } = await client
      .from('organizations')
      .select('id, is_active')
      .eq('id', session.target_organization_id)
      .maybeSingle();

    const targetOrg = targetOrgData as ImpersonationTargetOrgRow | null;

    if (!targetOrg || targetOrg.is_active === false) {
      await client
        .from('impersonation_sessions')
        .update({ ended_at: new Date().toISOString(), ended_reason: 'revoked' })
        .eq('id', session.id)
        .is('ended_at', null);

      return null;
    }

    const impersonation: ImpersonationContext = {
      sessionId: session.id,
      realUserId: requestUser.userId,
      realAuthUserId: requestUser.authUserId,
      realEmail: requestUser.email,
      realOrganizationId: requestUser.organizationId,
      targetUserId: session.target_user_id,
      targetOrganizationId: session.target_organization_id,
      targetMembershipRole: session.target_membership_role,
      writeAccess: session.write_access,
      expiresAt: session.expires_at,
      startedAt: session.started_at,
      reason: session.reason,
    };

    // SSR (/auth/bootstrap + /auth/me) resolves the profile by authUserId and
    // gates membership by `memberships`. To land the SA on the TARGET tenant's
    // dashboard those must reflect the target, not the SA. Prefer the target's
    // auth UUID; if it's null/missing (rare/legacy rows), keep the SA's so the
    // request still authenticates, and warn that SSR profile will show the SA.
    let overlayAuthUserId = requestUser.authUserId;

    if (targetUser.auth_user_id) {
      overlayAuthUserId = targetUser.auth_user_id;
    } else {
      this.logger.warn(
        `Impersonation target user ${targetUser.id} has no auth_user_id; SSR profile will resolve to the Super-Admin for this target (session=${session.id}).`,
      );
    }

    return {
      ...requestUser,
      authUserId: overlayAuthUserId,
      userId: targetUser.id,
      email: targetUser.email,
      organizationId: targetOrg.id,
      role: targetUser.role,
      isActive: targetUser.is_active,
      appMetadata: requestUser.appMetadata,
      memberships: await this.membershipContext.loadMemberships(targetUser.id),
      impersonation,
    };
  }

  /**
   * Attempts to resolve a RequestUser from the Bearer token on a @Public() route.
   * Attaches the result to `request.user` when successful; silently no-ops on any
   * failure so anonymous callers are never blocked.
   *
   * @private
   */
  private async tryAttachOptionalUser(
    context: ExecutionContext,
  ): Promise<void> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) return;

    // SCIM tokens are customer secrets; never forward them to GoTrue (or its logs).
    if (token.startsWith('xis_')) return;

    try {
      let authUserId: string | undefined;
      const tokenAlg = this.decodeTokenAlgorithm(token);

      if (!tokenAlg || tokenAlg === 'HS256') {
        try {
          const jwtSecret =
            this.configService.get<string>('supabase.jwtSecret');
          const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
            secret: jwtSecret,
            algorithms: ['HS256'],
          });

          authUserId = payload.sub;
        } catch {
          // fall through to auth.getUser()
        }
      }

      if (!authUserId) {
        const {
          data: { user },
        } = await this.supabaseAdmin.getClient().auth.getUser(token);

        authUserId = user?.id;
      }

      if (!authUserId) return;

      const publicUser =
        await this.usersService.getUserByAuthUserId(authUserId);

      if (!publicUser) return;

      (request as Request & { user: RequestUser }).user = {
        authUserId,
        userId: publicUser.id,
        email: publicUser.email || '',
        organizationId: '',
        memberships: [],
        role: publicUser.role,
        isActive: publicUser.is_active,
        appMetadata: {},
      };
    } catch {
      // Never block a @Public() route on any auth error
    }
  }

  private async enforceMfaIfRequired(
    request: Request,
    token: string,
    tokenAal: string | undefined,
    knownAuthUser: AuthUserForMfa | null,
    authUserId: string,
  ): Promise<void> {
    // authUserId comes from the already-verified token, so a marker left by a
    // different account on this shared parent domain is ignored rather than
    // gating this session. Unattributable markers still gate (fail closed).
    const forceMfa = readMfaPendingCookie(
      (request as Request & { cookies?: Record<string, string | undefined> })
        .cookies,
      readCookieConfig(this.configService),
      authUserId,
    );

    if (tokenAal === 'aal2' && !forceMfa) return;

    const authUser = knownAuthUser ?? (await this.getAuthUserForMfa(token));
    const passkeyAssured = await this.resolvePasskeySessionAssurance(token);
    const state = deriveSessionMfaState({
      accessToken: token,
      factors: authUser.factors,
      passkeyAssured,
      forceMfa,
    });

    if (state.mfaRequired) {
      throw new UnauthorizedException('MFA verification required');
    }
  }

  private async getAuthUserForMfa(token: string): Promise<AuthUserForMfa> {
    const {
      data: { user },
      error,
    } = await this.supabaseAdmin.getClient().auth.getUser(token);

    if (error || !user) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    return user;
  }

  private decodeTokenAlgorithm(token: string): string | undefined {
    const [header] = token.split('.');

    if (!header) return undefined;

    try {
      const decoded = JSON.parse(
        Buffer.from(toPaddedBase64(header), 'base64').toString('utf8'),
      ) as { alg?: unknown };

      return typeof decoded.alg === 'string' ? decoded.alg : undefined;
    } catch {
      return undefined;
    }
  }

  private decodeTokenAal(token: string): string | undefined {
    const [, payload] = token.split('.');

    if (!payload) return undefined;

    try {
      const decoded = JSON.parse(
        Buffer.from(toPaddedBase64(payload), 'base64').toString('utf8'),
      ) as { aal?: unknown };

      return typeof decoded.aal === 'string' ? decoded.aal : undefined;
    } catch {
      return undefined;
    }
  }

  private async resolvePasskeySessionAssurance(
    accessToken: string,
  ): Promise<boolean> {
    const tokenPayload = getSessionAssuranceTokenPayload(accessToken);
    const authUserId =
      typeof tokenPayload?.sub === 'string' ? tokenPayload.sub : null;
    const sessionId =
      typeof tokenPayload?.session_id === 'string'
        ? tokenPayload.session_id
        : null;
    const methods = normalizeAuthenticationMethods(tokenPayload?.amr);

    if (
      !methods.some((method) => method.method.toLowerCase() === 'passkey') ||
      !authUserId ||
      !sessionId ||
      !this.passkeySessionAssurance
    ) {
      return false;
    }

    try {
      return await this.passkeySessionAssurance.isSessionAssured({
        accessToken,
        authUserId,
        sessionId,
      });
    } catch (error) {
      this.logger.warn(
        `Passkey session assurance lookup failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return false;
    }
  }
}

function toPaddedBase64(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');

  return base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
}
