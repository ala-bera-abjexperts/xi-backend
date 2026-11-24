/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * @fileoverview Space Overall Budget records (Resource Planning > Overall
 * Budget, XE-T613): the budgets a space has available. The client is
 * service-role, so every read and write is scoped to the caller's
 * organization and to a space in their Resource Planning scope here.
 * @module src/resource-planning/overall-budget/overall-budget.service
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { BudgetSplitService } from '../budget-split/budget-split.service';
import { ResourcePlanningService } from '../resource-planning.service';
import { assertSpaceInScope } from '../space-scope.util';
import { type BudgetUsage, BudgetUsageService } from './budget-usage.service';
import type {
  CreateOverallBudgetDto,
  UpdateOverallBudgetDto,
} from './dto/overall-budget.dto';

const TABLE = 'overall_budgets';

const UPDATABLE_FIELDS = [
  'name',
  'amount',
  'currency',
  'source',
  'financial_year',
  'responsible_user_id',
  'cost_category_id',
] as const;

const NON_NULLABLE_FIELDS = ['name', 'amount', 'currency'] as const;

/** Row shape of overall_budgets; numeric may arrive as a string. */
interface OverallBudgetRow {
  id: string;
  organization_id: string;
  space_id: string;
  name: string;
  amount: number | string;
  currency: string;
  source: string | null;
  financial_year: string | null;
  responsible_user_id: string | null;
  cost_category_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface OverallBudgetResponsible {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  avatar_url: string | null;
  is_active: boolean;
  /** False once the person left the organization; the budget keeps them. */
  is_member: boolean;
}

type ResponsibleUserRow = Omit<OverallBudgetResponsible, 'is_member'>;

export interface OverallBudgetCategory {
  id: string;
  code: string;
  label: string;
  cost_group: string;
  is_active: boolean;
}

export interface OverallBudgetStatus extends BudgetUsage {
  allocated_amount: number;
}

export interface OverallBudget
  extends Omit<OverallBudgetRow, 'amount'>, OverallBudgetStatus {
  amount: number;
  responsible: OverallBudgetResponsible | null;
  cost_category: OverallBudgetCategory | null;
}

/**
 * Calculated status of a budget. Allocated is the sum of its top-level Budget
 * Splits (XE-T616, see budget-split.analysis.ts); used is the actual cost of
 * the tasks they fund (budget-usage.service.ts), nothing when absent.
 */
function budgetStatus(
  allocated: number,
  usage: BudgetUsage | undefined,
): OverallBudgetStatus {
  return {
    allocated_amount: allocated,
    used_amount: usage?.used_amount ?? 0,
    used_percent: usage?.used_percent ?? 0,
    used_other_currencies: usage?.used_other_currencies ?? [],
    missing_rate_hours: usage?.missing_rate_hours ?? 0,
  };
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

@Injectable()
export class OverallBudgetService {
  private get client() {
    return this.supabaseAdmin.getClient();
  }

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly orgModulesService: OrganizationModulesService,
    private readonly resourcePlanningService: ResourcePlanningService,
    private readonly auditLogs: AuditLogsService,
    private readonly budgetSplitService: BudgetSplitService,
    private readonly budgetUsageService: BudgetUsageService,
  ) {}

  private async assertModuleEnabled(organizationId: string): Promise<void> {
    if (
      !(await this.orgModulesService.isEnabled(
        organizationId,
        'resource_planning',
      ))
    ) {
      throw new ForbiddenException('Resource Planning module is not enabled');
    }
  }

  private async assertSpace(user: RequestUser, spaceId: string): Promise<void> {
    const scope = await this.resourcePlanningService.resolveSpaceScope(
      user.organizationId,
      user.userId,
    );
    assertSpaceInScope(scope, spaceId);
  }

  async list(
    user: RequestUser,
    spaceId: string,
  ): Promise<{ data: OverallBudget[]; count: number }> {
    await this.assertModuleEnabled(user.organizationId);
    await this.assertSpace(user, spaceId);

    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('organization_id', user.organizationId)
      .eq('space_id', spaceId)
      .order('financial_year', { ascending: false, nullsFirst: false })
      .order('name', { ascending: true });
    if (error) throw new InternalServerErrorException(error.message);

    const rows = await this.hydrate(
      user.organizationId,
      (data ?? []) as OverallBudgetRow[],
    );
    return { data: rows, count: rows.length };
  }

  async create(
    user: RequestUser,
    spaceId: string,
    dto: CreateOverallBudgetDto,
  ): Promise<OverallBudget> {
    await this.assertModuleEnabled(user.organizationId);
    await this.assertSpace(user, spaceId);
    if (dto.responsible_user_id) {
      await this.assertResponsibleMember(
        user.organizationId,
        dto.responsible_user_id,
      );
    }
    if (dto.cost_category_id) {
      await this.assertActiveCategory(
        user.organizationId,
        dto.cost_category_id,
      );
    }

    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: user.organizationId,
        space_id: spaceId,
        name: dto.name,
        amount: dto.amount,
        currency: dto.currency,
        source: dto.source ?? null,
        financial_year: dto.financial_year ?? null,
        responsible_user_id: dto.responsible_user_id ?? null,
        cost_category_id: dto.cost_category_id ?? null,
        created_by: user.userId,
        updated_by: user.userId,
      })
      .select('*')
      .single();
    if (error) this.throwWriteError(error);

