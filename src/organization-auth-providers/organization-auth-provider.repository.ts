import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

export interface OrganizationAuthProviderRow {
  id: string;
  organization_id: string;
  provider: string;
  is_enabled: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Data access for per-org external-SSO provider toggles
 * (`organization_auth_providers`). Mirrors `OrganizationModuleRepository`.
 *
 * Uses the service-role admin client (RLS bypassed) with explicit
 * `organization_id` scoping in every query — the same contract as the rest of
 * xisuite-backend.
 */
@Injectable()
export class OrganizationAuthProviderRepository {
  private static readonly TABLE = 'organization_auth_providers';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getProvider(
    organizationId: string,
    provider: string,
  ): Promise<OrganizationAuthProviderRow | null> {
    const result = (await this.client
      .from(OrganizationAuthProviderRepository.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('provider', provider)
      .maybeSingle()) as {
      data: OrganizationAuthProviderRow | null;
      error: { message: string } | null;
    };

    if (result.error) throw new BadRequestException(result.error.message);
    return result.data ?? null;
  }

  async listForOrg(
    organizationId: string,
  ): Promise<OrganizationAuthProviderRow[]> {
    const { data, error } = await this.client
      .from(OrganizationAuthProviderRepository.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .order('provider', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as OrganizationAuthProviderRow[];
  }

  async upsert(
    organizationId: string,
    provider: string,
    isEnabled: boolean,
    userId: string,
  ): Promise<OrganizationAuthProviderRow> {
    const upsertResult = (await this.client
      .from(OrganizationAuthProviderRepository.TABLE)
      .upsert(
        {
          organization_id: organizationId,
          provider,
          is_enabled: isEnabled,
          created_by: userId,
          updated_by: userId,
        },
        { onConflict: 'organization_id,provider' },
      )
      .select()
      .single()) as {
      data: OrganizationAuthProviderRow | null;
      error: { message: string } | null;
    };

    if (upsertResult.error)
      throw new BadRequestException(upsertResult.error.message);
    return upsertResult.data as OrganizationAuthProviderRow;
  }
}
