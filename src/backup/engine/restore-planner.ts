/**
 * @fileoverview Decides whether a restore may run, and in what order.
 * @module src/backup/engine/restore-planner
 *
 * Pure functions, no database and no archive. Everything here answers a question
 * that must be settled BEFORE a single row is written, because a restore cannot
 * be rolled back — the design doc is explicit that whole-restore rollback is
 * impossible and must never be promised. A refusal is cheap; a half-applied
 * restore is not.
 *
 * Four of the five refusals below come from checking the live schema rather than
 * from the design doc, and each would otherwise have failed the first real
 * restore:
 *
 *   - two GENERATED ALWAYS AS IDENTITY columns that PostgREST cannot write to,
 *   - two GENERATED ALWAYS AS STORED columns that must never be sent,
 *   - 40 INSERT triggers, one of which grants the operator admin on every
 *     restored space,
 *   - 850 NOT NULL columns with no default, any of which fails a row that
 *     predates it.
 */

import {
  COMPONENT_REGISTRY,
  IDENTITY_COLUMN_TABLES,
  tableEntry,
  type ComponentTable,
} from '../registry/component-registry';
import { fkEdgesFor } from '../registry/restore-fk-graph';

import {
  RESTORABLE_FORMATS,
  type BackupFileFormat,
} from './writers/table-writer';

/**
 * Tables that cannot be restored through PostgREST at all.
 *
 * Defined in the registry — a table Postgres numbers itself is a fact about that table, and the
 * registry is the bottom of this module's dependency graph, so the picker's restorability
 * projection can read it without the registry importing this file. Re-exported here because this is
 * the import site every existing consumer already uses.
 */
export { IDENTITY_COLUMN_TABLES };

/**
 * Columns Postgres computes itself. Sending one is an error, not an override,
 * so they are stripped from every row before insert.
 */
export const GENERATED_COLUMNS: Record<string, string[]> = {
  partner_leads: ['customer_company_normalized'],

  // `search_vector` cost a real restore its entire wiki_pages table: the exporter selects `*`, so
  // the column is in every archive, and sending it answers 428C9 — which is classed `rowLevel:
  // false`, so one row's refusal abandons the table. The catalog says these two are the only
  // GENERATED ALWAYS AS STORED columns in the schema, so this map is now complete.
  wiki_pages: ['search_vector'],

  // GENERATED ALWAYS AS **IDENTITY**, which the sentence above does not cover — that survey asked
  // only for AS STORED. An identity column refuses an explicit value exactly as a stored one does,
  // with the same 428C9 and the same whole-table abandonment, so it belongs in the same list.
  //
  // Never tripped so far only because no archive has carried a support ticket: every recorded run
  // shows `planned_row_count: 0` for this table. The first archive with one in it would have taken
  // the table down, same-organization included.
  //
  // Consequence worth stating: a restored ticket gets a NEW number from the destination. There is
  // no way to insert the archived one into an identity column, so a reference kept outside this
  // system will not match after a restore.
  support_requests: ['ticket_number'],
};

/** Why a table or a whole restore was refused. Stable keys — the UI maps them. */
export type RefusalCode =
  | 'format_not_restorable'
  | 'foreign_organization'
  | 'identity_column'
  | 'not_in_registry'
  | 'not_restorable_by_default'
  | 'identity_tier'
  | 'destination_not_empty'
  | 'missing_required_column'
  /**
   * The archive carries no organization id of its own.
   *
   * Never a refusal — it is recorded as a note. Archives written before the engine added a manifest
   * have nothing to compare, and treating that absence as a tenant mismatch made every one of them
   * permanently unrestorable.
   */
  | 'tenant_unprovable';

export interface Refusal {
  code: RefusalCode;
  table?: string;
  detail: string;
}

