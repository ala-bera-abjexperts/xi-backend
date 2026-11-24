// Chain integration test for the MCP-facing task read endpoints
// (`GET /api/v1/tasks/mine/search` + `GET /api/v1/tasks/mine/:taskIdOrKey`).
//
// It fires one signed S2S request (`X-MCP-S2S-Authorization: Bearer <hs256 jwt>`)
// through the full guard chain that protects every authenticated route, in
// declared order: McpServiceTokenGuard, SupabaseAuthGuard,
// ImpersonationBlockedGuard, ImpersonationReadOnlyGuard, FeatureGuard,
// UserAwareThrottlerGuard. It asserts every guard returns `true`, then invokes
// the controller handler and asserts the whitelisted 200 body. The `mine/*`
// routes carry the global auth guard only (no @RequirePermissions, no space
// guard), so app-auth and S2S reach them identically; member-space safety is
// enforced in the service, which is mocked here.
//
// This mirrors `mcp-org-context.chain.spec.ts`: a focused chain test using the
// real guard classes and a real HS256 verifier (so crypto/iss/aud/exp/membership
// logic is genuinely exercised) with only the DB/admin reads + identity
// resolution mocked. The HTTP transport is not booted.

// `jose` is ESM-only and Jest's ts-jest transform cannot parse it. The throttler
// guard imports `decodeJwt`, so provide a faithful base64url decoder. Mirrors
// the mock used in the org-context chain test.
jest.mock('jose', () => ({
  decodeJwt: (token: string): Record<string, unknown> => {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');

    return JSON.parse(json) as Record<string, unknown>;
  },
}));

// `sanitize-rich-text` pulls in `jsdom` (ESM-only) which Jest cannot transform.
// The chain test imports the controller, service, and sanitize-rich-text, so we
// stub it the same way the tasks unit specs do.
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
import { TasksController } from './tasks.controller';
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
  tasks: [
    {
      id: 'task-1',
      key: 'ENG-1',
      summary: 'Fix login',
      status: 'open',
      priority: 'medium',
      assignee: null,
      dueDate: null,
      space: { id: 'space-1', key: 'ENG', name: 'Engineering' },
      updatedAt: '2025-01-02T00:00:00Z',
    },
  ],
};

const WHITELISTED_GET = {
  task: {
    id: 'task-1',
    key: 'ENG-1',
    summary: 'Fix login',
    description: null,
    status: 'open',
    priority: 'medium',
    assignee: null,
    reporter: null,
    dueDate: null,
    space: { id: 'space-1', key: 'ENG', name: 'Engineering' },
    labels: [],
    version: 1,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-02T00:00:00Z',
  },
};

describe('Tasks mine/* S2S guard chain (integration)', () => {
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
        scopes: ['profile', 'read:tasks'],
        aal: null,
        jti: 'jti-tasks-integration',
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

  // The mine/* routes have no @Public/@RequireFeature/@ImpersonationBlocked.
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(false),
    get: jest.fn().mockReturnValue(undefined),
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
      getClass: () => TasksController,
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
      featureGuard: new FeatureGuard(
        reflector,
        entitlementsService as unknown as EntitlementsService,
      ),
      throttlerGuard: new UserAwareThrottlerGuard(
        undefined as never,
        undefined as never,
        undefined as never,
      ),
    };
  };

  // A TasksController with every dependency mocked. Only `service` is exercised
  // by the two mine/* handlers under test.
  const buildController = () => {
    const service = {
      searchMyTasks: jest.fn().mockResolvedValue(WHITELISTED_SEARCH),
      getMyTask: jest.fn().mockResolvedValue(WHITELISTED_GET),
    };

    return {
      service,
      controller: new TasksController(
        service as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      ),
    };
  };

  it('admits a signed S2S request to mine/search through EVERY guard and returns the whitelisted body', async () => {
    const jwtService = new JwtService({});
    const guards = buildGuards(jwtService);
    const token = signS2sJwt(jwtService);
    const { context, request } = buildContext(
      token,
      '/api/v1/tasks/mine/search',
    );

    await expect(guards.s2sGuard.canActivate(context)).resolves.toBe(true);
    const attached = request.user as RequestUser;

    expect(attached.userId).toBe(PUBLIC_USER_ID);
    expect(attached.organizationId).toBe(ORG_ID);
    expect(request._mcpS2s).toBe(true);

    await expect(guards.authGuard.canActivate(context)).resolves.toBe(true);
    expect(guards.blockedGuard.canActivate(context)).toBe(true);
    expect(guards.readOnlyGuard.canActivate(context)).toBe(true);
    await expect(guards.featureGuard.canActivate(context)).resolves.toBe(true);

    const tracker = await (
      guards.throttlerGuard as unknown as {
        getTracker: (r: Record<string, unknown>) => Promise<string>;
      }
    ).getTracker(request);

    expect(tracker).toBe(`user:${AUTH_USER_ID}`);

    const { controller, service } = buildController();
    const body = await controller.searchMyTasks(attached);

    expect(body).toEqual(WHITELISTED_SEARCH);
    expect(service.searchMyTasks).toHaveBeenCalledWith(
      attached,
      expect.any(Object),
    );
  });

  it('admits a signed S2S request to mine/:taskIdOrKey through EVERY guard and returns the whitelisted body', async () => {
    const jwtService = new JwtService({});
    const guards = buildGuards(jwtService);
    const token = signS2sJwt(jwtService);
    const { context, request } = buildContext(
      token,
      '/api/v1/tasks/mine/ENG-1',
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
    const body = await controller.getMyTask(attached, 'ENG-1');

    expect(body).toEqual(WHITELISTED_GET);
    expect(service.getMyTask).toHaveBeenCalledWith(
      attached,
      'ENG-1',
      expect.any(Object),
    );
  });
});
