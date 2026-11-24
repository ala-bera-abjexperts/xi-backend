/**
 * @fileoverview Engine housekeeping — one tick pass:
 *  1. wake sleeping items whose wakeup passed,
 *  2. unblock items whose awaited crosswalk row landed,
 *  3. fail blocked items whose dependency terminally failed (deadlock guard),
 *  4. advance each running run's stage when drained / finalize the run,
 *  5. roll up live totals, 6. time out runs stuck beyond the ceiling.
 *
 * Stage advancement is OPTIMISTIC (`eq('stage_index', old)`), so overlapping
 * ticks (multi-replica) can never double-advance a run.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { MigrationQueueService } from './migration-queue.service';
import { JIRA_ATTACHMENT_RELINK_STAGE } from './stages/jira-attachment-relink.stage';
import {
  OPEN_ITEM_STATUSES,
  type MigrationItemStatus,
  type MigrationRunRow,
} from './stages/stage.interface';

const RUNS = 'migration_runs';
const ITEMS = 'migration_run_items';

const RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface TickStats {
  sleepersWoken: number;
  itemsUnblocked: number;
  orphansFailed: number;
  stagesAdvanced: number;
  runsFinished: number;
  runsTimedOut: number;
}

@Injectable()
export class MigrationTickService {
  private readonly logger = new Logger(MigrationTickService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly queue: MigrationQueueService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async runTick(): Promise<TickStats> {
    const stats: TickStats = {
      sleepersWoken: 0,
      itemsUnblocked: 0,
      orphansFailed: 0,
      stagesAdvanced: 0,
      runsFinished: 0,
      runsTimedOut: 0,
    };

    stats.sleepersWoken = await this.queue.wakeSleepers();
    stats.itemsUnblocked = await this.queue.unblockReadyItems();

    const { data: running, error } = (await this.db
      .from(RUNS)
      .select('*')
      .eq('status', 'running')) as {
      data: MigrationRunRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      this.logger.warn(`Tick: loading running runs failed: ${error.message}`);

      return stats;
    }

    for (const run of running ?? []) {
      try {
        if (this.isTimedOut(run)) {
          await this.timeoutRun(run);
          stats.runsTimedOut++;
          continue;
        }

        const counts = await this.countItems(run);

        stats.orphansFailed += await this.failOrphanedBlockedItems(run, counts);
        await this.rollupTotals(run, counts);

        const open = OPEN_ITEM_STATUSES.reduce(
          (sum, s) => sum + (counts.get(s) ?? 0),
          0,
        );

        if (open > 0) continue;

        const advanced = await this.advanceOrFinish(run, counts);

        if (advanced === 'advanced') stats.stagesAdvanced++;
        if (advanced === 'finished') stats.runsFinished++;
      } catch (err) {
        this.logger.error(
          `Tick: run ${run.id} failed: ${(err as Error).message}`,
        );
      }
    }

    return stats;
  }

  // ───────────────────────── per-run passes ─────────────────────────

  private async countItems(
    run: MigrationRunRow,
  ): Promise<Map<MigrationItemStatus, number>> {
    const counts = new Map<MigrationItemStatus, number>();

    // Head-count per status via targeted count queries (no group-by over PostgREST).
    const statuses: MigrationItemStatus[] = [
      'pending',
      'running',
      'sleeping',
      'blocked',
      'paused',
      'succeeded',
      'failed',
      'skipped',
      'dead',
    ];

    for (const status of statuses) {
      const { count, error } = await this.db
        .from(ITEMS)
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', run.organization_id)
        .eq('run_id', run.id)
        .eq('status', status);

      if (error) throw new Error(`countItems(${status}): ${error.message}`);

      counts.set(status, count ?? 0);
    }

    return counts;
  }

  /**
   * Deadlock guard: when nothing is pending/running/sleeping anymore but items are
   * still blocked, each blocked item's awaited dependency can no longer arrive if
   * its producing item terminally failed — fail those blocked items so the run
   * can complete as `partially_completed` instead of hanging forever.
   */
  private async failOrphanedBlockedItems(
    run: MigrationRunRow,
    counts: Map<MigrationItemStatus, number>,
  ): Promise<number> {
    const blocked = counts.get('blocked') ?? 0;
    const stillMoving =
      (counts.get('pending') ?? 0) +
      (counts.get('running') ?? 0) +
      (counts.get('sleeping') ?? 0);

    if (blocked === 0 || stillMoving > 0) return 0;

    const { data: blockedItems } = (await this.db
      .from(ITEMS)
      .select('id, checkpoint, entity_type')
      .eq('organization_id', run.organization_id)
      .eq('run_id', run.id)
      .eq('status', 'blocked')
      .limit(200)) as {
      data:
        | {
            id: string;
            checkpoint: Record<string, unknown> | null;
            entity_type: string;
          }[]
        | null;
    };

    let failed = 0;

    for (const item of blockedItems ?? []) {
      const waitingType = item.checkpoint?.waiting_entity_type as
        | string
        | undefined;
      const waitingId = item.checkpoint?.waiting_source_id as
        | string
        | undefined;

      if (!waitingType || !waitingId) continue;

      // Is the dependency's own work item terminally failed (or absent entirely)?
      const { data: dep } = (await this.db
        .from(ITEMS)
        .select('id, status')
        .eq('organization_id', run.organization_id)
        .eq('run_id', run.id)
        .eq('entity_type', waitingType)
        .eq('source_ref', waitingId)
        .limit(1)) as {
        data: { id: string; status: MigrationItemStatus }[] | null;
      };

      const depStatus = dep?.[0]?.status;
      const depIsGone =
        !depStatus ||
        depStatus === 'failed' ||
        depStatus === 'dead' ||
        depStatus === 'skipped';

      if (!depIsGone) continue;

      const { data: updated } = (await this.db
        .from(ITEMS)
        .update({
          status: 'failed',
          error_class: 'permanent',
          error_message: `Dependency ${waitingType}:${waitingId} did not migrate (${depStatus ?? 'missing'})`,
          finished_at: new Date().toISOString(),
        })
        .eq('organization_id', run.organization_id)
        .eq('id', item.id)
        .eq('status', 'blocked')
        .select('id')) as { data: { id: string }[] | null };

      if (updated && updated.length > 0) {
        failed++;
        counts.set('blocked', (counts.get('blocked') ?? 1) - 1);
        counts.set('failed', (counts.get('failed') ?? 0) + 1);
      }
    }

    return failed;
  }

  /** Advance to the next planned stage, or finalize the run when the plan is exhausted. */
  private async advanceOrFinish(
    run: MigrationRunRow,
    counts: Map<MigrationItemStatus, number>,
  ): Promise<'advanced' | 'finished' | 'noop'> {
    const plan = (run.config_snapshot?.stage_plan ?? []) as string[];
    const nextIndex = run.stage_index + 1;

    if (nextIndex < plan.length) {
      const nextStage = plan[nextIndex];

      /**
       * Seed the collection item BEFORE committing the advance.
       *
       * Doing it afterwards is a silent-data-loss trap: the stage_index update commits first, so if
       * the insert then fails the run sits on a stage with NO items, the next tick sees nothing to do
       * and advances again — the stage is skipped entirely and the run still finishes `succeeded`.
       * Observed live: one transient upstream error at this exact point dropped the whole
       * `page_attachments` stage (0 of 281 attachments) from a run that reported success, with no
       * failed item and no error anywhere in the run's own logs.
       *
       * Safe in this order because `lease_migration_items` gates on `stage_order <= stage_index`, so a
       * row seeded for the next stage cannot be leased until the advance lands. And it is safe to
       * retry: `seedCollectionItem` returns early when the row already exists, so a throw here simply
       * leaves the run where it was and the next tick tries again.
       */
      await this.queue.seedCollectionItem(run, nextStage, nextIndex);

      // Optimistic advance — a concurrent tick loses this conditional update.
      const { data: updated, error } = (await this.db
        .from(RUNS)
        .update({ current_stage: nextStage, stage_index: nextIndex })
        .eq('organization_id', run.organization_id)
        .eq('id', run.id)
        .eq('status', 'running')
        .eq('stage_index', run.stage_index)
        .select('*')) as {
        data: MigrationRunRow[] | null;
        error: { message: string } | null;
      };

      if (error) throw new Error(`advance failed: ${error.message}`);

      if (!updated || updated.length === 0) return 'noop';

      await this.queue.log(
        run.organization_id,
        run.id,
        null,
        'info',
        nextStage,
        null,
        null,
        `Advanced to stage "${nextStage}" (${nextIndex + 1}/${plan.length})`,
      );

      return 'advanced';
    }

    // Retry keeps the final stage leaseable; only refresh verify after every other item drains.
    const { data: latest, error: latestError } = await this.db
      .from(RUNS)
      .select('totals, status')
      .eq('organization_id', run.organization_id)
      .eq('id', run.id)
      .single();
    if (latestError)
      throw new Error(`verification lookup failed: ${latestError.message}`);
    if (latest.status !== 'running') return 'noop';
    const verification = latest.totals?.verification as
      | {
          stale?: boolean;
          generation?: string;
          reconciliations?: { shortfall: number | null }[];
        }
      | undefined;
    // Retried attachments land after relink already finished; re-run relink once per retry generation.
    // ponytail: a retry made before relink first ran costs one extra (idempotent) relink pass.
    if (
      plan.includes(JIRA_ATTACHMENT_RELINK_STAGE) &&
      typeof verification?.generation === 'string' &&
      verification.generation !== ''
    ) {
      const { data: collections, error: collectionError } = (await this.db
        .from(ITEMS)
        .select('id, payload')
        .eq('organization_id', run.organization_id)
        .eq('run_id', run.id)
        .eq('stage', JIRA_ATTACHMENT_RELINK_STAGE)
        .eq('item_kind', 'collection')
        .limit(1)) as {
        data:
          | { id: string; payload: { relink_generation?: string } | null }[]
          | null;
        error: { message: string } | null;
      };
      if (collectionError)
        throw new Error(
          `relink item lookup failed: ${collectionError.message}`,
        );
      const collection = collections?.[0];
      if (
        collection &&
        collection.payload?.relink_generation !== verification.generation
      ) {
        const reset = {
          status: 'pending',
          retry_count: 0,
          next_retry_at: null,
          wakeup_at: null,
          error_class: null,
          error_message: null,
          started_at: null,
          finished_at: null,
          duration_ms: null,
        };
        const { error: entityError } = await this.db
          .from(ITEMS)
          .update(reset)
          .eq('organization_id', run.organization_id)
          .eq('run_id', run.id)
          .eq('stage', JIRA_ATTACHMENT_RELINK_STAGE)
          .eq('item_kind', 'entity')
          .in('status', ['succeeded', 'skipped', 'failed', 'dead']);
        if (entityError)
          throw new Error(`relink reset failed: ${entityError.message}`);
        // The generation stamp goes last, so a failed entity reset is retried next tick.
        const { error: stampError } = await this.db
          .from(ITEMS)
          .update({
            ...reset,
            checkpoint: null,
            payload: { relink_generation: verification.generation },
          })
          .eq('organization_id', run.organization_id)
          .eq('id', collection.id);
        if (stampError)
          throw new Error(`relink reset failed: ${stampError.message}`);
        return 'advanced';
      }
    }
    if (verification?.stale && plan.includes('verify')) {
      const { data: rows, error: lookupError } = await this.db
        .from(ITEMS)
        .select('id, payload')
        .eq('organization_id', run.organization_id)
        .eq('run_id', run.id)
        .eq('stage', 'verify');
      if (lookupError)
        throw new Error(
          `verification item lookup failed: ${lookupError.message}`,
        );
      if (
        (rows ?? []).some(
          (row) =>
            row.payload?.verification_generation !== verification.generation,
        )
      ) {
        const { error: resetError } = await this.db
          .from(ITEMS)
          .update({
            status: 'pending',
            retry_count: 0,
            next_retry_at: null,
            wakeup_at: null,
            error_class: null,
            error_message: null,
            started_at: null,
            finished_at: null,
            duration_ms: null,
            payload: { verification_generation: verification.generation },
          })
          .eq('organization_id', run.organization_id)
          .eq('run_id', run.id)
          .eq('stage', 'verify')
          .in('status', ['succeeded', 'skipped', 'failed', 'dead']);
        if (resetError)
          throw new Error(`verification reset failed: ${resetError.message}`);
        return 'advanced';
      }
    }
    const verificationFailed =
      verification?.stale === true ||
      verification?.reconciliations?.some(
        (row) => row.shortfall !== null && row.shortfall > 0,
      ) === true;

    // Plan exhausted — finalize.
    const anyFailures =
      (counts.get('failed') ?? 0) + (counts.get('dead') ?? 0) > 0;

    // A run whose plan never contained some canonical stages did NOT do the whole job, even though
    // nothing failed. Reporting `succeeded` there is the worst lie this tool can tell: a Jira run
    // currently stops after `issue_types`, so "succeeded" would mean "migrated zero issues".
    // No failures + skipped stages = partially_completed.
    const unimplemented = (run.config_snapshot?.unimplemented_stages ??
      []) as string[];
    const anySkippedStages =
      Array.isArray(unimplemented) && unimplemented.length > 0;
    const finalStatus =
      anyFailures || anySkippedStages || verificationFailed
        ? 'partially_completed'
        : 'succeeded';
    const finishedAt = new Date();
    const durationMs = run.started_at
      ? finishedAt.getTime() - new Date(run.started_at).getTime()
      : null;

    let finishQuery = this.db
      .from(RUNS)
      .update({
        status: finalStatus,
        finished_at: finishedAt.toISOString(),
        duration_ms: durationMs,
      })
      .eq('organization_id', run.organization_id)
      .eq('id', run.id)
      .eq('status', 'running')
      .eq('stage_index', run.stage_index)
      .select('id');
    finishQuery =
      verification?.generation !== undefined && verification.generation !== null
        ? finishQuery.eq(
            'totals->verification->>generation',
            verification.generation,
          )
        : finishQuery.is('totals->verification->>generation', null);
    const { data: finished, error } = (await finishQuery) as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) throw new Error(`finalize failed: ${error.message}`);

    if (!finished || finished.length === 0) return 'noop';

    const reasons: string[] = [];

    if (verificationFailed)
      reasons.push('verification is stale or found missing targets');
    if (anyFailures) reasons.push('some items failed');
    if (anySkippedStages)
      reasons.push(
        `stages not implemented in this build: ${unimplemented.join(', ')}`,
      );

    await this.queue.log(
      run.organization_id,
      run.id,
      null,
      anyFailures || anySkippedStages || verificationFailed ? 'warn' : 'info',
      null,
      null,
      null,
      reasons.length > 0
        ? `Run finished: ${finalStatus} — ${reasons.join('; ')}`
        : `Run finished: ${finalStatus}`,
    );

    return 'finished';
  }

  private async rollupTotals(
    run: MigrationRunRow,
    counts: Map<MigrationItemStatus, number>,
  ): Promise<void> {
    const byStatus: Record<string, number> = {};

    for (const [status, count] of counts) byStatus[status] = count;

    const { error } = await this.db.rpc('migration_merge_run_totals', {
      p_org_id: run.organization_id,
      p_run_id: run.id,
      p_patch: { by_status: byStatus },
    });

    if (error) this.logger.warn(`rollupTotals failed: ${error.message}`);
  }

  // ───────────────────────── timeout guard ─────────────────────────

  private isTimedOut(run: MigrationRunRow): boolean {
    if (!run.started_at) return false;

    return Date.now() - new Date(run.started_at).getTime() > RUN_TIMEOUT_MS;
  }

  private async timeoutRun(run: MigrationRunRow): Promise<void> {
    const { data: updated } = (await this.db
      .from(RUNS)
      .update({
        status: 'failed',
        error_message: 'Run exceeded the 24h execution ceiling',
        finished_at: new Date().toISOString(),
      })
      .eq('organization_id', run.organization_id)
      .eq('id', run.id)
      .eq('status', 'running')
      .select('id')) as { data: { id: string }[] | null };

    if (!updated || updated.length === 0) return;

    // Open items become skipped so nothing re-leases them.
    await this.db
      .from(ITEMS)
      .update({ status: 'skipped', error_message: 'Run timed out' })
      .eq('organization_id', run.organization_id)
      .eq('run_id', run.id)
      .in('status', ['pending', 'sleeping', 'blocked', 'paused']);

    await this.queue.log(
      run.organization_id,
      run.id,
      null,
      'error',
      null,
      null,
      null,
      'Run timed out after 24h and was failed by the engine',
    );
  }
}
