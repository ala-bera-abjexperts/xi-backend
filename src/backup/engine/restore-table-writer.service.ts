/**
 * @fileoverview Writes one table's archived rows back, or explains every row it would not.
 * @module src/backup/engine/restore-table-writer.service
 *
 * This is the only place in the module that inserts restored data, and it is deliberately small:
 * everything that decides WHETHER a row may be written lives in `restore-row-preparer.ts`, and
 * everything that decides whether the run may happen at all lives in `restore-planner.ts`.
 *
 * ## INSERT, never upsert
 *
 * `.upsert()`, `.update()` and `ON CONFLICT DO UPDATE` are banned here. All ~83 `updated_at`
 * triggers are BEFORE UPDATE, so updating a restored row rewrites the very history the restore
 * exists to bring back. A row that is already present is counted as skipped and left exactly as it
 * is — the archive does not get to overwrite the live database.
 *
 * ## Why a failed batch is retried row by row
 *
 * PostgREST sends a batch as one statement, so one bad row fails all of them. Reporting a
 * 500-row batch as 500 failures because of one duplicate would be false, and it would hide the 499
 * rows that were fine. On a batch failure that could be row-level, every row is retried alone: slow,
 * but it happens only on the batches that actually failed, and it is the difference between "499
 * restored, 1 duplicate" and "500 failed".
 *
 * ## Counting is not bookkeeping
 *
 * Every suppressed row is counted and given a reason. An uncounted skip is indistinguishable from
 * data loss — the operator sees "succeeded" over a table that is quietly missing rows.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { sequenceRekeyFor, tableEntry } from '../registry/component-registry';
import type { ComponentTable } from '../registry/component-registry';
import { buildRowLabel } from '../registry/row-label-columns';
import {
  redactRowForRecord,
  type RedactionOptions,
} from './restore-record-redactor';
import type { OpenedArchive } from './archive-reader.service';
import type { PlannedTable } from './restore-planner';
import { SpaceParentIndex } from './restore-space-scope';
import type { SpaceParentFallbackClient } from './restore-space-scope';
import {
  batchesOf,
  classifyInsertError,
  prepareRow,
  rowKeyOf,
  type ConflictClass,
} from './restore-row-preparer';
import {
  remapSpecFor,
  entityMapKey,
  remapRow,
  seedIds,
  type RemapPlan,
  type RemapState,
} from './restore-id-remapper';

/**
 * Rows per insert request.
 *
 * The backend accepts a 10 MB body, so a 200 000-row table cannot be one request. Set well below
 * that rather than measured against it, because a row's serialised size is not knowable in advance.
 */
export const INSERT_BATCH_ROWS = 200;

/** A row's id as a string, or null when it has none or it is not scalar. */
function scalarId(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  return null;
}

/**
 * What a `23505` actually says, for a report that has twice claimed more than it knew.
 *
 * "Already present" is an inference, not an observation. The engine sees a unique violation; whether
 * the row it collided with is in THIS space is a separate question nobody asked. Twice now the answer
 * has been no. `automations.webhook_token` is indexed without a tenant column, so a re-scoped
 * automation collided with the row it was copied FROM and 116 dependent rows were reported "already
 * present" against an empty destination. `file_attachments` was the same shape through a different
 * door — `UNIQUE (entity_type, entity_id, file_name)`, no `space_id` — and reported three attachments
 * present in a space that held none.
 *
 * Naming the constraint is what tells those apart from a real duplicate, and it costs nothing: the
 * name is already in the message Postgres returned. Kept as a suffix so the sentence a reader knows
 * still opens it.
 *
 * @param message The driver's error message, which carries `… unique constraint "<name>"`.
 */
function duplicateDetail(message: string | null | undefined): string {
  const base =
    'This row was refused as a duplicate, so it was left unchanged. A row with the same key ' +
    'already exists — not necessarily in this space.';

  const constraint = constraintNameOf(message);

  return constraint ? `${base} Constraint: ${constraint}.` : base;
}

/** What an insert answered with. `details` is Postgres's DETAIL line. */
interface InsertError {
  code: string | null;
  message: string;
  details: string | null;
}

/** One column of a violated unique key. `lower(col)` indexes compare case-insensitively. */
interface ConflictKeyColumn {
  column: string;
  caseInsensitive: boolean;
}

/**
 * Per table: the index whose refusal is answered by rewriting a column and inserting anyway.
 *
 * Deliberately an allowlist rather than a rule. Giving up a value is only ever right where the
 * value is a claim on something product-wide that the destination can reissue, and the alternative
 * is losing the row and everything hanging off it. Every other unique index still means what it
 * says.
 *
 * Read only on a cross-organization restore — see `reissueOnConflict`.
 */
/**
 * Per-space configuration tables whose row may REPLACE the destination's own, on request.
 *
 * These are the only tables where a restore is allowed to overwrite, and the reason is narrow:
 * they are `UNIQUE (organization_id, space_id)`, so restoring a many-space organization into a
 * smaller one folds several source spaces onto one destination space and only one configuration
 * can occupy it. Without this the archived row has nowhere to go at all.
 *
 * The value is the key to match the existing row on — the same columns the unique index covers.
 *
 * A deliberate allowlist, never a rule. Overwriting is destructive: it replaces settings the
 * destination organization may have been using for weeks, and it fires an `updated_at` BEFORE
 * UPDATE trigger, rewriting the history a restore exists to recover. It happens only for these
 * tables, only cross-organization, and only when the operator asked for it.
 */
const REPLACE_ON_CONFLICT: Record<string, string[]> = {
  task_hierarchy_configurations: ['organization_id', 'space_id'],
  form_builder_payment_configs: ['organization_id', 'space_id'],
};

/**
 * Reason codes that all mean "this row lost to a row already in the destination", and whose
 * blocker is therefore a legitimate parent for this restore's children.
 *
 * These are RELABELS of one verdict, not separate verdicts. `attachByConflictKey` renames the
 * reason AFTER the skip is decided, purely so the report can say something more useful than
 * "already exists" — and `mapDuplicatesToLiveRows` used to test the bare literal `'duplicate'`,
 * so the rename silently switched child re-parenting back off for every renamed row. One restore
 * collapsed 424 parents and dropped 2,188 children as `missing_parent` because of it.
 *
 * Membership here is NOT a tenancy decision. `duplicate_foreign_tenant` and
 * `duplicate_outside_target_scope` are deliberately absent, but the guard that actually protects
 * tenancy is `liveRowTargetScope === 'target'` at the adoption site — that check is load-bearing
 * and must stay, because `removeNonTargetDuplicateRows` only adjusts a counter and leaves those
 * records in place.
 */
const ADOPTABLE_DUPLICATE_REASONS = new Set([
  'duplicate',
  'duplicate_space_collapsed',
  'duplicate_shared',
]);

const REISSUE_ON_CONFLICT: Record<
  string,
  {
    constraint: string;
    column: string;
    mode: 'null' | 'suffix' | 'false' | 'value';
    /** The replacement, for `value`. Ignored by every other mode. */
    value?: string;
    /** Report sentence, when the generic one for this mode would be wrong. */
    detail?: string;
  }
> = {
  form_builder: {
    constraint: 'form_builder_public_slug_uq',
    column: 'public_slug',

    // Nullable, and an unpublished form simply has no public URL until somebody publishes it.
    mode: 'null',
  },
  partner_public_listings: {
    constraint: 'partner_public_listings_slug_uidx',
    column: 'slug',

    // NOT NULL, so emptying it would trade a 23505 for a 23502 and restore nothing. The value is
    // suffixed with the destination organization instead — derived, never random, so restoring the
    // same archive twice produces the same slug and the second run reports a real duplicate rather
    // than inserting a near-copy.
    mode: 'suffix',
  },
  partner_customer_addresses: {
    constraint: 'partner_customer_addresses_one_primary_uidx',
    column: 'is_primary',

    // `UNIQUE (customer_id) WHERE is_primary` — one primary address per customer, which is a real
    // rule and stays. The archived address was primary for ITS customer; the destination's customer
    // already has one, so the flag is what collides, not the address.
    //
    // NOT NULL and a boolean, so neither emptying nor suffixing applies: it is restored demoted.
    // The address comes back and the destination's existing primary keeps its place, which is the
    // only outcome that neither loses the record nor overrides a choice somebody already made.
    mode: 'false',
  },
  partner_customers: {
    constraint: 'partner_customers_one_active_partner_uidx',
    column: 'status',

    // `UNIQUE (customer_organization_id) WHERE status = 'active' AND NOT is_deleted` — one partner
    // actively owns a customer organization, product-wide. That rule stays, and this index is the
    // ONLY thing enforcing it: no trigger, no RLS policy and no application check stands behind it.
    //
    // Cross-organization the row arrives with `organization_id` rewritten to the destination but
    // `customer_organization_id` untouched — it names a customer, not a tenant, so there is nothing
    // to remap it to. It therefore collides with whichever OTHER partner already holds that
    // customer. The active claim is what collides, not the customer record.
    //
    // NOT NULL text constrained to `prospect|active|inactive`, so neither emptying nor suffixing
    // applies: it is restored demoted, the same shape as `partner_customer_addresses` above. The
    // customer comes back visible and attributable, and the destination's existing active partner
    // keeps its claim. Skipping instead lost the row outright, which is the bug this answers.
    //
    // The sibling `partner_customers_partner_customer_uidx` is deliberately NOT listed: it is
    // `UNIQUE (organization_id, customer_organization_id)`, so a collision there is this partner
    // already holding this customer — a real duplicate, and a skip is the right answer.
    mode: 'value',
    value: 'inactive',
  },
  tasks: {
    constraint: 'idx_tasks_key_unique',
    column: 'key',

    // Only reachable when a key minted from the space counter is already taken. Sent empty, the
    // key trigger assigns the next free one.
    mode: 'null',
    detail:
      'The task key was already taken in this space, so the task was given the next free key.',
  },
};

/** The unique index a `23505` names, or null when the message is shaped differently. */
function constraintNameOf(message: string | null | undefined): string | null {
  return /unique constraint "([^"]+)"/.exec(message ?? '')?.[1] ?? null;
}

/**
 * What a reissued column becomes when its one named index is what refused the row.
 *
 * A function rather than a nested conditional because the modes are the whole contract of
 * {@link REISSUE_ON_CONFLICT}, and a fourth branch inlined at the call site is where a fifth gets
 * added wrongly.
 */
function reissuedValue(
  reissue: {
    mode: 'null' | 'suffix' | 'false' | 'value';
    value?: string;
    suffix: string;
  },
  current: unknown,
): unknown {
  switch (reissue.mode) {
    case 'null':
      return null;
    case 'false':
      return false;
    case 'value':
      return reissue.value;
    default:
      return `${String(current)}-${reissue.suffix}`;
  }
}

/** The operator-facing account of a reissue, in the terms of the value that was given up. */
function reissuedDetail(reissue: {
  column: string;
  mode: 'null' | 'suffix' | 'false' | 'value';
  value?: string;
  detail?: string;
}): string {
  if (reissue.detail) {
    return reissue.detail;
  }

  switch (reissue.mode) {
    case 'null':
      return (
        `${reissue.column} is already used by another organization, so it was left ` +
        'empty and the rest of the row was restored.'
      );
    case 'false':
      return (
        `Another record already holds ${reissue.column} here, so this one was ` +
        'restored without it rather than displacing what was already chosen.'
      );
    case 'value':
      return (
        `Another organization already holds ${reissue.column} here, so this one was ` +
        `restored as "${String(reissue.value)}" rather than displacing a claim that ` +
        'was already made. Nothing the destination had was changed.'
      );
    default:
      return (
        `${reissue.column} is already used by another organization, so it was given ` +
        'a new value and the rest of the row was restored.'
      );
  }
}

/**
 * The columns and values a unique violation actually collided on.
 *
 * Postgres writes `Key (a, b)=(1, 2) already exists.` into DETAIL. That is the only statement of
 * WHICH row blocked this one — the message names the constraint but never the value — so it is
 * what makes "already exists" checkable rather than merely asserted.
 *
 * Returns null rather than guessing whenever the shape is not exactly what is expected: a value
 * containing `, ` splits wrongly, and a wrong pair here would look up somebody else's row. The
 * caller treats null as "cannot identify the blocker" and keeps today's plain skip.
 */
