import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

export interface PortfolioPlanRow {
  id: string;
  portfolio_id: string;
  plan_id: string;
  sort_order: number;
  included_at: string;
  included_by: string | null;
}

export type PlanRow = Record<string, unknown> & {
  id: string;
  organization_id: string;
  space_id: string;
  plan_key: string | null;
  name: string;
  owner_id?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  progress?: number | null;
  is_archived?: boolean | null;
  rag_status?: string | null;
  rag_set_manually?: boolean | null;
  budget?: number | null;
  currency?: string | null;
};

export interface PortfolioPlanWithPlan {
  junction: PortfolioPlanRow;
  plan: PlanRow;
}

export interface PortfolioPlanWithPlanAndSpace extends PortfolioPlanWithPlan {
  space: { id: string; key: string | null; name: string | null } | null;
}

@Injectable()
export class PortfolioPlanRepository {
  private static readonly TABLE = 'portfolio_plans';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async addPlan(
    portfolioId: string,
    planId: string,
    userId: string,
  ): Promise<PortfolioPlanRow> {
    const { data, error } = (await this.client
      .from(PortfolioPlanRepository.TABLE)
      .insert({
        portfolio_id: portfolioId,
        plan_id: planId,
        included_by: userId,
      })
      .select()
      .single()) as {
      data: PortfolioPlanRow | null;
      error: { message: string; code?: string } | null;
    };

    if (error?.code === '23505') {
      throw new ConflictException('Plan is already in this portfolio');
    }
    if (error) throw new BadRequestException(error.message);
    return data as PortfolioPlanRow;
  }

  async removePlan(
    portfolioId: string,
    planId: string,
  ): Promise<PortfolioPlanRow> {
    const { data: existing, error: findError } = (await this.client
      .from(PortfolioPlanRepository.TABLE)
      .select()
      .eq('portfolio_id', portfolioId)
      .eq('plan_id', planId)
      .maybeSingle()) as {
      data: PortfolioPlanRow | null;
      error: { message: string } | null;
    };

    if (findError) throw new BadRequestException(findError.message);
    if (!existing)
      throw new BadRequestException('Plan is not in this portfolio');

    const { error } = await this.client
      .from(PortfolioPlanRepository.TABLE)
      .delete()
      .eq('portfolio_id', portfolioId)
      .eq('plan_id', planId);

    if (error) throw new BadRequestException(error.message);
    return existing;
  }

  async findByPortfolio(portfolioId: string): Promise<PortfolioPlanWithPlan[]> {
    const { data, error } = await this.client
      .from(PortfolioPlanRepository.TABLE)
      .select('*, plan:plans!plan_id (*)')
      .eq('portfolio_id', portfolioId)
      .order('sort_order', { ascending: true })
      .order('included_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    return ((data ?? []) as Array<PortfolioPlanRow & { plan: PlanRow | null }>)
      .filter((row) => row.plan !== null)
      .map(({ plan, ...junction }) => ({
        junction: junction as PortfolioPlanRow,
        plan: plan as PlanRow,
      }));
  }

  async findByPortfolioWithSpaces(
    portfolioId: string,
  ): Promise<PortfolioPlanWithPlanAndSpace[]> {
    const { data, error } = await this.client
      .from(PortfolioPlanRepository.TABLE)
      .select(
        '*, plan:plans!plan_id (*, space:spaces!space_id (id, key, name))',
      )
      .eq('portfolio_id', portfolioId)
      .order('sort_order', { ascending: true })
      .order('included_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    return (
      (data ?? []) as Array<
        PortfolioPlanRow & {
          plan:
            | (PlanRow & {
                space: {
                  id: string;
                  key: string | null;
                  name: string | null;
                } | null;
              })
            | null;
        }
      >
    )
      .filter((row) => row.plan !== null)
      .map(({ plan, ...junction }) => {
        const { space, ...planOnly } = plan as PlanRow & {
          space: { id: string; key: string | null; name: string | null } | null;
        };
        return {
          junction: junction as PortfolioPlanRow,
          plan: planOnly as PlanRow,
          space: space ?? null,
        };
      });
  }

  async findIncludedPlanIds(portfolioId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from(PortfolioPlanRepository.TABLE)
      .select('plan_id')
      .eq('portfolio_id', portfolioId);

    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map((row) => (row as { plan_id: string }).plan_id);
  }

  async exists(portfolioId: string, planId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from(PortfolioPlanRepository.TABLE)
      .select('id')
      .eq('portfolio_id', portfolioId)
      .eq('plan_id', planId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    return data !== null;
  }
}
