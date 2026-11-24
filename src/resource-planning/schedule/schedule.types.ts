/**
 * @fileoverview Response shapes for the Resource Planning 2.0, Sub Task 2 schedule endpoint.
 * Bucket hours/capacity carry no currency or cost fields -- the "never sum across currencies"
 * hazard the report engine has to guard against does not exist in this endpoint, and stays that
 * way: `default_capacity`/`capacity_periods` below expose the raw capacity records (for context,
 * e.g. "why is this employee's capacity 20h this week") but deliberately never a computed or
 * summed cost figure, which is the one thing that would reintroduce that hazard.
 * @module src/resource-planning/schedule/schedule.types
 */

export interface ScheduleBucket {
  bucket_start: string;
  /** null means capacity is unknown for this user on this day -- never flagged over-allocated. */
  capacity_hours: number | null;
  planned_hours: number;
  over_allocated: boolean;
}

export interface ScheduleCapacityRecord {
  weekly_capacity_hours: number;
  cost_rate: number | null;
  currency: string | null;
  is_active: boolean;
}

export interface ScheduleCapacityPeriodRecord extends ScheduleCapacityRecord {
  id: string;
  effective_from: string;
  effective_to: string | null;
}

export interface ScheduleAssignment {
  source: 'plan' | 'task';
  id: string;
  name: string;
  start: string;
  end: string;
  /** Total planned hours for the allocation as stored -- NOT prorated. Buckets carry the
   *  per-bucket prorated figure separately; do not conflate the two. */
  hours: number;
  /** Task ticket key -- only present for source: 'task'; absent for source: 'plan'. */
  task_key?: string;
  /** Display label from task_statuses.name (via tasks.status_id, never the legacy tasks.status
   *  column) -- only present for source: 'task', and only when the task has a resolvable
   *  status_id. Absent for source: 'plan'. */
  task_status_name?: string;
  /** Hex color from task_statuses.color -- see task_status_name. */
  task_status_color?: string;
}

export interface ScheduleUserRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  unit_ids: string[];
  buckets: ScheduleBucket[];
  assignments: ScheduleAssignment[];
  /** The employee's org-wide default capacity/rate record, or null when never configured. */
  default_capacity: ScheduleCapacityRecord | null;
  /** Dated override periods whose effective range overlaps this response's query range --
   *  NOT resolved to a single value, since a range can span more than one non-overlapping
   *  period. Empty when no period overlaps the queried range. */
  capacity_periods: ScheduleCapacityPeriodRecord[];
  /** Internal, only with ScheduleQuery.taskBreakdownIds: task id -> bucket_start -> planned hours. */
  task_hours?: Record<string, Record<string, number>>;
}

export interface ScheduleResponse {
  range: { from: string; to: string; granularity: 'day' | 'week' | 'month' };
  /** True when the resolved user count exceeded the cap and the list below was truncated --
   *  always surfaced explicitly rather than silently returning a partial result. */
  truncated_users: boolean;
  users: ScheduleUserRow[];
}
