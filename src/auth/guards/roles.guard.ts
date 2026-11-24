/**
 * @fileoverview Guard that enforces organization-level role requirements on route handlers.
 * Checks the user's role in `organization_members` against the roles specified
 * by the {@link RequireRoles} decorator.
 * @module src/auth/guards/roles.guard
 * @author Prince Jadiya
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/require-roles.decorator';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { RequestUser } from '../interfaces/request-user.interface';
import type { Request } from 'express';

/**
 * Guard that checks whether the authenticated user holds one of the required organization roles.
 *
 * Security flow:
 * 1. Read required roles from route metadata (set by `@RequireRoles()`)
 * 2. If no roles are required, allow access
 * 3. Extract the {@link RequestUser} from the request (set by {@link SupabaseAuthGuard})
 * 4. Query `organization_members` for the user's role in their current organization
 * 5. If the user's role is in the required list, allow access; otherwise throw `ForbiddenException`
 *
 * @example
 * // Use with the decorator on a controller method:
 * @UseGuards(RolesGuard)
 * @RequireRoles('owner', 'admin')
 * async deleteOrg() { ... }
 */
@Injectable()
export class RolesGuard implements CanActivate {
  /**
   * @param {Reflector} reflector - NestJS reflector for reading route metadata
   * @param {SupabaseAdminService} supabaseAdmin - Admin client to query organization membership
   */
  constructor(
    private reflector: Reflector,
    private supabaseAdmin: SupabaseAdminService,
  ) {}

  /**
   * Determines whether the current request meets the role requirements.
   *
   * @param {ExecutionContext} context - The NestJS execution context
   * @returns {Promise<boolean>} `true` if the user has a required role
   * @throws {ForbiddenException} When no user context is found or the user lacks the required role
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as Request & { user: RequestUser }).user;

    if (!user) {
      throw new ForbiddenException('No user context found');
    }

    const { data: membership } = await this.supabaseAdmin
      .getClient()
      .from('organization_members')
      .select('role')
      .eq('user_id', user.userId)
      .eq('organization_id', user.organizationId)
      .single();

    if (!membership || !requiredRoles.includes(membership.role as string)) {
      throw new ForbiddenException('Insufficient role');
    }

    return true;
  }
}