export interface PlannedTable {
  table: string;
  component: string;
  tier: string;
  insertLevel: number;
  /** Columns to strip before insert because Postgres computes them. */
  generatedColumns: string[];
  /** True when the caller did not ask for this table; a dependency pulled it in. */
  addedAsDependency: boolean;
  /**
   * True when an archive-derived dependency should still be restored through the writer.
   *
   * A non-empty table proves "some parent rows exist", not that the specific rows this archive's
   * children point at exist. Dependencies discovered from the same archive therefore use the normal
   * insert/duplicate path so missing parents can be added and existing ones remain idempotent.
   */
  restoreDependencyRows?: boolean;
}

export interface RestorePlan {
  tables: PlannedTable[];
  refusals: Refusal[];

  /**
   * Components the selection depends on that are NOT part of it.
   *
   * Usually reported, not added. This used to be `addedComponents`, and their tables were silently
   * pulled into the run: choosing Tasks restored 20 tables instead of the 4 asked for, rewriting
   * spaces, statuses and process configuration nobody mentioned. Direct planner callers therefore
   * still write exactly what was chosen.
   *
   * The restore service may opt into a narrower rule after it has opened the archive: exact parent
   * tables that are physically present in the same backup can be added as dependency rows so
   * relation tables restore into the selected target scope instead of being skipped with missing
   * parents.
   */
  missingParentComponents: string[];

  /**
   * Things the operator must know that did not stop the plan.
   *
   * Holds what would have been a refusal had this not been a preview — a preview writes nothing, so
   * it reports instead of refusing, and the same condition stops the apply.
   *
   * Optional so the plans built by hand in tests and by `resolveRestoreSet` callers stay valid; read
   * it as `plan.notes ?? []`.
   */
  notes?: Refusal[];
  /** False when any refusal is fatal to the whole run rather than one table. */
  canProceed: boolean;
}

export interface PlanInput {
  /** Tables the operator picked. */
  selection: string[];
  /** Tables physically present in the archive, when the caller has already opened it. */
  availableTables?: string[];
  /**
   * Include parent rows found in the same archive.
   *
   * Defaults to false so direct planner callers keep the historical "exact selection" behavior.
   * The restore service enables it only where widening the table set cannot bypass a cross-tenant
   * approval.
   */
  includeAvailableDependencies?: boolean;
  /** The archive's format, from its manifest. */
  format: BackupFileFormat;
  /** `manifest.organization_id`. */
  archiveOrganizationId: string;
  /** The organization resolved from the session — never a body field. */
  sessionOrganizationId: string;
  /** Whether the operator has approved an identity-tier restore. */
  identityApproved?: boolean;

  /**
   * True for a dry run.
   *
   * A preview reads the archive and reports counts without writing a row, so a cross-organization
   * archive is described rather than refused. The apply passes false and is still stopped.
   */
  previewOnly?: boolean;

  /**
   * True when the run mints the archived spaces in the destination instead of folding onto a chosen
   * one.
   *
   * It changes what `spaces` IS to this planner. Folding, it is furniture that already exists in the
   * destination — the operator picked one — so it is an implicit parent nobody has to select and
   * nothing has to be ordered against. Recreating, it is an ordinary table being written, and every
   * space-scoped row in the run depends on its row having landed first.
   *
   * Defaults to false so direct planner callers keep the historical behaviour exactly.
   */
  recreateSpaces?: boolean;
}

/** True when this archive's format can be read back by the application. */
export function isRestorableFormat(format: BackupFileFormat): boolean {
  return (RESTORABLE_FORMATS as readonly string[]).includes(format);
}

/**
 * Every component a selection depends on, transitively.
 *
 * `requires` is component-level, so picking one table can pull in a whole
 * component. That is reported rather than hidden: a restore that silently grew
 * from one table to forty is not one the operator agreed to.
 */
export function requiredComponents(tables: string[]): string[] {
  const seen = new Set<string>();
  const queue: string[] = [];

  for (const table of tables) {
    const entry = tableEntry(table);

    if (entry) {
      queue.push(...entry.requires);
    }
  }

  while (queue.length) {
    const component = queue.shift() as string;

    if (seen.has(component)) {
      continue;
    }

    seen.add(component);

    // A component's own tables carry the next hop, so this terminates on the
    // registry rather than recursing on names that may not exist.
    for (const entry of COMPONENT_REGISTRY) {
      if (entry.component === component) {
        queue.push(...entry.requires);
      }
    }
  }

  return [...seen];
}

