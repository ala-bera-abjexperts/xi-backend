/**
 * @fileoverview Core authentication service that wraps Supabase Auth operations.
 * Handles signup, signin, OTP verification, token refresh, signout, password management,
 * and profile retrieval. All methods use the admin Supabase client.
 * @module src/auth/auth.service
 * @author Prince Jadiya
 */

import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
  Inject,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { OnPremiseTenantService } from '../on-premise/on-premise-tenant.service';
import { MembershipContextService } from './services/membership-context.service';
import { UsersService } from '../users/users.service';
import { SpacesService, type Space } from '../spaces/spaces.service';
import {
  OrganizationsService,
  type OrganizationBranding,
} from '../organizations/organizations.service';
import {
  PermissionsService,
  type IMenuPermission,
} from '../permissions/permissions.service';
import type { IUserEffectivePermissions } from '../permissions/models/access-control.model';
import type {
  SigninResponse,
  TokenResponse,
  SignupResult,
  OtpResult,
  ForgotPasswordResult,
  ProfileResponse,
} from './interfaces/auth-response.interface';
import type { RequestUser } from './interfaces/request-user.interface';
import { SsoEnforcementService } from './sso-enforcement.service';
import { ImpersonationService } from '../impersonation/impersonation.service';
import type { ImpersonationEnvelope } from '../impersonation/impersonation.service';
import { EntitlementsService } from '../licensing/entitlements.service';
import type { EntitlementsSnapshot } from '../licensing/entitlements.service';
import {
  PASSKEY_SESSION_ASSURANCE,
  type PasskeySessionAssuranceReader,
} from './passkeys/passkey-session-assurance.port';
import {
  deriveSessionMfaState,
  getSessionAssuranceTokenPayload,
  normalizeAuthenticationMethods,
  type SessionMfaState,
} from './mfa/session-assurance.util';

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';

type DefaultOrganization = {
  id: string;
  slug: string;
  name: string;
  role: OrganizationRole;
};

type LegacyOrganizationMembership = {
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  role: OrganizationRole;
};

type TenantMembership = LegacyOrganizationMembership & {
  slug: string;
  name: string;
};

type OrganizationRow = Record<string, unknown> & {
  id: string;
  slug: string;
  name: string;
  default_space_id?: string | null;
};

type ActiveOrganization = OrganizationRow & {
  branding: OrganizationBranding | null;
  role: OrganizationRole;
};

type BootstrapSpace = Space & {
  is_starred: boolean;
  enabled_modules: string[];
};

type BootstrapPermissions = {
  effective: IUserEffectivePermissions | null;
  menu: IMenuPermission[] | null;
};

/**
 * Service responsible for all authentication operations against Supabase Auth.
 *
 * Uses the admin Supabase client ({@link SupabaseAdminService}) for elevated operations
 * like generating signup links, managing passwords, and invalidating sessions.
 *
 * @example
 * // Inject in a controller:
 * constructor(private readonly authService: AuthService) {}
 *
 * const result = await this.authService.signin('user@example.com', 'password');
 */
@Injectable()
export class AuthService {
  /** @private Logger instance scoped to this service */
  private readonly logger = new Logger(AuthService.name);

