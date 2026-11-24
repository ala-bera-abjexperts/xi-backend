/**
 * @fileoverview Guard enforcing that the caller's active organization is a Partner
 * organization (`organizations.is_partner = true`). Only acts on routes decorated
 * with {@link RequirePartner}; otherwise it is a no-op. Mirrors {@link SuperAdminGuard}
 * but checks an org-level flag rather than the JWT app_metadata.
 * @module src/auth/guards/partner.guard
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { REQUIRE_PARTNER_KEY } from '../decorators/require-partner.decorator';
import type { RequestUser } from '../interfaces/request-user.interface';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';

@Injectable()
export class PartnerGuard implements CanActivate {
  private readonly logger = new Logger(PartnerGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiresPartner = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_PARTNER_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiresPartner) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = (request as Request & { user?: RequestUser }).user;

    if (!user) {
      throw new ForbiddenException('No user context found');
    }

    if (!user.organizationId) {
      throw new ForbiddenException('No active organization');
    }

    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('organizations')
      .select('is_partner')
      .eq('id', user.organizationId)
      .maybeSingle();

    if (error) {
      this.logger.error(`Failed to check partner status: ${error.message}`);
      throw new ForbiddenException('Authorization check failed');
    }

    const isPartner =
      (data as { is_partner?: boolean } | null)?.is_partner === true;

    if (!isPartner) {
      throw new ForbiddenException('Partner organization access required');
    }

    return true;
  }
}