/**
 * Insert order: parents strictly before children.
 *
 * `insertLevel` is a longest-path depth over the FK graph, and the registry says
 * plainly that levels inside a cycle are a hint rather than a guarantee. Sorting
 * by it is necessary and not sufficient — the engine still resolves cycles with
 * a nullable back-edge and a second pass.
 */
/**
 * Dependencies that exist in the application but not in the schema.
 *
 * The FK graph is generated from `pg_constraint`, so it can only see references the database
 * enforces. Every table here holds ids the schema graph cannot fully describe, or whose registry
 * `insertLevel` must stay protected from older graph snapshots:
 * `form_builder_orders` at level 1 ahead of `form_builder` at 3 and `form_builder_submissions` at 6,
 * and `task_relationships` at level 2 ahead of `tasks` at 5. Every one of their rows was then
 * refused `unmapped_reference`.
 *
 * `file_attachments` at level 3 and `entity_file_links` at 4 are the same fault one step further on.
 * Their `entity_id` is polymorphic — paired with `entity_type`, pointing at a task, a wiki page or an
 * asset item — so no foreign key exists and nothing ordered them after the rows they name. Being
 * written first, they found no mapping for their entity, kept the id the archive recorded, and
 * collided with the source space's own row on `UNIQUE (entity_type, entity_id, file_name)`, which
 * carries no `space_id`. The restore then reported them "already present" against a destination space
 * that held nothing of the kind, and the attachments were lost with a success on the report.
 *
 * The type lists are per table and genuinely differ: `file_attachments`' CHECK admits `gdpr_record`
 * and not `asset_object`, `entity_file_links`' the reverse. Both are the CHECK constraint's own
 * members, resolved to table names — see POLYMORPHIC_REFERENCES in `restore-id-remapper.ts`, which
 * must name the same tables for the ordering here to be the one the remapper needs.
 *
 * Hand-maintained because nothing can derive it. Keep it to references the database genuinely does
 * not enforce — anything with a real foreign key belongs in the generated graph, where it cannot
 * drift.
 */
const LOGICAL_DEPENDENCIES: Record<string, string[]> = {
  form_builder_orders: ['form_builder', 'form_builder_submissions'],
  task_relationships: ['tasks'],
  file_attachments: [
    'tasks',
    'business_processes',
    'wiki_pages',
    'asset_items',
    'gdpr_records',
    'space_gdpr_records',
    'support_requests',
    'test_cases',
    'test_run_attempts',
    'test_executions',
  ],
  entity_file_links: [
    'tasks',
    'business_processes',
    'wiki_pages',
    'asset_items',
    'asset_objects',
    'space_gdpr_records',
    'support_requests',
    'test_cases',
    'test_run_attempts',
    'test_executions',
  ],
  // Ids in `precondition_ids`, and in an attempt's snapshot and precondition results, are rewritten from
  // the preconditions' new ids, so those must be written first.
  test_cases: ['test_preconditions'],
  test_run_attempts: ['test_preconditions'],
  // Re-keying a precondition makes its trigger insert a bare settings row when none exists, so the
  // archived settings go in before it.
  test_preconditions: ['test_management_space_settings'],
};

const ARCHIVE_PARENT_DEPENDENCIES: Record<string, string[]> = {
  form_builder_orders: ['form_builder', 'form_builder_submissions'],
  form_builder_webhook_deliveries: ['form_builder_submissions'],
  form_builder_integration_deliveries: ['form_builder_submissions'],
  task_relationships: ['tasks'],
  file_attachments: LOGICAL_DEPENDENCIES.file_attachments,
  entity_file_links: LOGICAL_DEPENDENCIES.entity_file_links,
  // `precondition_ids` has no foreign key, so picking test cases alone would leave their lists pointing at nothing.
  test_cases: ['test_preconditions'],
};

