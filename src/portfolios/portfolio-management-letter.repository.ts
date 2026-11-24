import { BadRequestException, Injectable } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

export type LetterStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface PortfolioManagementLetterRow {
  id: string;
  organization_id: string;
  portfolio_id: string;
  plan_id: string;
  reporting_period_start: string;
  reporting_period_end: string;
  status: LetterStatus;
  rag_schedule: string | null;
  rag_budget: string | null;
  rag_quality: string | null;
  key_message: string | null;
  milestones_achieved: unknown[];
  success_factors: string | null;
  planned_vs_actual: Record<string, unknown>;
  next_steps: unknown[];
  budget_consumption_percent: number | null;
  resource_availability: string | null;
  identified_risks: unknown[];
  blockers: string[];

  // Frozen-on-submit snapshot of the linked plan's risks (incl. blockers).
  // NULL while the letter is in draft — the UI reads live plan_risks instead.
  // Populated by submitLetter/approveLetter/recomputeRisks. Marked optional so
  // existing fixtures and rows predating the migration remain valid.
  risks_snapshot?: unknown[] | null;
  assigned_to_user_id: string | null;
  due_date: string | null;
  linked_task_id: string | null;
  rejection_reason: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  approved_at: string | null;
  approved_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class PortfolioManagementLetterRepository {
  private static readonly TABLE = 'portfolio_management_letters';

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async findById(
    letterId: string,
  ): Promise<PortfolioManagementLetterRow | null> {
    const { data, error } = (await this.client
      .from(PortfolioManagementLetterRepository.TABLE)
      .select('*')
      .eq('id', letterId)
      .maybeSingle()) as {
      data: PortfolioManagementLetterRow | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data ?? null;
  }

  async findByPortfolio(
    portfolioId: string,
    status?: LetterStatus,
  ): Promise<Array<PortfolioManagementLetterRow & { plan?: unknown }>> {
    let query = this.client
      .from(PortfolioManagementLetterRepository.TABLE)
      .select('*, plan:plans!plan_id(id, name, plan_key)')
      .eq('portfolio_id', portfolioId)
      .order('reporting_period_end', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data, error } = (await query) as {
      data: Array<PortfolioManagementLetterRow & { plan?: unknown }> | null;
      error: { message: string } | null;
    };
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async findByPlanAndPeriod(
    portfolioId: string,
    planId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<PortfolioManagementLetterRow | null> {
    const { data, error } = (await this.client
      .from(PortfolioManagementLetterRepository.TABLE)
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('plan_id', planId)
      .eq('reporting_period_start', periodStart)
      .eq('reporting_period_end', periodEnd)
      .maybeSingle()) as {
      data: PortfolioManagementLetterRow | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data ?? null;
  }

  async create(
    input: Record<string, unknown>,
  ): Promise<PortfolioManagementLetterRow> {
    const { data, error } = (await this.client
      .from(PortfolioManagementLetterRepository.TABLE)
      .insert(input)
      .select()
      .single()) as {
      data: PortfolioManagementLetterRow | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data as PortfolioManagementLetterRow;
  }

  async update(
    letterId: string,
    patch: Record<string, unknown>,
  ): Promise<PortfolioManagementLetterRow> {
    const { data, error } = (await this.client
      .from(PortfolioManagementLetterRepository.TABLE)
      .update(patch)
      .eq('id', letterId)
      .select()
      .single()) as {
      data: PortfolioManagementLetterRow | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data as PortfolioManagementLetterRow;
  }

  async transitionStatus(
    letterId: string,
    expectedStatus: LetterStatus,
    patch: Record<string, unknown>,
  ): Promise<PortfolioManagementLetterRow | null> {
    const { data, error } = (await this.client
      .from(PortfolioManagementLetterRepository.TABLE)
      .update(patch)
      .eq('id', letterId)
      .eq('status', expectedStatus)
      .select()
      .maybeSingle()) as {
      data: PortfolioManagementLetterRow | null;
      error: { message: string } | null;
    };

    if (error) throw new BadRequestException(error.message);
    return data ?? null;
  }

  async delete(letterId: string): Promise<void> {
    const { error } = await this.client
      .from(PortfolioManagementLetterRepository.TABLE)
      .delete()
      .eq('id', letterId);

    if (error) throw new BadRequestException(error.message);
  }
}
