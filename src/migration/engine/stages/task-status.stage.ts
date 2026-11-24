/**
 * @fileoverview `task_statuses` stage — one space-scoped `task_statuses` row per
 * distinct Jira status (space-scoped for Jira fidelity; the org-level defaults keep
 * coexisting). Keys are deduped ASCII slugs precomputed at produce time (two German
 * names can slug identically); `category_id` resolves through the status-category
 * crosswalk; `is_completed` derives from the done bucket, never the localized name.
 */

import { AtlassianRequestError } from '../../adapters/http/atlassian-http-client';
import { InvalidJiraStatusError } from '../../adapters/jira/jira-adapter.base';
import { ConflictException, Injectable } from '@nestjs/common';
import { TaskStatusesService } from '../../../task-statuses/task-statuses.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedStatus } from '../../model/normalized';
import { asciiSlug, asDbKey, dedupeKeys } from '../../util/slug.util';
import { seededStatusKey } from './seeded-key.util';
import {
  blockedOnSpace,
  requireActingUser,
  resolveTargetSpace,
  scopeIncludes,
} from './stage-helpers';
import { STATUS_CATEGORY_ENTITY } from './status-category.stage';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type StageContext,
} from './stage.interface';

export const TASK_STATUSES_STAGE = 'task_statuses';
export const TASK_STATUS_ENTITY = 'task_status';

/** Jira statusCategory colorName → app hex (statuses require #RRGGBB). */
const COLOR_NAME_MAP: Record<string, string> = {
  'blue-gray': '#6B7280',
  'medium-gray': '#9CA3AF',
  yellow: '#F59E0B',
  green: '#22C55E',
  brown: '#92400E',
  'warm-red': '#EF4444',
  blue: '#3B82F6',
};

type StatusPayload = NormalizedStatus & { derivedKey: string };

@Injectable()
export class TaskStatusStage implements IStageHandler {
  readonly stage = TASK_STATUSES_STAGE;

  constructor(private readonly statusesService: TaskStatusesService) {}

  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'task_statuses stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    const statuses = await adapter.getStatuses(ctx.job.source_ref);
    const discoveryErrors: {
      entityType: string;
      sourceRef: string;
      payload: Record<string, unknown>;
    }[] = [];
    if (scopeIncludes(ctx, 'include_boards')) {
      const known = new Set(statuses.map((status) => status.sourceId));
      const boards = await adapter
        .getBoards(ctx.job.source_ref)
        .catch(async (error: unknown) => {
          if (
            !(error instanceof AtlassianRequestError) ||
            ![401, 403, 404, 410].includes(error.status)
          )
            throw error;
          await ctx.log(
            'error',
            `Board discovery unavailable; project statuses retained: ${error.message}`,
          );
          return [];
        });
      for (const board of boards) {
        if (board.configurationError) {
          await ctx.log('error', board.configurationError, {
            boardSourceId: board.sourceId,
          });
          continue;
        }
        for (const sourceId of board.columns.flatMap(
          (column) => column.statusSourceIds,
        )) {
          if (!sourceId || known.has(sourceId)) continue;
          known.add(sourceId);
          try {
            statuses.push(await adapter.getStatus(sourceId));
          } catch (error) {
            if (
              !(error instanceof InvalidJiraStatusError) &&
              (!(error instanceof AtlassianRequestError) ||
                ![401, 403, 404, 410].includes(error.status))
            )
              throw error;
            const message = `Board ${board.sourceId} (${board.name}) requires status ${sourceId}: ${(error as Error).message}`;
            await ctx.log('error', message, {
              boardSourceId: board.sourceId,
              statusSourceId: sourceId,
            });
            discoveryErrors.push({
              entityType: TASK_STATUS_ENTITY,
              sourceRef: sourceId,
              payload: { discoveryError: message },
            });
          }
        }
      }
    }

    // Deterministic, collision-free keys across the whole batch.
    // Alias a localized name onto the seeded key BEFORE deduping, so `Fertig` adopts the existing
    // org-level `done` instead of minting a duplicate. Inside dedupeKeys on purpose: if an instance
    // has both "Fertig" and "Erledigt", both alias to `done` and the second gets the `_sourceId`
    // suffix, so two source statuses can never silently collapse onto one target row (which would
    // turn a workflow transition into a self-loop).
    const keys = dedupeKeys(
      statuses,
      (s) => {
        const slug = asciiSlug(s.name, 'status', s.sourceId);

        return seededStatusKey(slug) ?? asDbKey(slug, 's');
      },
      (s) => s.sourceId,
    );

    return {
      items: [
        ...statuses.map((status) => ({
          entityType: TASK_STATUS_ENTITY,
          sourceRef: status.sourceId,
          payload: {
            ...status,
            derivedKey: keys.get(status)!,
          } as unknown as Record<string, unknown>,
        })),
        ...discoveryErrors,
      ],
      nextCheckpoint: null,
      done: true,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload =
      typeof item.payload?.discoveryError === 'string'
        ? ((await this.produce(ctx)).items.find(
            (seed) => seed.sourceRef === item.source_ref,
          )?.payload ?? item.payload)
        : item.payload;
    if (typeof payload?.discoveryError === 'string') {
      throw new MigrationItemError('permanent', payload.discoveryError);
    }
    const status = payload as unknown as StatusPayload | null;

    if (!status?.sourceId || !status.derivedKey) {
      throw new MigrationItemError(
        'permanent',
        'Status item is missing its payload snapshot',
      );
    }

    const existing = await ctx.entityMap.getExistingTarget(
      ctx.orgId,
      ctx.job.connection_id,
      TASK_STATUS_ENTITY,
      status.sourceId,
      'task_statuses',
    );

    if (existing) {
      if (existing.status === 'mapped') {
        return {
          kind: 'skipped',
          reason: 'status already mapped',
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

    // Cross-entity gate: the category must already be crosswalked.
    const categoryRow = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      STATUS_CATEGORY_ENTITY,
      status.statusCategory,
    );
    const categoryGateOpen =
      !!categoryRow &&
      (categoryRow.status === 'mapped' ||
        (ctx.dryRun && categoryRow.status === 'planned'));

    if (!categoryGateOpen) {
      return {
        kind: 'blocked',
        waitingFor: {
          entityType: STATUS_CATEGORY_ENTITY,
          sourceId: status.statusCategory,
        },
      };
    }

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: TASK_STATUS_ENTITY,
        sourceId: status.sourceId,
        sourceKey: status.derivedKey,
        targetTable: 'task_statuses',
        targetId: `planned:${status.derivedKey}`,
        status: 'planned',
        metadata: {
          key: status.derivedKey,
          category: status.statusCategory,
          name: status.name,
        },
      });

      return { kind: 'planned' };
    }

