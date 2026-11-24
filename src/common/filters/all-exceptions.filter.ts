/**
 * @fileoverview Global exception filter that catches all thrown exceptions and returns
 * a uniform error response format. Logs internal server errors with stack traces while
 * preserving structured error messages from HTTP exceptions and class-validator.
 * @module src/common/filters/all-exceptions.filter
 * @author Prince Jadiya
 */

import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { redactUrlForLog } from '../interceptors/logging.interceptor';

/**
 * Catches all unhandled exceptions and formats them into a consistent JSON response.
 *
 * Response format:
 * ```json
 * {
 *   "statusCode": 500,
 *   "hasError": true,
 *   "data": null,
 *   "message": "Internal server error"
 * }
 * ```
 *
 * For `HttpException` subclasses, the status code and message are extracted.
 * For class-validator errors (arrays of messages), they are joined into a single string.
 * Internal server errors (500) are logged with the full stack trace.
 *
 * @example
 * // Registered globally in main.ts:
 * app.useGlobalFilters(new AllExceptionsFilter());
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  /** @private Logger instance scoped to this filter */
  private readonly logger = new Logger(AllExceptionsFilter.name);

  /**
   * Handles the caught exception and sends a uniform error response.
   *
   * @param {unknown} exception - The caught exception (may be HttpException or any Error)
   * @param {ArgumentsHost} host - The NestJS arguments host for accessing request/response
   */
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let data: unknown = null;
    let code: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exResponse = exception.getResponse();

      if (typeof exResponse === 'string') {
        message = exResponse;
      } else {
        const obj = exResponse as Record<string, unknown>;

        // Handle class-validator array of messages
        if (Array.isArray(obj.message)) {
          message = (obj.message as string[]).join(', ');
        } else {
          message = obj.message?.toString() || exception.message;
        }

        if ('data' in obj) {
          data = obj.data;
        }

        // Forward a machine-readable error code when the exception provides one
        // (e.g. 'email_send_failed', 'email_not_confirmed') — clients branch on
        // it, and rebuilding the body below would otherwise silently drop it.
        if (typeof obj.code === 'string' && obj.code.length > 0) {
          code = obj.code;
        }
      }
    }

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${redactUrlForLog(request.url)} - ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if ((status as number) >= 400) {
      // 4xx diagnostics belong HERE, not in LoggingInterceptor.
      //
      // Nest runs guards BEFORE interceptors, so anything a guard throws —
      // SupabaseAuthGuard 401s, FeatureGuard 403s, the throttler's 429s — never
      // enters the interceptor at all (next.handle() is never called). Those are
      // exactly the failures being triaged, and until now they were logged
      // nowhere: the filter only logged 500s.
      //
      // cookieBytes/dupCookies: the reverse proxy is not in this repo, so its
      // limits are unknown from here. nginx defaults to
      // `large_client_header_buffers 4 8k` and rejects anything larger with a
      // 400/431 carrying no CORS headers — which the browser reports as a CORS
      // error and which never reaches this app. Logging the size on requests
      // that DO arrive is what makes proximity to that ceiling visible.
      // Duplicate names matter separately: Node's parser keeps the FIRST of a
      // repeated cookie while Next's Edge parser keeps the LAST, so the two
      // tiers can disagree about the session while each looks self-consistent.
      const typed = request as Request & {
        user?: { userId?: string; organizationId?: string };
        _orgSource?: string;
      };
      const rawCookie = request.headers.cookie ?? '';
      const names = rawCookie
        .split(';')
        .map((c) => c.split('=')[0]?.trim())
        .filter((n): n is string => Boolean(n));
      const dupes = [
        ...new Set(names.filter((n, i) => names.indexOf(n) !== i)),
      ];

      this.logger.warn(
        `${request.method} ${redactUrlForLog(request.url)} - ${status} ` +
          `ip=${request.ip || 'unknown'} user=${typed.user?.userId || '-'} ` +
          `org=${typed.user?.organizationId || '-'} orgSrc=${typed._orgSource || '-'} ` +
          `origin=${request.headers.origin || '-'} ` +
          `cookieBytes=${Buffer.byteLength(rawCookie, 'utf8')} cookieCount=${names.length}` +
          (dupes.length ? ` dupCookies=${dupes.join('|')}` : ''),
      );
    }

    // CORS headers on error responses. NestJS's `enableCors` attaches CORS to
    // SUCCESS responses, but errors thrown before/inside the route handler can
    // bypass that pipeline — leaving the browser to report the failure as a
    // generic "CORS error" without exposing the actual status. We mirror the
    // allowlist from main.ts so JS gets to see (and react to) 401/429/503/5xx.
    const origin = request.headers.origin;

    if (typeof origin === 'string' && origin.length > 0) {
      const allowedOrigins = (
        process.env.ALLOWED_ORIGINS ||
        process.env.FRONTEND_URL ||
        'http://localhost:3000'
      )
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);

      if (allowedOrigins.includes(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Credentials', 'true');
        response.setHeader('Vary', 'Origin');
      }
    }

    // Set Retry-After on 429 (rate limit) so clients can back off accurately.
    // The value is the throttler window in seconds — derived from THROTTLE_TTL
    // env (defaults to 60000ms = 60s). Without this header, frontends typically
    // fall back to fixed exponential backoff which still hammers the limit.
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      const ttlMs = parseInt(process.env.THROTTLE_TTL || '60000', 10);
      const retryAfterSec = Math.max(
        1,
        Math.ceil((Number.isFinite(ttlMs) ? ttlMs : 60000) / 1000),
      );

      response.setHeader('Retry-After', String(retryAfterSec));
    }

    // Uniform error response format (code is optional — only when provided)
    response.status(status).json({
      statusCode: status,
      hasError: true,
      data,
      message,
      ...(code ? { code } : {}),
    });
  }
}
