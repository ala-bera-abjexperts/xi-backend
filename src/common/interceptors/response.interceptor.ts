/**
 * @fileoverview Global response interceptor that wraps all successful responses into a uniform
 * envelope format with `statusCode`, `hasError`, `data`, and `message` fields.
 * Works in tandem with {@link AllExceptionsFilter} to ensure all API responses share the same shape.
 * @module src/common/interceptors/response.interceptor
 * @author Prince Jadiya
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import type { Response } from 'express';

/**
 * Uniform response envelope used by all successful API responses.
 *
 * @template T The type of the response data payload
 */
export interface UniformResponse<T = unknown> {
  /** The HTTP status code of the response */
  statusCode: number;

  /** Always `false` for successful responses (error responses set this to `true`) */
  hasError: boolean;

  /** The response data payload, or `null` if the response only contains a message */
  data: T | null;

  /** A human-readable status message (defaults to `"success"`) */
  message: string;
}

/**
 * Interceptor that wraps handler return values into a {@link UniformResponse} envelope.
 *
 * If the handler returns an object with a `message` property, that message is extracted
 * and used as the envelope message. If `message` is the only property, `data` is set to `null`.
 *
 * @template T The type of the response data
 *
 * @example
 * // Registered globally in main.ts:
 * app.useGlobalInterceptors(new ResponseInterceptor());
 *
 * // Handler returns: { message: 'Created', id: '123' }
 * // Response becomes: { statusCode: 201, hasError: false, data: { id: '123' }, message: 'Created' }
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  UniformResponse<T>
> {
  /**
   * Intercepts the response and wraps it in a uniform envelope.
   *
   * @param {ExecutionContext} context - The NestJS execution context
   * @param {CallHandler<T>} next - The next handler in the chain
   * @returns {Observable<UniformResponse<T>>} The wrapped response observable
   */
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<UniformResponse<T>> {
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((data) => {
        const statusCode = response.statusCode;

        // Extract message if the response has one, otherwise default
        let message = 'success';
        let responseData: T | null = data ?? null;

        if (
          responseData &&
          typeof responseData === 'object' &&
          'message' in responseData
        ) {
          const obj = responseData as Record<string, unknown>;
          message = (obj.message as string) || 'success';

          // Remove message from data if it's the only extra field alongside data
          const keys = Object.keys(obj);

          if (keys.length === 1 && keys[0] === 'message') {
            responseData = null;
          } else {
            const rest = Object.fromEntries(
              Object.entries(obj).filter(([k]) => k !== 'message'),
            );
            responseData = rest as T;
          }
        }

        return {
          statusCode,
          hasError: false,
          data: responseData,
          message,
        };
      }),
    );
  }
}
