/**
 * @fileoverview Authentication controller that exposes all auth-related HTTP endpoints.
 * Handles signup, signin, OTP verification, token refresh, signout, password management,
 * and profile retrieval. Public endpoints are rate-limited; authenticated endpoints require
 * a valid Bearer token.
 *
 * Cookie contract (see cookies.util.ts): signin / verify-otp / refresh write the access_token
 * and refresh_token HttpOnly cookies on the response. Clients can ignore the body tokens
 * entirely and rely on the browser to send cookies on subsequent requests.
 *
 * @module src/auth/auth.controller
 * @author Prince Jadiya
 */

import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  Query,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Public } from './decorators/public.decorator';
import { ImpersonationBlocked } from './decorators/impersonation-blocked.decorator';
import { AllowPendingMfa } from './decorators/allow-pending-mfa.decorator';
import { AllowWithoutSso } from './decorators/allow-without-sso.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { readRequestAccessToken } from './guards/sso-enforcement.guard';
import type { RequestUser } from './interfaces/request-user.interface';
import type {
  SigninResponse,
  TokenResponse,
} from './interfaces/auth-response.interface';
import { AuthService } from './auth.service';
import { MailService } from '../mail/mail.service';
import { rethrowEmailSendFailure } from '../mail/mail-failure.util';
import { SignupDto } from './dto/signup.dto';
import { SigninDto } from './dto/signin.dto';
import { EmailDto } from './dto/email.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { ExchangeCodeDto } from './dto/exchange-code.dto';
import {
  setAuthCookies,
  clearAuthCookies,
  clearMfaPendingCookie,
  readCookieConfig,
  readAccessTokenCookie,
  readMfaPendingCookie,
  readRefreshTokenCookie,
  setMfaPendingCookie,
  readImpersonationCookie,
} from './cookies.util';
import { ImpersonationService } from '../impersonation/impersonation.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  type OriginCacheEntry,
  type SupabaseLookupClient,
  isAllowedConfiguredOrSubdomainOrigin,
  isVerifiedSiteStudioCustomDomainOrigin,
} from '../common/cors/site-studio-cors.util';

