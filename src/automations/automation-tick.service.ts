// Automation tick — outbox relay, schedule fire, sleep wake, lease recovery, cleanup.

import { Injectable, Logger } from '@nestjs/common';
import { CronExpressionParser } from 'cron-parser';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AutomationQueueService } from './utils/queue';
import { findFirstActionableNodesForTrigger } from './utils/dag-engine';
import type { IAutomationDefinition } from './interfaces/automation.interface';
import {
  FilterEvaluator,
  hasRuleForField,
  type IFilterRuleGroup,
} from './utils/filter-evaluator';
import { fetchLinkedTaskIds, fetchTaskKeys } from '../tasks/task-links.util';

function computeNextRun(
  cronExpression: string,
  timezone: string,
  after: Date,
): Date {
  const interval = CronExpressionParser.parse(cronExpression, {
    currentDate: after,
    tz: timezone,
  });

  return interval.next().toDate();
}

interface OutboxRow {
  id: number;
  organization_id: string;
  space_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

interface ScheduleRow {
  id: string;
  next_run_at: string;
  cron_expression: string;
  timezone: string;
  start_date: string | null;
  end_date: string | null;
  automations: {
    id: string;
    status: string;
    published_version_id: string | null;
    organization_id: string;
    space_id: string;
    max_concurrent_runs: number | null;
  };
}

// Context carrying pre-fetched data to avoid N+1 queries in enqueueRun
interface EnqueueContext {
  spaceSettingsCache: Map<string, Record<string, unknown>>;
  versionCache: Map<string, IAutomationDefinition>;
  activeRunCountByAutomation: Map<string, number>;
  activeRunCountBySpace: Map<string, number>;
}

export interface TickStats {
  durationMs: number;
  outboxRelayed: number;
  schedulesFired: number;
  sleepersWoken: number;
  leasesRecovered: number;
  timedOutRuns: number;
  skippedConcurrent: number;
  cleanedRuns: number;
  cleanedOutbox: number;
  cleanedOauthStates: number;
}

@Injectable()
export class AutomationTickService {
  private readonly logger = new Logger(AutomationTickService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly queue: AutomationQueueService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async runTick(): Promise<TickStats> {
    const startedAt = Date.now();
    const stats: TickStats = {
      durationMs: 0,
      outboxRelayed: 0,
      schedulesFired: 0,
      sleepersWoken: 0,
      leasesRecovered: 0,
      timedOutRuns: 0,
      skippedConcurrent: 0,
      cleanedRuns: 0,
      cleanedOutbox: 0,
      cleanedOauthStates: 0,
    };

    // 1. Outbox relay
    const { data: pendingRaw } = await this.db
      .from('automation_event_outbox')
      .select('id, organization_id, space_id, kind, payload')
      .is('relayed_at', null)
      .order('occurred_at', { ascending: true })
      .limit(100);

    // Pre-fetch space settings for all pending outbox rows (one query)
    const uniqueSpaceIds = [
      ...new Set(
        (pendingRaw ?? [])
          .map((r) => (r as OutboxRow).space_id)
          .filter((id): id is string => id != null),
      ),
    ];
    const spaceSettingsCache = new Map<string, Record<string, unknown>>();

    if (uniqueSpaceIds.length > 0) {
      const { data: spacesData } = await this.db
        .from('spaces')
        .select('id, settings')
        .in('id', uniqueSpaceIds);

      for (const s of spacesData ?? []) {
        const sp = s as { id: string; settings: Record<string, unknown> };

        spaceSettingsCache.set(sp.id, sp.settings ?? {});
      }
    }

    for (const row of (pendingRaw ?? []) as OutboxRow[]) {
      if (Date.now() - startedAt > 30_000) break;

      // Org-level events (space_id IS NULL) match subscriptions by organization_id.
      // Space-level events match by space_id as before.
      let subsQuery = this.db
        .from('automation_event_subscriptions')
        .select(
          'automation_id, filters, automations!inner(id, status, published_version_id, organization_id, space_id, max_concurrent_runs)',
        )
        .eq('event_kind', row.kind)
        .eq('is_active', true);

      if (row.space_id == null) {
        subsQuery = subsQuery.eq('organization_id', row.organization_id);
      } else {
        subsQuery = subsQuery.eq('space_id', row.space_id);
      }

      const { data: subsRaw } = await subsQuery;

      if (!subsRaw || subsRaw.length === 0) {
        this.logger.warn(
          `[tick] no active subscriptions for kind="${row.kind}" space="${row.space_id ?? 'null'}"`,
        );
      }

      type SubRow = {
        automation_id: string;
        filters?: Record<string, unknown>;
        automations: {
          id: string;
          status: string;
          published_version_id: string | null;
          organization_id: string;
          space_id: string;
          max_concurrent_runs: number | null;
        };
      };

      const allSubs = (subsRaw ?? []) as unknown as SubRow[];

      const validSubs = allSubs.filter((sub) => {
        const automation = sub.automations;

        return (
          automation &&
          automation.status === 'published' &&
          automation.published_version_id
        );
      });

      // Batch-fetch version definitions for this row's matched subs
      const neededVersionIds = [
        ...new Set(
          validSubs.map((s) => s.automations.published_version_id as string),
        ),
      ];
      const versionCache = new Map<string, IAutomationDefinition>();

      if (neededVersionIds.length > 0) {
        const { data: versionsData } = await this.db
          .from('automation_versions')
          .select('id, definition')
          .in('id', neededVersionIds);

        for (const v of versionsData ?? []) {
          versionCache.set(
            (v as { id: string }).id,
            (v as { definition: IAutomationDefinition }).definition,
          );
        }
      }

      // Batch-fetch active run counts for all matched automations (2 queries instead of 2N)
      const automationIds = validSubs.map((s) => s.automations.id);
      const rowSpaceIds = [
        ...new Set(validSubs.map((s) => s.automations.space_id)),
      ];
      const activeRunCountByAutomation = new Map<string, number>();
      const activeRunCountBySpace = new Map<string, number>();

      if (automationIds.length > 0) {
        const { data: activeRuns } = await this.db
          .from('automation_runs')
          .select('automation_id, space_id')
          .in('automation_id', automationIds)
          .in('status', ['queued', 'running']);

        for (const r of activeRuns ?? []) {
          const ar = r as { automation_id: string; space_id: string };

          activeRunCountByAutomation.set(
            ar.automation_id,
            (activeRunCountByAutomation.get(ar.automation_id) ?? 0) + 1,
          );
          activeRunCountBySpace.set(
            ar.space_id,
            (activeRunCountBySpace.get(ar.space_id) ?? 0) + 1,
          );
        }
      }

      // Ensure space settings are present for all automation spaces in this row
      const missedSpaceIds = rowSpaceIds.filter(
        (id) => !spaceSettingsCache.has(id),
      );

      if (missedSpaceIds.length > 0) {
        const { data: missedSpaces } = await this.db
          .from('spaces')
          .select('id, settings')
          .in('id', missedSpaceIds);

        for (const s of missedSpaces ?? []) {
          const sp = s as { id: string; settings: Record<string, unknown> };

          spaceSettingsCache.set(sp.id, sp.settings ?? {});
        }
      }

      const rowContext: EnqueueContext = {
        spaceSettingsCache,
        versionCache,
        activeRunCountByAutomation,
        activeRunCountBySpace,
      };

      const matchPayload = await this.withLinkedTasks(row, validSubs);

      await Promise.all(
        validSubs
          .filter((sub) =>
            this.matchesFilters(matchPayload, sub.filters ?? {}, row.kind),
          )
          .map(async (sub) => {
            const automation = sub.automations;

            await this.enqueueRun({
              automationId: automation.id,
              publishedVersionId: automation.published_version_id!,
              maxConcurrentRuns: automation.max_concurrent_runs,
              // For space-level events use the event's space_id.
              // For org-level events (space_id IS NULL) fall back to the
              // automation's own space so automation_runs.space_id (NOT NULL uuid)
              // is always a valid UUID and actions run in the right space context.
              spaceId: row.space_id ?? automation.space_id ?? '',
              organizationId: row.organization_id,
              triggerKind: row.kind,
              triggerEventId: String(row.id),
              triggerPayload: row.payload,
              context: rowContext,
            });
          }),
      );

      await this.db
        .from('automation_event_outbox')
        .update({ relayed_at: new Date().toISOString() })
        .eq('id', row.id);
      stats.outboxRelayed++;
    }

    // 2. Schedule fire
    const nowIso = new Date().toISOString();

    const { data: dueRaw } = await this.db
      .from('automation_schedules')
      .select(
        'id, next_run_at, cron_expression, timezone, start_date, end_date, automations!inner(id, status, published_version_id, organization_id, space_id, max_concurrent_runs)',
      )
      .eq('is_active', true)
      .lte('next_run_at', nowIso)
      .or(`start_date.is.null,start_date.lte.${nowIso}`)
      .or(`end_date.is.null,end_date.gt.${nowIso}`)
      .limit(50);

    for (const sched of (dueRaw ?? []) as unknown as ScheduleRow[]) {
      const automation = sched.automations;

      if (
        !automation ||
        automation.status !== 'published' ||
        !automation.published_version_id
      )
        continue;

      // Advance BEFORE enqueueing, as a compare-and-swap on the next_run_at we read: if another
      // replica already advanced this schedule, zero rows move and this fire is theirs, not ours.
      // (enqueueRun reports failure by returning false, never by throwing, so the schedule was
      // already advanced on every path — moving it first changes nothing but who wins a race.)
      const nextRunAt = computeNextRun(
        sched.cron_expression,
        sched.timezone,
        new Date(),
      );

      const { data: advanced } =
        sched.end_date && nextRunAt.toISOString() > sched.end_date
          ? await this.db
              .from('automation_schedules')
              .update({
                last_run_at: new Date().toISOString(),
                is_active: false,
              })
              .eq('id', sched.id)
              .eq('next_run_at', sched.next_run_at)
              .select('id')
          : await this.db
              .from('automation_schedules')
              .update({
                last_run_at: new Date().toISOString(),
                next_run_at: nextRunAt.toISOString(),
              })
              .eq('id', sched.id)
              .eq('next_run_at', sched.next_run_at)
              .select('id');

      if (!advanced?.length) continue;

      // For cron triggers — fetch active run count for this specific automation only
      const cronRunData: { automation_id: string; space_id: string }[] = [];
      const { data: cronRunRows } = await this.db
        .from('automation_runs')
        .select('automation_id, space_id')
        .eq('automation_id', automation.id)
        .in('status', ['queued', 'running']);

      for (const r of cronRunRows ?? []) {
        cronRunData.push(r as { automation_id: string; space_id: string });
      }

      const cronActiveRuns = new Map<string, number>();
      const cronSpaceRunCount = new Map<string, number>();

      for (const r of cronRunData) {
        cronActiveRuns.set(
          r.automation_id,
          (cronActiveRuns.get(r.automation_id) ?? 0) + 1,
        );
        cronSpaceRunCount.set(
          r.space_id,
          (cronSpaceRunCount.get(r.space_id) ?? 0) + 1,
        );
      }

      const cronContext: EnqueueContext = {
        spaceSettingsCache,
        versionCache: new Map<string, IAutomationDefinition>(),
        activeRunCountByAutomation: cronActiveRuns,
        activeRunCountBySpace: cronSpaceRunCount,
      };

      const enqueued = await this.enqueueRun({
        automationId: automation.id,
        publishedVersionId: automation.published_version_id,
        maxConcurrentRuns: automation.max_concurrent_runs ?? null,
        spaceId: automation.space_id,
        organizationId: automation.organization_id,
        triggerKind: 'schedule.cron',
        triggerEventId: `schedule-${new Date().toISOString()}`,
        triggerPayload: { fired_at: new Date().toISOString() },
        context: cronContext,
      });

      if (!enqueued) stats.skippedConcurrent++;

      stats.schedulesFired++;
    }

    // 3. Wake sleeping steps
    stats.sleepersWoken = await this.queue.wakeSleepingSteps();

    // 4. Recover stale leases
    stats.leasesRecovered = await this.queue.recoverStaleLeases();

    // 5. Timeout stuck runs (>30 min)
    const timeoutCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: stuckRuns } = await this.db
      .from('automation_runs')
      .select('id, started_at')
      .eq('status', 'running')
      .lt('started_at', timeoutCutoff)
      .limit(50);

    for (const run of (stuckRuns ?? []) as Array<{
      id: string;
      started_at: string | null;
    }>) {
      const durationMs = run.started_at
        ? Date.now() - new Date(run.started_at).getTime()
        : null;

      await this.db
        .from('automation_run_steps')
        .update({ status: 'failed', error_message: 'Run timed out' })
        .eq('run_id', run.id)
        .in('status', ['pending', 'running']);

      await this.db
        .from('automation_runs')
        .update({
          status: 'failed',
          error_message: 'Run timed out after 30 minutes',
          finished_at: new Date().toISOString(),
          duration_ms: durationMs,
        })
        .eq('id', run.id);

      stats.timedOutRuns++;
    }

    // 6. Daily cleanup (once per 23 h via cron_run_state)
    const runOncePerDay = async (
      jobName: string,
      fn: () => Promise<number>,
    ): Promise<number> => {
      const { data } = await this.db
        .from('cron_run_state')
        .select('last_run_at')
        .eq('job_name', jobName)
        .maybeSingle();

      const lastRun: Date | null = (data as { last_run_at?: string } | null)
        ?.last_run_at
        ? new Date((data as { last_run_at: string }).last_run_at)
        : null;

      if (lastRun && Date.now() - lastRun.getTime() < 23 * 60 * 60 * 1000)
        return 0;

      try {
        const count = await fn();

        await this.db
          .from('cron_run_state')
          .upsert({ job_name: jobName, last_run_at: new Date().toISOString() });

        return count;
      } catch (err) {
        this.logger.error(`[tick/cleanup:${jobName}] ${String(err)}`);

        return 0;
      }
    };

    stats.cleanedRuns = await runOncePerDay(
      'cleanup_automation_runs',
      async () => {
        const r = await this.db.rpc('cleanup_old_automation_runs', {
          retention_days: 90,
        });

        return (r.data as number) ?? 0;
      },
    );

    stats.cleanedOutbox = await runOncePerDay(
      'cleanup_automation_outbox',
      async () => {
        const r = await this.db.rpc('cleanup_old_automation_outbox');

        return (r.data as number) ?? 0;
      },
    );

    stats.cleanedOauthStates = await runOncePerDay(
      'cleanup_oauth_states',
      async () => {
        const r = await this.db.rpc('cleanup_expired_oauth_states');

        return (r.data as number) ?? 0;
      },
    );

    stats.durationMs = Date.now() - startedAt;

    return stats;
  }

