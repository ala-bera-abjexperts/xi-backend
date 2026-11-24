/**
 * @fileoverview Actual cost per task and currency, costed exactly like the
 * Reports engine's actuals: labor is time-entry hours times the user's
 * effective cost rate that day, non-labor is manual actual budget entries.
 * Pure, all-time and unrounded; callers pick the entries and round.
 * @module src/resource-planning/reporting/task-actual-cost
 */

import {
  type createCapacityResolver,
  datePart,
  normalizeCurrency,
} from './resource-planning-report.engine';
import type {
  ResourcePlanningReportBudgetEntry,
  ResourcePlanningReportTimeEntry,
} from './resource-planning-report.types';

export interface TaskActualCost {
  actual_hours: number;
  labor_cost: number;
  non_labor_cost: number;
  /** Hours costed at 0 because the user had no cost rate that day. */
  missing_rate_hours: number;
}

/**
 * Task id -> normalized currency -> actual cost. Labor uses the engine's
 * formula, hours x (cost_rate ?? 0), in the resolved capacity's currency.
 * Unlike the engine, a capacity without a currency does not fall back to the
 * task's plan currency (a task has no single plan here), so it stays
 * UNSPECIFIED. Non-labor keeps only manual actual entries that have a task,
 * in the entry's own currency.
 */
export function computeActualCostByTask(input: {
  timeEntries: Pick<
    ResourcePlanningReportTimeEntry,
    'task_id' | 'user_id' | 'duration_minutes' | 'logged_at'
  >[];
  budgetEntries: (Pick<
    ResourcePlanningReportBudgetEntry,
    'task_id' | 'entry_type' | 'amount'
  > & { currency: string | null; aggregation: string })[];
  resolveCapacity: ReturnType<typeof createCapacityResolver>;
}): Map<string, Map<string, TaskActualCost>> {
  const result = new Map<string, Map<string, TaskActualCost>>();
  const costFor = (taskId: string, currency: string | null) => {
    const byCurrency = result.get(taskId) ?? new Map<string, TaskActualCost>();
    result.set(taskId, byCurrency);
    const key = normalizeCurrency(currency);
    const cost = byCurrency.get(key) ?? {
      actual_hours: 0,
      labor_cost: 0,
      non_labor_cost: 0,
      missing_rate_hours: 0,
    };
    byCurrency.set(key, cost);
    return cost;
  };

  for (const entry of input.timeEntries) {
    const day = datePart(entry.logged_at);
    if (!day) continue;
    const hours = entry.duration_minutes / 60;
    const capacity = input.resolveCapacity(entry.user_id, day);
    const cost = costFor(entry.task_id, capacity.currency);
    cost.actual_hours += hours;
    cost.labor_cost += hours * (capacity.cost_rate ?? 0);
    if (capacity.cost_rate === null) cost.missing_rate_hours += hours;
  }

  for (const entry of input.budgetEntries) {
    if (
      entry.entry_type !== 'actual' ||
      entry.aggregation !== 'manual' ||
      !entry.task_id
    ) {
      continue;
    }
    costFor(entry.task_id, entry.currency).non_labor_cost += entry.amount;
  }
  return result;
}