/**
 * Parents that are never pulled into a restore, because the destination already has them.
 *
 * `spaces` is only true of that while FOLDING. There the operator chose a destination space that
 * already exists, so nothing about it needs restoring and nothing needs ordering against it — which
 * is why it sits here beside `organizations` and `users`, both of which are hard-excluded from the
 * registry outright.
 *
 * Recreating inverts that: the spaces are being written, and every space-scoped row in the run needs
 * its space to have landed first. `implicitParents` below is what makes the distinction, rather than
 * this set being edited in place, so the folding answer stays exactly what it has always been.
 */
const IMPLICIT_PARENT_TABLES = new Set(['organizations', 'spaces', 'users']);

function implicitParents(recreateSpaces: boolean): ReadonlySet<string> {
  if (!recreateSpaces) {
    return IMPLICIT_PARENT_TABLES;
  }

  const parents = new Set(IMPLICIT_PARENT_TABLES);

  parents.delete('spaces');

  return parents;
}

function parentTablesFor(table: string, recreateSpaces = false): string[] {
  // Required FK fields are the structural "belongs to" edge: without the parent row, the relation
  // row cannot be restored. Optional links are left alone unless they are deliberately listed in
  // ARCHIVE_PARENT_DEPENDENCIES; that avoids dragging broad optional parents like
  // form_builder_submissions.task_id -> tasks into a restore that did not ask for tasks.
  const declared = fkEdgesFor(table)
    .filter((edge) => edge.required)
    .map((edge) => edge.references);
  const logical = ARCHIVE_PARENT_DEPENDENCIES[table] ?? [];

  const implicit = implicitParents(recreateSpaces);

  return [...new Set([...declared, ...logical])].filter(
    (parent) =>
      parent !== table && !implicit.has(parent) && Boolean(tableEntry(parent)),
  );
}

function selectionCoversComponent(
  component: string,
  selection: Set<string>,
): boolean {
  for (const table of selection) {
    if (tableEntry(table)?.component === component) {
      return true;
    }
  }

  return false;
}

export function availableDependencyTables(
  selection: string[],
  availableTables: Set<string>,
  identityApproved: boolean,
  recreateSpaces = false,
): Set<string> {
  const wanted = new Set(selection);
  const dependencies = new Set<string>();
  const queue = [...selection];

  while (queue.length) {
    const table = queue.shift() as string;

    for (const parent of parentTablesFor(table, recreateSpaces)) {
      if (wanted.has(parent) || !availableTables.has(parent)) {
        continue;
      }

      const entry = tableEntry(parent);

      if (!entry || refuseTable(entry, identityApproved)) {
        continue;
      }

      wanted.add(parent);
      dependencies.add(parent);
      queue.push(parent);
    }
  }

  return dependencies;
}

