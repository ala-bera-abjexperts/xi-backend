// Service backing GET /auth/mcp/org-memberships. Builds the whitelisted
// org-membership list the MCP org.list tool needs: [{ id, slug, name, role }].
// The membership set comes entirely from the authenticated RequestUser.memberships
// (already loaded by the auth/S2S guard), never from a request argument, which
// prevents cross-tenant enumeration. Org names are resolved with a single
// organizations WHERE id IN (...) read; deactivated orgs (is_active === false)
// are dropped, and only id, slug, name, and role are ever serialized.

import { Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { RequestUser } from '../interfaces/request-user.interface';

/**
 * One whitelisted org-membership entry returned by
 * `GET /auth/mcp/org-memberships`. Nothing outside these fields is serialized.
 */
export interface McpOrgMembership {
  id: string;
  slug: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

@Injectable()
export class McpOrgMembershipsService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  // Builds the whitelisted, active-only list of organizations the caller belongs to.
  async listOrgMemberships(user: RequestUser): Promise<McpOrgMembership[]> {
    const memberships = user.memberships ?? [];

    if (memberships.length === 0) {
      return [];
    }

    const orgIds = memberships.map((m) => m.organizationId);

    // One read for names + active flag. Whitelist columns explicitly so the
    // extra org row fields (size, default_space_id, timestamps) never leak.
    const result = await this.supabaseAdmin
      .getClient()
      .from('organizations')
      .select('id, name, slug, is_active')
      .in('id', orgIds);

    if (result.error) {
      // Fail closed: surface no orgs rather than leaking on a read error.
      return [];
    }

    type OrgRow = {
      id: string;
      name: string;
      slug: string | null;
      is_active: boolean;
    };

    const orgById = new Map<string, OrgRow>(
      ((result.data ?? []) as OrgRow[]).map((row) => [row.id, row]),
    );

    const out: McpOrgMembership[] = [];

    for (const membership of memberships) {
      const org = orgById.get(membership.organizationId);

      // Drop deactivated orgs and any membership whose org row is missing.
      if (!org || org.is_active === false) continue;

      out.push({
        id: membership.organizationId,
        slug: org.slug || membership.organizationSlug || '',
        name: org.name,
        role: membership.role,
      });
    }

    return out;
  }
}
