/**
 * @fileoverview Custom parameter decorator that extracts the authenticated user (or a specific
 * property of the user) from the request object. Works in tandem with {@link SupabaseAuthGuard}
 * which attaches the {@link RequestUser} to `request.user`.
 * @module src/auth/decorators/current-user.decorator
 * @author Prince Jadiya
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestUser } from '../interfaces/request-user.interface';

/**
 * Parameter decorator that extracts the authenticated user from the request.
 *
 * Can be used without arguments to get the full {@link RequestUser} object,
 * or with a property key to extract a single field.
 *
 * @param {keyof RequestUser | undefined} data - Optional property key to extract (e.g., `'userId'`, `'email'`)
 * @param {ExecutionContext} ctx - NestJS execution context
 * @returns {RequestUser | string} The full user object or a single property value
 *
 * @example
 * // Get the full user object:
 * async getProfile(@CurrentUser() user: RequestUser) { ... }
 *
 * @example
 * // Get just the userId:
 * async getItems(@CurrentUser('userId') userId: string) { ... }
 */
export const CurrentUser = createParamDecorator(
  (data: keyof RequestUser | undefined, ctx: ExecutionContext) => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { user: RequestUser }>();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);
