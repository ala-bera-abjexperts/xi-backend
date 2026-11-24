/**
 * @fileoverview Pure Budget Split figures (XE-T616). Nesting is derived, never
 * stored: a split sits under the split from the same budget on its nearest
 * ancestor task, so a budget's allocated amount counts only its top-level
 * splits. Over-allocation and children exceeding a split are warnings only.
 * @module src/resource-planning/budget-split/budget-split.analysis
 */

export interface SplitRef {
  id: string;
  overall_budget_id: string;
  task_id: string;
  amount: number;
}

export interface SplitAnalysis {
  /** Split from the same budget on the nearest ancestor task, or null. */
  parent_split_id: string | null;
  /** Sum of the splits nested directly under this one. */
  children_amount: number;
  /** How far children_amount exceeds this split's amount (0 when it does not). */
  children_exceed_by: number;
}

export interface BudgetAllocation {
  /** Sum of the budget's top-level splits. */
  allocated_amount: number;
  /** How far allocated_amount exceeds the budget amount (0 when it does not). */
  over_allocated_by: number;
}

export function roundCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * @param parentByTaskId parent_task_id of every task on the splits' ancestor
 *   chains; a missing id ends the walk like a root.
 * @param budgetAmountById every budget to report; each gets an entry, also
 *   without splits.
 */
export function analyzeSplits(
  splits: SplitRef[],
  parentByTaskId: ReadonlyMap<string, string | null>,
  budgetAmountById: ReadonlyMap<string, number>,
): {
  splits: Map<string, SplitAnalysis>;
  budgets: Map<string, BudgetAllocation>;
} {
  const splitIdByBudgetTask = new Map<string, string>();
  for (const split of splits) {
    splitIdByBudgetTask.set(
      `${split.overall_budget_id}::${split.task_id}`,
      split.id,
    );
  }

  const parentBySplitId = new Map<string, string | null>();
  const childrenAmountBySplitId = new Map<string, number>();
  const allocatedByBudgetId = new Map<string, number>();
  for (const split of splits) {
    // The visited set stops a parent_task_id cycle (the DB trigger forbids
    // one, kept anyway), including one back to the split's own task.
    const visited = new Set([split.task_id]);
    let parentSplitId: string | null = null;
    let taskId = parentByTaskId.get(split.task_id) ?? null;
    while (taskId !== null && !visited.has(taskId)) {
      visited.add(taskId);
      const hit = splitIdByBudgetTask.get(
        `${split.overall_budget_id}::${taskId}`,
      );
      if (hit) {
        parentSplitId = hit;
        break;
      }
      taskId = parentByTaskId.get(taskId) ?? null;
    }
    parentBySplitId.set(split.id, parentSplitId);

    if (parentSplitId) {
      childrenAmountBySplitId.set(
        parentSplitId,
        (childrenAmountBySplitId.get(parentSplitId) ?? 0) + split.amount,
      );
    } else {
      allocatedByBudgetId.set(
        split.overall_budget_id,
        (allocatedByBudgetId.get(split.overall_budget_id) ?? 0) + split.amount,
      );
    }
  }

  const splitResults = new Map<string, SplitAnalysis>();
  for (const split of splits) {
    const childrenAmount = roundCents(
      childrenAmountBySplitId.get(split.id) ?? 0,
    );
    splitResults.set(split.id, {
      parent_split_id: parentBySplitId.get(split.id) ?? null,
      children_amount: childrenAmount,
      children_exceed_by: roundCents(
        Math.max(0, childrenAmount - split.amount),
      ),
    });
  }

  const budgetResults = new Map<string, BudgetAllocation>();
  for (const [budgetId, budgetAmount] of budgetAmountById) {
    const allocated = roundCents(allocatedByBudgetId.get(budgetId) ?? 0);
    budgetResults.set(budgetId, {
      allocated_amount: allocated,
      over_allocated_by: roundCents(Math.max(0, allocated - budgetAmount)),
    });
  }

  return { splits: splitResults, budgets: budgetResults };
}
