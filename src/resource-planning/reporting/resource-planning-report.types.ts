import type { WorkingCalendarContext } from '../calendar/working-calendar.engine';

export type ResourcePlanningReportBucket = 'day' | 'week' | 'month';
export type ResourcePlanningReportGroup =
  | 'user'
  | 'unit'
  | 'plan'
  | 'portfolio';

export interface NormalizedResourcePlanningReportQuery {
  from: string;
  to: string;
  bucket: ResourcePlanningReportBucket;
  group_by: ResourcePlanningReportGroup;
  group_id?: string;
  portfolio_id?: string;
  /** Fixed-space view: only this space's plan/task-bound rows and their people. */
  space_id?: string;
  include_archived: boolean;
}

export interface ResourcePlanningReportUser {
  id: string;
  name: string;
}

export interface ResourcePlanningReportUnit {
  id: string;
  parent_id: string | null;
  name: string;
  is_active: boolean;
}

export interface ResourcePlanningReportUnitMembership {
  unit_id: string;
  user_id: string;
  effective_from: string;
  /** Inclusive; null means open-ended. */
  effective_to: string | null;
  /**
   * Resource Planning 2.0. Share of this user's capacity this specific team
   * membership represents, when they belong to more than one team at once.
   * Null means 100% — every pre-multi-team membership row has this meaning.
   */
  allocation_percent?: number | null;
}

export interface ResourcePlanningReportCapacity {
  user_id: string;
  weekly_capacity_hours: number;
  cost_rate: number | null;
  currency: string | null;
  is_active: boolean;
}

export interface ResourcePlanningReportCapacityPeriod extends ResourcePlanningReportCapacity {
  effective_from: string;
  /** Inclusive; null means open-ended. */
  effective_to: string | null;
}

export interface ResourcePlanningReportPlan {
  id: string;
  name: string;
  currency: string | null;
  start_date?: string | null;
  end_date?: string | null;
  is_archived: boolean;
  /**
   * Only populated/used for the group_by=portfolio per-plan access check
   * (ResourcePlanningReportService.computeAccessiblePlanIds) -- never read by
   * the report engine's row/total building, so omitting it (every other
   * grouping mode, and existing fixtures) is always valid.
   */
  space_id?: string;
}

export interface ResourcePlanningReportAllocation {
  id: string;
  plan_id: string;
  user_id: string;
  allocation_mode: 'total_hours' | 'hours_per_week' | 'capacity_percent';
  planned_hours: number;
  planned_budget: number;
  weekly_hours: number | null;
  capacity_percent: number | null;
  start_date: string | null;
  end_date: string | null;
}

export interface ResourcePlanningReportTimeEntry {
  id: string;
  task_id: string;
  user_id: string;
  duration_minutes: number;
  logged_at: string;
}

export interface ResourcePlanningReportBudgetEntry {
  id: string;
  plan_id: string | null;
  task_id: string | null;
  entry_type: 'planned' | 'actual';
  amount: number;
  currency: string;
  effective_date: string;
}