export function orderForInsert(
  tables: PlannedTable[],
  recreateSpaces = false,
): PlannedTable[] {
  const selected = new Set(tables.map((table) => table.table));

  // Dependencies among the tables ACTUALLY being written, from the generated FK graph. `insertLevel`
  // is a hand-maintained number and it has been wrong: `form_builder_orders` sits at level 1 while
  // the `form_builder` it requires sits at 3 and `form_builder_submissions` at 6, so orders were
  // written before either existed and every one of them was refused `unmapped_reference`. A depth
  // computed from the schema cannot drift from the schema.
  //
  // Self-references are ignored here — a row pointing at its own table is resolved by `seedIds`
  // minting the ids up front, not by ordering — and so are references to tables outside this
  // restore, which nothing in this run will write.
  const dependencies = new Map<string, string[]>();

  for (const table of selected) {
    // `spaces` is excluded while FOLDING because the destination space already exists and nothing in
    // the run writes it. Recreating, it is written like any other table and everything space-scoped
    // depends on it, so the edge has to count.
    //
    // Not a theoretical ordering worry. Depth is the primary sort and `insertLevel` only the
    // tie-break, so `spaces` picking up depth 1 from `space_types` while a child of it sits at
    // depth 0 — `space_categories` and `starred_spaces` have no other in-run parent — would order
    // the child FIRST. Its space would not exist yet, and every one of its rows would be refused
    // `unmapped_reference` for a space the run went on to create moments later.
    const declared = fkEdgesFor(table)
      .filter(
        (edge) =>
          edge.references !== table &&
          (recreateSpaces || edge.references !== 'spaces') &&
          selected.has(edge.references),
      )
      .map((edge) => edge.references);

    const logical = (LOGICAL_DEPENDENCIES[table] ?? []).filter(
      (parent) => parent !== table && selected.has(parent),
    );

    dependencies.set(table, [...new Set([...declared, ...logical])]);
  }

  /**
   * How deep a table sits below the tables it depends on.
   *
   * Memoised, and guarded against the cycles the registry warns about — `wiki_pages` and
   * `ai_generated_content` genuinely point at each other, as do the partner quote/invoice triangle.
   * A table already being visited contributes nothing rather than recursing forever; the engine
   * still resolves those with a nullable back-edge and the deferred second pass.
   */
  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (table: string): number => {
    const known = depths.get(table);

    if (known !== undefined) {
      return known;
    }

    if (visiting.has(table)) {
      return 0;
    }

    visiting.add(table);

    const depth = (dependencies.get(table) ?? []).reduce(
      (deepest, parent) => Math.max(deepest, depthOf(parent) + 1),
      0,
    );

    visiting.delete(table);
    depths.set(table, depth);

    return depth;
  };

  return [...tables].sort(
    (a, b) =>
      depthOf(a.table) - depthOf(b.table) ||
      // Kept as the tie-break so tables the graph cannot separate keep the order they have always
      // had, rather than silently rearranging on an unrelated change.
      a.insertLevel - b.insertLevel ||
      a.table.localeCompare(b.table),
  );
}

/** Columns Postgres computes for this table, which must never be sent. */
export function generatedColumnsFor(table: string): string[] {
  return GENERATED_COLUMNS[table] ?? [];
}

/** Something worth telling the operator that does not stop the run. */
export type WarningCode = 'destination_not_empty' | 'satisfied_by_existing';

export interface PlanWarning {
  code: WarningCode;
  table: string;
  liveRowCount: number;
  detail: string;
}

export interface ResolvedTable extends PlannedTable {
  liveRowCount: number;
  /** True when rows are being added alongside rows that are already there. */
  mergeIntoExisting: boolean;
}

export interface ResolvedPlan {
  /** What will actually be written, parents first. */
  tables: ResolvedTable[];
  /** Dependencies already present in the destination. Not restored; nothing is wrong with them. */
  satisfied: { table: string; liveRowCount: number }[];
  /** Tables whose live count could not be taken. Fatal — an unknown count is not zero. */
  blocked: { table: string; detail: string }[];
  warnings: PlanWarning[];
  canProceed: boolean;
}

/** One table's live occupancy, as reported by `RestorePreflightService`. */
export interface DestinationFact {
  table: string;
  liveRowCount: number;
  empty: boolean;
  error?: string;
}

/**
 * Decides what a plan actually restores, once the destination has been counted.
 *
 * This exists because the first version of the rule conflated two different things: a table we are
 * about to INSERT into, and a parent that merely has to EXIST so a foreign key resolves. Requiring
 * both to be empty makes the feature refuse itself — on a live database, restoring the one empty
 * table pulls in its non-empty parents and the whole run is rejected, so no restore is ever
 * possible.
 *
 * The split:
 *
 *   - A dependency that already holds rows is **satisfied**. It is dropped from the restore set and
 *     reported. Its rows are exactly what the child being restored needs to point at.
 *   - A table the operator **chose** that already holds rows is **merged into**: absent rows are
 *     inserted, present rows are counted as skipped. This is safe because the writer is INSERT-only
 *     and has no update path at all, so a live row can never be overwritten. It is still surfaced as
 *     a warning, because adding rows beside existing ones is a thing an operator must agree to.
 *   - A table whose count FAILED blocks everything. That rule does not move: treating an unknown
 *     count as zero is how a restore writes into data it never saw.
 */
