/**
 * @fileoverview People row of the Ressource Tree month timeline (RP 2.0): per
 * month, the people planned on the tree's shown tickets with hours per ticket,
 * actual hours, their total planned hours across all visible work, capacity and
 * the over-allocation flag. Hours and capacity come from ScheduleService's own
 * day loop (month buckets plus a per-ticket breakdown), so they match the
 * Schedule tab.
 * @module src/resource-planning/budget-tree/people/budget-timeline-people.service
 */

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { SCHEDULE_MAX_USERS } from '../../schedule/dto/schedule-query.dto';
import { ScheduleService } from '../../schedule/schedule.service';
import type { ScheduleUserRow } from '../../schedule/schedule.types';
import {
  createLocalDateReader,
  monthEnd,
  monthsBetween,
} from '../budget-timeline.engine';
import { resolveMonthRange } from '../budget-timeline.service';
import { BudgetTreeService, type TaskTreeRow } from '../budget-tree.service';

const IN_FILTER_CHUNK_SIZE = 100;
const PAGE_SIZE = 1000;
const DAY_MS = 86_400_000;

export interface BudgetTimelinePeopleOptions {
  /** Root tickets of the Ressource Tree selection. */
  taskIds: string[];
  depth?: number;
  spaceId?: string;
  /** YYYY-MM. */
  from?: string;
  to?: string;
  /** IANA time zone for done dates and logged time; default UTC. */
  tz?: string;
}

export interface BudgetTimelinePersonTask {
  task_id: string;
  key: string;
  summary: string;
  planned_hours: number;
  actual_hours: number;
}

export interface BudgetTimelinePerson {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  /** False for a deactivated user or one no longer in the organization. */
  is_active: boolean;
  /** On this tree's tickets. */
  planned_hours: number;
  actual_hours: number;
  /** The Schedule's month bucket: every allocation in spaces the viewer may see. */
  total_planned_hours: number;
  /** Null = no capacity configured. */
  capacity_hours: number | null;
  over_allocated: boolean;
  tasks: BudgetTimelinePersonTask[];
}

export interface BudgetTimelinePeopleMonth {
  month: string;
  planned_hours: number;
  people: BudgetTimelinePerson[];
}

