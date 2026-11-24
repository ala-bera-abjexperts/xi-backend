/**
 * @fileoverview Global guard that rejects requests to @ImpersonationBlocked()
 * routes when the caller is operating inside a Super-Admin impersonation
 * overlay. Must run AFTER SupabaseAuthGuard, which populates `request.user`.
 * @module src/auth/guards/impersonation-blocked.guard
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IMPERSONATION_BLOCKED_KEY } from '../decorators/impersonation-blocked.decorator';
import type { RequestUser } from '../interfaces/request-user.interface';

/**
 * Blocks @ImpersonationBlocked()-decorated handlers/controllers while an
 * impersonation overlay is active. For all other traffic it is a pure
 * pass-through.
 */
@Injectable()
export class ImpersonationBlockedGuard implements CanActivate {
  /**
   * @param {Reflector} reflector - Reads the IMPERSONATION_BLOCKED metadata.
   */
  constructor(private readonly reflector: Reflector) {}

  /**
   * @param {ExecutionContext} context - The NestJS execution context.
   * @returns {boolean} `true` when allowed.
   * @throws {ForbiddenException} When the route is blocked and the caller is impersonating.
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as Request & { user?: RequestUser }).user;

    // Defense-in-depth canary: an S2S-authenticated request must never carry an
    // impersonation overlay. The McpServiceTokenGuard already omits it and
    // asserts its absence, but if the two ever co-exist on a request, fail hard
    // here regardless of the @ImpersonationBlocked decorator. This combination
    // would represent a privilege-escalation bug, not a legitimate state.
    const isS2s = (request as Request & { _mcpS2s?: boolean })._mcpS2s === true;

    if (isS2s && user?.impersonation) {
      throw new ForbiddenException(
        'Impersonation is not permitted on service-to-service requests.',
      );
    }

    const blocked = this.reflector.getAllAndOverride<boolean>(
      IMPERSONATION_BLOCKED_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!blocked) {
      return true;
    }

    if (user?.impersonation) {
      throw new ForbiddenException(
        'This action is not available during impersonation. Exit impersonation and try again as yourself.',
      );
    }

    return true;
  }
}
