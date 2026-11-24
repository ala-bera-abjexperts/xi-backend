/**
 * @fileoverview Resource Planning 2.0, Sub Task 2 -- per-user-per-day/week schedule feed for the
 * team & employee scheduling grid. Reuses the Phase 1 calendar engine and the report engine's pure
 * date-indexing helpers directly; the dataset-coupled proration formula is mirrored (not imported)
 * since the report engine's dataset loader is too heavyweight for this lean, high-frequency
 * endpoint -- see the file-level comment in resource-planning-report.engine.ts's
 * plannedHoursForDay/perDayFromWeekly for the formula this one deliberately mirrors.
 * @module src/resource-planning/schedule/schedule.service
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { WorkingCalendarService } from '../calendar/working-calendar.service';
import type { WorkingCalendarContext } from '../calendar/working-calendar.engine';
import {
  effectiveRowsAt,
  indexEffectiveRows,
  MAX_RANGE_DAYS,
} from '../reporting/resource-planning-report.engine';
import { assertEffectiveDateRange } from '../resource-planning.validation';
import {
  getEffectivePlannedHours,
  ResourcePlanningService,
  type SpaceScope,
} from '../resource-planning.service';
import { assertSpaceInScope, rowSpaceFilter } from '../space-scope.util';
import {
  SCHEDULE_MAX_DAY_GRANULARITY_DAYS,
  SCHEDULE_MAX_USERS,
} from './dto/schedule-query.dto';
import type {
  ScheduleAssignment,
  ScheduleBucket,
  ScheduleResponse,
  ScheduleUserRow,
} from './schedule.types';

const DAY_MS = 86_400_000;

/** Task-id page size for the portfolio/plan scope lookup -- keeps `.in()` URLs under the
 *  length a PostgREST request can carry. */
const TASK_ID_BATCH_SIZE = 500;

/** PostgREST caps a response at 1000 rows, so the fixed-space roster lookup pages at that size. */
const SPACE_ROSTER_PAGE_SIZE = 1_000;
/** Hard stop for that paging, per table -- see the ponytail note in loadSpaceAssignedUserIds. */
const SPACE_ROSTER_MAX_ROWS = 50_000;

export interface ScheduleQuery {
  from: string;
  to: string;
  granularity: 'day' | 'week' | 'month';
  unitIds?: string[];
  userIds?: string[];
  roles?: string[];
  /** Restrict to people working on this portfolio (XE-T437). */
  portfolioId?: string;
  /** Restrict to people working on these plans. Intersects with portfolioId. */
  planIds?: string[];
  /** Restrict to one space: people with an allocation there, and only those assignments. */
  spaceId?: string;
  /** Internal (Ressource Tree people row): also report each user's hours per bucket for these
   *  task ids in `task_hours`, from the same day loop as the buckets. The HTTP endpoint never sets it. */
  taskBreakdownIds?: ReadonlySet<string>;
  /** Internal: `userIds` come from org-scoped rows, not the client, so the org-member
   *  intersection is skipped and people who left or were deactivated keep their allocations. */
  trustedUserIds?: boolean;
}

interface MembershipRow {
  user_id: string;
  unit_id: string;
  effective_from: string;
  effective_to: string | null;
  allocation_percent: number | null;
}

interface CapacityPeriodRow {
  // Optional (not required) even though every real DB row has all three -- schedule.service.spec.ts
  // constructs CapacityPeriodRow fixtures without them, predating this response addition, and
  // there's no correctness reason to force every hours-only test to also stub id/cost_rate/currency.
  id?: string;
  user_id: string;
  effective_from: string;
  effective_to: string | null;
  weekly_capacity_hours: number;
  cost_rate?: number | null;
  currency?: string | null;
  is_active: boolean;
}

interface CapacityDefaultRow {
  user_id: string;
  weekly_capacity_hours: number;
  cost_rate?: number | null;
  currency?: string | null;
  is_active: boolean;
}

interface PlanAllocationRow {
  id: string;
  user_id: string;
  planned_hours: number;
  allocation_mode: 'total_hours' | 'hours_per_week' | 'capacity_percent';
  weekly_hours: number | null;
  capacity_percent: number | null;
  start_date: string | null;
  end_date: string | null;
  role: string | null;
  plans: PlanRelationRow | PlanRelationRow[] | null;
}

interface PlanRelationRow {
  name: string;
  start_date: string | null;
  end_date: string | null;
  space_id?: string | null;
}

// `status_id` is the source of truth for a task's status (see legacy-status.util.ts's own doc
// comment); the plain `tasks.status` column is a legacy bucket and is deliberately never selected
// here. `task_statuses` (status_id's FK target) carries the display name/color for the chip. A
// null/legacy status_id (no resolvable task_statuses row) yields task_statuses: null.
interface TaskRelationRow {
  summary: string;
  key: string;
  status_id: string | null;
  space_id?: string | null;
  task_statuses:
    | { name: string; color: string }
    | { name: string; color: string }[]
    | null;
}

