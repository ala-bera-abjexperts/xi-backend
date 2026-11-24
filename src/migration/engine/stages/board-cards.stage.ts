/**
 * @fileoverview `board_cards` stage — puts the migrated tasks ONTO the migrated boards.
 *
 * 🔴 THIS IS THE STAGE THAT WAS MISSING. `boards.stage.ts` creates the board, its columns and its
 * status→column mappings — and stopped there. Nothing ever wrote `board_issue_ranking`, so the
 * migrated board rendered its columns with ZERO cards and an EMPTY backlog, while the run reported
 * `succeeded`. Measured on the live source: Jira board 1 holds 9,826 issues in its backlog; XISUITE
 * showed none. Every unit test passed, the DI resolved, and the board was empty — which is exactly
 * why live verification is not optional.
 *
 * Board membership comes from the SOURCE (`getBoardIssueIds`), never inferred from the project: a
 * board shows whatever its filter selects, and its order IS the hand-arranged backlog rank. Inferring
 * membership would put issues on boards they were never on; inventing an order would discard the rank.
 *
 * BACKLOG SEMANTICS (verified in `sprints.service.ts`): the backlog is
 * `board_issue_ranking WHERE board_id = X AND sprint_id IS NULL`, ordered by `backlog_position`.
 * `addCard` does not set `backlog_position`, so this stage writes it afterwards — otherwise every
 * card lands with a NULL rank and the backlog, while no longer empty, comes back in arbitrary order.
 *
 * COLUMN CHOICE IS LOAD-BEARING: `addCard` auto-applies the column's first mapped status to the task
 * (boards.service.ts, right after the insert). Placing a card in any column other than the one that
 * maps its OWN status would therefore silently rewrite the status the issues stage just migrated.
 * So the column is resolved FROM the task's status, and a task whose status the board does not map
 * is skipped rather than forced somewhere wrong.
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { BoardsService } from '../../../boards/boards.service';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import { BOARD_ENTITY } from './boards.stage';
import { isResolvedStatus } from './crosswalk-gate.util';
import { ISSUE_ENTITY } from './issues.stage';
import { requireActingUser, runScope } from './stage-helpers';
import {
  MigrationItemError,
  type IStageHandler,
  type ItemOutcome,
  type MigrationRunItemRow,
  type ProduceResult,
  type SeedItem,
  type StageContext,
} from './stage.interface';
import type { MigrationEntityMapRow } from '../../services/migration-entity-map.service';

export const BOARD_CARDS_STAGE = 'board_cards';
export const BOARD_CARD_ENTITY = 'board_card';

const PAGE_SIZE = 50;
/** Matches the app's own spacing (`sprints.service.ts` reorders with `(i + 1) * 1000`). */
const RANK_STEP = 1000;

interface CardPayload {
  boardSourceId: string;
  issueSourceId: string;
  /** The board's rank order from the source — becomes `backlog_position`. */
  rank: number;
}

@Injectable()
export class BoardCardsStage implements IStageHandler {
  readonly stage = BOARD_CARDS_STAGE;

