/**
 * @fileoverview Decorator that restricts route access to users with specific organization roles.
 * Used in conjunction with {@link RolesGuard} to enforce role-based access control.
 * @module src/auth/decorators/require-roles.decorator
 * @author Prince Jadiya
 */

import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key used by {@link RolesGuard} to read required roles.
 * @constant {string}
 */
export const ROLES_KEY = 'roles';

/**
 * Decorator that requires the authenticated user to hold one of the specified organization roles.
 *
 * @param {...string[]} roles - One or more role names (e.g., `'owner'`, `'admin'`, `'member'`)
 * @returns {MethodDecorator} A NestJS metadata decorator
 *
 * @example
 * @RequireRoles('owner', 'admin')
 * @Delete(':id')
 * async deleteOrganization(@Param('id') id: string) { ... }
 */
export const RequireRoles = (...roles: string[]) =>
  SetMetadata(ROLES_KEY, roles);
