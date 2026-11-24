/**
 * @fileoverview Global guard that enforces Require SSO: a member of an org with
 * `require_sso` on may only call the API from a session minted by that org's
 * SAML connection. Must run AFTER SupabaseAuthGuard, which populates
 * `request.user`. Direct PostgREST, Realtime and the Next API routes are not
 * gated (documented ceiling).
 * @module src/auth/guards/sso-enforcement.guard
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_WITHOUT_SSO_KEY } from '../decorators/allow-without-sso.decorator';
import { SsoEnforcementService } from '../sso-enforcement.service';
import type { RequestUser } from '../interfaces/request-user.interface';
import type { RequestWithS2sMarker } from './mcp-service-token.guard';

/**
 * Reads the access token in the same order SupabaseAuthGuard does: the
 * `Authorization: Bearer` header, else the `access_token` cookie.
 *
 * @param {Request} request - The incoming HTTP request
 * @returns {string | null} The token, or null when absent
 */
export function readRequestAccessToken(request: Request): string | null {
  const [type, headerToken] = request.headers.authorization?.split(' ') ?? [];

  if (type === 'Bearer' && headerToken) {
    return headerToken;
  }

  const cookie: unknown = (request as { cookies?: Record<string, unknown> })
    .cookies?.access_token;

  return typeof cookie === 'string' ? cookie : null;
}

/**
 * Rejects requests into an SSO-enforced org that lack an SSO session binding
 * with 403 `SSO_REQUIRED`. Never 401: the session itself is valid.
 */
@Injectable()
export class SsoEnforcementGuard implements CanActivate {
  /**
   * @param {Reflector} reflector - Reads the public / allow-without-SSO metadata.
   * @param {SsoEnforcementService} ssoEnforcement - Require SSO policy.
   */
  constructor(
    private readonly reflector: Reflector,
    private readonly ssoEnforcement: SsoEnforcementService,
  ) {}

  /**
   * @param {ExecutionContext} context - The NestJS execution context.
   * @returns {Promise<boolean>} `true` when allowed.
   * @throws {ForbiddenException} `SSO_REQUIRED` when the session is not SSO-bound.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ||
      this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_SSO_KEY, targets)
    ) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & RequestWithS2sMarker & { user?: RequestUser }>();

    const result = await this.ssoEnforcement.evaluate(
      request.user,
      readRequestAccessToken(request),
      { isMcpS2s: request._mcpS2s === true },
    );

    if (result) {
      throw new ForbiddenException({
        code: 'SSO_REQUIRED',
        message: 'This workspace requires single sign-on',
        data: { connectionId: result.connectionId },
      });
    }

    return true;
  }
}
