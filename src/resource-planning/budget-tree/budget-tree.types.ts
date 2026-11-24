import type { BudgetUsage } from '../overall-budget/budget-usage.service';

export interface BudgetCostCategoryRow {
  id: string;
  organization_id: string;
  code: string;
  label: string;
  cost_group: 'RC' | 'NRC' | 'OTHER';
  sort_order: number;
  color: string | null;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export type BudgetAggregation =
  | 'manual'
  | 'rollup_sum'
  | 'rollup_avg'
  | 'rollup_max';

/** Extends BudgetEntryRow (resource-planning-core.types.ts) additively. */
export interface BudgetEntryWithCategoryRow {
  id: string;
  organization_id: string;
  plan_id: string | null;
  task_id: string | null;
  entry_type: 'planned' | 'actual';
  name: string;
  category: string | null;
  cost_category_id: string | null;
  quantity: number;
  unit_cost: number;
  amount: number;
  currency: string;
  effective_date: string;
  start_date: string | null;
  end_date: string | null;
  aggregation: BudgetAggregation;
  notes: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/** One node in the budget tree, with its own and rolled-up category totals. */
export interface BudgetTreeNode {
  task_id: string;
  key: string;
  summary: string;
  level: number;
  parent_task_id: string | null;
  space_id: string | null;
  accessible: boolean;
  /** Own entries for this task only, one row per (cost_category_id, currency). */
  own_by_category: Array<{
    cost_category_id: string;
    currency: string;
    aggregation: BudgetAggregation;
    /** The stored manual value, retained even when aggregation != 'manual' so toggling back restores it. */
    manual_amount: number;
    /** The value actually displayed: manual_amount when aggregation is 'manual', else computed from children. */
    effective_amount: number;
  }>;
  working_days: number | null;
  children: BudgetTreeNode[];
  /** Dependency-linked tickets anchored here (include_dependencies only, else
   *  []). They have no children and never feed any rollup. */
  linked: BudgetTreeNode[];
  /** Set only on a node inside some `linked` array. */
  link?: { relation_type_name: string; label: string };
  /** True when this node has real children beyond the requested depth or the
   *  node-count cap -- i.e. `children` is empty here only because the walk
   *  was cut off, not because the task actually has none. */
  has_hidden_children: boolean;
  /** Budget Splits on this task (XE-T616) from budgets the caller can see; [] when none. */
  budget_splits: BudgetTreeSplit[];
  /** One row per split currency: planned subtree amount vs what the splits fund.
   *  [] for a node without splits and for a linked node. */
  funding: BudgetTreeFunding[];
  /** True when the subtree has planned amounts, but none in a split's currency. */
  funding_other_currency: boolean;
}

export type BudgetSplitWarning =
  | 'budget_over_allocated'
  | 'children_exceed'
  | 'budget_other_space';

/** A Budget Split on a tree node, with its budget and derived figures. */
export interface BudgetTreeSplit {
  id: string;
  overall_budget_id: string;
  budget_name: string;
  budget_space_id: string;
  /** The budget's currency. */
  currency: string;
  amount: number;
  budget_amount: number;
  /** amount / budget_amount * 100, 2 decimals. */
  percent_of_budget: number;
  note: string | null;
  /** Split from the same budget on the nearest ancestor task (walked in the DB, not only in this tree). */
  parent_split_id: string | null;
  /** Sum of the splits nested directly under this one. */
  children_amount: number;
  /** How far children_amount exceeds amount (0 when it does not). */
  children_exceed_by: number;
  /** How far the budget's allocated amount exceeds the budget (0 when it does not). */
  budget_over_allocated_by: number;
  warnings: BudgetSplitWarning[];
}

export interface BudgetTreeFunding {
  currency: string;
  /** Manual planned entries of the node and its visible descendants (not depth-limited). */
  planned_amount: number;
  /** Sum of the node's splits in this currency. */
  funded_amount: number;
  /** max(0, planned_amount - funded_amount). */
  underfunded_by: number;
}

/** An Overall Budget the tree can show: the root space's budgets plus any a visible split uses. */
export interface BudgetTreeBudget extends BudgetUsage {
  id: string;
  name: string;
  amount: number;
  currency: string;
  space_id: string;
  /** Sum of the budget's top-level splits, across the whole organization. */
  allocated_amount: number;
  over_allocated_by: number;
  /** True when the budget splits on a task outside the viewer's space scope,
   *  so its used figures include tasks they cannot see. */
  has_hidden_funded_tasks: boolean;
}

export interface BudgetTreeResponse {
  root_task_id: string;
  depth: number;
  node_count: number;
  truncated: boolean;
  /** Count of descendant tickets omitted from the tree because the current user
   *  lacks access to their space. Their budget entries are also excluded from
   *  every ancestor's rolled-up totals, so this warns that a visible total may
   *  be incomplete. */
  hidden_count: number;
  /** space_id scope only (else 0): child tickets dropped because they live in
   *  another space. Like hidden_count, they are excluded from every total. */
  other_space_count: number;
  tree: BudgetTreeNode;
  /** Budgets for the split editor and legend, sorted by name. */
  budgets: BudgetTreeBudget[];
}

export type BudgetTimelineWarning = 'start_after_end' | 'done_date_unknown';

/** Planned figures of one month: budget per currency and hours (2 decimals). */
export interface BudgetTimelineFigures {
  budget: Record<string, number>;
  hours: number;
}

/** One ticket row of the month timeline (same pruned tree as the graph). */
export interface BudgetTimelineNode {
  task_id: string;
  key: string;
  summary: string;
  parent_task_id: string | null;
  level: number;
  space_id: string | null;
  task_type_id: string | null;
  /** The status is in a completed category (task_statuses.is_completed). */
  is_done: boolean;
  /** tasks.start_date as a date in the requested time zone. */
  planned_start: string | null;
  /** tasks.end_date, else due_date, as a date in the requested time zone. */
  planned_end: string | null;
  /** completed_at, else resolved_at; only when is_done. */
  done_date: string | null;
  /** Planned start..end, ending at the done date and never after a done
   *  ancestor's; null when the ticket has no usable date. */
  bar: { start: string; end: string } | null;
  warnings: BudgetTimelineWarning[];
  /** Own planned budget entries or allocations exist (any date). */
  has_plan: boolean;
  /** 'YYYY-MM' inside the range -> own + visible descendants (not
   *  depth-limited); months without figures are omitted. */
  months: Record<string, BudgetTimelineFigures>;
  has_hidden_children: boolean;
}

/** A ticket's planned figures that have no usable date at all. */
export interface BudgetTimelineUnscheduled extends BudgetTimelineFigures {
  task_id: string;
  key: string;
  summary: string;
}

export interface BudgetTimelineResponse {
  root_task_id: string;
  from: string;
  to: string;
  months: string[];
  timezone: string;
  depth: number;
  truncated: boolean;
  hidden_count: number;
  other_space_count: number;
  /** False when the org has no working calendar, so days weigh equally. */
  working_calendar: boolean;
  /** Depth-first, parents before children. */
  nodes: BudgetTimelineNode[];
  /** Whole visible subtree, not depth-limited. */
  unscheduled: BudgetTimelineUnscheduled[];
}
