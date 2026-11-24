// Chain integration test for the MCP org-context endpoint. Fires one signed S2S
// request (X-MCP-S2S-Authorization: Bearer <hs256 jwt>) through the full guard
// chain that protects GET /api/v1/auth/mcp/org-context, in declared order:
//   McpServiceTokenGuard, SupabaseAuthGuard, ImpersonationBlockedGuard,
//   ImpersonationReadOnlyGuard, FeatureGuard, UserAwareThrottlerGuard
// then asserts every guard returns true, invokes the controller, and checks the
// whitelisted 200 body.
//
// Booting the full AppModule (or even AuthModule) pulls in Supabase/licensing/
// feature wiring that needs a live DB and is flaky in CI, so this is a focused
// chain test: it uses the real guard classes and a real HS256 verifier (so the
// crypto/iss/aud/exp/membership/org-active logic is genuinely exercised), with
// only the DB/admin reads and identity resolution mocked. It proves the chain
// admits a signed S2S request end-to-end without a live DB. The HTTP transport
// itself is not booted.

// `jose` is ESM-only and Jest's ts-jest transform cannot parse it. The throttler
// guard (pulled in below) imports `decodeJwt`; provide a faithful base64url
// decoder so the throttler bucketing in this chain test still works against the
// real signed S2S JWT. Mirrors the mock used in src/auth/oauth/*.spec.ts.
jest.mock('jose', () => ({
  decodeJwt: (token: string) => {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');

    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  },
}));

import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { McpServiceTokenGuard } from '../guards/mcp-service-token.guard';
import { SupabaseAuthGuard } from '../guards/supabase-auth.guard';
import { ImpersonationBlockedGuard } from '../guards/impersonation-blocked.guard';
import { ImpersonationReadOnlyGuard } from '../guards/impersonation-readonly.guard';
import { FeatureGuard } from '../guards/feature.guard';
import { UserAwareThrottlerGuard } from '../../common/throttler/user-aware-throttler.guard';
import { McpServiceTokenService } from '../services/mcp-service-token.service';
import { McpOrgContextController } from './mcp-org-context.controller';
import type {
  McpOrgContext,
  McpOrgContextService,
} from './mcp-org-context.service';
import type {
  McpOrgMembership,
  McpOrgMembershipsService,
} from './mcp-org-memberships.service';
import type { UsersService } from '../../users/users.service';
import type { MembershipContextService } from '../services/membership-context.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { EntitlementsService } from '../../licensing/entitlements.service';
import type { RequestUser } from '../interfaces/request-user.interface';

const SECRET = 'integration-mcp-s2s-secret-at-least-32-chars';
const ISSUER = 'xisuite-mcp';
const AUDIENCE = 'xisuite-backend';

const AUTH_USER_ID = 'auth-user-uuid';
const PUBLIC_USER_ID = 'public-user-id';
const ORG_ID = 'org-id';

const WHITELISTED_BODY: McpOrgContext = {
  organization: { id: ORG_ID, slug: 'acme', name: 'Acme Inc' },
  role: 'admin',
  modules: ['portfolio'],
};

const WHITELISTED_MEMBERSHIPS: McpOrgMembership[] = [
  { id: ORG_ID, slug: 'acme', name: 'Acme Inc', role: 'admin' },
];

