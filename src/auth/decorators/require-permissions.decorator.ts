/**
 * @fileoverview Decorator and interface for requiring specific permissions on a route handler.
 * Used with {@link PermissionsGuard} to enforce organization-level permission checks.
 * Supports both AND (all required) and OR (any required) logic.
 * @module src/auth/decorators/require-permissions.decorator
 * @author Prince Jadiya
 */

import { SetMetadata } from '@nestjs/common';

/**
 * Configuration options for the permissions requirement.
 */
export interface PermissionOptions {
  /** Array of permission keys that must be satisfied (e.g., `['can_invite_users', 'can_edit_users']`) */
  permissions: string[];

  /** When `true`, uses OR logic (user needs at least one permission). Default is AND logic (all required). */
  any?: boolean; // OR logic (default: AND)
}

/**
 * Metadata key used by {@link PermissionsGuard} to read permission requirements.
 * @constant {string}
 */
export const PERMISSIONS_KEY = 'permissions';

/**
 * Decorator that requires the authenticated user to have specific permissions.
 *
 * By default, all listed permissions must be satisfied (AND logic).
 * Pass `{ any: true }` to require at least one permission (OR logic).
 *
 * @param {string | string[]} permissions - One or more permission keys (e.g., `'can_invite_users'`)
 * @param {{ any?: boolean }} [options] - Optional configuration for OR logic
 * @returns {MethodDecorator} A NestJS metadata decorator
 *
 * @example
 * // Require a single permission:
 * @RequirePermissions('can_invite_users')
 *
 * @example
 * // Require ANY of multiple permissions:
 * @RequirePermissions(['can_edit_users', 'can_remove_users'], { any: true })
 */
export const RequirePermissions = (
  permissions: string | string[],
  options?: { any?: boolean },
) => {
  const perms = Array.isArray(permissions) ? permissions : [permissions];
  return SetMetadata(PERMISSIONS_KEY, {
    permissions: perms,
    any: options?.any ?? false,
  } as PermissionOptions);
};
