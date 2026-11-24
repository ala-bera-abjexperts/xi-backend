/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * @fileoverview Service for the Resource Planning module.
 * Handles employee capacity management, task/plan/portfolio resource allocations,
 * and roll-up summaries. All queries are scoped by organization_id.
 * @module src/resource-planning/resource-planning.service
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { OrganizationModulesService } from '../organization-modules/organization-modules.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  countWorkingDaysInRange,
  ratioContribution,
  type WorkingCalendarContext,
} from './calendar/working-calendar.engine';
import { WorkingCalendarService } from './calendar/working-calendar.service';
import type { UpsertCapacityDto } from './dto/upsert-capacity.dto';
import type {
  BulkCapacityChangesDto,
  BulkUpdateCapacityDto,
} from './dto/bulk-update-capacity.dto';
import {
  CURRENCY_REQUIRED_FOR_RATE_MESSAGE,
  SUPPORTED_CAPACITY_CURRENCIES,
  UNSUPPORTED_CURRENCY_MESSAGE,
} from './dto/capacity-period.dto';
import type { CreateTaskAllocationDto } from './dto/create-task-allocation.dto';
import type { UpdateTaskAllocationDto } from './dto/update-task-allocation.dto';
import type { CreatePlanAllocationDto } from './dto/create-plan-allocation.dto';
import type { UpdatePlanAllocationDto } from './dto/update-plan-allocation.dto';
import {
  type AllocationMode,
  type PlanAllocationShape,
  validatePlanAllocationShape,
} from './resource-planning.validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeInclusiveWeeks(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): number | null {
  if (!startDate || !endDate) return null;
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return (end - start + 24 * 60 * 60 * 1000) / (7 * 24 * 60 * 60 * 1000);
}

// PostgREST's .in() filter embeds every id directly in the request's query
// string -- a subtree's descendant id list has no upper bound here, so a
// large enough hierarchy can exceed the stack's URL-length limit in one
// shot. Splitting into batches keeps each request small regardless of scale.
const IN_FILTER_CHUNK_SIZE = 100;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }

  return chunks;
}

