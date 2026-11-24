/**
 * @fileoverview Reclaims runs whose worker is gone, and fails runs past their deadline.
 * @module src/backup/engine/backup-reaper.service
 *
 * This exists because a non-terminal run sits inside `backup_runs_one_active_per_scheme`. A run
 * abandoned by a killed process therefore blocks EVERY future run of its scheme — permanently, and
 * silently, because the scheme's `last_run_status` still shows the last good run.
 *
 * It sweeps on staleness across the whole in-flight set rather than on lease expiry, because a
 * `queued` run has no lease at all: it is in the uniqueness set but was invisible to a lease-based
 * reaper, which made "queued and abandoned" an unrecoverable state.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import {
  RUN_DEADLINE_MS,
  RUN_MAX_ATTEMPTS,
  RUN_STALE_AFTER_MS,
} from '../backup.constants';
import { IN_FLIGHT_STATUSES } from '../services/backup-runs.service';

const RUNS_TABLE = 'backup_runs';
const ITEMS_TABLE = 'backup_run_items';

interface StaleRun {
  id: string;
  organization_id: string;
  status: string;
  attempt_count: number;
  started_at: string | null;
  updated_at: string;
}

export interface ReaperStats {
  requeued: number;
  failed: number;
}

@Injectable()
export class BackupReaperService {
  private readonly logger = new Logger(BackupReaperService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async sweepOnce(): Promise<ReaperStats> {
    const stats: ReaperStats = { requeued: 0, failed: 0 };
    const staleBefore = new Date(Date.now() - RUN_STALE_AFTER_MS).toISOString();

    const { data, error } = (await this.db
      .from(RUNS_TABLE)
      .select(
        'id, organization_id, status, attempt_count, started_at, updated_at',
      )
      .in('status', IN_FLIGHT_STATUSES as unknown as string[])
      .lt('updated_at', staleBefore)
      .limit(50)) as unknown as {
      data: StaleRun[] | null;
      error: { message: string } | null;
    };

    if (error) {
      this.logger.error(`Reaper query failed: ${error.message}`);

      return stats;
    }

    for (const run of data ?? []) {
      const pastDeadline =
        run.started_at !== null &&
        Date.now() - new Date(run.started_at).getTime() > RUN_DEADLINE_MS;

      if (pastDeadline || run.attempt_count + 1 >= RUN_MAX_ATTEMPTS) {
        if (await this.failRun(run, pastDeadline)) {
          stats.failed += 1;
        }

        continue;
      }

      if (await this.requeueRun(run)) {
        stats.requeued += 1;
      }
    }

    return stats;
  }

  /**
   * Returns an abandoned run to `queued` for another worker.
   *
   * Both statuses live inside the partial unique index and `scheme_id` does not change, so the
   * index entry is simply replaced — no 23505 is possible from the transition itself.
   */
  private async requeueRun(run: StaleRun): Promise<boolean> {
    const { error } = await this.db
      .from(RUNS_TABLE)
      .update({
        status: 'queued',
        worker_id: null,
        lease_until: null,
        attempt_count: run.attempt_count + 1,
        phase_detail: 'reclaimed',
      })
      .eq('id', run.id)
      .eq('organization_id', run.organization_id)
      // Conditional on the status we read: if the real worker was alive and has moved on, this
      // matches nothing and we correctly do not drag it backwards.
      .eq('status', run.status);

    if (error) {
      this.logger.error(`Failed to requeue run ${run.id}: ${error.message}`);

      return false;
    }

    await this.resetItems(run);

    this.logger.warn(
      `Run ${run.id} was reclaimed after going quiet in '${run.status}' (attempt ${run.attempt_count + 1})`,
    );

    return true;
  }

  /**
   * Returns every item of a requeued run to `pending`.
   *
   * A retry does not resume — it writes a whole new archive from the first byte, because a partial
   * upload is discarded rather than continued. So the items it already finished on the previous
   * attempt still have to be exported again.
   *
   * Without this the retry is guaranteed to fail: the worker reads only `pending` items, finds
   * none, and throws "this run has no items to export" in milliseconds. Every reclaimed run then
   * burns its remaining attempts and ends as permanently failed, which is exactly what the run at
   * 13:47 did.
   */
  private async resetItems(run: StaleRun): Promise<void> {
    const { error } = await this.db
      .from(ITEMS_TABLE)
      .update({
        status: 'pending',
        worker_id: null,
        lease_until: null,
        started_at: null,
        finished_at: null,
      })
      .eq('run_id', run.id)
      .eq('organization_id', run.organization_id)
      // `dead` is deliberately excluded: an item that exhausted its own attempts should not be
      // revived by a run-level retry, or a permanently broken table would loop forever.
      .in('status', ['pending', 'running', 'succeeded', 'skipped', 'failed']);

    if (error) {
      // Logged, not thrown. The run is already back in the queue; the next attempt will fail
      // loudly on the empty item list rather than silently producing a short archive.
      this.logger.error(
        `Could not reset items for requeued run ${run.id}: ${error.message}`,
      );
    }
  }

  private async failRun(
    run: StaleRun,
    pastDeadline: boolean,
  ): Promise<boolean> {
    const { error } = await this.db
      .from(RUNS_TABLE)
      .update({
        status: 'failed',
        error_class: 'transient',
        error_message: pastDeadline
          ? 'The run exceeded its maximum duration.'
          : 'The run was abandoned and has run out of attempts.',
        phase_detail: pastDeadline ? 'run_deadline' : 'reclaim_exhausted',
        finished_at: new Date().toISOString(),
        worker_id: null,
        lease_until: null,
      })
      .eq('id', run.id)
      .eq('organization_id', run.organization_id)
      .eq('status', run.status);

    if (error) {
      this.logger.error(`Failed to close run ${run.id}: ${error.message}`);

      return false;
    }

    this.logger.error(
      `Run ${run.id} failed: ${pastDeadline ? 'past its deadline' : 'out of attempts'}`,
    );

    return true;
  }
}
