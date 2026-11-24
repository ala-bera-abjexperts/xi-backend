import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { McpServiceTokenGuard } from './mcp-service-token.guard';
import { McpServiceTokenService } from '../services/mcp-service-token.service';
import { MembershipContextService } from '../services/membership-context.service';
import { UsersService } from '../../users/users.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';

describe('McpServiceTokenGuard', () => {
  let guard: McpServiceTokenGuard;
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;
  let mcpTokenService: jest.Mocked<Pick<McpServiceTokenService, 'verify'>>;
  let usersService: jest.Mocked<Pick<UsersService, 'getUserByAuthUserId'>>;
  let membershipContext: jest.Mocked<
    Pick<MembershipContextService, 'loadMemberships'>
  >;
  let orgMaybeSingle: jest.Mock;
  let supabaseAdmin: SupabaseAdminService;

  const validClaims = {
    iss: 'xisuite-mcp',
    aud: 'xisuite-backend',
    sub: 'auth-user-uuid',
    userId: 'public-user-id',
    organizationId: 'org-id',
    grantId: 'grant-id',
    clientId: 'client-id',
    scopes: ['profile'],
    aal: null,
    jti: 'jti-123',
    iat: 1,
    exp: 61,
  };

  const activeUser = {
    id: 'public-user-id',
    email: 'user@example.com',
    role: 'member',
    is_active: true,
  };

  const memberships = [
    { organizationId: 'org-id', organizationSlug: 'acme', role: 'admin' },
  ];

  // Builds an ExecutionContext whose request optionally carries the S2S header.
  const mockContext = (
    headers: Record<string, string> = {},
  ): { context: ExecutionContext; request: Record<string, unknown> } => {
    const request: Record<string, unknown> = { headers, user: undefined };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    return { context, request };
  };

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    };
    mcpTokenService = {
      verify: jest.fn().mockResolvedValue(validClaims),
    };
    usersService = {
      getUserByAuthUserId: jest.fn().mockResolvedValue(activeUser),
    };
    membershipContext = {
      loadMemberships: jest.fn().mockResolvedValue(memberships),
    };
    orgMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: { is_active: true }, error: null });
    supabaseAdmin = {
      getClient: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: orgMaybeSingle,
        }),
      }),
    } as unknown as SupabaseAdminService;

    guard = new McpServiceTokenGuard(
      reflector as unknown as Reflector,
      mcpTokenService as unknown as McpServiceTokenService,
      usersService as unknown as UsersService,
      membershipContext as unknown as MembershipContextService,
      supabaseAdmin,
    );
  });

  it('passes through (true, no request.user) when the S2S header is absent', async () => {
    const { context, request } = mockContext({
      authorization: 'Bearer normal-token',
    });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.user).toBeUndefined();
    expect(mcpTokenService.verify).not.toHaveBeenCalled();
  });

  it('builds a fresh RequestUser when a valid S2S token is present', async () => {
    const { context, request } = mockContext({
      'x-mcp-s2s-authorization': 'Bearer valid-s2s-jwt',
    });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(usersService.getUserByAuthUserId).toHaveBeenCalledWith(
      'auth-user-uuid',
    );
    expect(request.user).toEqual({
      authUserId: 'auth-user-uuid',
      userId: 'public-user-id',
      email: 'user@example.com',
      organizationId: 'org-id',
      memberships,
      role: 'member',
      isActive: true,
      appMetadata: {
        mcp_grant_id: 'grant-id',
        mcp_scopes: ['profile'],
      },
    });
    expect(request._mcpS2s).toBe(true);
  });

  it('NEVER attaches an impersonation overlay on the S2S path', async () => {
    const { context, request } = mockContext({
      'x-mcp-s2s-authorization': 'Bearer valid-s2s-jwt',
    });

    await guard.canActivate(context);

    expect(
      (request.user as { impersonation?: unknown }).impersonation,
    ).toBeUndefined();
  });

  it('rejects when the resolved user is inactive', async () => {
    usersService.getUserByAuthUserId.mockResolvedValueOnce({
      ...activeUser,
      is_active: false,
    } as never);
    const { context } = mockContext({
      'x-mcp-s2s-authorization': 'Bearer valid-s2s-jwt',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects when the user profile is not found', async () => {
    usersService.getUserByAuthUserId.mockResolvedValueOnce(null);
    const { context } = mockContext({
      'x-mcp-s2s-authorization': 'Bearer valid-s2s-jwt',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects when the grant org is not an active membership', async () => {
    membershipContext.loadMemberships.mockResolvedValueOnce([
      { organizationId: 'other-org', organizationSlug: 'x', role: 'member' },
    ]);
    const { context } = mockContext({
      'x-mcp-s2s-authorization': 'Bearer valid-s2s-jwt',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects when the organization is inactive (double-check)', async () => {
    orgMaybeSingle.mockResolvedValueOnce({
      data: { is_active: false },
      error: null,
    });
    const { context } = mockContext({
      'x-mcp-s2s-authorization': 'Bearer valid-s2s-jwt',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('fail-closes (401) when the verifier throws (e.g. env secret missing)', async () => {
    mcpTokenService.verify.mockRejectedValueOnce(
      new UnauthorizedException('S2S authentication is not configured'),
    );
    const { context, request } = mockContext({
      'x-mcp-s2s-authorization': 'Bearer valid-s2s-jwt',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(request.user).toBeUndefined();
  });

  it('treats a malformed S2S header (no Bearer) as pass-through', async () => {
    const { context, request } = mockContext({
      'x-mcp-s2s-authorization': 'not-a-bearer-token',
    });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.user).toBeUndefined();
    expect(mcpTokenService.verify).not.toHaveBeenCalled();
  });

  it('maps an org-active DB error to 503 (ServiceUnavailable), not 401', async () => {
    orgMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'db connection reset' },
    });
    const { context } = mockContext({
      'x-mcp-s2s-authorization': 'Bearer valid-s2s-jwt',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('honors @Public(): a bogus S2S header on a public route passes (not 401)', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const { context, request } = mockContext({
      'x-mcp-s2s-authorization': 'Bearer bogus-unverifiable-token',
    });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.user).toBeUndefined();
    // The S2S verifier should not run for a public route.
    expect(mcpTokenService.verify).not.toHaveBeenCalled();
  });
});
