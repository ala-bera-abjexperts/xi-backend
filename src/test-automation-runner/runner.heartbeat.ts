import { Logger } from '@nestjs/common';

import type { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { userImageRegistries } from '../test-management/automation/custom-images/registry/custom-image-review';

export const HEARTBEAT_MS = 5_000;

// Row names in the shared cron_run_state table; the API reads the same names.
export const RUNNER_START_KEY = 'tm_runner.start';
export const RUNNER_DRAIN_KEY = 'tm_runner.drain';
export const RUNNER_START_FAILED_KEY = 'tm_runner.start_failed';
export const RUNNER_WORKER_PREFIX = 'tm_runner.worker.';
export const RUNNER_READY_PREFIX = 'tm_runner.ready.';
export const RUNNER_DRAINING_PREFIX = 'tm_runner.draining.';
export const RUNNER_NEVER = new Date(0).toISOString();

const STALE_ROWS_MS = 24 * 60 * 60 * 1000;
const STOP_WRITE_MS = 3_000;
const MAX_IDLE_MINUTES = 1440;

interface StateRow {
  job_name: string;
  last_run_at: string;
}

/** Minutes without work before a runner stops itself; unset or 0 never stops it. */
export function readIdleStopMs(
  raw = process.env.TM_RUNNER_IDLE_STOP_MINUTES,
): number {
  const minutes = Number(raw);

  if (!Number.isInteger(minutes) || minutes < 1) return 0;

  return Math.min(minutes, MAX_IDLE_MINUTES) * 60_000;
}

/** Tells the app that this runner is alive, and stops it on an admin request or after the idle time. */
export class RunnerHeartbeat {
  private readonly logger = new Logger(RunnerHeartbeat.name);
  private readonly startedAt: number;
  private timer?: NodeJS.Timeout;
  private idleSince: number | null = null;
  private firstBeat = true;
  private warned = false;
  private stopAsked = false;

  constructor(
    private readonly supabase: SupabaseAdminService,
    private readonly workerId: string,
    private readonly slots: number,
    private readonly isReady: () => boolean,
    private readonly idleStopMs: number,
    private readonly onStop: (reason: string) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  private get client() {
    return this.supabase.getClient();
  }

  private get workerKey(): string {
    return `${RUNNER_WORKER_PREFIX}${this.workerId}`;
  }

  private get readyKey(): string {
    return `${RUNNER_READY_PREFIX}${this.workerId}`;
  }

  private get drainingKey(): string {
    return `${RUNNER_DRAINING_PREFIX}${this.workerId}`;
  }

  start(): void {
    void this.removeStaleRows().catch(() => undefined);
    void this.beat();
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_MS);
  }

  /** A stopped runner must not look alive, so its rows go; a slow database can't hold up the exit. */
  async stop(): Promise<void> {
    clearInterval(this.timer);

    let timeout: NodeJS.Timeout | undefined;
    const remove = this.client
      .from('cron_run_state')
      .delete()
      .in('job_name', [this.workerKey, this.readyKey, this.drainingKey]);
    const limit = new Promise((resolve) => {
      timeout = setTimeout(resolve, STOP_WRITE_MS);
    });

    await Promise.race([remove, limit]).catch(() => undefined);
    clearTimeout(timeout);
  }

  async beat(): Promise<void> {
    try {
      const stamp = new Date(this.now()).toISOString();
      const rows: StateRow[] = [
        { job_name: this.workerKey, last_run_at: stamp },
      ];

      if (this.isReady()) {
        rows.push({ job_name: this.readyKey, last_run_at: stamp });
      }

      // Lets the app show "Stopping" while the running tests finish.
      if (this.stopAsked) {
        rows.push({ job_name: this.drainingKey, last_run_at: stamp });
      }

      const { error } = await this.client.from('cron_run_state').upsert(rows);

      if (error) throw new Error(error.message);

      if (this.firstBeat) {
        await this.endStartRequest();
        this.firstBeat = false;
      }

      if (this.stopAsked) return;

      if (await this.stopRequested()) this.askStop('stop request');
      else if (this.idleStopMs > 0 && (await this.idleLongEnough())) {
        this.askStop('idle');
      }

      this.warned = false;
    } catch (error) {
      // The runner keeps working without its status; one warning per outage is enough.
      if (!this.warned) {
        this.logger.warn(
          `Could not save the test runner status: ${(error as Error).message}`,
        );
      }

      this.warned = true;
    }
  }

  private askStop(reason: string): void {
    if (this.stopAsked) return;

    this.stopAsked = true;
    this.onStop(reason);
  }

  private async endStartRequest(): Promise<void> {
    const { error } = await this.client
      .from('cron_run_state')
      .update({ last_run_at: RUNNER_NEVER })
      .eq('job_name', RUNNER_START_KEY);

    if (error) throw new Error(error.message);
  }

  /** Only a request made after this runner started applies, so an old Stop never ends a new runner. */
  private async stopRequested(): Promise<boolean> {
    const { data, error } = await this.client
      .from('cron_run_state')
      .select('last_run_at')
      .eq('job_name', RUNNER_DRAIN_KEY)
      .maybeSingle();

    if (error) throw new Error(error.message);

    const row = data as Pick<StateRow, 'last_run_at'> | null;
    const requestedAt = Date.parse(row?.last_run_at ?? '');

    return Number.isFinite(requestedAt) && requestedAt > this.startedAt;
  }

  /** Idle means none of this runner's places is busy and no Docker run waits anywhere. */
  private async idleLongEnough(): Promise<boolean> {
    const slotIds = Array.from(
      { length: this.slots },
      (_, slot) => `${this.workerId}-${slot + 1}`,
    );
    const [busy, queued, checking] = await Promise.all([
      this.client
        .from('test_automation_runs')
        .select('id', { count: 'exact', head: true })
        .in('status', ['RUNNING', 'UPLOADING'])
        .in('worker_id', slotIds),
      this.client
        .from('test_automation_runs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'QUEUED')
        .eq('kind', 'docker')
        .is('cancel_requested_at', null),
      // Images waiting for or in their check, when this runner checks images.
      userImageRegistries().length > 0
        ? this.client
            .from('test_automation_user_images')
            .select('id', { count: 'exact', head: true })
            .eq('status', 'checking')
        : { count: 0, error: null },
    ]);

    if (busy.error) throw new Error(busy.error.message);
    if (queued.error) throw new Error(queued.error.message);
    if (checking.error) throw new Error(checking.error.message);

    if (
      (busy.count ?? 0) > 0 ||
      (queued.count ?? 0) > 0 ||
      (checking.count ?? 0) > 0
    ) {
      this.idleSince = null;

      return false;
    }

    this.idleSince ??= this.now();

    return this.now() - this.idleSince >= this.idleStopMs;
  }

  /** Rows of runners that crashed long ago. */
  private async removeStaleRows(): Promise<void> {
    const before = new Date(this.now() - STALE_ROWS_MS).toISOString();

    for (const prefix of [
      RUNNER_WORKER_PREFIX,
      RUNNER_READY_PREFIX,
      RUNNER_DRAINING_PREFIX,
    ]) {
      await this.client
        .from('cron_run_state')
        .delete()
        .like('job_name', `${prefix}%`)
        .lt('last_run_at', before);
    }
  }
}
