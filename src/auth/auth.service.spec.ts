import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService, isRefreshRejection } from './auth.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { UsersService } from '../users/users.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

describe('AuthService', () => {
  let service: AuthService;
  let mockGenerateLink: jest.Mock;
  let mockSignInWithPassword: jest.Mock;
  let mockRefreshSession: jest.Mock;
  let mockGetUserByEmail: jest.Mock;
  let mockGetUserByAuthUserId: jest.Mock;
  let mockGetUser: jest.Mock;
  let mockIsSessionAssured: jest.Mock;
  let mockEvaluate: jest.Mock;
  let mockIn: jest.Mock;
  let mockGetUserSpaces: jest.Mock;
  let mockGetBranding: jest.Mock;
  let mockGetUserEffectivePermissions: jest.Mock;
  let mockGetMenuPermissions: jest.Mock;

  beforeEach(() => {
    mockGenerateLink = jest.fn();
    mockSignInWithPassword = jest.fn();
    mockRefreshSession = jest.fn();
    mockGetUser = jest.fn();
    mockIsSessionAssured = jest.fn().mockResolvedValue(false);
    mockEvaluate = jest.fn().mockResolvedValue(null);
    mockIn = jest.fn().mockResolvedValue({ data: [], error: null });
    mockGetUserSpaces = jest.fn().mockResolvedValue([]);
    mockGetBranding = jest.fn();
    mockGetUserEffectivePermissions = jest.fn();
    mockGetMenuPermissions = jest.fn();

    (createClient as jest.Mock).mockReturnValue({
      auth: {
        getUser: mockGetUser,
      },
    });

    const supabaseAdmin = {
      createAuthClient: () => ({
        auth: {
          signInWithPassword: mockSignInWithPassword,
          refreshSession: mockRefreshSession,
        },
      }),
      getClient: () => ({
        auth: {
          admin: { generateLink: mockGenerateLink },
        },
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          in: mockIn,
          maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    } as unknown as SupabaseAdminService;

    mockGetUserByEmail = jest.fn();
    mockGetUserByAuthUserId = jest.fn();
    const usersService = {
      getUserByEmail: mockGetUserByEmail,
      getUserByAuthUserId: mockGetUserByAuthUserId,
    } as unknown as UsersService;

    const configService = {
      get: jest.fn().mockReturnValue('http://localhost:3000'),
    } as unknown as ConfigService;

    service = new AuthService(
      supabaseAdmin,
      usersService,
      configService,
      { getUserSpaces: mockGetUserSpaces } as any,
      { getBranding: mockGetBranding } as any,
      {
        getUserEffectivePermissions: mockGetUserEffectivePermissions,
        getMenuPermissions: mockGetMenuPermissions,
      } as any,
      {} as any,
      {} as any,
      { ensureDefaultMembership: jest.fn() } as any,
      {} as any,
      { evaluate: mockEvaluate } as any,
      { isSessionAssured: mockIsSessionAssured } as any,
    );
  });

  describe('signin', () => {
    it('marks MFA required when AAL can be upgraded after password sign-in', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: {
          session: {
            access_token: jwtWithAal('aal1'),
            refresh_token: 'refresh-token',
            expires_in: 3600,
          },
          user: {
            id: 'auth-user-id',
            email: 'mfa@example.com',
            user_metadata: {},
          },
        },
        error: null,
      });
      mockGetUserByAuthUserId.mockResolvedValue({
        id: 'public-user-id',
        first_name: 'Mfa',
        last_name: 'User',
      });
      mockGetUser.mockResolvedValue({
        data: {
          user: {
            id: 'auth-user-id',
            factors: [
              {
                id: 'factor-id',
                factor_type: 'totp',
                status: 'verified',
              },
            ],
          },
        },
        error: null,
      });

      const result = await service.signin('mfa@example.com', 'password');

      expect(result.mfaRequired).toBe(true);
      expect(result.currentLevel).toBe('aal1');
      expect(result.nextLevel).toBe('aal2');
    });

    it('does not require MFA when AAL cannot be upgraded', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: {
          session: {
            access_token: jwtWithAal('aal1'),
            refresh_token: 'refresh-token',
            expires_in: 3600,
          },
          user: {
            id: 'auth-user-id',
            email: 'plain@example.com',
            user_metadata: {},
          },
        },
        error: null,
      });
      mockGetUserByAuthUserId.mockResolvedValue(null);
      mockGetUser.mockResolvedValue({
        data: {
          user: {
            id: 'auth-user-id',
            factors: [],
          },
        },
        error: null,
      });

      const result = await service.signin('plain@example.com', 'password');

      expect(result.mfaRequired).toBe(false);
      expect(result.currentLevel).toBe('aal1');
      expect(result.nextLevel).toBe('aal1');
    });

    it('skips TOTP only when the passkey session is server-assured', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: {
          session: {
            access_token: jwtWithPayload({
              sub: 'auth-user-id',
              session_id: 'session-1',
              aal: 'aal1',
              amr: [{ method: 'passkey', timestamp: 1 }],
            }),
            refresh_token: 'refresh-token',
            expires_in: 3600,
          },
          user: {
            id: 'auth-user-id',
            email: 'passkey@example.com',
            user_metadata: {},
          },
        },
        error: null,
      });
      mockGetUserByAuthUserId.mockResolvedValue(null);
      mockIsSessionAssured.mockResolvedValue(true);
      mockGetUser.mockResolvedValue({
        data: {
          user: {
            id: 'auth-user-id',
            factors: [
              {
                id: 'factor-id',
                factor_type: 'totp',
                status: 'verified',
              },
            ],
          },
        },
        error: null,
      });

      const result = await service.signin('passkey@example.com', 'password');

      expect(result.mfaRequired).toBe(false);
      expect(result.currentLevel).toBe('aal1');
      expect(result.nextLevel).toBe('aal2');
    });

    it('fails closed when MFA assurance lookup fails after password sign-in', async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: {
          session: {
            access_token: jwtWithAal('aal1'),
            refresh_token: 'refresh-token',
            expires_in: 3600,
          },
          user: {
            id: 'auth-user-id',
            email: 'mfa@example.com',
            user_metadata: {},
          },
        },
        error: null,
      });
      mockGetUserByAuthUserId.mockResolvedValue(null);
      mockGetUser.mockResolvedValue({
        data: { user: null },
        error: { message: 'AAL lookup failed' },
      });

      await expect(
        service.signin('mfa@example.com', 'password'),
      ).rejects.toThrow('Unable to verify MFA requirement. Please try again.');
    });
  });

  describe('refreshToken', () => {
    const session = {
      access_token: 'a',
      refresh_token: 'r2',
      expires_in: 3600,
    };

    it('returns the rotated pair', async () => {
      mockRefreshSession.mockResolvedValue({ data: { session }, error: null });

      await expect(service.refreshToken('r1')).resolves.toMatchObject({
        access_token: 'a',
        refresh_token: 'r2',
      });
    });

    it('answers 401 only when Auth rejects the token itself', async () => {
      mockRefreshSession.mockResolvedValue({
        data: { session: null },
        error: { status: 400, message: 'Invalid Refresh Token: Already Used' },
      });

      await expect(service.refreshToken('r1')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it.each([
      [{ status: 500, message: 'database not accepting connections' }],
      [{ status: 504, message: 'context deadline exceeded' }],
      [{ status: 0, message: 'fetch failed' }],
      [{ status: 429, message: 'rate limited' }],
    ])('answers 503, not 401, when Auth is unavailable (%o)', async (error) => {
      mockRefreshSession.mockResolvedValue({
        data: { session: null },
        error,
      });

      await expect(service.refreshToken('r1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('answers 503 when the Auth call throws', async () => {
      mockRefreshSession.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.refreshToken('r1')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('classifies statuses', () => {
      expect(isRefreshRejection({ status: 400 })).toBe(true);
      expect(isRefreshRejection({ status: 401 })).toBe(true);
      expect(isRefreshRejection({ status: 408 })).toBe(false);
      expect(isRefreshRejection({})).toBe(false);
    });
  });

  describe('signup', () => {
    it('should return email and OTP on success', async () => {
      mockGenerateLink.mockResolvedValue({
        data: { properties: { email_otp: '123456' } },
        error: null,
      });

      const result = await service.signup({
        firstName: 'Test',
        lastName: 'User',
        email: 'test@example.com',
        password: 'password123',
      });

      expect(result.email).toBe('test@example.com');
      expect(result.otp).toBe('123456');
    });

    it('should return email without OTP when user already confirmed', async () => {
      mockGenerateLink.mockResolvedValue({
        data: { properties: {} },
        error: null,
      });

      const result = await service.signup({
        firstName: 'Test',
        lastName: 'User',
        email: 'test@example.com',
        password: 'password123',
      });

      expect(result.email).toBe('test@example.com');
      expect(result.otp).toBeUndefined();
    });

    it('should throw generic BadRequestException on error', async () => {
      mockGenerateLink.mockResolvedValue({
        data: null,
        error: { message: 'Internal constraint violation' },
      });

      await expect(
        service.signup({
          firstName: 'T',
          lastName: 'U',
          email: 'test@example.com',
          password: 'pass',
        }),
      ).rejects.toThrow('Failed to create account. Please try again.');
    });

    const doSignup = () =>
      service.signup({
        firstName: 'T',
        lastName: 'U',
        email: 'test@example.com',
        password: 'pass',
      });

    // A closed-enterprise instance (GOTRUE_DISABLE_SIGNUP=true, the on-prem default)
    // is a property of the DEPLOYMENT, not of the account — naming it leaks nothing and
    // saves an operator from needing shell access to read the backend log.
    it.each(['Signups not allowed for this instance', 'Signup is disabled'])(
      'reports disabled signups distinctly: %s',
      async (message) => {
        mockGenerateLink.mockResolvedValue({ data: null, error: { message } });
        await expect(doSignup()).rejects.toMatchObject({
          status: 403,
          response: { code: 'signups_disabled' },
        });
      },
    );

    it('passes through the password-policy message', async () => {
      mockGenerateLink.mockResolvedValue({
        data: null,
        error: { message: 'Password should be at least 8 characters' },
      });
      await expect(doSignup()).rejects.toMatchObject({
        status: 400,
        response: { code: 'weak_password' },
      });
    });

    // SECURITY: /auth/signup is unauthenticated. If an existing account produced a
    // distinguishable response, the endpoint would become an account-enumeration oracle.
    // This must stay indistinguishable from any other failure.
    it.each([
      'User already registered',
      'A user with this email address has already been registered',
      'Database error saving new user',
    ])('does NOT leak account existence: %s', async (message) => {
      mockGenerateLink.mockResolvedValue({ data: null, error: { message } });
      await expect(doSignup()).rejects.toThrow(
        'Failed to create account. Please try again.',
      );
    });
  });

  describe('resendVerification', () => {
    /**
     * resendVerification now calls Supabase's GoTrue REST endpoint
     * (`POST /auth/v1/resend`) via `fetch` instead of `generateLink`.
     * On success it marks the delivery as handled because the OTP itself is
     * delivered via Supabase's email templates and is not exposed back to the caller.
     */
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('marks delivery as handled when Supabase accepts the resend', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(''),
      }) as unknown as typeof fetch;

      const result = await service.resendVerification('test@example.com');
      expect(result).toEqual({ deliveredBySupabase: true });
    });

    it('should suppress error and return undefined OTP on non-OK response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValue('User not found'),
      }) as unknown as typeof fetch;

      const result = await service.resendVerification('bad@example.com');
      expect(result.otp).toBeUndefined();
    });
  });

  describe('forgotPassword', () => {
    it('should return resetLink and firstName', async () => {
      mockGenerateLink.mockResolvedValue({
        data: { properties: { action_link: 'https://example.com/reset' } },
        error: null,
      });
      mockGetUserByEmail.mockResolvedValue({ first_name: 'Prince' });

      const result = await service.forgotPassword('prince@example.com');
      expect(result.resetLink).toBe('https://example.com/reset');
      expect(result.firstName).toBe('Prince');
    });

    it('should return empty object on error', async () => {
      mockGenerateLink.mockResolvedValue({
        data: null,
        error: { message: 'User not found' },
      });

      const result = await service.forgotPassword('bad@example.com');
      expect(result).toEqual({});
    });
  });

  describe('bootstrap', () => {
    const profile = { id: 'u1', email: 'member@example.com' };

    it('withholds workspace data when the session must re-authenticate through SSO', async () => {
      mockGetUserByAuthUserId.mockResolvedValue(profile);
      mockEvaluate.mockResolvedValue({ connectionId: 'c1' });
      mockIn.mockResolvedValue({
        data: [{ id: 'org-1', slug: 'acme', name: 'Acme' }],
        error: null,
      });
      const user = {
        authUserId: 'auth-1',
        userId: 'u1',
        email: 'member@example.com',
        organizationId: 'org-1',
        memberships: [
          {
            organizationId: 'org-1',
            organizationSlug: 'acme',
            role: 'member' as const,
          },
        ],
      };

      const result = await service.bootstrap(user, 'token');

      expect(mockEvaluate).toHaveBeenCalledWith(user, 'token', {
        isMcpS2s: false,
      });
      expect(result.ssoRequired).toEqual({ connectionId: 'c1' });
      expect(result.spaces).toEqual([]);
      expect(result.default_space).toBeNull();
      expect(result.permissions).toEqual({ effective: null, menu: null });
      expect(result.entitlements).toBeNull();
      expect(result.activeOrganization).toEqual({
        id: 'org-1',
        slug: 'acme',
        name: 'Acme',
        branding: null,
        role: 'member',
      });
      expect(result.memberships).toHaveLength(1);
      expect(mockGetUserSpaces).not.toHaveBeenCalled();
      expect(mockGetUserEffectivePermissions).not.toHaveBeenCalled();
      expect(mockGetMenuPermissions).not.toHaveBeenCalled();
      expect(mockGetBranding).not.toHaveBeenCalled();
    });

    it('returns ssoRequired null when the session satisfies Require SSO', async () => {
      mockGetUserByAuthUserId.mockResolvedValue(profile);

      const result = await service.bootstrap(
        {
          authUserId: 'auth-1',
          userId: 'u1',
          email: 'member@example.com',
          organizationId: '',
          memberships: [],
        },
        'token',
      );

      expect(result.ssoRequired).toBeNull();
      expect(mockGetUserSpaces).toHaveBeenCalled();
    });
  });
});

function jwtWithAal(aal: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify({ aal })).toString('base64url');

  return `${header}.${payload}.signature`;
}

function jwtWithPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return `${header}.${encoded}.signature`;
}
