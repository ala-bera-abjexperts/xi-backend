/**
 * @fileoverview Decorator that marks routes as requiring the caller's active
 * organization to be a Partner organization (`organizations.is_partner = true`).
 * Used with {@link PartnerGuard}. Layer org-level permission checks on top with
 * `@RequirePermissions('can_*_partner_*')`.
 * @module src/auth/decorators/require-partner.decorator
 */

import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PARTNER_KEY = 'requirePartner';

/**
 * Require the request's active organization to be a partner org.
 *
 * @example
 * @RequirePartner()
 * @Controller('partner/profile')
 * export class PartnerProfileController {}
 */
export const RequirePartner = () => SetMetadata(REQUIRE_PARTNER_KEY, true);
