/**
 * @fileoverview Source-agnostic agile board. Maps in Phase 7 to `BoardsService.create` +
 * `createColumn` + `mapStatusToColumn`. Never set the trigger-owned `boards.board_key`.
 */

/** One status as the board reports it, carrying the EVIDENCE for a column's done-ness. */
export interface NormalizedBoardColumnStatus {
  sourceId: string;
  name?: string;
  /** Jira status category key, e.g. `new`, `indeterminate`, `done`. */
  categoryKey?: string;
  /** Whether Jira considers this status to resolve the issue. */
  isResolutionDone?: boolean;
}

export interface NormalizedBoardColumn {
  name: string;
  /** Status sourceIds mapped to this column (from Jira board configuration columnConfig). */
  statusSourceIds: string[];

  // ---- Enrichment. All optional: `undefined` means "the source never told us", which is NOT the
  // same as `false`/`0` and must not be written as if it were.

  /** Work-in-progress minimum, when the board reports one. */
  minWip?: number;
  /** Work-in-progress maximum, when the board reports one. */
  maxWip?: number;
  /**
   * Jira's `isKanPlanColumn`: the Kanban backlog column.
   *
   * It maps ZERO statuses by design, which is why it cannot be identified by name — a Kanban board
   * routinely has a second, ordinary column also called "Backlog".
   */
  isKanbanBacklog?: boolean;
  /** Per-status evidence, used to decide whether the column means "done". */
  statuses?: NormalizedBoardColumnStatus[];
}

/** A board quick filter or swimlane. Both are `{name, query, description}` on either side. */
export interface NormalizedBoardFilter {
  sourceId: string;
  name: string;
  /** The source's query. On Jira this is JQL, which XISUITE does not evaluate natively. */
  query: string;
  description?: string;
  /** Swimlanes only: the catch-all lane. */
  isDefault?: boolean;
}

export interface NormalizedBoard {
  /** Required configuration was inaccessible; columns are unknown, never an empty board to import. */
  configurationError?: string;
  /** Stable agile board id (numeric as string). */
  sourceId: string;
  name: string;
  type: 'kanban' | 'scrum';
  columns: NormalizedBoardColumn[];
  /** Jira rank field id (e.g. "customfield_10011") when reported. */
  rankFieldId?: string;
  /** Saved filter backing the board, when reported. */
  filterId?: string;

  /**
   * Whether the richer board configuration was actually READ.
   *
   * Distinguishes "the source reported no WIP limits and no quick filters" from "we never managed
   * to ask" — the richer endpoint is permission-gated on both Jira deployments. Without this flag
   * an empty `quickFilters` would look like a faithful migration of nothing.
   */
  enriched?: boolean;
  quickFilters?: NormalizedBoardFilter[];
  swimlanes?: NormalizedBoardFilter[];
  /** Jira's swimlane strategy, e.g. `custom`, `parentChild`, `none`. */
  swimlaneStrategy?: string;
  /** Explicitly audited metadata fallbacks used when optional source configuration is unreadable. */
  migrationWarnings?: string[];
}
