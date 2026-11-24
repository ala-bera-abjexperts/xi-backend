/**
 * @fileoverview The only @Cron declarations in the backup module.
 * @module src/backup/engine/backup.cron
 *
 * `ScheduleModule.forRoot()` is already registered in app.module.ts and discovers @Cron providers
 * across the whole app, so this module must NOT register it again — a third registration would be a
 * regression against the jobs that already run.
 *
 * There is deliberately no HTTP surface. The nearest precedent in this codebase, the automations
 * cron, exposes GET routes that are @Public() with no credential check at all despite comments
 * claiming otherwise; an endpoint that starts a whole-tenant export must not repeat that.
 *
 * Every tick swallows its own errors. A throwing tick that propagated would take the scheduler down
 * until the next deploy, and the next tick is thirty seconds away.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { BackupReaperService } from './backup-reaper.service';
import { BackupTickService } from './backup-tick.service';
import { BackupWorkerService } from './backup-worker.service';
import { RestoreArchiveCacheService } from './restore-archive-cache.service';

@Injectable()
export class BackupCron {
  private readonly logger = new Logger(BackupCron.name);

  /**
   * Process-local guard on the reaper only.
   *
   * NOT a correctness mechanism — that lives in the database, in the claim RPC's
   * FOR UPDATE SKIP LOCKED and the partial unique index, both of which hold across replicas. This
   * only stops one process from stacking overlapping sweeps when the database is slow.
   */
  private sweeping = false;
  private ticking = false;
  private working = false;
  private evicting = false;
  private reconciledAt = 0;

  constructor(
    private readonly tick: BackupTickService,
    private readonly reaper: BackupReaperService,
    private readonly worker: BackupWorkerService,
    private readonly archiveCache: RestoreArchiveCacheService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Off unless explicitly enabled.
   *
   * A developer machine and a production replica point at the same Supabase project in this setup.
   * Defaulting to on would let a laptop ship a customer's data to their SFTP server.
   */
  private get enabled(): boolean {
    return this.config.get<boolean>('backup.schedulerEnabled') === true;
  }

  // :07 and :37 — the existing jobs cluster on :00, :45 and every-5s, and three sweeps landing on
  // the same second is how one slow query becomes a visible latency spike.
  @Cron('7,37 * * * * *')
  async schedulerTick(): Promise<void> {
    if (!this.enabled || this.ticking) {
      return;
    }

    this.ticking = true;

    try {
      // Cheap and rare: repairs schemes whose state row never landed, which are otherwise
      // invisible to the claim forever.
      if (Date.now() - this.reconciledAt > 300_000) {
        this.reconciledAt = Date.now();
        await this.tick.reconcileMissingState();
      }

      const stats = await this.tick.tickOnce();

      if (stats.enqueued || stats.skipped) {
        this.logger.log(
          `Backup tick: ${stats.enqueued} enqueued, ${stats.skipped} skipped of ${stats.claimed} claimed`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Backup scheduler tick failed: ${(err as Error).message}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Executes queued runs.
   *
   * The in-flight guard is REQUIRED here: a backup takes minutes, so without it a 10-second tick
   * would stack a new export on top of the one still uploading. (The outbox and form-builder drains
   * now carry the same guard — a slow batch of their HTTP dispatches overlapped the same way.)
   */
  @Cron('*/10 * * * * *')
  async workerTick(): Promise<void> {
    if (!this.enabled || this.working) {
      return;
    }

    this.working = true;

    try {
      const stats = await this.worker.drainOnce();

      if (stats.ran) {
        this.logger.log(
          `Backup worker: ${stats.succeeded} succeeded, ${stats.failed} failed`,
        );
      }
    } catch (err) {
      this.logger.error(`Backup worker failed: ${(err as Error).message}`);
    } finally {
      this.working = false;
    }
  }

  @Cron('17 * * * * *')
  async reaperTick(): Promise<void> {
    if (!this.enabled || this.sweeping) {
      return;
    }

    this.sweeping = true;

    try {
      const stats = await this.reaper.sweepOnce();

      if (stats.requeued || stats.failed) {
        this.logger.warn(
          `Backup reaper: ${stats.requeued} requeued, ${stats.failed} failed`,
        );
      }
    } catch (err) {
      this.logger.error(`Backup reaper failed: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Evicts restore archives cached in Supabase Storage past their TTL.
   *
   * Separate from the reaper rather than folded into it: the reaper reclaims RUNS whose worker died,
   * and this expires a cached file. They share nothing but a clock, and the reaper is deliberately
   * kept free of dependencies on the restore engine.
   *
   * Every five minutes, not every one. A cached archive lives for a day, so the difference between
   * evicting it at 24h00m and 24h05m is nothing, and the orphan pass inside it lists a storage
   * bucket — far more expensive than the indexed delete the reaper does.
   *
   * Gated on the same `enabled` flag as the rest: a developer machine and a production replica share
   * one Supabase project here, so an ungated sweep would let a laptop delete a customer's cached
   * archives. `RestoreArchiveCacheService.lookup` enforces the same expiry on the read path, which
   * is what stops that gate from becoming a way to serve an archive forever.
   */
  @Cron('47 */5 * * * *')
  async archiveCacheTick(): Promise<void> {
    if (!this.enabled || this.evicting) {
      return;
    }

    this.evicting = true;

    try {
      const evicted = await this.archiveCache.evictExpired();

      if (evicted) {
        this.logger.log(
          `Restore archive cache: evicted ${evicted} cached archive(s)`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Restore archive cache sweep failed: ${(err as Error).message}`,
      );
    } finally {
      this.evicting = false;
    }
  }
}
