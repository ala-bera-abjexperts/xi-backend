// Internal cron scheduler — runs tick + worker automatically without external cron calls.

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AutomationTickService } from './automation-tick.service';
import { AutomationWorkerService } from './automation-worker.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { claimCronSlot, releaseCronSlot } from '../common/utils/cron-claim';
import { isOnPremReadOnly } from '../on-prem-license/read-only-flag';

const TICK_INTERVAL_MS = 2_000; // every 2 seconds
const WORK_INTERVAL_MS = 2_000; // every 2 seconds
/** One tick at a time across every replica (cron_run_state row). */
const TICK_LEASE_JOB = 'automation_tick_lease';
const TICK_LEASE_MS = 120_000;

@Injectable()
export class AutomationCronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutomationCronService.name);
  private tickTimer: NodeJS.Timeout | null = null;
  private workTimer: NodeJS.Timeout | null = null;
  private isTicking = false;
  private isWorking = false;
  private pendingTrigger = false;
  private stopping = false;
  private tickInFlight: Promise<void> | null = null;
  private workInFlight: Promise<void> | null = null;

  constructor(
    private readonly tickService: AutomationTickService,
    private readonly workerService: AutomationWorkerService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  onModuleInit(): void {
    // The test runner process loads this module too, but workflow automations belong to the API.
    if (process.env.TM_RUNNER_WORKER === '1') return;

    this.logger.log('Starting internal cron scheduler');

    // Run immediately on startup, then on interval
    void this.runTick();
    void this.runWork();

    this.tickTimer = setInterval(() => void this.runTick(), TICK_INTERVAL_MS);
    this.workTimer = setInterval(() => void this.runWork(), WORK_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.workTimer) clearInterval(this.workTimer);
    // Drain: the worker stops after its current batch; a tick releases its lease in `finally`.
    await Promise.allSettled([this.tickInFlight, this.workInFlight]);
    this.logger.log(
      'Internal cron scheduler stopped (in-flight work drained, tick lease released)',
    );
  }

  private runTick(): Promise<void> {
    if (this.isTicking || this.stopping) return Promise.resolve();
    this.isTicking = true;
    this.tickInFlight = this.tick().finally(() => {
      this.isTicking = false;
    });
    return this.tickInFlight;
  }

  private async tick(): Promise<void> {
    // On-prem past its licence grace: read-only, so no background writes.
    if (isOnPremReadOnly()) return;
    // ponytail: lease TTL 120s; a tick longer than that could overlap another pod — upgrade path is a unique dedupe key on automation_runs
    const db = this.supabaseAdmin.getClient();
    const lease = await claimCronSlot(db, TICK_LEASE_JOB, TICK_LEASE_MS);
    if (!lease) return; // another replica is ticking

    try {
      const stats = await this.tickService.runTick();

      if (stats.outboxRelayed > 0 || stats.schedulesFired > 0) {
        this.logger.log(`[tick] ${JSON.stringify(stats)}`);
        // New runs were created — kick worker immediately without waiting for interval
        if (!this.isWorking) void this.runWork();
      } else if (stats.sleepersWoken > 0 || stats.leasesRecovered > 0) {
        this.logger.log(`[tick] ${JSON.stringify(stats)}`);
      }
    } catch (err) {
      this.logger.error(`[tick] error: ${String(err)}`);
    } finally {
      await releaseCronSlot(db, TICK_LEASE_JOB, lease);
    }
  }

  private runWork(): Promise<void> {
    if (this.isWorking || this.stopping) return Promise.resolve();
    this.isWorking = true;
    this.workInFlight = this.work().finally(() => {
      this.isWorking = false;
    });
    return this.workInFlight;
  }

  private async work(): Promise<void> {
    // On-prem past its licence grace: read-only, so no background writes.
    if (isOnPremReadOnly()) return;
    try {
      const workerId = `cron-${randomUUID()}`;
      const stats = await this.workerService.runWorkerLoop(
        workerId,
        () => this.stopping,
      );

      if (stats.dispatched > 0) {
        this.logger.log(`[work] ${JSON.stringify(stats)}`);
      }
    } catch (err) {
      this.logger.error(`[work] error: ${String(err)}`);
    }
  }

  triggerImmediately(): void {
    if (this.pendingTrigger || this.isTicking) return;
    this.pendingTrigger = true;
    setImmediate(() => {
      this.pendingTrigger = false;
      void this.runTick();
    });
  }
}