export function parseConflictKey(
  details: string | null | undefined,
): { columns: ConflictKeyColumn[]; values: string[] } | null {
  // `[^)]` cannot match an expression index, whose key contains its own parentheses —
  // `Key (lower(public_slug))=(x)`. The lazy `.+?` up to `)=(` reads both shapes.
  const match = /Key \((.+?)\)=\((.*)\) already exists/.exec(details ?? '');

  if (!match) {
    return null;
  }

  const raw = match[1].split(', ').map((column) => column.trim());
  const values = match[2].split(', ');

  // A value holding ", " makes the two lists disagree, and pairing them anyway would map a column
  // to a fragment of some other column's value.
  if (!raw.length || raw.length !== values.length) {
    return null;
  }

  const columns: ConflictKeyColumn[] = [];

  for (const entry of raw) {
    // `lower(col)` is unwrapped to `col` compared case-insensitively, because that is the shape
    // real indexes use here (`form_builder_public_slug_uq`) and dropping it would blind exactly
    // the case this was written for. Any OTHER expression is refused rather than guessed at:
    // there is no column to filter on, and inventing one would read somebody else's row.
    const lowered = /^lower\(([a-z0-9_]+)\)$/i.exec(entry);

    if (lowered) {
      columns.push({ column: lowered[1], caseInsensitive: true });
      continue;
    }

    if (/[^a-z0-9_]/i.test(entry)) {
      return null;
    }

    columns.push({ column: entry, caseInsensitive: false });
  }

  return { columns, values };
}

/**
 * Stands in for a key the destination's sequence issued, which a blind insert cannot read back.
 *
 * Deliberately not a number and not a uuid, so anything that ever tries to use it as an id fails
 * loudly instead of silently addressing row 44 of somebody else's space.
 */
export const SEQUENCE_ASSIGNED_KEY = 'sequence-assigned';

/** Rows read from the archive before any are written. Bounds memory on a large table. */
const READ_BATCH_ROWS = 500;

/**
 * Conflict classes this writer raises on top of the ones an insert error produces.
 *
 * `refused_row` is a row the rules would not send at all; `missing_user` is a reference emptied
 * because the user is gone. Neither comes from Postgres, so neither is in `ConflictClass`.
 */
export type WriterConflictClass =
  | ConflictClass
  | 'refused_row'
  | 'missing_user';

type LiveRowTargetScope =
  | 'target'
  | 'foreign_tenant'
  | 'outside_target_space'
  | 'unknown';

export interface RestoreConflictRecord {
  table: string;
  conflictClass: WriterConflictClass;
  severity: 'info' | 'warning' | 'error';
  rowKey: string | null;
  resolution: 'skipped' | 'degraded_to_null' | 'refused' | 'unresolved';
  detail: string;
  columnName?: string;
}

export interface TableRestoreResult {
  table: string;
  status: 'succeeded' | 'partial' | 'failed' | 'skipped';
  plannedRows: number;
  insertedRows: number;
  skippedRows: number;
  failedRows: number;
  /** Nullable user references that were emptied, by column. Reported, never silent. */
  nulledUserColumns: Record<string, number>;
  /**
   * Rows dropped because they belong to a different space than the one chosen.
   *
   * Counted separately from `skippedRows` because the reason matters: a table whose rows were all
   * filtered out is not the same outcome as one whose rows were all already present, and reporting
   * both as a bare "skipped" is what let a fully-filtered restore finish green with no explanation.
   */
  otherSpaceRows: number;

  /**
   * Rows left alone because the destination already held them.
   *
   * The sibling of `otherSpaceRows`, and needed for the same reason it is: `skippedRows` is an
   * AGGREGATE. It carries duplicates, missing parents, missing users and space-filtered rows in one
   * number, so "nothing was inserted and something was skipped" cannot tell an operator which of
   * those happened. Reading `already_present` off that aggregate would report a table whose every
   * row was dropped for a missing parent as though its data were safely already there — the exact
   * confident falsehood `outcomeReason` exists to stop telling.
   */
  duplicateRows: number;
  conflicts: RestoreConflictRecord[];
  /**
   * One entry per row the writer reached a verdict on, for the restore report.
   *
   * Separate from `conflicts` because the two answer different questions and are read by different
   * screens. `conflicts` is "what went wrong", written at three granularities (run, table, row) and
   * counted into `restore_runs.conflict_count`. This is strictly row-level: it is the only thing
   * that can answer "was THIS record restored", which is the question an operator actually asks.
   */
  records: RestoreRunRecord[];
  /**
   * Conflicts the cap refused to record, and records the cap refused to keep.
   *
   * Reported rather than silent. The pre-existing behaviour dropped over-cap conflicts with no
   * counter and no log, so a run with one systemic problem looked identical to a clean one once the
   * first 500 were written.
   */
  truncatedConflicts: number;
  truncatedRecords: number;
  errorMessage?: string;

  /**
   * Why this table produced no restored rows, for a report that could not previously say.
   *
   * Persisted to `restore_run_items.outcome_reason`. Set only where the counts alone are ambiguous:
   * a table that restored rows needs no explanation, and a failed one already explains itself
   * through `errorMessage`.
   *
   * Decided HERE rather than inferred by the client, because the client cannot see the ladder that
   * produced the status and would have to keep a copy of it. This module has twice paid for that
   * pattern — the wizard's four-name literal and the thirteen-name spec map, both recounted in
   * `restore-id-remapper.ts` — so the rule and its answer stay in the same place.
   */
  outcomeReason?:
    | 'archive_empty'
    | 'other_space'
    | 'already_present'
    | 'unmapped_reference'
    | 'missing_parent';
}

/** What happened to one archived row. Mirrors the restore_run_records table. */
export interface RestoreRunRecord {
  table: string;
  /** From `rowKeyOf`. Null when every key column of the archived row was null. */
  rowPk: string | null;
  /** Human handle from the registry's label columns. Null is normal. */
  rowLabel: string | null;
  outcome: 'restored' | 'skipped' | 'failed';
  /** duplicate | missing_parent | other_space | missing_user | foreign_tenant | … */
  reasonCode?: string;
  reasonDetail?: string;

  /**
   * The table a refused reference pointed at, when the refusal knew one.
   *
   * Unlike `conflict` below, this DOES reach `restore_run_records` — it is the whole point. It turns
   * "131 rows skipped because form_id" into "131 rows skipped because the component holding
   * form_builder was not selected", which is the question the operator is actually asking, and it is
   * counted from what happened rather than predicted from a registry that has been shown to drift.
   */
  referencesTable?: string;

  /**
   * The unique index that refused this row, carried from the insert.
   *
   * IN-PROCESS ONLY — `recordRunRecords` maps named columns, so this never reaches
   * `restore_run_records`. It exists so `attachLiveRows` can find the blocking row by the key it
   * actually collided on, instead of by an id that a remapped insert never wrote.
   */
  conflict?: {
    constraintName: string | null;
    key: { columns: ConflictKeyColumn[]; values: string[] } | null;
  };
  /**
   * The archived row, redacted and clamped. Carried ONLY for skipped and failed rows.
   *
   * A restored row is already live in the destination; copying it here would duplicate tenant data
   * and multiply the storage of the table being restored. A skipped row exists nowhere else.
   */
  archivedRow?: Record<string, unknown> | null;
  /** The live row a duplicate collided with. Filled in by a batched lookup, never row-by-row. */
  liveRow?: Record<string, unknown> | null;
  /**
   * IN-PROCESS ONLY. Whether the unredacted live row belongs to the selected restore target.
   *
   * The persisted `liveRow` is redacted and clamped for reporting, so it must not be used as the
   * source of truth for remapping children.
   */
  liveRowTargetScope?: LiveRowTargetScope;
  /** IN-PROCESS ONLY. The live row id read before payload redaction. */
  liveRowId?: string;
  /** 1 = first attempt, 2 = the deferred-parent retry pass. */
  pass: 1 | 2;
}

/**
 * What the insert path decided about one row, before it becomes a report record.
 *
 * Carried back to `restoreTable` rather than turned into a `RestoreRunRecord` in place, so that
 * labelling, redaction and the payload budget all stay in the one closure that owns them. An insert
 * helper that also redacted would be two places to change when the denylist grows.
 */
interface RowOutcome {
  row: Record<string, unknown>;
  rowPk: string | null;
  outcome: 'restored' | 'skipped' | 'failed';
  reasonCode?: string;
  reasonDetail?: string;

  /**
   * The unique index that refused this row, and the key it collided on.
   *
   * Structured rather than left in the `reasonDetail` sentence, because the live-row lookup has to
   * filter on these values — and a regex over prose written for a human is not something to build
   * a tenant-scoped query from. Set only on a duplicate; absent everywhere else.
   */
  conflict?: {
    constraintName: string | null;
    key: { columns: ConflictKeyColumn[]; values: string[] } | null;
  };
}

export interface RestoreTableInput {
  archive: OpenedArchive;
  planned: PlannedTable;
  organizationId: string;
  /** Users present in the destination, or null when the check is not being made. */
  knownUsers: Set<string> | null;
  /** True to plan only. Reads and validates everything; writes nothing. */
  dryRun: boolean;

  /**
   * Asks whether the operator has cancelled the run, checked once per read batch.
   *
   * Optional, and absent means today's behaviour exactly — every existing caller and test is
   * unaffected. Supplied by the run loop, which owns the throttling so one budget covers both its
   * own between-tables check and this one.
   */
  shouldStop?: () => Promise<boolean>;
  /** Counts so far for this table, at most every few seconds, so a long table visibly moves. */
  onProgress?: (counts: {
    planned: number;
    inserted: number;
    skipped: number;
    failed: number;
  }) => Promise<void>;
  /** Cap on recorded conflicts, so one systemic problem cannot write a million rows. */
  maxConflicts?: number;
  /**
   * Cap on per-row report records for THIS table.
   *
   * Much higher than the conflict cap because the two carry different weight: a record is ~100
   * bytes of identity, a conflict is a row in a table the existing UI counts. `task_history` alone
   * holds 729 rows in a development database and the writer's own worst case is 200 000 in one
   * table, so a cap in the hundreds would truncate on the first real restore.
   */
  maxRecords?: number;
  /**
   * Redaction settings from the backup scheme, threaded through to the row payloads.
   *
   * Absent means "redact everything redactable", which is the safe reading for the schemes that
   * predate the options being honoured — i.e. all of them.
   */
  /**
   * Let per-space configuration replace the destination's own, for the tables in
   * {@link REPLACE_ON_CONFLICT}.
   *
   * Absent or false is the default and the pre-existing behaviour: a restore inserts, never
   * updates, and a slot already taken is reported rather than overwritten.
   */
  replaceExistingConfig?: boolean;

  redaction?: RedactionOptions;
  /**
   * Labels of rows already restored in this run, as `table -> id -> label`.
   *
   * Shared across the whole run so a child can be named after its parent — "Onboarding Form ·
   * submitted" rather than "submitted", which is true of every submission ever made. Safe because
   * the planner inserts in dependency order: a parent's level is strictly lower than its child's,
   * so it has already been through here by the time the child is labelled.
   *
   * Omitted, children fall back to describing themselves. It is an improvement to the label, never
   * a requirement for one.
   */
  labelIndex?: Map<string, Map<string, string>>;
  /**
   * Restore only rows in this space.
   *
   * How each table is tested comes from its `spaceScope`: its own column, the row it points at, its
   * own id, or not at all for organization-level tables.
   */
  spaceId?: string | null;
  /**
   * Resolves which rows of a parent table are in `spaceId`, for the tables that have no space of
   * their own.
   *
   * Shared across the run because `tasks` is the space parent of seven tables and must be scanned
   * once. Omitted, the writer builds a private one — so forgetting to thread it is a wasted scan
   * rather than an unfiltered table.
   */
  spaceParents?: SpaceParentIndex;
  /**
   * The client to write through.
   *
   * Absent means this instance, which is what every restore did before destinations existed — so
   * an omitted client keeps the original behaviour rather than changing it.
   */
  client?: WriteClient;
  /**
   * Present only for a restore into a DIFFERENT organization.
   *
   * When it is set every row is given a new identity and every reference is repointed, because both
   * organizations share one database and the archived ids still belong to the source tenant.
   * Absent — the ordinary case — leaves the id-preserving behaviour exactly as it was.
   */
  remap?: { plan: RemapPlan; state: RemapState };
}