  constructor(
    private readonly boardsService: BoardsService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Pages the source's board membership. The cursor is `${boardSourceId}|${startAt}` so a restart
   * resumes mid-board rather than re-walking 9,826 issues.
   */
  async produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'board_cards stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    const boards = await this.listMappedBoards(ctx);

    if (boards.length === 0) {
      return { items: [], nextCheckpoint: null, done: true };
    }

    const checkpoint = collectionItem.checkpoint ?? {};
    const cursor =
      typeof checkpoint.cursor === 'string' ? checkpoint.cursor : null;
    const [cursorBoard, cursorStart] = cursor
      ? cursor.split('|')
      : [boards[0].source_id, '0'];
    const boardIndex = Math.max(
      0,
      boards.findIndex((b) => b.source_id === cursorBoard),
    );
    const board = boards[boardIndex];
    const startAt = Number(cursorStart) || 0;

    const page = await adapter.getBoardIssueIds(board.source_id, {
      cursor: String(startAt),
      pageSize: PAGE_SIZE,
      // Narrow at the SOURCE. The crosswalk filter below is still the correctness guarantee (it
      // catches anything the scope did not migrate, for any reason); this just stops us walking
      // 9,826 board issues to card 25 of them.
      ...(runScope(ctx).jql ? { jql: runScope(ctx).jql } : {}),
    });

    // 🔴 Only card the issues this job ACTUALLY migrated. A board reports its full membership
    // (9,826 on the live SDP board), but the job's `scope.jql` may have narrowed the import to a
    // fraction of that (`key <= SDP-25` → 25 tasks). Seeding a card per board issue would leave
    // every out-of-scope card BLOCKED forever on an issue that is never coming, and the tick's
    // deadlock guard would then fail thousands of items — turning a clean run into
    // `partially_completed` with ~9.8k phantom failures.
    //
    // Filtering on the crosswalk rather than re-applying the JQL is deliberate: the crosswalk is the
    // record of what was migrated, so this stays correct no matter HOW the scope narrowed things
    // (jql, a failed item, a resumed run). `board_cards` runs after `issues` has drained, so every
    // in-scope issue is already mapped by now.
    const mapped = await ctx.entityMap.getTargets(
      ctx.orgId,
      ctx.job.connection_id,
      ISSUE_ENTITY,
      page.items,
    );

    const items: SeedItem[] = page.items
      // Keep the SOURCE's rank index before filtering — it is the board order the user arranged,
      // and re-indexing after the filter would invent a different one.
      .map((issueSourceId, i) => ({ issueSourceId, rank: startAt + i }))
      .filter(({ issueSourceId }) => {
        const row = mapped.get(issueSourceId);

        return !!row && isResolvedStatus(row.status, ctx.dryRun);
      })
      .map(({ issueSourceId, rank }) => ({
        entityType: BOARD_CARD_ENTITY,
        // One card per (board, issue) — the same issue can legitimately sit on two boards.
        sourceRef: `${board.source_id}:${issueSourceId}`,
        payload: {
          boardSourceId: board.source_id,
          issueSourceId,
          rank,
        } as unknown as Record<string, unknown>,
      }));

    if (items.length < page.items.length) {
      await ctx.log(
        'info',
        `board_cards: ${page.items.length - items.length} of ${page.items.length} board issues in ` +
          `this page are outside the job's scope — not carded`,
        { board: board.source_id },
      );
    }

    // Still inside this board? Keep paging it. Otherwise advance to the next board, and only
    // finish once the last board is exhausted.
    //
    // The `nextCursor !== startAt` guard is a liveness backstop, not paranoia: a cursor that does
    // not move means "keep paging from exactly where you already are", which the engine happily
    // obeys forever. That is not hypothetical — a live run sat on cursor `1|5250` re-leasing the
    // same collection item indefinitely, and because the item never failed, nothing timed it out
    // and the run simply never finished. Refusing to re-page the same offset converts a silent hang
    // into a bounded, reported stop.
    if (page.nextCursor && String(page.nextCursor) !== String(startAt)) {
      return {
        items,
        nextCheckpoint: { cursor: `${board.source_id}|${page.nextCursor}` },
        done: false,
      };
    }

    if (page.nextCursor) {
      await ctx.log(
        'warn',
        `board_cards: board ${board.source_id} reported the same cursor (${startAt}) twice — ` +
          `treating it as exhausted rather than paging it forever`,
        { board: board.source_id },
      );
    }

    const nextBoard = boards[boardIndex + 1];

    return {
      items,
      nextCheckpoint: nextBoard ? { cursor: `${nextBoard.source_id}|0` } : null,
      done: !nextBoard,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    const payload = item.payload as unknown as CardPayload | null;

    if (!payload?.boardSourceId || !payload.issueSourceId) {
      throw new MigrationItemError(
        'permanent',
        'Board-card item is missing its payload snapshot',
      );
    }

    const sourceRef =
      item.source_ref ?? `${payload.boardSourceId}:${payload.issueSourceId}`;
    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      BOARD_CARD_ENTITY,
      sourceRef,
    );

    if (existing?.status === 'mapped') {
      return { kind: 'skipped', reason: 'card already on the board' };
    }

    if (existing?.status === 'planned' && ctx.dryRun) {
      return { kind: 'skipped', reason: 'already planned' };
    }

    const boardRow = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      BOARD_ENTITY,
      payload.boardSourceId,
    );

    if (!boardRow || !isResolvedStatus(boardRow.status, ctx.dryRun)) {
      return {
        kind: 'blocked',
        waitingFor: {
          entityType: BOARD_ENTITY,
          sourceId: payload.boardSourceId,
        },
      };
    }

