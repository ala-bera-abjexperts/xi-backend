/**
 * @fileoverview Guard that enforces platform Super Admin authorization.
 * Requires both trusted Supabase Auth app_metadata and the public users.role mirror.
 * @module src/auth/guards/super-admin.guard
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SUPER_ADMIN_KEY } from '../decorators/require-super-admin.decorator';
import type { RequestUser } from '../interfaces/request-user.interface';
import type { Request } from 'express';

export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiresSuperAdmin = this.reflector.getAllAndOverride<boolean>(
      SUPER_ADMIN_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiresSuperAdmin) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as Request & { user?: RequestUser }).user;

    if (!user) {
      throw new ForbiddenException('No user context found');
    }

    const metadata = user.appMetadata ?? {};
    const hasAuthClaim =
      metadata.role === SUPER_ADMIN_ROLE || metadata.is_super_admin === true;

    if (
      !hasAuthClaim ||
      user.role !== SUPER_ADMIN_ROLE ||
      user.isActive === false
    ) {
      throw new ForbiddenException('Super Admin access required');
    }

    return true;
  }
}
