/**
 * @fileoverview `sprints` stage — Jira sprints → XISUITE sprints.
 *
 * The target's sprint lifecycle is far stricter than Jira's, and all of it is DB-enforced:
 *  - `sprints.status` is ALWAYS `'planning'` on insert (column default); there is no status field on
 *    `CreateSprintDto`. A state is reached only by walking `startSprint` → `completeSprint`.
 *  - `enforce_sprint_status_transition`: planning → active → completed ONLY. No backward moves, and
 *    a completed sprint is IMMUTABLE.
 *  - `sprints_one_active_per_board` (unique index) + `enforce_single_active_sprint` (trigger): at
 *    most ONE active sprint per board. Jira permits several.
 *  - `sprints_date_check`: `start_date < end_date` STRICTLY. Jira allows zero-duration sprints.
 *  - `requireScrum`: every sprint write 400s on a kanban board.
 *
 * Consequences this stage is built around:
 *  - A CLOSED Jira sprint must be walked planning → active → completed. Because only one sprint may
 *    be active at a time, that walk must be SEQUENTIAL per board — which is why sprints are seeded
 *    as ONE item per board, not one per sprint. Parallel per-sprint items would race the
 *    one-active-per-board rule and fail unpredictably.
 *  - A second ACTIVE Jira sprint on the same board cannot be represented. It is imported as
 *    `planning` and reported — never silently mislabelled.
 *
 * MEASURED: SDP has ZERO sprints, so none of this is exercised by the live test data. It is built
 * for real customers, and the constraints above are the reason it is written this way.
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { CompleteSprintAction } from '../../../sprints/dto/complete-sprint.dto';
import { SprintsService } from '../../../sprints/sprints.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import type { NormalizedSprint } from '../../model/normalized';
import { BOARD_ENTITY } from './boards.stage';
import { requireActingUser, scopeIncludes } from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type SeedItem,
  type StageContext,
} from './stage.interface';

export const SPRINTS_STAGE = 'sprints';
export const SPRINT_ENTITY = 'sprint';

interface BoardSprintsPayload {
  boardSourceId: string;
  boardName: string;
  boardType: 'kanban' | 'scrum';
  sprints: NormalizedSprint[];
}

@Injectable()
export class SprintsStage implements IStageHandler {
  readonly stage = SPRINTS_STAGE;

  constructor(private readonly sprintsService: SprintsService) {}

  /** ONE item per BOARD — the one-active-per-board rule forces a sequential walk. */
  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'sprints stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    // Sprints belong to boards; excluding boards excludes their sprints (the DTO calls it
    // "Include boards (and their sprints)").
    if (!scopeIncludes(ctx, 'include_boards')) {
      await ctx.log(
        'info',
        'sprints stage: boards excluded by job scope — seeding 0',
      );

      return { items: [], nextCheckpoint: null, done: true };
    }

    const boards = await adapter.getBoards(ctx.job.source_ref);
    const items: SeedItem[] = [];

    for (const board of boards) {
      // Kanban boards have no sprints, and every sprint write 400s on them (requireScrum).
      if (board.type !== 'scrum') continue;

      // Returns [] for kanban boards and when the agile API is absent.
      const sprints = await adapter.getSprints(board.sourceId);

      if (sprints.length === 0) continue;

      const payload: BoardSprintsPayload = {
        boardSourceId: board.sourceId,
        boardName: board.name,
        boardType: board.type,
        sprints,
      };

      items.push({
        entityType: SPRINT_ENTITY,
        sourceRef: `board:${board.sourceId}`,
        // Same-entity-type gate is not usable here (the parent is a BOARD, not a sprint), so the
        // board gate is resolved inline in processItem.
        payload: payload as unknown as Record<string, unknown>,
      });
    }

    return { items, nextCheckpoint: null, done: true };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload = item.payload as unknown as BoardSprintsPayload | null;

    if (!payload?.boardSourceId) {
      throw new MigrationItemError(
        'permanent',
        'Sprint item is missing its payload snapshot',
      );
    }

    const boardRow = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      BOARD_ENTITY,
      payload.boardSourceId,
    );
    const boardOpen =
      !!boardRow &&
      (boardRow.status === 'mapped' ||
        (ctx.dryRun && boardRow.status === 'planned'));

    if (!boardOpen) {
      return {
        kind: 'blocked',
        waitingFor: {
          entityType: BOARD_ENTITY,
          sourceId: payload.boardSourceId,
        },
      };
    }

    if (ctx.dryRun) {
      for (const sprint of payload.sprints) {
        await ctx.entityMap.recordMapping({
          orgId: ctx.orgId,
          connectionId: ctx.job.connection_id,
          jobId: ctx.job.id,
          runId: ctx.run.id,
          entityType: SPRINT_ENTITY,
          sourceId: sprint.sourceId,
          sourceKey: sprint.name,
          targetTable: 'sprints',
          targetId: `planned:${sprint.name}`,
          status: 'planned',
          metadata: { name: sprint.name, state: sprint.state },
        });
      }

      return { kind: 'planned' };
    }

    const actor = requireActingUser(ctx);
    const boardId = boardRow.target_id;

    // Closed sprints first, then the active one: each closed sprint occupies the single active slot
    // only transiently while being walked planning→active→completed, so ordering them first leaves
    // the slot free for the genuinely-active sprint at the end.
    const ordered = [...payload.sprints].sort(
      (a, b) => stateRank(a.state) - stateRank(b.state),
    );
    let activeClaimed = false;
    let created = 0;

    for (const sprint of ordered) {
      const existing = await ctx.entityMap.getTarget(
        ctx.orgId,
        ctx.job.connection_id,
        SPRINT_ENTITY,
        sprint.sourceId,
      );

      if (existing?.status === 'mapped') continue;

      const targetId = await this.importSprint(
        ctx,
        boardId,
        actor,
        sprint,
        activeClaimed,
      );

      if (!targetId) continue;

      if (sprint.state === 'active') activeClaimed = true;

      created += 1;

      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: SPRINT_ENTITY,
        sourceId: sprint.sourceId,
        sourceKey: sprint.name,
        targetTable: 'sprints',
        targetId,
        status: 'mapped',
        metadata: {
          name: sprint.name,
          source_state: sprint.state,
          board: payload.boardName,
        },
      });
    }

    if (created === 0) {
      return { kind: 'skipped', reason: 'all sprints already mapped' };
    }

    return {
      kind: 'created',
      targetId: boardId,
      targetTable: 'sprints',
    };
  }

  /** Create one sprint and walk it to its source state. Returns the new id, or null if skipped. */
  private async importSprint(
    ctx: StageContext,
    boardId: string,
    actor: string,
    sprint: NormalizedSprint,
    activeClaimed: boolean,
  ): Promise<string | null> {
    const dates = this.safeDates(sprint);

    let sprintId: string;

    try {
      const res = await this.sprintsService.createSprint(
        boardId,
        ctx.orgId,
        actor,
        {
          name: sprint.name,
          ...(sprint.goal ? { goal: sprint.goal } : {}),
          ...dates,
        },
      );

      sprintId = (res.data as { id: string }).id;
    } catch (err) {
      if (err instanceof BadRequestException) {
        await ctx.log(
          'warn',
          `sprints: "${sprint.name}" rejected — ${err.message}`,
          { sourceId: sprint.sourceId },
        );

        return null;
      }

      throw err;
    }

    if (sprint.state === 'future') return sprintId;

    // Only ONE sprint may be active per board. A second active Jira sprint cannot be represented —
    // leave it in `planning` and say so, rather than mislabel it.
    if (sprint.state === 'active' && activeClaimed) {
      await ctx.log(
        'warn',
        `sprints: "${sprint.name}" is active on the source but this board already has an active ` +
          `sprint — imported as "planning" (one active sprint per board is enforced)`,
        { sourceId: sprint.sourceId },
      );

      return sprintId;
    }

    // `StartSprintDto` REQUIRES start_date + end_date. Jira sprints can carry neither, and inventing
    // dates would fabricate history — so an undateable sprint stays in `planning`, reported.
    if (!dates.start_date || !dates.end_date) {
      await ctx.log(
        'warn',
        `sprints: "${sprint.name}" is "${sprint.state}" on the source but has no usable start/end ` +
          `dates — imported as "planning" (starting a sprint requires both, with start before end)`,
        { sourceId: sprint.sourceId },
      );

      return sprintId;
    }

    try {
      // NOTE the inverted arg order: startSprint/completeSprint are (sprintId, boardId, …) while
      // createSprint is (boardId, …). All bare strings — a swap compiles.
      await this.sprintsService.startSprint(
        sprintId,
        boardId,
        ctx.orgId,
        actor,
        { start_date: dates.start_date, end_date: dates.end_date },
      );

      if (sprint.state === 'closed') {
        // MOVE_TO_BACKLOG needs no target sprint. Issue↔sprint membership is not written by this
        // stage (that is `board_issue_ranking.sprint_id`), so the sprint is empty and the action is
        // a formality — but MOVE_TO_SPRINT would demand a `target_sprint_id` we do not have.
        await this.sprintsService.completeSprint(
          sprintId,
          boardId,
          ctx.orgId,
          actor,
          { action: CompleteSprintAction.MOVE_TO_BACKLOG },
        );
      }
    } catch (err) {
      if (err instanceof BadRequestException) {
        // The sprint EXISTS — only its lifecycle state could not be reproduced. Report the
        // degradation; do not lose the sprint over it.
        await ctx.log(
          'warn',
          `sprints: "${sprint.name}" imported but could not reach state "${sprint.state}" — ${err.message}`,
          { sourceId: sprint.sourceId },
        );

        return sprintId;
      }

      throw err;
    }

    return sprintId;
  }

  /**
   * `sprints_date_check` requires `start_date < end_date` STRICTLY. Jira permits equal (or absent)
   * dates, so an unsatisfiable pair is dropped rather than 400-ing the sprint out of existence.
   */
  private safeDates(sprint: NormalizedSprint): {
    start_date?: string;
    end_date?: string;
  } {
    if (!sprint.startDate || !sprint.endDate) return {};

    if (new Date(sprint.startDate) >= new Date(sprint.endDate)) return {};

    return { start_date: sprint.startDate, end_date: sprint.endDate };
  }
}

/** closed → active → future: closed sprints are walked first, freeing the single active slot. */
function stateRank(state: NormalizedSprint['state']): number {
  if (state === 'closed') return 0;
  if (state === 'future') return 1;

  return 2;
}
