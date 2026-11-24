/**
 * @fileoverview Public SAML service-provider routes (SP-initiated only).
 *
 *  POST /auth/saml/discover                  — email → enabled connection id
 *  GET  /auth/saml/:connectionId/login       — 302 to the IdP, sets `saml_request`
 *  POST /auth/saml/:connectionId/acs         — IdP posts here; cookies + 302
 *  GET  /auth/saml/:connectionId/metadata    — SP metadata XML
 *
 * Browser-facing routes never dead-end on JSON: every refusal is a 302 to
 * `/auth/login?error=<code>`. No licence check here (read-only grace, Q8).
 *
 * @module src/sso/saml.controller
 * @author Prince Jadiya
 */

import {
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';
import {
  type CookieConfig,
  clearMfaPendingCookie,
  readCookieConfig,
  setActiveOrgCookie,
  setAuthCookies,
  setMfaPendingCookie,
} from '../auth/cookies.util';
import { ImpersonationBlocked } from '../auth/decorators/impersonation-blocked.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { TokenResponse } from '../auth/interfaces/auth-response.interface';
import {
  SAML_REQUEST_COOKIE,
  SAML_REQUEST_TTL_MS,
  SamlLoginError,
  SamlService,
} from './saml.service';

@ImpersonationBlocked()
@ApiTags('SAML SSO')
@Controller('auth/saml')
export class SamlController {
  private readonly logger = new Logger(SamlController.name);

  constructor(
    private readonly samlService: SamlService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Finds the SSO connection for an email's verified domain.
   *
   * @param body - `{ email }`
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('discover')
  @ApiOperation({ summary: 'Find the SSO connection for an email domain' })
  async discover(
    @Body() body: Record<string, unknown>,
  ): Promise<{ connectionId: string | null }> {
    return { connectionId: await this.samlService.discover(body?.email) };
  }

  /**
   * Begins an SP-initiated SAML login (302 to the IdP).
   *
   * @param connectionId - `sso_connections.id`
   * @param redirectTo - Frontend URL to land on; must be an allowed origin
   */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Get(':connectionId/login')
  @ApiOperation({ summary: 'Begin SAML login (302 redirect)' })
  async login(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Query('redirectTo') redirectTo: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const { url, requestCookie } = await this.samlService.startLogin(
        connectionId,
        redirectTo,
      );

      res.cookie(SAML_REQUEST_COOKIE, requestCookie, {
        ...requestCookieOptions(readCookieConfig(this.configService)),
        maxAge: SAML_REQUEST_TTL_MS,
      });
      res.redirect(302, url);
    } catch (err) {
      this.redirectToLogin(res, err);
    }
  }

  /**
   * Assertion Consumer Service. Validates the IdP response, sets the session
   * cookies and 302s to the stored `redirectTo`.
   *
   * @param connectionId - `sso_connections.id`
   * @param body - Form post; only `SAMLResponse` is read
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post(':connectionId/acs')
  @ApiOperation({ summary: 'SAML assertion consumer service' })
  async acs(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Body() body: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const cookieCfg = readCookieConfig(this.configService);
    const cookies = req.cookies as Record<string, string> | undefined;
    const requestCookie = cookies?.[SAML_REQUEST_COOKIE];

    // One-time cookie: cleared on every outcome, with the set-time options.
    res.clearCookie(SAML_REQUEST_COOKIE, requestCookieOptions(cookieCfg));

    let tokens: TokenResponse | undefined;

    try {
      const login = await this.samlService.completeLogin(
        connectionId,
        body?.SAMLResponse,
        requestCookie,
      );
      const { redirectTo, organizationId } = login;

      tokens = login.tokens;

      const mfaState = await this.authService.getTokenMfaState(
        tokens.access_token,
        { forceMfa: false },
      );

      setAuthCookies(res, tokens, cookieCfg);

      // Land in the connection's workspace, also after a TOTP step-up.
      try {
        setActiveOrgCookie(res, organizationId, cookieCfg);
      } catch (err) {
        this.logger.warn(
          `SAML active org cookie skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (mfaState.mfaRequired) {
        setMfaPendingCookie(res, cookieCfg);
        res.redirect(
          302,
          `${this.samlService.frontendUrl()}/auth/verify-totp?returnUrl=${encodeURIComponent(
            redirectTo,
          )}`,
        );

        return;
      }

      clearMfaPendingCookie(res, cookieCfg);
      res.redirect(302, redirectTo);
    } catch (err) {
      // A minted, SSO-bound session must not outlive a failed sign-in.
      if (tokens) await this.samlService.revokeSession(tokens.access_token);

      this.redirectToLogin(res, err);
    }
  }

  /**
   * SP metadata for the IdP administrator.
   *
   * @param connectionId - `sso_connections.id`
   */
  @Public()
  @Get(':connectionId/metadata')
  @ApiOperation({ summary: 'SAML service provider metadata (XML)' })
  async metadata(
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Res() res: Response,
  ): Promise<void> {
    const xml = await this.samlService.metadata(connectionId);

    if (!xml) {
      throw new NotFoundException('SSO connection not found');
    }

    res.type('application/samlmetadata+xml').send(xml);
  }

  /** 302 to the login page with a fixed error code, never a library message. */
  private redirectToLogin(res: Response, err: unknown): void {
    if (!(err instanceof SamlLoginError)) {
      this.logger.warn(
        `SAML sign-in failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const code =
      err instanceof SamlLoginError ? err.code : 'sso_assertion_invalid';

    res.redirect(
      302,
      `${this.samlService.frontendUrl()}/auth/login?error=${code}`,
    );
  }
}

/**
 * `SameSite=None` so the cookie rides the IdP's cross-site form POST.
 * Always `Secure`, which browsers require for `SameSite=None`.
 */
function requestCookieOptions(cfg: CookieConfig) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'none' as const,
    ...(cfg.domain ? { domain: cfg.domain } : {}),
    path: '/api/v1/auth/saml',
  };
}
