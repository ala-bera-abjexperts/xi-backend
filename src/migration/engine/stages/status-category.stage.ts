/**
 * @fileoverview `status_categories` stage — Jira's three semantic buckets map onto the
 * org-level SYSTEM categories seeded at org creation (new → todo, indeterminate →
 * in_progress, done → done), so the default path REUSES them (no duplicate "To Do"
 * per space). Only when an org is missing a system category (pre-seed orgs) is a
 * space-scoped fallback created.
 */

import { ConflictException, Injectable } from '@nestjs/common';
import { StatusCategoriesService } from '../../../status-categories/status-categories.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedStatusCategory } from '../../model/normalized';
import {
  blockedOnSpace,
  requireActingUser,
  resolveTargetSpace,
  scopeIncludes,
} from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type StageContext,
} from './stage.interface';

export const STATUS_CATEGORIES_STAGE = 'status_categories';
export const STATUS_CATEGORY_ENTITY = 'status_category';

/** Jira statusCategory.key → the org's seeded system category key. */
const CATEGORY_KEY_MAP: Record<NormalizedStatusCategory, string> = {
  new: 'todo',
  indeterminate: 'in_progress',
  done: 'done',
};

const FALLBACK_COLORS: Record<NormalizedStatusCategory, string> = {
  new: '#6B7280',
  indeterminate: '#3B82F6',
  done: '#22C55E',
};

const FALLBACK_NAMES: Record<NormalizedStatusCategory, string> = {
  new: 'To Do',
  indeterminate: 'In Progress',
  done: 'Done',
};

@Injectable()
export class StatusCategoryStage implements IStageHandler {
  readonly stage = STATUS_CATEGORIES_STAGE;

  constructor(private readonly categoriesService: StatusCategoriesService) {}

  /** One item per DISTINCT category present in the project's statuses (≤ 3). */
  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log(
        'warn',
        'status_categories stage: non-Jira source — seeding 0',
      );

      return { items: [], nextCheckpoint: null, done: true };
    }

    const statuses = await adapter.getStatuses(ctx.job.source_ref);
    // Boards may reference instance statuses outside the project workflow.
    const present = scopeIncludes(ctx, 'include_boards')
      ? Object.keys(CATEGORY_KEY_MAP)
      : [...new Set(statuses.map((s) => s.statusCategory))];

    return {
      items: present.map((category) => ({
        entityType: STATUS_CATEGORY_ENTITY,
        sourceRef: category,
      })),
      nextCheckpoint: null,
      done: true,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const category = item.source_ref as NormalizedStatusCategory | null;

    if (!category || !(category in CATEGORY_KEY_MAP)) {
      throw new MigrationItemError(
        'permanent',
        `Unknown status category "${item.source_ref ?? ''}"`,
      );
    }

    const existing = await ctx.entityMap.getExistingTarget(
      ctx.orgId,
      ctx.job.connection_id,
      STATUS_CATEGORY_ENTITY,
      category,
      'status_categories',
    );

    if (existing) {
      if (existing.status === 'mapped') {
        return {
          kind: 'skipped',
          reason: 'category already mapped',
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

    // Preferred path: reuse the org-level system category.
    const targetKey = CATEGORY_KEY_MAP[category];
    const orgCategories = await this.categoriesService.getAll(ctx.orgId);
    const systemMatch = orgCategories.find(
      (c) => c.key === targetKey && !c.space_id,
    );

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: STATUS_CATEGORY_ENTITY,
        sourceId: category,
        targetTable: 'status_categories',
        targetId: systemMatch ? systemMatch.id : `planned:create:${targetKey}`,
        status: 'planned',
        matchMethod: systemMatch ? 'existing' : 'create',
        metadata: { target_key: targetKey, reused_system: !!systemMatch },
      });

      return { kind: 'planned' };
    }

    let targetId: string;
    let reused = false;

    if (systemMatch) {
      targetId = systemMatch.id;
      reused = true;
    } else {
      // Fallback: org predates the seed triggers — create a space-scoped category.
      try {
        const created = await this.categoriesService.create(
          ctx.orgId,
          {
            name: FALLBACK_NAMES[category],
            key: targetKey,
            color: FALLBACK_COLORS[category],
            space_id: spaceId!,
            is_done_like: category === 'done',
          },
          requireActingUser(ctx),
        );

        targetId = created.id;
      } catch (err) {
        if (err instanceof ConflictException) {
          throw new MigrationItemError(
            'transient',
            `Category key raced: ${err.message}`,
          );
        }

        throw err;
      }
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: STATUS_CATEGORY_ENTITY,
      sourceId: category,
      targetTable: 'status_categories',
      targetId,
      status: 'mapped',
      matchMethod: reused ? 'existing' : 'created',
      metadata: { target_key: targetKey, reused_system: reused },
    });

    return reused
      ? { kind: 'updated', targetId, targetTable: 'status_categories' }
      : { kind: 'created', targetId, targetTable: 'status_categories' };
  }
}
