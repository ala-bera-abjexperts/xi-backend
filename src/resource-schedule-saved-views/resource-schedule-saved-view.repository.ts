import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

export type ScheduleSavedViewState = {
  unit_ids: string[];
  user_ids: string[];
  granularity: 'day' | 'week';
};

export interface ResourceScheduleSavedViewRow {
  id: string;
  organization_id: string;
  user_id: string;
  name: string;
  is_default: boolean;
  view_state: ScheduleSavedViewState;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class ResourceScheduleSavedViewRepository {
  private static readonly TABLE = 'resource_schedule_saved_views';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // Mirrors the throwWriteError pattern used throughout this module family (e.g.
  // budget-cost-categories.service.ts:86-100, calendar-admin.service.ts:91): the only unique
  // constraint on this table is (user_id, organization_id, name), so a 23505 here can only mean a
  // name collision within the same user+org -- map it to a clean, user-facing message instead of
  // the raw Postgres constraint text.
  private throwWriteError(
    error: { code?: string; message: string } | null,
  ): void {
    if (!error) return;
    if (error.code === '23505') {
      throw new ConflictException(
        'A saved view with this name already exists.',
      );
    }
    throw new BadRequestException(error.message);
  }

  async findByUserAndOrg(
    userId: string,
    organizationId: string,
  ): Promise<ResourceScheduleSavedViewRow[]> {
    const { data, error } = await this.client
      .from(ResourceScheduleSavedViewRepository.TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .order('is_default', { ascending: false })
      .order('updated_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as ResourceScheduleSavedViewRow[];
  }

  // This table has no portfolio_id-equivalent sub-entity to transitively scope by
  // organization, so every row-level read/mutate query below filters by organization_id
  // (and user_id) directly -- that .eq(...) filter IS the tenant-isolation boundary on this
  // service-role client, not just a convenience check. A user in org A and org B must never
  // reach a saved view that belongs to the other org via this method.
  async findById(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<ResourceScheduleSavedViewRow | null> {
    const result = (await this.client
      .from(ResourceScheduleSavedViewRepository.TABLE)
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle()) as {
      data: ResourceScheduleSavedViewRow | null;
      error: { message: string } | null;
    };

    if (result.error) throw new BadRequestException(result.error.message);
    return result.data ?? null;
  }

  async create(input: {
    organization_id: string;
    user_id: string;
    name: string;
    view_state: ScheduleSavedViewState;
    is_default?: boolean;
  }): Promise<ResourceScheduleSavedViewRow> {
    const insertResult = (await this.client
      .from(ResourceScheduleSavedViewRepository.TABLE)
      .insert({
        organization_id: input.organization_id,
        user_id: input.user_id,
        name: input.name,
        view_state: input.view_state,
        is_default: input.is_default ?? false,
      })
      .select()
      .single()) as {
      data: ResourceScheduleSavedViewRow | null;
      error: { code?: string; message: string } | null;
    };

    this.throwWriteError(insertResult.error);
    return insertResult.data as ResourceScheduleSavedViewRow;
  }

  async update(
    id: string,
    userId: string,
    organizationId: string,
    patch: Partial<
      Pick<ResourceScheduleSavedViewRow, 'name' | 'view_state' | 'is_default'>
    >,
  ): Promise<ResourceScheduleSavedViewRow> {
    const updateResult = (await this.client
      .from(ResourceScheduleSavedViewRepository.TABLE)
      .update(patch)
      .eq('id', id)
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .select()
      .single()) as {
      data: ResourceScheduleSavedViewRow | null;
      error: { code?: string; message: string } | null;
    };

    this.throwWriteError(updateResult.error);
    return updateResult.data as ResourceScheduleSavedViewRow;
  }

  async delete(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<void> {
    const { error } = await this.client
      .from(ResourceScheduleSavedViewRepository.TABLE)
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
  }

  async unsetDefaultsForUserOrg(
    userId: string,
    organizationId: string,
    exceptId?: string,
  ): Promise<void> {
    let query = this.client
      .from(ResourceScheduleSavedViewRepository.TABLE)
      .update({ is_default: false })
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .eq('is_default', true);

    if (exceptId) {
      query = query.neq('id', exceptId);
    }

    const { error } = await query;
    if (error) throw new BadRequestException(error.message);
  }
}
