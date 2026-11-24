/**
 * @fileoverview Decorator that restricts route access based on a specific space-level permission.
 * Used with {@link SpacePermissionsGuard} to enforce fine-grained access control within spaces.
 * @module src/auth/decorators/require-space-permission.decorator
 * @author Prince Jadiya
 */

import { applyDecorators, SetMetadata } from '@nestjs/common';

/**
 * Metadata key used by {@link SpacePermissionsGuard} to read the required space permission.
 * @constant {string}
 */
export const SPACE_PERMISSION_KEY = 'spacePermission';

/** Optional org permission keys that also admit a space member when the space grant fails. */
export const SPACE_PERMISSION_ORG_ANY_KEY = 'spacePermissionOrgAny';

/**
 * Decorator that requires the authenticated user to have a specific permission within a space.
 *
 * The space ID is extracted from request params, query, or body by the guard.
 * Organization admins/owners automatically bypass this check.
 *
 * @param {string} permission - The space permission key (e.g., `'can_edit_tasks'`, `'view_processes'`)
 * @param {string[]} [orgAny] - Org permission keys, any of which also grants access to a space member
 * @returns {MethodDecorator} A NestJS metadata decorator
 *
 * @example
 * @RequireSpacePermission('can_edit_tasks')
 * @Patch(':spaceId/tasks/:taskId')
 * async updateTask(...) { ... }
 */
export const RequireSpacePermission = (
  permission: string,
  orgAny?: string[],
) =>
  orgAny
    ? applyDecorators(
        SetMetadata(SPACE_PERMISSION_KEY, permission),
        SetMetadata(SPACE_PERMISSION_ORG_ANY_KEY, orgAny),
      )
    : SetMetadata(SPACE_PERMISSION_KEY, permission);
