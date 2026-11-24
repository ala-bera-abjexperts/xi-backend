/**
 * @fileoverview Internal scheduler driving the migration engine: guarded
 * setInterval loops (no external cron), started on module init, cleared on
 * destroy, with bounded immediate worker bursts while queued work remains.
 *
 * Kill switch: set MIGRATION_ENGINE_DISABLED=true to keep the module's API alive
 * (connections/discovery/jobs) without running any background work on this replica.
 */

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { hostname } from 'os';
import { MigrationTickService } from './migration-tick.service';
import {
  MigrationWorkerService,
  type WorkerStats,
} from './migration-worker.service';

const TICK_INTERVAL_MS = 5_000;
const WORK_INTERVAL_MS = 2_000;
const MAX_WORK_BATCHES_PER_BURST = 10;

/** MIGRATION_ENGINE_DISABLED kill switch, shared by every background migration job on a replica. */
export function isMigrationEngineDisabled(): boolean {
  return ['true', '1', 'yes'].includes(
    (process.env.MIGRATION_ENGINE_DISABLED || '').trim().toLowerCase(),
  );
}

@Injectable()
export class MigrationCronService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MigrationCronService.name);
  private readonly workerId = `${hostname()}:${process.pid}`;
  private tickTimer: NodeJS.Timeout | null = null;
  private workTimer: NodeJS.Timeout | null = null;
  private isTicking = false;
  private isWorking = false;
  private isStopping = false;

  constructor(
    private readonly tickService: MigrationTickService,
    private readonly workerService: MigrationWorkerService,
  ) {}

  private get disabled(): boolean {
    return isMigrationEngineDisabled();
  }

  onModuleInit(): void {
    if (this.disabled) {
      this.logger.log(
        'Migration engine disabled via MIGRATION_ENGINE_DISABLED',
      );

      return;
    }

    this.logger.log(
      `Starting migration engine scheduler (worker ${this.workerId})`,
    );

    this.tickTimer = setInterval(() => void this.runTick(), TICK_INTERVAL_MS);
    this.workTimer = setInterval(() => void this.runWork(), WORK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.isStopping = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.workTimer) clearInterval(this.workTimer);
  }

  private async runTick(): Promise<void> {
    if (this.isTicking) return;

    this.isTicking = true;

    try {
      const stats = await this.tickService.runTick();

      if (
        stats.sleepersWoken > 0 ||
        stats.itemsUnblocked > 0 ||
        stats.orphansFailed > 0 ||
        stats.stagesAdvanced > 0 ||
        stats.runsFinished > 0 ||
        stats.runsTimedOut > 0
      ) {
        this.logger.log(`[tick] ${JSON.stringify(stats)}`);

        // Newly runnable work — kick the worker without waiting for its interval.
        if (!this.isWorking) void this.runWork();
      }
    } catch (err) {
      this.logger.error(`[tick] error: ${String(err)}`);
    } finally {
      this.isTicking = false;
    }
  }

  private async runWork(): Promise<void> {
    if (this.isWorking || this.isStopping) return;

    this.isWorking = true;

    try {
      let stats: WorkerStats;
      let batches = 0;

      do {
        stats = await this.workerService.runWorkerLoop(this.workerId);
        batches++;

        if (stats.leased > 0) {
          this.logger.log(`[work] ${JSON.stringify(stats)}`);
        }
      } while (
        stats.leased > 0 &&
        batches < MAX_WORK_BATCHES_PER_BURST &&
        !this.isStopping
      );
    } catch (err) {
      this.logger.error(`[work] error: ${String(err)}`);
    } finally {
      this.isWorking = false;
    }
  }
}
