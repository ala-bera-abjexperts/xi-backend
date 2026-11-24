/**
 * @fileoverview Engine contracts — typed rows for the APPLIED M1 schema plus the
 * `IStageHandler` contract every P3–P11 stage implements. The engine is stage-agnostic:
 * it only drives `produce` (paging → seed entity items) and `processItem`
 * (transform → reuse-service write via the crosswalk).
 *
 * NOTE: these row shapes mirror the LIVE database (verified via MCP) — e.g.
 * `migration_run_items` has `retry_count`/`next_retry_at` and NO `updated_at`.
 */

import type { ISourceAdapter } from '../../adapters/source-adapter.interface';
import type { MigrationEntityMapService } from '../../services/migration-entity-map.service';

export type MigrationRunStatus =
  | 'queued'
  | 'preflight'
  | 'running'
  | 'paused'
  | 'sleeping'
  | 'succeeded'
  | 'partially_completed'
  | 'failed'
  | 'cancelled';

export type MigrationItemStatus =
  | 'pending'
  | 'running'
  | 'sleeping'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'paused'
  | 'blocked'
  | 'dead';

export type MigrationErrorClass =
  | 'transient'
  | 'rate_limited'
  | 'permanent'
  | 'conflict';

/** Run statuses from which no further work is leased and no transition is allowed. */
export const TERMINAL_RUN_STATUSES: readonly MigrationRunStatus[] = [
  'succeeded',
  'partially_completed',
  'failed',
  'cancelled',
];

/** Item statuses that count as "open" when deciding whether a stage is drained. */
export const OPEN_ITEM_STATUSES: readonly MigrationItemStatus[] = [
  'pending',
  'running',
  'sleeping',
  'blocked',
  'paused',
];

export interface MigrationRunRow {
  id: string;
  organization_id: string;
  job_id: string;
  connection_id: string;
  mode: 'dry_run' | 'live';
  status: MigrationRunStatus;
  current_stage: string | null;
  stage_index: number;
  config_snapshot: Record<string, unknown>;
  totals: Record<string, unknown>;
  correlation_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error_message: string | null;
  created_by: string | null;
  created_at: string;
}

export interface MigrationRunItemRow {
  id: string;
  organization_id: string;
  run_id: string;
  stage: string;
  stage_order: number;
  entity_type: string;
  item_kind: 'collection' | 'entity';
  source_ref: string | null;
  parent_source_ref: string | null;
  payload: Record<string, unknown> | null;
  status: MigrationItemStatus;
  retry_count: number;
  max_attempts: number;
  next_retry_at: string | null;
  wakeup_at: string | null;
  lease_until: string | null;
  worker_id: string | null;
  checkpoint: Record<string, unknown> | null;
  target_id: string | null;
  error_class: MigrationErrorClass | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

/** The slice of the migration_jobs row stage handlers may read. */
export interface MigrationJobContext {
  id: string;
  connection_id: string;
  source_kind: 'jira_project' | 'confluence_space';
  source_ref: string;
  target_space_id: string | null;
  scope: Record<string, unknown>;
  options: Record<string, unknown>;
}

/**
 * Per-item execution context handed to stage handlers. The adapter is LAZY —
 * `getAdapter()` performs SSRF validation + deployment detection on first call
 * only, so stages that never touch the source (or dry-run planning paths that
 * short-circuit) cost zero outbound requests.
 */
export interface StageContext {
  orgId: string;
  run: MigrationRunRow;
  job: MigrationJobContext;
  dryRun: boolean;
  getAdapter(): Promise<ISourceAdapter>;
  /**
   * The configured source URL, retained with its optional context path for
   * content relinking. Older unit harnesses may omit it; production workers
   * always provide it.
   */
  getSourceBaseUrl?(): Promise<string | null>;
  entityMap: MigrationEntityMapService;
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    context?: Record<string, unknown>,
  ): Promise<void>;
}

/** One entity work unit a producer wants seeded. */
export interface SeedItem {
  entityType: string;
  sourceRef: string;
  /** Same-entity-type parent gate (subtask parent / child page) — worker blocks until it maps. */
  parentSourceRef?: string;
  /** Minimal normalized snapshot so processItem avoids a re-fetch where possible. */
  payload?: Record<string, unknown>;
}

/** One `produce` invocation = one resumable page of seeding work. */
export interface ProduceResult {
  items: SeedItem[];
  /** Cursor persisted on the collection item; passed back on the next produce call. */
  nextCheckpoint: Record<string, unknown> | null;
  /** True when there are no more pages — the collection item completes. */
  done: boolean;
}

export type ItemOutcome =
  | { kind: 'created'; targetId: string; targetTable?: string }
  | { kind: 'updated'; targetId: string; targetTable?: string }
  | { kind: 'skipped'; reason?: string; targetId?: string }
  /** Dry-run: validated + recorded as `planned` in the crosswalk; no target write. */
  | { kind: 'planned' }
  /** Handler-detected unmet dependency beyond the generic parent gate. */
  | { kind: 'blocked'; waitingFor: { entityType: string; sourceId: string } };

/**
 * Typed processing error. `rate_limited` sleeps the item (and cools the whole
 * connection down for `retryAfterMs`); `transient` retries with backoff up to
 * `max_attempts`; `permanent`/`conflict` fail immediately (no retry).
 */
export class MigrationItemError extends Error {
  constructor(
    readonly errorClass: MigrationErrorClass,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'MigrationItemError';
  }
}

/** The single contract every stage (P3–P11) implements; P2 ships only the noop probe. */
export interface IStageHandler {
  /** Stage key — must match the run plan entry and the seeded items' `stage` column. */
  readonly stage: string;

  /**
   * Seed one page of entity items for this stage. Called via the stage's
   * `collection` item; re-leased with the persisted checkpoint until `done`.
   */
  produce(
    ctx: StageContext,
    collectionItem: MigrationRunItemRow,
  ): Promise<ProduceResult>;

  /** Process one entity item (transform + write through existing XISUITE services). */
  processItem(
    ctx: StageContext,
    item: MigrationRunItemRow,
  ): Promise<ItemOutcome>;
}