export interface CapacityPeriodSummaryRow {
  user_id: string;
  effective_from: string;
  effective_to: string | null;
  weekly_capacity_hours: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toUtcDay(value: string): number | null {
  const day = new Date(`${value}T00:00:00.000Z`).getTime();
  return Number.isFinite(day) ? day : null;
}

function msToUtcDateString(ms: number): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function periodsOverlap(
  a: CapacityPeriodSummaryRow,
  b: CapacityPeriodSummaryRow,
): boolean {
  const aStart = toUtcDay(a.effective_from);
  const bStart = toUtcDay(b.effective_from);
  if (aStart == null || bStart == null) return false;
  const aEnd = a.effective_to
    ? toUtcDay(a.effective_to)
    : Number.POSITIVE_INFINITY;
  const bEnd = b.effective_to
    ? toUtcDay(b.effective_to)
    : Number.POSITIVE_INFINITY;
  if (aEnd == null || bEnd == null) return false;
  return Math.max(aStart, bStart) <= Math.min(aEnd, bEnd);
}

function anyPeriodsOverlap(periods: CapacityPeriodSummaryRow[]): boolean {
  for (let i = 0; i < periods.length; i++) {
    for (let j = i + 1; j < periods.length; j++) {
      if (periodsOverlap(periods[i], periods[j])) return true;
    }
  }
  return false;
}

/** Subtracts already-claimed day ranges from [segStart, segEnd], both inclusive UTC-day ms. */
function subtractClaimedDays(
  segStart: number,
  segEnd: number,
  claimed: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  let free = [{ start: segStart, end: segEnd }];
  for (const c of claimed) {
    const next: typeof free = [];
    for (const f of free) {
      if (c.end < f.start || c.start > f.end) {
        next.push(f);
        continue;
      }
      if (c.start > f.start)
        next.push({ start: f.start, end: c.start - DAY_MS });
      if (c.end < f.end) next.push({ start: c.end + DAY_MS, end: f.end });
    }
    free = next;
  }
  return free;
}

/**
 * Defence in depth only: employee_capacity_periods_no_active_overlap (a GiST
 * EXCLUDE constraint) already prevents overlapping active periods per user, and
 * both capacity loaders filter is_active, so this is unreachable today. It stays
 * for a caller that skips that filter, or if the constraint is ever relaxed.
 * When two periods cover the same day, the later effective_from wins that day.
 * ponytail: ties on identical effective_from break on array order, not a
 * documented rule — add a tiebreak column (e.g. created_at) if that matters.
 */
function resolveCapacityPeriodPrecedence(
  periods: CapacityPeriodSummaryRow[],
): CapacityPeriodSummaryRow[] {
  const sorted = [...periods].sort((a, b) => {
    const aStart = toUtcDay(a.effective_from) ?? -Infinity;
    const bStart = toUtcDay(b.effective_from) ?? -Infinity;
    return bStart - aStart;
  });

  const claimed: Array<{ start: number; end: number }> = [];
  const resolved: CapacityPeriodSummaryRow[] = [];
  for (const period of sorted) {
    const periodStart = toUtcDay(period.effective_from);
    if (periodStart == null) continue;
    const periodEnd = period.effective_to
      ? toUtcDay(period.effective_to)
      : Number.POSITIVE_INFINITY;
    if (periodEnd == null) continue;

    for (const segment of subtractClaimedDays(
      periodStart,
      periodEnd,
      claimed,
    )) {
      resolved.push({
        ...period,
        effective_from: msToUtcDateString(segment.start),
        effective_to:
          segment.end === Number.POSITIVE_INFINITY
            ? null
            : msToUtcDateString(segment.end),
      });
      claimed.push(segment);
    }
  }
  return resolved;
}

/**
 * Normalizes a plan currency for use as a Map/comparison key; preserves
 * null/undefined as null -- the frontend renders its "Unknown currency" label
 * off `currency === null`. The report engine deliberately differs here, mapping
 * missing currency to the string UNSPECIFIED because it keys rows by it.
 */
function normalizeCurrencyKey(
  currency: string | null | undefined,
): string | null {
  return currency == null ? null : currency.trim().toUpperCase();
}

/**
 * Working-days context for getEffectiveCapacityHours (Resource Planning 2.0,
 * Phase 1). Optional and additive: every existing call site omits it, and
 * omitting it (undefined/null) runs the exact legacy calendar-day proration
 * below unchanged, line for line. Only a call site that explicitly resolves and
 * passes a WorkingCalendarContext (see calendar/working-calendar.service.ts)
 * gets working-day-aware math instead of the /7 approximation. This is the
 * opt-in fallback mechanism (D6/R1): no scheme configured anywhere in an org
 * means this parameter is never populated, so that org's numbers are
 * byte-identical to before Resource Planning 2.0.
 */
export function getEffectiveCapacityHours(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  defaultWeeklyCapacity: number | null,
  periods: CapacityPeriodSummaryRow[] = [],
  calendar?: WorkingCalendarContext | null,
): number | null {
  if (!startDate || !endDate) return null;
  const start = toUtcDay(startDate);
  const end = toUtcDay(endDate);
  if (start == null || end == null || end < start) return null;

  const totalDays = (end - start) / DAY_MS + 1;
  const totalContribution = (weeklyCapacity: number) =>
    calendar
      ? ratioContribution(
          weeklyCapacity,
          countWorkingDaysInRange(calendar.dayHours, startDate, endDate),
          calendar.workingDaysPerWeek,
        )
      : (totalDays / 7) * weeklyCapacity;

  let hours =
    defaultWeeklyCapacity == null
      ? 0
      : totalContribution(Number(defaultWeeklyCapacity));
  let hasKnownCapacity = defaultWeeklyCapacity != null;
  let coveredDays = 0;

  // Fix: overlapping periods (DB allows them) must not double-count a day.
  const effectivePeriods = anyPeriodsOverlap(periods)
    ? resolveCapacityPeriodPrecedence(periods)
    : periods;

  for (const period of effectivePeriods) {
    const periodStart = toUtcDay(period.effective_from);
    const periodEnd = period.effective_to
      ? toUtcDay(period.effective_to)
      : Number.POSITIVE_INFINITY;
    if (periodStart == null || periodEnd == null) continue;
    const overlapStart = Math.max(start, periodStart);
    const overlapEnd = Math.min(end, periodEnd);
    if (overlapEnd < overlapStart) continue;

    const overlapDays = (overlapEnd - overlapStart) / DAY_MS + 1;
    coveredDays += overlapDays;
    const overlapContribution = (weeklyCapacity: number) =>
      calendar
        ? ratioContribution(
            weeklyCapacity,
            countWorkingDaysInRange(
              calendar.dayHours,
              msToUtcDateString(overlapStart),
              msToUtcDateString(overlapEnd),
            ),
            calendar.workingDaysPerWeek,
          )
        : (overlapDays / 7) * weeklyCapacity;

    if (defaultWeeklyCapacity != null) {
      hours -= overlapContribution(Number(defaultWeeklyCapacity));
    }
    hours += overlapContribution(Number(period.weekly_capacity_hours));
    hasKnownCapacity = true;
  }

  if (defaultWeeklyCapacity == null && coveredDays < totalDays) return null;
  return hasKnownCapacity ? hours : null;
}

export function mergeEffectiveDateIntervals(
  intervals: Array<{ start: string; end: string }>,
): Array<{ start: string; end: string }> {
  const parsed = intervals
    .map((interval) => ({
      ...interval,
      startDay: toUtcDay(interval.start),
      endDay: toUtcDay(interval.end),
    }))
    .filter(
      (
        interval,
      ): interval is typeof interval & {
        startDay: number;
        endDay: number;
      } =>
        interval.startDay != null &&
        interval.endDay != null &&
        interval.endDay >= interval.startDay,
    )
    .sort((a, b) => a.startDay - b.startDay);

  const merged: typeof parsed = [];
  for (const interval of parsed) {
    const previous = merged.at(-1);
    if (!previous || interval.startDay > previous.endDay + DAY_MS) {
      merged.push({ ...interval });
      continue;
    }
    if (interval.endDay > previous.endDay) {
      previous.end = interval.end;
      previous.endDay = interval.endDay;
    }
  }
  return merged.map(({ start, end }) => ({ start, end }));
}

/**
 * `calendar` is optional and additive, same contract as getEffectiveCapacityHours
 * above (D6/R1): every existing call site omits it and gets the exact legacy
 * (calendarDays / 7) proration for hours_per_week, unchanged. Only an explicit
 * caller that resolved a WorkingCalendarContext gets working-day-aware math.
 */
export function getEffectivePlannedHours(
  allocation: Pick<
    PlanAllocRow,
    | 'allocation_mode'
    | 'planned_hours'
    | 'weekly_hours'
    | 'capacity_percent'
    | 'start_date'
    | 'end_date'
  >,
  weeklyCapacity: number | null,
  capacityPeriods: CapacityPeriodSummaryRow[] = [],
  calendar?: WorkingCalendarContext | null,
): number {
  const mode = allocation.allocation_mode ?? 'total_hours';
  if (mode === 'total_hours') return Number(allocation.planned_hours) || 0;

  if (mode === 'hours_per_week') {
    const weeklyHours = Number(allocation.weekly_hours) || 0;
    if (calendar && allocation.start_date && allocation.end_date) {
      return ratioContribution(
        weeklyHours,
        countWorkingDaysInRange(
          calendar.dayHours,
          allocation.start_date,
          allocation.end_date,
        ),
        calendar.workingDaysPerWeek,
      );
    }
    const weeks = computeInclusiveWeeks(
      allocation.start_date,
      allocation.end_date,
    );
    if (weeks == null) return 0;
    return weeklyHours * weeks;
  }

  const capacityHours = getEffectiveCapacityHours(
    allocation.start_date,
    allocation.end_date,
    weeklyCapacity,
    capacityPeriods,
    calendar,
  );
  if (capacityHours == null) return 0;
  return capacityHours * ((Number(allocation.capacity_percent) || 0) / 100);
}

type AllocationModeInput = Pick<
  PlanAllocationShape,
  'allocation_mode' | 'planned_hours' | 'weekly_hours' | 'capacity_percent'
>;

/** Insert columns for an allocation's mode. Plan and task allocations share
 *  the same mode_shape CHECK, so both insert through this. */
function allocationModeInsert(dto: AllocationModeInput) {
  const mode = dto.allocation_mode ?? 'total_hours';
  return {
    allocation_mode: mode,
    planned_hours: mode === 'total_hours' ? (dto.planned_hours ?? 0) : 0,
    weekly_hours: mode === 'hours_per_week' ? (dto.weekly_hours ?? null) : null,
    capacity_percent:
      mode === 'capacity_percent' ? (dto.capacity_percent ?? null) : null,
  };
}

/** Copies the mode fields a PATCH sent, then clears the ones `targetMode`
 *  (the merged row's mode) forbids. */
function applyAllocationModePatch(
  patch: Record<string, unknown>,
  dto: AllocationModeInput,
  targetMode: AllocationMode | null | undefined,
): void {
  if (dto.planned_hours !== undefined) patch.planned_hours = dto.planned_hours;
  if (dto.allocation_mode !== undefined)
    patch.allocation_mode = dto.allocation_mode;
  if (dto.weekly_hours !== undefined) patch.weekly_hours = dto.weekly_hours;
  if (dto.capacity_percent !== undefined)
    patch.capacity_percent = dto.capacity_percent;

  if (targetMode === 'total_hours') {
    patch.weekly_hours = null;
    patch.capacity_percent = null;
  } else if (targetMode === 'hours_per_week') {
    patch.planned_hours = 0;
    patch.capacity_percent = null;
  } else if (targetMode === 'capacity_percent') {
    patch.planned_hours = 0;
    patch.weekly_hours = null;
  }
}

/** Spaces whose RP data the current user may see in multi-space views. */
export interface SpaceScope {
  allowedSpaceIds: Set<string>;
  /** Tasks/plans with no space are tenant-level and always visible. */
  allowsNullSpace: true;
}

/** Null-space rows pass; an unknown space (undefined, e.g. a missing embed) fails closed. */
export function inSpaceScope(
  scope: SpaceScope,
  spaceId: string | null | undefined,
): boolean {
  return (
    spaceId === null ||
    (spaceId !== undefined && scope.allowedSpaceIds.has(spaceId))
  );
}

// ---------------------------------------------------------------------------
// Shared select fragments
// ---------------------------------------------------------------------------

const USER_SELECT =
  'user:users!employee_capacity_user_id_fkey(id, first_name, last_name, email, avatar_url, is_active)';

const TASK_ALLOC_USER_SELECT =
  'user:users!task_resource_allocations_user_id_fkey(id, first_name, last_name, email, avatar_url, is_active)';

const PLAN_ALLOC_USER_SELECT =
  'user:users!plan_resource_allocations_user_id_fkey(id, first_name, last_name, email, avatar_url, is_active)';

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

export interface CapacityRow {
  id: string;
  organization_id: string;
  user_id: string;
  weekly_capacity_hours: number;
  cost_rate: number | null;
  currency: string | null;
  is_active: boolean;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  user?: unknown;
}

/** The capacity values an audit entry records and a bulk edit compares. */
export type CapacityValues = Pick<
  CapacityRow,
  'weekly_capacity_hours' | 'cost_rate' | 'currency' | 'is_active'
>;

/** Numeric columns can come back as strings; normalize before comparing. */
function toCapacityValues(row: CapacityValues): CapacityValues {
  return {
    weekly_capacity_hours: Number(row.weekly_capacity_hours),
    cost_rate: row.cost_rate == null ? null : Number(row.cost_rate),
    currency: row.currency ?? null,
    is_active: row.is_active,
  };
}

/** Every requested user id appears in exactly one list. */
export interface BulkCapacityResult {
  updated: string[];
  unchanged: string[];
  skipped: { user_id: string; reason: 'deactivated' }[];
  failed: {
    user_id: string;
    reason:
      | 'not_member'
      | 'weekly_capacity_required'
      | 'currency_required_for_rate'
      | 'unsupported_currency'
      | 'write_failed';
    message: string;
  }[];
}

export interface TaskAllocRow {
  id: string;
  organization_id: string;
  task_id: string;
  user_id: string;
  planned_hours: number;
  allocation_mode: AllocationMode;
  weekly_hours: number | null;
  capacity_percent: number | null;
  start_date: string | null;
  end_date: string | null;
  role: string | null;
  notes: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  user?: unknown;
}

export interface PlanAllocRow {
  id: string;
  organization_id: string;
  plan_id: string;
  user_id: string;
  planned_hours: number;
  planned_budget: number;
  allocation_mode: AllocationMode;
  start_date: string | null;
  end_date: string | null;
  weekly_hours: number | null;
  capacity_percent: number | null;
  role: string | null;
  notes: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
  user?: unknown;
}

interface TaskRow {
  id: string;
  organization_id: string;
  space_id: string;
  planned_budget: number | null;
}

interface PlanRow {
  id: string;
  organization_id: string;
  space_id: string;
  currency: string | null;
  start_date: string | null;
  end_date: string | null;
  name?: string;
  is_archived?: boolean;
}

interface PortfolioRow {
  id: string;
  organization_id: string;
}

@Injectable()
export class ResourcePlanningService {
  private readonly logger = new Logger(ResourcePlanningService.name);
  private static readonly CAPACITY_TABLE = 'employee_capacity';
  private static readonly TASK_ALLOC_TABLE = 'task_resource_allocations';
  private static readonly PLAN_ALLOC_TABLE = 'plan_resource_allocations';

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
    private readonly orgModulesService: OrganizationModulesService,
    private readonly workingCalendarService: WorkingCalendarService,
    private readonly auditLogsService: AuditLogsService,
  ) {}

  /**
   * Resolves a WorkingCalendarContext per distinct user in `userDateRanges`,
   * or an empty Map if the organization has never configured a workload
   * scheme (the common case today — checked once, cheaply, rather than once
   * per user). A user whose own range cannot be determined, or who has no
   * personal/org-default scheme, is simply absent from the returned Map —
   * every capacity-math call site already treats a missing/undefined
   * calendar as the legacy opt-out signal.
   */
  private async resolveCalendarsForUsers(
    organizationId: string,
    userDateRanges: Map<string, { from: string; to: string }>,
  ): Promise<Map<string, WorkingCalendarContext>> {
    const result = new Map<string, WorkingCalendarContext>();
    if (userDateRanges.size === 0) return result;
    if (
      !(await this.workingCalendarService.hasAnySchemeConfigured(
        organizationId,
      ))
    ) {
      return result;
    }
    await Promise.all(
      [...userDateRanges.entries()].map(async ([userId, range]) => {
        const calendar =
          await this.workingCalendarService.resolveCalendarContext(
            organizationId,
            userId,
            range.from,
            range.to,
          );
        if (calendar) result.set(userId, calendar);
      }),
    );
    return result;
  }

