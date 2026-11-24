import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

export type PortfolioStatus = 'draft' | 'active' | 'on_hold' | 'completed';

export interface PortfolioRow {
  id: string;
  organization_id: string;
  portfolio_key: string | null;
  name: string;
  description: string | null;
  status: PortfolioStatus;
  color: string | null;
  owner_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  sort_order: number;
  settings: Record<string, unknown>;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface PortfolioListItem extends PortfolioRow {
  plans_count: number;
}

@Injectable()
export class PortfolioRepository {
  private static readonly TABLE = 'portfolios';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async findById(id: string): Promise<PortfolioRow | null> {
    const { data, error } = (await this.client
      .from(PortfolioRepository.TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle()) as {
      data: PortfolioRow | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data ?? null;
  }

  async findByKey(
    organizationId: string,
    portfolioKey: string,
  ): Promise<PortfolioRow | null> {
    const { data, error } = (await this.client
      .from(PortfolioRepository.TABLE)
      .select('*')
      .eq('organization_id', organizationId)
      .eq('portfolio_key', portfolioKey)
      .maybeSingle()) as {
      data: PortfolioRow | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data ?? null;
  }

  async findByOrganization(
    organizationId: string,
    filters: {
      status?: PortfolioStatus;
      search?: string;
      include_archived?: boolean;
      page?: number;
      pageSize?: number;
    },
  ): Promise<{ data: PortfolioListItem[]; totalCount: number }> {
    const page = filters.page ?? 1;
    const pageSize = Math.min(filters.pageSize ?? 20, 100);
    const from = (page - 1) * pageSize;

    let countQuery = this.client
      .from(PortfolioRepository.TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId);

    let dataQuery = this.client
      .from(PortfolioRepository.TABLE)
      .select('*, portfolio_plans!portfolio_id(count)')
      .eq('organization_id', organizationId);

    if (!filters.include_archived) {
      countQuery = countQuery.eq('is_archived', false);
      dataQuery = dataQuery.eq('is_archived', false);
    }
    if (filters.status) {
      countQuery = countQuery.eq('status', filters.status);
      dataQuery = dataQuery.eq('status', filters.status);
    }
    if (filters.search) {
      const safe = filters.search.replace(/[,.()"'\\]/g, '');
      if (safe.length > 0) {
        countQuery = countQuery.ilike('name', `%${safe}%`);
        dataQuery = dataQuery.ilike('name', `%${safe}%`);
      }
    }

    const countResult = await countQuery;
    if (countResult.error)
      throw new BadRequestException(countResult.error.message);

    const { data, error } = await dataQuery
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as Array<
      PortfolioRow & { portfolio_plans?: Array<{ count: number }> }
    >;

    return {
      data: rows.map(({ portfolio_plans, ...portfolio }) => ({
        ...(portfolio as PortfolioRow),
        plans_count: portfolio_plans?.[0]?.count ?? 0,
      })),
      totalCount: countResult.count ?? 0,
    };
  }

  async create(input: Record<string, unknown>): Promise<PortfolioRow> {
    const { data, error } = (await this.client
      .from(PortfolioRepository.TABLE)
      .insert(input)
      .select()
      .single()) as {
      data: PortfolioRow | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data as PortfolioRow;
  }

  async update(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<PortfolioRow> {
    const { data, error } = (await this.client
      .from(PortfolioRepository.TABLE)
      .update(patch)
      .eq('id', id)
      .select()
      .single()) as {
      data: PortfolioRow | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data as PortfolioRow;
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.client
      .from(PortfolioRepository.TABLE)
      .delete()
      .eq('id', id);

    if (error) throw new BadRequestException(error.message);
  }
}
