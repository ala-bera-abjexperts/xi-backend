/**
 * @fileoverview Decorator marking a controller class or handler as forbidden
 * while a Super-Admin impersonation overlay is active. Read by
 * {@link ImpersonationBlockedGuard}.
 * @module src/auth/decorators/impersonation-blocked.decorator
 */

import { SetMetadata } from '@nestjs/common';

/** Metadata key used by {@link ImpersonationBlockedGuard}. */
export const IMPERSONATION_BLOCKED_KEY = 'impersonationBlocked';

/**
 * Marks a route (or whole controller) as unavailable during impersonation.
 *
 * @example
 * @ImpersonationBlocked()
 * @Controller('stripe')
 * export class StripeController {}
 */
export const ImpersonationBlocked = () =>
  SetMetadata(IMPERSONATION_BLOCKED_KEY, true);
