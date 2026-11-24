/**
 * @fileoverview `boards` stage — Jira agile boards → XISUITE boards + columns + status mappings.
 *
 * ONE item per board, doing all three writes: the board, its columns, and each column's status
 * mappings are a single logical unit (a board with no columns is useless, and columns without
 * status mappings render nothing).
 *
 * Hard constraints, all verified against real code:
 *  - `auto_create_columns` is FALSE. `BoardsService.create` otherwise bulk-inserts four hardcoded
 *    columns (Backlog/To Do/In Progress/Done) that have nothing to do with the source board.
 *  - `board_column_statuses_unique_status_per_board UNIQUE (board_id, status_id)` — "a status can
 *    only appear in one column per board". `mapStatusToColumn` is a plain INSERT (no upsert), so a
 *    duplicate throws. Jira permits the same status in several columns, so we dedupe FIRST — first
 *    column wins — rather than letting the second mapping fail the whole board.
 *  - `CreateColumnDto.color` is regex-locked to `/^#[0-9A-Fa-f]{6}$/`. Jira reports named/3-digit
 *    colours, so we simply omit colour rather than 400 the item over cosmetics.
 *  - Arg order flips: `create` is org-first; `createColumn`/`mapStatusToColumn` are id-first. Every
 *    param is a bare string, so a swap compiles and writes garbage.
 *  - Nothing here sets `boards.board_key` — it is trigger-owned.
 *
 * MEASURED: SDP has exactly ONE board ("SDP Board", scrum) and ZERO sprints. This is the only P7
 * stage the live test data can exercise at all.
 */

import { Injectable } from '@nestjs/common';
import { BoardsService } from '../../../boards/boards.service';
import { SupabaseAdminService } from '../../../supabase/supabase-admin.service';
import { isJiraAdapter } from '../../adapters/source-adapter.interface';
import { buildBoardColumns } from '../../mappers/board-column.builder';
import { describeMigratedQuery } from '../../mappers/board-query.util';
import {
  transpileJql,
  type BoardArtifact,
  type TranspileContext,
  type TranspileOutput,
} from '../../mappers/jql/jql-transpiler.util';
import { buildTranspileContext } from '../../mappers/jql/transpile-context.builder';
import type { NormalizedBoard } from '../../model/normalized';
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
import { TASK_STATUS_ENTITY } from './task-status.stage';

export const BOARDS_STAGE = 'boards';
export const BOARD_ENTITY = 'board';
const BOARD_REPAIR_GUIDANCE =
  'After restoring source access, run full Jira repair to rediscover board status prerequisites; retrying this board alone cannot discover missing statuses.';

@Injectable()
export class BoardsStage implements IStageHandler {
  readonly stage = BOARDS_STAGE;