  // ==========================================================================
  // Module-enabled guard
  // ==========================================================================

  /**
   * Asserts the resource_planning module is enabled for this organization.
   * Per-request check — not cached — so admin disable takes effect immediately.
   */
  private async assertModuleEnabled(organizationId: string): Promise<void> {
    const enabled = await this.orgModulesService.isEnabled(
      organizationId,
      'resource_planning',
    );

    if (!enabled) {
      throw new ForbiddenException('Resource Planning module is not enabled');
    }
  }

  /**
   * Spaces whose RP data this user may see in multi-space views (schedule,
   * report, budget entries, budget tree): the space module is on, the space
   * is not archived, and the user is a member (owners/admins: every enabled
   * space). Resolve once per request and test rows with `inSpaceScope`.
   * ponytail: non-admins cost one (cached) getUserSpacePermissions per
   * enabled space; swap for one space_members read if that list gets long.
   */
  async resolveSpaceScope(
    organizationId: string,
    userId: string,
  ): Promise<SpaceScope> {
    const [enabled, isAdmin] = await Promise.all([
      this.orgModulesService.getEnabledSpaceIds(
        organizationId,
        'resource_planning',
      ),
      this.permissionsService.isAdminOrOwner(userId, organizationId),
    ]);
    if (isAdmin) {
      return { allowedSpaceIds: new Set(enabled), allowsNullSpace: true };
    }

    const memberOf = await Promise.all(
      enabled.map(async (spaceId) =>
        (
          await this.permissionsService.getUserSpacePermissions(
            userId,
            organizationId,
            spaceId,
          )
        ).isMember
          ? spaceId
          : null,
      ),
    );
    return {
      allowedSpaceIds: new Set(
        memberOf.filter((id): id is string => id !== null),
      ),
      allowsNullSpace: true,
    };
  }

  /**
   * 403 when the space's resource_planning space module is off. Null-space
   * tasks/plans are tenant-level and pass. Callers run this BEFORE any
   * owner/admin bypass: the toggle binds admins too.
   */
  async assertSpaceAllowed(
    organizationId: string,
    spaceId: string | null,
  ): Promise<void> {
    if (spaceId == null) return;
    if (
      !(await this.orgModulesService.isSpaceModuleEnabled(
        organizationId,
        spaceId,
        'resource_planning',
      ))
    ) {
      throw new ForbiddenException(
        'Resource Planning is not enabled in this space',
      );
    }
  }

  // ==========================================================================
  // Authorization helpers (mirror time-entries pattern exactly)
  // ==========================================================================

  /**
   * Verifies the task exists in the organization and returns it.
   * Mirrors TimeEntriesService.assertTaskInOrganization() pattern.
   */
  private async assertTaskInOrganization(
    taskId: string,
    organizationId: string,
  ): Promise<TaskRow> {
    const { data, error } = await this.client
      .from('tasks')
      .select('id, organization_id, space_id, planned_budget')
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Task not found');

    return data as TaskRow;
  }

  /**
   * Verifies the user can access the space the task belongs to.
   * For view: space membership is sufficient.
   * For write: space membership with can_edit_tasks permission.
   * Mirrors how time-entries authorizes per-task access.
   */
  private async assertUserCanAccessTaskSpace(
    userId: string,
    organizationId: string,
    spaceId: string,
    level: 'view' | 'write',
  ): Promise<void> {
    await this.assertSpaceAllowed(organizationId, spaceId);

    // Admin/owner bypasses space check
    if (await this.permissionsService.isAdminOrOwner(userId, organizationId)) {
      return;
    }

    const spaceAccess = await this.permissionsService.getUserSpacePermissions(
      userId,
      organizationId,
      spaceId,
    );

    if (!spaceAccess.isMember) {
      throw new ForbiddenException('You do not have access to this task');
    }

    if (level === 'write') {
      // Require can_edit_tasks in space permissions (same check as time-entry creation)
      if (!spaceAccess.permissions['edit_tasks']) {
        throw new ForbiddenException(
          'You do not have permission to modify allocations for this task',
        );
      }
    }
  }

  /** Reusable organization-safe task authorization for related resource data. */
  async assertTaskAccess(
    taskId: string,
    organizationId: string,
    userId: string,
    level: 'view' | 'write',
  ): Promise<TaskRow> {
    const task = await this.assertTaskInOrganization(taskId, organizationId);
    await this.assertUserCanAccessTaskSpace(
      userId,
      organizationId,
      task.space_id,
      level,
    );
    return task;
  }

  /**
   * Verifies the plan exists in the organization and returns it.
   */
  private async assertPlanInOrganization(
    planId: string,
    organizationId: string,
  ): Promise<PlanRow> {
    const { data, error } = await this.client
      .from('plans')
      .select('id, organization_id, space_id, currency, start_date, end_date')
      .eq('id', planId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Plan not found');

    return data as PlanRow;
  }

  /**
   * Verifies the user can access the plan (mirrors PlansService.userCanAccessPlan / 'view' level).
   */
  private async assertUserCanAccessPlan(
    userId: string,
    organizationId: string,
    planId: string,
    spaceId: string,
    level: 'view' | 'edit' = 'view',
  ): Promise<void> {
    await this.assertSpaceAllowed(organizationId, spaceId);

    if (await this.permissionsService.isAdminOrOwner(userId, organizationId)) {
      return;
    }

    const spaceAccess = await this.permissionsService.getUserSpacePermissions(
      userId,
      organizationId,
      spaceId,
    );

    const permissionKey = level === 'view' ? 'view_plans' : 'edit_plans';
    if (
      spaceAccess.isMember &&
      spaceAccess.permissions[permissionKey] === true
    ) {
      return;
    }

    // Fallback: check plan_permissions table for explicit permission
    const { data: planPerm, error: planPermError } = await this.client
      .from('plan_permissions')
      .select('permission_level')
      .eq('plan_id', planId)
      .eq('user_id', userId)
      .maybeSingle();

    if (planPermError) {
      throw new InternalServerErrorException(planPermError.message);
    }

    const rank: Record<string, number> = { view: 1, edit: 2, admin: 3 };
    const explicitLevel = (planPerm as { permission_level?: string } | null)
      ?.permission_level;
    const requiredRank = level === 'view' ? 1 : 2;
    if (explicitLevel && (rank[explicitLevel] ?? 0) >= requiredRank) {
      return;
    }

    throw new ForbiddenException('You do not have access to this plan');
  }

  /** Reusable organization-safe plan authorization for related resource data. */
  async assertPlanAccess(
    planId: string,
    organizationId: string,
    userId: string,
    level: 'view' | 'edit' = 'view',
  ): Promise<PlanRow> {
    const plan = await this.assertPlanInOrganization(planId, organizationId);
    await this.assertUserCanAccessPlan(
      userId,
      organizationId,
      planId,
      plan.space_id,
      level,
    );
    return plan;
  }

  /** Ensures service-role writes cannot reference a user from another tenant. */
  async assertOrganizationMember(
    organizationId: string,
    targetUserId: string,
  ): Promise<void> {
    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('user_id', targetUserId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) {
      throw new NotFoundException('User is not a member of this organization');
    }
  }

  /**
   * Returns true when the user can expose a plan (used for portfolio iteration).
   * Not private: reused by ResourcePlanningReportService for the same
   * per-plan check on group_by=portfolio reporting (both are providers of
   * the same ResourcePlanningModule, so no new module wiring/circular-dep
   * risk from this cross-service call).
   */
  async canExposePlan(
    planId: string,
    organizationId: string,
    userId: string,
    spaceId: string,
  ): Promise<boolean> {
    try {
      await this.assertUserCanAccessPlan(
        userId,
        organizationId,
        planId,
        spaceId,
      );
      return true;
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      return false;
    }
  }

  /**
   * Verifies the portfolio exists in the organization.
   */
  private async assertPortfolioInOrganization(
    portfolioId: string,
    organizationId: string,
  ): Promise<PortfolioRow> {
    const { data, error } = await this.client
      .from('portfolios')
      .select('id, organization_id')
      .eq('id', portfolioId)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Portfolio not found');

    return data as PortfolioRow;
  }

  // ==========================================================================
  // Employee Capacity
  // ==========================================================================

  /**
   * Lists all employee capacity records for an organization, joined with user data.
   */
  async listCapacity(organizationId: string): Promise<CapacityRow[]> {
    await this.assertModuleEnabled(organizationId);

    const { data, error } = await this.client
      .from(ResourcePlanningService.CAPACITY_TABLE)
      .select(`*, ${USER_SELECT}`)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) throw new InternalServerErrorException(error.message);

    return (data ?? []) as CapacityRow[];
  }

