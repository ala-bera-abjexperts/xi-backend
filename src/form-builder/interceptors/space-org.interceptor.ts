/**
 * @fileoverview Interceptor for the authenticated form-builder controllers that pins the
 * request's effective organization to the org that actually OWNS the space in the route,
 * instead of the caller's currently-active organization.
 *
 * Why this exists:
 * Form-builder controllers scope every query by `user.organizationId` — the active org
 * resolved from the `active_org_id` cookie by SupabaseAuthGuard. But `SpacePermissionsGuard`
 * authorizes purely by SPACE MEMBERSHIP, not by org. So a user who belongs to several orgs
 * and opens a space owned by a DIFFERENT org than their active one would see empty reads and
 * 404 writes for a space they legitimately have access to (responses panel shows
 * "NO RESPONSES YET"; submits fail). A space's id uniquely determines its org, so we resolve
 * the space's org and — ONLY when the caller is genuinely a member of that org — pin
 * `user.organizationId` to it. The membership check guarantees this can never widen access to
 * an org the user is not already a member of; for a single-org user it is a no-op.
 * @module src/form-builder/interceptors/space-org.interceptor
 * @author Prince Jadiya
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Request } from 'express';

import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';

/**
 * Corrects the active-org "lens" to the route space's owning org for form-builder requests.
 *
 * Runs after the auth/permission guards, so `request.user` and the space-membership check are
 * already in place; this only fixes which org's rows the handler's queries target.
 */
@Injectable()
export class FormBuilderSpaceOrgInterceptor implements NestInterceptor {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  /**
   * @param {ExecutionContext} context - The NestJS execution context
   * @param {CallHandler} next - The next handler in the chain
   * @returns {Promise<Observable<unknown>>} The handler observable, unchanged
   */
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: RequestUser }>();
    const user = request.user;
    const params = request.params as Record<string, string>;
    const spaceId = params?.spaceId ?? params?.id;

    // Public routes (e.g. the Stripe payment funnel) have no user and resolve their org
    // server-side from the form record, so there is nothing to correct here.
    if (user && spaceId) {
      // Never let org resolution break the request — on any failure we simply fall back to
      // the caller's active org (the pre-existing behaviour).
      try {
        const { data } = await this.supabaseAdmin
          .getClient()
          .from('spaces')
          .select('organization_id')
          .eq('id', spaceId)
          .maybeSingle();

        const spaceOrgId = (data as { organization_id?: string } | null)
          ?.organization_id;

        // Pin the effective org to the space's org ONLY when the caller belongs to it — this
        // corrects the active-org lens without ever granting access to a non-member org.
        if (
          spaceOrgId &&
          user.memberships?.some((m) => m.organizationId === spaceOrgId)
        ) {
          user.organizationId = spaceOrgId;
        }
      } catch {
        // swallow — proceed with the active org already on the request
      }
    }

    return next.handle();
  }
}