  constructor(
    private readonly boardsService: BoardsService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  async produce(ctx: StageContext): Promise<ProduceResult> {
    const adapter = await ctx.getAdapter();

    if (!isJiraAdapter(adapter)) {
      await ctx.log('warn', 'boards stage: non-Jira source — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    if (!scopeIncludes(ctx, 'include_boards')) {
      await ctx.log('info', 'boards stage: excluded by job scope — seeding 0');

      return { items: [], nextCheckpoint: null, done: true };
    }

    // Returns [] (never throws) when the agile API is absent — Jira Core without Software.
    const boards = await adapter.getBoards(ctx.job.source_ref);
    for (const board of boards) {
      for (const warning of board.migrationWarnings ?? []) {
        await ctx.log('warn', `boards: ${warning}`, {
          sourceId: board.sourceId,
        });
      }
    }

    return {
      items: boards.map((board) => ({
        entityType: BOARD_ENTITY,
        sourceRef: board.sourceId,
        payload: board as unknown as Record<string, unknown>,
      })),
      nextCheckpoint: null,
      done: true,
    };
  }

  async processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome> {
    let board = item.payload as unknown as NormalizedBoard | null;

    if (!board?.sourceId) {
      throw new MigrationItemError(
        'permanent',
        'Board item is missing its payload snapshot',
      );
    }

    const existing = await ctx.entityMap.getTarget(
      ctx.orgId,
      ctx.job.connection_id,
      BOARD_ENTITY,
      board.sourceId,
    );

    if (existing) {
      if (existing.status === 'mapped') {
        return {
          kind: 'skipped',
          reason: 'board already mapped',
          targetId: existing.target_id,
        };
      }

      if (existing.status === 'planned' && ctx.dryRun) {
        return { kind: 'skipped', reason: 'already planned' };
      }
    }

    if (board.configurationError) {
      const adapter = await ctx.getAdapter();
      const refreshed = isJiraAdapter(adapter)
        ? (await adapter.getBoards(ctx.job.source_ref)).find(
            (candidate) => candidate.sourceId === board!.sourceId,
          )
        : undefined;
      if (!refreshed || refreshed.configurationError) {
        throw new MigrationItemError(
          'permanent',
          `${refreshed?.configurationError ?? board.configurationError}. ${BOARD_REPAIR_GUIDANCE}`,
        );
      }
      board = refreshed;
    }

    const { spaceId, gateOpen } = await resolveTargetSpace(ctx);

    if (!gateOpen) return blockedOnSpace(ctx);

    // Resolve every status the board references up front: a miss blocks the board rather than
    // creating one whose columns are silently empty.
    const statusSourceIds = Array.from(
      new Set(board.columns.flatMap((c) => c.statusSourceIds)),
    );
    const statusRows = await ctx.entityMap.getTargets(
      ctx.orgId,
      ctx.job.connection_id,
      TASK_STATUS_ENTITY,
      statusSourceIds,
    );

    for (const sourceId of statusSourceIds) {
      const row = statusRows.get(sourceId);
      const open =
        !!row &&
        (row.status === 'mapped' || (ctx.dryRun && row.status === 'planned'));

      if (!open) {
        await ctx.log(
          'warn',
          `Board ${board.sourceId} requires unmapped status ${sourceId}. ${BOARD_REPAIR_GUIDANCE}`,
          { boardSourceId: board.sourceId, statusSourceId: sourceId },
        );
        return {
          kind: 'blocked',
          waitingFor: { entityType: TASK_STATUS_ENTITY, sourceId },
        };
      }
    }

    if (ctx.dryRun) {
      await ctx.entityMap.recordMapping({
        orgId: ctx.orgId,
        connectionId: ctx.job.connection_id,
        jobId: ctx.job.id,
        runId: ctx.run.id,
        entityType: BOARD_ENTITY,
        sourceId: board.sourceId,
        sourceKey: board.name,
        targetTable: 'boards',
        targetId: `planned:${board.name}`,
        status: 'planned',
        metadata: {
          name: board.name,
          type: board.type,
          column_count: board.columns.length,
          status_count: statusSourceIds.length,
        },
      });

      return { kind: 'planned' };
    }

    const actor = requireActingUser(ctx);

    // `BoardsService.create` ALWAYS inserts one default swimlane, and `idx_board_swimlanes_one_default`
    // is a partial unique index. So Jira's own default lane has to be adopted by naming it here —
    // inserting it later as a second `is_default` row would 23505 and fail the whole board.
    const defaultLane = (board.swimlanes ?? []).find((s) => s.isDefault);

    const createdBoard = await this.boardsService.create(ctx.orgId, actor, {
      space_id: spaceId!,
      name: board.name,
      board_type: board.type,
      // Never true: it would inject four hardcoded columns unrelated to the source board, on top of
      // the Jira columns we are about to create.
      auto_create_columns: false,
      ...(defaultLane ? { default_swimlane_name: defaultLane.name } : {}),
    });
    const boardId = createdBoard.data.id;

    // A status may appear in only ONE column per board (unique index). Jira allows it in several,
    // so first-column-wins, and the rest are reported rather than left to throw.
    const claimed = new Set<string>();
    let mappedStatuses = 0;

    // Every constraint-sensitive column decision (WIP coercion, the one-per-board backlog flag,
    // done-ness) is made in a pure builder so it can be unit-tested against the real constraints.
    const { writes: columnWrites, notes: columnNotes } = buildBoardColumns(
      board.columns,
    );

    for (const note of columnNotes) {
      await ctx.log('warn', `boards: ${board.name} — ${note}`, {
        board: board.name,
      });
    }

    for (const [index, column] of board.columns.entries()) {
      const write = columnWrites[index];
      const createdColumn = await this.boardsService.createColumn(
        boardId,
        ctx.orgId,
        actor,
        {
          name: column.name,
          sort_order: index,
          min_wip: write.min_wip,
          max_wip: write.max_wip,
          is_kanban_backlog: write.is_kanban_backlog,
          is_backlog: write.is_backlog,
          is_done: write.is_done,
          // `color` deliberately omitted — the DTO demands /^#[0-9A-Fa-f]{6}$/ and Jira reports
          // named/short colours. Cosmetics must never fail a board import.
        },
      );

      for (const statusSourceId of column.statusSourceIds) {
        if (claimed.has(statusSourceId)) {
          await ctx.log(
            'warn',
            `boards: status ${statusSourceId} appears in more than one column on "${board.name}" — ` +
              `kept in the first, omitted from "${column.name}" (a status may occupy only one column)`,
            { board: board.name },
          );

          continue;
        }

        const statusRow = statusRows.get(statusSourceId)!;

        await this.boardsService.mapStatusToColumn(boardId, ctx.orgId, actor, {
          column_id: createdColumn.data.id,
          status_id: statusRow.target_id,
          sort_order: mappedStatuses,
        });

        claimed.add(statusSourceId);
        mappedStatuses += 1;
      }
    }

    // One crosswalk read per board item builds every name→key/id map the JQL transpiler needs.
    // Failure degrades to verbatim storage — exactly the pre-transpiler behaviour.
    const jqlCtx = await this.buildJqlContext(ctx);
    const transpileOutcomes: Record<string, unknown>[] = [];

    const swimlanesCreated = await this.migrateSwimlanes(
      ctx,
      board,
      boardId,
      actor,
      jqlCtx,
      transpileOutcomes,
    );
    const quickFiltersCreated = await this.migrateQuickFilters(
      ctx,
      board,
      boardId,
      actor,
      jqlCtx,
      transpileOutcomes,
    );

    await ctx.entityMap.recordMapping({
      orgId: ctx.orgId,
      connectionId: ctx.job.connection_id,
      jobId: ctx.job.id,
      runId: ctx.run.id,
      entityType: BOARD_ENTITY,
      sourceId: board.sourceId,
      sourceKey: board.name,
      targetTable: 'boards',
      targetId: boardId,
      status: 'mapped',
      metadata: {
        name: board.name,
        type: board.type,
        column_count: board.columns.length,
        mapped_statuses: mappedStatuses,
        // `enriched: false` means the richer board config was never readable (Jira Cloud, or a
        // permission/endpoint failure). Without it, zeroes below would look like a faithful
        // migration of a board that simply had no filters.
        enriched: board.enriched === true,
        swimlanes_created: swimlanesCreated,
        quick_filters_created: quickFiltersCreated,
        // Per-filter transpilation audit: which JQL became a live RuleGroup, which stayed verbatim
        // and WHY, plus the filters-dialect query for server-side semantic verification.
        transpile_outcomes: transpileOutcomes,
        ...(board.filterId ? { source_filter_id: board.filterId } : {}),
      },
    });

    return { kind: 'created', targetId: boardId, targetTable: 'boards' };
  }

  /**
   * Jira swimlanes → `board_swimlanes`, skipping the default lane.
   *
   * The default is SKIPPED because `BoardsService.create` already inserted one and named it after
   * Jira's default (see the create call above). `idx_board_swimlanes_one_default` allows a single
   * `is_default` row per board, so writing Jira's default here would 23505 and fail the board.
   *
   * Only the `custom` strategy is migrated. Jira's `parentChild` and `none` strategies are not
   * user-defined lane lists at all, so materialising lanes for them would be inventing data.
   */
  private async migrateSwimlanes(
    ctx: StageContext,
    board: NormalizedBoard,
    boardId: string,
    actor: string,
    jqlCtx: TranspileContext | null,
    outcomes: Record<string, unknown>[],
  ): Promise<number> {
    const lanes = board.swimlanes ?? [];

    if (lanes.length === 0) return 0;

    if (board.swimlaneStrategy && board.swimlaneStrategy !== 'custom') {
      await ctx.log(
        'info',
        `boards: "${board.name}" uses the "${board.swimlaneStrategy}" swimlane strategy, which has ` +
          `no XISUITE equivalent — no swimlanes migrated`,
        { board: board.name },
      );

      return 0;
    }

    let created = 0;

    // sort_order starts at 1: the adopted default lane already occupies 0.
    for (const [index, lane] of lanes.filter((l) => !l.isDefault).entries()) {
      try {
        const { query, description } = await this.translateQuery(
          ctx,
          board,
          jqlCtx,
          'swimlane',
          lane.name,
          lane.query,
          lane.description,
          outcomes,
        );

        await this.boardsService.createSwimlane(boardId, ctx.orgId, actor, {
          name: lane.name,
          query,
          description,
          sort_order: index + 1,
          is_default: false,
        });
        created += 1;
      } catch (err) {
        // A swimlane is presentation, never worth losing an imported board over.
        await ctx.log(
          'warn',
          `boards: swimlane "${lane.name}" on "${board.name}" was not created: ${(err as Error).message}`,
          { board: board.name },
        );
      }
    }

    return created;
  }

  /** Jira quick filters → `board_quick_filters`. */
  private async migrateQuickFilters(
    ctx: StageContext,
    board: NormalizedBoard,
    boardId: string,
    actor: string,
    jqlCtx: TranspileContext | null,
    outcomes: Record<string, unknown>[],
  ): Promise<number> {
    const filters = board.quickFilters ?? [];
    let created = 0;

    for (const [index, filter] of filters.entries()) {
      // `board_quick_filters.query` is NOT NULL, and a filter that filters nothing is not a filter.
      if (!filter.query) {
        await ctx.log(
          'warn',
          `boards: quick filter "${filter.name}" on "${board.name}" has no query — skipped`,
          { board: board.name },
        );

        continue;
      }

      try {
        const { query, description } = await this.translateQuery(
          ctx,
          board,
          jqlCtx,
          'quickfilter',
          filter.name,
          filter.query,
          filter.description,
          outcomes,
        );

        await this.boardsService.createQuickFilter(boardId, ctx.orgId, actor, {
          name: filter.name,
          query: query ?? filter.query,
          description,
          sort_order: index,
          is_enabled: true,
        });
        created += 1;
      } catch (err) {
        await ctx.log(
          'warn',
          `boards: quick filter "${filter.name}" on "${board.name}" was not created: ${(err as Error).message}`,
          { board: board.name },
        );
      }
    }

    return created;
  }

  /**
   * Name→key/id maps for the JQL transpiler, from the crosswalk this run already wrote.
   *
   * Best-effort BY DESIGN: a lookup failure degrades to `null`, which makes every query store
   * verbatim — the exact pre-transpiler behaviour. Board filters are presentation; they must never
   * cost the board import.
   */
  private async buildJqlContext(
    ctx: StageContext,
  ): Promise<TranspileContext | null> {
    try {
      const [
        statusRows,
        priorityRows,
        issueTypeRows,
        userRows,
        customFieldRows,
      ] = await Promise.all([
        ctx.entityMap.listByEntityType(
          ctx.orgId,
          ctx.job.connection_id,
          'task_status',
        ),
        ctx.entityMap.listByEntityType(
          ctx.orgId,
          ctx.job.connection_id,
          'priority',
        ),
        ctx.entityMap.listByEntityType(
          ctx.orgId,
          ctx.job.connection_id,
          'issue_type',
        ),
        ctx.entityMap.listByEntityType(
          ctx.orgId,
          ctx.job.connection_id,
          'user',
        ),
        ctx.entityMap.listByEntityType(
          ctx.orgId,
          ctx.job.connection_id,
          'custom_field',
        ),
      ]);

      const customFieldOptions =
        await this.fetchCustomFieldOptions(customFieldRows);

      return buildTranspileContext({
        projectKey: ctx.job.source_ref,
        statusRows,
        priorityRows,
        issueTypeRows,
        userRows,
        customFieldRows,
        customFieldOptions,
      });
    } catch (err) {
      await ctx.log(
        'warn',
        `boards: JQL transpile context unavailable — filters stored verbatim: ${(err as Error).message}`,
      );

      return null;
    }
  }

  /**
   * Load `custom_fields.options` for the migrated select/radio fields, keyed by the crosswalk
   * `target_id` (= `custom_fields.id`). The transpiler needs the option label → stored-id map to
   * translate `cf[…] = "Some Option"`; only single-value option fields carry one, so text/number/
   * date fields are skipped to keep the query small. A read failure returns `{}` — those fields
   * simply refuse rather than costing the board import.
   */
  private async fetchCustomFieldOptions(
    customFieldRows: {
      target_id: string;
      status: string;
      metadata: Record<string, unknown> | null;
    }[],
  ): Promise<Record<string, { value: string; label: string }[]>> {
    const optionFieldIds = customFieldRows
      .filter(
        (r) =>
          r.status === 'mapped' &&
          (r.metadata?.field_type === 'select' ||
            r.metadata?.field_type === 'radio') &&
          !!r.target_id,
      )
      .map((r) => r.target_id);

    if (optionFieldIds.length === 0) return {};

    const { data, error } = (await this.supabaseAdmin
      .getClient()
      .from('custom_fields')
      .select('id, options')
      .in('id', optionFieldIds)) as {
      data: { id: string; options: unknown }[] | null;
      error: { message: string } | null;
    };

    if (error || !data) return {};

    const out: Record<string, { value: string; label: string }[]> = {};

    for (const row of data) {
      if (!Array.isArray(row.options)) continue;

      const opts = row.options
        .filter(
          (o): o is { value: string; label: string } =>
            !!o &&
            typeof (o as { value?: unknown }).value === 'string' &&
            typeof (o as { label?: unknown }).label === 'string',
        )
        .map((o) => ({ value: o.value, label: o.label }));

      if (opts.length > 0) out[row.id] = opts;
    }

    return out;
  }

  /**
   * JQL → stored query. Translated queries store the BOARD-dialect RuleGroup (that is what the
   * Kanban evaluator runs); fallbacks store the verbatim JQL, exactly as before this transpiler
   * existed. The original JQL is preserved in the description IN BOTH CASES, because the board
   * config screen's save path overwrites `query` with whatever its rule builder parsed.
   */
  private async translateQuery(
    ctx: StageContext,
    board: NormalizedBoard,
    jqlCtx: TranspileContext | null,
    artifact: BoardArtifact,
    name: string,
    jql: string | undefined,
    sourceDescription: string | undefined,
    outcomes: Record<string, unknown>[],
  ): Promise<{ query: string | undefined; description: string | undefined }> {
    const raw = (jql ?? '').trim();

    if (!raw || !jqlCtx) {
      return {
        query: jql,
        description: describeMigratedQuery(jql, sourceDescription),
      };
    }

    const result: TranspileOutput = transpileJql(raw, jqlCtx, artifact);

    if (result.board.ok) {
      await ctx.log(
        'info',
        `boards: ${artifact} "${name}" on "${board.name}" — JQL translated to a live query` +
          (result.stripped.length > 0
            ? ` (dropped, membership-neutral: ${result.stripped.join('; ')})`
            : ''),
        { board: board.name },
      );
      outcomes.push({
        name,
        artifact,
        translated: true,
        jql: raw,
        ...(result.stripped.length > 0 ? { stripped: result.stripped } : {}),
        // The filters-dialect twin, when expressible — the input for server-side semantic
        // verification via POST /filters/execute.
        ...(result.filters.ok ? { filters_query: result.filters.query } : {}),
      });

      return {
        query: JSON.stringify(result.board.query),
        description: describeMigratedQuery(raw, sourceDescription),
      };
    }

    await ctx.log(
      'warn',
      `boards: ${artifact} "${name}" on "${board.name}" — JQL NOT translated (${result.board.reason}); ` +
        'stored verbatim, so it renders but does not evaluate',
      { board: board.name },
    );
    outcomes.push({
      name,
      artifact,
      translated: false,
      jql: raw,
      reason: result.board.reason,
    });

    return {
      query: jql,
      description: describeMigratedQuery(jql, sourceDescription),
    };
  }
}
