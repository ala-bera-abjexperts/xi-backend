/**
 * @fileoverview Turns an archived row into a row that may be inserted, or a counted refusal.
 * @module src/backup/engine/restore-row-preparer
 *
 * Pure functions. No database, no archive, no clock — which is the point: this is where every rule
 * that decides whether a restore corrupts data lives, and none of them should need a running system
 * to be proven.
 *
 * Four rules, each earning its place from something in the live schema:
 *
 *   - A row is written to the tenant it came from or not at all. The planner already refuses a
 *     foreign ARCHIVE; this refuses a foreign ROW inside an otherwise valid one. Rewriting the
 *     tenant id instead is the cross-organization migration the design deliberately does not do:
 *     177 jsonb and 5 uuid[] columns hold ids no FK-driven remapper can see, so a row moved by
 *     rewriting one column still points at the source tenant everywhere else.
 *   - Columns Postgres computes are stripped. Sending a GENERATED ALWAYS AS STORED column is an
 *     error, not an override, and Postgres rejects the whole row.
 *   - A user FK pointing at someone who no longer exists is nulled or the row is dropped, per the
 *     registry's `userFkPolicy` — 207 columns nullable, 26 not. Never a sentinel user, never a
 *     restored `public.users` row, never a match by email.
 *   - Values are passed through untouched. No `new Date()`, no number reformatting: a JS double
 *     silently loses money and hours, and re-serialising a timestamp invents one.
 *
 * Every refusal is returned, never thrown. A restore that stops at the first bad row out of 40 000
 * is less useful than one that writes 39 998 and names the two it would not.
 */

import {
  SEQUENCE_PRIMARY_KEY_TABLES,
  UNMOVABLE_PRIMARY_KEY_TABLES,
  crossOrgReissuedColumnsFor,
  reissuedColumnsFor,
} from '../registry/component-registry';
import type { ComponentTable } from '../registry/component-registry';

/**
 * A value as a comparable string, or null when it is not a scalar.
 *
 * Archived values are whatever JSON held, so a column that should carry an id can carry an object.
 * `String()` would turn that into `[object Object]` and compare it against a real id, which is how
 * a corrupt value quietly passes an identity check. Returning null instead forces every caller to
 * decide what a non-scalar means for it.
 */
function scalarString(value: unknown): string | null {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value);
    default:
      return null;
  }
}

/** Why one row was not inserted. Stable keys — the UI and `restore_conflicts` map them. */
export type SkipReason =
  | 'foreign_tenant'
  | 'missing_tenant'
  | 'missing_user'
  | 'not_an_object'
  | 'other_space';

export interface PreparedRow {
  row: Record<string, unknown>;
  /** Columns nulled because the user they pointed at is gone. Counted, never silent. */
  nulledUserColumns: string[];
  /**
   * Globally-unique columns left for the destination to reissue.
   *
   * Reported for the same reason a nulled user reference is: a value the restore dropped is a value
   * the operator should learn about from the report, not from a webhook that stopped firing.
   */
  reissuedColumns: string[];
}

export interface SkippedRow {
  reason: SkipReason;
  detail: string;
  /** The row's primary key, when it has one, so the refusal can be traced back to a row. */
  rowKey: string | null;
}

export type RowOutcome =
  | ({ kind: 'insert' } & PreparedRow)
  | ({ kind: 'skip' } & SkippedRow);

