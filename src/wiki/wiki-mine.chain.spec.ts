// Chain integration test for the MCP-facing wiki read endpoints
// (`GET /api/v1/wiki/mine/search` + `GET /api/v1/wiki/mine/:pageId`).
//
// Fires one signed S2S request (`X-MCP-S2S-Authorization: Bearer <hs256 jwt>`)
// through the full guard chain in declared order:
//   McpServiceTokenGuard, SupabaseAuthGuard, ImpersonationBlockedGuard,
//   ImpersonationReadOnlyGuard, FeatureGuard, UserAwareThrottlerGuard
// and asserts every guard returns `true`, then invokes the controller handler
// and asserts the whitelisted body. Unlike the tasks mine/* routes,
// WikiMineController carries class-level `@RequireFeature('module_wiki')`, so
// this test also exercises the FeatureGuard (entitled admits; not entitled
// denies). Member-space + page-ACL safety lives in WikiMineService, mocked here.
//
// Mirrors `tasks-mine.chain.spec.ts`: real guard classes + a real HS256
// verifier, with only DB/admin reads, identity resolution, and entitlements mocked.

// `jose` is ESM-only and Jest's ts-jest transform cannot parse it. The throttler
// guard imports `decodeJwt`; provide a faithful base64url decoder.
jest.mock('jose', () => ({
  decodeJwt: (token: string): Record<string, unknown> => {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');

    return JSON.parse(json) as Record<string, unknown>;
  },
}));

// `sanitize-rich-text` pulls in `jsdom` (ESM-only). WikiMineController, via
// WikiMineService and wiki-content.util, imports it; stub it as the unit specs do.
jest.mock('../common/utils/sanitize-rich-text', () => ({
  sanitizeRichText: (value: string | null | undefined) => value ?? null,
}));

import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { McpServiceTokenGuard } from '../auth/guards/mcp-service-token.guard';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { ImpersonationBlockedGuard } from '../auth/guards/impersonation-blocked.guard';
import { ImpersonationReadOnlyGuard } from '../auth/guards/impersonation-readonly.guard';
import { FeatureGuard } from '../auth/guards/feature.guard';
import { UserAwareThrottlerGuard } from '../common/throttler/user-aware-throttler.guard';
import { McpServiceTokenService } from '../auth/services/mcp-service-token.service';
import { REQUIRE_FEATURE_KEY } from '../auth/decorators/require-feature.decorator';
import { WikiMineController } from './wiki-mine.controller';
import type { UsersService } from '../users/users.service';
import type { MembershipContextService } from '../auth/services/membership-context.service';
import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { EntitlementsService } from '../licensing/entitlements.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

const SECRET = 'integration-mcp-s2s-secret-at-least-32-chars';
const ISSUER = 'xisuite-mcp';
const AUDIENCE = 'xisuite-backend';

const AUTH_USER_ID = 'auth-user-uuid';
const PUBLIC_USER_ID = 'public-user-id';
const ORG_ID = 'org-id';

const WHITELISTED_SEARCH = {
  pages: [
    {
      id: 'w-1',
      title: 'Runbook',
      snippet: 'How to handle an incident',
      space: { id: 'space-1', key: 'ENG', name: 'Engineering' },
      isArchived: false,
      updatedAt: '2025-01-02T00:00:00Z',
    },
  ],
};

const WHITELISTED_GET = {
  page: {
    id: 'w-1',
    title: 'Runbook',
    slug: 'runbook',
    parentId: null,
    space: { id: 'space-1', key: 'ENG', name: 'Engineering' },
    tags: [],
    isPublished: true,
    isArchived: false,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-02T00:00:00Z',
    contentText: 'incident steps',
    contentFormat: 'editorjs',
  },
};