/**
 * A client shaped like the one `SupabaseAdminService` hands out.
 *
 * Taken from the method rather than written as `SupabaseClient`: the bare generic defaults differ
 * from the schema-parameterised form, and the mismatch surfaces as an unsafe assignment.
 */
export type WriteClient = ReturnType<SupabaseAdminService['getClient']>;

const DEFAULT_MAX_CONFLICTS = 500;

/**
 * Per-table cap on report records.
 *
 * Sized against the real shape of the data rather than a round number: identity is ~100 bytes, so
 * 20 000 rows is ~2 MB for the largest table anyone has actually restored. Hitting it is reported.
 */
const DEFAULT_MAX_RECORDS = 20_000;

/**
 * How many skipped/failed rows carry their full payload.
 *
 * Below the record cap on purpose. Identity is what makes a record findable; the payload is what
 * makes it expensive. A table that skipped 20 000 rows for one systemic reason does not need 20 000
 * copies of the reason to be understood.
 */
const DEFAULT_MAX_PAYLOADS = 2_000;

/** Live rows fetched per lookup when filling in `liveRow` for duplicates. */
const LIVE_LOOKUP_CHUNK = 200;

/** Minimum gap between mid-table progress reports. */
const PROGRESS_EVERY_MS = 5_000;

/**
 * Labels held per table so children can be named after their parent.
 *
 * A naming convenience, not a correctness requirement — so it is capped rather than allowed to
 * become the largest object in the process on a 200 000-row table.
 */
const MAX_LABEL_INDEX_PER_TABLE = 20_000;