export interface PrepareContext {
  entry: ComponentTable;
  /** The organization resolved from the session. Never a body field. */
  organizationId: string;
  /** Columns Postgres computes, from the planner. */
  generatedColumns: string[];
  /**
   * Users that exist in the destination right now.
   *
   * Resolved once per run. A null set means the check is not being made — used by a dry run that
   * has not loaded the user list, and it must never be confused with "no users exist", which would
   * null or drop every user reference in the archive.
   */
  knownUsers: Set<string> | null;
  /**
   * Restore only rows in this space, or every row when absent.
   *
   * How a row is tested against it is the table's own `spaceScope`, not a single column: a table may
   * carry a space column, inherit one through a parent row, be a space, or genuinely have no space
   * at all. Treating the last two the same is what wrote another space's rows into the chosen one.
   */
  spaceId?: string | null;
  /**
   * Ids of the rows in this table's space parent that ARE in the chosen space.
   *
   * Required whenever `spaceId` is set and the table's scope is `parent`; the writer resolves it
   * before the first row and fails the table when it cannot. Null is therefore unreachable in
   * practice, and is treated as "refuse everything" rather than "allow everything" — the direction
   * that fails closed if it ever becomes reachable.
   */
  inSpaceParentIds?: ReadonlySet<string> | null;
  /**
   * The space the rows are being written INTO, when the restore is moving them.
   *
   * The opposite of `spaceId`, which narrows the archive to the rows already in a space. This takes
   * rows and puts them somewhere they were not. Both may be set — read from space A, write into
   * space B — and the filter then runs first, on the source.
   *
   * A row that is genuinely in a space cannot simply be stamped with this: its id still belongs to
   * the row in the space it came from, so it needs a new one. Organization-level rows, including the
   * NULL-space rows of space-scoped tables, are not moving and are restored unchanged.
   */
  destinationSpaceId?: string | null;
  /**
   * True when the rows are moving to a different TENANT, not merely a different space.
   *
   * Used only to word a refusal. It matters because the standing advice — "restore without choosing
   * a destination space" — is impossible cross-organization: `restore-approvals.service.ts:174`
   * throws without one. Telling an operator to do something the API refuses sends them round a loop
   * they cannot exit.
   */
  crossOrganization?: boolean;
  /**
   * Whether this table's space-scoped rows can actually be moved.
   *
   * True when `restore-id-remapper.ts` has a rewrite spec for the table, so the writer will mint a
   * new id and repoint its references. False means a space-scoped row would be inserted still
   * carrying the source space's id, which is why it is refused instead.
   */
  canRescope?: boolean;
}

/**
 * The primary key of a row, for reporting.
 *
 * Six tables have no `id` at all, so a missing one is normal rather than an error.
 */
export function rowKeyOf(
  row: Record<string, unknown>,
  entry: ComponentTable,
): string | null {
  const columns = entry.orderBy?.length ? entry.orderBy : ['id'];
  const parts: string[] = [];

  for (const column of columns) {
    const value = scalarString(row[column]);

    if (value === null) {
      continue;
    }

    parts.push(`${column}=${value}`);
  }

  return parts.length ? parts.join(',') : null;
}

/**
 * Decides what to do with one archived row.
 *
 * @returns An insertable row, or the reason it was refused. Never throws — a refusal is data.
 */