describe('MCP org-context S2S guard chain (integration)', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  // A real HS256 S2S JWT signed with the chain's configured secret.
  const signS2sJwt = (jwtService: JwtService): string => {
    const iat = nowSec();

    return jwtService.sign(
      {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: AUTH_USER_ID,
        userId: PUBLIC_USER_ID,
        organizationId: ORG_ID,
        grantId: 'grant-id',
        clientId: 'client-id',
        scopes: ['profile'],
        aal: null,
        jti: 'jti-integration',
        iat,
        exp: iat + 60,
      },
      { secret: SECRET, algorithm: 'HS256' },
    );
  };

  // ConfigService stub returning the S2S verifier config (mcpS2s.*).
  const configService = {
    get: jest.fn((key: string) => {
      switch (key) {
        case 'mcpS2s.signingSecret':
          return SECRET;
        case 'mcpS2s.issuer':
          return ISSUER;
        case 'mcpS2s.audience':
          return AUDIENCE;
        case 'mcpS2s.clockSkewSeconds':
          return 5;
        default:
          return undefined;
      }
    }),
  } as unknown as ConfigService;

  // Admin client whose only relevant read is the org-active double-check.
  const supabaseAdmin = {
    getClient: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest
          .fn()
          .mockResolvedValue({ data: { is_active: true }, error: null }),
      }),
    }),
  } as unknown as SupabaseAdminService;

  const usersService = {
    getUserByAuthUserId: jest.fn().mockResolvedValue({
      id: PUBLIC_USER_ID,
      email: 'user@example.com',
      role: 'member',
      is_active: true,
    }),
  } as unknown as UsersService;

  const membershipContext = {
    loadMemberships: jest
      .fn()
      .mockResolvedValue([
        { organizationId: ORG_ID, organizationSlug: 'acme', role: 'admin' },
      ]),
  } as unknown as MembershipContextService;

  const entitlementsService: jest.Mocked<
    Pick<EntitlementsService, 'getEffectiveEntitlements'>
  > = {
    getEffectiveEntitlements: jest.fn(),
  };

  const orgContextService: jest.Mocked<
    Pick<McpOrgContextService, 'getOrgContext'>
  > = {
    getOrgContext: jest.fn().mockResolvedValue(WHITELISTED_BODY),
  };

  const orgMembershipsService: jest.Mocked<
    Pick<McpOrgMembershipsService, 'listOrgMemberships'>
  > = {
    listOrgMemberships: jest.fn().mockResolvedValue(WHITELISTED_MEMBERSHIPS),
  };

  // The route has no @Public/@RequireFeature/@ImpersonationBlocked, so every
  // reflector lookup returns undefined/false.
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(false),
    get: jest.fn().mockReturnValue(undefined),
  } as unknown as Reflector;

  // Builds the ExecutionContext for GET /api/v1/auth/mcp/org-context carrying
  // only the S2S header (no Authorization, no cookie), exactly what the MCP
  // bridge sends. The same request object is shared across all guards so the
  // `user` / `_mcpS2s` markers set by the S2S guard are visible downstream.
  const buildContext = (
    s2sToken: string,
    path = '/api/v1/auth/mcp/org-context',
  ): { context: ExecutionContext; request: Record<string, unknown> } => {
    const request: Record<string, unknown> = {
      method: 'GET',
      path,
      url: path,
      headers: { 'x-mcp-s2s-authorization': `Bearer ${s2sToken}` },
      ip: '203.0.113.10',
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => McpOrgContextController,
    } as unknown as ExecutionContext;

    return { context, request };
  };

  it('admits a signed S2S request through EVERY guard and returns the whitelisted 200 body', async () => {
    const jwtService = new JwtService({});

    const mcpTokenService = new McpServiceTokenService(
      jwtService,
      configService,
    );

    const s2sGuard = new McpServiceTokenGuard(
      reflector,
      mcpTokenService,
      usersService,
      membershipContext,
      supabaseAdmin,
    );
    const authGuard = new SupabaseAuthGuard(
      reflector,
      jwtService,
      configService,
      usersService,
      supabaseAdmin,
      membershipContext,
    );
    const blockedGuard = new ImpersonationBlockedGuard(reflector);
    const readOnlyGuard = new ImpersonationReadOnlyGuard();
    const featureGuard = new FeatureGuard(
      reflector,
      entitlementsService as unknown as EntitlementsService,
    );
    const throttlerGuard = new UserAwareThrottlerGuard(
      undefined as never,
      undefined as never,
      undefined as never,
    );

    const token = signS2sJwt(jwtService);
    const { context, request } = buildContext(token);

    // 1. McpServiceTokenGuard verifies the S2S JWT and builds request.user fresh.
    await expect(s2sGuard.canActivate(context)).resolves.toBe(true);
    const attached = request.user as RequestUser;

    expect(attached).toBeDefined();
    expect(attached.userId).toBe(PUBLIC_USER_ID);
    expect(attached.organizationId).toBe(ORG_ID);
    expect(attached.impersonation).toBeUndefined();
    expect(request._mcpS2s).toBe(true);

    // 2. SupabaseAuthGuard passes through (no re-verify) on the S2S marker.
    await expect(authGuard.canActivate(context)).resolves.toBe(true);

    // 3 & 4. Impersonation guards pass through for a non-impersonating user.
    expect(blockedGuard.canActivate(context)).toBe(true);
    expect(readOnlyGuard.canActivate(context)).toBe(true);

    // 5. FeatureGuard: route has no @RequireFeature, so it admits without
    //    touching entitlements.
    await expect(featureGuard.canActivate(context)).resolves.toBe(true);
    expect(entitlementsService.getEffectiveEntitlements).not.toHaveBeenCalled();

    // 6. Throttler buckets the S2S request by user:<sub> (not a shared ip).
    const tracker = await (
      throttlerGuard as unknown as {
        getTracker: (r: Record<string, unknown>) => Promise<string>;
      }
    ).getTracker(request);

    expect(tracker).toBe(`user:${AUTH_USER_ID}`);

    // Handler: the controller returns only the whitelisted org-context shape.
    const controller = new McpOrgContextController(
      orgContextService as unknown as McpOrgContextService,
      orgMembershipsService as unknown as McpOrgMembershipsService,
    );
    const body = await controller.getOrgContext(attached);

    expect(body).toEqual(WHITELISTED_BODY);
    expect(orgContextService.getOrgContext).toHaveBeenCalledWith(attached);
  });

  it('admits a signed S2S request to org-memberships through EVERY guard and returns the whitelisted 200 body', async () => {
    const jwtService = new JwtService({});

    const mcpTokenService = new McpServiceTokenService(
      jwtService,
      configService,
    );

    const s2sGuard = new McpServiceTokenGuard(
      reflector,
      mcpTokenService,
      usersService,
      membershipContext,
      supabaseAdmin,
    );
    const authGuard = new SupabaseAuthGuard(
      reflector,
      jwtService,
      configService,
      usersService,
      supabaseAdmin,
      membershipContext,
    );
    const blockedGuard = new ImpersonationBlockedGuard(reflector);
    const readOnlyGuard = new ImpersonationReadOnlyGuard();
    const featureGuard = new FeatureGuard(
      reflector,
      entitlementsService as unknown as EntitlementsService,
    );

    const token = signS2sJwt(jwtService);
    const { context, request } = buildContext(
      token,
      '/api/v1/auth/mcp/org-memberships',
    );

    // 1. S2S guard verifies the S2S JWT and builds request.user fresh.
    await expect(s2sGuard.canActivate(context)).resolves.toBe(true);
    const attached = request.user as RequestUser;

    expect(attached.userId).toBe(PUBLIC_USER_ID);
    expect(request._mcpS2s).toBe(true);

    // 2-5. Remaining guards pass through for this non-impersonating, no-feature route.
    await expect(authGuard.canActivate(context)).resolves.toBe(true);
    expect(blockedGuard.canActivate(context)).toBe(true);
    expect(readOnlyGuard.canActivate(context)).toBe(true);
    await expect(featureGuard.canActivate(context)).resolves.toBe(true);

    // Handler returns only { data: [...] } with whitelisted membership fields.
    const controller = new McpOrgContextController(
      orgContextService as unknown as McpOrgContextService,
      orgMembershipsService as unknown as McpOrgMembershipsService,
    );
    const body = await controller.getOrgMemberships(attached);

    expect(body).toEqual({ data: WHITELISTED_MEMBERSHIPS });
    expect(orgMembershipsService.listOrgMemberships).toHaveBeenCalledWith(
      attached,
    );
  });
});
