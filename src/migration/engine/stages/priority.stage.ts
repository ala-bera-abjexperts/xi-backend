/**
 * @fileoverview `priorities` stage — one space-scoped `task_priorities` row per Jira
 * priority (global on the source, scoped to the target space for fidelity). Keys are
 * deduped ASCII slugs, aliased onto a seeded key where one exists so a localized name adopts
 * rather than duplicates. `sort_order` INVERTS the source rank: Jira lists most-urgent-first, this
 * app orders ascending = increasing urgency. No priority
 * is marked default — the org-level default keeps applying.
 */

import { ConflictException, Injectable } from '@nestjs/common';
import {
  TaskPrioritiesService,
  type TaskPriority,
} from '../../../task-priorities/task-priorities.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedPriority } from '../../model/normalized';
import { asciiSlug, asDbKey, dedupeKeys } from '../../util/slug.util';
import { seededPriorityKey } from './seeded-key.util';
import {
  blockedOnSpace,
  requireActingUser,
  resolveTargetSpace,
} from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type StageContext,
} from './stage.interface';

export const PRIORITIES_STAGE = 'priorities';
export const PRIORITY_ENTITY = 'priority';

/**
 * The priority ladder visible from a target space, memoized for the pass.
 *
 * `TaskPrioritiesService.getAll` is the SAME call `priority.stage` already uses, so the two stages
 * cannot drift on what "visible in this space" means. The memo key is the run ROW OBJECT: the worker
 * builds one context per ITEM but reuses one `run` object for every item of a pass
 * (`migration-worker.service.ts` leases a batch, then `runById` hands the same object back for each
 * item), so the ladder is read ONCE per pass — never once per issue — and the entry is dropped with
 * the pass, so a priority this same run's `priorities` stage created moments earlier is not served
 * stale from a previous pass.
 */
const visibleLadderMemo = new WeakMap<object, Promise<TaskPriority[]>>();

/** The ladder (org-wide + `spaceId`'s own rows) an issue in `spaceId` may attach, read once per pass. */
export function loadVisiblePriorityLadder(
  ctx: StageContext,
  priorities: TaskPrioritiesService,
  spaceId: string | null,
): Promise<TaskPriority[]> {
  const memoKey = ctx.run as unknown as object;
  const cached = visibleLadderMemo.get(memoKey);

  if (cached) return cached;

  const loaded = priorities.getAll(ctx.orgId, spaceId ?? undefined);
  visibleLadderMemo.set(memoKey, loaded);

  return loaded;
}

/** Whether a crosswalk target is on the ladder an issue's space can actually use. */
export function priorityVisible(
  ladder: readonly TaskPriority[],
  targetId: string,
): boolean {
  return ladder.some((row) => row.id === targetId);
}

/**
 * The same-key row THIS space exposes — organization-level first, mirroring
 * `PriorityStage.findAdoptablePriority`. Re-anchors a crosswalk row whose target belongs to another
 * space (one Jira connection, many projects, global priority ids — see `issues.stage`).
 */
export function visiblePriorityByKey(
  ladder: readonly TaskPriority[],
  key: string,
): TaskPriority | undefined {
  const wanted = key.trim().toLowerCase();
  const matches = ladder.filter(
    (row) => (row.key ?? '').trim().toLowerCase() === wanted,
  );

  return (
    matches.find((row) => !row.space_id) ??
    matches.find((row) => !!row.space_id)
  );
}

type PriorityPayload = NormalizedPriority & {
  derivedKey: string;
  /** Optional: run items produced before the direction fix carry no `sortOrder`. */
  sortOrder?: number;
};

@Injectable()
export class PriorityStage implements IStageHandler {
  readonly stage = PRIORITIES_STAGE;

  constructor(private readonly prioritiesService: TaskPrioritiesService) {}

  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'priorities stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    const priorities = await adapter.getPriorities();
    // Alias a localized name onto the seeded key BEFORE deduping, so `Mittel` adopts the existing
    // `medium` rather than minting a duplicate. See task-status.stage for why this sits inside
    // dedupeKeys rather than after it.
    const keys = dedupeKeys(
      priorities,
      (p) => {
        const slug = asciiSlug(p.name, 'priority', p.sourceId);

        return seededPriorityKey(slug) ?? asDbKey(slug, 'p');
      },
      (p) => p.sourceId,
    );

