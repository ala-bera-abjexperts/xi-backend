/**
 * @fileoverview Custom decorator that marks a route handler as publicly accessible,
 * bypassing the global {@link SupabaseAuthGuard}. Applied via `@Public()` on controller methods.
 * @module src/auth/decorators/public.decorator
 * @author Prince Jadiya
 */

import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key used by {@link SupabaseAuthGuard} to detect public routes.
 * @constant {string}
 */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Decorator that marks a route as public (no authentication required).
 *
 * When applied to a controller method, the {@link SupabaseAuthGuard} will skip
 * JWT verification and allow unauthenticated access.
 *
 * @returns {MethodDecorator} A NestJS metadata decorator
 *
 * @example
 * @Public()
 * @Get('health')
 * getHealth() { return { status: 'ok' }; }
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
