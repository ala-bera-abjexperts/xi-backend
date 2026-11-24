/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * @fileoverview Budget Splits (XE-T616): part of a space's Overall Budget
 * assigned to an epic or task of the same space. The client is service-role,
 * so every read and write is scoped to the caller's organization and to the
 * budget's space being in their Resource Planning scope here. Nesting and
 * allocated amounts are derived in budget-split.analysis.ts.
 * @module src/resource-planning/budget-split/budget-split.service
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
import { ResourcePlanningService } from '../resource-planning.service';
import { assertSpaceInScope } from '../space-scope.util';
import { analyzeSplits } from './budget-split.analysis';
import type {
  CreateBudgetSplitDto,
  UpdateBudgetSplitDto,
} from './dto/budget-split.dto';

const TABLE = 'budget_splits';

/** Keeps each PostgREST .in() request URL short (same as budget-tree.service.ts). */
const IN_FILTER_CHUNK_SIZE = 100;

/** Row shape of budget_splits; numeric may arrive as a string. */
interface BudgetSplitDbRow {
  id: string;
  organization_id: string;
  overall_budget_id: string;
  task_id: string;
  amount: number | string;
  note: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A split's currency is its budget's currency. */
export interface BudgetSplit extends Omit<BudgetSplitDbRow, 'amount'> {
  amount: number;
  currency: string;
}

/** The fields other services read. */
export interface BudgetSplitRow {
  id: string;
  overall_budget_id: string;
  task_id: string;
  amount: number;
  note: string | null;
}

const ROW_COLUMNS = 'id, overall_budget_id, task_id, amount, note';

interface BudgetRef {
  id: string;
  space_id: string;
  currency: string;
}

@Injectable()
export class BudgetSplitService {
  private get client() {
    return this.supabaseAdmin.getClient();
  }

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly orgModulesService: OrganizationModulesService,
    private readonly resourcePlanningService: ResourcePlanningService,
    private readonly auditLogs: AuditLogsService,
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

  async create(
    user: RequestUser,
    dto: CreateBudgetSplitDto,
  ): Promise<BudgetSplit> {
    await this.assertModuleEnabled(user.organizationId);
    const budget = await this.findBudget(
      user.organizationId,
      dto.overall_budget_id,
    );
    await this.assertSpace(user, budget.space_id);

    const { data: task, error: taskError } = await this.client
      .from('tasks')
      .select('id, space_id')
      .eq('id', dto.task_id)
      .eq('organization_id', user.organizationId)
      .maybeSingle();
    if (taskError) throw new InternalServerErrorException(taskError.message);
    if (!task) throw new NotFoundException('Task not found');
    if ((task as { space_id: string | null }).space_id !== budget.space_id) {
      throw new BadRequestException(
        'The task must be in the same space as the budget',
      );
    }

    const { data, error } = await this.client
      .from(TABLE)
      .insert({
        organization_id: user.organizationId,
        overall_budget_id: dto.overall_budget_id,
        task_id: dto.task_id,
        amount: dto.amount,
        note: dto.note ?? null,
        created_by: user.userId,
        updated_by: user.userId,
      })
      .select('*')
      .single();
    if (error) this.throwWriteError(error);

    const row = data as BudgetSplitDbRow;
    void this.auditLogs.logActionForRequest(
      user,
      'budget_split',
      row.id,
      'create',
      { space_id: budget.space_id, after: row },
    );
    return toBudgetSplit(row, budget.currency);
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateBudgetSplitDto,
  ): Promise<BudgetSplit> {
    await this.assertModuleEnabled(user.organizationId);
    // IsOptional lets null through; amount is NOT NULL.
    if ((dto.amount as unknown) === null) {
      throw new BadRequestException('amount cannot be null');
    }
    const patch: Record<string, unknown> = {};
    if (dto.amount !== undefined) patch.amount = dto.amount;
    if (dto.note !== undefined) patch.note = dto.note;
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('Nothing to update');
    }

    const before = await this.findRow(user.organizationId, id);
    const budget = await this.findBudget(
      user.organizationId,
      before.overall_budget_id,
    );
    await this.assertSpace(user, budget.space_id);

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
    if (!data) throw new NotFoundException('Budget split not found');

    const after = data as BudgetSplitDbRow;
    void this.auditLogs.logActionForRequest(
      user,
      'budget_split',
      id,
      'update',
      { space_id: budget.space_id, before, after },
    );
    return toBudgetSplit(after, budget.currency);
  }

