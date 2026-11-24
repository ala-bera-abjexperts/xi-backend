/**
 * @fileoverview Checks what a calendar route returns against its Zod shape and logs a drift.
 *
 * Deliberately **warn-only**: it hands the original payload straight through and never reshapes it.
 * A response is not a client's input — refusing one would turn a cosmetic mismatch into an outage,
 * and returning Zod's parsed copy would strip columns a screen may already rely on. The value here
 * is a line in the log when a service changes a shape, not a gate.
 * @module src/calendar/calendar-response.interceptor
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

import { calendarResponseSchema } from './dto/calendar-response.schemas';

@Injectable()
export class CalendarResponseInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CalendarResponseInterceptor.name);

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
      // A 204 and a plain string body are both legitimate and carry no shape to check.
      if (
        payload === null ||
        payload === undefined ||
        typeof payload !== 'object'
      )
        return;

      const items = Array.isArray(payload) ? payload : [payload];
      const failed = items.filter(
        (item) => !calendarResponseSchema.safeParse(item).success,
      );

      if (failed.length > 0) {
        this.logger.warn(
          `${route} returned ${failed.length} of ${items.length} rows that match no calendar response shape`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `${route} response could not be checked: ${String(error)}`,
      );
    }
  }
}