export function prepareRow(
  value: unknown,
  context: PrepareContext,
): RowOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      kind: 'skip',
      reason: 'not_an_object',
      detail: 'This entry is not a row.',
      rowKey: null,
    };
  }

  const source = value as Record<string, unknown>;
  const rowKey = rowKeyOf(source, context.entry);
  const tenantRefusal = refuseForeignTenant(source, context, rowKey);

  if (tenantRefusal) {
    return tenantRefusal;
  }

  // Filtering and re-scoping are opposite operations and never both apply. `spaceId` narrows the
  // archive to the rows already in a space; `destinationSpaceId` takes the rows and puts them in
  // one. A run may carry both — read from space A, write into space B — and then the filter runs
  // first, on the source, exactly as it reads.
  const spaceRefusal = refuseOtherSpace(source, context, rowKey);

  if (spaceRefusal) {
    return spaceRefusal;
  }

  const rescopeRefusal = refuseUnmovableRow(source, context, rowKey);

  if (rescopeRefusal) {
    return rescopeRefusal;
  }

  // Copied rather than mutated: the caller's row may be reported in an error, and a half-stripped
  // row in a log message is a confusing thing to read.
  const row: Record<string, unknown> = { ...source };

  for (const column of context.generatedColumns) {
    delete row[column];
  }

  // Columns whose uniqueness is GLOBAL: carrying the archived value collides with whatever row
  // still holds it. Stripped, not nulled, like the generated columns above, so the destination
  // applies any default it has rather than being forced to null.
  //
  // On the `prepareRow` path rather than the remapper's `regenerateColumns` because this one runs
  // for every restore — remapped or not — and the collision does not depend on re-scoping.
  const reissuedColumns: string[] = [];

  for (const column of reissuedColumnsFor(context.entry.table)) {
    if (column in row) {
      delete row[column];
      reissuedColumns.push(column);
    }
  }

  // And the columns that only collide across a TENANT boundary — a subdomain, a Stripe session —
  // whose unique index carries no `organization_id`.
  //
  // Gated, unlike the list above, because the trigger really is different. Within one organization
  // the archived value is still this row's own address: stripping it on a space move would take a
  // working funnel off the air to avoid a collision that exists only because the operator asked for
  // a copy. Across organizations the same value can never be written twice, so carrying it means the
  // row is refused as a duplicate against a tenant that has never seen it — eleven funnels and the
  // eleven pages beneath them, on a real restore.
  if (context.crossOrganization) {
    for (const column of crossOrgReissuedColumnsFor(context.entry.table)) {
      if (column in row) {
        delete row[column];
        reissuedColumns.push(column);
      }
    }
  }

  const nulledUserColumns: string[] = [];

  for (const [column, policy] of Object.entries(context.entry.userFkPolicy)) {
    const userId = row[column];

    // A non-scalar in a user FK column is corrupt rather than absent, and falls through to the
    // policy below — nulled or dropped — because it can never match a real user id either.
    const lookup = scalarString(userId);

    if (
      userId === undefined ||
      userId === null ||
      context.knownUsers === null ||
      (lookup !== null && context.knownUsers.has(lookup))
    ) {
      continue;
    }

    if (policy === 'skip_row') {
      // There is no version of this row that can be written without the user. Dropping it and
      // saying so beats inserting something the database will refuse anyway.
      //
      // The wording is deliberately about the ROW, not the column. It used to say "the column
      // cannot be empty", which was true of every table using this policy while they were all NOT
      // NULL — and became false the moment `form_builder_assignments.assignee_user_id` joined them:
      // that column is nullable, and what cannot happen is it AND `assignee_role` both being empty
      // (`form_builder_assignments_target_check`). Naming the row covers both shapes without
      // asserting anything about the column that might not hold.
      return {
        kind: 'skip',
        reason: 'missing_user',
        detail:
          `${column} refers to a user who is no longer in this organization, and this row cannot ` +
          'be written without them, so it was not restored.',
        rowKey,
      };
    }

    /*
     * The archived id stands, and the database rules on it.
     *
     * Only for a column a CHECK constraint reads, where the other two policies both lose: nulling
     * produces a row the destination refuses, dropping loses a row that was restorable. `knownUsers`
     * is the destination's MEMBER list, but this FK points at `users`, which is global — so a user
     * who still exists satisfies it from any organization, and one who is genuinely gone answers
     * 23503, which is row-level and costs only this row.
     *
     * `lookup !== null` is load bearing. Reaching this line means either a scalar id that is not a
     * member, or a NON-SCALAR value — a jsonb object where a uuid belongs, which `scalarString`
     * reports as null. That second case is corrupt rather than absent, and sending it would answer
     * 22P02 where nulling it costs nothing, so it keeps falling through below.
     */
    if (policy === 'keep' && lookup !== null) {
      continue;
    }

    /*
     * The same bargain as `keep`, for a column that has no null to fall back to.
     *
     * `keep` drops through to nulling when the value is not a usable id. On a NOT NULL column that
     * is `23502`, which is classified NOT row-level — one corrupt value would abandon the entire
     * table rather than the one row carrying it. Skipping keeps the damage where it belongs.
     *
     * Ordered after `keep` so the two cannot be confused, and before the null below so the column
     * is never emptied.
     */
    if (policy === 'keep_required') {
      if (lookup !== null) {
        continue;
      }

      return {
        kind: 'skip',
        reason: 'missing_user',
        detail:
          `${column} does not hold a usable user id, and this row cannot be written without one, ` +
          'so it was not restored.',
        rowKey,
      };
    }

    row[column] = null;
    nulledUserColumns.push(column);
  }

  return { kind: 'insert', row, nulledUserColumns, reissuedColumns };
}

