/**
 * @fileoverview `resolutions` stage — Jira resolutions → org-scoped `resolutions` rows.
 *
 * ORG-LEVEL BY CONSTRUCTION, on both sides. Jira resolutions are instance-wide (one global list
 * shared by every project), and `resolutions` has no `space_id` at all — so unlike statuses, there
 * is no scope decision to make here. This stage is the purest case of "global Jira config migrates
 * at the organization level".
 *
 * ADOPTION IS THE RULE, CREATION THE EXCEPTION. `seed_default_workflow_config()` seeds every
 * organization with exactly `done`, `wont_do`, `duplicate`, `cannot_reproduce`, and a default Jira
 * ships exactly "Done", "Won't Do", "Duplicate", "Cannot Reproduce". With correct key
 * normalization (apostrophes deleted BEFORE separators collapse — see `resolution-key.util.ts`)
 * that is a perfect 1:1, so on a stock instance this stage creates NOTHING and adopts all four.
 * Blind inserts would duplicate the seeded rows in every migrated org, forever.
 *
 * The adopt ladder has a NAME rung after the KEY rung on purpose: a customer who renamed the seeded
 * `wont_do` row to "Rejected" still has one semantic slot for it, and matching Jira's "Won't Do"
 * by name onto that renamed row beats minting a second row that means the same thing.
 *
 * NEVER calls `setDefault`. `resolutions_one_default_per_org` is a live org-wide invariant used by
 * the workflow engine's resolution post-functions; flipping it from a migration would change
 * behaviour for tasks that have nothing to do with this import. Jira has no default-resolution
 * concept to migrate anyway.
 */

import { ConflictException, Injectable } from '@nestjs/common';
import { ResolutionsService } from '../../../resolutions/resolutions.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedResolution } from '../../model/normalized';
import { normalizeResolutionKey } from './resolution-key.util';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type StageContext,
} from './stage.interface';

export const RESOLUTIONS_STAGE = 'resolutions';
export const RESOLUTION_ENTITY = 'resolution';

type ResolutionPayload = NormalizedResolution & { derivedKey: string };

@Injectable()
export class ResolutionsStage implements IStageHandler {
  readonly stage = RESOLUTIONS_STAGE;

  constructor(private readonly resolutionsService: ResolutionsService) {}

  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'resolutions stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    const resolutions = await adapter.getResolutions();

    return {
      items: resolutions.map((resolution) => ({
        entityType: RESOLUTION_ENTITY,
        sourceRef: resolution.sourceId,
        payload: {
          ...resolution,
          derivedKey: normalizeResolutionKey(resolution.name),
        } as unknown as Record<string, unknown>,
      })),
      nextCheckpoint: null,
      done: true,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const resolution = item.payload as unknown as ResolutionPayload | null;

    if (!resolution?.sourceId || !resolution.derivedKey) {
      throw new MigrationItemError(
        'permanent',
        'Resolution item is missing its payload snapshot',
      );
    }

    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      RESOLUTION_ENTITY,
      resolution.sourceId,
    );

    if (existing) {
      if (existing.status === 'mapped') {
        return {
          kind: 'skipped',
          reason: 'resolution already mapped',
          targetId: existing.target_id,
        };
      }

      if (existing.status === 'planned' && ctx.dryRun) {
        return { kind: 'skipped', reason: 'already planned' };
      }
    }

    if (ctx.dryRun) {
      await this.record(ctx, resolution, `planned:${resolution.derivedKey}`, {
        planned: true,
      });

      return { kind: 'planned' };
    }

    const found = await this.adoptOrCreate(ctx, resolution);

    await this.record(ctx, resolution, found.id, {
      key: resolution.derivedKey,
      adopted: found.method !== 'created',
      match_method: found.method,
    });

    return {
      kind: 'created',
      targetId: found.id,
      targetTable: 'resolutions',
    };
  }

  /**
   * key match → case-insensitive name match → create → conflict-and-re-read.
   *
   * `getAll` is re-read at each rung rather than cached across them: a parallel item may have
   * created a row between rungs, and four extra reads on a four-item stage is nothing.
   */
  private async adoptOrCreate(
    ctx: StageContext,
    resolution: ResolutionPayload,
  ): Promise<{ id: string; method: 'key' | 'name' | 'created' | 'raced' }> {
    const rows = await this.resolutionsService.getAll(ctx.orgId);
    const byKey = rows.find((r) => r.key === resolution.derivedKey);

    if (byKey) return { id: byKey.id, method: 'key' };

    const wanted = resolution.name.trim().toLowerCase();
    const byName = rows.find(
      (r) => (r.name ?? '').trim().toLowerCase() === wanted,
    );

    if (byName) return { id: byName.id, method: 'name' };

    try {
      const created = await this.resolutionsService.create(ctx.orgId, {
        name: resolution.name,
        key: resolution.derivedKey,
        ...(resolution.description
          ? { description: resolution.description }
          : {}),
        // Continue after the seeded rows (sort_order 1..4) rather than colliding with them.
        sort_order: 10 + resolution.sortOrder,
        is_active: true,
      });

      await ctx.log(
        'info',
        `resolutions: created "${resolution.name}" (${resolution.derivedKey}) — no seeded equivalent`,
        { key: resolution.derivedKey },
      );

      return { id: created.id, method: 'created' };
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;

      // Lost a race on UNIQUE (organization_id, key): the winner's row is the right answer.
      const reread = await this.resolutionsService.getAll(ctx.orgId);
      const winner = reread.find((r) => r.key === resolution.derivedKey);

      if (winner) return { id: winner.id, method: 'raced' };

      throw new MigrationItemError(
        'conflict',
        `Resolution key "${resolution.derivedKey}" conflicts but no matching row is readable: ${err.message}`,
      );
    }
  }

  private async record(
    ctx: StageContext,
    resolution: ResolutionPayload,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: RESOLUTION_ENTITY,
      sourceId: resolution.sourceId,
      sourceKey: resolution.name,
      targetTable: 'resolutions',
      targetId,
      status: ctx.dryRun ? 'planned' : 'mapped',
      metadata: { name: resolution.name, ...metadata },
    });
  }
}
