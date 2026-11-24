/**
 * @fileoverview Overall Budget "Used": the actual cost of the tasks a budget
 * funds through its Budget Splits plus all their descendants, costed with the
 * Reports engine's own formula (reporting/task-actual-cost.ts), all-time. A
 * task in several budgets' scopes shares its cost pro-rata by each budget's
 * nearest split amount. The client is service-role, so every read is
 * organization-filtered here.
 * @module src/resource-planning/overall-budget/budget-usage.service
 */

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  createCapacityResolver,
  normalizeCurrency,
} from '../reporting/resource-planning-report.engine';
import type {
  ResourcePlanningReportCapacity,
  ResourcePlanningReportCapacityPeriod,
  ResourcePlanningReportTimeEntry,
} from '../reporting/resource-planning-report.types';
import { computeActualCostByTask } from '../reporting/task-actual-cost';

/** Keeps each PostgREST .in() request URL short (same as budget-split.service.ts). */
const IN_FILTER_CHUNK_SIZE = 100;
/** PostgREST's max rows per response. */
const PAGE_SIZE = 1_000;

export interface BudgetUsage {
  /** Actual cost in the budget's currency. */
  used_amount: number;
  /** used_amount / budget amount x 100. */
  used_percent: number;
  /** Actual cost in any other currency (incl. UNSPECIFIED), never converted. */
  used_other_currencies: { currency: string; amount: number }[];
  /** This budget's share of hours costed at 0 for lack of a cost rate. */
  missing_rate_hours: number;
}

interface QueryResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/** numeric columns may arrive as strings. */
type Numeric = number | string;

function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

@Injectable()
export class BudgetUsageService {
  private get client() {
    return this.supabaseAdmin.getClient();
  }

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  /** Usage of every budget in `budgetIds` that exists in the organization. */
  async usedByBudget(
    organizationId: string,
    budgetIds: string[],
  ): Promise<Map<string, BudgetUsage>> {
    const usage = new Map<string, BudgetUsage>();
    if (budgetIds.length === 0) return usage;

    const budgets = await this.readAll<{
      id: string;
      amount: Numeric;
      currency: string;
    }>([...new Set(budgetIds)], (ids, from, to) =>
      this.client
        .from('overall_budgets')
        .select('id, amount, currency')
        .eq('organization_id', organizationId)
        .in('id', ids)
        .order('id')
        .range(from, to),
    );
    const splits = await this.readAll<{
      overall_budget_id: string;
      task_id: string;
      amount: Numeric;
    }>(
      budgets.map((budget) => budget.id),
      (ids, from, to) =>
        this.client
          .from('budget_splits')
          .select('overall_budget_id, task_id, amount')
          .eq('organization_id', organizationId)
          .in('overall_budget_id', ids)
          .order('id')
          .range(from, to),
    );

    // task id -> budget id -> that budget's split amount on the task
    const splitsByTask = new Map<string, Map<string, number>>();
    for (const split of splits) {
      const byBudget =
        splitsByTask.get(split.task_id) ?? new Map<string, number>();
      byBudget.set(split.overall_budget_id, Number(split.amount));
      splitsByTask.set(split.task_id, byBudget);
    }
    const weightsByTask = await this.fundingWeights(
      organizationId,
      splitsByTask,
    );
    const costByTask = await this.actualCosts(organizationId, [
      ...weightsByTask.keys(),
    ]);

    const currencyById = new Map(
      budgets.map((budget) => [budget.id, normalizeCurrency(budget.currency)]),
    );
    const totals = new Map(
      budgets.map((budget) => [
        budget.id,
        { used: 0, other: new Map<string, number>(), missingRateHours: 0 },
      ]),
    );
    for (const [taskId, weights] of weightsByTask) {
      const costs = costByTask.get(taskId);
      if (!costs) continue;
      const weightSum = [...weights.values()].reduce((a, b) => a + b, 0);
      // ponytail: funders in different currencies share equally, as their
      // split amounts can't be compared without FX rates; weight them once
      // an FX table exists.
      const sameCurrency =
        new Set([...weights.keys()].map((id) => currencyById.get(id))).size ===
        1;
      for (const [budgetId, weight] of weights) {
        const share = sameCurrency ? weight / weightSum : 1 / weights.size;
        const total = totals.get(budgetId)!;
        for (const [currency, cost] of costs) {
          const amount = share * (cost.labor_cost + cost.non_labor_cost);
          if (currency === currencyById.get(budgetId)) {
            total.used += amount;
          } else {
            total.other.set(
              currency,
              (total.other.get(currency) ?? 0) + amount,
            );
          }
          total.missingRateHours += share * cost.missing_rate_hours;
        }
      }
    }

    for (const budget of budgets) {
      const total = totals.get(budget.id)!;
      const used = roundCents(total.used);
      usage.set(budget.id, {
        used_amount: used,
        // overall_budgets.amount has CHECK (amount > 0).
        used_percent: roundCents((used / Number(budget.amount)) * 100),
        used_other_currencies: [...total.other]
          .map(([currency, amount]) => ({
            currency,
            amount: roundCents(amount),
          }))
          .filter((item) => item.amount !== 0)
          .sort((a, b) => a.currency.localeCompare(b.currency)),
        missing_rate_hours: roundCents(total.missingRateHours),
      });
    }
    return usage;
  }

