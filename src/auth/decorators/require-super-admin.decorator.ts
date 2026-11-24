/**
 * @fileoverview Decorator that marks routes as requiring platform Super Admin authority.
 * Used with {@link SuperAdminGuard}.
 * @module src/auth/decorators/require-super-admin.decorator
 */

import { SetMetadata } from '@nestjs/common';

export const SUPER_ADMIN_KEY = 'superAdmin';

export const RequireSuperAdmin = () => SetMetadata(SUPER_ADMIN_KEY, true);