/**
 * Controller for all authentication endpoints under the `/auth` route prefix.
 *
 * Public endpoints (no Bearer token required):
 * - `POST /auth/signup` -- Register a new user
 * - `POST /auth/signin` -- Sign in with email/password (sets cookies)
 * - `POST /auth/verify-otp` -- Verify email with OTP (sets cookies)
 * - `POST /auth/refresh` -- Refresh access token (sets cookies; reads from cookie if body empty)
 * - `POST /auth/resend-verification` -- Resend verification OTP
 * - `POST /auth/forgot-password` -- Request password reset
 *
 * Authenticated endpoints (Bearer token or access_token cookie required):
 * - `POST /auth/signout` -- Sign out (clears cookies)
 * - `POST /auth/update-password` -- Update password
 * - `GET /auth/me` -- Get current user profile
 * - `GET /auth/bootstrap` -- Aggregate session bootstrap (user + org + spaces + permissions)
 *
 * @example
 * // Injected via AuthModule:
 * constructor(
 *   private readonly authService: AuthService,
 *   private readonly mailService: MailService,
 *   private readonly configService: ConfigService,
 * ) {}
 */
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  /**
   * @param {AuthService} authService - Core authentication service
   * @param {MailService} mailService - Email delivery service for OTPs and password resets
   * @param {ConfigService} configService - Reads cookie config from env
   */
  constructor(
    private readonly authService: AuthService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly impersonationService: ImpersonationService,
  ) {}

  private readonly logger = new Logger(AuthController.name);

  private readonly transferOriginCache = new Map<string, OriginCacheEntry>();

  // ── Public Auth Endpoints ──────────────────────────────────────────────

  /**
   * Registers a new user account and sends an OTP verification email.
   *
   * @param {SignupDto} body - The signup request body with name, email, and password
   * @returns {Promise<{ message: string; email: string }>} Success message and the registered email
   * @throws {BadRequestException} When signup fails (e.g., email already registered)
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('signup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register a new user',
    description:
      'Creates a new user account via Supabase Auth and sends an OTP verification email. The database trigger `handle_new_user` automatically creates the public.users profile.',
  })
  @ApiResponse({
    status: 200,
    description: 'Signup successful — OTP email sent',
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error or signup failed',
  })
  @ApiResponse({
    status: 503,
    description:
      'Verification email could not be sent (code: email_send_failed) — the account is created; retrying signup re-sends the OTP once mail delivery is fixed',
  })
  async signup(
    @Body() body: SignupDto,
  ): Promise<{ message: string; email: string }> {
    const result = await this.authService.signup(body);

    if (result.otp) {
      try {
        await this.mailService.sendSignupOtp(result.email, result.otp);
      } catch (err) {
        // The auth user already exists (created above) but is unconfirmed —
        // retrying signup re-issues the OTP and re-sends once SMTP is fixed,
        // so surface a clear 503 instead of an opaque 500.
        rethrowEmailSendFailure(this.logger, 'signup OTP', err);
      }
      return { message: 'Email sent successfully!', email: result.email };
    }
    return {
      message: 'Registration completed, but no verification email was needed.',
      email: result.email,
    };
  }

  /**
   * Authenticates a user with email and password. Sets `access_token` and `refresh_token`
   * HttpOnly cookies. The body still includes the tokens for backwards compatibility, but
   * cookie-based clients should ignore them.
   *
   * @param {SigninDto} body - The sign-in request body with email and password
   * @param {Response} res - Express response (passthrough, used to write cookies)
   * @returns {Promise<SigninResponse>} Access token, refresh token, and user info
   * @throws {UnauthorizedException} When email or password is invalid
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('signin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with email and password',
    description:
      'Authenticates a user with email/password. Returns the user profile and writes ' +
      '`access_token` + `refresh_token` HttpOnly cookies on the response. ' +
      'Cookie-based clients can rely on the browser to send these on subsequent requests; ' +
      'header-based clients can read the body tokens.',
  })
  @ApiResponse({
    status: 200,
    description: 'Sign-in successful — cookies set, body returns tokens + user',
  })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  async signin(
    @Body() body: SigninDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SigninResponse> {
    const result = await this.authService.signin(body.email, body.password);
    const cookieConfig = readCookieConfig(this.configService);

    setAuthCookies(res, result, cookieConfig);
    if (result.mfaRequired) {
      setMfaPendingCookie(res, cookieConfig);
    } else {
      clearMfaPendingCookie(res, cookieConfig);
    }
    return result;
  }

  /**
   * Verifies the user's email using the OTP code sent during signup. Sets cookies on success.
   *
   * @param {VerifyOtpDto} body - The OTP verification request body
   * @param {Response} res - Express response (passthrough)
   * @returns {Promise<TokenResponse>} Access token and refresh token on successful verification
   * @throws {BadRequestException} When OTP is invalid or expired
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify email with OTP',
    description:
      "Verifies the user's email using the OTP code. Returns JWT tokens and writes auth cookies.",
  })
  @ApiResponse({
    status: 200,
    description: 'OTP verified — cookies set',
  })
  @ApiResponse({ status: 400, description: 'Invalid or expired OTP' })
  async verifyOtp(
    @Body() body: VerifyOtpDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponse> {
    const result = await this.authService.verifyOtp(body.email, body.token);
    const cookieConfig = readCookieConfig(this.configService);

    setAuthCookies(res, result, cookieConfig);
    clearMfaPendingCookie(res, cookieConfig);
    return result;
  }

  /**
   * Exchanges a refresh token for a new token pair. The refresh token may come from
   * the request body OR the `refresh_token` HttpOnly cookie. Sets new cookies.
   *
   * @param {Request} req - Express request (used to read refresh_token cookie)
   * @param {RefreshTokenDto} body - Optional refresh token in body
   * @param {Response} res - Express response (passthrough)
   * @returns {Promise<TokenResponse>} New access token and refresh token
   * @throws {UnauthorizedException} When the refresh token is invalid, expired, or missing
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh access token',
    description:
      'Exchanges a refresh token for a new pair. Token is read from the body OR ' +
      'from the refresh_token cookie (browser-friendly). New cookies are written on the response.',
  })
  @ApiResponse({
    status: 200,
    description: 'Token refreshed — cookies rotated',
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refreshToken(
    @Req() req: Request,
    @Body() body: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponse> {
    // cookie-parser populates req.cookies; falls back to body for non-browser callers.
    const cookieToken = readRefreshTokenCookie(
      (req as Request & { cookies?: Record<string, string | undefined> })
        .cookies,
    );
    const refreshToken = body?.refreshToken ?? cookieToken;

    if (!refreshToken) {
      throw new BadRequestException('Refresh token required');
    }

    const result = await this.authService.refreshToken(refreshToken);
    const forceMfa = readMfaPendingCookie(
      (req as Request & { cookies?: Record<string, string | undefined> })
        .cookies,
    );
    const mfaState = await this.authService.getTokenMfaState(
      result.access_token,
      { forceMfa },
    );
    const cookieConfig = readCookieConfig(this.configService);

    setAuthCookies(res, result, cookieConfig);
    if (mfaState.mfaRequired) {
      setMfaPendingCookie(res, cookieConfig);
    } else {
      clearMfaPendingCookie(res, cookieConfig);
    }
    return result;
  }

  /**
   * Resends a verification OTP email to an unconfirmed user.
   *
   * @param {EmailDto} body - The request body containing the email address
   * @returns {Promise<{ message: string }>} Success message
   * @throws {BadRequestException} When a new OTP cannot be generated
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resend verification OTP',
    description:
      'Generates a new OTP for an unconfirmed user and sends it via email. Returns a generic response to prevent email enumeration.',
  })
  @ApiResponse({ status: 200, description: 'Verification email resent' })
  @ApiResponse({
    status: 400,
    description: 'Could not generate verification code',
  })
  async resendVerification(
    @Body() body: EmailDto,
  ): Promise<{ message: string }> {
    const result = await this.authService.resendVerification(body.email);

    if (result.deliveredBySupabase) {
      return { message: 'Verification email sent successfully' };
    }

    if (result.otp) {
      try {
        await this.mailService.sendVerificationOtp(body.email, result.otp);
      } catch (err) {
        // Anti-enumeration endpoint: keep the generic success (a 503 only for
        // existing accounts would reveal which emails are registered). The
        // failure is fully logged for operators (see also MailService.send).
        const e = err as NodeJS.ErrnoException;
        this.logger.error(
          `resend-verification: email delivery failed (${e?.code ?? 'no-code'}): ${e?.message ?? String(err)}`,
        );
      }
      return { message: 'Verification email sent successfully' };
    }
    throw new BadRequestException('Could not generate a verification code');
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Get('refresh')
  @ApiOperation({
    summary: 'Refresh access token for browser navigation',
    description:
      'Reads refresh_token from the HttpOnly cookie, rotates auth cookies, and redirects back to an allowlisted frontend URL.',
  })
  async refreshForBrowser(
    @Req() req: Request,
    @Query('redirectTo') redirectTo: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const cookieToken = readRefreshTokenCookie(
      (req as Request & { cookies?: Record<string, string | undefined> })
        .cookies,
    );
    const frontendUrl =
      this.configService.get<string>('frontendUrl') || 'http://localhost:3000';
    const safeRedirect = resolveRedirectTarget(
      redirectTo,
      frontendUrl,
      this.configService.get<string[]>('allowedOrigins') ?? [frontendUrl],
    );

    if (!cookieToken) {
      clearAuthCookies(res, readCookieConfig(this.configService));
      res.redirect(302, buildLoginRedirect(frontendUrl, safeRedirect));
      return;
    }

    try {
      const result = await this.authService.refreshToken(cookieToken);
      const cookieConfig = readCookieConfig(this.configService);
      const mfaState = await this.authService.getTokenMfaState(
        result.access_token,
        {
          forceMfa: readMfaPendingCookie(
            (
              req as Request & {
                cookies?: Record<string, string | undefined>;
              }
            ).cookies,
          ),
        },
      );

      setAuthCookies(res, result, cookieConfig);
      if (mfaState.mfaRequired) {
        setMfaPendingCookie(res, cookieConfig);
        res.redirect(302, buildMfaRedirect(frontendUrl, safeRedirect));
        return;
      }

      clearMfaPendingCookie(res, cookieConfig);
      res.redirect(302, safeRedirect);
    } catch (err) {
      // Auth briefly unreachable: the cookies may still be valid. Keep them and say so instead
      // of logging the user out (a redirect back would only loop through this endpoint).
      if (err instanceof ServiceUnavailableException) {
        res
          .status(HttpStatus.SERVICE_UNAVAILABLE)
          .setHeader('Retry-After', '5')
          .type('text/plain')
          .send(
            'Sign-in is temporarily unavailable. Please reload in a moment.',
          );
        return;
      }

      clearAuthCookies(res, readCookieConfig(this.configService));
      res.redirect(302, buildLoginRedirect(frontendUrl, safeRedirect));
    }
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Get(['transfer-session', 'refresh/transfer-session'])
  @ApiOperation({
    summary: 'Transfer a browser session to a published site origin',
    description:
      'Validates backend-owned HttpOnly cookies and redirects to an allowlisted ' +
      'published return URL with a short-lived bearer in the URL hash. The ' +
      '`/auth/refresh/transfer-session` alias is used by browsers so the ' +
      'path-scoped refresh_token cookie can recover expired access sessions.',
  })
  async transferSession(
    @Req() req: Request,
    @Query('returnUrl') returnUrl: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const frontendUrl =
      this.configService.get<string>('frontendUrl') || 'http://localhost:3000';
    const allowedOrigins = [
      frontendUrl,
      this.configService.get<string>('appUrl') || frontendUrl,
      ...(this.configService.get<string[]>('allowedOrigins') ?? []),
    ];
    const returnTarget = parseTransferReturnTarget(returnUrl, frontendUrl);
    const isConfiguredReturnUrl = returnTarget
      ? isAllowedConfiguredOrSubdomainOrigin(
          returnTarget.origin,
          allowedOrigins,
        )
      : false;
    const publishedFunnelOrganizationId =
      returnTarget && !isConfiguredReturnUrl
        ? await this.resolvePublishedFunnelOrganizationId(returnTarget)
        : null;
    const loginReturnUrl = await this.resolveTransferReturnUrl(
      returnUrl,
      frontendUrl,
      allowedOrigins,
      { allowUnscopedCustomDomain: true, publishedFunnelOrganizationId },
    );
    const cookieConfig = readCookieConfig(this.configService);

    if (!loginReturnUrl) {
      res.redirect(302, buildBareLoginRedirect(frontendUrl));
      return;
    }

    const cookies = (
      req as Request & { cookies?: Record<string, string | undefined> }
    ).cookies;
    let accessToken = readAccessTokenCookie(cookies);
    const refreshToken = readRefreshTokenCookie(cookies);
    let refreshedAccessToken = false;

    if (!accessToken && refreshToken) {
      try {
        const refreshed = await this.authService.refreshToken(refreshToken);

        setAuthCookies(res, refreshed, cookieConfig);
        accessToken = refreshed.access_token;
        refreshedAccessToken = true;
      } catch {
        clearAuthCookies(res, cookieConfig);
        res.redirect(302, buildLoginRedirect(frontendUrl, loginReturnUrl));
        return;
      }
    }

    if (!accessToken) {
      res.redirect(302, buildLoginRedirect(frontendUrl, loginReturnUrl));
      return;
    }

    let mfaState: Awaited<ReturnType<AuthService['getTokenMfaState']>>;
    const forceMfa = readMfaPendingCookie(cookies);

    try {
      mfaState = await this.authService.getTokenMfaState(accessToken, {
        forceMfa,
      });
    } catch {
      if (refreshToken && !refreshedAccessToken) {
        try {
          const refreshed = await this.authService.refreshToken(refreshToken);

          setAuthCookies(res, refreshed, cookieConfig);
          accessToken = refreshed.access_token;
          mfaState = await this.authService.getTokenMfaState(accessToken, {
            forceMfa,
          });
        } catch {
          clearAuthCookies(res, cookieConfig);
          res.redirect(302, buildLoginRedirect(frontendUrl, loginReturnUrl));
          return;
        }
      } else {
        clearAuthCookies(res, cookieConfig);
        res.redirect(302, buildLoginRedirect(frontendUrl, loginReturnUrl));
        return;
      }
    }

    if (mfaState.mfaRequired) {
      setMfaPendingCookie(res, cookieConfig);
      res.redirect(302, buildMfaRedirect(frontendUrl, loginReturnUrl));
      return;
    }

    const safeReturnUrl = isConfiguredReturnUrl
      ? loginReturnUrl
      : await this.resolveTransferReturnUrl(
          returnUrl,
          frontendUrl,
          allowedOrigins,
          {
            publishedFunnelOrganizationId,
            organizationId: await this.resolveTransferSessionOrganizationId(
              accessToken,
              publishedFunnelOrganizationId,
            ),
          },
        );

    if (!safeReturnUrl) {
      res.redirect(302, buildBareLoginRedirect(frontendUrl));
      return;
    }

    clearMfaPendingCookie(res, cookieConfig);
    res.redirect(302, buildSessionTransferRedirect(safeReturnUrl, accessToken));
  }

  private async resolveTransferReturnUrl(
    raw: string | undefined,
    frontendUrl: string,
    allowedOrigins: string[],
    options: {
      organizationId?: string | null;
      allowUnscopedCustomDomain?: boolean;
      publishedFunnelOrganizationId?: string | null;
    } = {},
  ): Promise<string | null> {
    const target = parseTransferReturnTarget(raw, frontendUrl);

    if (!target) return null;

    if (isAllowedConfiguredOrSubdomainOrigin(target.origin, allowedOrigins)) {
      return target.toString();
    }

    if (
      options.publishedFunnelOrganizationId &&
      (options.allowUnscopedCustomDomain ||
        options.organizationId === options.publishedFunnelOrganizationId)
    ) {
      return target.toString();
    }

    if (!options.organizationId && !options.allowUnscopedCustomDomain) {
      return null;
    }

    const isVerifiedCustomDomain = await isVerifiedSiteStudioCustomDomainOrigin(
      target.origin,
      this.supabaseAdmin.getClient() as unknown as SupabaseLookupClient,
      this.transferOriginCache,
      Date.now(),
      options.organizationId ?? undefined,
    );

    return isVerifiedCustomDomain ? target.toString() : null;
  }

  private async resolvePublishedFunnelOrganizationId(
    target: URL,
  ): Promise<string | null> {
    try {
      // The cookie domain explicitly declares our serving root. Never infer
      // ownership by dropping APP_URL's first label (e.g. app.co.uk → co.uk).
      const root = readCookieConfig(this.configService)
        .domain.replace(/^\./, '')
        .toLowerCase();
      const configured = new URL(
        this.configService.get<string>('appUrl') ||
          this.configService.get<string>('frontendUrl') ||
          'http://localhost:3000',
      );
      const label = target.hostname.slice(0, -(root.length + 1));
      if (
        !root ||
        !(
          configured.hostname === root ||
          configured.hostname.endsWith(`.${root}`)
        ) ||
        target.hostname !== `${label}.${root}` ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ||
        target.protocol !== configured.protocol ||
        target.port !== configured.port
      )
        return null;

      const { data, error } = await this.supabaseAdmin
        .getClient()
        .from('site_studio_funnels')
        .select('organization_id')
        .or(`sub_domain_name.eq.${label},preview_subdomain.eq.${label}`)
        .eq('published', true)
        .maybeSingle();

      return error
        ? null
        : ((data as { organization_id?: string } | null)?.organization_id ??
            null);
    } catch {
      return null;
    }
  }

  private async resolveTransferSessionOrganizationId(
    accessToken: string,
    organizationId?: string | null,
  ): Promise<string | null> {
    try {
      const client = this.supabaseAdmin.getClient() as {
        auth?: {
          getUser: (jwt: string) => Promise<{
            data?: { user?: { id?: string } | null };
            error?: { message?: string } | null;
          }>;
        };
        from: (table: string) => unknown;
      };
      if (!client.auth) return null;

      const { data, error } = await client.auth.getUser(accessToken);

      if (error || !data?.user?.id) return null;

      // Published funnels select their owning organization, then require a
      // matching membership. Custom domains retain the existing first-org rule.
      const profile = await this.authService.getProfile(data.user.id);

      let membershipQuery = this.supabaseAdmin
        .getClient()
        .from('organization_members')
        .select('organization_id')
        .eq('user_id', profile.id)
        .order('created_at', { ascending: true });

      if (organizationId)
        membershipQuery = membershipQuery.eq('organization_id', organizationId);

      const memberships = await membershipQuery.limit(1).maybeSingle();
      if (memberships.error) return null;

      return (
        (memberships.data as { organization_id?: string } | null)
          ?.organization_id ?? null
      );
    } catch {
      return null;
    }
  }

  /**
   * Sends a password reset email with a secure link.
   * Always returns success to prevent email enumeration.
   *
   * @param {EmailDto} body - The request body containing the email address
   * @returns {Promise<{ success: boolean }>} Always `{ success: true }`
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request password reset',
    description:
      'Sends a password reset email with a secure link. Always returns success to prevent email enumeration.',
  })
  @ApiResponse({
    status: 200,
    description: 'Password reset email sent (always returns success)',
  })
  async forgotPassword(@Body() body: EmailDto): Promise<{ success: boolean }> {
    const result = await this.authService.forgotPassword(body.email);

    if (result.resetLink) {
      try {
        await this.mailService.sendPasswordReset(
          body.email,
          result.resetLink,
          result.firstName,
        );
      } catch (err) {
        // Anti-enumeration endpoint ("always returns success"): an error only
        // on the accounts-that-exist path would leak which emails are
        // registered, so log for operators and keep the generic response.
        const e = err as NodeJS.ErrnoException;
        this.logger.error(
          `forgot-password: email delivery failed (${e?.code ?? 'no-code'}): ${e?.message ?? String(err)}`,
        );
      }
    }

    return { success: true };
  }

  /**
   * Exchanges a Supabase recovery / invitation auth code for a session and sets cookies.
   * Used by the password-reset and OAuth-callback frontend flows where the user lands
   * on the Next.js app with a `?code=...` query string from a Supabase email link.
   *
   * @param {{ code: string }} body - The recovery / OAuth auth code from the email link
   * @param {Response} res - Express response (passthrough, used to write cookies)
   * @returns {Promise<TokenResponse>} New token pair (cookies are also set)
   * @throws {BadRequestException} When the code is invalid or expired
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('exchange-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange a Supabase auth code for a session',
    description:
      'Used by the password-reset confirmation page and other flows where the user lands ' +
      'on the frontend with a one-time `code` from a Supabase email link. Returns tokens ' +
      'and writes auth cookies.',
  })
  @ApiResponse({ status: 200, description: 'Code exchanged — cookies set' })
  @ApiResponse({ status: 400, description: 'Invalid or expired code' })
  async exchangeCode(
    @Body() body: ExchangeCodeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponse> {
    const result = await this.authService.exchangeCodeForSession(body.code);
    const cookieConfig = readCookieConfig(this.configService);
    const mfaState = await this.authService.getTokenMfaState(
      result.access_token,
      { forceMfa: false },
    );

    setAuthCookies(res, result, cookieConfig);
    if (mfaState.mfaRequired) {
      setMfaPendingCookie(res, cookieConfig);
    } else {
      clearMfaPendingCookie(res, cookieConfig);
    }
    return result;
  }

  // ── Authenticated Endpoints ────────────────────────────────────────────

  /**
   * Signs out the current user by invalidating the server-side Supabase session and
   * clearing the auth cookies on the response. Pass `?everywhere=true` to revoke all
   * device sessions instead of just the current one.
   *
   * @param {RequestUser} user - The authenticated user from the JWT
   * @param {Response} res - Express response (passthrough, used to clear cookies)
   * @param {string} [everywhere] - Optional `'true'` to revoke all sessions
   * @returns {Promise<{ message: string }>} Success message
   */
  @AllowPendingMfa()
  @AllowWithoutSso()
  @Post('signout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Sign out',
    description:
      "Invalidates the user's current session refresh token on the server and clears " +
      "auth cookies. With `?everywhere=true`, revokes ALL of this user's sessions across devices.",
  })
  @ApiResponse({ status: 200, description: 'Signed out successfully' })
  async signout(
    @CurrentUser() user: RequestUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('everywhere') everywhere?: string,
  ): Promise<{ message: string }> {
    const scope = everywhere === 'true' ? 'global' : 'local';
    const cookies = (
      req as Request & { cookies?: Record<string, string | undefined> }
    ).cookies;
    const cookieToken = readAccessTokenCookie(cookies);
    const headerToken = req.headers.authorization?.split(' ')[1];
    const token = cookieToken ?? headerToken;

    if (!token) {
      throw new BadRequestException('Authorization token required');
    }

    void user;

    // Best-effort: end any active impersonation session bound to this browser
    // before tearing down the auth session. A failure here MUST NOT block
    // signout. clearAuthCookies (below) already clears the impersonation cookie.
    const impersonationToken = readImpersonationCookie(cookies);

    if (impersonationToken) {
      try {
        await this.impersonationService.stopByToken(
          impersonationToken,
          'signed_out',
        );
      } catch (err) {
        this.logger.warn(
          `signout: failed to stop impersonation session: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    await this.authService.signout(token, scope);
    clearAuthCookies(res, readCookieConfig(this.configService));
    return {
      message:
        scope === 'global'
          ? 'Signed out everywhere'
          : 'Signed out successfully',
    };
  }

  /**
   * Updates the password for the currently authenticated user. Reads the access token
   * from the access_token cookie (preferred) or the Authorization header (fallback).
   *
   * @param {Request} req - The incoming HTTP request
   * @param {UpdatePasswordDto} body - The request body with the new password
   * @returns {Promise<{ message: string }>} Success message
   * @throws {BadRequestException} When the access token is missing or password update fails
   */
  @Post('update-password')
  @AllowWithoutSso()
  @ImpersonationBlocked()
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update password',
    description:
      'Changes the password for the currently authenticated user. Token is read from ' +
      'the access_token cookie or the Authorization header.',
  })
  @ApiResponse({ status: 200, description: 'Password updated successfully' })
  @ApiResponse({ status: 400, description: 'Failed to update password' })
  async updatePassword(
    @Req() req: Request,
    @Body() body: UpdatePasswordDto,
  ): Promise<{ message: string }> {
    const cookieBag = (req as unknown as { cookies?: Record<string, unknown> })
      .cookies;
    const rawCookieToken: unknown = cookieBag?.access_token;
    const cookieToken =
      typeof rawCookieToken === 'string' ? rawCookieToken : undefined;
    const headerToken = req.headers.authorization?.split(' ')[1];
    const token: string | undefined = cookieToken ?? headerToken;

    if (!token) {
      throw new BadRequestException('Authorization token required');
    }

    await this.authService.updatePassword(token, body.password);
    return { message: 'Password updated successfully' };
  }

  /**
   * Returns the authenticated user's profile from the public users table.
   *
   * @param {RequestUser} user - The authenticated user extracted by {@link CurrentUser}
   * @returns Promise resolving to the user profile + tenant context
   * @throws {BadRequestException} When the user profile is not found
   */
  // Per-user (UserAwareThrottlerGuard) — 60/min is generous for a heavy hook
  // (multiple dashboard components depend on it) but bounded enough to catch
  // accidental infinite loops or duplicate-cache-key fan-outs.
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @AllowWithoutSso()
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get current user + tenant context',
    description:
      "Returns the authenticated user's profile alongside the multi-tenant context: the currently active organization (matching the active_org_id cookie) and every organization the caller is a member of. Replaces the legacy single-org `/auth/me` shape — callers that used to read `.organization_id` should now read `.activeOrganization.id`. `.user` carries the bare profile for back-compat.",
  })
  @ApiResponse({ status: 200, description: 'User profile + tenant context' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getProfile(@CurrentUser() user: RequestUser) {
    return this.authService.getMe(user);
  }

  /**
   * Aggregate session-bootstrap endpoint. Returns the current user, their organization,
   * accessible spaces, and permission set in a single round-trip — replacing the 3-4
   * separate calls (`/auth/me`, `/permissions/effective`, `/permissions/menu`,
   * `/spaces`) the Next.js frontend previously made on every dashboard load.
   *
   * @param {RequestUser} user - The authenticated user
   * @returns {Promise<unknown>} Aggregated bootstrap payload
   */
  // Per-user (UserAwareThrottlerGuard). Bootstrap is a heavy aggregate read
  // that runs once on dashboard mount, once during SSR redirects, and may be
  // prefetched by several RSC links in quick succession. 120/min is still bounded
  // enough to catch runaway loops, while avoiding false login-loop failures from
  // legitimate dashboard startup traffic.
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @AllowWithoutSso()
  @Get('bootstrap')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Bootstrap session payload',
    description:
      'One-shot endpoint returning user + organization + spaces + permissions for ' +
      'fast dashboard initialization. Replaces 3-4 sequential calls.',
  })
  @ApiResponse({ status: 200, description: 'Bootstrap payload' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async bootstrap(
    @CurrentUser() user: RequestUser,
    @Req() req: Request,
  ): Promise<unknown> {
    return await this.authService.bootstrap(user, readRequestAccessToken(req));
  }
}

function resolveRedirectTarget(
  raw: string | undefined,
  fallbackOrigin: string,
  allowedOrigins: string[],
): string {
  if (!raw) return fallbackOrigin;

  try {
    const url = new URL(raw);

    // Accept the configured origins AND their subdomains — tenant module pages
    // live on dynamic `{slug}.{root}` hosts a static allowedOrigins list can't
    // enumerate. Mirrors CORS (main.ts) + transferSession; without this a tenant
    // returnUrl silently falls back to the app root (dashboard) even on a
    // successful refresh.
    const allowed = isAllowedConfiguredOrSubdomainOrigin(
      url.origin,
      allowedOrigins,
    );

    return allowed ? url.toString() : fallbackOrigin;
  } catch {
    if (raw.startsWith('/') && !raw.startsWith('//')) {
      return new URL(raw, fallbackOrigin).toString();
    }

    return fallbackOrigin;
  }
}

function parseTransferReturnTarget(
  raw: string | undefined,
  frontendUrl: string,
): URL | null {
  if (!raw) return null;

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    if (!raw.startsWith('/') || raw.startsWith('//')) return null;
    url = new URL(raw, frontendUrl);
  }

  if (!['http:', 'https:'].includes(url.protocol)) return null;

  return url;
}

function buildLoginRedirect(frontendUrl: string, returnUrl: string): string {
  const loginUrl = new URL('/auth/login', frontendUrl);

  loginUrl.searchParams.set('returnUrl', returnUrl);

  return loginUrl.toString();
}

function buildBareLoginRedirect(frontendUrl: string): string {
  return new URL('/auth/login', frontendUrl).toString();
}

function buildMfaRedirect(frontendUrl: string, returnUrl: string): string {
  const verifyUrl = new URL('/auth/verify-totp', frontendUrl);

  verifyUrl.searchParams.set('returnUrl', returnUrl);

  return verifyUrl.toString();
}

function buildSessionTransferRedirect(
  returnUrl: string,
  accessToken: string,
): string {
  const dest = new URL(returnUrl);
  const hash = new URLSearchParams({
    access_token: accessToken,
  });

  hash.set('type', 'session');
  dest.hash = hash.toString();

  return dest.toString();
}