    return {
      items: priorities.map((priority) => ({
        entityType: PRIORITY_ENTITY,
        sourceRef: priority.sourceId,
        payload: {
          ...priority,
          derivedKey: keys.get(priority)!,
          // Jira lists priorities most-urgent-first (rank 0 = Highest), but this app orders
          // priorities ASCENDING = increasing urgency (the seeded ladder is lowest@1 … critical@6 in
          // every organization, and TaskPrioritiesService.getAll lists ascending). Invert the rank
          // before it becomes sort_order, or the migrated ladder renders upside down.
          //
          // `rank` itself is deliberately NOT touched: the copy recorded in the crosswalk metadata
          // drives the JQL transpiler's ordered comparisons, where 0 = most urgent.
          sortOrder: priorities.length - priority.rank,
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
    const priority = item.payload as unknown as PriorityPayload | null;

    if (!priority?.sourceId || !priority.derivedKey) {
      throw new MigrationItemError(
        'permanent',
        'Priority item is missing its payload snapshot',
      );
    }

    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      PRIORITY_ENTITY,
      priority.sourceId,
    );

    if (existing) {
      if (existing.status === 'mapped' && ctx.dryRun) {
        return {
          kind: 'skipped',
          reason: 'priority already mapped',
          targetId: existing.target_id,
        };
      }

      if (existing.status === 'planned' && ctx.dryRun) {
        return {
          kind: 'skipped',
          reason: 'already planned',
          targetId: existing.target_id,
        };
      }
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen) return blockedOnSpace(ctx);

    let visiblePriorities: TaskPriority[] | undefined;

    if (existing?.status === 'mapped') {
      // The crosswalk outlives individual target rows. A deleted or wrong-space priority id is
      // unusable for TasksService.create, so do not let a stale mapping bypass the adopt/create
      // path and fail every dependent issue with `Invalid priority_id`.
      //
      // Shared with `issues.stage` (same query, same predicate) so the two stages cannot disagree
      // on what "visible in the target space" means.
      visiblePriorities = await loadVisiblePriorityLadder(
        ctx,
        this.prioritiesService,
        spaceId,
      );
      const mappingIsVisible = priorityVisible(
        visiblePriorities,
        existing.target_id,
      );

      if (mappingIsVisible) {
        // Re-assert the SOURCE's ordering. Runs produced before the direction fix wrote
        // `sort_order = rank`, i.e. inverted, and this skip happens before `create` is ever
        // reached — so without this a re-import would leave that ladder reversed forever. The
        // mapping itself is untouched; this is still a skip.
        //
        // Known ceiling: a manual re-ordering of a migrated priority is clobbered on the next
        // re-import, which is what "re-import from source" means.
        if (priority.sortOrder !== undefined && existing.target_id) {
          try {
            await this.prioritiesService.update(
              existing.target_id,
              ctx.orgId,
              { sort_order: priority.sortOrder },
              requireActingUser(ctx),
            );
          } catch (err) {
            await ctx.log(
              'warn',
              `priorities: could not re-assert sort_order for "${priority.derivedKey}": ${(err as Error).message}`,
            );
          }
        }

        return {
          kind: 'skipped',
          reason: 'priority already mapped',
          targetId: existing.target_id,
        };
      }

      await ctx.log(
        'warn',
        `priorities: mapped priority "${priority.derivedKey}" is no longer visible in the target space; remapping`,
      );
    }

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: PRIORITY_ENTITY,
        sourceId: priority.sourceId,
        sourceKey: priority.derivedKey,
        targetTable: 'task_priorities',
        targetId: `planned:${priority.derivedKey}`,
        status: 'planned',
        metadata: {
          key: priority.derivedKey,
          rank: priority.rank,
          name: priority.name,
        },
      });

      return { kind: 'planned' };
    }

    let created: { id: string };

    // Adopt before creating, exactly as `task-status.stage` does: a German "Mittel" aliases to the
    // seeded `medium`, and minting a duplicate beside it would leave two rows in every picker.
    const adopted = await this.findAdoptablePriority(
      ctx,
      priority.derivedKey,
      spaceId ?? null,
      visiblePriorities,
    );

    if (adopted) {
      await ctx.log(
        'info',
        `priorities: adopted the existing ${adopted.scope}-level priority "${priority.derivedKey}" instead of creating a duplicate`,
      );
      created = { id: adopted.id };
    } else {
      try {
        created = await this.prioritiesService.create(
          ctx.orgId,
          {
            name: priority.name || priority.derivedKey,
            key: priority.derivedKey,
            color: priority.colorHex ?? '#6B7280',
            space_id: spaceId!,
            sort_order: priority.sortOrder ?? priority.rank,
          },
          requireActingUser(ctx),
        );
      } catch (err) {
        if (!(err instanceof ConflictException)) throw err;

        // Re-read on the racing conflict. This also recovers a run that previously died between
        // the insert and `recordMapping`: without it that key 409s on every retry, forever.
        const raced = await this.findAdoptablePriority(
          ctx,
          priority.derivedKey,
          spaceId ?? null,
        );

        if (!raced) {
          throw new MigrationItemError(
            'conflict',
            `Priority key "${priority.derivedKey}" already exists in the target space: ${err.message}`,
          );
        }

        created = { id: raced.id };
      }
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: PRIORITY_ENTITY,
      sourceId: priority.sourceId,
      sourceKey: priority.derivedKey,
      targetTable: 'task_priorities',
      targetId: created.id,
      status: 'mapped',
      metadata: {
        key: priority.derivedKey,
        rank: priority.rank,
        name: priority.name,
      },
    });

    return {
      kind: 'created',
      targetId: created.id,
      targetTable: 'task_priorities',
    };
  }

  /** Organization-level match wins over a same-space one, mirroring `task-status.stage`. */
  private async findAdoptablePriority(
    ctx: StageContext,
    key: string,
    spaceId: string | null,
    visiblePriorities?: TaskPriority[],
  ): Promise<{ id: string; scope: 'organization' | 'space' } | null> {
    const rows =
      visiblePriorities ??
      (await loadVisiblePriorityLadder(ctx, this.prioritiesService, spaceId));
    const hit = visiblePriorityByKey(rows, key);

    if (!hit) return null;

    return {
      id: hit.id,
      scope: hit.space_id ? 'space' : 'organization',
    };
  }
}
