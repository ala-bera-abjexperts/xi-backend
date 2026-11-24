// Global guard that authenticates service-to-service (S2S) calls from the MCP
// server (xisuite-mcp). It runs first in the APP_GUARD chain, ahead of
// SupabaseAuthGuard. This is additive; normal auth is untouched.
//
// It reads only the dedicated `X-MCP-S2S-Authorization: Bearer <jwt>` header.
// If the header is absent it returns true immediately without attaching
// anything, so normal Authorization-based requests fall through to
// SupabaseAuthGuard unchanged. If the header is present it verifies the S2S JWT,
// re-resolves user/membership/org fresh from the database (claims are never
// trusted), builds the same RequestUser shape the Supabase guard builds,
// attaches it to request.user, and returns true.
//
// Security invariants (encoded as tests): the resolved S2S user is an ordinary
// user to every downstream guard, with no skip/elevation flag and impersonation
// asserted absent. The user must be active, the grant's org must be in the
// user's memberships, and the org must be active (double-checked even though
// loadMemberships already drops deactivated orgs). appMetadata carries only
// mcp_grant_id/mcp_scopes for audit, never a bypass flag.

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { UsersService } from '../../users/users.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { McpServiceTokenService } from '../services/mcp-service-token.service';
import { MembershipContextService } from '../services/membership-context.service';
import type { RequestUser } from '../interfaces/request-user.interface';

/** Header carrying the S2S JWT. Deliberately not `Authorization`. */
const S2S_HEADER = 'x-mcp-s2s-authorization';

/**
 * Request augmentation: a marker set when this guard authenticated the request
 * via S2S. Downstream guards (e.g. {@link ImpersonationBlockedGuard}) can read
 * it for defense-in-depth canaries.
 */
export interface RequestWithS2sMarker {
  /** True when the request was authenticated through the S2S path. */
  _mcpS2s?: boolean;
}

/** Minimal `organizations` row read for the active-org double-check. */
interface OrgActiveRow {
  is_active: boolean | null;
}

/**
 * Authenticates MCP service-to-service requests. Pure pass-through for every
 * request that does not carry the S2S header.
 */
@Injectable()
export class McpServiceTokenGuard implements CanActivate {
  private readonly logger = new Logger(McpServiceTokenGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly mcpTokenService: McpServiceTokenService,
    private readonly usersService: UsersService,
    private readonly membershipContext: MembershipContextService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Honor @Public() like SupabaseAuthGuard: a public route is open to all,
    // so a (possibly bogus) S2S header on it must not force a 401. Checked
    // before reading the header so the public path is a pure pass-through.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractS2sToken(request);

    // No S2S header, so leave the request exactly as it was. SupabaseAuthGuard
    // (next in the chain) handles normal auth. This is the common path.
    if (!token) {
      return true;
    }

    try {
      const requestUser = await this.buildRequestUserFromS2s(token);

      (request as Request & { user: RequestUser }).user = requestUser;
      (request as Request & RequestWithS2sMarker)._mcpS2s = true;

      return true;
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof ServiceUnavailableException
      ) {
        // 401 (auth genuinely failed) and 503 (transient DB unavailability
        // during the org-active check) must surface as themselves. Collapsing
        // a 503 to a 401 would needlessly churn the upstream OAuth token.
        throw error;
      }

      // Any unexpected failure collapses to a generic 401: never leak detail
      // and never accidentally fall through to the normal auth path with a
      // half-built user.
      this.logger.warn(
        `S2S authentication failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new UnauthorizedException('Invalid S2S token');
    }
  }

  // Verifies the S2S JWT and rebuilds the RequestUser from fresh DB reads.
  // Identity claims are treated as untrusted hints; the authoritative values
  // come from getUserByAuthUserId(sub) plus loadMemberships.
  private async buildRequestUserFromS2s(token: string): Promise<RequestUser> {
    const claims = await this.mcpTokenService.verify(token);

    // Resolve the real user fresh from the database via the verified `sub`.
    const publicUser = await this.usersService.getUserByAuthUserId(claims.sub);

    if (!publicUser) {
      throw new UnauthorizedException('S2S user profile not found');
    }

    if (publicUser.is_active === false) {
      throw new UnauthorizedException('S2S user is inactive');
    }

    // Load memberships through the same shared loader the Supabase guard uses
    // (deactivated orgs are already dropped here).
    const memberships = await this.membershipContext.loadMemberships(
      publicUser.id,
    );

    // The grant's organization must be one of the user's active memberships.
    const membership = memberships.find(
      (m) => m.organizationId === claims.organizationId,
    );

    if (!membership) {
      throw new UnauthorizedException(
        'S2S organization is not an active membership for this user',
      );
    }

    // Double-check the org is active (defense-in-depth): loadMemberships
    // already excludes inactive orgs, but a race between the two reads must
    // not grant access to a just-deactivated tenant.
    await this.assertOrganizationActive(claims.organizationId);

    // Build the same RequestUser shape SupabaseAuthGuard builds. appMetadata
    // carries audit-only MCP context, never an elevation/bypass flag. The
    // impersonation field is intentionally omitted: an S2S caller is an
    // ordinary user to every downstream guard.
    const requestUser: RequestUser = {
      authUserId: claims.sub,
      userId: publicUser.id,
      email: publicUser.email || '',
      organizationId: claims.organizationId,
      memberships,
      role: publicUser.role,
      isActive: publicUser.is_active,
      appMetadata: {
        mcp_grant_id: claims.grantId,
        mcp_scopes: claims.scopes,
      },
    };

    // Defense-in-depth assertion: this path must never produce an impersonation
    // overlay. If a future refactor wires one in, fail loudly instead of
    // silently shipping a privileged S2S user.
    if (requestUser.impersonation) {
      throw new UnauthorizedException('S2S user must not carry impersonation');
    }

    return requestUser;
  }

  // Asserts the organization row exists and is active.
  private async assertOrganizationActive(
    organizationId: string,
  ): Promise<void> {
    const result = await this.supabaseAdmin
      .getClient()
      .from('organizations')
      .select('is_active')
      .eq('id', organizationId)
      .maybeSingle();

    if (result.error) {
      // A DB blip is a transient infrastructure failure, not an auth failure.
      // Mirror MembershipContextService.loadMemberships: surface 503 so the
      // caller retries instead of collapsing to a 401 that would churn the
      // upstream OAuth token. The canActivate catch re-throws this unchanged.
      throw new ServiceUnavailableException(
        'Failed to verify S2S organization',
      );
    }

    const org = result.data as OrgActiveRow | null;

    if (!org || org.is_active === false) {
      throw new UnauthorizedException('S2S organization is inactive');
    }
  }

  // Extracts the raw JWT from the dedicated S2S header. Returns undefined when
  // the header is absent or malformed (the absent case is the common
  // pass-through path, not an error).
  private extractS2sToken(request: Request): string | undefined {
    const raw = request.headers[S2S_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;

    if (typeof value !== 'string') {
      return undefined;
    }

    const [type, headerToken] = value.split(' ');

    if (type === 'Bearer' && headerToken) {
      return headerToken;
    }

    return undefined;
  }
}
