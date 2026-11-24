/**
 * @fileoverview Guard that enforces organization-level permission requirements on route handlers.
 * Supports both AND and OR logic for multiple permissions, and falls back to space-level
 * permissions when a `spaceId` is available in the request.
 * @module src/auth/guards/permissions.guard
 * @author Prince Jadiya
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PERMISSIONS_KEY,
  PermissionOptions,
} from '../decorators/require-permissions.decorator';
import { PermissionsService } from '../../permissions/permissions.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { RequestUser } from '../interfaces/request-user.interface';
import type { Request } from 'express';

/**
 * Guard that checks whether the authenticated user has the required permissions.
 *
 * Security flow:
 * 1. Read permission options from route metadata (set by `@RequirePermissions()`)
 * 2. If no permissions are required, allow access
 * 3. Extract the {@link RequestUser} from the request
 * 4. Check organization-level permissions via {@link PermissionsService} (AND or OR logic)
 * 5. If org-level check fails and a `spaceId` is present, fall back to space-level permissions
 *    by querying `space_members` for the user's space role and custom permissions
 * 6. If all checks fail, throw `ForbiddenException`
 *
 * @example
 * // Use with the decorator on a controller method:
 * @UseGuards(PermissionsGuard)
 * @RequirePermissions('can_invite_users')
 * async invite() { ... }
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  /**
   * @param {Reflector} reflector - NestJS reflector for reading route metadata
   * @param {PermissionsService} permissionsService - Service for resolving effective permissions
   * @param {SupabaseAdminService} supabaseAdmin - Admin client for space membership fallback queries
   */
  constructor(
    private reflector: Reflector,
    private permissionsService: PermissionsService,
    private supabaseAdmin: SupabaseAdminService,
  ) {}

  /**
   * Determines whether the current request meets the permission requirements.
   *
   * @param {ExecutionContext} context - The NestJS execution context
   * @returns {Promise<boolean>} `true` if the user has the required permissions
   * @throws {ForbiddenException} When no user context is found or the user lacks required permissions
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permOptions = this.reflector.getAllAndOverride<PermissionOptions>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!permOptions) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as Request & { user: RequestUser }).user;

    if (!user) {
      throw new ForbiddenException('No user context found');
    }

    const { permissions, any } = permOptions;
    let hasAccess: boolean;

    if (any) {
      hasAccess = await this.permissionsService.hasAnyPermission(
        user.userId,
        user.organizationId,
        permissions,
      );
    } else {
      hasAccess = await this.permissionsService.hasAllPermissions(
        user.userId,
        user.organizationId,
        permissions,
      );
    }

    if (!hasAccess) {
      // Fallback: check space-level permissions when spaceId is available
      const spaceId =
        (request.query as Record<string, string>)?.spaceId ||
        (request.params as Record<string, string>)?.spaceId ||
        (await this.resolveSpaceIdFromRequest(request, user.organizationId));

      if (spaceId) {
        const client = this.supabaseAdmin.getClient();

        // Check space membership
        const memberResult = await client
          .from('space_members')
          .select('space_role, permissions')
          .eq('space_id', spaceId)
          .eq('user_id', user.userId)
          .eq('is_active', true)
          .maybeSingle();
        const spaceMember = memberResult.data as {
          space_role: string;
          permissions: Record<string, boolean> | null;
        } | null;
        if (spaceMember) {
          const check = (p: string) => {
            const flatKey = p.startsWith('can_') ? p.slice(4) : p;
            return (spaceMember.permissions || {})[flatKey] === true;
          };
          hasAccess = any ? permissions.some(check) : permissions.every(check);
        }
      }
    }

    if (!hasAccess) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }

  private async resolveSpaceIdFromRequest(
    request: Request,
    organizationId: string,
  ): Promise<string | undefined> {
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    const routePath =
      (request.route as { path?: string } | undefined)?.path ??
      request.path ??
      '';
    const client = this.supabaseAdmin.getClient();

    if (routePath.includes('/tasks') && (body.spaceId || body.space_id)) {
      return body.spaceId ?? body.space_id;
    }

    // Wiki field assignments are space-scoped resources whose space arrives in
    // the BODY (create) or has to be read back from the row (update/delete).
    // Without this a space admin with manage_custom_fields got a blanket 403,
    // while the UI — which reads effective (space-inclusive) permissions —
    // still rendered the controls as enabled.
    if (routePath.includes('wiki-assignments')) {
      if (body.spaceId || body.space_id) return body.spaceId ?? body.space_id;

      if (params.id) {
        const { data } = await client
          .from('wiki_field_assignments')
          .select('space_id')
          .eq('id', params.id)
          .eq('organization_id', organizationId)
          .maybeSingle();

        return (data as { space_id?: string } | null)?.space_id;
      }
    }

    const processId = query.processId ?? query.process_id ?? body.process_id;

    if (routePath.includes('/tasks') && processId) {
      const { data } = await client
        .from('business_processes')
        .select('space_id')
        .eq('id', processId)
        .eq('organization_id', organizationId)
        .maybeSingle();

      return (data as { space_id?: string } | null)?.space_id;
    }

    if (routePath.includes('/tasks/by-key') && params.key) {
      const { data } = await client
        .from('tasks')
        .select('space_id')
        .eq('key', params.key)
        .eq('organization_id', organizationId)
        .maybeSingle();

      return (data as { space_id?: string } | null)?.space_id;
    }

    if (routePath.includes('/tasks') && params.id) {
      const { data } = await client
        .from('tasks')
        .select('space_id')
        .eq('id', params.id)
        .eq('organization_id', organizationId)
        .maybeSingle();

      return (data as { space_id?: string } | null)?.space_id;
    }

    return undefined;
  }
}