/**
 * Whether a row is actually IN a space, as opposed to merely sitting in a table that has one.
 *
 * Fifteen of the space-scoped tables allow a NULL space column, and a NULL there means the row
 * belongs to the whole organization: a shared task status, an org-wide custom field. Queried
 * against the live database, `task_statuses`, `task_priorities`, `status_categories` and
 * `task_status_transitions` are 100% NULL — every one of their rows is an organization default.
 *
 * That distinction decides whether a row needs a new id. An org-level default is not moving
 * anywhere; it is restored as it is. Only a genuinely space-scoped row has to be re-pointed.
 */
function isInASpace(
  row: Record<string, unknown>,
  entry: ComponentTable,
): boolean {
  switch (entry.spaceScope.kind) {
    case 'organization':
      return false;

    // `spaces` is not IN a space, it IS one — handled separately, and never re-scoped.
    case 'self':
      return false;

    case 'own':
      return scalarString(row[entry.spaceScope.column]) !== null;

    // No column of its own; its space is the row it points at. A null FK is the same "no space I
    // can name" case as a null space column.
    case 'parent':
      return scalarString(row[entry.spaceScope.scope.column]) !== null;

    default: {
      const exhaustive: never = entry.spaceScope;

      return exhaustive;
    }
  }
}

/**
 * Refuses a row that cannot be moved into the destination space.
 *
 * Only rows that are genuinely in a space need moving, and moving one means minting a new id — the
 * archived id still belongs to the row in the space it came from. `restore-id-remapper.ts` does
 * that, and it does it for the tables it has a rewrite spec for. A space-scoped row from a table
 * without one would otherwise be inserted carrying the SOURCE space's id and its old key: visibly
 * in the destination space, and still pointing at the space it came from through every reference
 * the FK graph cannot see.
 *
 * Refused per ROW rather than per table, which is the difference between a usable feature and an
 * unusable one. A cross-organization restore refuses the whole table, correctly, because every row
 * there carries the wrong tenant. Here most tables are mixed: `custom_fields` holds 2 organization
 * defaults and 9 space-scoped rows, and refusing the table would throw away the 2 that are fine.
 */