  /**
   * Upserts the capacity record for (organizationId, userId) on the unique constraint.
   * Verifies targetUserId is a member of the organization before writing.
   * Does not overwrite created_by on update — only sets it on initial insert.
   */
  async upsertCapacity(
    organizationId: string,
    userId: string,
    targetUserId: string,
    dto: UpsertCapacityDto,
  ): Promise<CapacityRow> {
    await this.assertModuleEnabled(organizationId);
    await this.assertOrganizationMember(organizationId, targetUserId);

    const now = new Date().toISOString();

    // Fix 2: check if a row already exists so we do not overwrite created_by
    const { data: existingRow, error: existingError } = await this.client
      .from(ResourcePlanningService.CAPACITY_TABLE)
      .select(
        'id, created_by, weekly_capacity_hours, cost_rate, currency, is_active',
      )
      .eq('organization_id', organizationId)
      .eq('user_id', targetUserId)
      .maybeSingle();

    if (existingError) {
      throw new InternalServerErrorException(existingError.message);
    }

    const isInsert = !existingRow;
    const upsertPayload: Record<string, unknown> = {
      organization_id: organizationId,
      user_id: targetUserId,
      weekly_capacity_hours: dto.weekly_capacity_hours,
      cost_rate: dto.cost_rate ?? null,
      currency: dto.currency ?? null,
      is_active: dto.is_active ?? true,
      updated_by: userId,
      updated_at: now,
    };

    // Only set created_by on initial insert; preserve it on updates
    if (isInsert) {
      upsertPayload.created_by = userId;
    }

    const { data, error } = await this.client
      .from(ResourcePlanningService.CAPACITY_TABLE)
      .upsert(upsertPayload, {
        onConflict: 'organization_id,user_id',
        ignoreDuplicates: false,
      })
      .select(`*, ${USER_SELECT}`)
      .single();

    if (error) throw new BadRequestException(error.message);

    this.logCapacityChange(
      organizationId,
      userId,
      targetUserId,
      'single',
      existingRow ? toCapacityValues(existingRow as CapacityValues) : null,
      toCapacityValues(data as CapacityRow),
    );

    return data as CapacityRow;
  }

  /**
   * Applies one change (or a reset) to many employees' capacity records.
   * Each employee is validated against its own merged values, so one failure
   * never blocks the others.
   */
  async bulkUpdateCapacity(
    organizationId: string,
    actorUserId: string,
    dto: BulkUpdateCapacityDto,
  ): Promise<BulkCapacityResult> {
    await this.assertModuleEnabled(organizationId);

    const { action, user_ids: userIds, changes } = dto;
    if (action === 'reset' && changes !== undefined) {
      throw new BadRequestException('changes must be omitted for reset');
    }
    if (
      action === 'update' &&
      (changes == null ||
        (changes.weekly_capacity_hours === undefined &&
          changes.cost_rate === undefined &&
          changes.currency === undefined))
    ) {
      throw new BadRequestException('changes must set at least one field');
    }
    const c: BulkCapacityChangesDto = changes ?? {};

    const members = new Set<string>();
    const deactivated = new Set<string>();
    const rows = new Map<
      string,
      { values: CapacityValues; created_by: string }
    >();
    for (const chunk of chunkArray(userIds, IN_FILTER_CHUNK_SIZE)) {
      const [memberRes, userRes, rowRes] = await Promise.all([
        this.client
          .from('organization_members')
          .select('user_id')
          .eq('organization_id', organizationId)
          .in('user_id', chunk),
        this.client.from('users').select('id, is_active').in('id', chunk),
        this.client
          .from(ResourcePlanningService.CAPACITY_TABLE)
          .select(
            'user_id, weekly_capacity_hours, cost_rate, currency, is_active, created_by',
          )
          .eq('organization_id', organizationId)
          .in('user_id', chunk),
      ]);
      const readError = memberRes.error ?? userRes.error ?? rowRes.error;
      if (readError) throw new InternalServerErrorException(readError.message);

      for (const m of (memberRes.data ?? []) as { user_id: string }[]) {
        members.add(m.user_id);
      }
      for (const u of (userRes.data ?? []) as {
        id: string;
        is_active: boolean | null;
      }[]) {
        if (u.is_active === false) deactivated.add(u.id);
      }
      for (const r of (rowRes.data ?? []) as CapacityRow[]) {
        rows.set(r.user_id, {
          values: toCapacityValues(r),
          created_by: r.created_by,
        });
      }
    }

    const result: BulkCapacityResult = {
      updated: [],
      unchanged: [],
      skipped: [],
      failed: [],
    };
    const pending: {
      user_id: string;
      before: CapacityValues | null;
      after: CapacityValues | null;
      created_by: string;
    }[] = [];

    for (const userId of userIds) {
      const existing = rows.get(userId);
      if (!members.has(userId)) {
        result.failed.push({
          user_id: userId,
          reason: 'not_member',
          message: 'User is not a member of this organization',
        });
        continue;
      }
      if (deactivated.has(userId)) {
        result.skipped.push({ user_id: userId, reason: 'deactivated' });
        continue;
      }
      const before = existing?.values ?? null;

      if (action === 'reset') {
        if (existing) {
          pending.push({
            user_id: userId,
            before,
            after: null,
            created_by: existing.created_by,
          });
        } else {
          result.unchanged.push(userId);
        }
        continue;
      }

      const weekly =
        c.weekly_capacity_hours !== undefined
          ? c.weekly_capacity_hours
          : before?.weekly_capacity_hours;
      if (weekly === undefined) {
        result.failed.push({
          user_id: userId,
          reason: 'weekly_capacity_required',
          message:
            'Enter a weekly capacity for employees without their own values',
        });
        continue;
      }
      const after: CapacityValues = {
        weekly_capacity_hours: weekly,
        cost_rate:
          c.cost_rate !== undefined ? c.cost_rate : (before?.cost_rate ?? null),
        currency:
          c.currency !== undefined ? c.currency : (before?.currency ?? null),
        is_active: before?.is_active ?? true,
      };

      if (c.cost_rate !== undefined || c.currency !== undefined) {
        if (
          after.currency !== null &&
          !(SUPPORTED_CAPACITY_CURRENCIES as readonly string[]).includes(
            after.currency,
          )
        ) {
          result.failed.push({
            user_id: userId,
            reason: 'unsupported_currency',
            message: UNSUPPORTED_CURRENCY_MESSAGE,
          });
          continue;
        }
        if (after.cost_rate !== null && after.currency === null) {
          result.failed.push({
            user_id: userId,
            reason: 'currency_required_for_rate',
            message: CURRENCY_REQUIRED_FOR_RATE_MESSAGE,
          });
          continue;
        }
      }

      if (
        before &&
        before.weekly_capacity_hours === after.weekly_capacity_hours &&
        before.cost_rate === after.cost_rate &&
        before.currency === after.currency
      ) {
        result.unchanged.push(userId);
        continue;
      }

      pending.push({
        user_id: userId,
        before,
        after,
        // Existing rows keep their creator (even null): a batched upsert
        // would otherwise write NULL into a column one payload omits.
        created_by: existing ? existing.created_by : actorUserId,
      });
    }

    const written: typeof pending = [];
    const writeFailed = (userId: string, message: string) =>
      result.failed.push({ user_id: userId, reason: 'write_failed', message });

    if (action === 'update' && pending.length > 0) {
      const now = new Date().toISOString();
      const payload = (p: (typeof pending)[number]) => ({
        organization_id: organizationId,
        user_id: p.user_id,
        ...p.after,
        created_by: p.created_by,
        updated_by: actorUserId,
        updated_at: now,
      });
      const onConflict = { onConflict: 'organization_id,user_id' };

      const { error } = await this.client
        .from(ResourcePlanningService.CAPACITY_TABLE)
        .upsert(pending.map(payload), onConflict);
      if (!error) {
        written.push(...pending);
      } else {
        // Retry one by one so a single bad row doesn't fail the whole batch.
        for (const p of pending) {
          const { error: rowError } = await this.client
            .from(ResourcePlanningService.CAPACITY_TABLE)
            .upsert(payload(p), onConflict);
          if (rowError) writeFailed(p.user_id, rowError.message);
          else written.push(p);
        }
      }
    }

    if (action === 'reset') {
      // Chunked like the reads: .in() puts every id in the URL.
      for (const chunk of chunkArray(pending, IN_FILTER_CHUNK_SIZE)) {
        const { error } = await this.client
          .from(ResourcePlanningService.CAPACITY_TABLE)
          .delete()
          .eq('organization_id', organizationId)
          .in(
            'user_id',
            chunk.map((p) => p.user_id),
          );
        if (error) chunk.forEach((p) => writeFailed(p.user_id, error.message));
        else written.push(...chunk);
      }
    }

    for (const p of written) {
      result.updated.push(p.user_id);
      this.logCapacityChange(
        organizationId,
        actorUserId,
        p.user_id,
        'bulk',
        p.before,
        p.after,
      );
    }

    return result;
  }

  /** Fire-and-forget audit entry for one employee's capacity write. */
  private logCapacityChange(
    organizationId: string,
    actorUserId: string,
    targetUserId: string,
    source: 'single' | 'bulk',
    before: CapacityValues | null,
    after: CapacityValues | null,
  ): void {
    void this.auditLogsService.logAction(
      organizationId,
      actorUserId,
      'employee_capacity',
      targetUserId,
      before === null ? 'create' : after === null ? 'delete' : 'update',
      { user_id: targetUserId, source, before, after },
    );
  }

  // ==========================================================================
  // Task-level allocations
  // ==========================================================================