export function resolveRestoreSet(
  plan: RestorePlan,
  facts: DestinationFact[],

  // Re-sorts the surviving subset from scratch, so it needs the same answer `planRestore` was given.
  // Without it a recreating plan would be handed back in FOLDING order at the last moment, after the
  // ordering had already been got right once.
  recreateSpaces = false,
): ResolvedPlan {
  const byTable = new Map(facts.map((fact) => [fact.table, fact]));

  const tables: ResolvedTable[] = [];
  const satisfied: { table: string; liveRowCount: number }[] = [];
  const blocked: { table: string; detail: string }[] = [];
  const warnings: PlanWarning[] = [];

  for (const planned of plan.tables) {
    const fact = byTable.get(planned.table);

    if (!fact || fact.error) {
      blocked.push({
        table: planned.table,
        detail:
          fact?.error ??
          `The current contents of ${planned.table} could not be checked, so it was not restored.`,
      });
      continue;
    }

    if (fact.liveRowCount === 0) {
      tables.push({ ...planned, liveRowCount: 0, mergeIntoExisting: false });
      continue;
    }

    if (planned.addedAsDependency && !planned.restoreDependencyRows) {
      // Already there, and only needed so the child's foreign keys resolve. Restoring it would
      // duplicate nothing useful and skip every row anyway.
      satisfied.push({
        table: planned.table,
        liveRowCount: fact.liveRowCount,
      });
      warnings.push({
        code: 'satisfied_by_existing',
        table: planned.table,
        liveRowCount: fact.liveRowCount,
        detail:
          `${planned.table} already holds ${fact.liveRowCount} row(s) and is only needed so the ` +
          'tables you chose have something to refer to, so it was left alone.',
      });
      continue;
    }

    tables.push({
      ...planned,
      liveRowCount: fact.liveRowCount,
      mergeIntoExisting: true,
    });
    warnings.push({
      code: 'destination_not_empty',
      table: planned.table,
      liveRowCount: fact.liveRowCount,
      detail:
        `${planned.table} already holds ${fact.liveRowCount} row(s). Rows from the archive that ` +
        'are not there yet will be added; rows that are already there are left exactly as they are.',
    });
  }

  return {
    tables: orderForInsert(tables, recreateSpaces) as ResolvedTable[],
    satisfied,
    blocked,
    warnings,
    // An empty restore set is a refusal even when nothing individually failed — reporting
    // "restored 0 tables" as success is how an empty restore passes for a real one.
    canProceed: blocked.length === 0 && tables.length > 0,
  };
}

/**
 * Builds the plan, or the reasons there will not be one.
 *
 * Fatal refusals — a format that cannot be read, or an archive belonging to
 * another organization — stop everything. Per-table refusals drop that table and
 * are reported, because restoring nine tables of ten with the tenth named is
 * more useful than refusing all ten.
 */