interface TaskAllocationRow {
  id: string;
  task_id: string;
  user_id: string;
  planned_hours: number;
  allocation_mode: PlanAllocationRow['allocation_mode'];
  weekly_hours: number | null;
  capacity_percent: number | null;
  start_date: string | null;
  end_date: string | null;
  role: string | null;
  // `tasks` has no `title` column -- the human-readable field is `summary` (`key` is the ticket key).
  tasks: TaskRelationRow | TaskRelationRow[] | null;
}

interface UserRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  avatar_url: string | null;
}

// ---------------------------------------------------------------------------
// Pure UTC date-string helpers -- same convention as working-calendar.engine.ts:
// new Date(`${d}T00:00:00.000Z`), never local-time components.
// ---------------------------------------------------------------------------

function toUtcMs(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getTime();
}

function formatUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS) + 1;
}

function dateRange(from: string, to: string): string[] {
  const result: string[] = [];
  for (let ms = toUtcMs(from), end = toUtcMs(to); ms <= end; ms += DAY_MS) {
    result.push(formatUtcDate(ms));
  }
  return result;
}

/** Monday of the ISO week containing `day`, clamped to [from, to]. */
function weekBucketStart(day: string, from: string, to: string): string {
  const value = toUtcMs(day);
  const mondayOffset = (new Date(value).getUTCDay() + 6) % 7;
  const start = value - mondayOffset * DAY_MS;
  const clampedStart = Math.max(start, toUtcMs(from));
  return formatUtcDate(Math.min(clampedStart, toUtcMs(to)));
}

/** 1st of the calendar month containing `day`, clamped to [from, to]. Mirrors weekBucketStart's
 *  clamping shape so partial first/last buckets at the query boundary work the same way. */
function monthBucketStart(day: string, from: string, to: string): string {
  const value = new Date(toUtcMs(day));
  const start = Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1);
  const clampedStart = Math.max(start, toUtcMs(from));
  return formatUtcDate(Math.min(clampedStart, toUtcMs(to)));
}

function singleRelation<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function displayName(user: UserRow | undefined): string {
  if (!user) return 'Unknown';
  const name = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim();
  return name || user.email;
}

/**
 * Mirrors perDayFromWeekly in resource-planning-report.engine.ts:23. Duplicated rather than
 * imported: that function lives in a module whose exports are otherwise dataset-coupled, and this
 * is a 6-line pure formula -- importing it alone is not worth threading a dependency on the report
 * engine module through this lean endpoint. Keep the two in sync if either changes.
 */
function perDayFromWeekly(
  weeklyValue: number,
  day: string,
  calendar: WorkingCalendarContext | null,
): number {
  if (!calendar) return weeklyValue / 7;
  const hoursThatDay = calendar.dayHours.get(day) ?? 0;
  if (hoursThatDay <= 0) return 0;
  if (calendar.workingDaysPerWeek <= 0) return 0;
  return weeklyValue / calendar.workingDaysPerWeek;
}

/** Mirrors plannedHoursForDay in resource-planning-report.engine.ts:552 -- see perDayFromWeekly.
 *  Task allocations share the same mode columns, so they prorate through here too. */
function planAllocationHoursForDay(
  allocation: Pick<
    PlanAllocationRow,
    'allocation_mode' | 'planned_hours' | 'weekly_hours' | 'capacity_percent'
  >,
  windowDays: number,
  day: string,
  calendar: WorkingCalendarContext | null,
  weeklyCapacityHours: number,
): number {
  if (allocation.allocation_mode === 'hours_per_week') {
    return perDayFromWeekly(allocation.weekly_hours ?? 0, day, calendar);
  }
  if (allocation.allocation_mode === 'capacity_percent') {
    return (
      perDayFromWeekly(weeklyCapacityHours, day, calendar) *
      ((allocation.capacity_percent ?? 0) / 100)
    );
  }
  return allocation.planned_hours / windowDays;
}

