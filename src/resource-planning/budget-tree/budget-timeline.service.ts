/**
 * @fileoverview Ressource Tree month timeline (RP 2.0, time component) for one
 * root ticket. Uses the graph's access-checked, pruned tree
 * (BudgetTreeService.resolveScopedTree), loads dates, done state, planned
 * budget entries, allocations, capacity and working calendars, and hands them
 * to the pure budget-timeline.engine.
 * @module src/resource-planning/budget-tree/budget-timeline.service
 */

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { WorkingCalendarContext } from '../calendar/working-calendar.engine';
import { WorkingCalendarService } from '../calendar/working-calendar.service';
import { createCapacityResolver } from '../reporting/resource-planning-report.engine';
import type {
  ResourcePlanningReportCapacity,
  ResourcePlanningReportCapacityPeriod,
} from '../reporting/resource-planning-report.types';
import { inSpaceScope } from '../resource-planning.service';
import {
  addMonths,
  buildBudgetTimeline,
  createLocalDateReader,
  MAX_SPREAD_DAYS,
  MAX_TIMELINE_MONTHS,
  monthEnd,
  monthsBetween,
  type TimelineAllocation,
  type TimelineEntry,
  type TimelineTask,
  type TimelineWindow,
  windowDays,
} from './budget-timeline.engine';
import { BudgetTreeService } from './budget-tree.service';
import type {
  BudgetTimelineNode,
  BudgetTimelineResponse,
  BudgetTimelineUnscheduled,
} from './budget-tree.types';

const IN_FILTER_CHUNK_SIZE = 100;
const PAGE_SIZE = 1000;

export interface BudgetTimelineOptions {
  depth?: number;
  spaceId?: string;
  /** YYYY-MM. */
  from?: string;
  to?: string;
  /** IANA time zone; default UTC. */
  tz?: string;
}

interface TimelineTaskRow {
  id: string;
  start_date: string | null;
  due_date: string | null;
  end_date: string | null;
  completed_at: string | null;
  resolved_at: string | null;
  status_id: string | null;
  task_type_id: string | null;
}

interface PagedQuery {
  order: (column: string) => {
    range: (
      from: number,
      to: number,
    ) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string } | null;
    }>;
  };
}

