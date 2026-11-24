/**
 * @fileoverview Global interceptor that completes the active-org cookie
 * handshake started in {@link SupabaseAuthGuard}.
 *
 * The guard runs before the {@link Response} object is bound to the request
 * pipeline, so it cannot write Set-Cookie headers directly. Instead, it
 * stashes the desired write on `request._pendingActiveOrgCookie` (or
 * `_pendingActiveOrgClear` to evict a stale cookie), and this interceptor
 * flushes the decision after the controller returns but before NestJS
 * serialises the response body.
 *
 * Previously this interceptor also depended on a request-scoped
 * {@link OrgContextService} to expose the active orgId to other services.
 * That was removed (M4 follow-up + crash fix): global APP_INTERCEPTOR
 * providers are singletons, and Nest cannot inject a request-scoped
 * provider into a singleton — the interceptor field came up `undefined`
 * and every request 500'd at the `setActiveOrgId` call. No service in the
 * codebase consumed `OrgContextService`, so we dropped the dependency
 * entirely. Anything that needs the active org reads it from
 * `req.user.organizationId`, which the guard populates.
 *
 * @module src/auth/interceptors/active-org-cookie.interceptor
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import {
  clearActiveOrgCookie,
  readCookieConfig,
  setActiveOrgCookie,
} from '../cookies.util';
import type { RequestWithPendingCookie } from '../guards/supabase-auth.guard';

@Injectable()
export class ActiveOrgCookieInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ActiveOrgCookieInterceptor.name);

  constructor(private readonly configService: ConfigService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // We only care about HTTP requests. Other transports (Microservices,
    // GraphQL subscriptions) don't have an Express response to write to.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request & RequestWithPendingCookie>();
    const response = http.getResponse<Response>();

    return next.handle().pipe(
      tap({
        next: () => this.flushPendingCookie(request, response),
        error: () => this.flushPendingCookie(request, response),
      }),
    );
  }

  /**
   * Flushes the cookie decision the guard stashed on the request. Runs on
   * both success and error paths so the cookie state stays consistent even
   * when a downstream throws (e.g. a 4xx from the controller still needs to
   * land the freshly-resolved active org so the next request is fast).
   *
   * @private
   */
  private flushPendingCookie(
    request: Request & RequestWithPendingCookie,
    response: Response,
  ): void {
    // Headers may already be sent (streaming responses, early flush from a
    // proxy). In that case `res.cookie` would throw; bail quietly.
    if (response.headersSent) return;

    const cfg = readCookieConfig(this.configService);

    try {
      if (request._pendingActiveOrgClear) {
        clearActiveOrgCookie(response, cfg);
      }
      if (request._pendingActiveOrgCookie) {
        setActiveOrgCookie(response, request._pendingActiveOrgCookie, cfg);
      }
    } catch (err) {
      // Cookie write failures must never bubble up into the response — at
      // worst, the next request will simply re-resolve via first-membership.
      this.logger.debug(
        `Failed to flush active-org cookie (suppressed): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
