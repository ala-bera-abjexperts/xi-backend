/**
 * @fileoverview Global HTTP logging interceptor that logs every request with method, URL,
 * response status code, and response time in milliseconds. Strips sensitive query parameters
 * (e.g., tokens, search text) from logged URLs.
 * @module src/common/interceptors/logging.interceptor
 * @author Prince Jadiya
 */

import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';

/**
 * Strips sensitive query parameters from a URL before it is logged: `token=`
 * anywhere, and `q`, which is free search text (chat search). `q` is anchored on
 * ?/& so `beforeSeq=` and the like stay readable.
 *
 * @param {string} url - The request URL including its query string
 * @returns {string} The URL with those values replaced by `***`
 */
export function redactUrlForLog(url: string): string {
  return url
    .replace(/token=[^&]+/g, 'token=***')
    .replace(/([?&])q=[^&]+/g, '$1q=***');
}

/**
 * Interceptor that logs HTTP requests in the format: `METHOD /path STATUS - TIMEms`.
 *
 * Sensitive query parameters (e.g., `token=...`, `q=...`) are redacted from the logged URL.
 *
 * @example
 * // Registered globally in main.ts:
 * app.useGlobalInterceptors(new LoggingInterceptor());
 *
 * // Output example:
 * // [HTTP] GET /api/v1/health 200 - 3ms
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  /** @private Logger instance using the 'HTTP' context */
  private readonly logger = new Logger('HTTP');

  /**
   * Intercepts the request, records the start time, and logs the response on completion.
   *
   * @param {ExecutionContext} context - The NestJS execution context
   * @param {CallHandler} next - The next handler in the chain
   * @returns {Observable<unknown>} The response observable with logging side-effect
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const { method } = request;
    const url = redactUrlForLog(request.url);
    const now = Date.now();

    const logOutcome = (status: number): void => {
      const duration = Date.now() - now;

      if (status < 400) {
        this.logger.log(`${method} ${url} ${status} - ${duration}ms`);

        return;
      }

      const ip = request.ip || 'unknown';
      const typed = request as Request & {
        user?: { userId?: string; organizationId?: string };
        _orgSource?: string;
      };
      const userId = typed.user?.userId || '-';

      // Tenant context is the single most useful thing here. A multi-org user
      // can have SSR resolve one org (from x-tenant-slug) while a browser XHR
      // resolves another (cookie / oldest membership); org + orgSrc make that
      // divergence greppable per request.
      const org = typed.user?.organizationId || '-';
      const orgSrc = typed._orgSource || '-';

      // Cookie size + duplicate detection. The reverse proxy is not in this
      // repo, so its limits are unknown from here; nginx defaults to
      // `large_client_header_buffers 4 8k` and rejects anything larger with a
      // 400/431 carrying no CORS headers — a failure the browser reports as a
      // CORS error and which never reaches this app at all. Logging the size on
      // requests that DO arrive is what makes proximity to that ceiling visible.
      //
      // Duplicate names matter separately: two cookies of one name under
      // different Domain scopes are both sent, and Node's parser keeps the
      // FIRST while Next's Edge parser keeps the LAST — so the tiers can
      // disagree about the session while each looks internally consistent.
      const rawCookie = request.headers.cookie ?? '';
      const cookieBytes = Buffer.byteLength(rawCookie, 'utf8');
      const names = rawCookie
        .split(';')
        .map((c) => c.split('=')[0]?.trim())
        .filter((n): n is string => Boolean(n));
      const dupes = [
        ...new Set(names.filter((n, i) => names.indexOf(n) !== i)),
      ];
      const dupeFlag = dupes.length ? ` dupCookies=${dupes.join('|')}` : '';

      this.logger.log(
        `${method} ${url} ${status} - ${duration}ms ip=${ip} user=${userId} org=${org} orgSrc=${orgSrc} cookieBytes=${cookieBytes} cookieCount=${names.length}${dupeFlag}`,
      );
    };

    // BOTH callbacks are required. With only a next handler, every THROWN
    // failure bypassed this interceptor entirely: guards run before
    // interceptors, so guard-thrown 401s, FeatureGuard 403s and throttler 429s
    // were never logged at all — the 4xx/5xx branch described triage output
    // that in practice never ran. On the error path response.statusCode is
    // still 200, so the status must come from the exception itself.
    return next.handle().pipe(
      tap({
        next: () => {
          const response = context.switchToHttp().getResponse<Response>();

          logOutcome(response.statusCode);
        },
        error: (err: unknown) => {
          const status =
            err instanceof HttpException
              ? err.getStatus()
              : HttpStatus.INTERNAL_SERVER_ERROR;

          logOutcome(status);
        },
      }),
    );
  }
}
