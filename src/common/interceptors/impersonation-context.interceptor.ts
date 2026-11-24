/**
 * @fileoverview Global interceptor that establishes the request-scoped
 * impersonation audit context (see {@link impersonationAls}) around every
 * request handler. Runs AFTER guards, so `request.user` is already populated by
 * the SupabaseAuthGuard. Wrapping the downstream subscription in a fresh
 * Observable guarantees the handler — and every async service call it awaits —
 * executes inside the AsyncLocalStorage context, regardless of when Nest
 * subscribes.
 * @module src/common/interceptors/impersonation-context.interceptor
 */

import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { runWithImpersonationContext } from '../context/impersonation-context';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';

@Injectable()
export class ImpersonationContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ user?: RequestUser }>();
    const impersonatedByUserId = req.user?.impersonation?.realUserId ?? null;

    return new Observable((subscriber) => {
      runWithImpersonationContext({ impersonatedByUserId }, () => {
        next.handle().subscribe({
          next: (v) => subscriber.next(v),
          error: (e) => subscriber.error(e),
          complete: () => subscriber.complete(),
        });
      });
    });
  }
}