export function planRestore(input: PlanInput): RestorePlan {
  const refusals: Refusal[] = [];
  const notes: Refusal[] = [];

  if (!isRestorableFormat(input.format)) {
    refusals.push({
      code: 'format_not_restorable',
      detail:
        `This archive is ${input.format.toUpperCase()}, which this application cannot read back. ` +
        `Only ${RESTORABLE_FORMATS.join(' and ').toUpperCase()} archives can be restored — ` +
        'everything else is written for a person to read, not for the product to import.',
    });
  }

  // The tenant boundary. Compared against the session-resolved organization,
  // never a body field or a header, and never the archive's own claim alone.
  //
  // A PREVIEW is allowed across it. Nothing is written, and refusing outright meant an operator
  // asking "what would this archive put into my other tenant?" got no answer at all — only the
  // refusal. The apply still stops here, which is the moment a row could actually cross.
  if (input.archiveOrganizationId !== input.sessionOrganizationId) {
    if (input.previewOnly) {
      notes.push({
        code: 'foreign_organization',
        detail:
          'This archive belongs to a different organization. The preview below shows what it ' +
          'holds, but applying it is refused: the rows keep the ids of the organization they came ' +
          'from, so they would point back at it rather than at this one.',
      });
    } else {
      refusals.push({
        code: 'foreign_organization',
        detail:
          'This archive belongs to a different organization. Restoring it here would mix two ' +
          "tenants' data, so it is refused.",
      });
    }
  }

  // Nothing below is worth computing if the run cannot happen at all.
  if (refusals.length) {
    return {
      tables: [],
      refusals,
      notes,
      missingParentComponents: [],
      canProceed: false,
    };
  }

  const wanted = new Set(input.selection);
  const dependencyTables =
    input.includeAvailableDependencies && input.availableTables
      ? availableDependencyTables(
          input.selection,
          new Set(input.availableTables),
          Boolean(input.identityApproved),
          Boolean(input.recreateSpaces),
        )
      : new Set<string>();

  for (const table of dependencyTables) {
    wanted.add(table);
  }

  // Components still absent after any archive-derived parent rows have been added. The operator is
  // told which parents remain absent so the skips that follow are expected rather than mysterious.
  const missingParentComponents = requiredComponents(input.selection).filter(
    (component) => !selectionCoversComponent(component, wanted),
  );

  const tables: PlannedTable[] = [];

  for (const table of wanted) {
    const entry = tableEntry(table);

    if (!entry) {
      refusals.push({
        code: 'not_in_registry',
        table,
        detail: `${table} is not a table this product backs up, so it cannot be restored.`,
      });
      continue;
    }

    const refusal = refuseTable(entry, Boolean(input.identityApproved));

    if (refusal) {
      refusals.push(refusal);
      continue;
    }

    tables.push({
      table: entry.table,
      component: entry.component,
      tier: entry.tier,
      insertLevel: entry.insertLevel,
      generatedColumns: generatedColumnsFor(entry.table),
      addedAsDependency: dependencyTables.has(entry.table),
      restoreDependencyRows: dependencyTables.has(entry.table) || undefined,
    });
  }

  return {
    tables: orderForInsert(tables, Boolean(input.recreateSpaces)),
    refusals,
    notes,
    missingParentComponents,
    // A plan with no tables is a refusal even when nothing individually failed:
    // reporting "restored 0 tables" as success is how an empty restore passes
    // for a real one.
    canProceed: tables.length > 0,
  };
}

/**
 * Per-table refusals. Returns null when the table may be restored.
 *
 * Exported only so `tableRestorable()` in the registry can be asserted against it. The registry
 * duplicates these rules deliberately — it is the bottom of the dependency graph and cannot import
 * this file — and its docblock has always claimed the pairing was covered by a test. It was not.
 */
export function refuseTable(
  entry: ComponentTable,
  identityApproved: boolean,
): Refusal | null {
  if ((IDENTITY_COLUMN_TABLES as readonly string[]).includes(entry.table)) {
    return {
      code: 'identity_column',
      table: entry.table,
      detail:
        `${entry.table} has a database-generated identity column. Restoring it through the API ` +
        'would renumber every row rather than preserve the archived values, so it is refused.',
    };
  }

  if (entry.tier === 'identity' && !identityApproved) {
    return {
      code: 'identity_tier',
      table: entry.table,
      detail:
        `${entry.table} holds identity data (users, roles or memberships). Restoring it needs ` +
        'separate approval, because it can change who has access to what.',
    };
  }

  if (!entry.restoreByDefault) {
    return {
      code: 'not_restorable_by_default',
      table: entry.table,
      detail: `${entry.table} is a legacy table that is archived but not restored by default.`,
    };
  }

  return null;
}