export interface BudgetTimelinePeopleResponse {
  from: string;
  to: string;
  timezone: string;
  months: BudgetTimelinePeopleMonth[];
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

interface TaskDoneRow {
  id: string;
  status_id: string | null;
  completed_at: string | null;
  resolved_at: string | null;
}

interface TimeEntryRow {
  task_id: string;
  user_id: string;
  duration_minutes: number;
  logged_at: string;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

const shiftDay = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

@Injectable()
export class BudgetTimelinePeopleService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly budgetTreeService: BudgetTreeService,
    private readonly scheduleService: ScheduleService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  async getPeople(
    organizationId: string,
    userId: string,
    options: BudgetTimelinePeopleOptions,
  ): Promise<BudgetTimelinePeopleResponse> {
    const { from, to } = resolveMonthRange(options.from, options.to);
    const timeZone = options.tz || 'UTC';
    const months = monthsBetween(from, to);
    const rangeStart = `${from}-01`;
    const rangeEnd = monthEnd(to);

    // The shown tickets: each root's access-checked, pruned, depth-limited
    // tree, exactly what the graph and the timeline rows show.
    const trees = await Promise.all(
      [...new Set(options.taskIds)].map((rootId) =>
        this.budgetTreeService.resolveScopedTree(
          rootId,
          organizationId,
          userId,
          { depth: options.depth, spaceId: options.spaceId },
        ),
      ),
    );
    const taskById = new Map<string, TaskTreeRow>();
    for (const tree of trees) {
      for (const [id, row] of tree.included) taskById.set(id, row);
    }
    const taskIds = [...taskById.keys()];

    const planned = await this.readAll<{ user_id: string }>(taskIds, (chunk) =>
      this.client
        .from('task_resource_allocations')
        .select('id, user_id')
        .eq('organization_id', organizationId)
        .in('task_id', chunk)
        .not('start_date', 'is', null)
        .not('end_date', 'is', null)
        .lte('start_date', rangeEnd)
        .gte('end_date', rangeStart),
    );
    const userIds = [...new Set(planned.map((row) => row.user_id))];
    const peopleByMonth = new Map<string, BudgetTimelinePerson[]>(
      months.map((month) => [month, []]),
    );

    if (userIds.length > 0) {
      const breakdown = new Set(taskIds);
      const rows: ScheduleUserRow[] = [];
      for (let index = 0; index < userIds.length; index += SCHEDULE_MAX_USERS) {
        const schedule = await this.scheduleService.getSchedule(
          organizationId,
          {
            from: rangeStart,
            to: rangeEnd,
            granularity: 'month',
            userIds: userIds.slice(index, index + SCHEDULE_MAX_USERS),
            // No spaceId: capacity % counts all the person's visible work.
            taskBreakdownIds: breakdown,
            trustedUserIds: true,
          },
          userId,
        );
        rows.push(...schedule.users);
      }

      const [cutoffMonth, activeUserIds, actualHours] = await Promise.all([
        this.loadCutoffMonths(organizationId, taskById, timeZone),
        this.loadActiveMemberIds(organizationId, userIds),
        this.loadActualHours(
          organizationId,
          taskIds,
          userIds,
          rangeStart,
          rangeEnd,
          timeZone,
        ),
      ]);

      for (const row of rows) {
        const plannedByMonth = new Map<string, Map<string, number>>();
        for (const [taskId, byBucket] of Object.entries(row.task_hours ?? {})) {
          const cutoff = cutoffMonth.get(taskId);
          for (const [bucketStart, hours] of Object.entries(byBucket)) {
            const month = bucketStart.slice(0, 7);
            if (hours <= 0 || (cutoff && month > cutoff)) continue;
            const byTask =
              plannedByMonth.get(month) ?? new Map<string, number>();
            byTask.set(taskId, (byTask.get(taskId) ?? 0) + hours);
            plannedByMonth.set(month, byTask);
          }
        }

        const bucketByMonth = new Map(
          row.buckets.map((bucket) => [
            bucket.bucket_start.slice(0, 7),
            bucket,
          ]),
        );
        for (const [month, byTask] of plannedByMonth) {
          const people = peopleByMonth.get(month);
          if (!people) continue;
          const actualByTask =
            actualHours.get(row.user_id)?.get(month) ??
            new Map<string, number>();
          const tasks = [...new Set([...byTask.keys(), ...actualByTask.keys()])]
            .map((taskId) => ({
              task_id: taskId,
              key: taskById.get(taskId)?.key ?? '',
              summary: taskById.get(taskId)?.summary ?? '',
              planned_hours: round2(byTask.get(taskId) ?? 0),
              actual_hours: round2(actualByTask.get(taskId) ?? 0),
            }))
            .sort(
              (a, b) =>
                b.planned_hours - a.planned_hours ||
                a.key.localeCompare(b.key, undefined, { numeric: true }),
            );
          const bucket = bucketByMonth.get(month);
          people.push({
            user_id: row.user_id,
            display_name: row.display_name,
            avatar_url: row.avatar_url,
            is_active: activeUserIds.has(row.user_id),
            planned_hours: round2(sum(byTask.values())),
            actual_hours: round2(sum(actualByTask.values())),
            total_planned_hours: round2(bucket?.planned_hours ?? 0),
            capacity_hours:
              bucket?.capacity_hours == null
                ? null
                : round2(bucket.capacity_hours),
            over_allocated: bucket?.over_allocated ?? false,
            tasks,
          });
        }
      }
    }

    return {
      from,
      to,
      timezone: timeZone,
      months: months.map((month) => {
        const people = peopleByMonth
          .get(month)!
          .filter((person) => person.planned_hours > 0)
          .sort(
            (a, b) =>
              b.planned_hours - a.planned_hours ||
              a.display_name.localeCompare(b.display_name),
          );
        return {
          month,
          planned_hours: round2(
            sum(people.map((person) => person.planned_hours)),
          ),
          people,
        };
      }),
    };
  }