function refuseUnmovableRow(
  row: Record<string, unknown>,
  context: PrepareContext,
  rowKey: string | null,
): ({ kind: 'skip' } & SkippedRow) | null {
  const destination = context.destinationSpaceId;

  if (!destination) {
    return null;
  }

  const entry = context.entry;

  // The destination space already exists — it was chosen from a list of live spaces — so there is
  // nothing to write. Refusing says that; writing the archived row would try to create a second
  // space under the source's id.
  if (entry.spaceScope.kind === 'self') {
    return {
      kind: 'skip',
      reason: 'other_space',
      detail:
        'The space being restored into already exists, so the archived space row was not written.',
      rowKey,
    };
  }

  // Organization-level rows, and the organization-level rows of space-scoped tables, are restored
  // exactly as they are: same id, no re-scoping. They are not in any space, so nothing moves.
  if (!isInASpace(row, entry)) {
    return null;
  }

  // In a space, and the run knows how to move it.
  if (context.canRescope) {
    return null;
  }

  // History that is true of ONE space, so it is never carried into another.
  //
  // Worth its own sentence because the generic message below tells the operator to clear the
  // destination space — advice that cannot work here, since the space was never the reason. Someone
  // reads it, tries it, and is no further forward. The fact comes from the registry, which is also
  // what made the engine refuse the table, so the explanation and the decision cannot drift apart.
  //
  // Deliberately says WHY in the operator's terms rather than naming the primary-key type.
  //
  // Generic now, and unreachable until something is added to the list — it is empty. The wording it
  // used to carry was `automation_event_outbox`'s alone ("records automation activity that happened
  // in one space"), which was accurate for the one member and would have been a lie for the next.
  // That table now re-scopes through `SEQUENCE_REKEYED_TABLES`; see the registry docblock for what a
  // new member has to prove before it is refused outright rather than moved.
  if (
    (SEQUENCE_PRIMARY_KEY_TABLES as readonly string[]).includes(entry.table)
  ) {
    return {
      kind: 'skip',
      reason: 'other_space',
      detail:
        `${entry.table} records activity that happened in one space, and it cannot be written into ` +
        `another without saying something untrue about it. ${remedyFor(context)}`,
      rowKey,
    };
  }

  // No surrogate key exists to reissue — the key IS the tenant/type/year triple.
  if (
    (UNMOVABLE_PRIMARY_KEY_TABLES as readonly string[]).includes(entry.table)
  ) {
    return {
      kind: 'skip',
      reason: 'other_space',
      detail:
        `${entry.table} is identified by the organization it belongs to rather than by a row id, ` +
        `so there is nothing to reissue for a different one. ${remedyFor(context)}`,
      rowKey,
    };
  }

  return {
    kind: 'skip',
    reason: 'other_space',
    detail:
      `${entry.table} rows belong to a space, and this restore cannot move them into another one — ` +
      `their ids and references would still point at the space they came from. ${remedyFor(context)}`,
    rowKey,
  };
}

/**
 * What the operator can actually do about an unmovable row.
 *
 * Cross-organization there is nothing: a destination space is mandatory
 * (`restore-approvals.service.ts:174` throws without one), so "clear the destination space" is
 * advice the API refuses. Saying it anyway is how an operator ends up retrying the same restore and
 * getting the same 44 skipped rows, which is exactly what happened here.
 */
function remedyFor(context: PrepareContext): string {
  return context.crossOrganization
    ? 'A restore into another organization always needs a destination space, so these rows cannot ' +
        'be brought across. They stay in the organization they were backed up from.'
    : 'Restoring without choosing a destination space puts them back where they came from.';
}

/**
 * Refuses a row belonging to another tenant.
 *
 * The service role bypasses RLS, so there is no database backstop here — this check is the only
 * thing between a tampered archive and one tenant's rows landing in another's.
 */
function refuseForeignTenant(
  row: Record<string, unknown>,
  context: PrepareContext,
  rowKey: string | null,
): ({ kind: 'skip' } & SkippedRow) | null {
  const column = context.entry.tenantColumn;

  // A parent-scoped table has no tenant column of its own. Its tenancy is decided by the parent
  // row it points at, which either exists in this organization or fails the foreign key.
  if (!column) {
    return null;
  }

  // A non-scalar here is not a tenant id, and is treated as absent rather than compared: an
  // object stringifies to `[object Object]`, which would fail the check for the wrong reason.
  const value = scalarString(row[column]);

  if (value === null) {
    return {
      kind: 'skip',
      reason: 'missing_tenant',
      detail: `This row has no usable ${column}, so which organization it belongs to cannot be established.`,
      rowKey,
    };
  }

  if (value !== context.organizationId) {
    return {
      kind: 'skip',
      reason: 'foreign_tenant',
      detail:
        `This row belongs to organization ${value}, not to the one being restored. ` +
        'It was not written, because moving a row between tenants would leave every id it ' +
        'carries pointing at the organization it came from.',
      rowKey,
    };
  }

  return null;
}

