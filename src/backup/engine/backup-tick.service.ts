/**
 * @fileoverview Scheduler tick — turns a due scheme into a queued run.
 * @module src/backup/engine/backup-tick.service
 *
 * Enqueues only. Nothing here exports, compresses or uploads anything; the worker does that under
 * its own lease. A tick that held a multi-minute await would stall every other scheme behind it.
 *
 * The invariant that matters: EVERY path through a claimed scheme ends by writing a real
 * `next_run_at` and releasing the lease. The claim already advanced the schedule provisionally, so
 * even a crash here is bounded — but a path that silently returns would leave the scheme firing a
 * minute late, forever, with nothing in the logs to say why.
 */

import { Injectable, Logger } from '@nestjs/common';
import { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { SCHEME_LEASE_MS, WORKER_ID } from '../backup.constants';
import {
  computeNextRunAt,
  resolveMisfire,
  type ScheduleDefinition,
} from '../services/backup-schedule.service';
import { BackupRunsService } from '../services/backup-runs.service';
import { BackupQueueService, type DueScheme } from './backup-queue.service';

const STATE_TABLE = 'backup_schedule_state';
const SCHEMES_TABLE = 'backup_schemes';

type SkipReason = 'overlap' | 'missed' | 'entitlement' | 'config';

interface SchemeScheduleRow {
  id: string;
  cron_expression: string | null;
  timezone: string;
  schedule_enabled: boolean;
  status: string;
}

export interface TickStats {
  claimed: number;
  enqueued: number;
  skipped: number;
}

@Injectable()
export class BackupTickService {
  private readonly logger = new Logger(BackupTickService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly queue: BackupQueueService,
    private readonly runs: BackupRunsService,
    private readonly organizationModules: OrganizationModulesService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** Split out from the @Cron so tests can drive one pass without a timer. */
  async tickOnce(): Promise<TickStats> {
    const stats: TickStats = { claimed: 0, enqueued: 0, skipped: 0 };
    const due = await this.queue.claimDueSchemes(WORKER_ID, SCHEME_LEASE_MS);

    stats.claimed = due.length;

    for (const scheme of due) {
      try {
        const enqueued = await this.processScheme(scheme);

        if (enqueued) {
          stats.enqueued += 1;
        } else {
          stats.skipped += 1;
        }
      } catch (err) {
        stats.skipped += 1;
        this.logger.error(
          `Scheme ${scheme.scheme_id} failed during scheduling: ${(err as Error).message}`,
        );

        // The lease must not outlive the failure, and the schedule must still move.
        await this.release(scheme, null, 'config');
      }
    }

    return stats;
  }

  private async processScheme(scheme: DueScheme): Promise<boolean> {
    // Per claim, never cached: an admin who disables Backup must stop the next run, not the one
    // after the cache expires. A cron has no request, so the controller's gate cannot help here.
    const moduleEnabled = await this.organizationModules.isEnabled(
      scheme.organization_id,
      'backup',
    );

    if (!moduleEnabled) {
      this.logger.log(
        `Scheme ${scheme.scheme_id} skipped — the Backup module is disabled for its organization`,
      );
      await this.release(scheme, null, 'entitlement', true);

      return false;
    }

    const row = await this.loadSchedule(scheme);

    if (
      !row?.cron_expression ||
      !row.schedule_enabled ||
      row.status !== 'active'
    ) {
      // Edited or paused between the claim and now. Deactivate rather than re-evaluate: the write
      // path re-activates it when the scheme becomes schedulable again.
      await this.release(scheme, null, 'config', true);

      return false;
    }

    const definition: ScheduleDefinition = {
      cronExpression: row.cron_expression,
      timezone: row.timezone,
    };

    const now = new Date();
    const decision = resolveMisfire({
      schedule: definition,
      dueAt: new Date(scheme.due_at),
      now,
    });

    if (decision.action === 'skip') {
      this.logger.warn(
        `Scheme ${scheme.scheme_id} missed ${decision.missedOccurrences} window(s); ` +
          'running once at the next scheduled time rather than catching up',
      );
      await this.release(
        scheme,
        decision.nextRunAt,
        'missed',
        false,
        decision.missedOccurrences,
      );

      return false;
    }

    try {
      await this.runs.createRun({
        organizationId: scheme.organization_id,
        schemeId: scheme.scheme_id,
        triggerSource: 'schedule',
        // No acting user: a scheduled run is the system's, and attributing it to whoever created
        // the scheme would survive them leaving the company.
        userId: null,
      });

      await this.release(scheme, decision.nextRunAt, null);

      return true;
    } catch (err) {
      const message = (err as Error).message ?? '';
      // An overlap is a normal state, not a failure: the previous run is simply still going. It
      // must never alert, but it must be recorded, or a permanently wedged run looks like silence.
      const reason: SkipReason = /already running/i.test(message)
        ? 'overlap'
        : 'config';

      if (reason === 'config') {
        this.logger.error(
          `Scheme ${scheme.scheme_id} could not be enqueued: ${message}`,
        );
      }

      await this.release(scheme, decision.nextRunAt, reason);

      return false;
    }
  }

  private async loadSchedule(
    scheme: DueScheme,
  ): Promise<SchemeScheduleRow | null> {
    const { data, error } = (await this.db
      .from(SCHEMES_TABLE)
      .select('id, cron_expression, timezone, schedule_enabled, status')
      .eq('id', scheme.scheme_id)
      .eq('organization_id', scheme.organization_id)
      .maybeSingle()) as unknown as {
      data: SchemeScheduleRow | null;
      error: { message: string; code?: string } | null;
    };

    if (error && error.code !== 'PGRST116') {
      this.logger.warn(
        `Could not load scheme ${scheme.scheme_id}: ${error.message}`,
      );
    }

    return data;
  }

  /**
   * Writes the real next_run_at and gives the lease back.
   *
   * Called on every path, including failures. When `nextRunAt` is null the provisional value the
   * claim already wrote is left in place, so the scheme retries shortly instead of spinning.
   */
  private async release(
    scheme: DueScheme,
    nextRunAt: Date | null,
    skipReason: SkipReason | null,
    deactivate = false,
    missedOccurrences = 0,
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      lease_until: null,
      worker_id: null,
      last_evaluated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (nextRunAt) {
      patch.next_run_at = nextRunAt.toISOString();
    }

    if (deactivate) {
      patch.is_active = false;
    }

    if (skipReason) {
      patch.last_skip_reason = skipReason;
      patch.last_skip_at = new Date().toISOString();
    }

    if (missedOccurrences > 0) {
      patch.missed_occurrences = missedOccurrences;
    }

    const { error } = await this.db
      .from(STATE_TABLE)
      .update(patch)
      .eq('scheme_id', scheme.scheme_id)
      .eq('organization_id', scheme.organization_id)
      // Only if we still hold it. A reaped lease belongs to someone else now, and overwriting
      // their next_run_at would double-fire the scheme.
      .eq('worker_id', WORKER_ID);

    if (error) {
      this.logger.error(
        `Failed to release scheme ${scheme.scheme_id}: ${error.message}`,
      );
    }
  }

  /**
   * Creates or repairs the state row for a scheme that should be schedulable.
   *
   * Self-healing on purpose: a scheme whose state write failed at save time would otherwise be
   * invisible to the claim forever, and nothing about the scheme itself would look wrong.
   */
  async reconcileMissingState(): Promise<number> {
    const { data, error } = (await this.db
      .from(SCHEMES_TABLE)
      .select('id, organization_id, cron_expression, timezone')
      .eq('status', 'active')
      .eq('schedule_enabled', true)
      .not('cron_expression', 'is', null)) as unknown as {
      data:
        | {
            id: string;
            organization_id: string;
            cron_expression: string;
            timezone: string;
          }[]
        | null;
      error: { message: string } | null;
    };

    if (error) {
      this.logger.warn(`Could not reconcile schedule state: ${error.message}`);

      return 0;
    }

    const schemes = data ?? [];

    if (!schemes.length) {
      return 0;
    }

    const { data: existing } = (await this.db
      .from(STATE_TABLE)
      .select('scheme_id')
      .in(
        'scheme_id',
        schemes.map((s) => s.id),
      )) as unknown as { data: { scheme_id: string }[] | null };

    const known = new Set((existing ?? []).map((row) => row.scheme_id));
    const missing = schemes.filter((s) => !known.has(s.id));

    for (const scheme of missing) {
      try {
        const nextRunAt = computeNextRunAt(
          {
            cronExpression: scheme.cron_expression,
            timezone: scheme.timezone,
          },
          new Date(),
        );

        await this.db.from(STATE_TABLE).upsert(
          {
            scheme_id: scheme.id,
            organization_id: scheme.organization_id,
            is_active: true,
            next_run_at: nextRunAt.toISOString(),
          },
          { onConflict: 'scheme_id' },
        );

        this.logger.log(`Recreated schedule state for scheme ${scheme.id}`);
      } catch (err) {
        // A bad stored timezone lands here. Leaving it unscheduled is correct — activation
        // validates, so this row was edited outside the application.
        this.logger.error(
          `Cannot schedule scheme ${scheme.id}: ${(err as Error).message}`,
        );
      }
    }

    return missing.length;
  }
}
