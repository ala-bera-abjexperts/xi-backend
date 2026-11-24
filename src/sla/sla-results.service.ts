import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { SlaAccessService } from './sla-access.service';
import { SlaCycle, projectCycle } from './sla-engine';
import { businessMilliseconds } from './sla-clock';
import type { RequestUser } from '../auth/interfaces/request-user.interface';

@Injectable()
export class SlaResultsService {
  constructor(
    private readonly db: SupabaseAdminService,
    private readonly access: SlaAccessService,
  ) {}
  async task(user: RequestUser, taskId: string) {
    const task = await this.access.authorizeTask(user, taskId);
    const client = this.db.getClient();
    const metrics = await client
      .from('sla_metrics')
      .select('id,field_id,custom_fields(name)')
      .eq('space_id', task.space_id)
      .eq('organization_id', task.organization_id);
    if (metrics.error)
      throw new ServiceUnavailableException('SLA results unavailable');
    const stream = await client
      .from('sla_task_streams')
      .select('processing_error,sequence,processed_sequence')
      .eq('task_id', taskId)
      .maybeSingle();
    if (stream.error)
      throw new ServiceUnavailableException('SLA results unavailable');
    const now = Date.now();
    const results = await Promise.all(
      this.ordered(metrics.data ?? []).map(async (metric) => {
        const rows = await client
          .from('sla_cycles')
          .select('*')
          .eq('task_id', taskId)
          .eq('metric_id', metric.id)
          .order('cycle_number', { ascending: false })
          .limit(1);
        if (rows.error)
          throw new ServiceUnavailableException('SLA results unavailable');
        const raw = rows.data?.[0] as SlaCycle | undefined;
        const pending =
          stream.data &&
          Number(stream.data.processed_sequence) < Number(stream.data.sequence);
        const cycle = raw
          ? projectCycle(raw, pending ? Date.parse(raw.updated_at) : now)
          : undefined;
        const error =
          stream.data?.processing_error ?? cycle?.state.error ?? null;
        return { metric, cycle, error, pending: !!pending };
      }),
    );
    const names = await this.calendarNames(
      results.flatMap((result) => (result.cycle ? [result.cycle] : [])),
    );
    return results.map((result) =>
      this.present(
        result.metric,
        result.cycle,
        result.error,
        result.pending,
        now,
        names,
      ),
    );
  }
  private calendarRevision(cycle: SlaCycle): string | undefined {
    return cycle.state.terms?.config.goals.find(
      (goal) => goal.id === cycle.state.goal_id,
    )?.calendar_revision_id;
  }
  private async calendarNames(
    cycles: SlaCycle[],
  ): Promise<Record<string, string>> {
    const ids = [
      ...new Set(
        cycles
          .map((cycle) => this.calendarRevision(cycle))
          .filter((id): id is string => !!id),
      ),
    ];
    if (!ids.length) return {};
    const { data, error } = await this.db
      .getClient()
      .from('sla_calendar_revisions')
      .select(
        'id,sla_calendars!sla_calendar_revisions_calendar_id_organization_id_space_i_fkey(name)',
      )
      .in('id', ids);
    if (error)
      throw new ServiceUnavailableException('SLA calendar names unavailable');
    return Object.fromEntries(
      (data ?? []).flatMap((row) => {
        const relation = row.sla_calendars as unknown as
          | { name: string }
          | { name: string }[]
          | null;
        const name = Array.isArray(relation)
          ? relation[0]?.name
          : relation?.name;
        return name ? [[row.id, name]] : [];
      }),
    );
  }
  /** The embedded custom field arrives as an object or a single-element array. */
  private metricName(metric: { custom_fields?: unknown }): string {
    const field = metric.custom_fields as
      | { name: string }
      | { name: string }[]
      | null;

    return (Array.isArray(field) ? field[0]?.name : field?.name) ?? 'SLA';
  }