describe('Wiki mine/* S2S guard chain (integration)', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

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
        scopes: ['profile', 'read:wiki'],
        aal: null,
        jti: 'jti-wiki-integration',
        iat,
        exp: iat + 60,
      },
      { secret: SECRET, algorithm: 'HS256' },
    );
  };

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

  // module_wiki entitled (active license).
  const entitlementsService = {
    getEffectiveEntitlements: jest.fn().mockResolvedValue({
      licenseStatus: 'active',
      grandfathered: false,
      has: (key: string) => key === 'module_wiki',
    }),
  } as unknown as EntitlementsService;

  // getAllAndOverride returns false (no @Public/@ImpersonationBlocked). get
  // returns ['module_wiki'] only for the FeatureGuard's class-metadata read.
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(false),
    get: jest.fn((key: unknown, target: unknown) =>
      key === REQUIRE_FEATURE_KEY && target === WikiMineController
        ? ['module_wiki']
        : undefined,
    ),
  } as unknown as Reflector;

  const buildContext = (
    s2sToken: string,
    path: string,
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
      getClass: () => WikiMineController,
    } as unknown as ExecutionContext;

    return { context, request };
  };

  const buildGuards = (jwtService: JwtService) => {
    const mcpTokenService = new McpServiceTokenService(
      jwtService,
      configService,
    );

    return {
      s2sGuard: new McpServiceTokenGuard(
        reflector,
        mcpTokenService,
        usersService,
        membershipContext,
        supabaseAdmin,
      ),
      authGuard: new SupabaseAuthGuard(
        reflector,
        jwtService,
        configService,
        usersService,
        supabaseAdmin,
        membershipContext,
      ),
      blockedGuard: new ImpersonationBlockedGuard(reflector),
      readOnlyGuard: new ImpersonationReadOnlyGuard(),
      featureGuard: new FeatureGuard(reflector, entitlementsService),
      throttlerGuard: new UserAwareThrottlerGuard(
        undefined as never,
        undefined as never,
        undefined as never,
      ),
    };
  };

  const buildController = () => {
    const service = {
      searchMyWikiPages: jest.fn().mockResolvedValue(WHITELISTED_SEARCH),
      getMyWikiPage: jest.fn().mockResolvedValue(WHITELISTED_GET),
    };

    return {
      service,
      controller: new WikiMineController(service as never),
    };
  };

  it('admits a signed S2S request to mine/search through EVERY guard and returns the whitelisted body', async () => {
    const jwtService = new JwtService({});
    const guards = buildGuards(jwtService);
    const token = signS2sJwt(jwtService);
    const { context, request } = buildContext(
      token,
      '/api/v1/wiki/mine/search',
    );

    await expect(guards.s2sGuard.canActivate(context)).resolves.toBe(true);
    const attached = request.user as RequestUser;

    expect(attached.userId).toBe(PUBLIC_USER_ID);
    expect(attached.organizationId).toBe(ORG_ID);
    expect(request._mcpS2s).toBe(true);

    await expect(guards.authGuard.canActivate(context)).resolves.toBe(true);
    expect(guards.blockedGuard.canActivate(context)).toBe(true);
    expect(guards.readOnlyGuard.canActivate(context)).toBe(true);
    // FeatureGuard enforces module_wiki; entitled here.
    await expect(guards.featureGuard.canActivate(context)).resolves.toBe(true);

    const tracker = await (
      guards.throttlerGuard as unknown as {
        getTracker: (r: Record<string, unknown>) => Promise<string>;
      }
    ).getTracker(request);

    expect(tracker).toBe(`user:${AUTH_USER_ID}`);

    const { controller, service } = buildController();
    const body = await controller.searchMyWikiPages(attached, 'runbook');

    expect(body).toEqual(WHITELISTED_SEARCH);
    expect(service.searchMyWikiPages).toHaveBeenCalledWith(
      attached,
      expect.any(Object),
    );
  });

  it('admits a signed S2S request to mine/:pageId through EVERY guard and returns the whitelisted body', async () => {
    const jwtService = new JwtService({});
    const guards = buildGuards(jwtService);
    const token = signS2sJwt(jwtService);
    const { context, request } = buildContext(
      token,
      '/api/v1/wiki/mine/11111111-1111-1111-1111-111111111111',
    );

    await expect(guards.s2sGuard.canActivate(context)).resolves.toBe(true);
    const attached = request.user as RequestUser;

    expect(attached.userId).toBe(PUBLIC_USER_ID);
    expect(request._mcpS2s).toBe(true);

    await expect(guards.authGuard.canActivate(context)).resolves.toBe(true);
    expect(guards.blockedGuard.canActivate(context)).toBe(true);
    expect(guards.readOnlyGuard.canActivate(context)).toBe(true);
    await expect(guards.featureGuard.canActivate(context)).resolves.toBe(true);

    const { controller, service } = buildController();
    const body = await controller.getMyWikiPage(
      attached,
      '11111111-1111-1111-1111-111111111111',
    );

    expect(body).toEqual(WHITELISTED_GET);
    expect(service.getMyWikiPage).toHaveBeenCalledWith(
      attached,
      '11111111-1111-1111-1111-111111111111',
      expect.any(Object),
    );
  });

  it('FeatureGuard DENIES when module_wiki is not entitled', async () => {
    const jwtService = new JwtService({});
    const guards = buildGuards(jwtService);
    (
      entitlementsService.getEffectiveEntitlements as jest.Mock
    ).mockResolvedValueOnce({
      licenseStatus: 'active',
      grandfathered: false,
      has: () => false,
    });
    const token = signS2sJwt(jwtService);
    const { context } = buildContext(token, '/api/v1/wiki/mine/search');

    await expect(guards.featureGuard.canActivate(context)).rejects.toThrow();
  });
});
