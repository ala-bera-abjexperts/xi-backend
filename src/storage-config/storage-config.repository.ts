import {
  DEFAULT_STORAGE_QUOTA_BYTES,
  IS_ON_PREMISE,
} from '../common/upload-limits';
import { Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { LIVE_LICENSE_STATUSES } from '../licensing/licensing.constants';

export interface OrgStorageConfigRow {
  id: string;
  organization_id: string;
  default_quota_bytes: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserStorageOverrideRow {
  id: string;
  organization_id: string;
  user_id: string;
  quota_bytes: number;
  override_source: 'admin' | 'license';
  license_plan_key: string | null;
  granted_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserStorageOverrideWithUsage extends UserStorageOverrideRow {
  user_name: string | null;
  user_email: string | null;
  used_bytes: number;
}

@Injectable()
export class StorageConfigRepository {
  constructor(private readonly supabase: SupabaseAdminService) {}

  private get client() {
    return this.supabase.getClient();
  }

  async getOrgConfig(orgId: string): Promise<OrgStorageConfigRow | null> {
    const { data, error } = await this.client
      .from('organization_storage_config')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle();

    if (error) throw error;

    return data;
  }

  async upsertOrgConfig(
    orgId: string,
    defaultQuotaBytes: number,
    updatedBy: string,
  ): Promise<OrgStorageConfigRow> {
    const { data, error } = await this.client
      .from('organization_storage_config')
      .upsert(
        {
          organization_id: orgId,
          default_quota_bytes: defaultQuotaBytes,
          updated_by: updatedBy,
        },
        { onConflict: 'organization_id' },
      )
      .select()
      .single();

    if (error) throw error;

    return data;
  }

  async listUserOverrides(
    orgId: string,
  ): Promise<UserStorageOverrideWithUsage[]> {
    const { data, error } = await this.client
      .from('user_storage_overrides')
      .select(
        `
        *,
        user:users!user_storage_overrides_user_id_fkey(first_name, last_name, email)
      `,
      )
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Fetch used bytes for each user via RPC
    const overrides: UserStorageOverrideWithUsage[] = await Promise.all(
      (data ?? []).map(async (row) => {
        const { data: usedBytes } = await this.client.rpc(
          'get_user_storage_used_bytes',
          {
            p_user_id: row.user_id,
            p_org_id: orgId,
          },
        );

        const firstName: string = row.user?.first_name ?? '';
        const lastName: string = row.user?.last_name ?? '';
        const fullName =
          [firstName, lastName].filter(Boolean).join(' ') || null;

        return {
          id: row.id,
          organization_id: row.organization_id,
          user_id: row.user_id,
          quota_bytes: row.quota_bytes,
          override_source: row.override_source,
          license_plan_key: row.license_plan_key,
          granted_by: row.granted_by,
          created_at: row.created_at,
          updated_at: row.updated_at,
          user_name: fullName,
          user_email: row.user?.email ?? null,
          used_bytes: (usedBytes as number) ?? 0,
        };
      }),
    );

    return overrides;
  }

  async upsertUserOverride(
    orgId: string,
    userId: string,
    quotaBytes: number,
    overrideSource: 'admin' | 'license',
    licensePlanKey: string | undefined,
    grantedBy: string,
  ): Promise<UserStorageOverrideRow> {
    const { data, error } = await this.client
      .from('user_storage_overrides')
      .upsert(
        {
          organization_id: orgId,
          user_id: userId,
          quota_bytes: quotaBytes,
          override_source: overrideSource,
          license_plan_key: licensePlanKey ?? null,
          granted_by: grantedBy,
        },
        { onConflict: 'organization_id,user_id' },
      )
      .select()
      .single();

    if (error) throw error;

    return data;
  }

  async deleteUserOverride(orgId: string, userId: string): Promise<void> {
    const { error } = await this.client
      .from('user_storage_overrides')
      .delete()
      .eq('organization_id', orgId)
      .eq('user_id', userId);

    if (error) throw error;
  }

  async isOrgSaaS(orgId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from('organization_licenses')
      .select('id')
      .eq('organization_id', orgId)
      .eq('external_provider', 'stripe')
      .in('status', LIVE_LICENSE_STATUSES)
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    return data !== null;
  }

  async getUserQuota(
    orgId: string,
    userId: string,
  ): Promise<{ quota: number; used: number }> {
    const [{ data: quota, error: qErr }, { data: used, error: uErr }] =
      await Promise.all([
        this.client.rpc('get_user_effective_quota_bytes', {
          p_user_id: userId,
          p_org_id: orgId,
        }),
        this.client.rpc('get_user_storage_used_bytes', {
          p_user_id: userId,
          p_org_id: orgId,
        }),
      ]);

    if (qErr) throw qErr;
    if (uErr) throw uErr;

    const usedBytes = (used as number) ?? 0;

    // On-premise the bytes sit on the customer's own hardware, so rationing them is not ours to do
    // by default. An administrator who WANTS a limit still gets one — an explicit per-user override
    // or per-org config wins here exactly as it does on cloud. Only the fallback changes, and it is
    // checked separately because the RPC returns its default indistinguishably from a configured
    // value of the same size.
    if (IS_ON_PREMISE && !(await this.hasExplicitQuota(orgId, userId))) {
      return { quota: Number.MAX_SAFE_INTEGER, used: usedBytes };
    }

    return {
      quota: (quota as number) ?? DEFAULT_STORAGE_QUOTA_BYTES,
      used: usedBytes,
    };
  }

  /** True when an administrator has set a per-user override or a per-org default for this org. */
  private async hasExplicitQuota(
    orgId: string,
    userId: string,
  ): Promise<boolean> {
    const [{ data: override }, { data: orgConfig }] = await Promise.all([
      this.client
        .from('user_storage_overrides')
        .select('quota_bytes')
        .eq('organization_id', orgId)
        .eq('user_id', userId)
        .maybeSingle(),
      this.client
        .from('organization_storage_config')
        .select('default_quota_bytes')
        .eq('organization_id', orgId)
        .maybeSingle(),
    ]);

    return override != null || orgConfig != null;
  }

  async checkUploadAllowed(
    orgId: string,
    userId: string,
    newFileBytes: number,
  ): Promise<{
    allowed: boolean;
    quota: number;
    used: number;
    remaining: number;
  }> {
    const { quota, used } = await this.getUserQuota(orgId, userId);
    const remaining = quota - used;

    return { allowed: remaining >= newFileBytes, quota, used, remaining };
  }
}