/**
 * Refuses a row that is not in the space the operator chose.
 *
 * Which question to ask comes from the table's `spaceScope`, and there are four of them. The old
 * code asked only one — "does this row's space column match?" — and let every table without such a
 * column through. That silently covered three unrelated cases: organization-level tables (right by
 * accident), tables whose space comes from a parent row (wrong, and the reason a restore scoped to
 * one space wrote 99 `task_history` rows belonging to another), and `spaces` itself (wrong, and the
 * reason it recreated every archived space of the tenant).
 *
 * Every refusal keeps `reason: 'other_space'`. The writer's per-table counting, its once-per-table
 * summary and its "a fully filtered table is skipped, not succeeded" rule all key off that literal;
 * only the wording of `detail` differs between the kinds.
 */
function refuseOtherSpace(
  row: Record<string, unknown>,
  context: PrepareContext,
  rowKey: string | null,
): ({ kind: 'skip' } & SkippedRow) | null {
  const wanted = context.spaceId;

  if (!wanted) {
    return null;
  }

  const refuse = (detail: string): { kind: 'skip' } & SkippedRow => ({
    kind: 'skip',
    reason: 'other_space',
    detail,
    rowKey,
  });

  const scope = context.entry.spaceScope;

  switch (scope.kind) {
    // Not in any space, so no space can exclude it. Organization-level configuration, the partner
    // ledger, Site Studio — restored whole for the organization, which is what "this belongs to the
    // org, not the space" means.
    case 'organization':
      return null;

    // The table IS the list of spaces. "Restore space X" means the one row that IS space X.
    case 'self': {
      const id = scalarString(row['id']);

      return id === wanted
        ? null
        : refuse(
            `This is space ${id ?? 'unknown'}, not the one that was chosen.`,
          );
    }

    case 'own': {
      // Same reasoning as the tenant check: a non-scalar is not an id, and comparing it would fail
      // for the wrong reason.
      const value = scalarString(row[scope.column]);

      if (value === wanted) {
        return null;
      }

      if (value === null) {
        return scope.whenNull === 'organization'
          ? null
          : refuse(
              `This row has no ${scope.column}, so it is not in the space that was chosen.`,
            );
      }

      return refuse(
        `This row belongs to space ${value}, not the one that was chosen.`,
      );
    }

    // The row names no space of its own; the row it points at does. The set was resolved once for
    // the whole table before any row was read.
    case 'parent': {
      const value = scalarString(row[scope.scope.column]);

      if (value === null) {
        return scope.scope.whenNull === 'organization'
          ? null
          : refuse(
              `This row has no ${scope.scope.column}, so which space it is in cannot be established.`,
            );
      }

      // Fails closed. An unresolved set means the space could not be established, which is not the
      // same as "every row qualifies" — that confusion is the bug this function exists to fix.
      if (!context.inSpaceParentIds) {
        return refuse(
          `Which rows of ${scope.scope.parentTable} are in the chosen space could not be established, ` +
            `so this row's space is unknown.`,
        );
      }

      return context.inSpaceParentIds.has(value)
        ? null
        : refuse(
            `The ${scope.scope.parentTable} row this belongs to is not in the space that was chosen.`,
          );
    }

    default: {
      // Adding a fifth kind must break here rather than silently restore into every space.
      const exhaustive: never = scope;

      return exhaustive;
    }
  }
}

/** How an insert failed, in terms an operator can act on. */
export type ConflictClass =
  | 'duplicate'
  | 'missing_parent'
  | 'missing_required_column'
  | 'invalid_value'
  | 'schema_drift'
  | 'permission'
  | 'unknown';

/**
 * Classifies a Postgres error from an insert.
 *
 * `missing_required_column` is the one worth naming: it means a NOT NULL column with no default was
 * added after the archive was written, so no archived row can satisfy it. There are 850 such
 * columns live, and without this the failure reads as a generic database error at row 40 000.
 */