  /**
   * Last month a ticket may carry hours: the timeline's rule (done =
   * task_statuses.is_completed, done date = completed_at ?? resolved_at in the
   * viewer's time zone), and a done ancestor cuts its descendants. Done without
   * a date: no cutoff.
   */
  private async loadCutoffMonths(
    organizationId: string,
    taskById: Map<string, TaskTreeRow>,
    timeZone: string,
  ): Promise<Map<string, string>> {
    const rows = await this.readAll<TaskDoneRow>(
      [...taskById.keys()],
      (chunk) =>
        this.client
          .from('tasks')
          .select('id, status_id, completed_at, resolved_at')
          .eq('organization_id', organizationId)
          .in('id', chunk),
    );
    const statusIds = [
      ...new Set(rows.map((row) => row.status_id).filter(Boolean)),
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
    const readDate = createLocalDateReader(timeZone);
    const ownDoneMonth = new Map<string, string>();
    for (const row of rows) {
      if (!row.status_id || !doneStatusIds.has(row.status_id)) continue;
      const doneDate = readDate(row.completed_at) ?? readDate(row.resolved_at);
      if (doneDate) ownDoneMonth.set(row.id, doneDate.slice(0, 7));
    }

    // `included` is in level order, so a parent's cutoff exists before its children.
    const cutoff = new Map<string, string>();
    for (const [id, row] of taskById) {
      const candidates = [
        row.parent_task_id ? cutoff.get(row.parent_task_id) : undefined,
        ownDoneMonth.get(id),
      ].filter((month): month is string => Boolean(month));
      if (candidates.length > 0) cutoff.set(id, candidates.sort()[0]);
    }
    return cutoff;
  }

  /** Active users still in the organization. The ids come from org-scoped allocation rows. */
  private async loadActiveMemberIds(
    organizationId: string,
    userIds: string[],
  ): Promise<Set<string>> {
    const [users, members] = await Promise.all([
      this.readAll<{ id: string; is_active: boolean | null }>(
        userIds,
        (chunk) =>
          this.client.from('users').select('id, is_active').in('id', chunk),
      ),
      this.readAll<{ user_id: string }>(userIds, (chunk) =>
        this.client
          .from('organization_members')
          .select('id, user_id')
          .eq('organization_id', organizationId)
          .in('user_id', chunk),
      ),
    ]);
    const memberIds = new Set(members.map((row) => row.user_id));
    return new Set(
      users
        .filter((row) => row.is_active !== false && memberIds.has(row.id))
        .map((row) => row.id),
    );
  }

  /** user -> month -> ticket -> hours logged on these tickets, months in the viewer's time zone. */
  private async loadActualHours(
    organizationId: string,
    taskIds: string[],
    userIds: string[],
    rangeStart: string,
    rangeEnd: string,
    timeZone: string,
  ): Promise<Map<string, Map<string, Map<string, number>>>> {
    // A day of slack on both sides covers any time zone offset; the local month decides.
    const entries = await this.readAll<TimeEntryRow>(taskIds, (chunk) =>
      this.client
        .from('time_entries')
        .select('id, task_id, user_id, duration_minutes, logged_at')
        .eq('organization_id', organizationId)
        .in('task_id', chunk)
        .gte('logged_at', `${shiftDay(rangeStart, -1)}T00:00:00.000Z`)
        .lte('logged_at', `${shiftDay(rangeEnd, 1)}T23:59:59.999Z`),
    );
    const people = new Set(userIds);
    const readDate = createLocalDateReader(timeZone);
    const firstMonth = rangeStart.slice(0, 7);
    const lastMonth = rangeEnd.slice(0, 7);
    const result = new Map<string, Map<string, Map<string, number>>>();
    for (const entry of entries) {
      const month = readDate(entry.logged_at)?.slice(0, 7);
      if (!month || month < firstMonth || month > lastMonth) continue;
      if (!people.has(entry.user_id)) continue;
      const byMonth =
        result.get(entry.user_id) ?? new Map<string, Map<string, number>>();
      const byTask = byMonth.get(month) ?? new Map<string, number>();
      byTask.set(
        entry.task_id,
        (byTask.get(entry.task_id) ?? 0) +
          (Number(entry.duration_minutes) || 0) / 60,
      );
      byMonth.set(month, byTask);
      result.set(entry.user_id, byMonth);
    }
    return result;
  }

  /** Chunked `.in()` reads (URL length) with range paging (PostgREST row cap),
   *  same as BudgetTimelineService. */
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

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
