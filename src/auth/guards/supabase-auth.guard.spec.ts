import { createHmac } from 'crypto';
import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { ALLOW_PENDING_MFA_KEY } from '../decorators/allow-pending-mfa.decorator';
import { UsersService } from '../../users/users.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { MembershipContextService } from '../services/membership-context.service';

describe('SupabaseAuthGuard', () => {
  let guard: SupabaseAuthGuard;
  let reflector: Reflector;
  let jwtService: JwtService;
  let configService: ConfigService;
  let usersService: UsersService;
  let supabaseAdmin: SupabaseAdminService;
  let membershipContext: MembershipContextService;
  let mockSupabaseGetUser: jest.Mock;
  let mockIsSessionAssured: jest.Mock;

  const mockUser = {
    id: 'public-user-id',
    email: 'test@example.com',
    first_name: 'Test',
    last_name: 'User',
    auth_user_id: 'auth-user-uuid',
    organization_id: 'org-id',
    avatar_url: null,
    avatar_path: null,
    mobile: null,
    role: null,
    country: null,
    language: null,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  };

  const mockContext = ({
    headers = {},
    path = '/api/v1/auth/bootstrap',
  }: {
    headers?: Record<string, string>;
    path?: string;
  } = {}): ExecutionContext => {
    const request = { headers, path, url: path, user: undefined };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  };

  beforeEach(() => {
    reflector = new Reflector();
    jwtService = new JwtService({});
    configService = {
      get: jest.fn().mockReturnValue('test-jwt-secret'),
    } as unknown as ConfigService;
    usersService = {
      getUserByAuthUserId: jest.fn(),
    } as unknown as UsersService;
    mockSupabaseGetUser = jest.fn().mockResolvedValue({
      data: {
        user: {
          id: 'auth-user-uuid',
          email: 'test@example.com',
          app_metadata: {},
          factors: [],
        },
      },
      error: null,
    });
    supabaseAdmin = {
      getClient: jest.fn().mockReturnValue({
        auth: {
          getUser: mockSupabaseGetUser,
        },
      }),
    } as unknown as SupabaseAdminService;
    // Shared membership loader is now a dependency (extracted from the guard).
    // Default to an empty membership set; individual tests override as needed.
    membershipContext = {
      loadMemberships: jest.fn().mockResolvedValue([]),
    } as unknown as MembershipContextService;
    mockIsSessionAssured = jest.fn().mockResolvedValue(false);
    guard = new SupabaseAuthGuard(
      reflector,
      jwtService,
      configService,
      usersService,
      supabaseAdmin,
      membershipContext,
      { isSessionAssured: mockIsSessionAssured } as any,
    );
  });

  it('never forwards a SCIM token on a @Public() route to GoTrue', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const context = mockContext({
      headers: { authorization: 'Bearer xis_scim_secret' },
    });

    expect(await guard.canActivate(context)).toBe(true);
    expect(mockSupabaseGetUser).not.toHaveBeenCalled();
    expect(
      context.switchToHttp().getRequest<{ user?: unknown }>().user,
    ).toBeUndefined();
  });

  it('should allow access to @Public() routes', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const context = mockContext();
    expect(await guard.canActivate(context)).toBe(true);
  });

  it('should reject requests without Authorization header', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const context = mockContext({ headers: {} });
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should reject requests with invalid token', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    mockSupabaseGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'invalid token' },
    });
    const context = mockContext({
      headers: { authorization: 'Bearer invalid-token' },
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should reject when user profile not found', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
      sub: 'auth-user-uuid',
      email: 'test@example.com',
    });
    (usersService.getUserByAuthUserId as jest.Mock).mockResolvedValue(null);

    const context = mockContext({
      headers: { authorization: 'Bearer valid-token' },
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('surfaces a profile lookup DB failure as 503, not 401', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
      sub: 'auth-user-uuid',
      email: 'test@example.com',
    });
    (usersService.getUserByAuthUserId as jest.Mock).mockRejectedValue(
      new ServiceUnavailableException('Could not load user profile'),
    );

    const context = mockContext({
      headers: { authorization: 'Bearer valid-token' },
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('lets a @Public() route continue anonymously when the profile lookup fails', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
      sub: 'auth-user-uuid',
      email: 'test@example.com',
    });
    (usersService.getUserByAuthUserId as jest.Mock).mockRejectedValue(
      new ServiceUnavailableException('Could not load user profile'),
    );

    const context = mockContext({
      headers: { authorization: 'Bearer valid-token' },
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading the jest mock fn, not invoking it bound
    expect(usersService.getUserByAuthUserId).toHaveBeenCalledWith(
      'auth-user-uuid',
    );
    expect(
      context.switchToHttp().getRequest<{ user: unknown }>().user,
    ).toBeUndefined();
  });

  it('should attach RequestUser to request on success', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
      sub: 'auth-user-uuid',
      email: 'test@example.com',
      aal: 'aal2',
    });
    (usersService.getUserByAuthUserId as jest.Mock).mockResolvedValue(mockUser);

    const request = {
      headers: { authorization: 'Bearer valid-token' },
      user: undefined as unknown,
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
    expect(request.user).toEqual({
      authUserId: 'auth-user-uuid',
      userId: 'public-user-id',
      email: 'test@example.com',
      // No active_org cookie + empty memberships means onboarding org ('').
      organizationId: '',
      memberships: [],
      role: null,
      isActive: true,
      appMetadata: {},
    });
  });

  it('resolves the active org from the first membership when present', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
      sub: 'auth-user-uuid',
      email: 'test@example.com',
      aal: 'aal2',
    });
    (usersService.getUserByAuthUserId as jest.Mock).mockResolvedValue(mockUser);
    (membershipContext.loadMemberships as jest.Mock).mockResolvedValue([
      { organizationId: 'org-id', organizationSlug: 'acme', role: 'admin' },
    ]);

    const request = {
      headers: { authorization: 'Bearer valid-token' },
      user: undefined as unknown,
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await guard.canActivate(context);

    expect((request.user as { organizationId: string }).organizationId).toBe(
      'org-id',
    );
    expect((request.user as { memberships: unknown[] }).memberships).toEqual([
      { organizationId: 'org-id', organizationSlug: 'acme', role: 'admin' },
    ]);
  });

  it('passes through (no re-verification) for an S2S-authenticated request', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const verifySpy = jest.spyOn(jwtService, 'verifyAsync');

    const s2sUser = {
      authUserId: 'auth-user-uuid',
      userId: 'public-user-id',
      email: 'user@example.com',
      organizationId: 'org-id',
      memberships: [],
      role: 'member',
      isActive: true,
      appMetadata: { mcp_grant_id: 'grant-id', mcp_scopes: ['profile'] },
    };
    // No Authorization header, only the S2S marker + pre-built user the
    // McpServiceTokenGuard would have attached.
    const request = {
      headers: {},
      _mcpS2s: true,
      user: s2sUser as unknown,
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    // The guard must not re-verify or overwrite the S2S-built user.
    expect(verifySpy).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- reading the jest mock fn, not invoking it bound
    expect(usersService.getUserByAuthUserId).not.toHaveBeenCalled();
    expect(request.user).toBe(s2sUser);
  });

  it('rejects protected requests when an aal1 session has a verified MFA factor', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === ALLOW_PENDING_MFA_KEY) return false;
      return false;
    });
    jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
      sub: 'auth-user-uuid',
      email: 'test@example.com',
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: 1 }],
    });
    mockSupabaseGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: 'auth-user-uuid',
          email: 'test@example.com',
          app_metadata: {},
          factors: [{ id: 'factor-id', status: 'verified' }],
        },
      },
      error: null,
    });

    const context = mockContext({
      headers: {
        authorization: `Bearer ${jwtWithPayload({
          sub: 'auth-user-uuid',
          session_id: 'session-1',
          email: 'test@example.com',
          aal: 'aal1',
          amr: [{ method: 'passkey', timestamp: 1 }],
        })}`,
      },
      path: '/api/v1/auth/bootstrap',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'MFA verification required',
    );
  });

  it('allows low-risk passkey sessions without forcing TOTP', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === ALLOW_PENDING_MFA_KEY) return false;
      return false;
    });
    jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
      sub: 'auth-user-uuid',
      session_id: 'session-1',
      email: 'test@example.com',
      aal: 'aal1',
      amr: [{ method: 'passkey', timestamp: 1 }],
    });
    (usersService.getUserByAuthUserId as jest.Mock).mockResolvedValue(mockUser);
    mockIsSessionAssured.mockResolvedValue(true);
    mockSupabaseGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: 'auth-user-uuid',
          email: 'test@example.com',
          app_metadata: {},
          factors: [
            { id: 'factor-id', factor_type: 'totp', status: 'verified' },
          ],
        },
      },
      error: null,
    });

    const context = mockContext({
      headers: {
        authorization: `Bearer ${jwtWithPayload({
          sub: 'auth-user-uuid',
          session_id: 'session-1',
          email: 'test@example.com',
          aal: 'aal1',
          amr: [{ method: 'passkey', timestamp: 1 }],
        })}`,
      },
      path: '/api/v1/auth/bootstrap',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects low-risk passkey sessions when a step-up is still pending', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === ALLOW_PENDING_MFA_KEY) return false;
      return false;
    });
    jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
      sub: 'auth-user-uuid',
      session_id: 'session-1',
      email: 'test@example.com',
      aal: 'aal1',
      amr: [{ method: 'passkey', timestamp: 1 }],
    });
    mockIsSessionAssured.mockResolvedValue(true);
    mockSupabaseGetUser.mockResolvedValueOnce({
      data: {
        user: {
          id: 'auth-user-uuid',
          email: 'test@example.com',
          app_metadata: {},
          factors: [
            { id: 'factor-id', factor_type: 'totp', status: 'verified' },
          ],
        },
      },
      error: null,
    });

    const context = mockContext({
      headers: { authorization: 'Bearer valid-token' },
      path: '/api/v1/auth/bootstrap',
    });
    context.switchToHttp().getRequest().cookies = { mfa_pending: 'true' };

    await expect(guard.canActivate(context)).rejects.toThrow(
      'MFA verification required',
    );
  });

  it('ignores an mfa_pending marker bound to a different account', async () => {
    const signMfaPendingUser = (sub: string) =>
      `${sub}.${createHmac('sha256', 'test-jwt-secret')
        .update(sub)
        .digest('hex')
        .slice(0, 16)}`;

    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === ALLOW_PENDING_MFA_KEY) return false;
      return false;
    });
    jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
      sub: 'auth-user-uuid',
      session_id: 'session-1',
      email: 'test@example.com',
      aal: 'aal1',
      amr: [{ method: 'passkey', timestamp: 1 }],
    });
    (usersService.getUserByAuthUserId as jest.Mock).mockResolvedValue(mockUser);
    mockIsSessionAssured.mockResolvedValue(true);
    mockSupabaseGetUser.mockResolvedValue({
      data: {
        user: {
          id: 'auth-user-uuid',
          email: 'test@example.com',
          app_metadata: {},
          factors: [
            { id: 'factor-id', factor_type: 'totp', status: 'verified' },
          ],
        },
      },
      error: null,
    });

    const context = mockContext({
      headers: {
        authorization: `Bearer ${jwtWithPayload({
          sub: 'auth-user-uuid',
          session_id: 'session-1',
          email: 'test@example.com',
          aal: 'aal1',
          amr: [{ method: 'passkey', timestamp: 1 }],
        })}`,
      },
      path: '/api/v1/auth/bootstrap',
    });
    const request = context.switchToHttp().getRequest<{
      cookies?: Record<string, string>;
    }>();

    request.cookies = {
      mfa_pending: 'true',
      mfa_pending_user: signMfaPendingUser('another-auth-user'),
    };
    await expect(guard.canActivate(context)).resolves.toBe(true);

    // Same marker, bound to this account: the gate must still fire.
    request.cookies = {
      mfa_pending: 'true',
      mfa_pending_user: signMfaPendingUser('auth-user-uuid'),
    };
    await expect(guard.canActivate(context)).rejects.toThrow(
      'MFA verification required',
    );
  });

  it('allows pending-MFA routes via metadata while a step-up is pending', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === ALLOW_PENDING_MFA_KEY) return true;
      return false;
    });
    jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
      sub: 'auth-user-uuid',
      email: 'test@example.com',
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: 1 }],
    });
    (usersService.getUserByAuthUserId as jest.Mock).mockResolvedValue(mockUser);

    const context = mockContext({
      headers: { authorization: 'Bearer valid-token' },
      path: '/api/v1/auth/mfa/challenge',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(mockSupabaseGetUser).not.toHaveBeenCalled();
  });

  /**
   * Origin-derived tenant fallback.
   *
   * x-tenant-slug is stamped by the Next middleware, which only sees SSR and
   * proxied requests. In SaaS production the browser calls this API origin
   * directly, so client-side XHRs carry no slug and used to fall through to the
   * ACTIVE_ORG cookie or the OLDEST membership — meaning a multi-org user's page
   * shell and its client-fetched data could disagree about the tenant.
   *
   * The fallback is deliberately additive: it is adopted only when the header is
   * absent AND the derived slug names an org the caller already belongs to.
   */
  describe('tenant resolution from Origin (multi-org split-brain fix)', () => {
    const TWO_ORGS = [
      {
        organizationId: 'org-old',
        organizationSlug: 'ambertech',
        role: 'owner',
      },
      { organizationId: 'org-new', organizationSlug: 'test-ii', role: 'owner' },
    ];

    async function runWithHeaders(headers: Record<string, string>) {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
        sub: 'auth-user-uuid',
        email: 'test@example.com',
        aal: 'aal2',
      });
      (usersService.getUserByAuthUserId as jest.Mock).mockResolvedValue(
        mockUser,
      );
      (membershipContext.loadMemberships as jest.Mock).mockResolvedValue(
        TWO_ORGS,
      );

      const request = {
        headers: { authorization: 'Bearer valid-token', ...headers },
        user: undefined as unknown,
      };
      const context = {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as unknown as ExecutionContext;

      await guard.canActivate(context);

      return (request.user as { organizationId: string }).organizationId;
    }

    it('resolves the org matching the browser Origin, not the oldest membership', async () => {
      // Without the fallback this returned 'org-old' (memberships[0]).
      expect(
        await runWithHeaders({ origin: 'https://test-ii.xisuite.cloud' }),
      ).toBe('org-new');
    });

    it('ignores an Origin naming an org the user does not belong to', async () => {
      // Must NOT resolve a foreign tenant and must NOT blank the org — behaviour
      // falls back exactly as before the change.
      expect(
        await runWithHeaders({ origin: 'https://someone-else.xisuite.cloud' }),
      ).toBe('org-old');
    });

    it('ignores reserved non-tenant subdomains', async () => {
      expect(
        await runWithHeaders({ origin: 'https://app.xisuite.cloud' }),
      ).toBe('org-old');
      expect(
        await runWithHeaders({ origin: 'https://auth.xisuite.cloud' }),
      ).toBe('org-old');
    });

    it('ignores the apex and foreign domains', async () => {
      expect(await runWithHeaders({ origin: 'https://xisuite.cloud' })).toBe(
        'org-old',
      );
      expect(
        await runWithHeaders({ origin: 'https://test-ii.evil.example' }),
      ).toBe('org-old');
    });

    it('lets an explicit x-tenant-slug header win over Origin', async () => {
      const org = await runWithHeaders({
        origin: 'https://test-ii.xisuite.cloud',
        'x-tenant-slug': 'ambertech',
      });

      expect(org).toBe('org-old');
    });

    it('falls back to the oldest membership when there is no Origin at all', async () => {
      expect(await runWithHeaders({})).toBe('org-old');
    });

    /**
     * B2 containment. `active_org_id` is a single cookie scoped to the whole
     * domain (Domain=.xisuite.cloud, Path=/), so every tenant subdomain shares
     * one slot and a value written while on tenant A used to decide requests
     * made while on tenant B.
     *
     * With the Origin fallback the cookie branch is only reached when no tenant
     * is derivable, so a stale or unreadable cookie can no longer override the
     * tenant the browser is actually on. That is what makes the shared-slot
     * cookie safe to leave as-is rather than re-scoping it (which would touch
     * login, impersonation and tenant-switch).
     */
    it('prefers the Origin tenant over a stale/unreadable active_org_id cookie', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      jest.spyOn(jwtService, 'verifyAsync').mockResolvedValue({
        sub: 'auth-user-uuid',
        email: 'test@example.com',
        aal: 'aal2',
      });
      (usersService.getUserByAuthUserId as jest.Mock).mockResolvedValue(
        mockUser,
      );
      (membershipContext.loadMemberships as jest.Mock).mockResolvedValue(
        TWO_ORGS,
      );

      const request = {
        headers: {
          authorization: 'Bearer valid-token',
          origin: 'https://test-ii.xisuite.cloud',
        },
        // Shared domain-wide slot still pointing at the OTHER tenant.
        cookies: { active_org_id: 'org-old.deadbeefdeadbeef' },
        user: undefined as unknown,
      };
      const context = {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as unknown as ExecutionContext;

      await guard.canActivate(context);

      expect((request.user as { organizationId: string }).organizationId).toBe(
        'org-new',
      );
    });
  });
});

function jwtWithPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return `${header}.${encoded}.signature`;
}
