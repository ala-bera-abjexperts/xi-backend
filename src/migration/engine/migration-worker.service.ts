/**
 * @fileoverview The migration worker — one budget-bounded pass per invocation:
 * lease a batch via the SKIP-LOCKED RPC, resolve each item's run/job/handler,
 * enforce the generic parent gate, dispatch to the stage handler, and route the
 * outcome (or typed error) back through the queue's conditional transitions.
 *
 * Adapters are built lazily and memoized PER PASS per connection — a pass over
 * 25 items on one connection performs at most one SSRF-validate + detection.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { MigrationConnectionsService } from '../services/migration-connections.service';
import { MigrationEntityMapService } from '../services/migration-entity-map.service';
import { RequiredJiraIdentityError } from '../adapters/jira/jira-adapter.base';
import { AtlassianRequestError } from '../adapters/http/atlassian-http-client';
import type { ISourceAdapter } from '../adapters/source-adapter.interface';
import { MigrationQueueService } from './migration-queue.service';
import { StageRegistry } from './stages/stage.registry';
import {
  MigrationItemError,
  type MigrationErrorClass,
  type MigrationJobContext,
  type MigrationRunItemRow,
  type MigrationRunRow,
  type StageContext,
} from './stages/stage.interface';

const LEASE_BATCH = 25;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

export interface WorkerStats {
  leased: number;
  succeeded: number;
  skipped: number;
  blocked: number;
  failed: number;
  produced: number;
}

@Injectable()
export class MigrationWorkerService {
  private readonly logger = new Logger(MigrationWorkerService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly queue: MigrationQueueService,
    private readonly registry: StageRegistry,
    private readonly connectionsService: MigrationConnectionsService,
    private readonly entityMap: MigrationEntityMapService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async runWorkerLoop(workerId: string): Promise<WorkerStats> {
    const stats: WorkerStats = {
      leased: 0,
      succeeded: 0,
      skipped: 0,
      blocked: 0,
      failed: 0,
      produced: 0,
    };

    const items = await this.queue.leaseItems(workerId, LEASE_BATCH);

    stats.leased = items.length;

    if (items.length === 0) return stats;

    // Batch-load the runs + jobs behind the claimed items (org-scoped per row).
    const runById = await this.loadRuns(items);
    const jobById = await this.loadJobs([...runById.values()]);

    // Per-pass adapter memo: connection_id → Promise<ISourceAdapter>.
    const adapterMemo = new Map<string, Promise<ISourceAdapter>>();
    const sourceBaseUrlMemo = new Map<string, Promise<string | null>>();
    const coolingConnections = new Set<string>();
    const stoppedRuns = new Set<string>();

    for (const item of items) {
      const run = runById.get(item.run_id);
      const job = run ? jobById.get(run.job_id) : undefined;

      if (!run || !job) {
        await this.queue.failItem(item, 'permanent', 'Run or job row missing');
        stats.failed++;
        continue;
      }

      if (
        stoppedRuns.has(run.id) ||
        coolingConnections.has(run.connection_id)
      ) {
        await this.queue.releaseItem(item);
        continue;
      }

      const ctx = this.buildContext(
        run,
        job,
        adapterMemo,
        sourceBaseUrlMemo,
        item,
      );

      try {
        if (item.item_kind === 'collection') {
          await this.processCollection(ctx, item, run, stats);
        } else {
          await this.processEntity(ctx, item, run, stats);
        }
      } catch (err) {
        if (
          err instanceof RequiredJiraIdentityError ||
          (item.stage === 'users' &&
            item.item_kind === 'collection' &&
            job.source_kind === 'jira_project' &&
            err instanceof AtlassianRequestError &&
            [401, 403].includes(err.status))
        ) {
          const { error } = await this.db
            .from('migration_runs')
            .update({
              status: 'failed',
              finished_at: new Date().toISOString(),
              error_message: (err as Error).message,
            })
            .eq('organization_id', run.organization_id)
            .eq('id', run.id)
            .eq('status', 'running');
          if (error)
            throw new Error(
              `Could not stop unauthorized migration: ${error.message}`,
            );
          stoppedRuns.add(run.id);
        }
        if (await this.routeError(item, run, err, stats)) {
          coolingConnections.add(run.connection_id);
        }
      }
    }

    return stats;
  }

  // ───────────────────────── item processing ─────────────────────────

  private async processCollection(
    ctx: StageContext,
    item: MigrationRunItemRow,
    run: MigrationRunRow,
    stats: WorkerStats,
  ): Promise<void> {
    const handler = this.registry.get(item.stage);

    if (!handler) {
      await this.queue.failItem(
        item,
        'permanent',
        `No handler registered for stage "${item.stage}"`,
      );
      stats.failed++;

      return;
    }

    const started = Date.now();
    const result = await handler.produce(ctx, item);
    const seeded = await this.queue.seedEntityItems(
      run,
      item.stage,
      item.stage_order,
      result.items,
    );

    stats.produced += seeded;

    if (result.done) {
      await this.queue.completeItem(
        item,
        'succeeded',
        null,
        Date.now() - started,
      );
      stats.succeeded++;
      await this.queue.log(
        run.organization_id,
        run.id,
        item.id,
        'info',
        item.stage,
        item.entity_type,
        null,
        `Stage "${item.stage}" fully seeded`,
        { seededThisPage: seeded },
      );
    } else {
      await this.queue.requeueCollection(item, result.nextCheckpoint ?? {});
    }
  }

  private async processEntity(
    ctx: StageContext,
    item: MigrationRunItemRow,
    run: MigrationRunRow,
    stats: WorkerStats,
  ): Promise<void> {
    const handler = this.registry.get(item.stage);

    if (!handler) {
      await this.queue.failItem(
        item,
        'permanent',
        `No handler registered for stage "${item.stage}"`,
      );
      stats.failed++;

      return;
    }

    // Generic referential gate: same-entity-type parent must already be mapped.
    if (item.parent_source_ref) {
      const open = await this.entityMap.isGateOpen(
        run.organization_id,
        run.connection_id,
        item.entity_type,
        item.parent_source_ref,
        run.mode === 'dry_run',
      );

      if (!open) {
        await this.queue.blockItem(
          item,
          item.entity_type,
          item.parent_source_ref,
        );
        stats.blocked++;

        return;
      }
    }

    const started = Date.now();
    const outcome = await handler.processItem(ctx, item);
    const duration = Date.now() - started;

    switch (outcome.kind) {
      case 'created':
      case 'updated':
        await this.queue.completeItem(
          item,
          'succeeded',
          outcome.targetId,
          duration,
        );
        stats.succeeded++;
        break;

      case 'planned':
        await this.queue.completeItem(item, 'succeeded', null, duration);
        stats.succeeded++;
        break;

      case 'skipped':
        await this.queue.completeItem(
          item,
          'skipped',
          outcome.targetId ?? null,
          duration,
        );
        stats.skipped++;
        break;

      case 'blocked':
        await this.queue.blockItem(
          item,
          outcome.waitingFor.entityType,
          outcome.waitingFor.sourceId,
        );
        stats.blocked++;
        break;
    }
  }

  // ───────────────────────── error routing ─────────────────────────

  private async routeError(
    item: MigrationRunItemRow,
    run: MigrationRunRow,
    err: unknown,
    stats: WorkerStats,
  ): Promise<boolean> {
    stats.failed++;
    let connectionCooling = false;

    if (err instanceof MigrationItemError) {
      if (err.errorClass === 'rate_limited') {
        await this.queue.sleepItem(
          item,
          run,
          err.retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
          err.message,
        );
        connectionCooling = true;
      } else {
        await this.queue.failItem(item, err.errorClass, err.message);
      }
    } else if (err instanceof AtlassianRequestError) {
      const cls = this.classifyHttpStatus(err.status);

      if (cls === 'rate_limited') {
        await this.queue.sleepItem(
          item,
          run,
          DEFAULT_RATE_LIMIT_COOLDOWN_MS,
          err.message,
        );
        connectionCooling = true;
      } else if (err.status >= 500 && err.status < 600) {
        await this.queue.failSourceItem(item, run, err.message);
        connectionCooling = true;
      } else {
        await this.queue.failItem(item, cls, err.message);
      }
    } else {
      await this.queue.failItem(
        item,
        'transient',
        (err as Error).message ?? String(err),
      );
    }

    await this.queue.log(
      run.organization_id,
      run.id,
      item.id,
      'error',
      item.stage,
      item.entity_type,
      item.source_ref,
      (err as Error).message ?? String(err),
    );

    return connectionCooling;
  }

  /** 429 sleeps; auth/permission/not-found never retry; everything else backs off. */
  private classifyHttpStatus(status: number): MigrationErrorClass {
    if (status === 429) return 'rate_limited';

    if (status === 401 || status === 403 || status === 404 || status === 410)
      return 'permanent';

    return 'transient';
  }

  // ───────────────────────── context assembly ─────────────────────────

  private buildContext(
    run: MigrationRunRow,
    job: MigrationJobContext,
    adapterMemo: Map<string, Promise<ISourceAdapter>>,
    sourceBaseUrlMemo: Map<string, Promise<string | null>>,
    item: MigrationRunItemRow,
  ): StageContext {
    const queue = this.queue;
    const connections = this.connectionsService;

    return {
      orgId: run.organization_id,
      run,
      job,
      dryRun: run.mode === 'dry_run',
      entityMap: this.entityMap,
      getAdapter(): Promise<ISourceAdapter> {
        let adapter = adapterMemo.get(run.connection_id);

        if (!adapter) {
          adapter = connections.buildAdapter(
            run.organization_id,
            run.connection_id,
          );
          adapterMemo.set(run.connection_id, adapter);
        }

        return adapter;
      },
      getSourceBaseUrl(): Promise<string | null> {
        const cached = sourceBaseUrlMemo.get(run.connection_id);

        if (cached) return cached;

        const loaded = connections.getBaseUrl(
          run.organization_id,
          run.connection_id,
        );
        sourceBaseUrlMemo.set(run.connection_id, loaded);

        return loaded;
      },
      log(level, message, context) {
        return queue.log(
          run.organization_id,
          run.id,
          item.id,
          level,
          item.stage,
          item.entity_type,
          item.source_ref,
          message,
          context,
        );
      },
    };
  }

  private async loadRuns(
    items: MigrationRunItemRow[],
  ): Promise<Map<string, MigrationRunRow>> {
    const runIds = [...new Set(items.map((i) => i.run_id))];

    const { data, error } = (await this.db
      .from('migration_runs')
      .select('*')
      .in('id', runIds)) as {
      data: MigrationRunRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      this.logger.warn(`loadRuns failed: ${error.message}`);

      return new Map();
    }

    return new Map((data ?? []).map((r) => [r.id, r]));
  }

  private async loadJobs(
    runs: MigrationRunRow[],
  ): Promise<Map<string, MigrationJobContext>> {
    const jobIds = [...new Set(runs.map((r) => r.job_id))];

    if (jobIds.length === 0) return new Map();

    const { data, error } = (await this.db
      .from('migration_jobs')
      .select(
        'id, connection_id, source_kind, source_ref, target_space_id, scope, options',
      )
      .in('id', jobIds)) as {
      data: MigrationJobContext[] | null;
      error: { message: string } | null;
    };

    if (error) {
      this.logger.warn(`loadJobs failed: ${error.message}`);

      return new Map();
    }

    return new Map((data ?? []).map((j) => [j.id, j]));
  }
}