  /**
   * @param {SupabaseAdminService} supabaseAdmin - Admin Supabase client for auth operations
   * @param {UsersService} usersService - Service for resolving user profiles from the public users table
   * @param {ConfigService} configService - Config service for reading application URLs
   * @param {SpacesService} spacesService - Used by `bootstrap()` to load the user's spaces
   * @param {OrganizationsService} organizationsService - Used by `bootstrap()` to load the user's org
   * @param {PermissionsService} permissionsService - Used by `bootstrap()` to load effective + menu permissions
   * @param {OnPremiseTenantService} onPremiseTenant - On-prem single-tenant auto-join (no-op in SaaS)
   */
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
    private readonly spacesService: SpacesService,
    private readonly organizationsService: OrganizationsService,
    private readonly permissionsService: PermissionsService,
    private readonly impersonationService: ImpersonationService,
    private readonly entitlementsService: EntitlementsService,
    private readonly onPremiseTenant: OnPremiseTenantService,
    private readonly membershipContext: MembershipContextService,
    private readonly ssoEnforcement: SsoEnforcementService,
    @Optional()
    @Inject(PASSKEY_SESSION_ASSURANCE)
    private readonly passkeySessionAssurance?: PasskeySessionAssuranceReader,
  ) {}

  // ── Login lockout (H13) ────────────────────────────────────────────────────
  // Durable, multi-instance per-account lockout backing the per-IP throttle, so
  // an attacker can't brute-force one account by rotating IPs. Bookkeeping
  // failures never block the auth flow.
  private static readonly MAX_FAILED_ATTEMPTS = 5;
  private static readonly LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
  private static readonly ATTEMPTS_TABLE = 'auth_login_attempts';

  /** Throw 429 if the account is currently locked out from too many failures. */
  private async assertNotLockedOut(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const { data } = await this.supabaseAdmin
      .getClient()
      .from(AuthService.ATTEMPTS_TABLE)
      .select('locked_until')
      .eq('email', normalized)
      .maybeSingle();

    const lockedUntil = (data as { locked_until: string | null } | null)
      ?.locked_until;

    if (lockedUntil && new Date(lockedUntil).getTime() > Date.now()) {
      const retryAfterSeconds = Math.ceil(
        (new Date(lockedUntil).getTime() - Date.now()) / 1000,
      );

      throw new HttpException(
        {
          message: 'Too many failed attempts. Please wait and try again.',
          code: 'account_locked',
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Record a failed attempt; lock the account once the threshold is reached. */
  private async recordLoginFailure(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();

    try {
      const client = this.supabaseAdmin.getClient();
      const { data } = await client
        .from(AuthService.ATTEMPTS_TABLE)
        .select('failed_count')
        .eq('email', normalized)
        .maybeSingle();

      const nextCount =
        ((data as { failed_count: number } | null)?.failed_count ?? 0) + 1;
      const lockedUntil =
        nextCount >= AuthService.MAX_FAILED_ATTEMPTS
          ? new Date(Date.now() + AuthService.LOCK_DURATION_MS).toISOString()
          : null;

      await client.from(AuthService.ATTEMPTS_TABLE).upsert(
        {
          email: normalized,
          failed_count: nextCount,
          locked_until: lockedUntil,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'email' },
      );
    } catch (err) {
      this.logger.warn(
        `recordLoginFailure failed for ${normalized}: ${(err as Error).message}`,
      );
    }
  }

  /** Clear the failure counter after a successful authentication. */
  private async clearLoginAttempts(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();

    try {
      await this.supabaseAdmin
        .getClient()
        .from(AuthService.ATTEMPTS_TABLE)
        .delete()
        .eq('email', normalized);
    } catch (err) {
      this.logger.warn(
        `clearLoginAttempts failed for ${normalized}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Registers a new user via Supabase Auth admin `generateLink` and returns the OTP for email verification.
   *
   * The database trigger `handle_new_user` automatically creates the `public.users` profile row
   * when the Supabase auth user is created.
   *
   * @param {object} data - Signup data
   * @param {string} data.firstName - User's first name
   * @param {string} data.lastName - User's last name
   * @param {string} data.email - User's email address
   * @param {string} data.password - User's password (min 6 characters)
   * @returns {Promise<SignupResult>} The email and optional OTP code
   * @throws {BadRequestException} When Supabase fails to create the account
   */
  async signup(data: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
  }): Promise<SignupResult> {
    const client = this.supabaseAdmin.getClient();

    const { data: resData, error } = await client.auth.admin.generateLink({
      type: 'signup',
      email: data.email,
      password: data.password,
      options: {
        data: {
          first_name: data.firstName,
          last_name: data.lastName,
          full_name: `${data.firstName} ${data.lastName}`.trim(),
        },
      },
    });

    if (error) {
      this.logger.error(`Signup error: ${error.message}`);

      // Distinguish CONFIGURATION failures from user-specific ones.
      //
      // Every GoTrue failure used to collapse into one generic message, so diagnosing a
      // signup outage required shell access to read this log line — on an on-premise box
      // that is often a different company. The two cases below are properties of the
      // INSTANCE, not of the account being created, so naming them leaks nothing and
      // turns a support round-trip into a self-service fix.
      //
      // Everything else deliberately keeps the generic message. In particular
      // "User already registered" must NEVER be surfaced: /auth/signup is unauthenticated,
      // so a distinguishable response would make it an account-enumeration oracle.
      const raw = (error.message || '').toLowerCase();

      if (
        raw.includes('signups not allowed') ||
        raw.includes('signup is disabled')
      ) {
        throw new ForbiddenException({
          message:
            'Registration is disabled on this instance. Ask an administrator to invite you.',
          code: 'signups_disabled',
        });
      }

      if (raw.includes('password')) {
        // GoTrue's own policy text (length/strength). Says nothing about the account.
        throw new BadRequestException({
          message: error.message,
          code: 'weak_password',
        });
      }

      throw new BadRequestException(
        'Failed to create account. Please try again.',
      );
    }

    return {
      email: data.email,
      otp: resData.properties?.email_otp,
    };
  }

  /**
   * Authenticates a user with email and password, returning JWT tokens and user profile.
   *
   * @param {string} email - The user's email address
   * @param {string} password - The user's password
   * @returns {Promise<SigninResponse>} Access token, refresh token, and user profile
   * @throws {UnauthorizedException} When credentials are invalid or no session is created
   */
  async signin(email: string, password: string): Promise<SigninResponse> {
    // SECURITY (H13): per-account lockout on top of the per-IP throttle.
    await this.assertNotLockedOut(email);

    const client = this.supabaseAdmin.createAuthClient();

    const { data, error } = await client.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.session) {
      await this.recordLoginFailure(email);
      this.logger.warn(`Sign-in failed for ${email}: ${error?.message}`);

      // Preserve the distinct email-not-confirmed error code so the frontend
      // can show the "Resend verification" CTA. Collapsing it to "Invalid email
      // or password" silently broke that branch in Login.tsx.
      const lower = (error?.message ?? '').toLowerCase();

      if (
        error?.code === 'email_not_confirmed' ||
        lower.includes('email not confirmed')
      ) {
        throw new UnauthorizedException({
          message: 'Email not confirmed',
          code: 'email_not_confirmed',
        });
      }

      throw new UnauthorizedException('Invalid email or password');
    }

    // Successful auth — reset the failure counter.
    await this.clearLoginAttempts(email);

    const publicUser = await this.usersService.getUserByAuthUserId(
      data.user.id,
    );
    const mfaState = await this.getSigninMfaState(data.session.access_token);

    // Load memberships + compute default tenant so the frontend can land
    // the user on `{defaultSlug}.{root}/` without a follow-up bootstrap call.
    //
    // Sentinel contract for the response field (`defaultOrganization`):
    //   - undefined  → query failed / publicUser missing. Frontend falls
    //                  back to its existing redirectToTenantAfterAuth
    //                  (which does its own bootstrap call).
    //   - null       → query succeeded, user has confirmed-zero memberships.
    //                  Frontend redirects to /onboarding.
    //   - object     → fast path. Frontend hard-navigates to tenantUrl().
    //
    // Conflating undefined and null was a bug: a transient DB failure
    // would have sent fully-onboarded users to /onboarding.
    let defaultOrganization: SigninResponse['defaultOrganization'] = undefined;
    let allOrganizationsDeactivated = false;

    if (publicUser?.id) {
      try {
        // On-premise is single-tenant. A self-service signup creates auth.users +
        // public.users but NEVER an organization_members row, so without this the
        // query below returns nothing, defaultOrganization becomes null, and the
        // user is sent to /onboarding to create a SECOND organization on a
        // deployment meant to have exactly one. No-op in SaaS (onPrem.enabled
        // false), and idempotent, so it is safe on every login.
        await this.onPremiseTenant.ensureDefaultMembership(
          publicUser.id,
          publicUser.email,
        );

        const adminClient = this.supabaseAdmin.getClient();
        const { data: rows, error: membershipsErr } = await adminClient
          .from('organization_members')
          .select('role, organizations!inner(id, slug, name, is_active)')
          .eq('user_id', publicUser.id)
          .order('created_at', { ascending: true });

        if (!membershipsErr && rows) {
          // Split memberships by org status. The default-tenant redirect must
          // only ever consider ACTIVE orgs; a user whose every org has been
          // deactivated is fully onboarded but locked out and gets the
          // "all organizations deactivated" dialog (allOrganizationsDeactivated)
          // rather than being sent to a dead tenant or to /onboarding.
          const allMemberships = rows
            .map((row) => {
              const org = row.organizations as {
                id?: string;
                slug?: string;
                name?: string;
                is_active?: boolean | null;
              } | null;

              if (!org?.id || !org.slug || !org.name) return null;

              return {
                organizationId: org.id,
                organizationSlug: org.slug,
                organizationName: org.name,
                isActive: org.is_active !== false,
                role: row.role as 'owner' | 'admin' | 'member' | 'viewer',
              };
            })
            .filter((m): m is NonNullable<typeof m> => m !== null);

          const activeMemberships = allMemberships.filter((m) => m.isActive);

          if (activeMemberships.length > 0) {
            defaultOrganization =
              this.computeDefaultOrganization(activeMemberships);
          } else if (allMemberships.length > 0) {
            // Has memberships, but all are deactivated.
            defaultOrganization = null;
            allOrganizationsDeactivated = true;
          } else {
            // Genuinely zero memberships → onboarding.
            defaultOrganization = null;
          }
        }
        // membershipsErr → defaultOrganization stays undefined (query failed)
      } catch (err) {
        this.logger.warn(
          `signin.defaultOrganization computation failed for ${email}: ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        );
        // stays undefined → frontend falls back to bootstrap
      }
    }

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      token_type: 'bearer',
      mfaRequired: mfaState.mfaRequired,
      currentLevel: mfaState.currentLevel,
      nextLevel: mfaState.nextLevel,
      authenticationMethod: mfaState.authenticationMethod,
      stepUpReason: mfaState.stepUpReason,
      recentTotpRequired: mfaState.recentTotpRequired,
      user: {
        id: publicUser?.id || data.user.id,
        email: data.user.email || email,
        first_name:
          publicUser?.first_name ||
          (data.user.user_metadata?.first_name as string) ||
          null,
        last_name:
          publicUser?.last_name ||
          (data.user.user_metadata?.last_name as string) ||
          null,
      },
      defaultOrganization,
      allOrganizationsDeactivated,
    };
  }

  /**
   * Pick the user's "owner-first, oldest-otherwise" default tenant.
   *
   * `memberships` MUST already be ordered by `created_at ASC` (which the
   * SupabaseAuthGuard and the inline signin query both do). Returns `null`
   * only when the user has zero memberships.
   */
  private computeDefaultOrganization(
    memberships: LegacyOrganizationMembership[],
  ): DefaultOrganization | null {
    if (memberships.length === 0) return null;

    const winner =
      memberships.find((m) => m.role === 'owner') ?? memberships[0];

    return {
      id: winner.organizationId,
      slug: winner.organizationSlug,
      name: winner.organizationName,
      role: winner.role,
    };
  }

  private async getSigninMfaState(
    accessToken: string,
  ): Promise<SessionMfaState> {
    return this.getTokenMfaState(accessToken);
  }

  async getTokenMfaState(
    accessToken: string,
    options: { forceMfa?: boolean } = {},
  ): Promise<SessionMfaState> {
    const tokenPayload = getSessionAssuranceTokenPayload(accessToken);

    try {
      const client = this.userClientFor(accessToken);
      const {
        data: { user },
        error,
      } = await client.auth.getUser();

      if (error) {
        this.logger.warn(
          `MFA AAL lookup after signin failed: ${error.message}`,
        );
        throw new UnauthorizedException(
          'Unable to verify MFA requirement. Please try again.',
        );
      }

      if (!user) {
        this.logger.warn('MFA AAL lookup after signin returned no data');
        throw new UnauthorizedException(
          'Unable to verify MFA requirement. Please try again.',
        );
      }

      const passkeyAssured = await this.resolvePasskeySessionAssurance(
        accessToken,
        tokenPayload,
      );

      return deriveSessionMfaState({
        accessToken,
        factors: user.factors,
        passkeyAssured,
        forceMfa: options.forceMfa,
      });
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;

      this.logger.warn(
        `MFA AAL lookup after signin failed: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
      throw new UnauthorizedException(
        'Unable to verify MFA requirement. Please try again.',
      );
    }
  }

  private userClientFor(accessToken: string): SupabaseClient<any, any> {
    const url = this.configService.get<string>('supabase.url');
    const anonKey = this.configService.get<string>('supabase.anonKey');

    if (!url || !anonKey) {
      throw new Error('Supabase URL/anonKey not configured');
    }

    return createClient(url, anonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  private async resolvePasskeySessionAssurance(
    accessToken: string,
    tokenPayload: ReturnType<typeof getSessionAssuranceTokenPayload>,
  ): Promise<boolean> {
    const authUserId =
      typeof tokenPayload?.sub === 'string' ? tokenPayload.sub : null;
    const sessionId =
      typeof tokenPayload?.session_id === 'string'
        ? tokenPayload.session_id
        : null;
    const methods = normalizeAuthenticationMethods(tokenPayload?.amr);

    if (!methods.some((method) => method.method.toLowerCase() === 'passkey')) {
      return false;
    }

    if (!authUserId || !sessionId || !this.passkeySessionAssurance) {
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

  /**
   * Verifies an email OTP code and returns JWT tokens upon success.
   *
   * @param {string} email - The email address to verify
   * @param {string} token - The OTP code sent to the user's email
   * @returns {Promise<TokenResponse>} Access token and refresh token
   * @throws {BadRequestException} When the OTP is invalid or expired
   */
  async verifyOtp(email: string, token: string): Promise<TokenResponse> {
    // SECURITY (H13): lock out brute-force of the 6-digit OTP per account.
    await this.assertNotLockedOut(email);

    const client = this.supabaseAdmin.createAuthClient();

    const { data, error } = await client.auth.verifyOtp({
      email,
      token,
      type: 'email',
    });

    if (error || !data.session) {
      await this.recordLoginFailure(email);
      this.logger.warn(
        `OTP verification failed for ${email}: ${error?.message}`,
      );
      throw new BadRequestException('Invalid or expired verification code');
    }

    await this.clearLoginAttempts(email);

    // On-premise single-tenant auto-join. THIS is the signup path: a new user
    // goes signup -> verifyOtp -> dashboard and never passes through signin(),
    // so joining only there left every fresh account with zero memberships and
    // staring at "create your organization".
    //
    // It must happen HERE, before these tokens are used, rather than in
    // bootstrap(): bootstrap reads user.memberships off RequestUser, which the
    // auth guard computed while validating the JWT — i.e. before the handler
    // runs. Joining later would leave the CURRENT request unchanged and only
    // take effect after a refresh, which reads as an intermittent bug.
    //
    // ensureDefaultMembership takes public.users.id, NOT the GoTrue auth id, so
    // the profile has to be resolved first. No-op off-premise.
    try {
      const profile = await this.usersService.getUserByAuthUserId(
        data.user?.id ?? '',
      );

      if (profile?.id) {
        await this.onPremiseTenant.ensureDefaultMembership(profile.id, email);
      }
    } catch (err) {
      // Never fail OTP verification over tenant plumbing — the user is
      // authenticated either way, and bootstrap()'s net catches them.
      this.logger.warn(
        `verifyOtp auto-join skipped for ${email}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      token_type: 'bearer',
    };
  }

  /**
   * Exchanges a refresh token for a new access token and refresh token pair.
   *
   * @param {string} refreshToken - The refresh token from a previous sign-in or refresh
   * @returns {Promise<TokenResponse>} New access token and refresh token
   * @throws {UnauthorizedException} When the refresh token is invalid or expired
   * @throws {ServiceUnavailableException} When Supabase Auth cannot answer (5xx, timeout, network,
   *   rate limit): the token may still be valid, so callers must not treat this as a logout.
   */
  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    const client = this.supabaseAdmin.createAuthClient();

    let result: Awaited<ReturnType<typeof client.auth.refreshSession>>;

    try {
      result = await client.auth.refreshSession({
        refresh_token: refreshToken,
      });
    } catch (thrown) {
      this.logger.error(
        `Token refresh unavailable: ${thrown instanceof Error ? thrown.message : 'unknown error'}`,
      );
      throw new ServiceUnavailableException(
        'Authentication is temporarily unavailable',
      );
    }

    const { data, error } = result;

    if (error && !isRefreshRejection(error)) {
      this.logger.error(`Token refresh unavailable: ${error.message}`);
      throw new ServiceUnavailableException(
        'Authentication is temporarily unavailable',
      );
    }

    if (error || !data.session) {
      this.logger.warn(`Token refresh failed: ${error?.message}`);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      token_type: 'bearer',
    };
  }

  /**
   * Signs out a user by invalidating their session(s) via Supabase admin.
   *
   * @param {string} jwt - The current Supabase access JWT.
   * @param {'local' | 'global' | 'others'} [scope='local'] - Session scope to revoke.
   *   `'local'` revokes only the current refresh token; `'global'` revokes ALL of this
   *   user's sessions across devices; `'others'` revokes all but the current.
   * @returns {Promise<void>}
   */
  async signout(
    jwt: string,
    scope: 'local' | 'global' | 'others' = 'local',
  ): Promise<void> {
    const client = this.supabaseAdmin.getClient();
    await client.auth.admin.signOut(jwt, scope);
  }

  /**
   * Exchanges a Supabase one-time auth code (from a password-reset / invite email link
   * or an OAuth callback) for an access + refresh token pair.
   *
   * @param {string} code - The one-time auth code from the Supabase email link / OAuth callback
   * @returns {Promise<TokenResponse>} New token pair
   * @throws {BadRequestException} When the code is invalid or expired
   */
  async exchangeCodeForSession(code: string): Promise<TokenResponse> {
    const client = this.supabaseAdmin.createAuthClient();

    const { data, error } = await client.auth.exchangeCodeForSession(code);

    if (error || !data.session) {
      this.logger.warn(`Code exchange failed: ${error?.message}`);
      throw new BadRequestException('Invalid or expired code');
    }

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      token_type: 'bearer',
    };
  }

  /**
   * Aggregates the data needed to bootstrap a user session on the frontend.
   * Returns the user, the ACTIVE organization (with branding metadata), the
   * full list of memberships (for the tenant switcher), the user's spaces in
   * the active org, and effective + menu permissions in one round-trip.
   *
   * Replaces the 3-4 separate calls (`/auth/me`, `/permissions/effective`,
   * `/permissions/menu`, `/spaces`) the Next.js frontend previously made on
   * every dashboard load.
   *
   * Each underlying call is wrapped in a try/catch so a failure in one slice
   * (e.g., user has no spaces yet during onboarding) does not poison the
   * whole bootstrap.
   *
   * Shape change (Prompt 02 of the multi-tenant migration):
   *   - `organization` is preserved as a LEGACY alias for `activeOrganization`
   *     so the existing Next.js consumer keeps rendering until Prompt 04
   *     migrates it. Remove once the frontend reads `activeOrganization`.
   *   - `activeOrganization` is the single org the user is currently scoped
   *     to (matches `active_org_id` cookie / first membership).
   *   - `memberships` is the full list (excluding the active org's own
   *     `RequestUserMembership` is intentional — consumers usually iterate
   *     all memberships including the active one for the switcher UI).
   *
   * @param {RequestUser} user - The authenticated user (from the auth guard)
   * @returns {Promise<object>} The aggregated bootstrap payload
   */
  async bootstrap(
    user: RequestUser,
    accessToken: string | null = null,
  ): Promise<{
    user: ProfileResponse;
    activeOrganization: ActiveOrganization | null;
    /**
     * Server-computed default tenant for post-login / post-onboarding redirects.
     * Picks the user's `owner`-role membership first, oldest by joined-at;
     * falls back to the oldest membership regardless of role. Null only when
     * the user has zero memberships.
     */
    defaultOrganization: DefaultOrganization | null;
    memberships: TenantMembership[];
    /**
     * True when the user has organization memberships but EVERY one is
     * deactivated (`organizations.is_active = false`). `user.memberships` is
     * already filtered to active orgs by the auth guard, so this is computed
     * from a separate total-membership count. The SSR dashboard gate and the
     * select-tenant dispatcher use this to route to /account-deactivated
     * instead of /onboarding.
     */
    allOrganizationsDeactivated: boolean;
    /** @deprecated LEGACY alias for `activeOrganization`. Remove in Prompt 04. */
    organization: ActiveOrganization | null;
    spaces: BootstrapSpace[];
    default_space: { id: string; key: string } | null;
    permissions: BootstrapPermissions;
    /**
     * Active impersonation overlay for the calling Super-Admin, or null.
     * Always null for non-SA callers (no DB lookup is performed for them).
     */
    impersonation: ImpersonationEnvelope | null;
    /**
     * Effective license entitlements for the active org. `null` ⇒ no active org
     * or the resolve failed — the frontend MUST treat null as grandfathered
     * (full access) so a transient failure never locks a tenant out.
     */
    entitlements: EntitlementsSnapshot | null;
    /**
     * Set when the active org requires SSO and this session is not SSO-bound.
     * The frontend then routes to the SSO login for `connectionId`.
     */
    ssoRequired: { connectionId: string } | null;
  }> {
    const client = this.supabaseAdmin.getClient();

    // On-premise net for sessions that already exist.
    //
    // verifyOtp()/signin() cover new signups and logins, but an account created
    // BEFORE this shipped still has zero memberships and would be stuck on
    // /onboarding forever. Catch those here.
    //
    // The re-read is the important part: `user.memberships` was computed by the
    // auth guard before this handler ran, so joining alone would leave THIS
    // response unchanged and only help after a refresh. Re-reading makes the
    // current request correct. Cost is one extra query, and only for users who
    // have no organization at all.
    if (this.onPremiseTenant.isOnPremise && user.memberships.length === 0) {
      try {
        const joinedOrgId = await this.onPremiseTenant.ensureDefaultMembership(
          user.userId,
          user.email,
        );

        if (joinedOrgId) {
          // Reuse the guard's own loader rather than re-implementing the query:
          // the two must agree exactly, and MembershipContextService exists
          // precisely so guard and service-token paths cannot drift.
          const fresh = await this.membershipContext.loadMemberships(
            user.userId,
          );

          if (fresh.length > 0) {
            user.memberships = fresh;
            // The guard left this empty (no memberships existed then); without
            // it the org/spaces slices below still resolve as "no tenant".
            user.organizationId =
              user.organizationId || fresh[0].organizationId;
          }
        }
      } catch (err) {
        // Fall through with the guard's (empty) list — degrades to the previous
        // behaviour rather than failing bootstrap.
        this.logger.warn(
          `bootstrap auto-join skipped for ${user.userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Require SSO: bootstrap is @AllowWithoutSso so the frontend can learn it
    // must re-authenticate. A blocked session gets only the profile, tenant
    // list and active-org basics; no spaces, permissions, menu, entitlements
    // or branding leave before the SSO round-trip.
    const ssoRequired = await this.ssoEnforcement.evaluate(user, accessToken, {
      isMcpS2s: false,
    });

    if (ssoRequired) {
      const [profile, orgsRes] = await Promise.all([
        this.usersService.getUserByAuthUserId(user.authUserId),
        client
          .from('organizations')
          .select('id, slug, name')
          .in(
            'id',
            user.memberships.map((m) => m.organizationId),
          ),
      ]);

      if (!profile) {
        throw new BadRequestException('User profile not found');
      }

      const orgRows = (orgsRes.error ? [] : (orgsRes.data ?? [])) as Array<{
        id: string;
        slug: string;
        name: string;
      }>;
      const memberships = user.memberships.map((m) => {
        const slug = m.organizationSlug;
        const name =
          orgRows.find((o) => o.id === m.organizationId)?.name ?? slug;

        return {
          organizationId: m.organizationId,
          slug,
          name,
          organizationSlug: slug,
          organizationName: name,
          role: m.role,
        };
      });
      const activeRow = orgRows.find((o) => o.id === user.organizationId);
      const activeRole = user.memberships.find(
        (m) => m.organizationId === user.organizationId,
      )?.role;
      const activeOrganization: ActiveOrganization | null =
        activeRow && activeRole
          ? { ...activeRow, branding: null, role: activeRole }
          : null;

      return {
        user: profile,
        activeOrganization,
        defaultOrganization: this.computeDefaultOrganization(memberships),
        memberships,
        allOrganizationsDeactivated: false,
        organization: activeOrganization,
        spaces: [],
        default_space: null,
        permissions: { effective: null, menu: null },
        impersonation: null,
        entitlements: null,
        ssoRequired,
      };
    }

    // Best-effort wrapper — never let one failed slice poison the whole bootstrap.
    const safe = async <T>(
      label: string,
      fn: () => Promise<T>,
      fallback: T,
    ): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : JSON.stringify(err);
        this.logger.warn(`bootstrap.${label}: ${msg}`);
        return fallback;
      }
    };

    const profilePromise = this.usersService.getUserByAuthUserId(
      user.authUserId,
    );
    const orgPromise: Promise<OrganizationRow | null> = user.organizationId
      ? safe(
          'org',
          async () => {
            const r = await client
              .from('organizations')
              .select('*')
              .eq('id', user.organizationId)
              .maybeSingle();
            return r.error ? null : (r.data as OrganizationRow | null);
          },
          null,
        )
      : Promise.resolve(null);
    const spacesPromise: Promise<Space[]> = safe(
      'spaces',
      () => this.spacesService.getUserSpaces(user.userId, user.organizationId),
      [],
    );
    const effectivePromise: Promise<IUserEffectivePermissions | null> = safe(
      'effective',
      () =>
        this.permissionsService.getUserEffectivePermissions(
          user.userId,
          user.organizationId,
        ),
      null,
    );
    const menuPromise: Promise<IMenuPermission[] | null> = safe(
      'menu',
      () =>
        this.permissionsService.getMenuPermissions(
          user.userId,
          user.organizationId,
        ),
      null,
    );
    const brandingPromise: Promise<OrganizationBranding | null> =
      user.organizationId
        ? safe(
            'branding',
            () => this.organizationsService.getBranding(user.organizationId),
            null,
          )
        : Promise.resolve(null);
    // Only resolve an impersonation envelope for Super-Admins. Non-SA callers
    // short-circuit with no DB call. Wrapped in safe() so a lookup failure
    // never poisons the rest of bootstrap.
    const impersonationEnvelopePromise: Promise<ImpersonationEnvelope | null> =
      safe(
        'impersonation',
        async () => {
          const isSA =
            user.appMetadata?.role === 'SUPER_ADMIN' ||
            user.appMetadata?.is_super_admin === true ||
            user.role === 'SUPER_ADMIN' ||
            !!user.impersonation;

          if (!isSA) return null;

          // During impersonation `user.userId` is the TARGET; the envelope is
          // keyed on the SA, so look it up via the impersonation realUserId.
          return await this.impersonationService.getEnvelopeForSuperAdmin(
            user.impersonation?.realUserId ?? user.userId,
          );
        },
        null,
      );

    // Resolve entitlements alongside the other slices. safe()-wrapped so a
    // resolver failure degrades to null (frontend treats null as grandfathered)
    // rather than poisoning the whole bootstrap.
    const entitlementsPromise: Promise<EntitlementsSnapshot | null> =
      user.organizationId
        ? safe(
            'entitlements',
            async () =>
              EntitlementsService.toSnapshot(
                await this.entitlementsService.getEffectiveEntitlements(
                  user.organizationId,
                ),
              ),
            null,
          )
        : Promise.resolve(null);

    const [
      profile,
      orgResult,
      baseSpaces,
      effective,
      menu,
      branding,
      impersonationEnvelope,
      entitlements,
    ] = await Promise.all([
      profilePromise,
      orgPromise,
      spacesPromise,
      effectivePromise,
      menuPromise,
      brandingPromise,
      impersonationEnvelopePromise,
      entitlementsPromise,
    ]);

    if (!profile) {
      throw new BadRequestException('User profile not found');
    }

    const activeOrgSpaceRows = user.organizationId
      ? baseSpaces.filter(
          (space) => space.organization_id === user.organizationId,
        )
      : baseSpaces;

    // Annotate every active-tenant space with `is_starred` and `enabled_modules[]` so the
    // sidebar / root-page redirect logic can run with zero extra round-trips.
    const spaceIds = activeOrgSpaceRows.map((s) => s.id).filter(Boolean);
    let starredSet = new Set<string>();
    const modulesBySpace = new Map<string, string[]>();

    if (spaceIds.length > 0) {
      const [starredRes, modulesRes] = await Promise.all([
        safe(
          'starred',
          async () => {
            const r = await client
              .from('starred_spaces')
              .select('space_id')
              .eq('user_id', user.userId)
              .in('space_id', spaceIds);
            return r.error ? [] : (r.data ?? []);
          },
          [] as Array<{ space_id: string }>,
        ),
        safe(
          'modules',
          async () => {
            const r = await client
              .from('space_modules')
              .select('space_id, module_type')
              .in('space_id', spaceIds)
              .eq('is_enabled', true);
            return r.error ? [] : (r.data ?? []);
          },
          [] as Array<{ space_id: string; module_type: string }>,
        ),
      ]);

      starredSet = new Set(starredRes.map((s) => s.space_id));
      for (const row of modulesRes) {
        const list = modulesBySpace.get(row.space_id) ?? [];
        list.push(row.module_type);
        modulesBySpace.set(row.space_id, list);
      }
    }

    // Hide modules the tenant is not entitled to. `space_modules` rows are
    // seeded per space by `create_default_space_modules` and were previously
    // returned verbatim, so an unlicensed module still produced a sidebar entry
    // whose controller then 403s via @RequireFeature. Enforcement is unchanged;
    // this only stops the nav from advertising what the API will refuse.
    //
    // Reuses the snapshot already resolved above rather than re-resolving.
    // A grandfathered snapshot marks every catalog key true, so this is a no-op
    // for tenants that have never held a licence.
    const isEntitled = (featureKey: string): boolean =>
      entitlements ? entitlements.features[featureKey] === true : true;

    const spaces = activeOrgSpaceRows.map((s) => ({
      ...s,
      is_starred: starredSet.has(s.id),
      enabled_modules: EntitlementsService.filterModuleTypesBy(
        modulesBySpace.get(s.id) ?? [],
        isEntitled,
      ),
    }));

    // Resolve the default space — used by the root page redirect.
    // Order: organizations.default_space_id (if user is a member + space not archived)
    //        → null (root page falls through to recent-cookie / first-membership).
    let defaultSpace: { id: string; key: string } | null = null;
    const defaultId = (orgResult as { default_space_id?: string } | null)
      ?.default_space_id;
    if (defaultId) {
      const candidate = spaces.find(
        (s) =>
          s.id === defaultId &&
          (s as { is_archived?: boolean }).is_archived !== true,
      );
      if (candidate) {
        defaultSpace = { id: candidate.id, key: candidate.key };
      }
    }

    // Build the membership list with org names. Memberships already carry id
    // + slug from the guard; we batch-fetch names in one query so the tenant
    // switcher can render without an extra round-trip. Best-effort: on error
    // we fall back to empty names rather than failing the whole bootstrap.
    const membershipOrgIds = user.memberships.map((m) => m.organizationId);
    const orgNamesById = new Map<string, string>();
    if (membershipOrgIds.length > 0) {
      const orgsRes = await safe(
        'membershipOrgNames',
        async () => {
          const r = await client
            .from('organizations')
            .select('id, name')
            .in('id', membershipOrgIds);
          return r.error ? [] : (r.data ?? []);
        },
        [] as Array<{ id: string; name: string }>,
      );
      for (const row of orgsRes) orgNamesById.set(row.id, row.name);
    }

    const memberships = user.memberships.map((m) => {
      const slug = m.organizationSlug;
      const name = orgNamesById.get(m.organizationId) ?? slug;

      return {
        organizationId: m.organizationId,
        slug,
        name,
        // Legacy aliases kept while older frontend code and auth guard DTOs
        // migrate to the public TenantSummary shape.
        organizationSlug: slug,
        organizationName: name,
        role: m.role,
      };
    });

    // activeOrganization is the org pinned by the active_org_id cookie /
    // first-membership fallback. The fields mirror what the legacy
    // `organization` slot returned (full row + branding) plus the caller's
    // role so the frontend doesn't need a second lookup.
    let activeMembershipRole =
      user.memberships.find((m) => m.organizationId === user.organizationId)
        ?.role ?? null;
    let activeOrgRow = orgResult;
    let activeBranding = branding;

    // M2: the user got removed from their active org between the guard's
    // membership query and this aggregator. orgResult may still hold the
    // row, but activeMembershipRole is null — keeping activeOrganization
    // null in that case would bounce the user to /onboarding even though
    // they're still a member of other tenants. Fall back to memberships[0]
    // so THIS response renders the right tenant.
    //
    // We deliberately do NOT write the cookie from here: the next request's
    // SupabaseAuthGuard will see the stale cookie pointing at the vanished
    // org, fail the membership check, and the existing
    // _pendingActiveOrgClear / _pendingActiveOrgCookie pipeline naturally
    // re-issues the cookie. Coupling the bootstrap aggregator to the
    // Response object just to short-circuit one redirect cycle isn't worth
    // the layering hit.
    if (!activeMembershipRole && user.memberships.length > 0) {
      const fallback = user.memberships[0];
      this.logger.warn(
        `bootstrap.activeOrgFallback: user ${user.userId} lost membership in ${user.organizationId || '<none>'}; falling back to ${fallback.organizationId}`,
      );

      const [refetchedOrg, refetchedBranding] = await Promise.all([
        safe<OrganizationRow | null>(
          'fallback_org',
          async () => {
            const r = await client
              .from('organizations')
              .select('*')
              .eq('id', fallback.organizationId)
              .maybeSingle();
            return r.error ? null : (r.data as OrganizationRow | null);
          },
          null,
        ),
        safe(
          'fallback_branding',
          () => this.organizationsService.getBranding(fallback.organizationId),
          null,
        ),
      ]);

      activeOrgRow = refetchedOrg;
      activeBranding = refetchedBranding;
      activeMembershipRole = fallback.role;
    }

    const activeOrganization: ActiveOrganization | null =
      activeOrgRow && activeMembershipRole
        ? {
            ...activeOrgRow,
            branding: activeBranding,
            role: activeMembershipRole,
          }
        : null;

    // Distinguish "all orgs deactivated" (locked out) from "zero memberships"
    // (never joined → onboarding). `user.memberships` is already active-only
    // (guard filter), so only when it's empty do we pay for a total count.
    let allOrganizationsDeactivated = false;
    if (user.memberships.length === 0) {
      const totalMemberships = await safe(
        'totalMembershipCount',
        async () => {
          const r = await client
            .from('organization_members')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.userId);
          return r.count ?? 0;
        },
        0,
      );

      allOrganizationsDeactivated = totalMemberships > 0;
    }

    return {
      user: profile,
      activeOrganization,
      defaultOrganization: this.computeDefaultOrganization(memberships),
      memberships,
      allOrganizationsDeactivated,
      // LEGACY: kept until Prompt 04 migrates the Next.js layout off
      // `bootstrap.organization`. Same payload shape the old endpoint returned.
      organization: activeOrganization,
      spaces,
      default_space: defaultSpace,
      permissions: {
        effective,
        menu,
      },
      impersonation: impersonationEnvelope,
      entitlements,
      ssoRequired: null,
    };
  }

  /**
   * Updates the password for the user identified by the given access token.
   *
   * @param {string} accessToken - The user's current access token
   * @param {string} newPassword - The new password to set
   * @returns {Promise<void>}
   * @throws {UnauthorizedException} When the access token is invalid
   * @throws {BadRequestException} When the password update fails
   */
  async updatePassword(
    accessToken: string,
    newPassword: string,
  ): Promise<void> {
    const client = this.supabaseAdmin.getClient();

    const {
      data: { user },
      error: getUserError,
    } = await client.auth.getUser(accessToken);

    if (getUserError || !user) {
      throw new UnauthorizedException('Invalid session');
    }

    await this.passkeySessionAssurance?.revokeTrustedDevices?.(user.id);

    const { error } = await client.auth.admin.updateUserById(user.id, {
      password: newPassword,
    });

    if (error) {
      this.logger.error(`Password update error: ${error.message}`);
      throw new BadRequestException('Failed to update password');
    }
  }

  /**
   * Retrieves the public user profile for the given Supabase auth user ID.
   *
   * @param {string} authUserId - The Supabase `auth.users.id`
   * @returns {Promise<ProfileResponse>} The user's public profile
   * @throws {BadRequestException} When no profile is found for the given auth user ID
   */
  async getProfile(authUserId: string): Promise<ProfileResponse> {
    const publicUser = await this.usersService.getUserByAuthUserId(authUserId);

    if (!publicUser) {
      throw new BadRequestException('User profile not found');
    }

    return publicUser;
  }

  /**
   * Multi-tenant `/auth/me` response. Returns the user's profile alongside
   * the membership list (every org they belong to) and the currently active
   * organization, in the same shape `bootstrap()` exposes those fields. Used
   * by the frontend tenant switcher and any page that needs the active-tenant
   * context without paying for the full bootstrap aggregator.
   *
   * Backwards-compat: the bare `ProfileResponse` from `getProfile()` is still
   * exposed via the `user` field, so any internal consumer can keep reading
   * profile fields off `<me>.user.*`. Public callers that used to read
   * `<me>.organization_id` lost that field when Prompt 01 dropped the column;
   * the new `<me>.activeOrganization.id` is the equivalent. Document the
   * change in `/auth/me` Swagger so the frontend migration is unambiguous.
   *
   * @param {RequestUser} user - The authenticated user from the guard.
   * @returns Promise resolving to `{ user, activeOrganization, memberships }`.
   */
  async getMe(user: RequestUser): Promise<{
    user: ProfileResponse;
    activeOrganization: ActiveOrganization | null;
    memberships: TenantMembership[];
  }> {
    const client = this.supabaseAdmin.getClient();
    const safe = async <T>(
      label: string,
      fn: () => Promise<T>,
      fallback: T,
    ): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : JSON.stringify(err);
        this.logger.warn(`getMe.${label}: ${msg}`);
        return fallback;
      }
    };

    // Run profile + activeOrg lookups + name batch in parallel. None of them
    // need each other's results.
    const membershipOrgIds = user.memberships.map((m) => m.organizationId);

    const profilePromise = this.usersService.getProfile(user.authUserId);
    const orgPromise: Promise<OrganizationRow | null> = user.organizationId
      ? safe(
          'org',
          async () => {
            const r = await client
              .from('organizations')
              .select('*')
              .eq('id', user.organizationId)
              .maybeSingle();
            return r.error ? null : (r.data as OrganizationRow | null);
          },
          null,
        )
      : Promise.resolve(null);
    const brandingPromise: Promise<OrganizationBranding | null> =
      user.organizationId
        ? safe(
            'branding',
            () => this.organizationsService.getBranding(user.organizationId),
            null,
          )
        : Promise.resolve(null);
    const orgNamesPromise: Promise<Array<{ id: string; name: string }>> =
      membershipOrgIds.length > 0
        ? safe(
            'membershipOrgNames',
            async () => {
              const r = await client
                .from('organizations')
                .select('id, name')
                .in('id', membershipOrgIds);
              return r.error ? [] : (r.data ?? []);
            },
            [] as Array<{ id: string; name: string }>,
          )
        : Promise.resolve([] as Array<{ id: string; name: string }>);

    const [profile, orgResult, branding, orgNamesRes] = await Promise.all([
      profilePromise,
      orgPromise,
      brandingPromise,
      orgNamesPromise,
    ]);

    const orgNamesById = new Map<string, string>();
    for (const row of orgNamesRes) orgNamesById.set(row.id, row.name);

    // M6: when the names batch missed a row (RLS filtered it, race with org
    // rename, ...), fall back to the membership slug so the switcher chip
    // never renders blank. Slug is always populated by the guard.
    const memberships = user.memberships.map((m) => {
      const slug = m.organizationSlug;
      const name = orgNamesById.get(m.organizationId) ?? slug;

      return {
        organizationId: m.organizationId,
        slug,
        name,
        // Legacy aliases kept while older frontend code and auth guard DTOs
        // migrate to the public TenantSummary shape.
        organizationSlug: slug,
        organizationName: name,
        role: m.role,
      };
    });

    const activeMembershipRole =
      user.memberships.find((m) => m.organizationId === user.organizationId)
        ?.role ?? null;

    const activeOrganization: ActiveOrganization | null =
      orgResult && activeMembershipRole
        ? {
            ...orgResult,
            branding,
            role: activeMembershipRole,
          }
        : null;

    return { user: profile, activeOrganization, memberships };
  }

  /**
   * Resends a verification OTP to an unconfirmed user's email.
   *
   * Returns the OTP for the mail service to send. If the user is already confirmed
   * or doesn't exist, returns `{ otp: undefined }` to prevent email enumeration.
   *
   * @param {string} email - The email address to resend verification to
   * @returns {Promise<OtpResult>} The generated OTP, or undefined if not applicable
   */
  async resendVerification(email: string): Promise<OtpResult> {
    const client = this.supabaseAdmin.getClient();

    // Use the `email_change` link type's `email` flow instead — generateLink
    // with `type:'signup'` REQUIRES a password and silently rotates the user's
    // existing password to that value. That meant: a user who set a real
    // password during signup but didn't verify their email had their password
    // wiped on every "Resend verification" click, locking them out.
    //
    // Calling resend on the GoTrue HTTP API (`POST /auth/v1/resend`) avoids
    // touching the password entirely. We invoke it via fetch since the
    // supabase-js admin client doesn't expose it directly.
    const url = this.configService.get<string>('supabase.url');
    const anonKey = this.configService.get<string>('supabase.anonKey');

    if (!url || !anonKey) {
      this.logger.warn('Supabase URL/anonKey missing for resend-verification');
      return { otp: undefined };
    }

    try {
      const res = await fetch(`${url}/auth/v1/resend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
        },
        body: JSON.stringify({ type: 'signup', email }),
      });

      if (!res.ok) {
        // Suppress to prevent email enumeration. Logged for ops only.
        const body = await res.text();
        this.logger.warn(
          `Resend verification (suppressed) ${res.status}: ${body}`,
        );
        return { otp: undefined };
      }
    } catch (err) {
      this.logger.warn(
        `Resend verification fetch failed (suppressed): ${err instanceof Error ? err.message : String(err)}`,
      );
      return { otp: undefined };
    }

    // We can't get an OTP back from /auth/v1/resend (it sends the email
    // directly via the Supabase project's mail config). Return a sentinel so
    // the controller knows the request was handled — the OTP itself is in the
    // user's inbox via Supabase's own templates. Note: this means our custom
    // Nodemailer template is bypassed for resend; if the team relies on the
    // custom template, swap to a service-side OTP store + custom send instead.
    void client; // quiet the unused warning
    return { deliveredBySupabase: true };
  }

  /**
   * Initiates the forgot-password flow by generating a recovery link via Supabase.
   *
   * Always returns a result (even on failure) to prevent email enumeration.
   * The caller is responsible for sending the reset email.
   *
   * @param {string} email - The email address to send the password reset to
   * @returns {Promise<ForgotPasswordResult>} The reset link and user's first name, if found
   */
  async forgotPassword(email: string): Promise<ForgotPasswordResult> {
    const client = this.supabaseAdmin.getClient();
    const appUrl = this.configService.get<string>('appUrl');

    const { data, error } = await client.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: {
        redirectTo: `${appUrl}/auth/update-password`,
      },
    });

    if (error) {
      this.logger.warn(`Forgot password error (suppressed): ${error.message}`);
      return {};
    }

    const user = await this.usersService.getUserByEmail(email);

    return {
      resetLink: data.properties?.action_link,
      firstName: user?.first_name ?? undefined,
    };
  }
}

/**
 * Supabase Auth refused the refresh token itself (invalid, expired, already used, session gone:
 * 4xx). Anything else (5xx, timeout, network failure reported as status 0, 408, 429) says
 * nothing about the token, so it must not be answered with a 401 that logs the user out.
 */
export function isRefreshRejection(error: { status?: number }): boolean {
  const status = error.status ?? 0;

  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