  /**
   * Lists all resource allocations for a task (scoped to organization).
   */
  async listTaskAllocations(
    taskId: string,
    organizationId: string,
    userId: string,
  ): Promise<Array<TaskAllocRow & { effective_planned_hours: number }>> {
    // Fix 3: module must be enabled per-request
    await this.assertModuleEnabled(organizationId);

    const task = await this.assertTaskInOrganization(taskId, organizationId);

    await this.assertUserCanAccessTaskSpace(
      userId,
      organizationId,
      task.space_id,
      'view',
    );

    const { data, error } = await this.client
      .from(ResourcePlanningService.TASK_ALLOC_TABLE)
      .select(`*, ${TASK_ALLOC_USER_SELECT}`)
      .eq('task_id', taskId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) throw new InternalServerErrorException(error.message);

    const rows = (data ?? []) as TaskAllocRow[];
    const hours = await this.effectiveTaskHours(organizationId, rows);
    return rows.map((row, i) => ({
      ...row,
      effective_planned_hours: hours[i],
    }));
  }

  /**
   * Creates a new task resource allocation.
   * Throws 409 on duplicate (task_id, user_id).
   */
  async createTaskAllocation(
    taskId: string,
    organizationId: string,
    userId: string,
    dto: CreateTaskAllocationDto,
  ): Promise<TaskAllocRow> {
    // Fix 3: module must be enabled per-request
    await this.assertModuleEnabled(organizationId);

    const task = await this.assertTaskInOrganization(taskId, organizationId);

    await this.assertUserCanAccessTaskSpace(
      userId,
      organizationId,
      task.space_id,
      'write',
    );

    await this.assertOrganizationMember(organizationId, dto.user_id);
    validatePlanAllocationShape(dto);

    const now = new Date().toISOString();
    const { data, error } = await this.client
      .from(ResourcePlanningService.TASK_ALLOC_TABLE)
      .insert({
        organization_id: organizationId,
        task_id: taskId,
        user_id: dto.user_id,
        ...allocationModeInsert(dto),
        start_date: dto.start_date ?? null,
        end_date: dto.end_date ?? null,
        role: dto.role ?? null,
        notes: dto.notes ?? null,
        created_by: userId,
        updated_by: userId,
        created_at: now,
        updated_at: now,
      })
      .select(`*, ${TASK_ALLOC_USER_SELECT}`)
      .single();

    if (error?.code === '23505') {
      throw new ConflictException(
        'This user already has an allocation for this task',
      );
    }
    if (error) throw new BadRequestException(error.message);

    return data as TaskAllocRow;
  }

  /**
   * Updates a task allocation by id.
   */
  async updateTaskAllocation(
    id: string,
    organizationId: string,
    userId: string,
    dto: UpdateTaskAllocationDto,
  ): Promise<TaskAllocRow> {
    // Fix 3: module must be enabled per-request
    await this.assertModuleEnabled(organizationId);

    const existing = await this.findTaskAllocationById(id, organizationId);
    const task = await this.assertTaskInOrganization(
      existing.task_id,
      organizationId,
    );

    await this.assertUserCanAccessTaskSpace(
      userId,
      organizationId,
      task.space_id,
      'write',
    );

    const mergedAllocation = { ...existing, ...dto };
    validatePlanAllocationShape(mergedAllocation);

    const patch: Record<string, unknown> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };

    if (dto.start_date !== undefined) patch.start_date = dto.start_date;
    if (dto.end_date !== undefined) patch.end_date = dto.end_date;
    applyAllocationModePatch(patch, dto, mergedAllocation.allocation_mode);
    if (dto.role !== undefined) patch.role = dto.role;
    if (dto.notes !== undefined) patch.notes = dto.notes;

    // Fix 4: defense-in-depth — scope write to organization_id as well as id
    const { data, error } = await this.client
      .from(ResourcePlanningService.TASK_ALLOC_TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select(`*, ${TASK_ALLOC_USER_SELECT}`)
      .single();

    if (error) throw new BadRequestException(error.message);

    return data as TaskAllocRow;
  }

  /**
   * Deletes a task allocation by id.
   */
  async deleteTaskAllocation(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    // Fix 3: module must be enabled per-request
    await this.assertModuleEnabled(organizationId);

    const existing = await this.findTaskAllocationById(id, organizationId);
    const task = await this.assertTaskInOrganization(
      existing.task_id,
      organizationId,
    );

    await this.assertUserCanAccessTaskSpace(
      userId,
      organizationId,
      task.space_id,
      'write',
    );

    // Fix 4: defense-in-depth — scope delete to organization_id as well as id
    const { error } = await this.client
      .from(ResourcePlanningService.TASK_ALLOC_TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
  }

  /**
   * Gets a task resource rollup: own + cumulative (via get_task_descendant_ids RPC).
   */
  async getTaskRollup(
    taskId: string,
    organizationId: string,
    userId: string,
  ): Promise<{
    task_id: string;
    own: { planned_budget: number; planned_hours: number; headcount: number };
    cumulative: {
      planned_budget: number;
      planned_hours: number;
      headcount: number;
    };
    has_sublevels: boolean;
    allocations: TaskAllocRow[];
    /**
     * Resource Planning 2.0, Sub Task 1. This task's OWN manual budget-entry
     * amounts (not cumulative across descendants -- see the dedicated
     * GET /tasks/:taskId/budget-tree endpoint for the full rollup tree),
     * grouped by cost category and currency. Additive: every existing
     * consumer of getTaskRollup ignores unknown keys (see R5) and this field
     * changes nothing about own/cumulative/has_sublevels/allocations above.
     */
    budget_by_category: Array<{
      cost_category_id: string;
      currency: string;
      planned_amount: number;
      actual_amount: number;
    }>;
    budget_by_currency: Array<{
      currency: string;
      planned_amount: number;
      actual_amount: number;
    }>;
  }> {
    // Fix 3: module must be enabled per-request
    await this.assertModuleEnabled(organizationId);

    const task = await this.assertTaskInOrganization(taskId, organizationId);

    await this.assertUserCanAccessTaskSpace(
      userId,
      organizationId,
      task.space_id,
      'view',
    );

    // Get all descendant task IDs via RPC
    const { data: descendantIds, error: rpcError } = await this.client.rpc(
      'get_task_descendant_ids',
      { p_root_ids: [taskId], p_organization_id: organizationId },
    );

    if (rpcError) throw new InternalServerErrorException(rpcError.message);

    const descendants: string[] = ((descendantIds ?? []) as string[]).filter(
      (id) => id !== taskId,
    );
    const hasSublevels = descendants.length > 0;
    const allTaskIds = [taskId, ...descendants];

    // Fetch own allocations (with user)
    const allocations = await this.listTaskAllocationsByIds(
      [taskId],
      organizationId,
    );

    // Fetch cumulative allocations (own + descendants)
    const cumulativeAllocs = hasSublevels
      ? await this.listTaskAllocationsByIds(allTaskIds, organizationId)
      : allocations;

    // Effective hours (hours/week and % of capacity prorated); own allocations
    // are a subset of the cumulative set, so one pass covers both.
    const cumulativeHours = await this.effectiveTaskHours(
      organizationId,
      cumulativeAllocs,
    );
    const hoursById = new Map(
      cumulativeAllocs.map((a, i) => [a.id, cumulativeHours[i]]),
    );

    // Own totals
    const ownPlannedHours = allocations.reduce(
      (sum, a) => sum + (hoursById.get(a.id) ?? 0),
      0,
    );
    const ownHeadcount = new Set(allocations.map((a) => a.user_id)).size;
    const ownPlannedBudget =
      task.planned_budget != null ? Number(task.planned_budget) : 0;

    // Cumulative task planned_budget: sum across all task ids
    let cumulativePlannedBudget = ownPlannedBudget;
    if (hasSublevels && descendants.length > 0) {
      for (const chunk of chunkArray(descendants, IN_FILTER_CHUNK_SIZE)) {
        const { data: descendantTasks, error: dtErr } = await this.client
          .from('tasks')
          .select('planned_budget')
          .in('id', chunk)
          .eq('organization_id', organizationId);

        if (dtErr) throw new InternalServerErrorException(dtErr.message);

        for (const dt of (descendantTasks ?? []) as Array<{
          planned_budget: number | null;
        }>) {
          cumulativePlannedBudget +=
            dt.planned_budget != null ? Number(dt.planned_budget) : 0;
        }
      }
    }

    const cumulativePlannedHours = cumulativeHours.reduce(
      (sum, hours) => sum + hours,
      0,
    );
    const cumulativeHeadcount = new Set(cumulativeAllocs.map((a) => a.user_id))
      .size;

    // Resource Planning 2.0, Sub Task 1 -- own manual budget entries only.
    // Excludes rollup_* rows for the same D9 reason the report engine does:
    // their amount is a placeholder, not a fact, and the full rollup tree is
    // computed by the dedicated budget-tree endpoint, not duplicated here.
    const { data: ownBudgetRows, error: budgetError } = await this.client
      .from('resource_budget_entries')
      .select('cost_category_id, currency, entry_type, amount, aggregation')
      .eq('organization_id', organizationId)
      .eq('task_id', taskId)
      .eq('aggregation', 'manual')
      .not('cost_category_id', 'is', null);
    if (budgetError) {
      throw new InternalServerErrorException(budgetError.message);
    }
    const byCategoryKey = new Map<
      string,
      {
        cost_category_id: string;
        currency: string;
        planned_amount: number;
        actual_amount: number;
      }
    >();
    const byCurrencyKey = new Map<
      string,
      { currency: string; planned_amount: number; actual_amount: number }
    >();
    for (const row of (ownBudgetRows ?? []) as Array<{
      cost_category_id: string;
      currency: string;
      entry_type: 'planned' | 'actual';
      amount: number;
    }>) {
      const amount = Number(row.amount) || 0;
      const categoryKey = `${row.cost_category_id}|${row.currency}`;
      const categoryEntry = byCategoryKey.get(categoryKey) ?? {
        cost_category_id: row.cost_category_id,
        currency: row.currency,
        planned_amount: 0,
        actual_amount: 0,
      };
      if (row.entry_type === 'planned') categoryEntry.planned_amount += amount;
      else categoryEntry.actual_amount += amount;
      byCategoryKey.set(categoryKey, categoryEntry);

      const currencyEntry = byCurrencyKey.get(row.currency) ?? {
        currency: row.currency,
        planned_amount: 0,
        actual_amount: 0,
      };
      if (row.entry_type === 'planned') currencyEntry.planned_amount += amount;
      else currencyEntry.actual_amount += amount;
      byCurrencyKey.set(row.currency, currencyEntry);
    }

    return {
      task_id: taskId,
      own: {
        planned_budget: ownPlannedBudget,
        planned_hours: ownPlannedHours,
        headcount: ownHeadcount,
      },
      cumulative: {
        planned_budget: cumulativePlannedBudget,
        planned_hours: cumulativePlannedHours,
        headcount: cumulativeHeadcount,
      },
      has_sublevels: hasSublevels,
      allocations: allocations.map((a) => ({
        ...a,
        effective_planned_hours: hoursById.get(a.id) ?? 0,
      })),
      budget_by_category: [...byCategoryKey.values()],
      budget_by_currency: [...byCurrencyKey.values()],
    };
  }

  // ==========================================================================
  // Plan-level allocations
  // ==========================================================================

  /**
   * Lists all resource allocations for a plan (with access check).
   */
  async listPlanAllocations(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<PlanAllocRow[]> {
    // Fix 3: module must be enabled per-request
    await this.assertModuleEnabled(organizationId);

    const plan = await this.assertPlanInOrganization(planId, organizationId);

    await this.assertUserCanAccessPlan(
      userId,
      organizationId,
      planId,
      plan.space_id,
    );

    const { data, error } = await this.client
      .from(ResourcePlanningService.PLAN_ALLOC_TABLE)
      .select(`*, ${PLAN_ALLOC_USER_SELECT}`)
      .eq('plan_id', planId)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true });

    if (error) throw new InternalServerErrorException(error.message);

    return (data ?? []) as PlanAllocRow[];
  }