    const row = data as OverallBudgetRow;
    void this.auditLogs.logActionForRequest(
      user,
      'overall_budget',
      row.id,
      'create',
      { space_id: spaceId, after: row },
    );
    return (await this.hydrate(user.organizationId, [row]))[0];
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateOverallBudgetDto,
  ): Promise<OverallBudget> {
    await this.assertModuleEnabled(user.organizationId);
    // PartialType's IsOptional lets null through; these columns are NOT NULL.
    for (const field of NON_NULLABLE_FIELDS) {
      if ((dto[field] as unknown) === null) {
        throw new BadRequestException(`${field} cannot be null`);
      }
    }
    const patch: Record<string, unknown> = {};
    for (const field of UPDATABLE_FIELDS) {
      if (dto[field] !== undefined) patch[field] = dto[field];
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('Nothing to update');
    }

    const before = await this.findRow(user.organizationId, id);
    await this.assertSpace(user, before.space_id);
    // A split's currency is its budget's currency, so it cannot change under them.
    if (
      dto.currency !== undefined &&
      dto.currency !== before.currency &&
      (await this.budgetSplitService.linkedSplits(user.organizationId, id, 1))
        .total > 0
    ) {
      throw new ConflictException(
        'The currency cannot be changed while budget splits use this budget',
      );
    }
    if (
      dto.responsible_user_id &&
      dto.responsible_user_id !== before.responsible_user_id
    ) {
      await this.assertResponsibleMember(
        user.organizationId,
        dto.responsible_user_id,
      );
    }
    // An unchanged category may stay even if it was deactivated since.
    if (
      dto.cost_category_id &&
      dto.cost_category_id !== before.cost_category_id
    ) {
      await this.assertActiveCategory(
        user.organizationId,
        dto.cost_category_id,
      );
    }

    const { data, error } = await this.client
      .from(TABLE)
      .update({
        ...patch,
        updated_by: user.userId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', user.organizationId)
      .select('*')
      .maybeSingle();
    if (error) this.throwWriteError(error);
    if (!data) throw new NotFoundException('Overall budget not found');

    const after = data as OverallBudgetRow;
    void this.auditLogs.logActionForRequest(
      user,
      'overall_budget',
      id,
      'update',
      { space_id: before.space_id, before, after },
    );
    return (await this.hydrate(user.organizationId, [after]))[0];
  }

  async remove(user: RequestUser, id: string): Promise<{ success: true }> {
    await this.assertModuleEnabled(user.organizationId);
    const before = await this.findRow(user.organizationId, id);
    await this.assertSpace(user, before.space_id);

    // A budget that still funds tasks cannot go; name them so they can be removed.
    const { total, items } = await this.budgetSplitService.linkedSplits(
      user.organizationId,
      id,
    );
    if (total > 0) {
      const listed = items
        .map(
          (item) =>
            `${item.task_key} (${formatAmount(item.amount)} ${before.currency})`,
        )
        .join(', ');
      const more =
        total > items.length ? `, and ${total - items.length} more` : '';
      throw new ConflictException(
        `Cannot delete "${before.name}": it still funds ${total} task(s): ${listed}${more}. Remove these budget splits first.`,
      );
    }

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', user.organizationId);
    // 23503: a split was added after the check above (the FK is NO ACTION).
    if (error?.code === '23503') {
      throw new ConflictException(
        'This budget still has budget splits. Remove them first.',
      );
    }
    if (error) throw new InternalServerErrorException(error.message);

    void this.auditLogs.logActionForRequest(
      user,
      'overall_budget',
      id,
      'delete',
      { space_id: before.space_id, before },
    );
    return { success: true };
  }

  private async findRow(
    organizationId: string,
    id: string,
  ): Promise<OverallBudgetRow> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Overall budget not found');
    return data as OverallBudgetRow;
  }

  private async assertResponsibleMember(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) {
      throw new BadRequestException(
        'Responsible user is not a member of this organization',
      );
    }
  }

  private async assertActiveCategory(
    organizationId: string,
    categoryId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('budget_cost_categories')
      .select('id, is_active')
      .eq('organization_id', organizationId)
      .eq('id', categoryId)
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!(data as { is_active: boolean } | null)?.is_active) {
      throw new BadRequestException('Budget category not found or inactive');
    }
  }

  /** Adds responsible user, category and status: a bounded number of reads for any row count. */
  private async hydrate(
    organizationId: string,
    rows: OverallBudgetRow[],
  ): Promise<OverallBudget[]> {
    const [{ analysis }, usage] = await Promise.all([
      this.budgetSplitService.analyzeBudgets(
        organizationId,
        rows.map((row) => ({ id: row.id, amount: Number(row.amount) })),
      ),
      rows.length > 0
        ? this.budgetUsageService.usedByBudget(
            organizationId,
            rows.map((row) => row.id),
          )
        : new Map<string, BudgetUsage>(),
    ]);
    const userIds = distinct(rows.map((row) => row.responsible_user_id));
    const categoryIds = distinct(rows.map((row) => row.cost_category_id));

    const users = new Map<string, ResponsibleUserRow>();
    const memberIds = new Set<string>();
    const categories = new Map<string, OverallBudgetCategory>();

    if (userIds.length > 0) {
      const [usersResult, membersResult] = await Promise.all([
        this.client
          .from('users')
          .select('id, first_name, last_name, email, avatar_url, is_active')
          .in('id', userIds),
        this.client
          .from('organization_members')
          .select('user_id')
          .eq('organization_id', organizationId)
          .in('user_id', userIds),
      ]);
      const error = usersResult.error ?? membersResult.error;
      if (error) throw new InternalServerErrorException(error.message);
      for (const u of (usersResult.data ?? []) as ResponsibleUserRow[]) {
        users.set(u.id, u);
      }
      for (const m of (membersResult.data ?? []) as { user_id: string }[]) {
        memberIds.add(m.user_id);
      }
    }

    if (categoryIds.length > 0) {
      const { data, error } = await this.client
        .from('budget_cost_categories')
        .select('id, code, label, cost_group, is_active')
        .eq('organization_id', organizationId)
        .in('id', categoryIds);
      if (error) throw new InternalServerErrorException(error.message);
      for (const c of (data ?? []) as OverallBudgetCategory[]) {
        categories.set(c.id, c);
      }
    }

    return rows.map((row) => {
      const responsible = row.responsible_user_id
        ? users.get(row.responsible_user_id)
        : undefined;
      return {
        ...row,
        amount: Number(row.amount),
        responsible: responsible
          ? {
              ...responsible,
              is_active: responsible.is_active !== false,
              is_member: memberIds.has(responsible.id),
            }
          : null,
        cost_category: row.cost_category_id
          ? (categories.get(row.cost_category_id) ?? null)
          : null,
        ...budgetStatus(
          analysis.budgets.get(row.id)?.allocated_amount ?? 0,
          usage.get(row.id),
        ),
      };
    });
  }

  private throwWriteError(error: { code?: string; message: string }): never {
    // 23514: CHECK constraint; 23503: space/category/user FK (e.g. deleted mid-call).
    if (error.code === '23514' || error.code === '23503') {
      throw new BadRequestException(error.message);
    }
    throw new InternalServerErrorException(error.message);
  }
}

function distinct(ids: (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null))];
}
