/**
 * @fileoverview Guard that enforces space-level permission requirements on route handlers.
 * Checks the user's space membership, custom permissions, and falls back to base space role
 * permissions. Organization admins/owners automatically bypass this check.
 * @module src/auth/guards/space-permissions.guard
 * @author Prince Jadiya
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  SPACE_PERMISSION_KEY,
  SPACE_PERMISSION_ORG_ANY_KEY,
} from '../decorators/require-space-permission.decorator';
import { PermissionsService } from '../../permissions/permissions.service';
import {
  isTestManagementPermission,
  spaceGrantAllows,
} from '../../permissions/models/space-permissions.model';
import type { RequestUser } from '../interfaces/request-user.interface';
import type { Request } from 'express';

/**
 * Guard that checks whether the authenticated user has a specific permission within a space.
 *
 * Security flow:
 * 1. Read the required space permission from route metadata (set by `@RequireSpacePermission()`)
 * 2. If no permission is required, allow access
 * 3. Extract the {@link RequestUser} and the `spaceId` from params, query, or body
 * 4. If the user is an organization admin or owner, allow access immediately
 * 5. Query `space_members` for the user's space membership
 * 6. Check the user's custom space permissions (flat key lookup without `can_` prefix)
 * 7. Fall back to base space role permissions from {@link SPACE_ROLE_BASE_PERMISSIONS}
 * 8. If no permission grants access, throw `ForbiddenException`
 *
 * @example
 * // Use with the decorator on a controller method:
 * @UseGuards(SpacePermissionsGuard)
 * @RequireSpacePermission('can_edit_tasks')
 * async updateTask() { ... }
 */
@Injectable()
export class SpacePermissionsGuard implements CanActivate {
  /**
   * @param {Reflector} reflector - NestJS reflector for reading route metadata
   * @param {PermissionsService} permissionsService - Resolves the space grant (admin status,
   *   membership, explicit and base-role permissions)
   */
  constructor(
    private reflector: Reflector,
    private permissionsService: PermissionsService,
  ) {}

  /**
   * Determines whether the current request meets the space permission requirement.
   *
   * @param {ExecutionContext} context - The NestJS execution context
   * @returns {Promise<boolean>} `true` if the user has the required space permission
   * @throws {ForbiddenException} When no user context, no space ID, user is not a space member,
   *   or the user lacks the required permission
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermission = this.reflector.getAllAndOverride<string>(
      SPACE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermission) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as Request & { user: RequestUser }).user;

    if (!user) {
      throw new ForbiddenException('No user context found');
    }

    // Extract spaceId from params, query, or body
    const params = request.params as Record<string, string>;
    const query = request.query as Record<string, string>;
    const body = request.body as Record<string, string> | undefined;
    const spaceId =
      params?.spaceId ||
      params?.id ||
      query?.spaceId ||
      body?.spaceId ||
      body?.space_id;

    if (!spaceId) {
      throw new BadRequestException('spaceId is required');
    }

    const flatPermission = requiredPermission.replace(/^can_/, '');

    // Test Management keys follow the per-space overrides; every other key keeps the path below.
    if (isTestManagementPermission(flatPermission)) {
      const testGrant =
        await this.permissionsService.resolveTestManagementPermissions(
          user.userId,
          user.organizationId,
          spaceId,
        );

      if (!testGrant.isMember) {
        throw new ForbiddenException('Not a member of this space');
      }
      if (testGrant.permissions[flatPermission]) return true;

      throw new ForbiddenException('Insufficient space permissions');
    }

    // Steps 4-7 live in PermissionsService.resolveSpaceBaseGrant + spaceGrantAllows so
    // that non-guarded call sites (e.g. the File Explorer node-level access gate) reach
    // the same verdict this guard reaches. Keeping a second copy here is what let those
    // two drift apart and 404 requests the guard had already admitted.
    const grant = await this.permissionsService.resolveSpaceBaseGrant(
      user.userId,
      user.organizationId,
      spaceId,
    );

    if (!grant.isAdmin && !grant.isMember) {
      throw new ForbiddenException('Not a member of this space');
    }

    if (spaceGrantAllows(grant, requiredPermission)) {
      return true;
    }

    // Org-level Space Management permissions (Settings → Access → Space Permissions) also grant in member spaces.
    if (
      await this.permissionsService.orgGrantsSpacePermission(
        user.userId,
        user.organizationId,
        requiredPermission,
      )
    ) {
      return true;
    }

    // Opt-in granular org keys (e.g. can_edit_wiki_labels); non-members were rejected above
    const orgAny = this.reflector.getAllAndOverride<string[] | undefined>(
      SPACE_PERMISSION_ORG_ANY_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (
      Array.isArray(orgAny) &&
      orgAny.length > 0 &&
      (await this.permissionsService.hasAnyPermission(
        user.userId,
        user.organizationId,
        orgAny,
      ))
    ) {
      return true;
    }

    throw new ForbiddenException('Insufficient space permissions');
  }
}