  private async enqueueRun(args: {
    automationId: string;
    publishedVersionId: string;
    maxConcurrentRuns: number | null;
    spaceId: string;
    organizationId: string;
    triggerKind: string;
    triggerEventId: string;
    triggerPayload: Record<string, unknown>;
    context: EnqueueContext;
  }): Promise<boolean> {
    const {
      automationId,
      publishedVersionId,
      maxConcurrentRuns,
      spaceId,
      organizationId,
      triggerKind,
      triggerEventId,
      triggerPayload,
      context,
    } = args;

    // Per-space concurrency cap — use pre-fetched cache
    const spaceSettings = context.spaceSettingsCache.get(spaceId);
    const spaceCapValue =
      (
        spaceSettings?.automation_config as {
          max_concurrent_runs?: number | null;
        } | null
      )?.max_concurrent_runs ?? null;
    const maxPerSpace =
      spaceCapValue != null && spaceCapValue > 0
        ? spaceCapValue
        : parseInt(
            process.env.AUTOMATION_MAX_CONCURRENT_RUNS_PER_SPACE ?? '0',
            10,
          );

    if (maxPerSpace > 0) {
      const spaceCount = context.activeRunCountBySpace.get(spaceId) ?? 0;

      if (spaceCount >= maxPerSpace) {
        this.logger.log(
          `space ${spaceId} at concurrency limit (${maxPerSpace})`,
        );

        return false;
      }
    }

    // Per-automation concurrency cap — use pre-fetched max_concurrent_runs from subscription join
    const maxPerAutomation = maxConcurrentRuns;

    if (maxPerAutomation !== null && maxPerAutomation > 0) {
      const automationRunCount =
        context.activeRunCountByAutomation.get(automationId) ?? 0;

      if (automationRunCount >= maxPerAutomation) {
        this.logger.log(
          `automation ${automationId} at concurrency limit (${maxPerAutomation})`,
        );

        return false;
      }
    }

    // Scheduled triggers run serially — skip if one is already active
    if (triggerKind === 'schedule.cron') {
      const count = context.activeRunCountByAutomation.get(automationId) ?? 0;

      if (count > 0) {
        this.logger.log(`skipping ${automationId} — run already active`);

        return false;
      }
    }

    const { data: run, error: runError } = await this.db
      .from('automation_runs')
      .insert({
        automation_id: automationId,
        automation_version_id: publishedVersionId,
        space_id: spaceId,
        organization_id: organizationId,
        trigger_kind: triggerKind,
        trigger_event_id: triggerEventId,
        trigger_payload: triggerPayload,
        status: 'queued',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (runError || !run) {
      this.logger.error(
        `enqueueRun: failed to insert run: ${runError?.message}`,
      );

      return false;
    }

    // Load version definition — use cache, fall back to individual fetch on miss
    let versionDefinition =
      context.versionCache.get(publishedVersionId) ?? null;

    if (!versionDefinition) {
      // Cache miss — fall back to individual fetch
      const { data: version, error: versionError } = await this.db
        .from('automation_versions')
        .select('definition')
        .eq('id', publishedVersionId)
        .single();

      if (versionError || !version) {
        this.logger.error(
          `enqueueRun: failed to load version: ${versionError?.message}`,
        );
        await this.db
          .from('automation_runs')
          .update({
            status: 'failed',
            error_message: `Version not found: ${versionError?.message ?? 'unknown'}`,
          })
          .eq('id', (run as { id: string }).id);

        return false;
      }

      versionDefinition = (version as { definition: IAutomationDefinition })
        .definition;
    }

    let firstNodes: ReturnType<typeof findFirstActionableNodesForTrigger> = [];

    try {
      firstNodes = findFirstActionableNodesForTrigger(
        versionDefinition,
        triggerKind,
      );
    } catch (err) {
      this.logger.error(
        `enqueueRun: findFirstActionableNodesForTrigger failed: ${String(err)}`,
      );
    }

    // No connected action nodes — fail the run immediately so it doesn't hang.
    if (firstNodes.length === 0) {
      this.logger.warn(
        `enqueueRun: no actionable nodes for trigger kind "${triggerKind}" in automation ${automationId} — marking run failed`,
      );
      await this.db
        .from('automation_runs')
        .update({
          status: 'failed',
          error_message: 'No action nodes connected to trigger',
        })
        .eq('id', (run as { id: string }).id);

      return false;
    }

    // Batch insert all first-action steps in a single query
    const { error: stepsError } = await this.db
      .from('automation_run_steps')
      .insert(
        firstNodes.map((node) => ({
          run_id: (run as { id: string }).id,
          space_id: spaceId,
          node_id: node.id,
          node_kind: node.data?.kind,
          step_index: 1,
          status: 'pending',
          input: triggerPayload,
          retry_count: 0,
        })),
      );

    if (stepsError) {
      this.logger.error(
        `enqueueRun: failed to insert steps: ${stepsError.message}`,
      );
      await this.db
        .from('automation_runs')
        .update({
          status: 'failed',
          error_message: `Failed to create run steps: ${stepsError.message}`,
        })
        .eq('id', (run as { id: string }).id);

      return false;
    }

    await this.db
      .from('automation_runs')
      .update({ status: 'running' })
      .eq('id', (run as { id: string }).id);

    // Update the shared count maps so concurrent enqueueRun calls in the same
    // Promise.all batch see the incremented counts and respect concurrency caps.
    context.activeRunCountByAutomation.set(
      automationId,
      (context.activeRunCountByAutomation.get(automationId) ?? 0) + 1,
    );
    context.activeRunCountBySpace.set(
      spaceId,
      (context.activeRunCountBySpace.get(spaceId) ?? 0) + 1,
    );

    return true;
  }

  /**
   * "Linked to" trigger filters (XE-T532): for an `app.task.*` row with a
   * subscription whose filter_query uses `linked_to`, return a copy of the payload
   * carrying the task's linked ids + keys, read at tick time. Otherwise the same
   * payload, with no query. Only filter matching sees the copy; the run's trigger
   * payload stays the original.
   */
  private async withLinkedTasks(
    row: Pick<OutboxRow, 'kind' | 'organization_id' | 'payload'>,
    subs: { filters?: Record<string, unknown> }[],
  ): Promise<Record<string, unknown>> {
    const { payload } = row;
    if (!row.kind.startsWith('app.task.')) return payload;

    const usesLinkedTo = subs.some((sub) => {
      const query = sub.filters?.filter_query;
      return (
        query != null &&
        typeof query === 'object' &&
        hasRuleForField(query as IFilterRuleGroup, 'linked_to')
      );
    });
    if (!usesLinkedTo) return payload;

    const taskId = (payload.task_id ??
      (payload.task as { id?: unknown } | undefined)?.id) as string | undefined;
    if (!taskId) return payload;

    const linked = await fetchLinkedTaskIds(this.db, row.organization_id, [
      taskId,
    ]);
    const ids = [...(linked.get(taskId) ?? [])];
    const keys =
      ids.length > 0
        ? await fetchTaskKeys(this.db, row.organization_id, ids)
        : new Map<string, string>();

    return { ...payload, linked_to: [...ids, ...keys.values()] };
  }

  private camelToSnake(s: string): string {
    return s.replace(/([A-Z])/g, (c) => '_' + c.toLowerCase());
  }

  private getEntityTypeForKind(kind: string): string {
    if (kind.startsWith('app.task.')) return 'task';
    if (kind.startsWith('app.process.')) return 'process';
    if (kind.startsWith('app.asset_object.')) return 'asset_object';
    if (kind.startsWith('app.asset.')) return 'asset';
    return '';
  }

  private getEntityData(
    payload: Record<string, unknown>,
    entityType: string,
  ): Record<string, unknown> {
    if (!entityType) return payload;
    const obj = payload[entityType];
    if (obj == null || typeof obj !== 'object') return payload;
    // Merge: top-level payload fields are accessible, entity sub-object fields take precedence
    // This allows filter rules on both task fields AND event envelope fields (previousStatus, newStatus)
    return { ...payload, ...(obj as Record<string, unknown>) };
  }

  // Resolve a filter key against the payload: flat first, then one level
  // deep (event data nests under { task: {...} }, { plan: {...} }, etc.).
  private lookupKey(payload: Record<string, unknown>, key: string): unknown {
    if (payload[key] !== undefined) return payload[key];

    for (const value of Object.values(payload)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        const nested = (value as Record<string, unknown>)[key];

        if (nested !== undefined) return nested;
      }
    }

    return undefined;
  }

  private matchesFilters(
    payload: Record<string, unknown>,
    filters: Record<string, unknown>,
    eventKind?: string,
  ): boolean {
    // Special case: threshold + direction → numeric comparison against riskScore.
    // app.risk.threshold_crossed stores these as filter parameters (e.g. "fire
    // when score goes below 10"), NOT as fields emitted in the payload. Standard
    // equality matching can never match them, so we handle them here before the
    // equality loop and skip them inside it.
    if ('threshold' in filters && 'direction' in filters) {
      const score =
        (payload['riskScore'] as number | undefined) ??
        ((payload['process'] as Record<string, unknown> | undefined)?.[
          'risk_score'
        ] as number | undefined);
      const threshold = filters['threshold'] as number;
      const direction = filters['direction'] as string;

      // If the payload has no numeric score we cannot evaluate the filter.
      // Guard both undefined AND null — JS coerces null to 0 in comparisons,
      // which would incorrectly allow null-score processes to trigger
      // "direction: below" automations (0 < threshold is always true).
      if (score === undefined || score === null) return false;

      if (direction === 'below' && score > threshold) return false;
      if (direction === 'above' && score < threshold) return false;
      // direction === 'below' && score <= threshold → passes (score crossed down to/below threshold)
      // direction === 'above' && score >= threshold → passes (score crossed up to/above threshold)
      // Using non-strict inequality: "threshold_crossed" means reaching the threshold, not exceeding it.
      // threshold=100 + direction=above fires when score=100 (maximum risk); threshold=70 fires when score≥70.
    }

    // Special case: thresholdAbove / thresholdBelow → numeric range filter for app.risk.recalculated.
    // These are comparison operators (not payload fields) — handle them here and skip in the equality
    // loop below. Either or both may be absent (treated as no constraint — leave blank for any).
    if ('thresholdAbove' in filters || 'thresholdBelow' in filters) {
      const score =
        (payload['riskScore'] as number | undefined) ??
        ((payload['process'] as Record<string, unknown> | undefined)?.[
          'risk_score'
        ] as number | undefined);

      // Guard undefined and null — same reason as threshold/direction above.
      if (score === undefined || score === null) return false;

      const above = filters['thresholdAbove'];
      const below = filters['thresholdBelow'];

      // thresholdAbove: fires when score reaches or exceeds this value (score >= thresholdAbove).
      if (typeof above === 'number' && score < above) return false;

      // thresholdBelow: fires when score drops to or below this value (score <= thresholdBelow).
      if (typeof below === 'number' && score > below) return false;
    }

    // New IFilterRuleGroup-based evaluation — detect by presence of 'combinator' + 'rules'
    if (
      'filter_query' in filters &&
      filters.filter_query != null &&
      typeof filters.filter_query === 'object' &&
      'combinator' in filters.filter_query
    ) {
      const entityType = this.getEntityTypeForKind(eventKind ?? '');
      const entityData = this.getEntityData(payload, entityType);

      // Resolve actor from outbox payload — used by the 'currentUser' operator.
      // created_by is present for app.task.created; updated_by for app.task.updated.
      const triggeringUserId = (payload.created_by ??
        payload.updated_by ??
        payload.user_id) as string | undefined;

      try {
        const evaluator = new FilterEvaluator(entityType);
        if (
          !evaluator.evaluate(
            filters.filter_query as IFilterRuleGroup,
            entityData,
            triggeringUserId,
          )
        ) {
          return false;
        }
      } catch (err) {
        this.logger.warn(
          `[matchesFilters] filter_query evaluation failed: ${String(err)}`,
        );
      }
    }

    for (const [key, expected] of Object.entries(filters)) {
      // threshold/direction and thresholdAbove/thresholdBelow are handled above as comparison
      // operators — skip them in the equality loop so they don't cause a spurious mismatch.
      if (
        key === 'threshold' ||
        key === 'direction' ||
        key === 'thresholdAbove' ||
        key === 'thresholdBelow' ||
        key === 'filter_query' ||
        // answerFormat controls how submission answers are RENDERED; it is never
        // emitted in the payload, so leaving it in the equality loop made every
        // form-submitted automation silently stop firing the moment it was
        // republished — relayed outbox row, no run, no error.
        key === 'answerFormat'
      )
        continue;

      // 'any' is the "no filter" sentinel used in action-enum fields (e.g. the
      // action filter on app.process.relationship_changed, app.task.updated,
      // etc.). Treat it as a wildcard so automations with "any action" always
      // fire regardless of the actual action value in the payload.
      if (
        expected === undefined ||
        expected === null ||
        expected === '' ||
        expected === 'any'
      )
        continue;

      // 1+2. Flat then one-level-nested lookup of the filter key as-is.
      let actual: unknown = this.lookupKey(payload, key);

      // 3. snake_case fallback: a saved filter key like `taskId` or
      // `previousStatus` may target a payload field named `task_id` /
      // `previous_status`. Retry with the converted key so already-published
      // subscriptions keep matching even if their keys predate the rename.
      if (actual === undefined) {
        const snake = this.camelToSnake(key);

        if (snake !== key) actual = this.lookupKey(payload, snake);
      }

      if (Array.isArray(expected)) {
        if (!expected.includes(actual)) return false;
      } else if (actual !== expected) {
        return false;
      }
    }

    return true;
  }
}
