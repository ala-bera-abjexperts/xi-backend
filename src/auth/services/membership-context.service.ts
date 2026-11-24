// Shared provider that loads a user's organization memberships. Extracted from
// SupabaseAuthGuard so that guard and McpServiceTokenGuard resolve memberships
// through one behavior-identical implementation, with no drift between the
// normal and service-to-service auth paths.

import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { RequestUserMembership } from '../interfaces/request-user.interface';

// Membership row shape pulled from the `organization_members JOIN organizations`
// query. Kept private to this module; consumers see RequestUserMembership.
interface MembershipRow {
  organization_id: string;
  role: string;
  organizations:
    | { slug: string; is_active: boolean | null }
    | { slug: string; is_active: boolean | null }[]
    | null;
}

// Loads every organization a public user belongs to. This is the single source
// of truth for membership resolution, shared by both SupabaseAuthGuard (normal
// Bearer auth) and McpServiceTokenGuard (S2S auth). The implementation is
// intentionally byte-for-byte identical to the previous in-guard logic so both
// paths produce the same `memberships` array.
@Injectable()
export class MembershipContextService {
  private readonly logger = new Logger(MembershipContextService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  // Loads every organization the given public user belongs to, joined to the
  // organizations row so the slug is available without a second round-trip.
  //
  // Ordering is `organization_members.created_at ASC` so the first row is the
  // user's oldest membership, used as the "default tenant" when no
  // `active_org_id` cookie is present.
  //
  // Throws ServiceUnavailableException (503) on a real DB error so callers see
  // the outage rather than a silent "onboarding mode" 200 cascade. A
  // legitimately empty result set is returned as `[]`, the brand-new-user /
  // no-memberships path, distinct from "Postgres is down".
  async loadMemberships(userId: string): Promise<RequestUserMembership[]> {
    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from('organization_members')
      .select(
        'organization_id, role, organizations:organizations(slug, is_active)',
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (error) {
      // Surface the failure as 503 rather than masking it as an empty list.
      // The previous behaviour silently downgraded every authenticated
      // request to onboarding state (organizationId = '') during a Supabase
      // blip, returning 200s with empty tenant data — the caller saw "no
      // memberships" instead of "service degraded" and reacted incorrectly
      // (e.g. redirecting to /onboarding).
      this.logger.error(`Failed to load memberships: ${error.message}`);
      throw new ServiceUnavailableException(
        'Failed to resolve tenant memberships',
      );
    }

    const rows = (data ?? []) as MembershipRow[];

    return rows.flatMap((row) => {
      const org = Array.isArray(row.organizations)
        ? row.organizations[0]
        : row.organizations;
      const slug = org?.slug ?? '';
      const role = row.role as RequestUserMembership['role'];

      // Deactivated orgs (is_active = false) are dropped from the active
      // membership set so they can never become the resolved active org.
      // On a deactivated tenant subdomain the x-tenant-slug then matches no
      // membership → organizationId resolves to '' and org-scoped handlers
      // deny the request (same path as the onboarding/empty-org state).
      // Counting these "all my orgs are deactivated" users is handled in
      // auth.service bootstrap()/signin() via a separate total-count query.
      if (org && org.is_active === false) {
        return [];
      }

      // The DB CHECK constraint already restricts role to the allowed values
      // (owner/admin/member/viewer); a row that fails this cast indicates a
      // schema/data drift bug, so we drop it from memberships rather than
      // attaching an invalid role to RequestUser.
      if (!['owner', 'admin', 'member', 'viewer'].includes(role)) {
        this.logger.warn(
          `Skipping membership with unexpected role "${row.role}" for user ${userId} / org ${row.organization_id}`,
        );
        return [];
      }

      return [
        {
          organizationId: row.organization_id,
          organizationSlug: slug,
          role,
        },
      ];
    });
  }
}
