/**
 * @fileoverview OAuth controller for Azure/Google/GitHub/Keycloak login flows.
 *
 *  GET  /auth/oauth/providers        — list providers the frontend can offer
 *  GET  /auth/oauth/authorize        — 302 to the provider with a signed state cookie
 *  GET  /auth/oauth/callback         — provider returns here; exchange code → cookies; 302 home
 *
 * The frontend just renders an `<a href="/api/v1/auth/oauth/authorize?provider=azure&redirectTo=...">`
 * — no Supabase SDK on the client.
 *
 * @module src/auth/oauth/oauth.controller
 * @author Prince Jadiya
 */

import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Public } from '../decorators/public.decorator';
import { ImpersonationBlocked } from '../decorators/impersonation-blocked.decorator';
import { Throttle } from '@nestjs/throttler';
import {
  OauthService,
  SUPPORTED_PROVIDERS,
  type SupportedProvider,
  OAUTH_STATE_COOKIE,
} from './oauth.service';
import {
  clearMfaPendingCookie,
  readCookieConfig,
  setAuthCookies,
  setMfaPendingCookie,
} from '../cookies.util';
import {
  type AuthProviderType,
  OrganizationAuthProvidersService,
} from '../../organization-auth-providers/organization-auth-providers.service';
import { AuthService } from '../auth.service';

@ImpersonationBlocked()
@ApiTags('OAuth')
@Controller('auth/oauth')
export class OauthController {
  constructor(
    private readonly oauthService: OauthService,
    private readonly configService: ConfigService,
    private readonly authProviders: OrganizationAuthProvidersService,
    private readonly authService: AuthService,
  ) {}

  /**
   * Lists OAuth providers the frontend can render buttons for. Comes from a
   * compile-time list; consult Supabase project settings to confirm each is
   * enabled before exposing.
   */
  @Public()
  @Get('providers')
  @ApiOperation({
    summary: 'List OAuth providers the login page should render',
    description:
      'Deployment-aware and pre-auth. SaaS returns the fixed cloud set ' +
      '(Azure only). On-premise returns the subset of providers an admin has ' +
      'enabled in Tenant Config for the pinned org. Keycloak is never returned ' +
      'off-premise.',
  })
  async providers(): Promise<{ providers: string[] }> {
    // Cloud (SaaS): Azure is the only external provider, fixed-on. Keycloak is
    // impossible here — never read the toggle table, never expose it.
    if (!this.authProviders.isOnPremise) {
      return { providers: ['azure'] };
    }

    // On-premise: exactly what the admin enabled for this installation's org.
    const providers =
      await this.authProviders.getAvailableProvidersForOnPremise();

    return { providers };
  }