  /**
   * Creates a new plan resource allocation.
   */
  async createPlanAllocation(
    planId: string,
    organizationId: string,
    userId: string,
    dto: CreatePlanAllocationDto,
  ): Promise<PlanAllocRow> {
    // Fix 3: module must be enabled per-request
    await this.assertModuleEnabled(organizationId);

    const plan = await this.assertPlanInOrganization(planId, organizationId);

    await this.assertUserCanAccessPlan(
      userId,
      organizationId,
      planId,
      plan.space_id,
      'edit',
    );

    await this.assertOrganizationMember(organizationId, dto.user_id);
    validatePlanAllocationShape({
      allocation_mode: dto.allocation_mode ?? 'total_hours',
      planned_hours:
        dto.allocation_mode && dto.allocation_mode !== 'total_hours'
          ? (dto.planned_hours ?? 0)
          : dto.planned_hours,
      weekly_hours: dto.weekly_hours,
      capacity_percent: dto.capacity_percent,
      start_date: dto.start_date,
      end_date: dto.end_date,
    });

    const now = new Date().toISOString();
    const { data, error } = await this.client
      .from(ResourcePlanningService.PLAN_ALLOC_TABLE)
      .insert({
        organization_id: organizationId,
        plan_id: planId,
        user_id: dto.user_id,
        ...allocationModeInsert(dto),
        planned_budget: dto.planned_budget ?? 0,
        start_date: dto.start_date ?? null,
        end_date: dto.end_date ?? null,
        role: dto.role ?? null,
        notes: dto.notes ?? null,
        created_by: userId,
        updated_by: userId,
        created_at: now,
        updated_at: now,
      })
      .select(`*, ${PLAN_ALLOC_USER_SELECT}`)
      .single();

    if (error?.code === '23505') {
      throw new ConflictException(
        'This user already has an allocation for this plan',
      );
    }
    if (error) throw new BadRequestException(error.message);

    return data as PlanAllocRow;
  }

  /**
   * Updates a plan allocation by id.
   */
  async updatePlanAllocation(
    id: string,
    organizationId: string,
    userId: string,
    dto: UpdatePlanAllocationDto,
  ): Promise<PlanAllocRow> {
    // Fix 3: module must be enabled per-request
    await this.assertModuleEnabled(organizationId);

    const existing = await this.findPlanAllocationById(id, organizationId);

    // Fix 1: assert plan org-scoping AND space-access (mirrors createPlanAllocation)
    const plan = await this.assertPlanInOrganization(
      existing.plan_id,
      organizationId,
    );

    await this.assertUserCanAccessPlan(
      userId,
      organizationId,
      existing.plan_id,
      plan.space_id,
      'edit',
    );

    const mergedAllocation = { ...existing, ...dto };
    validatePlanAllocationShape(mergedAllocation);

    const patch: Record<string, unknown> = {
      updated_by: userId,
      updated_at: new Date().toISOString(),
    };

    if (dto.planned_budget !== undefined)
      patch.planned_budget = dto.planned_budget;
    if (dto.start_date !== undefined) patch.start_date = dto.start_date;
    if (dto.end_date !== undefined) patch.end_date = dto.end_date;
    applyAllocationModePatch(patch, dto, mergedAllocation.allocation_mode);
    if (dto.role !== undefined) patch.role = dto.role;
    if (dto.notes !== undefined) patch.notes = dto.notes;

    // Fix 4: defense-in-depth — scope write to organization_id as well as id
    const { data, error } = await this.client
      .from(ResourcePlanningService.PLAN_ALLOC_TABLE)
      .update(patch)
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select(`*, ${PLAN_ALLOC_USER_SELECT}`)
      .single();

    if (error) throw new BadRequestException(error.message);

    return data as PlanAllocRow;
  }