    let created: { id: string };

    // ADOPT-FIRST, org-level before space-level.
    //
    // `task_statuses` reads UNION org and space scope (`task-statuses.service.ts` filters
    // `space_id.is.null,space_id.eq.X`), so a status that already exists at ORG level is ALREADY
    // visible in the target space. Creating a space-scoped copy of it does not add anything; it just
    // produces two rows with the same key that the space UI then lists twice.
    //
    // This is measured, not hypothetical: before this change the test org held THREE rows each for
    // `done` and `in_progress` — one org-level row that pre-existed, plus a space copy minted by
    // each of two migrations.
    const adopted = await this.findAdoptableStatus(
      ctx,
      status.derivedKey,
      spaceId ?? null,
    );

    if (adopted) {
      await ctx.log(
        'info',
        `task_statuses: adopted the existing ${adopted.scope}-level status "${status.derivedKey}" ` +
          `instead of creating a duplicate`,
        { key: status.derivedKey },
      );
      created = { id: adopted.id };
    } else {
      try {
        created = await this.statusesService.create(
          ctx.orgId,
          {
            name: status.name || status.derivedKey,
            key: status.derivedKey,
            color: COLOR_NAME_MAP[status.colorName ?? ''] ?? '#6B7280',
            // ORG-LEVEL, not space-scoped. Two independent reasons, and the first is fidelity:
            //
            // 1. Jira statuses ARE instance-wide. They live in one global list and are shared by
            //    every project; a project does not own its statuses, it merely uses them. Writing a
            //    per-space copy therefore misrepresents the source.
            // 2. It is the only correct answer once one connection migrates TWO projects. The
            //    crosswalk is keyed per CONNECTION, so the second project reuses the first's status
            //    rows — and if those rows are space-scoped to the first project's space, the second
            //    project's workflow cannot see them. Observed live: the KAN workflow died with
            //    "status_id(s) not visible from this workflow's scope" pointing at rows owned by the
            //    SDP space.
            //
            // Safe on the read side: every status read unions org and space scope
            // (`task-statuses.service.ts` filters `space_id.is.null,space_id.eq.X`), so an org-level
            // status is visible from every space, which is exactly Jira's own semantics.
            space_id: null,
            category_id: categoryRow.target_id,
            is_completed: status.statusCategory === 'done',
            sort_order:
              status.statusCategory === 'new'
                ? 0
                : status.statusCategory === 'done'
                  ? 2
                  : 1,
          },
          requireActingUser(ctx),
        );
      } catch (err) {
        if (err instanceof ConflictException) {
          // Raced another worker between the lookup and the insert.
          const raced = await this.findAdoptableStatus(
            ctx,
            status.derivedKey,
            spaceId ?? null,
          );

          if (raced) {
            created = { id: raced.id };
          } else {
            throw new MigrationItemError(
              'conflict',
              `Status key "${status.derivedKey}" already exists in the target space: ${err.message}`,
            );
          }
        } else {
          throw err;
        }
      }
    }

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: TASK_STATUS_ENTITY,
      sourceId: status.sourceId,
      sourceKey: status.derivedKey,
      targetTable: 'task_statuses',
      targetId: created.id,
      status: 'mapped',
      metadata: {
        key: status.derivedKey,
        category: status.statusCategory,
        name: status.name,
      },
    });

    return {
      kind: 'created',
      targetId: created.id,
      targetTable: 'task_statuses',
    };
  }

  /**
   * An existing status this key should reuse, ORG-LEVEL FIRST.
   *
   * Order matters and is not arbitrary. An org-level row is visible in every space, so adopting it
   * keeps one row serving all spaces, which is what makes repeat migrations converge instead of
   * accumulating a copy per space. Only if no org-level row exists do we look for one already
   * scoped to this space (a previous run of this same migration).
   *
   * `getAll(org, spaceId)` unions both scopes in one query, so `space_id` on the returned row is
   * what tells the two apart.
   */
  private async findAdoptableStatus(
    ctx: StageContext,
    key: string,
    spaceId: string | null,
  ): Promise<{ id: string; scope: 'organization' | 'space' } | null> {
    const rows = await this.statusesService.getAll(
      ctx.orgId,
      spaceId ?? undefined,
    );
    const wanted = key.trim().toLowerCase();
    const matches = rows.filter(
      (r) => (r.key ?? '').trim().toLowerCase() === wanted,
    );
    const orgLevel = matches.find((r) => !r.space_id);

    if (orgLevel) return { id: orgLevel.id, scope: 'organization' };

    const sameSpace = spaceId
      ? matches.find((r) => r.space_id === spaceId)
      : undefined;

    return sameSpace ? { id: sameSpace.id, scope: 'space' } : null;
  }
}
