import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

export interface PortfolioGanttSavedViewRow {
  id: string;
  organization_id: string;
  user_id: string;
  portfolio_id: string | null;
  name: string;
  is_default: boolean;
  view_state: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class PortfolioGanttSavedViewRepository {
  private static readonly TABLE = 'portfolio_gantt_saved_views';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async findByUserAndPortfolio(
    userId: string,
    portfolioId: string,
  ): Promise<PortfolioGanttSavedViewRow[]> {
    const { data, error } = await this.client
      .from(PortfolioGanttSavedViewRepository.TABLE)
      .select('*')
      .eq('user_id', userId)
      .eq('portfolio_id', portfolioId)
      .order('is_default', { ascending: false })
      .order('updated_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as PortfolioGanttSavedViewRow[];
  }

  async findById(id: string): Promise<PortfolioGanttSavedViewRow | null> {
    const result = (await this.client
      .from(PortfolioGanttSavedViewRepository.TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle()) as {
      data: PortfolioGanttSavedViewRow | null;
      error: { message: string } | null;
    };

    if (result.error) throw new BadRequestException(result.error.message);
    return result.data ?? null;
  }

  async create(input: {
    organization_id: string;
    user_id: string;
    portfolio_id: string;
    name: string;
    view_state: Record<string, unknown>;
    is_default?: boolean;
  }): Promise<PortfolioGanttSavedViewRow> {
    const insertResult = (await this.client
      .from(PortfolioGanttSavedViewRepository.TABLE)
      .insert({
        organization_id: input.organization_id,
        user_id: input.user_id,
        portfolio_id: input.portfolio_id,
        name: input.name,
        view_state: input.view_state,
        is_default: input.is_default ?? false,
      })
      .select()
      .single()) as {
      data: PortfolioGanttSavedViewRow | null;
      error: { message: string } | null;
    };

    if (insertResult.error)
      throw new BadRequestException(insertResult.error.message);
    return insertResult.data as PortfolioGanttSavedViewRow;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<PortfolioGanttSavedViewRow, 'name' | 'view_state' | 'is_default'>
    >,
  ): Promise<PortfolioGanttSavedViewRow> {
    const updateResult = (await this.client
      .from(PortfolioGanttSavedViewRepository.TABLE)
      .update(patch)
      .eq('id', id)
      .select()
      .single()) as {
      data: PortfolioGanttSavedViewRow | null;
      error: { message: string } | null;
    };

    if (updateResult.error)
      throw new BadRequestException(updateResult.error.message);
    return updateResult.data as PortfolioGanttSavedViewRow;
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.client
      .from(PortfolioGanttSavedViewRepository.TABLE)
      .delete()
      .eq('id', id);

    if (error) throw new BadRequestException(error.message);
  }

  async unsetDefaultsForUserPortfolio(
    userId: string,
    portfolioId: string,
    exceptId?: string,
  ): Promise<void> {
    let query = this.client
      .from(PortfolioGanttSavedViewRepository.TABLE)
      .update({ is_default: false })
      .eq('user_id', userId)
      .eq('portfolio_id', portfolioId)
      .eq('is_default', true);

    if (exceptId) {
      query = query.neq('id', exceptId);
    }

    const { error } = await query;
    if (error) throw new BadRequestException(error.message);
  }
}