    const taskRow = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      ISSUE_ENTITY,
      payload.issueSourceId,
    );

    if (!taskRow || !isResolvedStatus(taskRow.status, ctx.dryRun)) {
      return {
        kind: 'blocked',
        waitingFor: {
          entityType: ISSUE_ENTITY,
          sourceId: payload.issueSourceId,
        },
      };
    }

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: BOARD_CARD_ENTITY,
        sourceId: sourceRef,
        sourceKey: payload.issueSourceId,
        targetTable: 'board_issue_ranking',
        targetId: `planned:${sourceRef}`,
        status: 'planned',
        metadata: { rank: payload.rank },
      });

      return { kind: 'planned' };
    }

    // The column MUST be the one mapping this task's own status — addCard auto-applies the column's
    // first status to the task, so any other column silently rewrites the migrated status.
    const columnId = await this.columnForTaskStatus(
      ctx,
      boardRow.target_id,
      taskRow.target_id,
    );

    if (!columnId) {
      // Jira would not show it either — the board's columns do not cover this status. Report it;
      // do not force the card into an arbitrary column and corrupt its status.
      await ctx.log(
        'warn',
        `board_cards: task ${payload.issueSourceId} has a status no column on this board maps — not placed`,
        { board: payload.boardSourceId },
      );

      return { kind: 'skipped', reason: 'status not mapped to any column' };
    }

    const actor = requireActingUser(ctx);
    const position = (payload.rank + 1) * RANK_STEP;

    try {
      await this.boardsService.addCard(boardRow.target_id, ctx.orgId, actor, {
        task_id: taskRow.target_id,
        column_id: columnId,
        position,
        // Backlog. Sprint membership is the sprints stage's job; a scrum board's backlog is
        // precisely `sprint_id IS NULL`.
        sprint_id: null,
      });
    } catch (err) {
      // "Task is already on this board" — a resumed run. Converge instead of failing.
      if (
        err instanceof BadRequestException &&
        /already on this board/i.test(err.message)
      ) {
        await this.setBacklogPosition(
          boardRow.target_id,
          taskRow.target_id,
          position,
        );
        await this.record(
          ctx,
          sourceRef,
          payload,
          boardRow.target_id,
          taskRow.target_id,
        );

        return { kind: 'skipped', reason: 'card already on the board' };
      }

      throw err;
    }

    // addCard does not write `backlog_position`, and the backlog is ORDERED by it — without this the
    // cards appear but in arbitrary order, losing the rank the user arranged in Jira.
    await this.setBacklogPosition(
      boardRow.target_id,
      taskRow.target_id,
      position,
    );
    await this.record(
      ctx,
      sourceRef,
      payload,
      boardRow.target_id,
      taskRow.target_id,
    );

    return {
      kind: 'created',
      targetId: `${boardRow.target_id}:${taskRow.target_id}`,
      targetTable: 'board_issue_ranking',
    };
  }

  /** The board column whose mapped statuses include this task's status, or null. */
  private async columnForTaskStatus(
    ctx: StageContext,
    boardId: string,
    taskId: string,
  ): Promise<string | null> {
    const { data: task, error: taskError } = (await this.db
      .from('tasks')
      .select('status_id')
      .eq('organization_id', ctx.orgId)
      .eq('id', taskId)
      .maybeSingle()) as {
      data: { status_id: string | null } | null;
      error: { message: string } | null;
    };

    if (taskError) {
      throw new MigrationItemError(
        'transient',
        `Task lookup failed: ${taskError.message}`,
      );
    }

    if (!task?.status_id) return null;

    const { data, error } = (await this.db
      .from('board_column_statuses')
      .select('column_id')
      .eq('board_id', boardId)
      .eq('status_id', task.status_id)
      .maybeSingle()) as {
      data: { column_id: string } | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Column lookup failed: ${error.message}`,
      );
    }

    return data?.column_id ?? null;
  }

  /** `addCard` omits backlog_position; the backlog is ordered by it, so set it explicitly. */
  private async setBacklogPosition(
    boardId: string,
    taskId: string,
    position: number,
  ): Promise<void> {
    const { error } = await this.db
      .from('board_issue_ranking')
      .update({ backlog_position: position })
      .eq('board_id', boardId)
      .eq('task_id', taskId);

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Backlog rank write failed: ${error.message}`,
      );
    }
  }

  private async record(
    ctx: StageContext,
    sourceRef: string,
    payload: CardPayload,
    boardId: string,
    taskId: string,
  ): Promise<void> {
    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: BOARD_CARD_ENTITY,
      sourceId: sourceRef,
      sourceKey: payload.issueSourceId,
      targetTable: 'board_issue_ranking',
      targetId: `${boardId}:${taskId}`,
      status: 'mapped',
      metadata: { rank: payload.rank, board: payload.boardSourceId },
    });
  }

  /**
   * Mapped boards for THIS JOB — hand-scoped (service-role bypasses RLS).
   *
   * `job_id`, not just `source_connection_id`. One connection commonly migrates several projects,
   * and the crosswalk is keyed per connection, so a connection-only filter hands this stage every
   * board any project ever migrated. The KAN job then walked the SDP board's 9,826 issues, produced
   * nothing from them (they belong to another space), and never finished.
   *
   * A board belongs to exactly one space and a job targets exactly one space, so the job is the
   * correct boundary: card the boards this job migrated, nobody else's.
   */
  private async listMappedBoards(
    ctx: StageContext,
  ): Promise<MigrationEntityMapRow[]> {
    const { data, error } = (await this.db
      .from('migration_entity_map')
      .select('*')
      .eq('organization_id', ctx.orgId)
      .eq('source_connection_id', ctx.job.connection_id)
      .eq('job_id', ctx.job.id)
      .eq('entity_type', BOARD_ENTITY)
      .in('status', ctx.dryRun ? ['mapped', 'planned'] : ['mapped'])
      .order('created_at', { ascending: true })) as {
      data: MigrationEntityMapRow[] | null;
      error: { message: string } | null;
    };

    if (error) {
      throw new MigrationItemError(
        'transient',
        `Board crosswalk list failed: ${error.message}`,
      );
    }

    return data ?? [];
  }
}
