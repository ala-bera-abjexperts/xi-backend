/**
 * @fileoverview Item queue — every `migration_run_items` state transition lives here.
 *
 * Concurrency safety rules:
 *  - Claiming is ONLY via the `lease_migration_items` RPC (FOR UPDATE SKIP LOCKED).
 *  - Every completion/fail/sleep/block update is CONDITIONAL on `status = 'running'`
 *    (and the claiming worker id) so a cancel/reclaim race can never resurrect an item.
 *  - Seeding dedupes against the partial unique index (org, run, entity_type, source_ref)
 *    by pre-checking then tolerating 23505 — safe under concurrent producers.
 *
 * All writes hand-scope `organization_id` (service-role client bypasses RLS).
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type {
  MigrationErrorClass,
  MigrationRunItemRow,
  MigrationRunRow,
  SeedItem,
} from './stages/stage.interface';

const ITEMS = 'migration_run_items';
const LOGS = 'migration_logs';
const RATE = 'migration_rate_state';

const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const SOURCE_FAILURE_COOLDOWN_MS = 60_000;
// PostgREST sends `.in()` filters in the request URI. Keep well below common
// proxy URI limits because attachment source refs are often full, long URLs.
const MAX_DEDUPE_LOOKUP_ENCODED_REFS = 4_000;

export interface LeaseResult {
  items: MigrationRunItemRow[];
}

@Injectable()
export class MigrationQueueService {
  private readonly logger = new Logger(MigrationQueueService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** Exponential backoff with ±50% jitter, capped at 5 minutes. */
  private backoffMs(retryCount: number): number {
    const base = Math.min(MAX_BACKOFF_MS, 2 ** retryCount * 1000);

    return Math.floor(base * (0.5 + Math.random() * 0.5));
  }

  // ───────────────────────────── claiming ─────────────────────────────

  async leaseItems(
    workerId: string,
    limit: number,
    leaseMs = 300_000,
  ): Promise<MigrationRunItemRow[]> {
    const { data, error } = (await this.db.rpc('lease_migration_items', {
      p_worker_id: workerId,
      p_lease_ms: leaseMs,
      p_limit: limit,
    })) as {
      data: MigrationRunItemRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      this.logger.warn(`lease_migration_items failed: ${error.message}`);
      throw new Error(`lease_migration_items failed: ${error.message}`);
    }

    return data ?? [];
  }

  // ───────────────────────────── seeding ─────────────────────────────

  /** Insert the stage's collection (producer) item — exactly one per run+stage. */
  async seedCollectionItem(
    run: MigrationRunRow,
    stage: string,
    stageOrder: number,
  ): Promise<void> {
    const { data: existing } = (await this.db
      .from(ITEMS)
      .select('id')
      .eq('organization_id', run.organization_id)
      .eq('run_id', run.id)
      .eq('stage', stage)
      .eq('item_kind', 'collection')
      .limit(1)) as { data: { id: string }[] | null };

    if (existing && existing.length > 0) return;

    const { error } = await this.db.from(ITEMS).insert({
      organization_id: run.organization_id,
      run_id: run.id,
      stage,
      stage_order: stageOrder,
      entity_type: stage,
      item_kind: 'collection',
      source_ref: null,
      status: 'pending',
    });

    if (error)
      throw new BadRequestException(
        `Failed to seed collection item for stage "${stage}": ${error.message}`,
      );
  }

  /**
   * Bulk-seed entity items, idempotently: pre-filter refs that already exist for
   * this run+entity_type, then insert row-by-row tolerating 23505 (the partial
   * unique index is the authoritative dedupe under concurrency).
   */
  async seedEntityItems(
    run: MigrationRunRow,
    stage: string,
    stageOrder: number,
    seeds: SeedItem[],
  ): Promise<number> {
    if (seeds.length === 0) return 0;

    const uniqueRefs = [...new Set(seeds.map((s) => s.sourceRef))];
    const refBatches: string[][] = [];
    let batch: string[] = [];
    let batchLength = 0;

    for (const ref of uniqueRefs) {
      // Account for encoded values, commas and the surrounding `.in.(...)` syntax.
      const refLength = encodeURIComponent(ref).length + 1;

      if (
        batch.length > 0 &&
        batchLength + refLength > MAX_DEDUPE_LOOKUP_ENCODED_REFS
      ) {
        refBatches.push(batch);
        batch = [];
        batchLength = 0;
      }

      batch.push(ref);
      batchLength += refLength;
    }

    if (batch.length > 0) refBatches.push(batch);

    const existingRows: { source_ref: string; entity_type: string }[] = [];

    for (const refs of refBatches) {
      const { data: existing, error: lookupError } = (await this.db
        .from(ITEMS)
        .select('source_ref, entity_type')
        .eq('organization_id', run.organization_id)
        .eq('run_id', run.id)
        .eq('item_kind', 'entity')
        .in('source_ref', refs)) as {
        data: { source_ref: string; entity_type: string }[] | null;
        error: { message: string } | null;
      };

      if (lookupError)
        throw new BadRequestException(
          `Seed dedupe lookup failed: ${lookupError.message}`,
        );

      existingRows.push(...(existing ?? []));
    }

    const seen = new Set(
      existingRows.map((r) => `${r.entity_type}:${r.source_ref}`),
    );
    const fresh = seeds.filter(
      (s) => !seen.has(`${s.entityType}:${s.sourceRef}`),
    );

    if (fresh.length === 0) return 0;

    const rows = fresh.map((s) => ({
      organization_id: run.organization_id,
      run_id: run.id,
      stage,
      stage_order: stageOrder,
      entity_type: s.entityType,
      item_kind: 'entity',
      source_ref: s.sourceRef,
      parent_source_ref: s.parentSourceRef ?? null,
      payload: s.payload ?? null,
      status: 'pending',
    }));

    const { error } = (await this.db.from(ITEMS).insert(rows)) as {
      error: { message: string; code?: string } | null;
    };

    if (error && error.code === '23505') {
      // Concurrent producer won the race for some rows — retry one-by-one, ignoring dupes.
      let inserted = 0;

      for (const row of rows) {
        const { error: rowError } = (await this.db.from(ITEMS).insert(row)) as {
          error: { message: string; code?: string } | null;
        };

        if (!rowError) inserted++;
        else if (rowError.code !== '23505')
          throw new BadRequestException(
            `Seed insert failed: ${rowError.message}`,
          );
      }

      return inserted;
    }

    if (error)
      throw new BadRequestException(`Seed insert failed: ${error.message}`);

    return rows.length;
  }

  // ─────────────────────── leased-item transitions ───────────────────────
  // All conditional on status='running' + worker_id so stale workers lose races.

  private async transitionLeased(
    item: MigrationRunItemRow,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const { data, error } = (await this.db
      .from(ITEMS)
      .update({ ...patch, lease_until: null, worker_id: null })
      .eq('organization_id', item.organization_id)
      .eq('id', item.id)
      .eq('status', 'running')
      .eq('worker_id', item.worker_id)
      .select('id')) as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      this.logger.warn(`Item ${item.id} transition failed: ${error.message}`);

      return false;
    }

    // 0 rows = lost the race (reclaimed lease / cancel) — the other writer wins.
    return (data ?? []).length > 0;
  }

  async completeItem(
    item: MigrationRunItemRow,
    outcome: 'succeeded' | 'skipped',
    targetId: string | null,
    durationMs: number,
  ): Promise<boolean> {
    return this.transitionLeased(item, {
      status: outcome,
      target_id: targetId,
      error_class: null,
      error_message: null,
      finished_at: new Date().toISOString(),
      duration_ms: durationMs,
    });
  }

  /** Return untouched leased work to pending when its connection enters cooldown. */
  async releaseItem(item: MigrationRunItemRow): Promise<boolean> {
    return this.transitionLeased(item, { status: 'pending' });
  }

  /**
   * Failure routing: `permanent`/`conflict` → failed immediately; otherwise retry
   * with backoff until `max_attempts`, then `dead`.
   */
  async failItem(
    item: MigrationRunItemRow,
    errorClass: MigrationErrorClass,
    message: string,
  ): Promise<boolean> {
    const truncated = message.slice(0, 2000);

    if (errorClass === 'permanent' || errorClass === 'conflict') {
      return this.transitionLeased(item, {
        status: 'failed',
        error_class: errorClass,
        error_message: truncated,
        finished_at: new Date().toISOString(),
      });
    }

    const nextRetry = item.retry_count + 1;

    if (nextRetry >= item.max_attempts) {
      return this.transitionLeased(item, {
        status: 'dead',
        retry_count: nextRetry,
        error_class: errorClass,
        error_message: truncated,
        finished_at: new Date().toISOString(),
      });
    }

    return this.transitionLeased(item, {
      status: 'pending',
      retry_count: nextRetry,
      next_retry_at: new Date(
        Date.now() + this.backoffMs(nextRetry),
      ).toISOString(),
      error_class: errorClass,
      error_message: truncated,
    });
  }

  /**
   * A source 5xx means sibling items are likely to fail too. Cool the shared
   * connection down, but keep this item on the normal bounded retry path.
   */
  async failSourceItem(
    item: MigrationRunItemRow,
    run: MigrationRunRow,
    message: string,
  ): Promise<boolean> {
    await this.coolConnection(run, SOURCE_FAILURE_COOLDOWN_MS);

    return this.failItem(item, 'transient', message);
  }

  /**
   * Rate-limited: sleep THIS item until `wakeupAt` and cool the whole connection
   * down so sibling items stop hammering the same source.
   */
  async sleepItem(
    item: MigrationRunItemRow,
    run: MigrationRunRow,
    retryAfterMs: number,
    message: string,
  ): Promise<boolean> {
    const cappedMs = Math.min(Math.max(retryAfterMs, 1000), MAX_COOLDOWN_MS);
    const wakeupAt = new Date(Date.now() + cappedMs).toISOString();

    await this.coolConnection(run, cappedMs, wakeupAt);

    return this.transitionLeased(item, {
      status: 'sleeping',
      wakeup_at: wakeupAt,
      error_class: 'rate_limited',
      error_message: message.slice(0, 2000),
    });
  }

  private async coolConnection(
    run: MigrationRunRow,
    cooldownMs: number,
    cooldownUntil = new Date(Date.now() + cooldownMs).toISOString(),
  ): Promise<void> {
    const { error: rateError } = await this.db.from(RATE).upsert(
      {
        organization_id: run.organization_id,
        connection_id: run.connection_id,
        cooldown_until: cooldownUntil,
        last_retry_after_ms: cooldownMs,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,connection_id' },
    );

    if (rateError)
      this.logger.warn(`Rate-state upsert failed: ${rateError.message}`);
  }

  /** Referential gate: parent/dependency not yet in the crosswalk. */
  async blockItem(
    item: MigrationRunItemRow,
    waitingEntityType: string,
    waitingSourceId: string,
  ): Promise<boolean> {
    return this.transitionLeased(item, {
      status: 'blocked',
      checkpoint: {
        ...(item.checkpoint ?? {}),
        waiting_entity_type: waitingEntityType,
        waiting_source_id: waitingSourceId,
      },
      error_message: `Waiting for ${waitingEntityType}:${waitingSourceId} to be migrated`,
    });
  }

  /** Producer paging: persist the cursor and return the collection item to the queue. */
  async requeueCollection(
    item: MigrationRunItemRow,
    checkpoint: Record<string, unknown>,
  ): Promise<boolean> {
    return this.transitionLeased(item, {
      status: 'pending',
      checkpoint,
    });
  }

  // ───────────────────────── tick housekeeping ─────────────────────────

  /** sleeping items whose wakeup time passed → pending. Returns rows woken. */
  async wakeSleepers(): Promise<number> {
    const { data, error } = (await this.db
      .from(ITEMS)
      .update({ status: 'pending', wakeup_at: null })
      .eq('status', 'sleeping')
      .lte('wakeup_at', new Date().toISOString())
      .select('id')) as {
      data: { id: string }[] | null;
      error: { message: string } | null;
    };

    if (error) {
      this.logger.warn(`wakeSleepers failed: ${error.message}`);

      return 0;
    }

    return (data ?? []).length;
  }

  /** Blocked items whose awaited crosswalk row now exists → pending. */
  async unblockReadyItems(): Promise<number> {
    const { data: blocked, error } = (await this.db
      .from(ITEMS)
      .select('id, organization_id, run_id, checkpoint')
      .eq('status', 'blocked')
      .limit(500)) as {
      data:
        | {
            id: string;
            organization_id: string;
            run_id: string;
            checkpoint: Record<string, unknown> | null;
          }[]
        | null;
      error: { message: string } | null;
    };

    if (error || !blocked || blocked.length === 0) return 0;

    // Resolve each run's connection once for crosswalk lookups.
    const runIds = [...new Set(blocked.map((b) => b.run_id))];
    const { data: runs } = (await this.db
      .from('migration_runs')
      .select('id, connection_id, mode')
      .in('id', runIds)) as {
      data: { id: string; connection_id: string; mode: string }[] | null;
    };
    const runById = new Map((runs ?? []).map((r) => [r.id, r]));

    let woken = 0;

    for (const item of blocked) {
      const run = runById.get(item.run_id);
      const waitingType = item.checkpoint?.waiting_entity_type as
        | string
        | undefined;
      const waitingId = item.checkpoint?.waiting_source_id as
        | string
        | undefined;

      if (!run || !waitingType || !waitingId) continue;

      const gateStatuses =
        run.mode === 'dry_run'
          ? ['mapped', 'placeholder', 'planned']
          : ['mapped', 'placeholder'];

      const { data: mapping } = (await this.db
        .from('migration_entity_map')
        .select('id')
        .eq('organization_id', item.organization_id)
        .eq('source_connection_id', run.connection_id)
        .eq('entity_type', waitingType)
        .eq('source_id', waitingId)
        .in('status', gateStatuses)
        .limit(1)) as { data: { id: string }[] | null };

      if (!mapping || mapping.length === 0) continue;

      const { data: updated } = (await this.db
        .from(ITEMS)
        .update({ status: 'pending', error_message: null })
        .eq('organization_id', item.organization_id)
        .eq('id', item.id)
        .eq('status', 'blocked')
        .select('id')) as { data: { id: string }[] | null };

      if (updated && updated.length > 0) woken++;
    }

    return woken;
  }

  // ───────────────────────────── logging ─────────────────────────────

  async log(
    orgId: string,
    runId: string,
    runItemId: string | null,
    level: 'debug' | 'info' | 'warn' | 'error',
    stage: string | null,
    entityType: string | null,
    sourceRef: string | null,
    message: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.db.from(LOGS).insert({
      organization_id: orgId,
      run_id: runId,
      run_item_id: runItemId,
      level,
      stage,
      entity_type: entityType,
      source_ref: sourceRef,
      message: message.slice(0, 4000),
      context: context ?? {},
    });

    // Logging must never break the engine.
    if (error)
      this.logger.warn(`migration_logs insert failed: ${error.message}`);
  }
}
