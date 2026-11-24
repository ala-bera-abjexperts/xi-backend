/**
 * @fileoverview Global guard that enforces read-only behavior during a
 * read-only Super-Admin impersonation session. Mutating HTTP verbs are
 * rejected unless the session was started with writeAccess. Must run AFTER
 * SupabaseAuthGuard, which populates `request.user`.
 * @module src/auth/guards/impersonation-readonly.guard
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { RequestUser } from '../interfaces/request-user.interface';

/** HTTP methods that never mutate state and are always allowed read-only. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Rejects write requests while a read-only impersonation overlay is active.
 * For non-impersonating traffic, write-enabled sessions, and safe verbs it is
 * a pure pass-through. The impersonation-stop endpoint is always allowed so a
 * read-only session can still be exited.
 */
@Injectable()
export class ImpersonationReadOnlyGuard implements CanActivate {
  /**
   * @param {ExecutionContext} context - The NestJS execution context.
   * @returns {boolean} `true` when allowed.
   * @throws {ForbiddenException} When a write is attempted in a read-only session.
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as Request & { user?: RequestUser }).user;

    if (!user?.impersonation) {
      return true;
    }

    if (user.impersonation.writeAccess) {
      return true;
    }

    const method = (request.method ?? 'GET').toUpperCase();

    if (SAFE_METHODS.has(method)) {
      return true;
    }

    const path = request.path || request.url || '';

    // The exit path must work even in a read-only session, otherwise the SA
    // could not stop their own impersonation overlay. NOTE: request.path
    // carries the global prefix (e.g. /api/v1/admin/impersonation/stop) and no
    // query string, so endsWith is prefix-safe and avoids matching the
    // substring anywhere in the path.
    if (path.endsWith('/admin/impersonation/stop')) {
      return true;
    }

    throw new ForbiddenException(
      'Impersonation session is read-only. Restart with writeAccess=true to make changes.',
    );
  }
}