@Injectable()
export class RestoreTableWriterService {
  private readonly logger = new Logger(RestoreTableWriterService.name);

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Reads one table out of the archive and writes what may be written.
   *
   * The archive member's checksum is verified by `readTable` before it yields anything, so no row
   * reaching this method comes from bytes that were not proven against the manifest.
   */
  async restoreTable(input: RestoreTableInput): Promise<TableRestoreResult> {
    const { planned, organizationId, dryRun } = input;
    const entry = tableEntry(planned.table);

    const result: TableRestoreResult = {
      table: planned.table,
      status: 'succeeded',
      plannedRows: 0,
      insertedRows: 0,
      skippedRows: 0,
      failedRows: 0,
      otherSpaceRows: 0,
      duplicateRows: 0,
      nulledUserColumns: {},
      conflicts: [],
      records: [],
      truncatedConflicts: 0,
      truncatedRecords: 0,
    };
    const skippedReasonCounts: Record<string, number> = {};
    const countSkippedReason = (reason?: string) => {
      if (!reason) {
        return;
      }

      skippedReasonCounts[reason] = (skippedReasonCounts[reason] ?? 0) + 1;
    };

    if (!entry) {
      // Unreachable through the planner, which refuses an unknown table. Kept because this method
      // is the last thing between an archive and the database, and it must not trust its caller.
      return {
        ...result,
        status: 'failed',
        errorMessage: `${planned.table} is not in the backup registry.`,
      };
    }

    const maxConflicts = input.maxConflicts ?? DEFAULT_MAX_CONFLICTS;
    const maxRecords = input.maxRecords ?? DEFAULT_MAX_RECORDS;
    // Derived from the schema, not from a hand-written list. A table used to be movable only if
    // somebody had written a spec for it, so `form_builder` could be restored into another space
    // while its own fields, webhooks and integrations were refused one row at a time as
    // `other_space` — 181 rows of one 305-row restore, for no reason the operator could see.
    const remapSpec = input.remap
      ? remapSpecFor(
          planned.table,
          entry,
          input.remap.plan.archiveOrganizationId !==
            input.remap.plan.targetOrganizationId,

          // Read off the plan rather than re-derived from the absence of a destination space. The
          // plan is what `remapRow` consults a moment later, so asking it the same question the same
          // way is what keeps "does this table get a spec" and "what does that spec do" from
          // disagreeing — and a disagreement here means `spaces` is written with no spec, which
          // inserts it under the SOURCE tenant's id.
          input.remap.plan.recreateSpaces,
        )
      : undefined;

    /**
     * Set only when this run is genuinely re-keying AND the destination assigns this table's key.
     *
     * Both halves are load bearing. A restore back into the SAME space builds no `remap` at all, and
     * there the archived id must be sent exactly as it always has been so an existing row answers
     * `23505` and is recognised as already present. Reissuing it there would insert a second copy of
     * every row and report it as a clean restore — which is why this is gated on `remapSpec` rather
     * than on the table name alone.
     */
    const rekey =
      input.remap && remapSpec ? sequenceRekeyFor(planned.table) : undefined;

    /** One value for the whole table, so a restored batch does not fan out over milliseconds. */
    const neutralisedAt = new Date().toISOString();

    /**
     * Rows whose `neutraliseWhenNull` column this restore filled in.
     *
     * Tracked so the report can say so. The row is genuinely `restored`, so it carries no reason
     * CODE — but it now claims a delivery that never happened, and an operator reading the record
     * is owed that sentence rather than left to infer it from a timestamp.
     */
    const stampedRows = new Set<Record<string, unknown>>();

    /**
     * The sentence for a stamped row, or undefined for every other row in the product.
     *
     * Rides on `reasonDetail` with NO `reasonCode`, which is a shape the report already supports:
     * both fields are optional, a restored row already persists a null `reason_code`, and the detail
     * renders on its own in `RestoreRecordDetail`. Inventing a reason code for this would have meant
     * a new conflict class and two new translations to describe something that is not a conflict.
     */
    const neutralisedDetailFor = (row: Record<string, unknown>) =>
      stampedRows.has(row)
        ? 'This event had not been delivered when the backup was taken. It was restored marked as ' +
          'delivered, so it records what happened without firing this space’s automations.'
        : undefined;

    /**
     * True when the rows are moving to a different TENANT, as opposed to a different space inside
     * the same one.
     *
     * The two need opposite failure modes. Cross-organization, every row carries the wrong tenant,
     * so a table without a rewrite spec has nothing salvageable and the whole table must fail.
     * Within one organization only the space-scoped rows need moving — and most tables are mixed:
     * `custom_fields` holds 2 organization-wide rows and 9 space-scoped ones, and failing the table
     * would throw away the 2 that were never going anywhere. Those refuse per row instead, in
     * `refuseUnmovableRow`.
     */
    const crossOrganization = Boolean(
      input.remap &&
      input.remap.plan.targetOrganizationId !==
        input.remap.plan.archiveOrganizationId,
    );

    // Fail closed. A cross-organization run re-points the tenant check at the ARCHIVE's
    // organization so its rows can be rewritten — which means a table with no rewrite spec would
    // sail straight through that check and be INSERTED still carrying the source organization's
    // id. Rows physically written into the wrong tenant, with no constraint to object.
    //
    // The allowlist in `restore-approvals.service.ts` is supposed to make this unreachable. This is
    // here because "supposed to" is not a guarantee: the two lists are edited by different people
    // at different times, and the cost of them disagreeing is silent cross-tenant corruption.
    if (crossOrganization && !remapSpec) {
      return {
        ...result,
        status: 'failed',
        errorMessage:
          `${planned.table} cannot be restored into another organization: its rows carry ids that ` +
          'this engine does not know how to rewrite, so they would be written into the wrong tenant.',
      };
    }

    const context = {
      entry,

      // The tenant check does not disappear when remapping, it changes what it compares against.
      // Passing the ARCHIVE's organization makes `refuseForeignTenant` accept the rows this restore
      // is meant to move and still refuse anything that was never the source's — a tampered file,
      // or a bug upstream — which would otherwise be rewritten into the destination unnoticed.
      organizationId: input.remap
        ? input.remap.plan.archiveOrganizationId
        : organizationId,
      generatedColumns: planned.generatedColumns,
      knownUsers: input.knownUsers,

      // Cross-organization the space is a DESTINATION, not a filter — every archived row is going
      // to the chosen space, so filtering by it here would match nothing and drop them all. That
      // exact confusion is what silently discarded 124 rows once already.
      spaceId: input.remap ? null : (input.spaceId ?? null),

      // Filled below, for the tables whose space comes from the row they point at.
      inSpaceParentIds: null as ReadonlySet<string> | null,

      // Where the rows are going, when the restore is moving them into a space they were not in.
      // Cross-organization already expresses this through `remap`, so it is only set for a move
      // WITHIN one organization; passing it there too would say the same thing twice.
      destinationSpaceId: input.remap?.plan.destinationSpaceId ?? null,

      // Wording only. A refusal that tells the operator to clear the destination space is useless
      // cross-organization, where one is mandatory. Derived from the two organizations on the plan
      // rather than a flag, because that is what "cross-organization" actually means here.
      crossOrganization: Boolean(
        input.remap &&
        input.remap.plan.archiveOrganizationId !==
          input.remap.plan.targetOrganizationId,
      ),

      // Whether this table's space-scoped rows CAN be moved. A table with no rewrite spec would
      // otherwise insert them still carrying the source space's id.
      canRescope: Boolean(remapSpec),
    };

    // Resolved once for the whole table, before the first row is read. A table whose space can only
    // come from a parent it cannot see is FAILED, never written unfiltered — "we could not tell" and
    // "they all qualify" read the same to an insert and opposite to an operator.
    if (context.spaceId && entry.spaceScope.kind === 'parent') {
      const scope = entry.spaceScope.scope;

      const index =
        input.spaceParents ??
        new SpaceParentIndex(
          input.archive,
          organizationId,
          context.spaceId,
          input.client as SpaceParentFallbackClient | undefined,
        );

      try {
        context.inSpaceParentIds = await index.idsInSpace(scope);
      } catch (error) {
        return {
          ...result,
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }

      if (!context.inSpaceParentIds) {
        return {
          ...result,
          status: 'failed',
          errorMessage:
            `${planned.table} is in a space only through ${scope.parentTable}, which this archive does ` +
            'not contain and which the destination could not be read for — so which of its rows are ' +
            `in the chosen space could not be established. Restore from an archive that holds ` +
            `${scope.parentTable}, or restore without narrowing to a space.`,
        };
      }
    }

    // Over-cap conflicts are COUNTED, not silently dropped. The previous behaviour discarded them
    // with no counter and no log, so a table with one systemic problem and a table with exactly 500
    // problems produced identical output and the operator had no way to tell which they had.
    /**
     * Destination id → the archived id it was minted from, for rows this run re-scoped.
     *
     * Held until the row is known to have landed. A pair recorded at mint time would make the next
     * run skip a row that failed its insert and is not actually there.
     */
    const mintedBySourceId = new Map<string, string>();

    /**
     * Columns to empty and retry with, when one specific index refuses the row.
     *
     * `form_builder_public_slug_uq` is `UNIQUE (lower(public_slug))` with no organization column —
     * a public form URL is one namespace across the whole product, which is correct. The
     * consequence is that carrying a form into another organization is refused by whoever holds
     * that slug, and the destination is told it "already exists" when it has no such form. The
     * form, its fields and its submissions were all dropped over a URL.
     *
     * So the slug is given up rather than the form: it inserts with `public_slug` empty and the
     * destination issues a new URL when somebody publishes it. Reported as `degraded_to_null`, the
     * same way a missing user FK already degrades, so nothing about it is silent.
     *
     * Gated on `remap`, exactly as `replaceKey` below is, and for the same reason: both moves that
     * fold rows into a destination they did not come from hit this, whether that destination is
     * another organization or another space of this one. A space move mints a NEW row, so the value
     * blocking it belongs to a DIFFERENT row — the original, which keeps it. Only the copy being
     * written is rewritten, never the row already there.
     *
     * A plain same-organization re-run has NO remap and stays excluded, which is the case the
     * cross-organization-only gate here was really protecting: there the archived row IS the live
     * row, the collision is its own record of itself, and giving up the value would insert a second
     * copy with the URL stripped off it.
     */
    const reissueRule = input.remap
      ? REISSUE_ON_CONFLICT[planned.table]
      : undefined;

    /**
     * Columns to match on when the archive's configuration is allowed to win.
     *
     * Undefined unless all three hold: the operator asked, the table is one of the few whose
     * configuration may be replaced, and the restore crosses organizations. A same-organization
     * re-run is idempotency, not a fold, and overwriting there would rewrite a row with itself.
     */
    /*
     * Gated on `remap` alone, which covers both moves that fold spaces together: into another
     * organization, and into another space of this one. A per-space configuration hits the same
     * `UNIQUE (organization_id, space_id)` slot either way, and refusing it because the two
     * organizations happen to match would leave the same row unrestorable for the same reason.
     *
     * A plain same-organization re-run has NO remap — nothing is being moved, the archived row IS
     * the live row, and overwriting would rewrite a row with a copy of itself and bump every
     * `updated_at`. That case stays untouched, and it is the reason this reads `input.remap` rather
     * than dropping the condition entirely.
     */
    const replaceKey =
      input.replaceExistingConfig && input.remap
        ? REPLACE_ON_CONFLICT[planned.table]
        : undefined;

    // The suffix is the destination organization's first segment: derived, stable, and unique per
    // tenant. Deliberately not random — restoring the same archive twice has to produce the same
    // value, so the second run reports a duplicate instead of inserting a second near-identical row.
    const reissueOnConflict = reissueRule
      ? {
          ...reissueRule,
          suffix: (
            input.remap?.plan.targetOrganizationId ?? input.organizationId
          ).split('-')[0],
        }
      : undefined;

    // A space move clears `tasks.key`; minting it here spares the key trigger a scan of the whole space per row.
    const mintTaskKeys = planned.table === 'tasks' && Boolean(input.remap);
    const taskSpaceKeys = new Map<string, string | null>();

    /** Promotes a landed row's pair into the state the run records when it finishes. */
    const rememberMinted = (rowOutcome: {
      row: Record<string, unknown>;
      outcome: 'restored' | 'skipped' | 'failed';
    }) => {
      if (!input.remap || rowOutcome.outcome !== 'restored') {
        return;
      }

      const destinationId = scalarId(rowOutcome.row['id']);
      const sourceId = destinationId
        ? mintedBySourceId.get(destinationId)
        : undefined;

      if (destinationId && sourceId) {
        input.remap.state.minted.push({
          table: planned.table,
          sourceId,

          /**
           * The destination's own sequence issued this key, and a blind insert never learns it.
           *
           * Recorded as a sentinel rather than echoing the archived id, which is what `row['id']`
           * still holds — the strip happens in the insert payload, not on the row. Echoing it would
           * write `source_id === destination_id` and read for all the world like a preserved key.
           *
           * Costs nothing, because the value is never consulted: idempotency keys on
           * `(organization_id, space_id, table_name, source_id)`, and NOTHING in the schema
           * references `automation_event_outbox` — zero inbound foreign keys — so no reference is
           * ever repointed through this entry.
           */
          destinationId: rekey ? SEQUENCE_ASSIGNED_KEY : destinationId,
        });
      }
    };

    const record = (conflict: RestoreConflictRecord) => {
      if (result.conflicts.length < maxConflicts) {
        result.conflicts.push(conflict);

        return;
      }

      result.truncatedConflicts += 1;
    };

    /** Payload budget spent so far on this table. Declared before the closure that reads it. */
    let payloadsWritten = 0;

    /** Reads a parent's label out of the run-scoped index, when one was threaded in. */
    const lookupParentLabel = (parentTable: string, id: string) =>
      input.labelIndex?.get(parentTable)?.get(id) ?? null;

    /**
     * Files this row's label under its id, so its children can be named after it.
     *
     * Capped: the index is a naming convenience, not a correctness requirement, and a 200 000-row
     * table must not turn it into the largest object in the process. Past the cap children of the
     * later rows simply describe themselves, which is the behaviour without an index at all.
     */
    const rememberLabel = (row: Record<string, unknown>, label: string) => {
      if (!input.labelIndex) {
        return;
      }

      const id = row['id'];

      if (typeof id !== 'string' || id.length === 0) {
        return;
      }

      let forTable = input.labelIndex.get(planned.table);

      if (!forTable) {
        forTable = new Map<string, string>();
        input.labelIndex.set(planned.table, forTable);
      }

      if (forTable.size < MAX_LABEL_INDEX_PER_TABLE) {
        forTable.set(id, label);
      }
    };

    /**
     * One report record per row.
     *
     * The payload is attached only for skipped and failed rows, and only while under the payload
     * budget — identity is what makes a record findable, the payload is what makes it expensive.
     */
    const recordRow = (
      entryRecord: Omit<RestoreRunRecord, 'table' | 'rowLabel'> & {
        sourceRow?: Record<string, unknown> | null;
      },
    ) => {
      if (result.records.length >= maxRecords) {
        result.truncatedRecords += 1;

        return;
      }

      const { sourceRow, ...rest } = entryRecord;

      const wantsPayload =
        rest.outcome !== 'restored' && payloadsWritten < DEFAULT_MAX_PAYLOADS;

      if (wantsPayload && sourceRow) {
        payloadsWritten += 1;
      }

      const rowLabel = sourceRow
        ? buildRowLabel(planned.table, sourceRow, lookupParentLabel)
        : null;

      // Remember it, so this row can name its own children later in the run.
      if (rowLabel && sourceRow) {
        rememberLabel(sourceRow, rowLabel);
      }

      result.records.push({
        ...rest,
        table: planned.table,
        rowLabel,
        archivedRow:
          wantsPayload && sourceRow
            ? redactRowForRecord(sourceRow, input.redaction)
            : null,
      });
    };

    /** Rows whose parent had not been inserted yet. Retried once when the table is done. */
    const deferred: Record<string, unknown>[] = [];

    /**
     * Archived rows for the deferred set only.
     *
     * Table-scoped rather than batch-scoped because pass two runs after every batch has been read,
     * by which point the per-batch map is gone. Bounded by how many rows were held back, which is
     * a small fraction of a table rather than all of it.
     */
    const deferredArchived = new Map<
      Record<string, unknown>,
      Record<string, unknown>
    >();

    try {
      // Every id in this table, minted before a single row is written.
      //
      // `tasks.parent_task_id` points at another row in this same table, and the archive is a file
      // in whatever order it was written — a child can precede its parent. Resolving that
      // mid-stream is impossible, and the alternative (insert with a null parent, update after)
      // fires `tasks_history_trigger`, which is AFTER INSERT OR UPDATE, and would manufacture a
      // history row per restored task.
      if (
        input.remap &&
        remapSpec?.rowReferences.some(
          (ref) => !ref.typeColumn && ref.column.startsWith('parent'),
        )
      ) {
        for await (const batch of input.archive.readTable(
          planned.table,
          READ_BATCH_ROWS,
        )) {
          seedIds(batch, input.remap.state);
        }
      }

      let lastProgressAt = Date.now();

      for await (const batch of input.archive.readTable(
        planned.table,
        READ_BATCH_ROWS,
      )) {
        if (
          input.onProgress &&
          Date.now() - lastProgressAt >= PROGRESS_EVERY_MS
        ) {
          lastProgressAt = Date.now();
          await input.onProgress({
            planned: result.plannedRows,
            inserted: result.insertedRows,
            skipped: result.skippedRows,
            failed: result.failedRows,
          });
        }

        // Cancellation, checked once per read batch.
        //
        // The run loop already checks between tables, which is useless for the case that matters:
        // one table holding most of the rows. This is the second checkpoint, and it is HERE — at the
        // top of the read loop — rather than inside the insert loop below, because this is the only
        // place where stopping costs nothing. Every counter this table reports is derived from rows
        // that have been read and reasoned about; breaking before a batch is read leaves
        // `plannedRows`, `insertedRows`, `skippedRows` and `failedRows` describing exactly the rows
        // the writer actually looked at. Breaking mid-insert would leave rows that were planned and
        // never accounted for, which is the one thing this file's header forbids: an uncounted row
        // is indistinguishable from data loss.
        //
        // Worst case is therefore one read batch — 500 rows — between the operator clicking and the
        // table stopping, not a whole table.
        if (input.shouldStop && (await input.shouldStop())) {
          this.logger.log(
            `Restore: cancelled, stopping ${planned.table} after ${result.plannedRows} rows.`,
          );

          break;
        }

        const writable: Record<string, unknown>[] = [];

        /**
         * The archived row each writable row came from.
         *
         * A label must be read from the ARCHIVE, never from what is about to be inserted.
         * `prepareRow` strips generated columns, and `tasks.key` is one of them — it is reissued on
         * insert from `task_key_sequences`. Labelling the prepared row therefore produced "(no
         * name)" for all 291 restored tasks in a real run while the 388 skipped ones, labelled from
         * `raw`, came out as `NEWSPACE-T88` exactly as intended.
         *
         * Keyed by object identity, which survives `writable` -> `batchesOf` -> `insertChunk` ->
         * `rowOutcomes[].row`. Declared per read batch rather than per table so it cannot grow to
         * hold 200 000 entries.
         */
        const archivedFor = new Map<
          Record<string, unknown>,
          Record<string, unknown>
        >();

        for (const raw of batch) {
          result.plannedRows += 1;

          const outcome = prepareRow(raw, context);

          if (outcome.kind === 'skip') {
            result.skippedRows += 1;
            countSkippedReason(outcome.reason);

            // A row outside the chosen space is counted but not recorded individually AS A
            // CONFLICT. Listing every one there would bury the real conflicts under thousands of
            // rows working as intended; recording none at all left a filtered-out restore with
            // nothing to explain itself. One summary conflict per table is written below instead.
            if (outcome.reason === 'other_space') {
              result.otherSpaceRows += 1;
            }

            if (outcome.reason !== 'other_space') {
              record({
                table: planned.table,
                conflictClass: 'refused_row',
                severity:
                  outcome.reason === 'foreign_tenant' ? 'error' : 'warning',
                rowKey: outcome.rowKey,
                resolution: 'refused',
                detail: outcome.detail,
              });
            }

            // ...but it IS recorded individually HERE, with its own key. The summary answers "how
            // many", which is not the question an operator asks — they ask "was MY record left
            // out", and until now a space-filtered restore could not answer it for a single row.
            // The report filters by outcome, so these no longer bury anything.
            //
            // Recorded on a dry run as well: a `prepareRow` skip is genuinely observed even when
            // nothing is written, unlike an insert outcome, which a dry run never sees.
            recordRow({
              rowPk: outcome.rowKey,
              outcome: 'skipped',
              reasonCode: outcome.reason,
              reasonDetail: outcome.detail,
              sourceRow: raw,
              pass: 1,
            });

            continue;
          }

          // Moving the row to the other organization: a new identity, and every reference
          // repointed. Done AFTER `prepareRow` so generated columns are already stripped and the
          // user policy has already run — against the DESTINATION's members, which is what makes a
          // restored row belong to somebody who is actually there.
          if (input.remap && remapSpec) {
            // The raw id, not `rowKeyOf` — that renders `id=t1` for reporting, and the map is keyed
            // by the id itself. Comparing the two forms is a lookup that can never match, which
            // silently turns every repeat restore back into a duplicating one.
            const sourceId = scalarId(outcome.row['id']);

            // Already written into this space by an earlier run. Skipped rather than minted a
            // second id, which is what makes repeating a restore safe: the ids differ by
            // construction and the keys are regenerated, so nothing else could recognise it.
            if (
              sourceId &&
              input.remap.state.alreadyRestored.has(
                entityMapKey(planned.table, sourceId),
              )
            ) {
              result.skippedRows += 1;
              countSkippedReason('duplicate');

              // Counted here as well as in the aggregate, so "nothing was inserted" can be answered
              // with WHY. This is the idempotent-re-run path: the rows are genuinely already there.
              result.duplicateRows += 1;

              record({
                table: planned.table,
                conflictClass: 'duplicate',
                severity: 'info',
                rowKey: sourceId,
                resolution: 'skipped',
                detail:
                  'This row was already restored into this space by an earlier run, so it was not written again.',
              });

              recordRow({
                rowPk: sourceId,
                outcome: 'skipped',
                reasonCode: 'duplicate',
                reasonDetail: 'Already restored into this space.',
                liveRowTargetScope: 'target',
                sourceRow: raw,
                pass: 1,
              });

              continue;
            }

            const moved = remapRow(
              outcome.row,
              remapSpec,
              input.remap.plan,
              input.remap.state,
            );

            if (moved.kind === 'skip') {
              result.skippedRows += 1;
              countSkippedReason(moved.reason);

              const movedKey = rowKeyOf(outcome.row, entry);

              record({
                table: planned.table,
                conflictClass: 'refused_row',
                severity: 'warning',
                rowKey: movedKey,
                resolution: 'refused',
                detail: moved.detail,
              });

              // The key here is the SOURCE row's, because the destination identity was never
              // minted — the row did not get that far. Cross-org reports must not imply a
              // destination id that does not exist.
              recordRow({
                rowPk: movedKey,
                outcome: 'skipped',
                reasonCode: moved.reason,
                reasonDetail: moved.detail,

                // Undefined for `unsupported_reference_type`, which by definition resolved to no
                // table. Every other refusal here names one.
                referencesTable: moved.referencesTable,
                sourceRow: outcome.row,
                pass: 1,
              });

              continue;
            }

            // Remembered against the id the row will carry, so the pair can be recorded only if
            // this row actually lands. Recording it at mint time would make the next run skip a row
            // that never made it in.
            const mintedId = scalarId(moved.row['id']);

            if (sourceId && mintedId) {
              mintedBySourceId.set(mintedId, sourceId);
            }

            // Arrive as history, never as work.
            //
            // Re-scoping has just rewritten this row's `space_id`, and the relay drain polls every
            // two seconds on `relayed_at IS NULL` with no tenant filter, matching subscriptions
            // against exactly that column. An unrelayed row carried across would therefore fire the
            // DESTINATION space's automations for real — email, Slack, Teams, SMS, webhooks, task
            // mutations — and its archived `occurred_at` would sort it ahead of every other tenant's
            // pending events in a shared 100-row queue.
            //
            // Stamping the column is what makes the move safe rather than merely possible: the row
            // falls permanently outside what the drain can select, which closes the re-firing and
            // the queue-ordering hazards together. Applied to the row itself, not just the payload,
            // so the report and the database agree about what was written.
            if (rekey) {
              for (const column of rekey.neutraliseWhenNull) {
                if (moved.row[column] == null) {
                  moved.row[column] = neutralisedAt;
                  stampedRows.add(moved.row);
                }
              }
            }

            // A cleared column is a reference the destination has no equivalent for. Counted so
            // "this task arrived without its process" is visible rather than discovered later.
            for (const column of moved.clearedColumns) {
              record({
                table: planned.table,
                conflictClass: 'missing_user',
                severity: 'info',
                rowKey: rowKeyOf(moved.row, entry),
                resolution: 'degraded_to_null',
                columnName: column,
                detail:
                  `${column} had no equivalent in the destination organization, so it was left ` +
                  'empty rather than left pointing at the organization the archive came from.',
              });
            }

            outcome.row = moved.row;
          }

          for (const column of outcome.nulledUserColumns) {
            result.nulledUserColumns[column] =
              (result.nulledUserColumns[column] ?? 0) + 1;

            record({
              table: planned.table,
              conflictClass: 'missing_user',
              severity: 'warning',
              rowKey: rowKeyOf(outcome.row, entry),
              resolution: 'degraded_to_null',
              columnName: column,
              detail: `${column} referred to a user who is no longer here, so it was left empty.`,
            });
          }

          // A value the restore deliberately did not carry. Reported for the same reason a nulled
          // user reference is: the alternative is the operator discovering it when a webhook stops
          // firing. `info`, not `warning` — nothing went wrong, the destination reissues it.
          for (const column of outcome.reissuedColumns) {
            record({
              table: planned.table,
              conflictClass: 'refused_row',
              severity: 'info',
              rowKey: rowKeyOf(outcome.row, entry),
              resolution: 'degraded_to_null',
              columnName: column,
              detail:
                `${column} has to be unique across every organization, so the archived value was ` +
                'left out rather than colliding with the row that still holds it. The destination ' +
                'issues a new one when this is next configured.',
            });
          }

          archivedFor.set(outcome.row, raw);
          writable.push(outcome.row);
        }

        // A dry run does everything except the write: it reads the archive, verifies the checksum,
        // applies every rule and produces the same counts. That is what makes the preview worth
        // anything — a preview computed by a different code path is a guess.
        //
        // But it produces the same counts only for the rules it can actually evaluate. Everything
        // above this line is local — tenancy, space, user policy, remapping — and a dry run reaches
        // the same verdict the apply will. Everything below it is the DATABASE's verdict: duplicate
        // keys, missing parents, constraint violations. A dry run never asks, so it never hears
        // "no", and `writable.length` is the count of rows that passed local validation, not the
        // count of rows that will land.
        //
        // That gap is not theoretical. On this installation every apply that followed a green
        // preview inserted zero rows: previews of 122, 101 and 219 rows against a destination that
        // already held them, each followed by an apply that skipped all 249 / 199 / 249 as
        // duplicates. So NO `restored` record is written here — recording one would be inventing an
        // outcome the code never observed, and the report exists to stop exactly that kind of
        // confident wrong number. The skips above ARE recorded, because those were genuinely seen.
        if (dryRun) {
          result.insertedRows += writable.length;

          // No record — but DO file the labels. `rememberLabel` is otherwise only reachable from
          // `recordRow`, so a preview left the index empty for every parent, and the skipped
          // children the preview exists to show came out with no task key at all. Naming a row is
          // not the same claim as restoring it: this indexes what the archive says a row is called,
          // which is true whether or not the insert is ever attempted. Preview and apply now
          // describe identical input identically.
          for (const row of writable) {
            const archived = archivedFor.get(row) ?? row;
            const label = buildRowLabel(
              planned.table,
              archived,
              lookupParentLabel,
            );

            if (label) {
              rememberLabel(archived, label);
            }
          }

          continue;
        }

        for (const chunk of batchesOf(writable, INSERT_BATCH_ROWS)) {
          if (mintTaskKeys) {
            await this.assignTaskKeys(
              chunk,
              input.client ?? this.db,
              taskSpaceKeys,
            );
          }

          const outcome = await this.insertChunk(
            planned.table,
            chunk,
            entry,
            input.client,
            rekey?.key,
            reissueOnConflict,
            replaceKey,
          );

          result.insertedRows += outcome.inserted;
          result.skippedRows += outcome.skipped;
          result.failedRows += outcome.failed;
          outcome.conflicts.forEach(record);
          deferred.push(...outcome.deferred);

          // Carry the archive mapping forward before this batch's map goes out of scope.
          for (const row of outcome.deferred) {
            const archived = archivedFor.get(row);

            if (archived) {
              deferredArchived.set(row, archived);
            }
          }

          for (const rowOutcome of outcome.rowOutcomes) {
            recordRow({
              rowPk: rowOutcome.rowPk,
              outcome: rowOutcome.outcome,
              reasonCode: rowOutcome.reasonCode,
              reasonDetail:
                rowOutcome.reasonDetail ?? neutralisedDetailFor(rowOutcome.row),

              // Carries the constraint and the key it collided on. The fields above are listed one
              // by one rather than spread, so anything not named here is dropped — which is what
              // happened to this: it was set on the outcome and never reached the record, leaving
              // `attachByConflictKey` with nothing to look the blocking row up by.
              conflict: rowOutcome.conflict,

              // The archive's version, so the label survives the columns an insert regenerates.
              sourceRow: archivedFor.get(rowOutcome.row) ?? rowOutcome.row,
              pass: 1,
            });

            // Read off the verdict rather than counted at each `23505` site, so the two insert paths
            // — the chunk and the per-row retry it degrades to — cannot disagree about the total.
            if (rowOutcome.reasonCode === 'duplicate') {
              result.duplicateRows += 1;
            }

            if (rowOutcome.outcome === 'skipped') {
              countSkippedReason(rowOutcome.reasonCode);
            }

            rememberMinted(rowOutcome);
          }

          if (outcome.fatal) {
            // Every row of this table has the same shape, so the rest cannot succeed either.
            return {
              ...result,
              status: 'failed',
              errorMessage: outcome.fatal,
            };
          }
        }
      }

      // Second pass. A row can fail its foreign key simply because the row it points at had not
      // been read yet — a task under a parent task further down the file, or either half of a
      // cycle. Retrying once, after the whole table has been inserted, resolves those without
      // reordering anything. Rows deferred here were counted NOWHERE in the first pass, so this is
      // the only place they are tallied.
      if (deferred.length) {
        const retry = await this.retryDeferred(
          planned.table,
          deferred,
          entry,
          input.client,
          rekey?.key,
        );

        result.insertedRows += retry.inserted;
        result.skippedRows += retry.skipped;
        result.failedRows += retry.failed;
        retry.conflicts.forEach(record);

        for (const rowOutcome of retry.rowOutcomes) {
          recordRow({
            rowPk: rowOutcome.rowPk,
            outcome: rowOutcome.outcome,
            reasonCode: rowOutcome.reasonCode,
            reasonDetail:
              rowOutcome.reasonDetail ?? neutralisedDetailFor(rowOutcome.row),

            // Same as pass one. A row reaches here only by having been deferred for a missing
            // parent first, but once it is refused as a duplicate it deserves the same handle.
            conflict: rowOutcome.conflict,

            // Pass two runs after the read loop, so its batch-scoped map is gone. Deferred rows
            // keep their prepared form here; the label falls back to it rather than to nothing.
            sourceRow: deferredArchived.get(rowOutcome.row) ?? rowOutcome.row,
            pass: 2,
          });

          // Deferred rows are counted NOWHERE in pass one, so their duplicates are counted here or
          // nowhere at all — the same rule the tallies above already follow.
          if (rowOutcome.reasonCode === 'duplicate') {
            result.duplicateRows += 1;
          }

          if (rowOutcome.outcome === 'skipped') {
            countSkippedReason(rowOutcome.reasonCode);
          }

          // Pass two LANDS rows, so its mappings have to be recorded exactly as pass one's are.
          //
          // Omitted here, a re-scoped row that was merely deferred was written and never mapped —
          // and a deferred row is the ordinary case, not an edge one: a sub-task whose parent sits
          // further down the file fails its foreign key on the first attempt by design, which is
          // the entire reason this pass exists. The next apply of the same archive then found no
          // mapping for it, minted a fresh id, and inserted a second copy. Nothing could object:
          // the id is new by construction and `tasks.key` is regenerated by the destination, so
          // there is no unique constraint left for the database to refuse it with.
          rememberMinted(rowOutcome);
        }
      }

      // Fill in the live row for the duplicates, in ONE lookup per chunk rather than one per row.
      //
      // The duplicate branch does no database read at all, and it sits inside the per-row fallback
      // loop — so a SELECT there would turn an all-duplicate re-run of a large table into N inserts
      // plus N selects, serially awaited. Batching it here keeps the archived-versus-live comparison
      // affordable, and it is skipped entirely when nothing needs it.
      //
      // Not for a re-keyed table. The lookup addresses the destination by the ARCHIVED key, which
      // after reissuing names nothing this restore wrote — and an outbox id is unique to the table
      // rather than to a space, so `id=44` would happily match a row belonging to a DIFFERENT space
      // and present it as "already in the database". Showing no live side is what every
      // composite-key table already does, and it is the honest answer here.
      // ponytail: a sequence-keyed table under remap skips this whole block, so its duplicates
      // never adopt and its children orphan. Lifting that needs a lookup that can address a
      // re-keyed row, which the comment above explains does not exist yet. Rare in practice —
      // the collapsing tables seen so far are all uuid-keyed — so it is named, not fixed here.
      if (!rekey) {
        await this.attachLiveRows(result.records, planned.table, entry, input);

        this.removeNonTargetDuplicateRows(result);

        // A row already present in the destination is pointed AT the row that is already there,
        // rather than left with no address at all.
        //
        // Without this, "already exists" orphans everything beneath it: a child resolves its
        // parent through the remap state, finds nothing for a parent that was never inserted, and
        // is skipped as `missing_parent`. One refused parent took eighty-three children with it in
        // the run that prompted this. Attaching them to the existing parent is what the operator
        // meant by restoring, and it is what "already present" should always have implied.
        this.mapDuplicatesToLiveRows(
          result.records,
          planned.table,
          mintedBySourceId,
          input,
        );
      }
    } catch (err) {
      // A checksum mismatch, a malformed line, a damaged member. The table is abandoned; the run
      // decides whether that is fatal to it.
      return {
        ...result,
        status: 'failed',
        errorMessage: (err as Error).message,
      };
    }

    if (result.otherSpaceRows > 0) {
      // `other_space` covers two unrelated situations, and this summary used to assume the first.
      //
      // A SOURCE FILTER narrowing the archive to one space is the operator's own instruction, and
      // clearing it does restore the rest. A table that is never carried into another space is
      // nothing to do with a filter, and telling someone to "clear the filter" there sent them
      // looking for a setting they had never switched on. Observed exactly that: a run with no
      // source filter at all reported one as the reason.
      //
      // The second branch stays deliberately general about WHY. The reason differs per table —
      // `automation_event_outbox` is automation history that belongs to the space it happened in,
      // `partner_document_sequences` has no row id to reissue — and `refuseUnmovableRow` in
      // `restore-row-preparer.ts` already writes the table-specific sentence onto every row record.
      // Restating one table's reason here is what made this summary claim a mechanism that was not
      // even the right one: it used to say the rows were "numbered by a database sequence, so no id
      // can be minted", which is not why they are kept out and not the error they would raise.
      const filtered = Boolean(input.spaceId);

      record({
        table: planned.table,
        conflictClass: 'refused_row',
        severity: 'warning',
        rowKey: null,
        resolution: 'refused',
        detail: filtered
          ? `${result.otherSpaceRows} row(s) were left out because they belong to a different ` +
            'space than the one chosen. This is the space filter doing what was asked; clear it to ' +
            'restore the whole table.'
          : `${result.otherSpaceRows} row(s) were left out because this table is kept in the space ` +
            'it belongs to and is not copied into another. Restoring without choosing a destination ' +
            'space puts them back where they came from.',
      });
    }

    const dependencySkippedRows =
      (skippedReasonCounts.unmapped_reference ?? 0) +
      (skippedReasonCounts.missing_parent ?? 0);

    if (result.failedRows > 0) {
      result.status = 'partial';
    } else if (result.plannedRows === 0) {
      result.status = 'skipped';

      // The archive held a member for this table and it was empty. Recorded because the counts
      // cannot say it: `planned_row_count = 0` looks identical whether the table was empty or the
      // run was cancelled before reaching it, and the results screen — which builds its table list
      // from per-ROW records — has nothing at all to render for a table with none. That is how 97 of
      // 147 selected tables came to be absent from a report that called itself complete.
      result.outcomeReason = 'archive_empty';
    } else if (
      result.insertedRows === 0 &&
      result.otherSpaceRows === result.plannedRows
    ) {
      // Every row read was filtered out by the space rule. Reporting `succeeded` here is what made
      // a restore that wrote nothing look like one that worked. Deliberately NOT extended to a run
      // whose rows were all duplicates — that is a correct idempotent re-run and stays `succeeded`.
      result.status = 'skipped';
      result.outcomeReason = 'other_space';
    } else if (
      result.insertedRows === 0 &&
      result.duplicateRows === result.plannedRows
    ) {
      // A correct idempotent re-run: the destination already had every row. `status` stays
      // `succeeded` on purpose — nothing went wrong — but the reason is recorded so the report can
      // say WHY nothing was added instead of showing a table that inserted zero and explaining
      // nothing.
      //
      // Gated on `duplicateRows`, never on `skippedRows`. The latter is an aggregate that also
      // carries missing parents and missing users, and reading this off it would tell an operator
      // their data was safely already present when in fact every row had been dropped.
      result.outcomeReason = 'already_present';
    } else if (
      result.insertedRows === 0 &&
      dependencySkippedRows > 0 &&
      dependencySkippedRows + result.duplicateRows === result.plannedRows
    ) {
      // All rows were either already present or refused because their required parent could not be
      // mapped. The duplicate half is harmless, but the missing-parent half is the reason this
      // table restored no data and must not be hidden behind a null table reason.
      result.status = 'skipped';
      result.outcomeReason =
        (skippedReasonCounts.unmapped_reference ?? 0) > 0
          ? 'unmapped_reference'
          : 'missing_parent';
    }

    return result;
  }

  /**
   * Points a duplicate at the row already sitting in the destination, so its children can attach.
   *
   * Writes in TWO places, and both are required:
   *
   *  - `state.ids`, in memory, so children later in THIS run resolve. `alreadyRestored` is loaded
   *    once before the first table is written and `remapRow` never re-reads the database, so a row
   *    inserted into `restore_entity_map` now would not be seen until some future run. Persisting
   *    alone would look correct and fix nothing.
   *  - `state.minted`, which the caller already flushes once at the end through
   *    `RestoreEntityMapService.record`. Reusing that seam means no second write path and no new
   *    ordering to get wrong.
   *
   * Refuses to map unless the blocking row is unambiguously the destination's own. A mapping that
   * points at another tenant's row would hand this restore's children to that tenant — far worse
   * than the skip it replaces.
   *
   * A no-op without a remap, which is every same-organization restore: there the archived id IS
   * the live id, so there is nothing to forward.
   */
  private mapDuplicatesToLiveRows(
    records: RestoreRunRecord[],
    table: string,
    mintedBySourceId: Map<string, string>,
    input: RestoreTableInput,
  ): void {
    if (!input.remap || input.dryRun) {
      return;
    }

    const { state } = input.remap;

    for (const record of records) {
      // Foreign and outside-target rows are excluded here by the scope marker. They have no
      // counterpart in the selected target space to attach children to.
      //
      // The reason test is a SET, not a literal: `attachByConflictKey` runs before this and
      // relabels some of these records for the report. See ADOPTABLE_DUPLICATE_REASONS.
      if (
        !ADOPTABLE_DUPLICATE_REASONS.has(record.reasonCode ?? '') ||
        record.liveRowTargetScope !== 'target'
      ) {
        continue;
      }

      const destinationId =
        record.liveRowId ?? scalarId(record.liveRow?.['id']);

      if (!destinationId) {
        continue;
      }

      // `rowPk` is `col=value`; the remap tables are keyed by bare id. The attempted row carries
      // the reissued id, so the archived one it stands for comes back through `mintedBySourceId`.
      const attemptedId = record.rowPk?.startsWith('id=')
        ? record.rowPk.slice('id='.length)
        : null;

      const sourceId = attemptedId
        ? (mintedBySourceId.get(attemptedId) ?? attemptedId)
        : null;

      if (!sourceId || sourceId === destinationId) {
        continue;
      }

      // Same-run resolution. Children read `state.ids` first.
      //
      // ponytail: this runs at the END of the table, after `retryDeferred`. Children in LATER
      // tables therefore see it (insertLevel orders parents first, which covers every case seen
      // in the wild), but a row whose parent is a collapsed row in the SAME table has already
      // had its retry and stays `missing_parent`. Upgrade path is to adopt before pass two,
      // which needs `attachLiveRows` to move with it — a bigger change than this one.
      state.ids.set(sourceId, destinationId);

      // Durable record, flushed by the caller with everything else this run minted.
      state.minted.push({ table, sourceId, destinationId });
    }
  }

  /**
   * Finds the one live row a duplicate collided with, using the key the database itself reported.
   *
   * Attaches it as `liveRow` so the report can show what is already there, and records on the
   * record whether that row belongs to THIS destination or to another organization — the two mean
   * opposite things to an operator, and today both are reported as a flat "already exists".
   *
   * Deliberately not tenant-filtered in the query. The whole question being asked is *whose* row
   * blocked this one, and filtering to the destination first would hide the cross-tenant case that
   * needs surfacing. Ownership is read off the row afterwards and never used to widen access:
   * nothing is written here.
   *
   * Best-effort. Any failure leaves the record exactly as it was.
   */
  private async attachByConflictKey(
    record: RestoreRunRecord,
    table: string,
    entry: ComponentTable,
    input: RestoreTableInput,
  ): Promise<void> {
    const key = record.conflict?.key;

    if (!key) {
      return;
    }

    try {
      let query = (input.client ?? this.db).from(table).select('*');

      key.columns.forEach((column, index) => {
        const value = key.values[index];

        // `ilike` with no wildcards is an equality that ignores case, which is what a
        // `lower(col)` index enforces. Escaped so a value containing % or _ cannot widen it.
        query = column.caseInsensitive
          ? query.ilike(column.column, value.replace(/[%_]/g, '\\$&'))
          : query.eq(column.column, value);
      });

      // Two matches means the key did not identify one row, so nothing here can be trusted.
      const { data, error } = (await query.limit(2)) as unknown as {
        data: Record<string, unknown>[] | null;
        error: { message: string } | null;
      };

      if (error || !data || data.length !== 1) {
        return;
      }

      const live = data[0];

      record.liveRow = redactRowForRecord(live, input.redaction);
      record.liveRowId = scalarId(live['id']) ?? undefined;

      const scope = await this.classifyLiveRowTargetScope(live, entry, input);

      this.applyLiveRowTargetScope(record, scope);

      if (scope !== 'target') {
        return;
      }

      // Organization-wide rows serve every space, so the one already here is the one the restore uses.
      if (entry.spaceScope.kind === 'organization') {
        record.reasonCode = 'duplicate_shared';
        record.reasonDetail =
          'This is shared by the whole organization and is already here, so the existing one was kept ' +
          'and the restored rows use it. Nothing was copied twice.';

        return;
      }

      // Same organization, DIFFERENT space in the archive than the row now occupying the slot.
      //
      // The two cannot both be true unless the restore folded several source spaces into one
      // destination: the archived row was configuration for its own space, its space id was
      // rewritten to the single destination space, and it landed on a slot another space had
      // already taken. Calling that "you already have this" is wrong twice over — the operator
      // never had this row, and the reason is the fold, not a duplicate.
      const archivedSpace = record.archivedRow?.['space_id'];
      const liveSpace = live['space_id'];

      if (
        typeof archivedSpace === 'string' &&
        typeof liveSpace === 'string' &&
        archivedSpace !== liveSpace
      ) {
        // Renaming the reason must NOT change what happens to this row's children — the row is
        // still a duplicate of a live row in the target. Any new code added here has to be in
        // ADOPTABLE_DUPLICATE_REASONS too, or `mapDuplicatesToLiveRows` will stop re-parenting
        // and the children will be dropped as `missing_parent`.
        record.reasonCode = 'duplicate_space_collapsed';
        record.reasonDetail =
          'This is configuration for a different space in the backup, and that space maps onto ' +
          'one already holding its own. The existing settings were left untouched.';
      }
    } catch (err) {
      this.logger.warn(
        `Conflict-key lookup failed for ${table}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Fetches the live rows that duplicates collided with, in batches, and attaches them.
   *
   * Only for records that already carry an archived payload: the point is the side-by-side
   * comparison, and a live row with nothing to compare against is storage without a reader.
   *
   * Best-effort throughout. A failure here costs the report one column, and must never turn into a
   * failed restore — the rows were already written, or already skipped, before this ran.
   */
  private async attachLiveRows(
    records: RestoreRunRecord[],
    table: string,
    entry: NonNullable<ReturnType<typeof tableEntry>>,
    input: RestoreTableInput,
  ): Promise<void> {
    if (input.dryRun) {
      // Nothing was written, so there is no "live versus archived" to draw.
      return;
    }

    // Rows whose collision key the driver told us about are looked up by THAT key, one query each.
    //
    // The batched path below can only search by the archived primary key, which is the right
    // answer for a same-organization restore where ids are preserved. Cross-organization every id
    // is reissued, so the id on the attempted row never landed anywhere and the batch matches
    // nothing — which is why every duplicate in a cross-org run reported no live row at all. The
    // key from the DETAIL line is the one thing that does identify the blocker.
    const remaining: RestoreRunRecord[] = [];

    for (const record of records) {
      if (record.reasonCode !== 'duplicate' || !record.archivedRow) {
        continue;
      }

      if (record.conflict?.key) {
        await this.attachByConflictKey(record, table, entry, input);

        continue;
      }

      remaining.push(record);
    }

    const keyColumns = entry.orderBy ?? ['id'];

    // Composite keys would need an OR of ANDs per row, which is the N+1 this method exists to
    // avoid. They keep their archived payload and simply show no live side.
    if (keyColumns.length !== 1) {
      return;
    }

    const keyColumn = keyColumns[0];

    const targets = remaining.filter((record) => record.rowPk !== null);

    if (!targets.length) {
      return;
    }

    // `rowKeyOf` formats as "col=value"; the lookup needs the value.
    const prefix = `${keyColumn}=`;
    const byKey = new Map<string, RestoreRunRecord[]>();

    for (const record of targets) {
      const raw = record.rowPk as string;
      const value = raw.startsWith(prefix) ? raw.slice(prefix.length) : null;

      if (!value) {
        continue;
      }

      const existing = byKey.get(value);

      if (existing) {
        existing.push(record);
        continue;
      }

      byKey.set(value, [record]);
    }

    const values = [...byKey.keys()];
    const client = input.client ?? this.db;

    for (const chunk of batchesOf(values, LIVE_LOOKUP_CHUNK)) {
      try {
        const { data, error } = (await client
          .from(table)
          .select('*')
          .in(keyColumn, chunk)) as unknown as {
          data: Record<string, unknown>[] | null;
          error: { message: string } | null;
        };

        if (error || !data) {
          this.logger.warn(
            `Could not read live rows for ${table} report records: ${error?.message ?? 'no data'}`,
          );

          continue;
        }

        for (const live of data) {
          const matches = byKey.get(String(live[keyColumn]));

          if (!matches) {
            continue;
          }

          for (const record of matches) {
            const scope = await this.classifyLiveRowTargetScope(
              live,
              entry,
              input,
            );

            record.liveRowId = scalarId(live['id']) ?? undefined;
            this.applyLiveRowTargetScope(record, scope);
            record.liveRow = redactRowForRecord(live, input.redaction);
          }
        }
      } catch (err) {
        this.logger.warn(
          `Live row lookup failed for ${table}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Removes duplicate rows that proved not to be clean target idempotency from the
   * "already present" counter.
   *
   * The counter is incremented as insert outcomes arrive, before the live-row lookup has enough
   * information to classify the blocker. Adjusting it here keeps the insert path simple while
   * preventing outside-target rows from producing an `already_present` table reason.
   */
  private removeNonTargetDuplicateRows(result: TableRestoreResult): void {
    const nonTargetDuplicates = result.records.filter((record) => {
      if (record.outcome !== 'skipped') {
        return false;
      }

      if (
        record.reasonCode === 'duplicate_foreign_tenant' ||
        record.reasonCode === 'duplicate_space_collapsed' ||
        record.reasonCode === 'duplicate_outside_target_scope'
      ) {
        return true;
      }

      return (
        record.reasonCode === 'duplicate' &&
        record.liveRowTargetScope !== undefined &&
        record.liveRowTargetScope !== 'target'
      );
    }).length;

    result.duplicateRows = Math.max(
      0,
      result.duplicateRows - nonTargetDuplicates,
    );
  }

  /**
   * Tells whether a duplicate blocker is actually in the restore target.
   *
   * A duplicate is safe to treat as "already present" only when it belongs to the selected
   * organization and, for space-scoped tables, the selected target space. Parent-scoped rows fail
   * closed: if the parent cannot be read, no child remap is created.
   */
  private async classifyLiveRowTargetScope(
    live: Record<string, unknown>,
    entry: ComponentTable,
    input: RestoreTableInput,
  ): Promise<LiveRowTargetScope> {
    const destinationOrganization =
      input.remap?.plan.targetOrganizationId ?? input.organizationId;
    const owner = this.rowOwner(live, entry);

    if (owner && owner !== destinationOrganization) {
      return 'foreign_tenant';
    }

    const destinationSpace =
      input.remap?.plan.destinationSpaceId ?? input.spaceId ?? null;

    if (!destinationSpace) {
      return 'target';
    }

    switch (entry.spaceScope.kind) {
      case 'organization':
        return 'target';

      case 'self':
        return scalarId(live['id']) === destinationSpace
          ? 'target'
          : 'outside_target_space';

      case 'own': {
        const liveSpace = scalarId(live[entry.spaceScope.column]);

        if (liveSpace === destinationSpace) {
          return 'target';
        }

        return liveSpace === null &&
          entry.spaceScope.whenNull === 'organization'
          ? 'target'
          : 'outside_target_space';
      }

      case 'parent':
        return this.classifyParentScopedLiveRow(
          live,
          entry,
          input,
          destinationSpace,
        );

      default: {
        const exhaustive: never = entry.spaceScope;

        return exhaustive;
      }
    }
  }

  private applyLiveRowTargetScope(
    record: RestoreRunRecord,
    scope: LiveRowTargetScope,
  ): void {
    record.liveRowTargetScope = scope;

    if (scope === 'foreign_tenant') {
      // The blocking row belongs to somebody else. Saying "you already have this" would be false —
      // the destination has nothing of the sort — so it is reported as what it is.
      record.reasonCode = 'duplicate_foreign_tenant';
      record.reasonDetail =
        'This was refused because another organization already uses the same value, not ' +
        'because it exists here. Nothing was changed.';

      return;
    }

    if (scope === 'outside_target_space') {
      record.reasonCode = 'duplicate_outside_target_scope';
      record.reasonDetail =
        'This was refused because the same value exists outside the selected target space, ' +
        'not because it has already been restored there. Nothing was changed.';
    }
  }

  private rowOwner(
    row: Record<string, unknown>,
    entry: ComponentTable,
  ): string | null {
    if (entry.tenantColumn) {
      return scalarId(row[entry.tenantColumn]);
    }

    return scalarId(row['organization_id']) ?? scalarId(row['organizationid']);
  }

  private async classifyParentScopedLiveRow(
    live: Record<string, unknown>,
    entry: ComponentTable,
    input: RestoreTableInput,
    destinationSpace: string,
  ): Promise<LiveRowTargetScope> {
    if (entry.spaceScope.kind !== 'parent') {
      return 'unknown';
    }

    const scope = entry.spaceScope.scope;
    const parentId = scalarId(live[scope.column]);

    if (!parentId) {
      return scope.whenNull === 'organization'
        ? 'target'
        : 'outside_target_space';
    }

    try {
      const parentEntry = tableEntry(scope.parentTable);
      const ownerColumn =
        entry.parentScope?.parentTenantColumn ??
        parentEntry?.tenantColumn ??
        null;
      const selectColumns = [scope.parentSpaceColumn, ownerColumn]
        .filter(
          (column): column is Exclude<typeof column, null> => column !== null,
        )
        .join(', ');
      const client = input.client ?? this.db;
      const { data, error } = (await client
        .from(scope.parentTable)
        .select(selectColumns || scope.parentSpaceColumn)
        .eq('id', parentId)
        .limit(2)) as unknown as {
        data: Record<string, unknown>[] | null;
        error: { message: string } | null;
      };

      if (error || !data || data.length !== 1) {
        return 'unknown';
      }

      const parent = data[0];
      const destinationOrganization =
        input.remap?.plan.targetOrganizationId ?? input.organizationId;
      const owner = ownerColumn ? scalarId(parent[ownerColumn]) : null;

      if (owner && owner !== destinationOrganization) {
        return 'foreign_tenant';
      }

      return scalarId(parent[scope.parentSpaceColumn]) === destinationSpace
        ? 'target'
        : 'outside_target_space';
    } catch (err) {
      this.logger.warn(
        `Parent-scope lookup failed for ${entry.table}: ${(err as Error).message}`,
      );

      return 'unknown';
    }
  }

  /**
   * Inserts one chunk, falling back to one row at a time when the chunk fails.
   *
   * @returns Counts plus `fatal` when the failure cannot be row-level, in which case the caller
   *   must stop this table rather than retry 200 000 rows against the same broken shape.
   */
  private async insertChunk(
    table: string,
    rows: Record<string, unknown>[],
    entry: NonNullable<ReturnType<typeof tableEntry>>,
    client?: WriteClient,
    omitColumn?: string,
    /** Rewrite this column and try once more, when this one index is what refused the row. */
    reissue?: {
      constraint: string;
      column: string;
      mode: 'null' | 'suffix' | 'false' | 'value';
      value?: string;
      suffix: string;
    },
    /** Columns to match the existing row on, when the archive is allowed to replace it. */
    replaceKey?: string[],
  ): Promise<{
    inserted: number;
    skipped: number;
    failed: number;
    conflicts: RestoreConflictRecord[];
    /** One entry per row, for the restore report. Deferred rows are absent — pass two reports them. */
    rowOutcomes: RowOutcome[];
    /** Rows held back for the table's second pass. Counted there, never here. */
    deferred: Record<string, unknown>[];
    fatal?: string;
  }> {
    if (!rows.length) {
      return {
        inserted: 0,
        skipped: 0,
        failed: 0,
        conflicts: [],
        rowOutcomes: [],
        deferred: [],
      };
    }

    const error = await this.insert(table, rows, client, omitColumn);

    if (!error) {
      return {
        inserted: rows.length,
        skipped: 0,
        failed: 0,
        conflicts: [],
        rowOutcomes: rows.map((row) => ({
          row,
          rowPk: rowKeyOf(row, entry),
          outcome: 'restored' as const,
        })),
        deferred: [],
      };
    }

    const classified = classifyInsertError(error.code);

    if (!classified.rowLevel) {
      // The whole chunk died of something that is not about any one row — a missing column, a
      // permission failure, an unrecognised code. Every row is reported as failed with the same
      // reason, because that is what happened to every row: the alternative, saying nothing, is how
      // an aborted table came to look like a table with no rows in it.
      return {
        inserted: 0,
        skipped: 0,
        failed: rows.length,
        conflicts: [],
        rowOutcomes: rows.map((row) => ({
          row,
          rowPk: rowKeyOf(row, entry),
          outcome: 'failed' as const,
          reasonCode: classified.conflictClass,
          reasonDetail: error.message,
        })),
        deferred: [],
        fatal: `${table} could not be restored (${classified.conflictClass}): ${error.message}`,
      };
    }

    // One row in the chunk is bad and PostgREST failed all of them for it. Retrying alone is the
    // only way to tell "499 restored, 1 duplicate" from "500 failed".
    this.logger.debug(
      `Retrying ${rows.length} ${table} rows individually after ${classified.conflictClass}`,
    );

    let inserted = 0;
    let skipped = 0;
    let failed = 0;
    const conflicts: RestoreConflictRecord[] = [];
    const rowOutcomes: RowOutcome[] = [];
    const deferred: Record<string, unknown>[] = [];

    for (const row of rows) {
      const rowError = await this.insert(table, [row], client, omitColumn);
      const rowKey = rowKeyOf(row, entry);

      if (!rowError) {
        inserted += 1;
        rowOutcomes.push({ row, rowPk: rowKey, outcome: 'restored' });

        continue;
      }

      const rowClass = classifyInsertError(rowError.code);

      if (rowClass.conflictClass === 'duplicate') {
        const constraint = constraintNameOf(rowError.message);

        // One named index is answered by giving up the value instead of the row. See
        // `REISSUE_ON_CONFLICT`. Attempted once, on a COPY so nothing downstream reads a row this
        // branch mutated, and only when the row actually carried a value to give up.
        if (
          reissue &&
          constraint === reissue.constraint &&
          row[reissue.column] !== null &&
          row[reissue.column] !== undefined
        ) {
          const retried = {
            ...row,
            [reissue.column]: reissuedValue(reissue, row[reissue.column]),
          };
          const retryError = await this.insert(
            table,
            [retried],
            client,
            omitColumn,
          );

          if (!retryError) {
            inserted += 1;
            conflicts.push({
              table,
              conflictClass: 'duplicate',
              severity: 'warning',
              rowKey,
              resolution: 'degraded_to_null',
              columnName: reissue.column,
              detail: reissuedDetail(reissue),
            });

            // `retried`, not `row` — the caller reads `id` off this to record what landed, and
            // both carry the same one, but the emptied column has to be what is remembered.
            rowOutcomes.push({
              row: retried,
              rowPk: rowKey,
              outcome: 'restored',
            });

            continue;
          }

          // Something else refuses it too. Fall through and report the ORIGINAL refusal, which is
          // the one the operator can act on.
        }

        // The operator asked for the archive's configuration to win. This is the ONLY place a
        // restore writes over a row that was already there, and it is reached only for a table in
        // `REPLACE_ON_CONFLICT`, only cross-organization, and only on an explicit request.
        if (replaceKey) {
          const replaced = await this.replaceExisting(
            table,
            row,
            replaceKey,
            client,
            omitColumn,
          );

          if (replaced) {
            inserted += 1;
            conflicts.push({
              table,
              conflictClass: 'duplicate',
              severity: 'warning',
              rowKey,
              resolution: 'refused',
              detail:
                'The configuration already in this space was replaced by the backup, because ' +
                'the restore was asked to let the archive win.',
            });
            rowOutcomes.push({ row, rowPk: rowKey, outcome: 'restored' });

            continue;
          }

          // The update itself failed. Report the original refusal rather than the second error —
          // the row is still exactly as it was, which is what the skip below says.
        }

        // A unique key was already taken. Left exactly as it is — the archive does not overwrite the
        // database — and reported as the constraint failure it is rather than as a claim about what
        // this space contains. See `duplicateDetail`.
        const detail = duplicateDetail(rowError.message);

        skipped += 1;
        conflicts.push({
          table,
          conflictClass: 'duplicate',
          severity: 'info',
          rowKey,
          resolution: 'skipped',
          detail,
        });
        rowOutcomes.push({
          row,
          rowPk: rowKey,
          outcome: 'skipped',
          reasonCode: 'duplicate',
          reasonDetail: detail,

          // Carried so the caller can go and find the row that blocked this one. Reading it is
          // optional: every existing consumer ignores the field and behaves as it always has.
          conflict: {
            constraintName: constraintNameOf(rowError.message),
            key: parseConflictKey(rowError.details),
          },
        });

        continue;
      }

      if (rowClass.conflictClass === 'missing_parent') {
        // Held back rather than counted. The row it points at may simply not have been read yet,
        // and the caller retries the whole set once the table is complete. Counting it here as
        // well as there would report the same row twice.
        //
        // No report record either, for the same reason: pass two reaches the verdict, and a record
        // written here would be joined by a second one there for the same row.
        deferred.push(row);

        continue;
      }

      failed += 1;
      conflicts.push({
        table,
        conflictClass: rowClass.conflictClass,
        severity: 'error',
        rowKey,
        resolution: 'unresolved',
        detail: rowError.message,
      });
      rowOutcomes.push({
        row,
        rowPk: rowKey,
        outcome: 'failed',
        reasonCode: rowClass.conflictClass,
        reasonDetail: rowError.message,
      });
    }

    return { inserted, skipped, failed, conflicts, rowOutcomes, deferred };
  }

  /**
   * The table's second pass: rows whose parent was missing the first time.
   *
   * Run once, after every row of the table has been attempted, so a row pointing at another row in
   * the SAME table — a sub-task under its parent, either half of a cycle — now finds it. A row that
   * still cannot resolve is counted as skipped, not failed: its parent was simply not part of what
   * the operator chose to restore, which is a decision rather than a fault.
   */
  private async retryDeferred(
    table: string,
    rows: Record<string, unknown>[],
    entry: NonNullable<ReturnType<typeof tableEntry>>,
    client?: WriteClient,
    omitColumn?: string,
  ): Promise<{
    inserted: number;
    skipped: number;
    failed: number;
    conflicts: RestoreConflictRecord[];
    rowOutcomes: RowOutcome[];
  }> {
    let inserted = 0;
    let skipped = 0;
    let failed = 0;
    const conflicts: RestoreConflictRecord[] = [];

    // Pass two is the ONLY place a deferred row is reported. It was counted nowhere in pass one, so
    // every branch below emits exactly one record for exactly one row.
    const rowOutcomes: RowOutcome[] = [];

    for (const row of rows) {
      const error = await this.insert(table, [row], client, omitColumn);
      const rowKey = rowKeyOf(row, entry);

      if (!error) {
        inserted += 1;
        rowOutcomes.push({ row, rowPk: rowKey, outcome: 'restored' });

        continue;
      }

      const rowClass = classifyInsertError(error.code);

      if (rowClass.conflictClass === 'missing_parent') {
        const detail =
          'This row refers to something that is not in this restore and is not already in the ' +
          `database, so it was left out rather than inserted with a broken link: ${error.message}`;

        skipped += 1;
        conflicts.push({
          table,
          conflictClass: 'missing_parent',
          severity: 'warning',
          rowKey,
          resolution: 'skipped',
          detail,
        });
        rowOutcomes.push({
          row,
          rowPk: rowKey,
          outcome: 'skipped',
          reasonCode: 'missing_parent',
          reasonDetail: detail,
        });

        continue;
      }

      if (rowClass.conflictClass === 'duplicate') {
        const detail = duplicateDetail(error.message);

        skipped += 1;
        conflicts.push({
          table,
          conflictClass: 'duplicate',
          severity: 'info',
          rowKey,
          resolution: 'skipped',
          detail,
        });
        rowOutcomes.push({
          row,
          rowPk: rowKey,
          outcome: 'skipped',
          reasonCode: 'duplicate',
          reasonDetail: detail,

          // Same as pass one. A row can reach here only by having been deferred for a missing
          // parent first, but once it is refused as a duplicate it is the same fact and deserves
          // the same handle on it.
          conflict: {
            constraintName: constraintNameOf(error.message),
            key: parseConflictKey(error.details),
          },
        });

        continue;
      }

      failed += 1;
      conflicts.push({
        table,
        conflictClass: rowClass.conflictClass,
        severity: 'error',
        rowKey,
        resolution: 'unresolved',
        detail: error.message,
      });
      rowOutcomes.push({
        row,
        rowPk: rowKey,
        outcome: 'failed',
        reasonCode: rowClass.conflictClass,
        reasonDetail: error.message,
      });
    }

    return { inserted, skipped, failed, conflicts, rowOutcomes };
  }

  /**
   * One insert. INSERT only — never upsert.
   *
   * The tenant column is not re-asserted here: `prepareRow` has already refused any row whose
   * tenant is not this organization, and re-writing it at this point would be the silent rewrite
   * that check exists to prevent.
   *
   * @param omitColumn Left out of the payload so the destination's own default supplies it — the
   *   sequence-assigned primary key of a re-keyed table. Omitted rather than nulled, because the
   *   column is NOT NULL and an explicit null is a `23502` rather than a default fill. The caller's
   *   row objects are untouched: they still carry the archived key, which the repeat-restore guard
   *   and the entity-map capture both read AFTER this returns. Undefined for every other table, and
   *   then this behaves exactly as it did before the parameter existed.
   */
  /**
   * Overwrites the row already occupying a unique slot with the archived one.
   *
   * The only UPDATE a restore ever issues. It matches on the same columns the violated index
   * covers, so it can address exactly the row that refused the insert and nothing else.
   *
   * `id` and `created_at` are left alone: the destination's row keeps its identity, so anything
   * already pointing at it still resolves, and only the configuration itself changes. Writing a
   * new id here would orphan every reference to the row being replaced.
   *
   * @returns true when one row was updated; false leaves the caller reporting the original refusal.
   */
  private async replaceExisting(
    table: string,
    row: Record<string, unknown>,
    keyColumns: string[],
    client?: WriteClient,
    omitColumn?: string,
  ): Promise<boolean> {
    const payload: Record<string, unknown> = { ...row };

    delete payload['id'];
    delete payload['created_at'];

    if (omitColumn) {
      delete payload[omitColumn];
    }

    // Matching on a null would silently address every row whose key column is null.
    if (
      keyColumns.some(
        (column) => row[column] === null || row[column] === undefined,
      )
    ) {
      return false;
    }

    try {
      let query = (client ?? this.db).from(table).update(payload);

      for (const column of keyColumns) {
        query = query.eq(column, row[column]);
      }

      const { error } = (await query) as unknown as {
        error: { message: string } | null;
      };

      if (error) {
        this.logger.warn(
          `Could not replace existing ${table} configuration: ${error.message}`,
        );

        return false;
      }

      return true;
    } catch (err) {
      this.logger.warn(
        `Replacing existing ${table} configuration failed: ${(err as Error).message}`,
      );

      return false;
    }
  }

  private async insert(
    table: string,
    rows: Record<string, unknown>[],
    client?: WriteClient,
    omitColumn?: string,
  ): Promise<InsertError | null> {
    const payload = omitColumn
      ? rows.map((row) => {
          const copy = { ...row };

          delete copy[omitColumn];

          return copy;
        })
      : rows;

    // An absent client means this instance, which is what a restore did before destinations
    // existed — so omitting it keeps the original behaviour rather than changing it.
    const { error } = (await (client ?? this.db)
      .from(table)
      .insert(payload)) as unknown as {
      error: {
        code?: string | null;
        message: string;
        details?: string | null;
      } | null;
    };

    if (!error) {
      return null;
    }

    // `details` is carried now, having been dropped here before. On a unique violation Postgres
    // puts the offending key in it — `Key (public_slug)=(test-anonymous-form) already exists.` —
    // which is the only place the CONFLICTING VALUE appears. `message` names the constraint but
    // never the value, so without this there is no way to find the row that did the blocking.
    // Nothing reads it unless a duplicate is being resolved, so every other path is unchanged.
    return {
      code: error.code ?? null,
      message: error.message,
      details: error.details ?? null,
    };
  }

  /**
   * Gives each keyless task `<SPACE>-T<n>` from a block reserved on its space's key counter.
   * Anything unreadable leaves the keys empty, and the trigger mints them as before.
   */
  private async assignTaskKeys(
    rows: Record<string, unknown>[],
    client: WriteClient,
    spaceKeys: Map<string, string | null>,
  ): Promise<void> {
    const bySpace = new Map<string, Record<string, unknown>[]>();

    for (const row of rows) {
      if (row.key != null || typeof row.space_id !== 'string') {
        continue;
      }

      bySpace.set(row.space_id, [...(bySpace.get(row.space_id) ?? []), row]);
    }

    for (const [spaceId, spaceRows] of bySpace) {
      try {
        if (!spaceKeys.has(spaceId)) {
          const { data, error } = (await client
            .from('spaces')
            .select('key')
            .eq('id', spaceId)
            .maybeSingle()) as unknown as {
            data: { key: string | null } | null;
            error: unknown;
          };

          spaceKeys.set(spaceId, error ? null : (data?.key ?? null));
        }

        const spaceKey = spaceKeys.get(spaceId);
        const first = spaceKey
          ? await this.reserveTaskNumbers(spaceId, spaceRows.length, client)
          : null;

        if (!spaceKey || first === null) {
          continue;
        }

        spaceRows.forEach((row, index) => {
          row.key = `${spaceKey}-T${first + index}`;
        });
      } catch (err) {
        // Keys stay empty and the trigger mints them, which is the old path.
        this.logger.warn(
          `Task keys for space ${spaceId} left to the database: ${(err as Error).message}`,
        );
      }
    }
  }

  /** First number of a block of `count` on the space's key counter, or null when none could be claimed. */
  private async reserveTaskNumbers(
    spaceId: string,
    count: number,
    client: WriteClient,
  ): Promise<number | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { data, error } = (await client
        .from('task_key_sequences_space')
        .select('last_number')
        .eq('space_id', spaceId)
        .maybeSingle()) as unknown as {
        data: { last_number: number } | null;
        error: unknown;
      };

      // No counter yet: the trigger creates it from the space's real highest key on the first insert.
      if (error || !data || !Number.isFinite(data.last_number)) {
        return null;
      }

      // Compare-and-set, so a task created in the space meanwhile makes this retry instead of overlap.
      const { data: claimed, error: claimError } = (await client
        .from('task_key_sequences_space')
        .update({
          last_number: data.last_number + count,
          updated_at: new Date().toISOString(),
        })
        .eq('space_id', spaceId)
        .eq('last_number', data.last_number)
        .select('space_id')) as unknown as {
        data: { space_id: string }[] | null;
        error: unknown;
      };

      if (claimError) {
        return null;
      }

      if (claimed?.length) {
        return data.last_number + 1;
      }
    }

    return null;
  }
}