  /**
   * Begins an OAuth flow. Redirects the browser to the provider's consent
   * screen. The provider will send the user to `GET /auth/oauth/callback`
   * after consent.
   *
   * @param provider - 'azure', 'google', 'github', or 'keycloak'
   * @param redirectTo - Frontend URL to land on after the callback completes
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Get('authorize')
  @ApiOperation({ summary: 'Begin OAuth flow (302 redirect)' })
  @ApiQuery({ name: 'provider', enum: SUPPORTED_PROVIDERS })
  @ApiQuery({
    name: 'redirectTo',
    description:
      'Frontend URL to land on after the callback completes. MUST be in ALLOWED_ORIGINS.',
  })
  @ApiQuery({
    name: 'prompt',
    required: false,
    enum: ['none'],
    description:
      'Silent sign-in: `none` asks the provider to reuse an existing session without showing a login screen. Without one, the callback returns to the login page with no error.',
  })
  async authorize(
    @Query('provider') provider: string,
    @Query('redirectTo') redirectTo: string,
    @Query('prompt') prompt: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
      throw new BadRequestException(`Unsupported provider: ${provider}`);
    }
    if (!redirectTo) {
      throw new BadRequestException('redirectTo is required');
    }
    // Only `none` is forwarded — never arbitrary provider params.
    if (prompt !== undefined && prompt !== 'none') {
      throw new BadRequestException(`Unsupported prompt: ${prompt}`);
    }

    // Server-side authority for the tenant-config toggles + cloud safety. The
    // login button is already hidden when a provider is disabled, but enforce it
    // here too so a crafted request can never start a disabled flow. Keycloak is
    // additionally on-premise-only. Legacy providers (google/github) are left
    // untouched — this gate only governs the configurable set (azure/keycloak).
    const configurable: readonly AuthProviderType[] = ['azure', 'keycloak'];

    if (configurable.includes(provider as AuthProviderType)) {
      if (provider === 'keycloak' && !this.authProviders.isOnPremise) {
        throw new BadRequestException(
          'Keycloak sign-in is only available on-premise',
        );
      }

      if (this.authProviders.isOnPremise) {
        const available =
          await this.authProviders.getAvailableProvidersForOnPremise();

        if (!available.includes(provider as AuthProviderType)) {
          throw new BadRequestException(
            `${provider} sign-in is not enabled for this installation`,
          );
        }
      }
    }

    const { authorizeUrl, state } = await this.oauthService.beginAuthorize(
      provider as SupportedProvider,
      redirectTo,
      { silent: prompt === 'none' },
    );

    const cookieCfg = readCookieConfig(this.configService);

    // Domain-scoped the same as the access/refresh token cookies set in
    // callback() below — this requires PUBLIC_API_URL to be under the same
    // domain family as COOKIE_DOMAIN (see the comment on PUBLIC_API_URL in
    // .env), otherwise the browser silently drops this Set-Cookie entirely
    // (Domain must be the response's own host or a parent of it).
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: cookieCfg.secure,
      sameSite: 'lax',
      ...(cookieCfg.domain ? { domain: cookieCfg.domain } : {}),
      path: '/api/v1/auth/oauth/callback',
      maxAge: 10 * 60 * 1000,
    });

    res.redirect(302, authorizeUrl);
  }

  /**
   * OAuth provider callback. Exchanges the code for a Supabase session, sets
   * auth cookies, then 302s the browser to the original `redirectTo`.
   */
  @Public()
  @Get('callback')
  @ApiOperation({ summary: 'OAuth callback — exchange code for session' })
  async callback(
    @Req() req: Request,
    @Query('code') code: string,
    @Res() res: Response,
  ): Promise<void> {
    const cookieCfg = readCookieConfig(this.configService);
    const typedReq = req as Request & { cookies?: Record<string, string> };
    const state = (typedReq.cookies?.[OAUTH_STATE_COOKIE] ?? undefined) as
      | string
      | undefined;

    // Clear the one-time state cookie on EVERY outcome (success or failure).
    // Mirror the EXACT options used at set time — Safari is strict about
    // attribute equality on clearCookie.
    const clearState = () =>
      res.clearCookie(OAUTH_STATE_COOKIE, {
        httpOnly: true,
        secure: cookieCfg.secure,
        sameSite: 'lax',
        path: '/api/v1/auth/oauth/callback',
        ...(cookieCfg.domain ? { domain: cookieCfg.domain } : {}),
      });

    try {
      // A silent (prompt=none) attempt with no provider session comes back
      // without a code (login_required). That is the expected "not signed in
      // yet" answer, so return to the login page quietly instead of with an
      // error. Keyed on our own signed state, not on how the error is relayed.
      // The trailing `#` replaces the `#error=login_required` fragment Supabase
      // Auth appends, which the browser would otherwise carry onto this URL.
      if (!code && state) {
        const silentRedirectTo =
          await this.oauthService.silentRedirectFor(state);

        if (silentRedirectTo) {
          clearState();
          res.redirect(
            302,
            `${(
              this.configService.get<string>('frontendUrl') ??
              'http://localhost:3000'
            ).replace(
              /\/$/,
              '',
            )}/auth/login?returnUrl=${encodeURIComponent(silentRedirectTo)}#`,
          );
          return;
        }
      }

      if (!code || !state) {
        throw new BadRequestException(
          'OAuth callback missing code or state cookie',
        );
      }

      const { tokens, redirectTo } = await this.oauthService.completeCallback(
        code,
        state,
      );
      const mfaState = await this.authService.getTokenMfaState(
        tokens.access_token,
        { forceMfa: false },
      );

      clearState();
      setAuthCookies(res, tokens, cookieCfg);
      if (mfaState.mfaRequired) {
        setMfaPendingCookie(res, cookieCfg);
        res.redirect(
          302,
          buildMfaRedirect(
            (
              this.configService.get<string>('frontendUrl') ??
              'http://localhost:3000'
            ).replace(/\/$/, ''),
            redirectTo,
          ),
        );
        return;
      }

      clearMfaPendingCookie(res, cookieCfg);
      res.redirect(302, redirectTo);
    } catch (err) {
      // Never dead-end the browser on a raw JSON 400/401 at the API host.
      // Bounce back to the frontend login page with a human-readable ?error=
      // that Login.tsx already surfaces (its searchParams 'error' effect).
      // Covers every failure mode: missing code/state, expired state JWT,
      // code-exchange failure, or a trigger/provisioning error bubbled up
      // from Supabase (e.g. email collision, missing email).
      clearState();

      let message = 'Sign-in failed. Please try again.';

      if (err instanceof HttpException) {
        const resp = err.getResponse() as unknown;
        const m =
          typeof resp === 'string'
            ? resp
            : (resp as { message?: string | string[] })?.message;

        message = Array.isArray(m) ? m.join(', ') : (m ?? err.message);
      }

      const loginBase = (
        this.configService.get<string>('frontendUrl') ?? 'http://localhost:3000'
      ).replace(/\/$/, '');

      res.redirect(
        302,
        `${loginBase}/auth/login?error=${encodeURIComponent(message)}`,
      );
    }
  }
}

function buildMfaRedirect(frontendUrl: string, returnUrl: string): string {
  return `${frontendUrl}/auth/verify-totp?returnUrl=${encodeURIComponent(
    returnUrl,
  )}`;
}
