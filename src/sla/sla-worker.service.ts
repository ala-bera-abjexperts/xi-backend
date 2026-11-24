import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  projectCycle,
  invalidateCycle,
  referencedCustomFields,
  reduceSlaEvent,
  SlaCycle,
  SlaMetricTerms,
  SlaConfig,
} from './sla-engine';
import type { SlaCalendar } from './sla.types';

@Injectable()
export class SlaWorkerService {
  private readonly logger = new Logger(SlaWorkerService.name);
  constructor(private readonly db: SupabaseAdminService) {}
  private get client() {
    return this.db.getClient();
  }
  // In-process overlap guard: a tick over 50 streams can outlast the 15 s schedule. The commit is
  // already fenced by lease_token; this just stops a second tick stacking on the first.
  private ticking = false;
  @Cron('*/15 * * * * *')
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
    } finally {
      this.ticking = false;
    }
  }
  private async tickOnce(): Promise<void> {
    const recovery = await this.client.rpc('sla_recover_workflows');
    if (recovery.error)
      this.logger.error(
        `SLA workflow recovery failed: ${recovery.error.message}`,
      );
    const activation = await this.client
      .from('sla_metrics')
      .select('id')
      .eq('enabled', true)
      .eq('activation_complete', false)
      .limit(20);
    if (activation.error)
      this.logger.error(
        `SLA activation lookup failed: ${activation.error.message}`,
      );
    for (const metric of activation.data ?? []) {
      const result = await this.client.rpc('sla_resume_metric_activation', {
        p_metric_id: metric.id,
        p_batch_size: 500,
      });
      if (result.error)
        this.logger.error(`SLA activation failed: ${result.error.message}`);
    }
    const claimed = await this.client.rpc('sla_claim_streams', {
      p_limit: 50,
      p_lease_seconds: 120,
    });
    if (claimed.error) {
      this.logger.error(`SLA claim failed: ${claimed.error.message}`);
      return;
    }
    for (const stream of claimed.data ?? []) {
      try {
        await this.processStream(stream);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'SLA evaluation failed';
        this.logger.error(`SLA stream ${stream.task_id}: ${message}`);
        const saved = await this.client
          .from('sla_task_streams')
          .update({
            processing_error: message.slice(0, 500),
            lease_until: null,
            lease_token: null,
          })
          .eq('task_id', stream.task_id)
          .eq('lease_token', stream.lease_token);
        if (saved.error)
          this.logger.error(
            `SLA error checkpoint failed: ${saved.error.message}`,
          );
      }
    }
  }
  async processStream(stream: {
    task_id: string;
    processed_sequence: number;
    sequence: number;
    lease_token: string;
  }): Promise<void> {
    let cycles: SlaCycle[] = [];
    for (let offset = 0; ; offset += 500) {
      const saved = await this.client
        .from('sla_cycles')
        .select('*')
        .eq('task_id', stream.task_id)
        .order('metric_id')
        .order('cycle_number')
        .range(offset, offset + 499);
      if (saved.error) throw new Error(saved.error.message);
      cycles = [...cycles, ...((saved.data ?? []) as SlaCycle[])];
      if ((saved.data?.length ?? 0) < 500) break;
    }
    let sequence = Number(stream.processed_sequence);
    // A bounded page keeps leases finite. The CAS leaves later events queued.
    const events = await this.client
      .from('sla_task_events')
      .select('*')
      .eq('task_id', stream.task_id)
      .gt('sequence', sequence)
      .order('sequence')
      .limit(250);
    if (events.error) throw new Error(events.error.message);
    const prepared: { event: any; terms: SlaMetricTerms[] }[] = [];
    for (const event of events.data ?? []) {
      if (Number(event.sequence) !== sequence + 1)
        throw new Error('SLA event sequence gap');
      const terms = await this.loadTerms(
        event.metric_revisions ?? [],
        event.after_snapshot?.space_id ?? event.before_snapshot?.space_id,
      );
      prepared.push({ event, terms });
      sequence = Number(event.sequence);
    }
    const referenced = new Set<string>();
    for (const terms of [
      ...cycles
        .filter((c) => c.lifecycle === 'active')
        .map((c) => c.state.terms),
      ...prepared.flatMap((p) => p.terms),
    ]) {
      try {
        referencedCustomFields(terms.config).forEach((field) =>
          referenced.add(field),
        );
      } catch {
        /* reducer records this metric's invalid configuration */
      }
    }
    let unavailable = new Set<string>();
    if (referenced.size) {
      const definitions = await this.client
        .from('custom_fields')
        .select('id,is_deleted')
        .in(
          'id',
          [...referenced].map((field) => field.slice(3)),
        );
      if (definitions.error)
        throw new Error('Unable to verify SLA condition field references');
      unavailable = new Set(
        [...referenced].filter(
          (field) =>
            !definitions.data?.some(
              (row) => row.id === field.slice(3) && row.is_deleted !== true,
            ),
        ),
      );
    }
    for (const { event, terms } of prepared) {
      const snapshot = event.after_snapshot
        ? Object.fromEntries(
            Object.entries(event.after_snapshot).filter(
              ([key]) => !unavailable.has(key),
            ),
          )
        : null;
      const checked = terms.map((term) => {
        try {
          return referencedCustomFields(term.config).some((field) =>
            unavailable.has(field),
          )
            ? {
                ...term,
                configuration_error:
                  'SLA condition references a deleted custom field',
              }
            : term;
        } catch (error) {
          return {
            ...term,
            configuration_error:
              error instanceof Error
                ? error.message
                : 'Invalid SLA configuration',
          };
        }
      });
      cycles = reduceSlaEvent(
        cycles,
        { ...event, after_snapshot: snapshot },
        checked,
      );
    }
    cycles = cycles.map((cycle) => {
      if (cycle.lifecycle !== 'active') return cycle;
      try {
        referencedCustomFields(cycle.state.terms.config);
        return cycle;
      } catch (error) {
        return invalidateCycle(cycle, error, new Date().toISOString());
      }
    });
    cycles = cycles.map((cycle) => {
      if (cycle.lifecycle !== 'active') return cycle;
      const broken = referencedCustomFields(cycle.state.terms.config).some(
        (field) => unavailable.has(field),
      );
      return broken
        ? invalidateCycle(
            cycle,
            new Error('SLA condition references a deleted custom field'),
            new Date().toISOString(),
          )
        : cycle;
    });
    // Never advance time past an unprocessed event: it may pause or complete.
    const projectionAt =
      (events.data?.length ?? 0) === 250
        ? Date.parse(events.data![249].effective_at)
        : Date.now();
    cycles = cycles.map((c) => {
      try {
        return projectCycle(c, projectionAt);
      } catch (error) {
        return invalidateCycle(c, error, new Date(projectionAt).toISOString());
      }
    });
    const committed = await this.client.rpc('sla_commit_stream', {
      p_task_id: stream.task_id,
      p_token: stream.lease_token,
      p_expected_sequence: stream.processed_sequence,
      p_processed_sequence: sequence,
      p_expected_captured_sequence: stream.sequence,
      p_cycles: cycles,
    });
    if (committed.error) throw new Error(committed.error.message);
    if (committed.data !== true)
      throw new Error('SLA processing lease changed; retry queued');
  }
  private async loadTerms(
    references: { metric_id: string; revision_id: string; enabled: boolean }[],
    spaceId: string,
  ): Promise<SlaMetricTerms[]> {
    if (!references.length) return [];
    const revisions = await this.client
      .from('sla_metric_revisions')
      .select('*')
      .in(
        'id',
        references.map((r) => r.revision_id),
      );
    if (revisions.error) throw new Error(revisions.error.message);
    const missing = references.filter(
      (ref) =>
        !revisions.data?.some(
          (row) =>
            row.id === ref.revision_id && row.metric_id === ref.metric_id,
        ),
    );
    const retainedMetricIds = new Set<string>();
    if (missing.length) {
      const retained = await this.client
        .from('sla_metrics')
        .select('id')
        .in('id', [...new Set(missing.map((ref) => ref.metric_id))]);
      if (retained.error)
        throw new Error('Unable to verify missing SLA metric revisions');
      for (const metric of retained.data ?? [])
        retainedMetricIds.add(metric.id);
    }
    // Parent-space retention can remove an old metric while its task stream survives a move.
    // Only verified metric absence permits skipping its historical revision reference.
    const surviving = references.filter(
      (ref) => !missing.includes(ref) || retainedMetricIds.has(ref.metric_id),
    );

    const calendarIds = [
      ...new Set(
        (revisions.data ?? []).flatMap((r) =>
          Array.isArray(r.config?.goals)
            ? (r.config as SlaConfig).goals.map((g) => g.calendar_revision_id)
            : [],
        ),
      ),
    ];
    const calendars = calendarIds.length
      ? await this.client
          .from('sla_calendar_revisions')
          .select('id,config')
          .in('id', calendarIds)
      : { data: [], error: null };
    if (calendars.error) throw new Error(calendars.error.message);
    const byId = Object.fromEntries(
      (calendars.data ?? []).map((c) => [c.id, c.config as SlaCalendar]),
    );
    return surviving.map((ref) => {
      const revision = revisions.data?.find(
        (r) => r.id === ref.revision_id && r.metric_id === ref.metric_id,
      );
      if (!revision) throw new Error('SLA metric revision is missing');
      const config = revision.config as SlaConfig;
      return {
        ...ref,
        space_id: revision?.space_id ?? spaceId,
        configuration_error: Array.isArray(config?.goals)
          ? undefined
          : 'Invalid SLA metric configuration',
        config,
        calendars: byId,
        metadata: config?.field_metadata ?? [],
      };
    });
  }
}
