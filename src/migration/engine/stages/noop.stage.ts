/**
 * @fileoverview No-op probe stage — proves the leased engine loop end-to-end before any
 * real handler exists (P3+): produce seeds synthetic items (one carries a parent gate so
 * the blocked → unblocked path is exercised), processItem writes only crosswalk rows
 * (`planned` in dry-run) — ZERO XISUITE entity writes, ZERO source requests.
 */

import { Injectable } from '@nestjs/common';
import type {
  IStageHandler,
  ItemOutcome,
  MigrationRunItemRow,
  ProduceResult,
  SeedItem,
  StageContext,
} from './stage.interface';
import { PROBE_STAGE } from './stage.registry';

const DEFAULT_PROBE_ITEMS = 6;
const PAGE_SIZE = 3;

@Injectable()
export class NoopProbeStage implements IStageHandler {
  readonly stage = PROBE_STAGE;

  /** Seeds `probe_count` synthetic items in pages of 3 (exercises checkpoint resume). */
  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const options = (ctx.job.options ?? {}) as { probe_count?: number };
    const total =
      typeof options.probe_count === 'number' && options.probe_count > 0
        ? Math.min(options.probe_count, 100)
        : DEFAULT_PROBE_ITEMS;
    const checkpoint = (collectionItem.checkpoint ?? {}) as { offset?: number };
    const offset =
      typeof checkpoint.offset === 'number' && checkpoint.offset >= 0
        ? checkpoint.offset
        : 0;

    const items: SeedItem[] = [];

    for (let i = offset; i < Math.min(offset + PAGE_SIZE, total); i++) {
      items.push({
        entityType: PROBE_STAGE,
        sourceRef: `probe-${i}`,

        // The FIRST item waits on the LAST — its parent cannot be mapped yet when
        // it is first processed, guaranteeing the blocked → unblocked path runs.
        parentSourceRef:
          i === 0 && total > 1 ? `probe-${total - 1}` : undefined,
        payload: { index: i },
      });
    }

    const next = offset + PAGE_SIZE;

    await ctx.log('debug', `probe produce page offset=${offset}`, {
      seeded: items.length,
      total,
    });

    return {
      items,
      nextCheckpoint: next < total ? { offset: next } : null,
      done: next >= total,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const sourceRef = item.source_ref ?? '';

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: PROBE_STAGE,
        sourceId: sourceRef,
        targetTable: null,
        targetId: `planned:${sourceRef}`,
        status: 'planned',
      });

      return { kind: 'planned' };
    }

    // Idempotency: a prior run already mapped this synthetic entity → skip.
    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      PROBE_STAGE,
      sourceRef,
    );

    if (existing && existing.status === 'mapped') {
      return {
        kind: 'skipped',
        reason: 'already mapped',
        targetId: existing.target_id,
      };
    }

    const targetId = `noop:${sourceRef}`;

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: PROBE_STAGE,
      sourceId: sourceRef,
      targetTable: null,
      targetId,
      status: 'mapped',
    });

    return { kind: 'created', targetId };
  }
}