  /**
   * Deletes a plan allocation by id.
   */
  async deletePlanAllocation(
    id: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    // Fix 3: module must be enabled per-request
    await this.assertModuleEnabled(organizationId);

    const existing = await this.findPlanAllocationById(id, organizationId);

    // Fix 1: assert plan org-scoping AND space-access (mirrors createPlanAllocation)
    const plan = await this.assertPlanInOrganization(
      existing.plan_id,
      organizationId,
    );

    await this.assertUserCanAccessPlan(
      userId,
      organizationId,
      existing.plan_id,
      plan.space_id,
      'edit',
    );

    // Fix 4: defense-in-depth — scope delete to organization_id as well as id
    const { error } = await this.client
      .from(ResourcePlanningService.PLAN_ALLOC_TABLE)
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) throw new BadRequestException(error.message);
  }

  /**
   * Gets a plan-level resource summary: per-user planned hours/budget, capacity, utilization.
   */
  async getPlanSummary(
    planId: string,
    organizationId: string,
    userId: string,
  ): Promise<{
    plan_id: string;
    currency: string | null;
    employees: unknown[];
    totals: {
      planned_budget: number;
      planned_hours: number;
      headcount: number;
    };
    task_demand: unknown[];
  }> {
    // Fix 3: module must be enabled per-request
    await this.assertModuleEnabled(organizationId);

    const plan = await this.assertPlanInOrganization(planId, organizationId);

    await this.assertUserCanAccessPlan(
      userId,
      organizationId,
      planId,
      plan.space_id,
    );

    // Load plan allocations (all users)
    const { data: allocRows, error: allocErr } = await this.client
      .from(ResourcePlanningService.PLAN_ALLOC_TABLE)
      .select(`*, ${PLAN_ALLOC_USER_SELECT}`)
      .eq('plan_id', planId)
      .eq('organization_id', organizationId);

    if (allocErr) throw new InternalServerErrorException(allocErr.message);

    const allocs = (allocRows ?? []) as PlanAllocRow[];

    // Load capacities for all allocated users in one query
    const allocatedUserIds = [...new Set(allocs.map((a) => a.user_id))];
    const userDateRanges = new Map<string, { from: string; to: string }>();
    for (const a of allocs) {
      const from = a.start_date ?? plan.start_date;
      const to = a.end_date ?? plan.end_date;
      if (!from || !to) continue;
      const existing = userDateRanges.get(a.user_id);
      userDateRanges.set(a.user_id, {
        from: existing && existing.from < from ? existing.from : from,
        to: existing && existing.to > to ? existing.to : to,
      });
    }
    const [capacityMap, capacityPeriodMap, calendarMap] = await Promise.all([
      this.loadCapacityMap(organizationId, allocatedUserIds),
      this.loadCapacityPeriodMap(organizationId, allocatedUserIds),
      this.resolveCalendarsForUsers(organizationId, userDateRanges),
    ]);

    // Build employee lines
    const employees = allocs.map((a) => {
      const weeklyCapacity = capacityMap.get(a.user_id) ?? null;
      const capacityPeriods = capacityPeriodMap.get(a.user_id) ?? [];
      const calendar = calendarMap.get(a.user_id) ?? null;
      const plannedHours = getEffectivePlannedHours(
        a,
        weeklyCapacity,
        capacityPeriods,
        calendar,
      );

      const effectiveCapacity = getEffectiveCapacityHours(
        a.start_date ?? plan.start_date,
        a.end_date ?? plan.end_date,
        weeklyCapacity,
        capacityPeriods,
        calendar,
      );

      const utilization =
        effectiveCapacity != null && effectiveCapacity > 0
          ? plannedHours / effectiveCapacity
          : null;
      const overAllocated =
        effectiveCapacity != null && plannedHours > effectiveCapacity;

      return {
        user: a.user,
        planned_hours: plannedHours,
        effective_planned_hours: plannedHours,
        planned_budget: Number(a.planned_budget) || 0,
        capacity_hours: effectiveCapacity,
        utilization,
        over_allocated: overAllocated,
      };
    });

    // Totals
    const totalPlannedHours = employees.reduce(
      (s, e) => s + e.planned_hours,
      0,
    );
    const totalPlannedBudget = employees.reduce(
      (s, e) => s + e.planned_budget,
      0,
    );
    const headcount = new Set(allocs.map((a) => a.user_id)).size;

    // Task demand: per-user SUM(planned_hours) from task_resource_allocations across this plan's tasks
    const taskDemand = await this.getTaskDemandForPlan(planId, organizationId);

    return {
      plan_id: planId,
      currency: normalizeCurrencyKey(plan.currency),
      employees,
      totals: {
        planned_budget: totalPlannedBudget,
        planned_hours: totalPlannedHours,
        headcount,
      },
      task_demand: taskDemand,
    };
  }

  // ==========================================================================
  // Portfolio-level summary
  // ==========================================================================

  /**
   * Gets a portfolio-level resource summary across all accessible plans.
   */
  async getPortfolioSummary(
    portfolioId: string,
    organizationId: string,
    userId: string,
  ): Promise<{
    portfolio_id: string;
    employees: unknown[];
    budget_by_currency: { currency: string | null; planned_budget: number }[];
    totals: {
      planned_budget: number | null;
      planned_hours: number;
      headcount: number;
    };
    skipped_plan_count: number;
  }> {
    // Fix 3: module must be enabled per-request
    await this.assertModuleEnabled(organizationId);

    await this.assertPortfolioInOrganization(portfolioId, organizationId);

    // Get all plan IDs from the portfolio
    // Fix 5: include name, start_date, end_date in join to eliminate per-plan N+1 name query
    // Fix 6: start_date/end_date needed for duration-scaled capacity
    const { data: portfolioPlans, error: ppErr } = await this.client
      .from('portfolio_plans')
      .select(
        'plan_id, plan:plans!plan_id(id, organization_id, space_id, currency, name, start_date, end_date, is_archived)',
      )
      .eq('portfolio_id', portfolioId);

    if (ppErr) throw new InternalServerErrorException(ppErr.message);

    const planLinks = (portfolioPlans ?? []) as unknown as Array<{
      plan_id: string;
      plan: PlanRow | null;
    }>;

    // Filter to plans in this org; skip inaccessible ones
    let skippedPlanCount = 0;

    // Per-user aggregated data across plans
    const userPlanHours = new Map<string, number>();
    const userBudgetByCurrency = new Map<string, Map<string | null, number>>();
    const userAllocations = new Map<
      string,
      Array<{
        plan_id: string;
        plan_name: string;
        currency: string | null;
        plan_start_date: string | null;
        plan_end_date: string | null;
        allocation: PlanAllocRow;
      }>
    >();
    const userRef = new Map<string, unknown>();

    // Budget grouped by currency (never sum across currencies)
    const budgetByCurrencyMap = new Map<string | null, number>();

    // Process plans in chunks of 5 (matching portfolio KPI pattern)
    const accessiblePlans: Array<{ plan_id: string; plan: PlanRow }> = [];
    for (let i = 0; i < planLinks.length; i += 5) {
      const chunk = planLinks.slice(i, i + 5);
      const results = await Promise.all(
        chunk.map(async ({ plan_id, plan }) => {
          // Fix: archived plans are excluded from the portfolio summary by
          // default, matching resource-planning-report.engine.ts.
          if (
            !plan ||
            plan.organization_id !== organizationId ||
            plan.is_archived
          ) {
            skippedPlanCount++;
            return null;
          }

          try {
            const canAccess = await this.canExposePlan(
              plan_id,
              organizationId,
              userId,
              plan.space_id,
            );

            if (!canAccess) {
              skippedPlanCount++;
              return null;
            }

            return { plan_id, plan };
          } catch (error) {
            // Fix: an unexpected error checking one plan must not fail the whole portfolio.
            this.logger.warn(
              `getPortfolioSummary: skipping plan ${plan_id} in portfolio ${portfolioId} after access-check error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            skippedPlanCount++;
            return null;
          }
        }),
      );

      for (const result of results) {
        if (result) accessiblePlans.push(result);
      }
    }

    // Fix: one batched allocations query for all accessible plans instead of one per plan.
    const allocsByPlanId = new Map<string, PlanAllocRow[]>();
    if (accessiblePlans.length > 0) {
      const { data: allocs, error: aErr } = await this.client
        .from(ResourcePlanningService.PLAN_ALLOC_TABLE)
        .select(`*, ${PLAN_ALLOC_USER_SELECT}`)
        .in(
          'plan_id',
          accessiblePlans.map((p) => p.plan_id),
        )
        .eq('organization_id', organizationId);

      if (aErr) throw new InternalServerErrorException(aErr.message);

      for (const alloc of (allocs ?? []) as PlanAllocRow[]) {
        const list = allocsByPlanId.get(alloc.plan_id) ?? [];
        list.push(alloc);
        allocsByPlanId.set(alloc.plan_id, list);
      }
    }

    for (const { plan_id, plan } of accessiblePlans) {
      // Fix 5: use name from the join — no extra query needed
      const planName = plan.name ?? plan_id;
      const planCurrency = normalizeCurrencyKey(plan.currency);

      for (const alloc of allocsByPlanId.get(plan_id) ?? []) {
        const uid = alloc.user_id;
        const budget = Number(alloc.planned_budget) || 0;

        const currencyBudgets =
          userBudgetByCurrency.get(uid) ?? new Map<string | null, number>();
        currencyBudgets.set(
          planCurrency,
          (currencyBudgets.get(planCurrency) ?? 0) + budget,
        );
        userBudgetByCurrency.set(uid, currencyBudgets);

        if (!userRef.has(uid)) {
          userRef.set(uid, alloc.user);
        }

        const allocationsForUser = userAllocations.get(uid) ?? [];
        allocationsForUser.push({
          plan_id,
          plan_name: planName,
          currency: planCurrency,
          plan_start_date: plan.start_date,
          plan_end_date: plan.end_date,
          allocation: alloc,
        });
        userAllocations.set(uid, allocationsForUser);

        // Budget grouped by currency — NEVER sum across currencies
        const currentBudget = budgetByCurrencyMap.get(planCurrency) ?? 0;
        budgetByCurrencyMap.set(planCurrency, currentBudget + budget);
      }
    }

    // Load capacity for all involved users
    const allUserIds = [...userRef.keys()];
    const userDateRanges = new Map<string, { from: string; to: string }>();
    for (const uid of allUserIds) {
      for (const item of userAllocations.get(uid) ?? []) {
        const from = item.allocation.start_date ?? item.plan_start_date;
        const to = item.allocation.end_date ?? item.plan_end_date;
        if (!from || !to) continue;
        const existing = userDateRanges.get(uid);
        userDateRanges.set(uid, {
          from: existing && existing.from < from ? existing.from : from,
          to: existing && existing.to > to ? existing.to : to,
        });
      }
    }
    const [capacityMap, capacityPeriodMap, calendarMap] = await Promise.all([
      this.loadCapacityMap(organizationId, allUserIds),
      this.loadCapacityPeriodMap(organizationId, allUserIds),
      this.resolveCalendarsForUsers(organizationId, userDateRanges),
    ]);

    const userBreakdown = new Map<
      string,
      Array<{
        plan_id: string;
        plan_name: string;
        currency: string | null;
        planned_hours: number;
        planned_budget: number;
      }>
    >();
    for (const uid of allUserIds) {
      const weeklyCapacity = capacityMap.get(uid) ?? null;
      const capacityPeriods = capacityPeriodMap.get(uid) ?? [];
      const calendar = calendarMap.get(uid) ?? null;
      const breakdown = (userAllocations.get(uid) ?? []).map((item) => ({
        plan_id: item.plan_id,
        plan_name: item.plan_name,
        currency: item.currency,
        planned_hours: getEffectivePlannedHours(
          item.allocation,
          weeklyCapacity,
          capacityPeriods,
          calendar,
        ),
        planned_budget: Number(item.allocation.planned_budget) || 0,
      }));
      userBreakdown.set(uid, breakdown);
      userPlanHours.set(
        uid,
        breakdown.reduce((sum, item) => sum + item.planned_hours, 0),
      );
    }

    // Build final employee lines
    // Fix 6: capacity_hours = weekly_capacity * sum(planWeeks for plans with known dates)
    const employees = allUserIds.map((uid) => {
      const plannedHours = userPlanHours.get(uid) ?? 0;
      const weeklyCapacity = capacityMap.get(uid) ?? null;
      const capacityPeriods = capacityPeriodMap.get(uid) ?? [];
      const calendar = calendarMap.get(uid) ?? null;
      const budgetByCurrency = [
        ...(userBudgetByCurrency.get(uid) ?? new Map()).entries(),
      ].map(([currency, planned_budget]) => ({
        currency: currency as string | null,
        planned_budget: Number(planned_budget),
      }));
      const plannedBudget =
        budgetByCurrency.length <= 1
          ? (budgetByCurrency[0]?.planned_budget ?? 0)
          : null;

      const capacityIntervals = mergeEffectiveDateIntervals(
        (userAllocations.get(uid) ?? []).flatMap((item) => {
          const start = item.allocation.start_date ?? item.plan_start_date;
          const end = item.allocation.end_date ?? item.plan_end_date;
          return start && end ? [{ start, end }] : [];
        }),
      );
      const intervalCapacities = capacityIntervals.map((interval) =>
        getEffectiveCapacityHours(
          interval.start,
          interval.end,
          weeklyCapacity,
          capacityPeriods,
          calendar,
        ),
      );
      const effectiveCapacity =
        capacityIntervals.length === 0 ||
        intervalCapacities.some((capacity) => capacity == null)
          ? null
          : intervalCapacities.reduce<number>(
              (sum, capacity) => sum + (capacity ?? 0),
              0,
            );

      const utilization =
        effectiveCapacity != null && effectiveCapacity > 0
          ? plannedHours / effectiveCapacity
          : null;
      const overAllocated =
        effectiveCapacity != null && plannedHours > effectiveCapacity;

      return {
        user: userRef.get(uid),
        planned_hours: plannedHours,
        planned_budget: plannedBudget,
        budget_by_currency: budgetByCurrency,
        capacity_hours: effectiveCapacity,
        utilization,
        over_allocated: overAllocated,
        plan_breakdown: userBreakdown.get(uid) ?? [],
      };
    });

    // Totals
    const totalPlannedHours = employees.reduce(
      (s, e) => s + e.planned_hours,
      0,
    );
    const totalPlannedBudget =
      budgetByCurrencyMap.size <= 1
        ? ([...budgetByCurrencyMap.values()][0] ?? 0)
        : null;
    const headcount = employees.length;

    // budget_by_currency array
    const budgetByCurrency: {
      currency: string | null;
      planned_budget: number;
    }[] = [];
    for (const [currency, planned_budget] of budgetByCurrencyMap.entries()) {
      budgetByCurrency.push({ currency, planned_budget });
    }

    return {
      portfolio_id: portfolioId,
      employees,
      budget_by_currency: budgetByCurrency,
      totals: {
        planned_budget: totalPlannedBudget,
        planned_hours: totalPlannedHours,
        headcount,
      },
      skipped_plan_count: skippedPlanCount,
    };
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private async findTaskAllocationById(
    id: string,
    organizationId: string,
  ): Promise<TaskAllocRow> {
    const { data, error } = await this.client
      .from(ResourcePlanningService.TASK_ALLOC_TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Task allocation not found');

    return data as TaskAllocRow;
  }

  private async findPlanAllocationById(
    id: string,
    organizationId: string,
  ): Promise<PlanAllocRow> {
    const { data, error } = await this.client
      .from(ResourcePlanningService.PLAN_ALLOC_TABLE)
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Plan allocation not found');

    return data as PlanAllocRow;
  }

  private async listTaskAllocationsByIds(
    taskIds: string[],
    organizationId: string,
  ): Promise<TaskAllocRow[]> {
    if (taskIds.length === 0) return [];

    const rows: TaskAllocRow[] = [];
    for (const chunk of chunkArray(taskIds, IN_FILTER_CHUNK_SIZE)) {
      const { data, error } = await this.client
        .from(ResourcePlanningService.TASK_ALLOC_TABLE)
        .select(`*, ${TASK_ALLOC_USER_SELECT}`)
        .in('task_id', chunk)
        .eq('organization_id', organizationId);

      if (error) throw new InternalServerErrorException(error.message);

      rows.push(...((data ?? []) as TaskAllocRow[]));
    }

    return rows;
  }

  /**
   * Effective hours per task allocation, in input order. When every row is
   * total_hours (all legacy rows) the stored hours come back with no queries;
   * dated modes reuse getEffectivePlannedHours with the same capacity and
   * calendar inputs the plan summary uses.
   */
  private async effectiveTaskHours(
    organizationId: string,
    rows: TaskAllocRow[],
  ): Promise<number[]> {
    const isTotal = (row: TaskAllocRow) =>
      (row.allocation_mode ?? 'total_hours') === 'total_hours';
    if (rows.every(isTotal)) {
      return rows.map((row) => Number(row.planned_hours) || 0);
    }

    const dated = rows.filter((row) => !isTotal(row));
    const userIds = [...new Set(dated.map((row) => row.user_id))];
    const userDateRanges = new Map<string, { from: string; to: string }>();
    for (const row of dated) {
      if (!row.start_date || !row.end_date) continue;
      const existing = userDateRanges.get(row.user_id);
      userDateRanges.set(row.user_id, {
        from:
          existing && existing.from < row.start_date
            ? existing.from
            : row.start_date,
        to: existing && existing.to > row.end_date ? existing.to : row.end_date,
      });
    }
    const [capacityMap, capacityPeriodMap, calendarMap] = await Promise.all([
      this.loadCapacityMap(organizationId, userIds),
      this.loadCapacityPeriodMap(organizationId, userIds),
      this.resolveCalendarsForUsers(organizationId, userDateRanges),
    ]);

    return rows.map((row) =>
      getEffectivePlannedHours(
        row,
        capacityMap.get(row.user_id) ?? null,
        capacityPeriodMap.get(row.user_id) ?? [],
        calendarMap.get(row.user_id) ?? null,
      ),
    );
  }

  /**
   * Loads a map of user_id → weekly_capacity_hours for given user IDs.
   */
  private async loadCapacityMap(
    organizationId: string,
    userIds: string[],
  ): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();

    if (userIds.length === 0) return result;

    const { data, error } = await this.client
      .from(ResourcePlanningService.CAPACITY_TABLE)
      .select('user_id, weekly_capacity_hours')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .in('user_id', userIds);

    if (error) throw new InternalServerErrorException(error.message);

    for (const row of (data ?? []) as Array<{
      user_id: string;
      weekly_capacity_hours: number;
    }>) {
      result.set(row.user_id, row.weekly_capacity_hours);
    }

    return result;
  }

  private async loadCapacityPeriodMap(
    organizationId: string,
    userIds: string[],
  ): Promise<Map<string, CapacityPeriodSummaryRow[]>> {
    const result = new Map<string, CapacityPeriodSummaryRow[]>();
    if (userIds.length === 0) return result;

    const { data, error } = await this.client
      .from('employee_capacity_periods')
      .select('user_id, effective_from, effective_to, weekly_capacity_hours')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .in('user_id', userIds)
      .order('effective_from', { ascending: true });

    if (error) throw new InternalServerErrorException(error.message);
    for (const row of (data ?? []) as CapacityPeriodSummaryRow[]) {
      result.set(row.user_id, [...(result.get(row.user_id) ?? []), row]);
    }
    return result;
  }

  /**
   * Returns per-user task demand (SUM of planned_hours) from task_resource_allocations
   * across all tasks in a plan.
   */
  private async getTaskDemandForPlan(
    planId: string,
    organizationId: string,
  ): Promise<{ user: unknown; planned_hours: number }[]> {
    // Get task IDs for this plan via plan_tasks junction
    const { data: planTaskRows, error: ptErr } = await this.client
      .from('plan_tasks')
      .select('task_id')
      .eq('plan_id', planId);

    if (ptErr) throw new InternalServerErrorException(ptErr.message);

    const taskIds = ((planTaskRows ?? []) as Array<{ task_id: string }>).map(
      (r) => r.task_id,
    );

    if (taskIds.length === 0) return [];

    const { data: allocRows, error: aErr } = await this.client
      .from(ResourcePlanningService.TASK_ALLOC_TABLE)
      .select(`*, ${TASK_ALLOC_USER_SELECT}`)
      .in('task_id', taskIds)
      .eq('organization_id', organizationId);

    if (aErr) throw new InternalServerErrorException(aErr.message);

    // Aggregate per user
    const userHours = new Map<string, number>();
    const userRefMap = new Map<string, unknown>();
    const rows = (allocRows ?? []) as TaskAllocRow[];
    const effectiveHours = await this.effectiveTaskHours(organizationId, rows);

    for (const [i, row] of rows.entries()) {
      const uid = row.user_id;
      userHours.set(uid, (userHours.get(uid) ?? 0) + effectiveHours[i]);
      if (!userRefMap.has(uid)) {
        userRefMap.set(uid, row.user);
      }
    }

    return [...userHours.entries()].map(([uid, hours]) => ({
      user: userRefMap.get(uid),
      planned_hours: hours,
    }));
  }
}
