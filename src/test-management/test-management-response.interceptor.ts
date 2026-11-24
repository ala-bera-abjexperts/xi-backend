/**
 * @fileoverview Checks what a Test Management route returns against its Zod shape and logs a drift.
 *
 * Warn-only, like the calendar interceptor: the original payload is handed straight through and
 * never reshaped, so a mismatch costs a log line, never a failed request or a dropped field.
 * @module src/test-management/test-management-response.interceptor
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { testManagementResponseSchema } from './dto/test-management-response.schemas';

@Injectable()
export class TestManagementResponseInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TestManagementResponseInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context
      .switchToHttp()
      .getRequest<{ method: string; url: string }>();
    const route = `${request?.method ?? '?'} ${request?.url ?? '?'}`;

    return next.handle().pipe(
      map((payload: unknown) => {
        this.check(payload, route);

        return payload;
      }),
    );
  }

  /** Nothing here may throw: a drift is worth a log line, never a failed request. */
  private check(payload: unknown, route: string): void {
    try {
      // A 204 has no body and an empty list has nothing to check.
      if (payload === null || payload === undefined) return;

      const items = Array.isArray(payload) ? payload : [payload];
      const failed = items.filter(
        (item) => !testManagementResponseSchema.safeParse(item).success,
      );

      if (failed.length > 0) {
        this.logger.warn(
          `${route} returned ${failed.length} of ${items.length} rows that match no test management response shape`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `${route} response could not be checked: ${String(error)}`,
      );
    }
  }
}