  /**
   * Task id -> budget id -> weight, for every task in a budget's scope (its
   * split tasks and all their descendants). A budget's weight on a task is its
   * split on that task, else on the task's nearest ancestor it splits.
   */
  private async fundingWeights(
    organizationId: string,
    splitsByTask: Map<string, Map<string, number>>,
  ): Promise<Map<string, Map<string, number>>> {
    const weightsByTask = new Map<string, Map<string, number>>();
    const rootIds = [...splitsByTask.keys()];
    if (rootIds.length === 0) return weightsByTask;

    const { data, error } = (await this.client.rpc('get_task_descendant_ids', {
      p_root_ids: rootIds,
      p_organization_id: organizationId,
    })) as QueryResult<string>;
    if (error) throw new InternalServerErrorException(error.message);
    // The RPC excludes the roots themselves.
    const tasks = await this.readAll<{
      id: string;
      parent_task_id: string | null;
    }>([...new Set([...rootIds, ...(data ?? [])])], (ids, from, to) =>
      this.client
        .from('tasks')
        .select('id, parent_task_id')
        .eq('organization_id', organizationId)
        .in('id', ids)
        .order('id')
        .range(from, to),
    );
    const parentById = new Map(
      tasks.map((task) => [task.id, task.parent_task_id]),
    );

    for (const taskId of parentById.keys()) {
      const weights = new Map<string, number>();
      const visited = new Set<string>();
      // Up the loaded chain; the first split seen per budget is its nearest.
      let id: string | null | undefined = taskId;
      while (id && parentById.has(id) && !visited.has(id)) {
        visited.add(id);
        for (const [budgetId, amount] of splitsByTask.get(id) ?? []) {
          if (!weights.has(budgetId)) weights.set(budgetId, amount);
        }
        id = parentById.get(id);
      }
      weightsByTask.set(taskId, weights);
    }
    return weightsByTask;
  }

  /** Actual cost per task and currency, exactly as the Reports engine costs it. */
  private async actualCosts(organizationId: string, taskIds: string[]) {
    const [timeEntries, budgetEntries] = await Promise.all([
      this.readAll<
        Pick<
          ResourcePlanningReportTimeEntry,
          'task_id' | 'user_id' | 'logged_at'
        > & { duration_minutes: Numeric }
      >(taskIds, (ids, from, to) =>
        this.client
          .from('time_entries')
          .select('task_id, user_id, duration_minutes, logged_at')
          .eq('organization_id', organizationId)
          .in('task_id', ids)
          .order('id')
          .range(from, to),
      ),
      this.readAll<{
        task_id: string;
        entry_type: 'planned' | 'actual';
        amount: Numeric;
        currency: string | null;
        aggregation: string;
      }>(taskIds, (ids, from, to) =>
        this.client
          .from('resource_budget_entries')
          .select('task_id, entry_type, amount, currency, aggregation')
          .eq('organization_id', organizationId)
          .in('task_id', ids)
          .eq('entry_type', 'actual')
          .eq('aggregation', 'manual')
          .order('id')
          .range(from, to),
      ),
    ]);

    const userIds = [...new Set(timeEntries.map((entry) => entry.user_id))];
    const [capacities, periods] = await Promise.all([
      this.readAll<ResourcePlanningReportCapacity>(userIds, (ids, from, to) =>
        this.client
          .from('employee_capacity')
          .select(
            'user_id, weekly_capacity_hours, cost_rate, currency, is_active',
          )
          .eq('organization_id', organizationId)
          .in('user_id', ids)
          .order('id')
          .range(from, to),
      ),
      this.readAll<ResourcePlanningReportCapacityPeriod>(
        userIds,
        (ids, from, to) =>
          this.client
            .from('employee_capacity_periods')
            .select(
              'user_id, effective_from, effective_to, weekly_capacity_hours, cost_rate, currency, is_active',
            )
            .eq('organization_id', organizationId)
            .in('user_id', ids)
            .order('id')
            .range(from, to),
      ),
    ]);

    return computeActualCostByTask({
      timeEntries: timeEntries.map((entry) => ({
        ...entry,
        duration_minutes: numeric(entry.duration_minutes),
      })),
      budgetEntries: budgetEntries.map((entry) => ({
        ...entry,
        amount: numeric(entry.amount),
      })),
      resolveCapacity: createCapacityResolver(
        capacities.map(normalizeCapacity),
        periods.map(normalizeCapacity),
      ),
    });
  }

  /**
   * Every row for `ids`: 100 ids per request, paged by PostgREST's row limit.
   * ponytail: all-time reads of every scope task's entries, summed in JS;
   * move to a SQL aggregate (RPC) if budget scopes grow huge.
   */
  private async readAll<T>(
    ids: string[],
    load: (
      ids: string[],
      from: number,
      to: number,
    ) => PromiseLike<QueryResult<T>>,
  ): Promise<T[]> {
    const rows: T[] = [];
    for (let index = 0; index < ids.length; index += IN_FILTER_CHUNK_SIZE) {
      const chunk = ids.slice(index, index + IN_FILTER_CHUNK_SIZE);
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await load(chunk, from, from + PAGE_SIZE - 1);
        if (error) throw new InternalServerErrorException(error.message);
        const page = data ?? [];
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
    }
    return rows;
  }
}

/** Same numeric normalization as resource-planning-report.service.ts. */
function normalizeCapacity<T extends ResourcePlanningReportCapacity>(
  item: T,
): T {
  return {
    ...item,
    weekly_capacity_hours: numeric(item.weekly_capacity_hours),
    cost_rate: item.cost_rate == null ? null : numeric(item.cost_rate),
  };
}

function numeric(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}