  async remove(user: RequestUser, id: string): Promise<{ success: true }> {
    await this.assertModuleEnabled(user.organizationId);
    const before = await this.findRow(user.organizationId, id);
    const budget = await this.findBudget(
      user.organizationId,
      before.overall_budget_id,
    );
    await this.assertSpace(user, budget.space_id);

    const { error } = await this.client
      .from(TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', user.organizationId);
    if (error) throw new InternalServerErrorException(error.message);

    void this.auditLogs.logActionForRequest(
      user,
      'budget_split',
      id,
      'delete',
      { space_id: budget.space_id, before },
    );
    return { success: true };
  }

  /** Splits on the given tasks, any budget. No module or scope check: callers own that. */
  async listByTaskIds(
    organizationId: string,
    taskIds: string[],
  ): Promise<BudgetSplitRow[]> {
    return this.listBy(organizationId, 'task_id', taskIds);
  }

  /**
   * Every split of the given budgets with its derived nesting, plus each
   * budget's allocated amount. Loads the splits' ancestor tasks level by
   * level, so a split nests through tasks outside any tree the caller shows.
   */
  async analyzeBudgets(
    organizationId: string,
    budgets: { id: string; amount: number }[],
  ): Promise<{
    rows: BudgetSplitRow[];
    analysis: ReturnType<typeof analyzeSplits>;
  }> {
    const budgetAmountById = new Map(budgets.map((b) => [b.id, b.amount]));
    if (budgetAmountById.size === 0) {
      return { rows: [], analysis: analyzeSplits([], new Map(), new Map()) };
    }
    const rows = await this.listBy(organizationId, 'overall_budget_id', [
      ...budgetAmountById.keys(),
    ]);
    const parentByTaskId = await this.loadTaskParents(
      organizationId,
      rows.map((row) => row.task_id),
    );
    return {
      rows,
      analysis: analyzeSplits(rows, parentByTaskId, budgetAmountById),
    };
  }

  /** The tasks a budget funds, largest first, for a blocked delete's message. */
  async linkedSplits(
    organizationId: string,
    budgetId: string,
    limit = 10,
  ): Promise<{
    total: number;
    items: { task_key: string; task_summary: string; amount: number }[];
  }> {
    const { data, error, count } = await this.client
      .from(TABLE)
      .select('task_id, amount', { count: 'exact' })
      .eq('organization_id', organizationId)
      .eq('overall_budget_id', budgetId)
      .order('amount', { ascending: false })
      .limit(limit);
    if (error) throw new InternalServerErrorException(error.message);
    const splits = (data ?? []) as {
      task_id: string;
      amount: number | string;
    }[];
    if (splits.length === 0) return { total: count ?? 0, items: [] };

    const { data: taskData, error: taskError } = await this.client
      .from('tasks')
      .select('id, key, summary')
      .eq('organization_id', organizationId)
      .in(
        'id',
        splits.map((split) => split.task_id),
      );
    if (taskError) throw new InternalServerErrorException(taskError.message);
    const taskById = new Map(
      ((taskData ?? []) as { id: string; key: string; summary: string }[]).map(
        (task) => [task.id, task],
      ),
    );

    return {
      total: count ?? splits.length,
      items: splits.map((split) => ({
        task_key: taskById.get(split.task_id)?.key ?? '',
        task_summary: taskById.get(split.task_id)?.summary ?? '',
        amount: Number(split.amount),
      })),
    };
  }

  private async listBy(
    organizationId: string,
    column: 'task_id' | 'overall_budget_id',
    ids: string[],
  ): Promise<BudgetSplitRow[]> {
    const rows: BudgetSplitRow[] = [];
    for (const chunk of chunkArray([...new Set(ids)], IN_FILTER_CHUNK_SIZE)) {
      const { data, error } = await this.client
        .from(TABLE)
        .select(ROW_COLUMNS)
        .eq('organization_id', organizationId)
        .in(column, chunk);
      if (error) throw new InternalServerErrorException(error.message);
      for (const row of (data ?? []) as BudgetSplitRow[]) {
        rows.push({ ...row, amount: Number(row.amount) });
      }
    }
    return rows;
  }

  /** parent_task_id of the tasks and all their ancestors, one read per level. */
  private async loadTaskParents(
    organizationId: string,
    taskIds: string[],
  ): Promise<Map<string, string | null>> {
    const parentByTaskId = new Map<string, string | null>();
    // A known id is never fetched again: the cycle guard.
    let pending = [...new Set(taskIds)];
    while (pending.length > 0) {
      const next = new Set<string>();
      for (const chunk of chunkArray(pending, IN_FILTER_CHUNK_SIZE)) {
        const { data, error } = await this.client
          .from('tasks')
          .select('id, parent_task_id')
          .eq('organization_id', organizationId)
          .in('id', chunk);
        if (error) throw new InternalServerErrorException(error.message);
        for (const task of (data ?? []) as {
          id: string;
          parent_task_id: string | null;
        }[]) {
          parentByTaskId.set(task.id, task.parent_task_id);
          if (task.parent_task_id) next.add(task.parent_task_id);
        }
      }
      // Not found (deleted meanwhile): ends the walk like a root.
      for (const id of pending) {
        if (!parentByTaskId.has(id)) parentByTaskId.set(id, null);
      }
      pending = [...next].filter((id) => !parentByTaskId.has(id));
    }
    return parentByTaskId;
  }

  private async findRow(
    organizationId: string,
    id: string,
  ): Promise<BudgetSplitDbRow> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Budget split not found');
    return data as BudgetSplitDbRow;
  }

  private async findBudget(
    organizationId: string,
    id: string,
  ): Promise<BudgetRef> {
    const { data, error } = await this.client
      .from('overall_budgets')
      .select('id, space_id, currency')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Overall budget not found');
    return data as BudgetRef;
  }

  private throwWriteError(error: { code?: string; message: string }): never {
    if (error.code === '23505') {
      throw new ConflictException(
        'This task already has a split from this budget',
      );
    }
    // 23514: CHECK constraint; 23503: budget/task FK (e.g. deleted mid-call).
    if (error.code === '23514' || error.code === '23503') {
      throw new BadRequestException(error.message);
    }
    throw new InternalServerErrorException(error.message);
  }
}

function toBudgetSplit(row: BudgetSplitDbRow, currency: string): BudgetSplit {
  return { ...row, amount: Number(row.amount), currency };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