/** Default: the current UTC month and the next 11. */
export function resolveMonthRange(
  from?: string,
  to?: string,
  now = new Date(),
): { from: string; to: string } {
  const start =
    from ??
    `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const end = to ?? addMonths(start, 11);
  if (start > end) {
    throw new BadRequestException('from must not be after to');
  }
  if (monthsBetween(start, end).length > MAX_TIMELINE_MONTHS) {
    throw new BadRequestException(
      `The timeline range cannot exceed ${MAX_TIMELINE_MONTHS} months`,
    );
  }
  return { from: start, to: end };
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

@Injectable()
export class BudgetTimelineService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly budgetTreeService: BudgetTreeService,
    private readonly workingCalendarService: WorkingCalendarService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getTimeline(
    taskId: string,
    organizationId: string,
    userId: string,
    options: BudgetTimelineOptions = {},
  ): Promise<BudgetTimelineResponse> {
    const { from, to } = resolveMonthRange(options.from, options.to);
    const timeZone = options.tz || 'UTC';
    const { spaceId } = options;
    const tree = await this.budgetTreeService.resolveScopedTree(
      taskId,
      organizationId,
      userId,
      options,
    );

    // Month figures roll up the whole visible subtree, not only the depth on
    // screen, with the graph's funding rule: a fixed space keeps its own
    // tickets, otherwise the viewer's space scope decides.
    const isVisible = (id: string) => {
      const childSpaceId = tree.detailById.get(id)?.space_id ?? null;
      return spaceId
        ? childSpaceId === spaceId
        : inSpaceScope(tree.scope, childSpaceId);
    };
    const subtreeIds = [taskId];
    const seen = new Set(subtreeIds);
    for (let index = 0; index < subtreeIds.length; index += 1) {
      for (const childId of tree.childrenByParentId.get(subtreeIds[index]) ??
        []) {
        if (seen.has(childId) || !isVisible(childId)) continue;
        seen.add(childId);
        subtreeIds.push(childId);
      }
    }

    const taskRows = await this.readAll<TimelineTaskRow>(subtreeIds, (chunk) =>
      this.client
        .from('tasks')
        .select(
          'id, start_date, due_date, end_date, completed_at, resolved_at, status_id, task_type_id',
        )
        .eq('organization_id', organizationId)
        .in('id', chunk),
    );
    const statusIds = [
      ...new Set(taskRows.map((row) => row.status_id).filter(Boolean)),
    ] as string[];
    const statuses = await this.readAll<{ id: string; is_completed: boolean }>(
      statusIds,
      (chunk) =>
        this.client
          .from('task_statuses')
          .select('id, is_completed')
          .in('id', chunk),
    );
    const doneStatusIds = new Set(
      statuses.filter((status) => status.is_completed).map((row) => row.id),
    );

    // Same filter as the graph's funding: manual planned entries with a category.
    const entries = (
      await this.readAll<TimelineEntry>(subtreeIds, (chunk) =>
        this.client
          .from('resource_budget_entries')
          .select('id, task_id, currency, amount, start_date, end_date')
          .eq('organization_id', organizationId)
          .eq('entry_type', 'planned')
          .eq('aggregation', 'manual')
          .in('task_id', chunk)
          .not('cost_category_id', 'is', null),
      )
    ).map((entry) => ({ ...entry, amount: Number(entry.amount) || 0 }));
    const allocations = (
      await this.readAll<TimelineAllocation>(subtreeIds, (chunk) =>
        this.client
          .from('task_resource_allocations')
          .select(
            'id, task_id, user_id, allocation_mode, planned_hours, weekly_hours, capacity_percent, start_date, end_date',
          )
          .eq('organization_id', organizationId)
          .in('task_id', chunk),
      )
    ).map((allocation) => ({
      ...allocation,
      allocation_mode: allocation.allocation_mode ?? 'total_hours',
      planned_hours: Number(allocation.planned_hours) || 0,
      weekly_hours: nullableNumber(allocation.weekly_hours),
      capacity_percent: nullableNumber(allocation.capacity_percent),
    }));

    const readDate = createLocalDateReader(timeZone);
    const rowById = new Map(taskRows.map((row) => [row.id, row]));
    const timelineTasks: TimelineTask[] = subtreeIds
      .filter((id) => rowById.has(id))
      .map((id) => {
        const row = rowById.get(id)!;
        const isDone = Boolean(
          row.status_id && doneStatusIds.has(row.status_id),
        );
        return {
          id,
          parent_task_id:
            id === taskId
              ? null
              : (tree.detailById.get(id)?.parent_task_id ?? null),
          planned_start: readDate(row.start_date),
          planned_end: readDate(row.end_date) ?? readDate(row.due_date),
          is_done: isDone,
          done_date: isDone
            ? (readDate(row.completed_at) ?? readDate(row.resolved_at))
            : null,
        };
      });
    const timelineTaskById = new Map(timelineTasks.map((row) => [row.id, row]));

    // The calendars must cover every day the engine walks: the range (weekly
    // modes) and every spreadable window. Longer windows skip the calendar.
    const span: TimelineWindow = { start: `${from}-01`, end: monthEnd(to) };
    const widen = (dates: (string | null)[]) => {
      const known = dates
        .filter((date): date is string => Boolean(date))
        .sort();
      if (known.length === 0) return;
      const window = { start: known[0], end: known[known.length - 1] };
      if (windowDays(window) > MAX_SPREAD_DAYS) return;
      if (window.start < span.start) span.start = window.start;
      if (window.end > span.end) span.end = window.end;
    };
    for (const row of [...entries, ...allocations]) {
      widen([row.start_date, row.end_date]);
    }
    for (const row of timelineTasks)
      widen([row.planned_start, row.planned_end]);

    const hasCalendar =
      await this.workingCalendarService.hasAnySchemeConfigured(organizationId);
    const budgetCalendar = hasCalendar
      ? await this.workingCalendarService.resolveCalendarContext(
          organizationId,
          null,
          span.start,
          span.end,
        )
      : null;
    const userCalendars = new Map<string, WorkingCalendarContext | null>();
    if (hasCalendar) {
      for (const allocationUserId of new Set(
        allocations.map((row) => row.user_id),
      )) {
        userCalendars.set(
          allocationUserId,
          await this.workingCalendarService.resolveCalendarContext(
            organizationId,
            allocationUserId,
            span.start,
            span.end,
          ),
        );
      }
    }

    let weeklyCapacity: (userId: string, day: string) => number = () => 0;
    const capacityUserIds = [
      ...new Set(
        allocations
          .filter((row) => row.allocation_mode === 'capacity_percent')
          .map((row) => row.user_id),
      ),
    ];
    if (capacityUserIds.length > 0) {
      const toCapacity = <T extends ResourcePlanningReportCapacity>(
        row: T,
      ): T => ({
        ...row,
        weekly_capacity_hours: Number(row.weekly_capacity_hours) || 0,
        cost_rate: nullableNumber(row.cost_rate),
      });
      const capacities = await this.readAll<ResourcePlanningReportCapacity>(
        capacityUserIds,
        (chunk) =>
          this.client
            .from('employee_capacity')
            .select(
              'id, user_id, weekly_capacity_hours, cost_rate, currency, is_active',
            )
            .eq('organization_id', organizationId)
            .in('user_id', chunk),
      );
      const periods = await this.readAll<ResourcePlanningReportCapacityPeriod>(
        capacityUserIds,
        (chunk) =>
          this.client
            .from('employee_capacity_periods')
            .select(
              'id, user_id, effective_from, effective_to, weekly_capacity_hours, cost_rate, currency, is_active',
            )
            .eq('organization_id', organizationId)
            .in('user_id', chunk),
      );
      const resolveCapacity = createCapacityResolver(
        capacities.map(toCapacity),
        periods.map(toCapacity),
      );
      weeklyCapacity = (capacityUserId, day) =>
        resolveCapacity(capacityUserId, day).weekly_capacity_hours;
    }

    const { months, byTask } = buildBudgetTimeline({
      tasks: timelineTasks,
      entries,
      allocations,
      from,
      to,
      budgetCalendar,
      calendarFor: (allocationUserId) =>
        userCalendars.get(allocationUserId) ?? null,
      weeklyCapacity,
    });

    const childIdsByParent = new Map<string, string[]>();
    for (const row of tree.included.values()) {
      if (!row.parent_task_id || !tree.included.has(row.parent_task_id)) {
        continue;
      }
      const list = childIdsByParent.get(row.parent_task_id) ?? [];
      list.push(row.id);
      childIdsByParent.set(row.parent_task_id, list);
    }
    const nodes: BudgetTimelineNode[] = [];
    const walk = (id: string) => {
      const row = tree.included.get(id)!;
      const task = timelineTaskById.get(id);
      const result = byTask.get(id);
      const childIds = childIdsByParent.get(id) ?? [];
      nodes.push({
        task_id: id,
        key: row.key,
        summary: row.summary,
        parent_task_id: row.parent_task_id,
        level: row.level,
        space_id: tree.spaceByTaskId.get(id) ?? null,
        task_type_id: rowById.get(id)?.task_type_id ?? null,
        is_done: task?.is_done ?? false,
        planned_start: task?.planned_start ?? null,
        planned_end: task?.planned_end ?? null,
        done_date: task?.done_date ?? null,
        bar: result?.bar ?? null,
        warnings: result?.warnings ?? [],
        has_plan: result?.has_plan ?? false,
        months: Object.fromEntries(result?.months ?? []),
        // Same rule as the graph's has_hidden_children.
        has_hidden_children:
          childIds.length === 0 &&
          (tree.childrenByParentId.get(id) ?? []).some(
            (childId) =>
              !spaceId || tree.detailById.get(childId)?.space_id === spaceId,
          ),
      });
      for (const childId of childIds) walk(childId);
    };
    walk(taskId);

    const unscheduled: BudgetTimelineUnscheduled[] = [];
    for (const id of subtreeIds) {
      const figures = byTask.get(id)?.unscheduled;
      if (!figures) continue;
      const detail = id === taskId ? tree.rootTask : tree.detailById.get(id);
      unscheduled.push({
        task_id: id,
        key: detail?.key ?? '',
        summary: detail?.summary ?? '',
        ...figures,
      });
    }

    return {
      root_task_id: taskId,
      from,
      to,
      months,
      timezone: timeZone,
      depth: tree.depth,
      truncated: tree.truncated,
      hidden_count: tree.hiddenCount,
      other_space_count: tree.otherSpaceCount,
      working_calendar: budgetCalendar !== null,
      nodes,
      unscheduled,
    };
  }

  /** Chunked `.in()` reads (URL length) with range paging (PostgREST row cap). */
  private async readAll<T>(
    ids: string[],
    build: (chunk: string[]) => PagedQuery,
  ): Promise<T[]> {
    const rows: T[] = [];
    for (let index = 0; index < ids.length; index += IN_FILTER_CHUNK_SIZE) {
      const chunk = ids.slice(index, index + IN_FILTER_CHUNK_SIZE);
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data, error } = await build(chunk)
          .order('id')
          .range(offset, offset + PAGE_SIZE - 1);
        if (error) throw new InternalServerErrorException(error.message);
        rows.push(...((data ?? []) as T[]));
        if ((data?.length ?? 0) < PAGE_SIZE) break;
      }
    }
    return rows;
  }
}