@Injectable()
export class ScheduleService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly workingCalendar: WorkingCalendarService,
    private readonly orgModulesService: OrganizationModulesService,
    private readonly resourcePlanningService: ResourcePlanningService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Mirrors ResourcePlanningCoreService.assertModuleEnabled -- per-request, not cached. */
  private async assertModuleEnabled(organizationId: string): Promise<void> {
    const enabled = await this.orgModulesService.isEnabled(
      organizationId,
      'resource_planning',
    );
    if (!enabled) {
      throw new ForbiddenException('Resource Planning module is not enabled');
    }
  }

  async getSchedule(
    organizationId: string,
    query: ScheduleQuery,
    userId: string,
  ): Promise<ScheduleResponse> {
    await this.assertModuleEnabled(organizationId);
    assertEffectiveDateRange(query.from, query.to);
    const totalDays = daysBetween(query.from, query.to);

    if (totalDays > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `Range exceeds the ${MAX_RANGE_DAYS}-day maximum`,
      );
    }
    if (
      query.granularity === 'day' &&
      totalDays > SCHEDULE_MAX_DAY_GRANULARITY_DAYS
    ) {
      throw new BadRequestException(
        `Day granularity is limited to ${SCHEDULE_MAX_DAY_GRANULARITY_DAYS} days -- use week granularity for longer ranges`,
      );
    }

    // Fixed-space view: a space outside the caller's scope is refused before anyone is
    // resolved, and that scope is reused below instead of being resolved twice.
    let requestedScope: SpaceScope | undefined;
    if (query.spaceId) {
      requestedScope = await this.resourcePlanningService.resolveSpaceScope(
        organizationId,
        userId,
      );
      assertSpaceInScope(requestedScope, query.spaceId);
    }

    const { userIds, truncated } = await this.resolveUserIds(
      organizationId,
      query,
    );

    const range = {
      from: query.from,
      to: query.to,
      granularity: query.granularity,
    };

    if (userIds.length === 0) {
      return { range, truncated_users: truncated, users: [] };
    }

    const [
      users,
      memberships,
      capacityDefaults,
      capacityPeriods,
      planAllocations,
      taskAllocations,
      hasScheme,
      spaceScope,
    ] = await Promise.all([
      this.loadUsers(userIds),
      this.loadMemberships(organizationId, userIds),
      this.loadCapacityDefaults(organizationId, userIds),
      this.loadCapacityPeriods(organizationId, userIds),
      this.loadPlanAllocations(organizationId, userIds, query.from, query.to),
      this.loadTaskAllocations(organizationId, userIds, query.from, query.to),
      // Cheap org-wide fast path (see WorkingCalendarService.hasAnySchemeConfigured):
      // avoids two extra per-user queries each for every user when nothing is configured,
      // which is the universal case for every org verified so far this project.
      this.workingCalendar.hasAnySchemeConfigured(organizationId),
      requestedScope ??
        this.resourcePlanningService.resolveSpaceScope(organizationId, userId),
    ]);

    // Assignments only from spaces this user may see with the RP space module
    // on (plus null-space rows) -- or, with spaceId, only that space's rows;
    // capacity and memberships stay org-wide.
    const inScope = rowSpaceFilter(spaceScope, query.spaceId);
    const visiblePlanAllocations = planAllocations.filter((a) =>
      inScope(singleRelation(a.plans)?.space_id),
    );
    const visibleTaskAllocations = taskAllocations.filter((a) =>
      inScope(singleRelation(a.tasks)?.space_id),
    );

    const usersById = new Map(users.map((u) => [u.id, u]));
    const membershipsByUser = indexEffectiveRows(memberships);
    const capacityPeriodsByUser = indexEffectiveRows(
      capacityPeriods.filter((p) => p.is_active),
    );
    const capacityDefaultByUser = new Map(
      capacityDefaults.map((c) => [c.user_id, c]),
    );
    const planAllocationsByUser = groupBy(
      visiblePlanAllocations,
      (a) => a.user_id,
    );
    const taskAllocationsByUser = groupBy(
      visibleTaskAllocations,
      (a) => a.user_id,
    );

    const calendarByUser = new Map<string, WorkingCalendarContext | null>();
    if (hasScheme) {
      await Promise.all(
        userIds.map(async (userId) => {
          calendarByUser.set(
            userId,
            await this.workingCalendar.resolveCalendarContext(
              organizationId,
              userId,
              query.from,
              query.to,
            ),
          );
        }),
      );
    } else {
      for (const userId of userIds) calendarByUser.set(userId, null);
    }

    const days = dateRange(query.from, query.to);
    let rows: ScheduleUserRow[] = userIds.map((userId) =>
      this.buildUserRow(
        userId,
        usersById.get(userId),
        days,
        query,
        membershipsByUser.get(userId),
        capacityPeriodsByUser.get(userId),
        capacityDefaultByUser.get(userId),
        calendarByUser.get(userId) ?? null,
        planAllocationsByUser.get(userId) ?? [],
        taskAllocationsByUser.get(userId) ?? [],
      ),
    );

    // Same narrowing semantics as unit/user filters: a role filter (or a fixed space) that leaves
    // a user with no matching assignments drops that user's row entirely. No-op when neither
    // roles nor spaceId is passed.
    if ((query.roles && query.roles.length > 0) || query.spaceId) {
      rows = rows.filter((r) => r.assignments.length > 0);
    }

    return { range, truncated_users: truncated, users: rows };
  }

  private buildUserRow(
    userId: string,
    user: UserRow | undefined,
    days: string[],
    query: ScheduleQuery,
    memberships: MembershipRow[] | undefined,
    capacityPeriods: CapacityPeriodRow[] | undefined,
    capacityDefault: CapacityDefaultRow | undefined,
    calendar: WorkingCalendarContext | null,
    planAllocations: PlanAllocationRow[],
    taskAllocations: TaskAllocationRow[],
  ): ScheduleUserRow {
    // Grouping key for this row must reflect only units the employee actually belonged to
    // during the QUERIED range, not their full membership history -- `memberships` itself stays
    // un-dated (the day-loop below needs full history for correct per-day capacity scaling via
    // effectiveRowsAt), but unioning it unfiltered here means an employee still shows grouped
    // under a unit they left years ago. Same overlap predicate loadUnitMemberIds already uses
    // for the roster query below (effective_from <= to AND (effective_to is null OR >= from)).
    const unitIdSet = new Set<string>();
    for (const m of memberships ?? []) {
      const overlapsQueryRange =
        m.effective_from <= query.to &&
        (m.effective_to === null || m.effective_to >= query.from);
      if (overlapsQueryRange) unitIdSet.add(m.unit_id);
    }

    // Same overlap predicate as unitIdSet above, applied to capacity periods -- exposed as a
    // list, not resolved to one record, since the queried range can span more than one
    // non-overlapping period. Distinct from the day-loop's per-day effectiveRowsAt lookup below,
    // which still needs the full unfiltered `capacityPeriods` to compute correct daily hours.
    const capacityPeriodsInRange = (capacityPeriods ?? []).filter(
      (p) =>
        p.effective_from <= query.to &&
        (p.effective_to === null || p.effective_to >= query.from),
    );

    // Role filtering narrows what's shown (like unit/user filters), so it must run before the
    // bucket-accumulation loop and the assignments array are built -- not applied as a display
    // facet afterward. No-op (byte-for-byte identical) when query.roles is empty/undefined.
    const roleFilter =
      query.roles && query.roles.length > 0 ? new Set(query.roles) : null;
    const filteredPlanAllocations = roleFilter
      ? planAllocations.filter((a) => a.role != null && roleFilter.has(a.role))
      : planAllocations;
    const filteredTaskAllocations = roleFilter
      ? taskAllocations.filter((a) => a.role != null && roleFilter.has(a.role))
      : taskAllocations;

    const bucketMap = new Map<
      string,
      { capacity: number; capacityUnknown: boolean; planned: number }
    >();

    // Per-task share of the same per-day hours, only when asked (see ScheduleQuery.taskBreakdownIds).
    const taskHours = query.taskBreakdownIds
      ? new Map<string, Map<string, number>>()
      : null;

    const planAllocationsWithDates = filteredPlanAllocations
      .map((allocation) => {
        const plan = singleRelation(allocation.plans);
        const start = allocation.start_date ?? plan?.start_date ?? null;
        const end = allocation.end_date ?? plan?.end_date ?? null;
        return { allocation, start, end };
      })
      .filter(
        (
          a,
        ): a is { allocation: PlanAllocationRow; start: string; end: string } =>
          a.start !== null && a.end !== null && a.start <= a.end,
      );

    for (const day of days) {
      const bucketStart =
        query.granularity === 'day'
          ? day
          : query.granularity === 'month'
            ? monthBucketStart(day, query.from, query.to)
            : weekBucketStart(day, query.from, query.to);
      const bucket = bucketMap.get(bucketStart) ?? {
        capacity: 0,
        capacityUnknown: false,
        planned: 0,
      };

      const period = effectiveRowsAt(capacityPeriods, day).find(
        (p) => p.is_active,
      );
      const weeklyCapacityHours =
        period?.weekly_capacity_hours ??
        (capacityDefault?.is_active === false
          ? undefined
          : capacityDefault?.weekly_capacity_hours);

      let dayCapacity: number | null =
        weeklyCapacityHours === undefined
          ? null
          : perDayFromWeekly(weeklyCapacityHours, day, calendar);

      // allocation_percent scoping (confirmed decision, 12-phase-3-team-employee-planning.md
      // 3.4): when the grid is filtered to specific unit(s), a user's capacity contribution to
      // THAT filtered view is scaled by their allocation_percent on the matching membership(s)
      // effective that day, summed if they belong to more than one filtered unit at once
      // (deliberately unbounded past 100% -- over-commitment across teams is a real condition to
      // surface, not a validation error, same as everywhere else allocation_percent appears).
      // A user resolved into this response via a unit filter but not currently a member of any
      // filtered unit on this specific day (a join/leave boundary within the range) contributes 0
      // to that filtered view for that day, not their full capacity.
      if (dayCapacity !== null && query.unitIds && query.unitIds.length > 0) {
        const activeToday = effectiveRowsAt(memberships, day).filter((m) =>
          query.unitIds!.includes(m.unit_id),
        );
        const scale =
          activeToday.length === 0
            ? 0
            : activeToday.reduce(
                (sum, m) => sum + (m.allocation_percent ?? 100) / 100,
                0,
              );
        dayCapacity = dayCapacity * scale;
      }

      if (dayCapacity === null) {
        bucket.capacityUnknown = true;
      } else {
        bucket.capacity += dayCapacity;
      }

      const windowDaysFor = (start: string | null, end: string | null) =>
        start && end ? daysBetween(start, end) : 1;

      for (const { allocation, start, end } of planAllocationsWithDates) {
        if (day < start || day > end) continue;
        bucket.planned += planAllocationHoursForDay(
          allocation,
          windowDaysFor(start, end),
          day,
          calendar,
          weeklyCapacityHours ?? 0,
        );
      }

      for (const allocation of filteredTaskAllocations) {
        if (!allocation.start_date || !allocation.end_date) continue;
        if (day < allocation.start_date || day > allocation.end_date) continue;
        const hours = planAllocationHoursForDay(
          allocation,
          windowDaysFor(allocation.start_date, allocation.end_date),
          day,
          calendar,
          weeklyCapacityHours ?? 0,
        );
        bucket.planned += hours;
        if (taskHours && query.taskBreakdownIds!.has(allocation.task_id)) {
          const byBucket =
            taskHours.get(allocation.task_id) ?? new Map<string, number>();
          byBucket.set(bucketStart, (byBucket.get(bucketStart) ?? 0) + hours);
          taskHours.set(allocation.task_id, byBucket);
        }
      }

      bucketMap.set(bucketStart, bucket);
    }

    const buckets: ScheduleBucket[] = [...bucketMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket_start, value]) => ({
        bucket_start,
        capacity_hours: value.capacityUnknown ? null : round6(value.capacity),
        planned_hours: round6(value.planned),
        over_allocated:
          !value.capacityUnknown && value.planned > value.capacity,
      }));

    // Dated modes (hours/week, % of capacity) store planned_hours = 0, so their bar label is
    // the effective total -- the same number the task and plan views show.
    const activeCapacityPeriods = (capacityPeriods ?? []).filter(
      (p) => p.is_active !== false,
    );
    const defaultWeeklyCapacity =
      capacityDefault?.is_active === false
        ? null
        : (capacityDefault?.weekly_capacity_hours ?? null);
    const assignmentHours = (
      a: Pick<
        PlanAllocationRow,
        'allocation_mode' | 'planned_hours' | 'weekly_hours' | 'capacity_percent'
      >,
      start: string,
      end: string,
    ): number =>
      (a.allocation_mode ?? 'total_hours') === 'total_hours'
        ? a.planned_hours
        : round6(
            getEffectivePlannedHours(
              { ...a, start_date: start, end_date: end },
              defaultWeeklyCapacity,
              activeCapacityPeriods,
              calendar,
            ),
          );

    const assignments: ScheduleAssignment[] = [
      ...planAllocationsWithDates.map(
        ({ allocation: a, start, end }): ScheduleAssignment => ({
          source: 'plan',
          id: a.id,
          name: singleRelation(a.plans)?.name ?? 'Plan',
          start,
          end,
          hours: assignmentHours(a, start, end),
        }),
      ),
      ...filteredTaskAllocations
        .filter((a) => a.start_date && a.end_date)
        .map((a): ScheduleAssignment => {
          const task = singleRelation(a.tasks);
          const status = singleRelation(task?.task_statuses ?? null);
          return {
            source: 'task',
            id: a.id,
            name: task?.summary ?? 'Task',
            start: a.start_date!,
            end: a.end_date!,
            hours: assignmentHours(a, a.start_date!, a.end_date!),
            task_key: task?.key ?? undefined,
            task_status_name: status?.name ?? undefined,
            task_status_color: status?.color ?? undefined,
          };
        }),
    ];

    return {
      user_id: userId,
      display_name: displayName(user),
      avatar_url: user?.avatar_url ?? null,
      unit_ids: [...unitIdSet],
      buckets,
      assignments,
      default_capacity: capacityDefault
        ? {
            weekly_capacity_hours: capacityDefault.weekly_capacity_hours,
            cost_rate: capacityDefault.cost_rate ?? null,
            currency: capacityDefault.currency ?? null,
            is_active: capacityDefault.is_active,
          }
        : null,
      capacity_periods: capacityPeriodsInRange.map((p) => ({
        id: p.id ?? '',
        effective_from: p.effective_from,
        effective_to: p.effective_to,
        weekly_capacity_hours: p.weekly_capacity_hours,
        cost_rate: p.cost_rate ?? null,
        currency: p.currency ?? null,
        is_active: p.is_active,
      })),
      ...(taskHours && {
        task_hours: Object.fromEntries(
          [...taskHours].map(([taskId, byBucket]) => [
            taskId,
            Object.fromEntries(
              [...byBucket].map(([start, value]) => [start, round6(value)]),
            ),
          ]),
        ),
      }),
    };
  }

  private async resolveUserIds(
    organizationId: string,
    query: ScheduleQuery,
  ): Promise<{ userIds: string[]; truncated: boolean }> {
    let candidateIds: string[];

    // Fixed-space view: only people with an allocation in that space overlapping the range. The
    // default branch uses this list as-is; explicit user_ids/unit_ids are intersected with it.
    const spaceUserIds = query.spaceId
      ? await this.loadSpaceAssignedUserIds(
          organizationId,
          query.spaceId,
          query.from,
          query.to,
        )
      : null;

    if (query.userIds && query.userIds.length > 0) {
      if (query.unitIds && query.unitIds.length > 0) {
        const memberIds = await this.loadUnitMemberIds(
          organizationId,
          query.unitIds,
          query.from,
          query.to,
        );
        const memberSet = new Set(memberIds);
        candidateIds = query.userIds.filter((id) => memberSet.has(id));
      } else if (query.trustedUserIds) {
        candidateIds = query.userIds;
      } else {
        // Client-supplied user_ids with no unit filter to narrow them -- must still be
        // intersected against org membership, or a caller could read any user's identity
        // (loadUsers) and schedule data by id alone. Same organization_members table/pattern
        // as ResourcePlanningService.assertOrganizationMember, bulked via .in().
        const orgMemberIds = await this.loadOrgMemberIds(
          organizationId,
          query.userIds,
        );
        const memberSet = new Set(orgMemberIds);
        candidateIds = query.userIds.filter((id) => memberSet.has(id));
      }
    } else if (query.unitIds && query.unitIds.length > 0) {
      candidateIds = await this.loadUnitMemberIds(
        organizationId,
        query.unitIds,
        query.from,
        query.to,
      );
    } else {
      candidateIds =
        spaceUserIds ?? (await this.loadAllCapacityUserIds(organizationId));
    }

    if (spaceUserIds) {
      const spaceSet = new Set(spaceUserIds);
      candidateIds = candidateIds.filter((id) => spaceSet.has(id));
    }

    // XE-T437: portfolio/plan scope narrows whatever the branches above resolved -- it never
    // widens it. Returns null when no scope was asked for, which leaves the unscoped path
    // byte-identical to its previous behaviour.
    const scopedUserIds = await this.loadPlanScopedUserIds(
      organizationId,
      query,
    );

    if (scopedUserIds !== null) {
      const scopeSet = new Set(scopedUserIds);
      candidateIds = candidateIds.filter((id) => scopeSet.has(id));
    }

    const unique = [...new Set(candidateIds)];
    const truncated = unique.length > SCHEDULE_MAX_USERS;
    return { userIds: unique.slice(0, SCHEDULE_MAX_USERS), truncated };
  }

  /**
   * User ids working on the requested portfolio/plan scope, or null when no scope was
   * requested -- null means "do not filter" and is what keeps the existing unscoped
   * behaviour untouched.
   *
   * A person reaches a plan two ways: a direct plan allocation, or a task allocation on a
   * task that plan owns. Both count, matching how the report engine attributes work to a
   * plan. An empty array (portfolio exists but has no eligible plans) is NOT null -- it
   * correctly yields an empty schedule rather than the whole organization.
   */
  private async loadPlanScopedUserIds(
    organizationId: string,
    query: ScheduleQuery,
  ): Promise<string[] | null> {
    const requestedPlanIds = query.planIds ?? [];
    if (!query.portfolioId && requestedPlanIds.length === 0) return null;

    let planIds = requestedPlanIds;

    if (query.portfolioId) {
      // portfolio_plans carries no organization_id, so the portfolio itself is the tenant
      // check -- everything downstream derives from an id already proven to be in this org.
      const { data: portfolio, error: portfolioError } = await this.client
        .from('portfolios')
        .select('id')
        .eq('id', query.portfolioId)
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (portfolioError)
        throw new InternalServerErrorException(portfolioError.message);
      if (!portfolio) throw new NotFoundException('Portfolio not found');

      const { data: links, error: linksError } = await this.client
        .from('portfolio_plans')
        .select('plan_id')
        .eq('portfolio_id', query.portfolioId);
      if (linksError)
        throw new InternalServerErrorException(linksError.message);

      const linkedPlanIds = (links ?? []).map(
        (row: { plan_id: string }) => row.plan_id,
      );

      // Both filters given -> intersection, so plan_ids narrows the portfolio rather than
      // smuggling in plans that do not belong to it.
      planIds =
        requestedPlanIds.length > 0
          ? linkedPlanIds.filter((id) => requestedPlanIds.includes(id))
          : linkedPlanIds;
    }

    if (planIds.length === 0) return [];

    // Archived plans are excluded, matching getPortfolioSummary. `is not true` rather than
    // `= false` because plans.is_archived is nullable: getPortfolioSummary tests it in JS,
    // where NULL is falsy and the plan counts as live, and `.eq(false)` would silently
    // disagree. This is also the organization_id gate for a caller-supplied plan_ids list.
    const { data: plans, error: plansError } = await this.client
      .from('plans')
      .select('id')
      .eq('organization_id', organizationId)
      .in('id', planIds)
      .not('is_archived', 'is', true);
    if (plansError) throw new InternalServerErrorException(plansError.message);

    const scopedPlanIds = (plans ?? []).map((row: { id: string }) => row.id);
    if (scopedPlanIds.length === 0) return [];

    const { data: planAllocations, error: planAllocError } = await this.client
      .from('plan_resource_allocations')
      .select('user_id')
      .eq('organization_id', organizationId)
      .in('plan_id', scopedPlanIds);
    if (planAllocError)
      throw new InternalServerErrorException(planAllocError.message);

    const userIds = new Set(
      (planAllocations ?? []).map((row: { user_id: string }) => row.user_id),
    );

    const { data: planTasks, error: planTasksError } = await this.client
      .from('plan_tasks')
      .select('task_id')
      .in('plan_id', scopedPlanIds);
    if (planTasksError)
      throw new InternalServerErrorException(planTasksError.message);

    const taskIds = [
      ...new Set(
        (planTasks ?? []).map((row: { task_id: string }) => row.task_id),
      ),
    ];

    // Chunked: a plan can own thousands of tasks and a single .in() would build a URL long
    // enough to be rejected before it reaches Postgres.
    for (let i = 0; i < taskIds.length; i += TASK_ID_BATCH_SIZE) {
      const batch = taskIds.slice(i, i + TASK_ID_BATCH_SIZE);
      const { data: taskAllocations, error: taskAllocError } = await this.client
        .from('task_resource_allocations')
        .select('user_id')
        .eq('organization_id', organizationId)
        .in('task_id', batch);
      if (taskAllocError)
        throw new InternalServerErrorException(taskAllocError.message);
      for (const row of (taskAllocations ?? []) as { user_id: string }[]) {
        userIds.add(row.user_id);
      }
    }

    return [...userIds];
  }

  private async loadUnitMemberIds(
    organizationId: string,
    unitIds: string[],
    from: string,
    to: string,
  ): Promise<string[]> {
    const { data: activeUnits, error: activeUnitsError } = await this.client
      .from('organization_units')
      .select('id')
      .eq('organization_id', organizationId)
      .in('id', unitIds)
      .eq('is_active', true);
    if (activeUnitsError)
      throw new InternalServerErrorException(activeUnitsError.message);
    const activeUnitIds = (activeUnits ?? []).map((u: { id: string }) => u.id);
    if (activeUnitIds.length === 0) return [];

    const { data, error } = await this.client
      .from('organization_unit_memberships')
      .select(
        'user_id, users!organization_unit_memberships_user_id_fkey!inner(is_active)',
      )
      .eq('organization_id', organizationId)
      .in('unit_id', activeUnitIds)
      .lte('effective_from', to)
      .or(`effective_to.is.null,effective_to.gte.${from}`)
      .eq('users.is_active', true)
      .order('user_id', { ascending: true });
    if (error) throw new InternalServerErrorException(error.message);
    return ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
  }

  /** Intersects client-supplied user_ids against this org's organization_members rows. */
  private async loadOrgMemberIds(
    organizationId: string,
    userIds: string[],
  ): Promise<string[]> {
    const { data, error } = await this.client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', organizationId)
      .in('user_id', userIds);
    if (error) throw new InternalServerErrorException(error.message);
    return ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
  }

  private async loadAllCapacityUserIds(
    organizationId: string,
  ): Promise<string[]> {
    const { data, error } = await this.client
      .from('employee_capacity')
      .select('user_id, users!employee_capacity_user_id_fkey!inner(is_active)')
      .eq('organization_id', organizationId)
      .eq('is_active', true)
      .eq('users.is_active', true)
      .order('user_id', { ascending: true });
    if (error) throw new InternalServerErrorException(error.message);
    return ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
  }

  /**
   * Distinct user ids with a task or plan allocation in `spaceId` overlapping [from, to] -- the
   * same date filters as loadTaskAllocations/loadPlanAllocations, so the default fixed-space
   * roster is exactly the people those loaders return work for. Sorted like
   * loadAllCapacityUserIds so the SCHEDULE_MAX_USERS cut stays deterministic.
   */
  private async loadSpaceAssignedUserIds(
    organizationId: string,
    spaceId: string,
    from: string,
    to: string,
  ): Promise<string[]> {
    const pageLoaders = [
      (start: number, end: number) =>
        this.client
          .from('task_resource_allocations')
          .select('user_id, tasks!inner(space_id)')
          .eq('organization_id', organizationId)
          .eq('tasks.space_id', spaceId)
          .not('start_date', 'is', null)
          .not('end_date', 'is', null)
          .lte('start_date', to)
          .gte('end_date', from)
          .order('id', { ascending: true })
          .range(start, end),
      (start: number, end: number) =>
        this.client
          .from('plan_resource_allocations')
          .select(
            'user_id, plans!plan_resource_allocations_plan_id_fkey!inner(space_id)',
          )
          .eq('organization_id', organizationId)
          .eq('plans.space_id', spaceId)
          .or(
            `and(start_date.lte.${to},end_date.gte.${from}),start_date.is.null,end_date.is.null`,
          )
          .order('id', { ascending: true })
          .range(start, end),
    ];

    const userIds = new Set<string>();
    for (const loadPage of pageLoaders) {
      // ponytail: stops after SPACE_ROSTER_MAX_ROWS allocation rows per table, so a space with
      // more can miss people; swap for a distinct-user_id RPC if a space ever gets that big.
      for (
        let start = 0;
        start < SPACE_ROSTER_MAX_ROWS;
        start += SPACE_ROSTER_PAGE_SIZE
      ) {
        const { data, error } = await loadPage(
          start,
          start + SPACE_ROSTER_PAGE_SIZE - 1,
        );
        if (error) throw new InternalServerErrorException(error.message);
        const rows = (data ?? []) as { user_id: string }[];
        for (const row of rows) userIds.add(row.user_id);
        if (rows.length < SPACE_ROSTER_PAGE_SIZE) break;
      }
    }
    return [...userIds].sort();
  }

  private async loadUsers(userIds: string[]): Promise<UserRow[]> {
    // `users` has no `organization_id` column (org membership lives in
    // `organization_members`) -- safe without an org filter here because every caller of
    // this method only ever passes userIds already resolved through an org-scoped table
    // (employee_capacity, organization_unit_memberships, organization_members, or the
    // org-filtered plan/task allocations of a fixed space) in
    // resolveUserIds -- a client-supplied user_ids list is always intersected against one
    // of those there before reaching this method.
    const { data, error } = await this.client
      .from('users')
      .select('id, first_name, last_name, email, avatar_url')
      .in('id', userIds);
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as UserRow[];
  }

  private async loadMemberships(
    organizationId: string,
    userIds: string[],
  ): Promise<MembershipRow[]> {
    const { data: activeUnits, error: activeUnitsError } = await this.client
      .from('organization_units')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('is_active', true);
    if (activeUnitsError)
      throw new InternalServerErrorException(activeUnitsError.message);
    const activeUnitIds = (activeUnits ?? []).map((u: { id: string }) => u.id);
    if (activeUnitIds.length === 0) return [];

    const { data, error } = await this.client
      .from('organization_unit_memberships')
      .select(
        'user_id, unit_id, effective_from, effective_to, allocation_percent, users!organization_unit_memberships_user_id_fkey!inner(is_active)',
      )
      .eq('organization_id', organizationId)
      .in('user_id', userIds)
      .in('unit_id', activeUnitIds)
      .eq('users.is_active', true);
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as MembershipRow[];
  }

  private async loadCapacityDefaults(
    organizationId: string,
    userIds: string[],
  ): Promise<CapacityDefaultRow[]> {
    const { data, error } = await this.client
      .from('employee_capacity')
      .select('user_id, weekly_capacity_hours, cost_rate, currency, is_active')
      .eq('organization_id', organizationId)
      .in('user_id', userIds);
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as CapacityDefaultRow[];
  }

  private async loadCapacityPeriods(
    organizationId: string,
    userIds: string[],
  ): Promise<CapacityPeriodRow[]> {
    const { data, error } = await this.client
      .from('employee_capacity_periods')
      .select(
        'id, user_id, effective_from, effective_to, weekly_capacity_hours, cost_rate, currency, is_active',
      )
      .eq('organization_id', organizationId)
      .in('user_id', userIds);
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as CapacityPeriodRow[];
  }

  private async loadPlanAllocations(
    organizationId: string,
    userIds: string[],
    from: string,
    to: string,
  ): Promise<PlanAllocationRow[]> {
    const { data, error } = await this.client
      .from('plan_resource_allocations')
      .select(
        'id, user_id, planned_hours, allocation_mode, weekly_hours, capacity_percent, start_date, end_date, role, plans!plan_resource_allocations_plan_id_fkey(name, start_date, end_date, space_id)',
      )
      .eq('organization_id', organizationId)
      .in('user_id', userIds)
      .or(
        `and(start_date.lte.${to},end_date.gte.${from}),start_date.is.null,end_date.is.null`,
      );
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as unknown as PlanAllocationRow[];
  }

  private async loadTaskAllocations(
    organizationId: string,
    userIds: string[],
    from: string,
    to: string,
  ): Promise<TaskAllocationRow[]> {
    const { data, error } = await this.client
      .from('task_resource_allocations')
      .select(
        'id, task_id, user_id, planned_hours, allocation_mode, weekly_hours, capacity_percent, start_date, end_date, role, tasks(summary, key, status_id, space_id, task_statuses(name, color))',
      )
      .eq('organization_id', organizationId)
      .in('user_id', userIds)
      .not('start_date', 'is', null)
      .not('end_date', 'is', null)
      .lte('start_date', to)
      .gte('end_date', from);
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as unknown as TaskAllocationRow[];
  }

  async listDistinctRoles(organizationId: string): Promise<string[]> {
    await this.assertModuleEnabled(organizationId);
    const [plan, task] = await Promise.all([
      this.client
        .from('plan_resource_allocations')
        .select('role')
        .eq('organization_id', organizationId)
        .not('role', 'is', null),
      this.client
        .from('task_resource_allocations')
        .select('role')
        .eq('organization_id', organizationId)
        .not('role', 'is', null),
    ]);
    if (plan.error) throw new InternalServerErrorException(plan.error.message);
    if (task.error) throw new InternalServerErrorException(task.error.message);
    const set = new Set<string>();
    for (const row of [...(plan.data ?? []), ...(task.data ?? [])]) {
      if (row.role) set.add(row.role);
    }
    return [...set].sort();
  }
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const values = result.get(k) ?? [];
    values.push(item);
    result.set(k, values);
  }
  return result;
}

function round6(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e6) / 1e6;
}