export interface ResourcePlanningReportDataset {
  users: ResourcePlanningReportUser[];
  units: ResourcePlanningReportUnit[];
  unitMemberships: ResourcePlanningReportUnitMembership[];
  capacities: ResourcePlanningReportCapacity[];
  capacityPeriods: ResourcePlanningReportCapacityPeriod[];
  plans: ResourcePlanningReportPlan[];
  allocations: ResourcePlanningReportAllocation[];
  planTasks: Array<{ plan_id: string; task_id: string }>;
  portfolioPlans: Array<{ portfolio_id: string; plan_id: string }>;
  portfolios: Array<{
    id: string;
    name: string;
    is_archived: boolean;
  }>;
  timeEntries: ResourcePlanningReportTimeEntry[];
  budgetEntries: ResourcePlanningReportBudgetEntry[];
  /**
   * Resource Planning 2.0, opt-in (D6/R1, second gate). user_id -> the working
   * calendar resolved for that user (their own workload/holiday scheme, or the
   * organization default). A user with NO entry here — including every user in
   * every org that has never configured a scheme, i.e. this field being absent
   * entirely — falls back to the legacy weeklyValue/7 math applied unconditionally
   * on every day, unchanged. This is a completely separate gate from the one on
   * getEffectiveCapacityHours/getEffectivePlannedHours in resource-planning.service.ts:
   * this report engine never calls those functions, it has its own inline per-day
   * math, so both gates must exist for the opt-in guarantee to actually hold.
   */
  workingCalendars?: ReadonlyMap<string, WorkingCalendarContext>;
  /**
   * group_by=portfolio ONLY: the plan ids the requesting user may actually
   * see (space membership / view_plans / an explicit plan_permissions
   * grant), mirroring ResourcePlanningService.getPortfolioSummary's
   * canExposePlan check. Undefined means "no restriction computed" -- the
   * only caller that ever sets it is ResourcePlanningReportService.loadDataset,
   * and only when group_by is 'portfolio'; every other grouping mode (and
   * every existing engine test fixture) is unaffected by its absence.
   */
  accessiblePlanIds?: ReadonlySet<string>;
}

export interface ResourcePlanningReportRow {
  bucket_start: string;
  bucket_end: string;
  group_id: string;
  group_name: string;
  group_type: ResourcePlanningReportGroup;
  currency: string;
  capacity_hours: number;
  planned_hours: number;
  actual_hours: number;
  utilization_percent: number | null;
  planned_labor_cost: number;
  actual_labor_cost: number;
  planned_non_labor_cost: number;
  actual_non_labor_cost: number;
  planned_total_cost: number;
  actual_total_cost: number;
  variance_hours: number;
  variance_cost: number;
  over_allocated: boolean;
}

export interface ResourcePlanningReportTotal {
  currency: string;
  capacity_hours: number;
  planned_hours: number;
  actual_hours: number;
  utilization_percent: number | null;
  planned_labor_cost: number;
  actual_labor_cost: number;
  planned_non_labor_cost: number;
  actual_non_labor_cost: number;
  planned_total_cost: number;
  actual_total_cost: number;
  variance_hours: number;
  variance_cost: number;
  over_allocated: boolean;
}

export interface ResourcePlanningReport {
  range: {
    from: string;
    to: string;
    bucket: ResourcePlanningReportBucket;
    group_by: ResourcePlanningReportGroup;
  };
  rows: ResourcePlanningReportRow[];
  totals_by_currency: ResourcePlanningReportTotal[];
  /**
   * Fix 2c. group_by=portfolio only: how many portfolio-eligible plans were
   * omitted purely because dataset.accessiblePlanIds restricted them (not
   * archived-plan exclusions, which are intentional/silent by design).
   * Undefined for every other grouping mode -- "not applicable", not zero.
   */
  restricted_plan_count?: number;
  exceptions: {
    ambiguous_time_entry_count: number;
    unallocated_time_entry_count: number;
    ambiguous_actual_hours: number;
    unallocated_actual_hours: number;
    missing_rate_hours: number;
    undated_allocation_count: number;

    /**
     * Budget entries dropped from non-labor cost because their task links to
     * no plan (unallocated) or to several (ambiguous) -- the same two failure
     * modes already tracked for time entries above. Without these, a report
     * showing 0.00 non-labor cost is indistinguishable from one where the
     * cost exists but is unreachable.
     *
     * Counts only, deliberately no amount: entries carry per-row currencies
     * (EUR and USD already coexist) and there is no FX table, so a single
     * summed amount would be a meaningless number.
     *
     * Only the plan/portfolio groupings read budget entries at all, so these
     * are undefined elsewhere -- "not applicable", not zero, matching
     * restricted_plan_count.
     */
    unallocated_budget_entry_count?: number;
    ambiguous_budget_entry_count?: number;
  };
}
