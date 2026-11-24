/**
 * @fileoverview Who the caller is, for the calendar access rules.
 *
 * Read on every request from the application's own membership table, so a share is never a copied
 * membership: someone who leaves the organization stops matching on the next call. Sharing names a
 * person, a space role or the whole space — the space role and the space itself come from the space
 * grant, so this only has to answer for the organization.
 */
import { Injectable } from '@nestjs/common';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';

export interface CalendarPrincipals {
  userId: string;

  /** Organization owner or admin, who administers the calendars of their own tenant. */
  isOrgAdmin: boolean;

  /** The organization owner alone; outside a space only they are let in by role. */
  isOrgOwner?: boolean;

  /** Still a member of the organization: a share to someone who left grants nothing. */
  isOrgMember: boolean;
}

@Injectable()
export class CalendarPrincipalsService {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async resolve(
    userId: string,
    organizationId: string,
  ): Promise<CalendarPrincipals> {
    const { data } = await this.client
      .from('organization_members')
      .select('role')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .maybeSingle();

    const orgRole = (data as { role?: string } | null)?.role ?? null;

    return {
      userId,
      isOrgAdmin: orgRole === 'owner' || orgRole === 'admin',
      isOrgOwner: orgRole === 'owner',
      isOrgMember: Boolean(orgRole),
    };
  }
}