  /**
   * `sla_metrics` has no sort column, and PostgREST leaves row order unspecified,
   * so consumers were free to reshuffle between polls. Callers render these in
   * order — the task sidebar and the cycle-history tab both do — so fix the order
   * here, by the name the reader actually sees, with the id as a stable tiebreak.
   */
  private ordered<T extends { id: string; custom_fields?: unknown }>(
    metrics: T[],
  ): T[] {
    return [...metrics].sort(
      (a, b) =>
        this.metricName(a).localeCompare(this.metricName(b)) ||
        a.id.localeCompare(b.id),
    );
  }

  private present(
    metric: { id: string; field_id: string; custom_fields?: unknown },
    cycle: SlaCycle | undefined,
    error: string | null,
    pending: boolean,
    now: number,
    calendarNames: Record<string, string> = {},
  ) {
    const field_name = this.metricName(metric);
    const lifecycle =
      cycle?.lifecycle === 'active'
        ? cycle.state.paused
          ? 'paused'
          : 'running'
        : (cycle?.lifecycle ?? 'not_applicable');
    return {
      field_id: metric.field_id,
      field_name,
      metric_id: metric.id,
      cycle_id: cycle?.id ?? null,
      cycle_number: cycle?.cycle_number ?? null,
      lifecycle: error
        ? 'invalid'
        : cycle?.state.not_applicable_reason === 'request_unlinked'
          ? 'not_applicable'
          : lifecycle,
      outcome: cycle?.outcome ?? 'pending',
      target_ms: cycle?.target_ms ?? null,
      elapsed_ms: cycle?.elapsed_ms ?? 0,
      remaining_ms: cycle ? cycle.target_ms - cycle.elapsed_ms : null,
      deadline_at: cycle?.deadline_at ?? null,
      timezone: cycle?.state.calendar?.timezone ?? null,
      calendar_name: cycle
        ? (calendarNames[this.calendarRevision(cycle) ?? ''] ?? null)
        : null,
      paused: cycle?.state.paused ?? false,
      evaluated_at: cycle?.updated_at ?? new Date(now).toISOString(),
      outside_working_hours: cycle?.state.calendar
        ? businessMilliseconds(cycle.state.calendar, now, now + 1) === 0
        : false,
      started_at: cycle?.started_at ?? null,
      completed_at: cycle?.completed_at ?? null,
      error,
      pending,
      deadline_pending: cycle?.state.deadline_pending ?? false,
    };
  }
  async history(user: RequestUser, taskId: string) {
    const task = await this.access.authorizeTask(user, taskId);
    const metrics = await this.db
      .getClient()
      .from('sla_metrics')
      .select('id,field_id,custom_fields(name)')
      .eq('space_id', task.space_id)
      .eq('organization_id', task.organization_id);
    if (metrics.error)
      throw new ServiceUnavailableException('SLA history unavailable');
    let cycles: SlaCycle[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.db
        .getClient()
        .from('sla_cycles')
        .select('*')
        .eq('task_id', taskId)
        .eq('space_id', task.space_id)
        .order('metric_id')
        .order('cycle_number')
        .range(offset, offset + 499);
      if (page.error)
        throw new ServiceUnavailableException('SLA history unavailable');
      cycles = [...cycles, ...((page.data ?? []) as SlaCycle[])];
      if ((page.data?.length ?? 0) < 500) break;
    }
    const names = await this.calendarNames(cycles);
    return cycles.flatMap((cycle) => {
      const metric = metrics.data?.find((m) => m.id === cycle.metric_id);
      return metric
        ? [
            this.present(
              metric,
              cycle,
              cycle.state.error,
              false,
              Date.now(),
              names,
            ),
          ]
        : [];
    });
  }
  async batch(user: RequestUser, taskIds: string[]) {
    const pairs = await Promise.all(
      [...new Set(taskIds)].map(
        async (id) => [id, await this.task(user, id)] as const,
      ),
    );
    return Object.fromEntries(pairs);
  }
}