export function classifyInsertError(code: string | null | undefined): {
  conflictClass: ConflictClass;
  /** True when the rest of the table is still worth attempting. */
  rowLevel: boolean;
} {
  switch (code) {
    case '23505':
      // Unique violation. Expected on a resume, and counted rather than treated as damage.
      return { conflictClass: 'duplicate', rowLevel: true };
    case '23503':
      return { conflictClass: 'missing_parent', rowLevel: true };
    case '23502':
      return { conflictClass: 'missing_required_column', rowLevel: false };
    case '22P02':
    case '22007':
    case '22003':
      return { conflictClass: 'invalid_value', rowLevel: true };
    case '23514':
      // A CHECK the destination refuses. Row-level, unlike the two schema faults below, because a
      // CHECK is by definition a statement about THIS row's values — the next row may satisfy it.
      //
      // It had no case at all and fell to `unknown`, which is `rowLevel: false`, so ONE offending
      // row aborted its entire table. That is not hypothetical: `form_builder_assignments` lost all
      // 6 rows and `partner_leads` all 4 on a real restore, both to a constraint that only some
      // rows could ever violate, and both reported as a generic database fault.
      return { conflictClass: 'invalid_value', rowLevel: true };
    case '42703':
    case 'PGRST204':
      // A column in the archive no longer exists, or one the table needs is unknown to PostgREST.
      // Every row of this table has the same shape, so retrying the rest is pointless.
      return { conflictClass: 'schema_drift', rowLevel: false };
    case '428C9':
      // Writing an explicit value into a GENERATED ALWAYS column. A fact about the TABLE, not the
      // row — every row would answer the same — so `rowLevel` stays false, exactly like the two
      // above. What this case buys is the name: without it the failure fell to `unknown`, which
      // tells an operator nothing and reads as a generic database fault at row 40 000.
      //
      // Tables known to be shaped this way are refused up front via `IDENTITY_COLUMN_TABLES`, so
      // reaching here means a NEW one appeared. That is precisely when a named class is worth having.
      return { conflictClass: 'schema_drift', rowLevel: false };
    case '42501':
      /*
       * Row-level, because a refusal here is usually about THIS row rather than the table.
       *
       * RLS is the obvious reading and it is not the common one: the restore writes as the service
       * role, which bypasses RLS entirely. What actually raises 42501 is a SECURITY DEFINER trigger
       * written precisely BECAUSE the service role bypasses RLS — and those inspect the row.
       * `partner_customers_enforce_sell_authorisation` only fires when `customer_organization_id IS
       * NOT NULL`, so it can refuse one row of a chunk and have nothing to say about the rest.
       *
       * As `rowLevel: false` it had plenty to say: one blocked row failed its whole 200-row chunk.
       * On a real restore that reported six partner_customers as failed when five of them carried a
       * NULL `customer_organization_id` and the trigger never even looked at them. Identical to the
       * 23514 case above, which was moved here for the same reason.
       *
       * A destination that genuinely denies the table — a mis-pasted key on a remote destination —
       * now retries row by row before reaching the same verdict. Slower, and the same cost already
       * accepted for 23505, 23503 and 23514.
       */
      return { conflictClass: 'permission', rowLevel: true };
    default:
      return { conflictClass: 'unknown', rowLevel: false };
  }
}

/**
 * Splits rows into batches.
 *
 * The backend accepts a 10 MB body, so a 200 000-row table cannot be one request. Batching by row
 * count rather than by serialised size is deliberate — it is predictable, and the cap is set well
 * below the limit rather than measured against it.
 */
export function batchesOf<T>(rows: T[], size: number): T[][] {
  if (size < 1) {
    throw new Error('Batch size must be at least 1.');
  }

  const batches: T[][] = [];

  for (let index = 0; index < rows.length; index += size) {
    batches.push(rows.slice(index, index + size));
  }

  return batches;
}
