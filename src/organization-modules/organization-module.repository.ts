import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

export interface OrganizationModuleRow {
  id: string;
  organization_id: string;
  module_type: string;
  is_enabled: boolean;
  settings: Record<string, unknown>;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class OrganizationModuleRepository {
  private static readonly TABLE = 'organization_modules';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getModule(
    organizationId: string,
    moduleType: string,
  ): Promise<OrganizationModuleRow | null> {
    const result = (await this.client
      .from(OrganizationModuleRepository.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('module_type', moduleType)
      .maybeSingle()) as {
      data: OrganizationModuleRow | null;
      error: { message: string } | null;
    };

    if (result.error) throw new BadRequestException(result.error.message);
    return result.data ?? null;
  }

  async listForOrg(organizationId: string): Promise<OrganizationModuleRow[]> {
    const { data, error } = await this.client
      .from(OrganizationModuleRepository.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .order('module_type', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as OrganizationModuleRow[];
  }

  /**
   * Space ids in this org whose `space_modules` row for `moduleType` is enabled
   * and whose space is not archived. `space_modules` has no organization_id, so
   * the tenant filter rides on the inner-joined `spaces` row.
   * ponytail: one unpaged PostgREST read, capped at its 1000-row default; page
   * it if a tenant ever has more enabled spaces than that.
   */
  async listEnabledSpaceIds(
    organizationId: string,
    moduleType: string,
    spaceIds?: string[],
  ): Promise<string[]> {
    let query = this.client
      .from('space_modules')
      .select('space_id, spaces!inner(id)')
      .eq('module_type', moduleType)
      .eq('is_enabled', true)
      .eq('spaces.organization_id', organizationId)
      .not('spaces.is_archived', 'is', true);
    if (spaceIds) query = query.in('space_id', spaceIds);

    const { data, error } = await query;
    if (error) throw new BadRequestException(error.message);
    return ((data ?? []) as Array<{ space_id: string }>).map(
      (row) => row.space_id,
    );
  }

  async upsert(
    organizationId: string,
    moduleType: string,
    isEnabled: boolean,
    userId: string,
  ): Promise<OrganizationModuleRow> {
    const upsertResult = (await this.client
      .from(OrganizationModuleRepository.TABLE)
      .upsert(
        {
          organization_id: organizationId,
          module_type: moduleType,
          is_enabled: isEnabled,
          created_by: userId,
          updated_by: userId,
        },
        { onConflict: 'organization_id,module_type' },
      )
      .select()
      .single()) as {
      data: OrganizationModuleRow | null;
      error: { message: string } | null;
    };

    if (upsertResult.error)
      throw new BadRequestException(upsertResult.error.message);
    return upsertResult.data as OrganizationModuleRow;
  }
}
