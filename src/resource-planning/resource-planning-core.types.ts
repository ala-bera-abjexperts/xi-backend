export interface OrganizationUnitRow {
  id: string;
  organization_id: string;
  parent_id: string | null;
  name: string;
  unit_type: 'unit' | 'team';
  description: string | null;
  color: string | null;
  sort_order: number;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface UnitMembershipRow {
  id: string;
  organization_id: string;
  unit_id: string;
  user_id: string;
  effective_from: string;
  effective_to: string | null;
  /** Resource Planning 2.0. Null means 100%. */
  allocation_percent: number | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CapacityPeriodRow {
  id: string;
  organization_id: string;
  user_id: string;
  effective_from: string;
  effective_to: string | null;
  weekly_capacity_hours: number;
  cost_rate: number | null;
  currency: string | null;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BudgetEntryRow {
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
  aggregation: 'manual' | 'rollup_sum' | 'rollup_avg' | 'rollup_max';
  notes: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}
