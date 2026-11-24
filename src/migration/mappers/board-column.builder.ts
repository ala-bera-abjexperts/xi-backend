/**
 * @fileoverview Turns normalized board columns into the exact field set `board_columns` accepts.
 *
 * Pure and dependency-free ON PURPOSE — `boards.stage.ts` imports NestJS services, so keeping these
 * decisions here makes every one of them directly testable.
 *
 * Three database constraints shape this file, and getting any of them wrong fails the whole board
 * item rather than degrading:
 *
 *  1. `idx_board_columns_one_kanban_backlog` — a partial UNIQUE index allowing ONE
 *     `is_kanban_backlog` row per board. A live Kanban board has two columns both literally named
 *     "Backlog" (the kanplan one and an ordinary status-mapped one), so any name-based rule writes
 *     two `true` rows and throws 23505.
 *  2. `idx_board_columns_one_backlog` — the same, for `is_backlog`.
 *  3. `board_columns_wip_check` — `(max_wip = 0) OR (min_wip = 0) OR (max_wip >= min_wip)`, plus
 *     `@Min(0)` on the DTO. Greenhopper reports unset limits as `""`, `null`, or `-1` depending on
 *     version, so passing them through unmodified is a 400.
 *
 * The builder reports what it decided and why, via `notes`, because two of these decisions are
 * lossy and a silent loss is this project's signature failure mode.
 *
 * @module src/migration/mappers/board-column.builder
 */

import type { NormalizedBoardColumn } from '../model/normalized';

/** Exactly the fields `CreateColumnDto` accepts, already constraint-safe. */
export interface BoardColumnWrite {
  name: string;
  sort_order: number;
  min_wip: number;
  max_wip: number;
  is_kanban_backlog: boolean;
  is_backlog: boolean;
  is_done: boolean;
  /** Which evidence decided `is_done`, for the run log. */
  doneEvidence: 'resolution' | 'category' | 'none';
}

export interface BuildBoardColumnsResult {
  writes: BoardColumnWrite[];
  /** Human-readable notes about every lossy or corrective decision taken. */
  notes: string[];
}

/**
 * Coerce a Greenhopper WIP value to a non-negative integer.
 *
 * Greenhopper is inconsistent across versions: `""` and `null` both mean "unset", and some versions
 * send `-1`. All of them become 0, which the CHECK constraint reads as "no limit".
 */
function toWip(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;

  const n = Number(value);

  if (!Number.isFinite(n) || n < 0) return 0;

  return Math.floor(n);
}

/**
 * Decide whether a column means "done", and say which evidence decided it.
 *
 * The empty-status guard is load-bearing and not defensive noise: `[].every(...)` is `true` in
 * JavaScript, so without it the Kanban backlog column — which maps ZERO statuses by design — would
 * be classified as done, and every card completing the board would look finished.
 */
function decideDone(column: NormalizedBoardColumn): {
  isDone: boolean;
  evidence: BoardColumnWrite['doneEvidence'];
} {
  const statuses = column.statuses ?? [];

  if (statuses.length === 0) return { isDone: false, evidence: 'none' };

  // Jira's own answer, when the richer board config was readable.
  if (statuses.every((s) => s.isResolutionDone === true)) {
    return { isDone: true, evidence: 'resolution' };
  }

  // Fall back to the status category, which survives when `isResolutionDone` is absent.
  if (
    statuses.every((s) => (s.categoryKey ?? '').toLowerCase() === 'done') &&
    statuses.some((s) => s.categoryKey)
  ) {
    return { isDone: true, evidence: 'category' };
  }

  return { isDone: false, evidence: 'none' };
}

/**
 * Build constraint-safe column writes, preserving source order.
 *
 * @param columns  Normalized columns in the board's own order. `sort_order` follows the array index,
 *                 which is the board's order, never a re-derivation.
 */
export function buildBoardColumns(
  columns: readonly NormalizedBoardColumn[],
): BuildBoardColumnsResult {
  const notes: string[] = [];
  const writes: BoardColumnWrite[] = [];
  let kanbanBacklogClaimed = false;

  for (const [index, column] of columns.entries()) {
    let minWip = toWip(column.minWip);
    const maxWip = toWip(column.maxWip);

    // `board_columns_wip_check` permits an inverted pair only when one side is 0. Keep the MAXIMUM,
    // because that is the limit users actually enforce, and drop the minimum rather than lose both.
    if (minWip > 0 && maxWip > 0 && maxWip < minWip) {
      notes.push(
        `column "${column.name}": WIP min ${minWip} exceeded max ${maxWip}; kept the max and cleared the min`,
      );
      minWip = 0;
    }

    let isKanbanBacklog = column.isKanbanBacklog === true;

    if (isKanbanBacklog && kanbanBacklogClaimed) {
      // Only one row per board may carry this flag; a second would 23505 and fail the board.
      notes.push(
        `column "${column.name}": a second Kanban backlog column was reported; kept the first only`,
      );
      isKanbanBacklog = false;
    }

    if (isKanbanBacklog) kanbanBacklogClaimed = true;

    const { isDone, evidence } = decideDone(column);

    writes.push({
      name: column.name,
      sort_order: index,
      min_wip: minWip,
      max_wip: maxWip,
      is_kanban_backlog: isKanbanBacklog,
      // Always false, deliberately. `is_backlog` means the SCRUM sprint-backlog column, and
      // Greenhopper exposes no such flag — in Jira the Scrum backlog is a separate view, not a
      // column. The only available rule would be "scrum board, first column", which is a guess, and
      // a wrong guess here silently hides that column's cards from the board.
      is_backlog: false,
      is_done: isDone,
      doneEvidence: evidence,
    });
  }

  return { writes, notes };
}
